import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations, latestQualityReport, saveQualityReport, type Db } from '@pomagierkb/shared/db';
import { recordLlmUsage } from '@pomagierkb/shared/llm';
import { appendAudit } from '@pomagierkb/shared/audit';
import { sharedMigrationsDir } from '../src/lib/migrations.js';
import runQualityAnswers, { collectBreakerIncidents } from '../src/jobs/quality-answers.js';
import type { JobContext } from '../src/jobs/job-types.js';

/**
 * Job quality_answers: rodzaj raportu 'answers' (D10-09), sekcja kosztu LLM
 * (GAP-05) i sekcja otwarć breakerów z audytu (D10-05).
 */

let db: Db;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'kag-qa-test-'));
  db = openDb(':memory:');
  runMigrations(db, sharedMigrationsDir());
});
afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function ctx(): JobContext {
  return { db, actionId: 'act_test', dataDir, params: {}, progress: () => {}, log: () => {} };
}

function parseChecks(json: string): { id: string; details?: unknown }[] {
  return JSON.parse(json) as { id: string; details?: unknown }[];
}

describe('collectBreakerIncidents', () => {
  it('zlicza otwarcia breakerów z łańcucha audytu i podaje ostatni powód', () => {
    appendAudit(db, {
      actor: 'system',
      actorType: 'system',
      action: 'breaker.open',
      resourceType: 'breaker',
      resourceId: 'llm.chat',
      metadata: { reason: 'timeout providera' },
    });
    appendAudit(db, {
      actor: 'system',
      actorType: 'system',
      action: 'breaker.close',
      resourceType: 'breaker',
      resourceId: 'llm.chat',
      metadata: {},
    });
    const incidents = collectBreakerIncidents(db, new Date(Date.now() - 7 * 86_400_000).toISOString());
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ breaker: 'llm.chat', opens: 1, lastReason: 'timeout providera' });
  });

  it('brak incydentów → pusta lista', () => {
    expect(collectBreakerIncidents(db, new Date().toISOString())).toEqual([]);
  });
});

describe('job quality_answers', () => {
  it('pusta baza: zapisuje raport __all__ rodzaju answers z sekcjami kosztu i breakerów', async () => {
    await runQualityAnswers(ctx());
    const report = latestQualityReport(db, '__all__');
    expect(report).not.toBeNull();
    expect(report?.kind).toBe('answers');
    expect(parseChecks(report!.checks_json).map((c) => c.id)).toEqual([
      'answer_quality_week',
      'llm_usage_week',
      'breaker_openings_week',
    ]);
  });

  it('raport nie przesłania werdyktu quality gate bazy (D10-09)', async () => {
    db.prepare(
      "INSERT INTO kb_registry (namespace, name, job_prefix, status, created_at, updated_at) VALUES ('Docs','Docs','docs','active',?,?)",
    ).run(new Date().toISOString(), new Date().toISOString());
    saveQualityReport(db, 'Docs', 1, 'OK', [{ id: 'export_integrity', ok: true }], 'gate');
    db.prepare(
      `INSERT INTO answers (id, question, namespaces_json, citations_json, source, no_answer, created_at)
       VALUES ('ans_1', 'pytanie?', '["Docs"]', '[]', 'panel', 1, ?)`,
    ).run(new Date().toISOString());

    await runQualityAnswers(ctx());

    // Raport odpowiedzi dla Docs powstał…
    expect(latestQualityReport(db, 'Docs', 'answers')).not.toBeNull();
    // …ale /kb dalej widzi werdykt builda.
    const gate = latestQualityReport(db, 'Docs');
    expect(gate?.kind).toBe('gate');
    expect(gate?.verdict).toBe('OK');
  });

  it('agreguje tokeny LLM z okna 7 dni do sekcji llm_usage_week (GAP-05)', async () => {
    recordLlmUsage(db, {
      endpoint: 'chat',
      purpose: 'llm.chat',
      model: 'gpt-a',
      promptTokens: 100,
      completionTokens: 40,
    });
    recordLlmUsage(db, {
      endpoint: 'chat',
      purpose: 'llm.chat',
      model: 'gpt-a',
      promptTokens: 1,
      at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    });

    await runQualityAnswers(ctx());
    const checks = parseChecks(latestQualityReport(db, '__all__')!.checks_json);
    const usage = checks.find((c) => c.id === 'llm_usage_week')?.details as {
      totalTokens: number;
      byModel: { key: string; totalTokens: number }[];
    };
    expect(usage.totalTokens).toBe(140); // wiersz sprzed 30 dni poza oknem
    expect(usage.byModel[0]?.key).toBe('gpt-a');
  });
});
