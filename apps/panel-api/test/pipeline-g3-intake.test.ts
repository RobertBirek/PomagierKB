import { afterEach, describe, expect, it } from 'vitest';
import { createKb, transitionKb, type Db } from '@pomagierkb/shared/db';
import { AppError } from '@pomagierkb/shared/errors';
import { errorDetail, processIntake, tickIntakeWorker } from '../src/pipeline/intake-worker.js';
import {
  findIntakeByBlobPath,
  getIntakeOrThrow,
  insertIntake,
  intakeToDetail,
  nextReceivedIntake,
  requeueStaleIntakes,
  saveBlob,
  updateIntake,
  INTAKE_MAX_ATTEMPTS,
} from '../src/services/intakes.js';
import type { AppConfig } from '../src/config.js';
import { makeDb, makeKbTestConfig } from './helpers/kb.js';

/**
 * REGRESJE AUDYTU G3 dla intake'ów:
 *  - D10-03/D7-05: sweep intake'ów zawieszonych w stanie pośrednim + dedup po blobie,
 *  - D10-08: treść błędu obok kodu (z redakcją sekretów),
 *  - D7-06: limit długości egzekwowany PRZED wywołaniem LLM.
 */

const dbs: Db[] = [];

function fresh(): { db: Db; config: AppConfig } {
  const db = makeDb();
  dbs.push(db);
  const config = makeKbTestConfig();
  createKb(db, { namespace: 'LightingDocs', name: 'Oświetlenie', routingKeywords: ['oświetlenie'] });
  transitionKb(db, 'LightingDocs', 'provisioning');
  transitionKb(db, 'LightingDocs', 'active');
  return { db, config };
}

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close();
});

/** Intake w zadanym stanie pośrednim, „zestarzały" o podany czas. */
function stuckIntake(db: Db, config: AppConfig, status: string, ageMs: number, attempts = 0): string {
  const { blobPath } = saveBlob(config.dataDir, Buffer.from(`treść ${Math.random()}`, 'utf8'));
  const row = insertIntake(db, { sourceKind: 'text', originalName: 'Notatka', mime: 'text/plain', blobPath });
  db.prepare('UPDATE intakes SET status = ?, attempts = ?, updated_at = ? WHERE id = ?').run(
    status,
    attempts,
    new Date(Date.now() - ageMs).toISOString(),
    row.id,
  );
  return row.id;
}

describe('D10-03/D7-05 — intake nie wisi po restarcie procesu', () => {
  it('stan pośredni starszy niż deadline wraca do kolejki (i jest znów podejmowany)', () => {
    const { db, config } = fresh();
    const id = stuckIntake(db, config, 'cleaned', 30 * 60_000);
    expect(nextReceivedIntake(db)).toBeNull(); // dotąd nikt go nie widział

    const result = requeueStaleIntakes(db, 20 * 60_000);
    expect(result.requeued).toEqual([id]);
    const row = getIntakeOrThrow(db, id);
    expect(row.status).toBe('received');
    expect(row.attempts).toBe(1);
    expect(nextReceivedIntake(db)?.id).toBe(id);
  });

  it('świeży stan pośredni (worker właśnie pracuje) NIE jest ruszany', () => {
    const { db, config } = fresh();
    const id = stuckIntake(db, config, 'analyzed', 60_000);
    expect(requeueStaleIntakes(db, 20 * 60_000).requeued).toEqual([]);
    expect(getIntakeOrThrow(db, id).status).toBe('analyzed');
  });

  it('wyczerpane próby → failed z kodem interrupted zamiast nieskończonej pętli', () => {
    const { db, config } = fresh();
    const id = stuckIntake(db, config, 'extracted', 30 * 60_000, INTAKE_MAX_ATTEMPTS);
    const result = requeueStaleIntakes(db, 20 * 60_000);
    expect(result.failed).toEqual([id]);
    const row = getIntakeOrThrow(db, id);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('interrupted');
    expect(row.error_detail).toContain('przerwane');
  });

  it('dedup po blobie pomija intake failed z wyczerpanymi próbami (treść da się zgłosić ponownie)', () => {
    const { db, config } = fresh();
    const { blobPath } = saveBlob(config.dataDir, Buffer.from('ta sama treść', 'utf8'));
    const row = insertIntake(db, { sourceKind: 'text', originalName: 'N', mime: 'text/plain', blobPath });
    expect(findIntakeByBlobPath(db, blobPath)?.id).toBe(row.id);

    db.prepare("UPDATE intakes SET status = 'failed', attempts = ? WHERE id = ?").run(INTAKE_MAX_ATTEMPTS, row.id);
    expect(findIntakeByBlobPath(db, blobPath)).toBeNull();

    // Failed z pozostałymi próbami nadal deduplikuje (jest przycisk „Ponów").
    db.prepare("UPDATE intakes SET attempts = 1 WHERE id = ?").run(row.id);
    expect(findIntakeByBlobPath(db, blobPath)?.id).toBe(row.id);
  });
});

describe('D10-08 — diagnostyka nieudanego intake’u', () => {
  it('errorDetail redaguje sekrety i przycina długość', () => {
    expect(errorDetail(new Error('FOREIGN KEY constraint failed'))).toBe('FOREIGN KEY constraint failed');
    expect(errorDetail(new Error('Bearer abcdef123456 odrzucony'))).toContain('Bearer [REDACTED]');
    expect(errorDetail(new Error('klucz sk-abcdefgh12345678 nieprawidłowy'))).toContain('sk-[REDACTED]');
    expect(errorDetail(new Error('x'.repeat(1000))).length).toBe(300);
  });

  it('kolumna error_detail wraca w detalu intake’u', () => {
    const { db, config } = fresh();
    const { blobPath } = saveBlob(config.dataDir, Buffer.from('treść', 'utf8'));
    const row = insertIntake(db, { sourceKind: 'text', originalName: 'N', mime: 'text/plain', blobPath });
    updateIntake(db, row.id, { status: 'failed', error: 'internal', error_detail: 'FK users(id)' });
    const detail = intakeToDetail(getIntakeOrThrow(db, row.id));
    expect(detail['errorDetail']).toBe('FK users(id)');
  });
});

describe('D7-06 — limit długości przed LLM', () => {
  it('za długi dokument kończy się payload_too_large bez wywołania modelu', async () => {
    const { db, config } = fresh();
    const paragraph = 'Oświetlenie awaryjne montuje się nad drogami ewakuacyjnymi w halach. ';
    const text = paragraph.repeat(2000); // ~134 tys. znaków > limit draftu (100 tys.)
    const { blobPath } = saveBlob(config.dataDir, Buffer.from(text, 'utf8'));
    const row = insertIntake(db, {
      sourceKind: 'text',
      originalName: 'Duża instrukcja',
      mime: 'text/plain',
      blobPath,
      sizeBytes: Buffer.byteLength(text),
    });

    const exploding = {
      chat: async (): Promise<never> => {
        throw new Error('LLM NIE POWINIEN być wołany dla dokumentu ponad limit');
      },
      embed: async (): Promise<number[][]> => [],
    };

    let caught: unknown;
    try {
      await processIntake(db, config, row, { chatLlm: exploding, openieLlm: exploding, aiClean: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('payload_too_large');
    // Etap ekstrakcji zapisany, ale draft nie powstał i LLM nie został dotknięty.
    expect(getIntakeOrThrow(db, row.id).status).toBe('extracted');
    const drafts = db.prepare('SELECT COUNT(*) AS n FROM drafts').get() as { n: number };
    expect(drafts.n).toBe(0);
  });
});

describe('audyt wznowień', () => {
  it('sweep zapisuje wpis audytu intake.requeue (mutacja systemowa)', async () => {
    const { db, config } = fresh();
    stuckIntake(db, config, 'cleaned', 60 * 60_000);
    await tickIntakeWorker(db, config, { chatLlm: null, openieLlm: null, aiClean: false });
    const entry = db
      .prepare("SELECT actor, actor_type, action FROM audit WHERE action = 'intake.requeue' ORDER BY seq DESC LIMIT 1")
      .get() as { actor: string; actor_type: string; action: string } | undefined;
    expect(entry).toBeDefined();
    expect(entry!.actor_type).toBe('system');
  });
});
