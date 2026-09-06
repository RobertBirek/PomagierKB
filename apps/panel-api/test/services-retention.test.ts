import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '@pomagierkb/shared/db';
import { makeTestApp } from './admin-helpers.js';
import { insertIntake, updateIntake } from '../src/services/intakes.js';
import {
  ANONYMIZED_QUESTION,
  RETENTION_DEFAULTS,
  purgeUserAnswers,
  readRetentionPolicy,
  runRetention,
  selectExpired,
  startRetentionWorker,
} from '../src/services/retention.js';

let app: FastifyInstance;
let db: Db;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'kag-retention-test-'));
  ({ app, db } = await makeTestApp({ dataDir }));
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function oldFile(path: string, ageDays: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'x');
  const t = new Date(Date.now() - ageDays * 86_400_000);
  utimesSync(path, t, t);
}

describe('retention', () => {
  it('selectExpired: pure — wybiera tylko starsze niż cutoff', () => {
    const now = Date.now();
    const files = [
      { path: '/a/stary.log', mtimeMs: now - 100 * 86_400_000 },
      { path: '/a/nowy.log', mtimeMs: now - 1 * 86_400_000 },
    ];
    expect(selectExpired(files, 90, now)).toEqual(['/a/stary.log']);
    expect(selectExpired(files, 200, now)).toEqual([]);
  });

  it("polityka z settings 'retention' nadpisuje domyślne (defensywnie)", () => {
    expect(readRetentionPolicy(db)).toEqual(RETENTION_DEFAULTS);
    db.prepare(
      "INSERT INTO settings (key, value_json, is_secret, updated_at) VALUES ('retention', ?, 0, datetime('now'))",
    ).run(JSON.stringify({ actionLogsDays: 10, exportsDays: 'zle' }));
    const p = readRetentionPolicy(db);
    expect(p.actionLogsDays).toBe(10);
    expect(p.exportsDays).toBe(RETENTION_DEFAULTS.exportsDays);
  });

  it('runRetention czyści stare logi/usage/eksporty i blob failed intake; audytuje', () => {
    const staryLog = join(dataDir, 'actions', '2026', '01', 'act_old.log');
    const nowyLog = join(dataDir, 'actions', '2026', '09', 'act_new.log');
    oldFile(staryLog, 120);
    oldFile(nowyLog, 1);
    const staryUsage = join(dataDir, 'mcp-usage', '2025-01-01.jsonl');
    oldFile(staryUsage, 400);
    const staryExport = join(dataDir, 'exports', 'KbX', '1');
    mkdirSync(staryExport, { recursive: true });
    writeFileSync(join(staryExport, 'chunk.csv'), 'x');
    const t = new Date(Date.now() - 60 * 86_400_000);
    utimesSync(staryExport, t, t);

    // failed intake sprzed 40 dni z blobem
    const blob = join(dataDir, 'uploads', 'aa', 'deadbeef');
    oldFile(blob, 40);
    const intake = insertIntake(db, { sourceKind: 'text', blobPath: blob });
    updateIntake(db, intake.id, { status: 'failed', error: 'internal' });
    db.prepare('UPDATE intakes SET updated_at = ? WHERE id = ?').run(
      new Date(Date.now() - 40 * 86_400_000).toISOString(),
      intake.id,
    );

    const result = runRetention(db, dataDir);
    expect(result.actionLogs).toBe(1);
    expect(result.mcpUsage).toBe(1);
    expect(result.exportDirs).toBe(1);
    expect(result.failedIntakeBlobs).toBe(1);
    expect(existsSync(staryLog)).toBe(false);
    expect(existsSync(nowyLog)).toBe(true);
    expect(existsSync(blob)).toBe(false);

    const audit = db
      .prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'retention.purge'")
      .get() as { n: number };
    expect(audit.n).toBe(1);
  });

  // ── D14-09: oryginały UDANYCH intake'ów i wiersze pipeline'u ───────────────
  it('kasuje blob udanego intake i dopiero potem wiersz intake', () => {
    const blob = join(dataDir, 'uploads', 'bb', 'cafebabe');
    oldFile(blob, 60);
    const intake = insertIntake(db, { sourceKind: 'upload', blobPath: blob });
    updateIntake(db, intake.id, { status: 'drafted' });
    db.prepare('UPDATE intakes SET updated_at = ? WHERE id = ?').run(
      new Date(Date.now() - 60 * 86_400_000).toISOString(),
      intake.id,
    );

    const first = runRetention(db, dataDir);
    expect(first.succeededIntakeBlobs).toBe(1);
    expect(existsSync(blob)).toBe(false);
    // Wiersz zostaje (60 dni < intakeRowsDays 180) — z blob_path = NULL.
    const row = db.prepare('SELECT blob_path FROM intakes WHERE id = ?').get(intake.id) as
      | { blob_path: string | null }
      | undefined;
    expect(row?.blob_path).toBeNull();

    // Po przekroczeniu intakeRowsDays wiersz znika.
    db.prepare('UPDATE intakes SET updated_at = ? WHERE id = ?').run(
      new Date(Date.now() - 400 * 86_400_000).toISOString(),
      intake.id,
    );
    const second = runRetention(db, dataDir);
    expect(second.intakeRows).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM intakes WHERE id = ?').get(intake.id)).toEqual({ n: 0 });
  });

  it('nie rusza bloba współdzielonego przez inny intake', () => {
    const blob = join(dataDir, 'uploads', 'cc', 'shared');
    oldFile(blob, 90);
    const a = insertIntake(db, { sourceKind: 'upload', blobPath: blob });
    const b = insertIntake(db, { sourceKind: 'upload', blobPath: blob });
    for (const id of [a.id, b.id]) {
      updateIntake(db, id, { status: 'drafted' });
      db.prepare('UPDATE intakes SET updated_at = ? WHERE id = ?').run(
        new Date(Date.now() - 90 * 86_400_000).toISOString(),
        id,
      );
    }
    runRetention(db, dataDir);
    expect(existsSync(blob)).toBe(true);
  });

  it('manifesty eksportów: kasuje stare, ZOSTAWIA najnowszy bieg bazy', () => {
    db.prepare(
      "INSERT INTO kb_registry (namespace, name, job_prefix, status, created_at, updated_at) VALUES ('RetKb','RetKb','ret','active',?,?)",
    ).run(new Date().toISOString(), new Date().toISOString());
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    const insert = db.prepare(
      "INSERT INTO export_runs (namespace, status, started_at, finished_at) VALUES ('RetKb','success',?,?)",
    );
    const first = Number(insert.run(old, old).lastInsertRowid);
    const second = Number(insert.run(old, old).lastInsertRowid);
    db.prepare(
      "INSERT INTO export_files (run_id, file_name, row_count, columns_json, sha256, path) VALUES (?, 'chunk.csv', 1, '[]', 'x', '/tmp/x')",
    ).run(first);

    const result = runRetention(db, dataDir);
    expect(result.exportRunRows).toBe(1);
    expect(result.exportFileRows).toBe(1);
    const left = db.prepare('SELECT id FROM export_runs WHERE namespace = ?').all('RetKb') as { id: number }[];
    expect(left.map((r) => r.id)).toEqual([second]); // najnowszy bieg zostaje
  });

  // ── D14-03: pytania użytkowników ─────────────────────────────────────────
  it('anonimizuje stare pytania i twardo kasuje najstarsze wraz z feedbackiem', () => {
    const insertAnswer = db.prepare(
      `INSERT INTO answers (id, question, namespaces_json, citations_json, source, user_id, created_at)
       VALUES (?, ?, '[]', '[]', 'panel', 'u-admin', ?)`,
    );
    insertAnswer.run('ans_anon', 'Ile zarabia Kowalski?', new Date(Date.now() - 200 * 86_400_000).toISOString());
    insertAnswer.run('ans_del', 'Bardzo stare pytanie', new Date(Date.now() - 400 * 86_400_000).toISOString());
    insertAnswer.run('ans_fresh', 'Świeże pytanie', new Date().toISOString());
    db.prepare(
      "INSERT INTO feedback (id, answer_id, verdict, comment, created_at) VALUES ('fb_del','ans_del','down','komentarz',?)",
    ).run(new Date(Date.now() - 400 * 86_400_000).toISOString());

    const result = runRetention(db, dataDir);
    expect(result.answersDeleted).toBe(1);
    expect(result.feedbackRows).toBe(1);
    expect(result.answersAnonymized).toBe(1);

    const anon = db.prepare('SELECT question, user_id FROM answers WHERE id = ?').get('ans_anon') as {
      question: string;
      user_id: string | null;
    };
    expect(anon.question).toBe(ANONYMIZED_QUESTION);
    expect(anon.user_id).toBeNull();
    const fresh = db.prepare('SELECT question FROM answers WHERE id = ?').get('ans_fresh') as { question: string };
    expect(fresh.question).toBe('Świeże pytanie');
    expect(db.prepare("SELECT COUNT(*) AS n FROM answers WHERE id = 'ans_del'").get()).toEqual({ n: 0 });

    // Idempotencja: drugi bieg nie anonimizuje po raz drugi.
    expect(runRetention(db, dataDir).answersAnonymized).toBe(0);
  });

  it('kasuje zamknięte luki, otwartych NIE rusza', () => {
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const insert = db.prepare(
      `INSERT INTO learning_gaps (id, question, normalized_question, source, status, created_at, processed_at)
       VALUES (?, ?, ?, 'panel', ?, ?, ?)`,
    );
    insert.run('gap_open', 'otwarte?', 'otwarte', 'open', old, null);
    insert.run('gap_done', 'zamknięte?', 'zamkniete', 'resolved', old, old);

    expect(runRetention(db, dataDir).gapRows).toBe(1);
    const left = db.prepare('SELECT id FROM learning_gaps ORDER BY id').all() as { id: string }[];
    expect(left.map((r) => r.id)).toContain('gap_open');
    expect(left.map((r) => r.id)).not.toContain('gap_done');
  });

  it('purgeUserAnswers kasuje historię jednego użytkownika i audytuje', () => {
    db.prepare(
      `INSERT INTO answers (id, question, namespaces_json, citations_json, source, user_id, created_at)
       VALUES ('ans_mine', 'moje pytanie', '[]', '[]', 'panel', 'u-viewer', ?)`,
    ).run(new Date().toISOString());
    db.prepare(
      "INSERT INTO feedback (id, answer_id, verdict, created_at) VALUES ('fb_mine','ans_mine','up',?)",
    ).run(new Date().toISOString());

    const counts = purgeUserAnswers(db, 'u-viewer');
    expect(counts).toEqual({ answers: 1, feedback: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM answers WHERE user_id = 'u-viewer'").get()).toEqual({ n: 0 });
    const audit = db
      .prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'retention.purge_user'")
      .get() as { n: number };
    expect(audit.n).toBe(1);
  });

  it('worker konserwacyjny odpala też harmonogram jobów (D10-04)', async () => {
    const start = vi.fn(() => ({ id: 'act_sched' }) as never);
    const worker = startRetentionWorker({
      db,
      dataDir,
      intervalMs: 3_600_000,
      initialDelayMs: 0,
      startActionImpl: start,
    });
    await new Promise((r) => setTimeout(r, 50));
    worker.stop();
    expect(start).toHaveBeenCalledTimes(1);
    expect((start.mock.calls[0] as unknown[])[1]).toMatchObject({ type: 'quality_answers' });
  });

  it('kasuje stare wiersze rejestru zużycia LLM (llm_usage)', () => {
    const insert = db.prepare(
      "INSERT INTO llm_usage (at, endpoint, purpose, model, prompt_tokens, completion_tokens) VALUES (?, 'chat', 'llm.chat', 'gpt-x', 10, 5)",
    );
    insert.run(new Date(Date.now() - 400 * 86_400_000).toISOString());
    insert.run(new Date().toISOString());
    expect(runRetention(db, dataDir).llmUsageRows).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM llm_usage').get()).toEqual({ n: 1 });
  });
});
