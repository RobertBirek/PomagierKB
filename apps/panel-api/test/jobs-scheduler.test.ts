import { describe, expect, it, vi } from 'vitest';
import { openDb, runMigrations, saveQualityReport, type Db } from '@pomagierkb/shared/db';
import { sharedMigrationsDir } from '../src/lib/migrations.js';
import { isReportDue, runDueJobs, QUALITY_ANSWERS_EVERY_DAYS } from '../src/jobs/scheduler.js';
import type { ActionRow } from '@pomagierkb/shared/db';

/**
 * Harmonogram jobów cyklicznych (ustalenie D10-04): job quality_answers nie miał
 * ŻADNEGO mechanizmu cyklicznego i nie uruchomił się w produkcji ani razu.
 */

function freshDb(): Db {
  const db = openDb(':memory:');
  runMigrations(db, sharedMigrationsDir());
  return db;
}

const fakeAction = { id: 'act_test' } as ActionRow;

describe('isReportDue', () => {
  const now = Date.parse('2026-09-06T12:00:00.000Z');
  it('brak raportu → termin minął', () => {
    expect(isReportDue(null, now, 6)).toBe(true);
  });
  it('raport sprzed 7 dni → termin minął; sprzed 2 dni → jeszcze nie', () => {
    expect(isReportDue(new Date(now - 7 * 86_400_000).toISOString(), now, 6)).toBe(true);
    expect(isReportDue(new Date(now - 2 * 86_400_000).toISOString(), now, 6)).toBe(false);
  });
  it('data nieparsowalna → uruchamiamy (lepiej raz za dużo niż nigdy)', () => {
    expect(isReportDue('nie-data', now, 6)).toBe(true);
  });
});

describe('runDueJobs', () => {
  it('pusta baza: uruchamia quality_answers jako system', () => {
    const db = freshDb();
    const start = vi.fn(() => fakeAction);
    const started = runDueJobs({ db, dataDir: '/tmp', startActionImpl: start });
    expect(started).toEqual(['quality_answers']);
    expect(start).toHaveBeenCalledTimes(1);
    const input = start.mock.calls[0]![1] as { type: string; resource: string; startedBy: string | null };
    expect(input.type).toBe('quality_answers');
    expect(input.startedBy).toBeNull();
    db.close();
  });

  it('świeży raport odpowiedzi → nic nie uruchamia', () => {
    const db = freshDb();
    saveQualityReport(db, '__all__', null, 'OK', [{ id: 'answer_quality_week' }], 'answers');
    const start = vi.fn(() => fakeAction);
    expect(runDueJobs({ db, dataDir: '/tmp', startActionImpl: start })).toEqual([]);
    expect(start).not.toHaveBeenCalled();
    db.close();
  });

  it('raport starszy niż okno → uruchamia ponownie', () => {
    const db = freshDb();
    saveQualityReport(db, '__all__', null, 'OK', [{ id: 'answer_quality_week' }], 'answers');
    db.prepare("UPDATE quality_reports SET created_at = ?").run(
      new Date(Date.now() - (QUALITY_ANSWERS_EVERY_DAYS + 1) * 86_400_000).toISOString(),
    );
    const start = vi.fn(() => fakeAction);
    expect(runDueJobs({ db, dataDir: '/tmp', startActionImpl: start })).toEqual(['quality_answers']);
    db.close();
  });

  it('raport quality gate NIE zalicza się jako raport odpowiedzi (D10-09)', () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO kb_registry (namespace, name, job_prefix, status, created_at, updated_at) VALUES ('Docs','Docs','docs','active',?,?)",
    ).run(new Date().toISOString(), new Date().toISOString());
    saveQualityReport(db, 'Docs', 1, 'OK', [{ id: 'export_integrity' }], 'gate');
    const start = vi.fn(() => fakeAction);
    expect(runDueJobs({ db, dataDir: '/tmp', startActionImpl: start })).toEqual(['quality_answers']);
    db.close();
  });

  it('błąd startu akcji (409 — poprzedni bieg trwa) nie wywraca workera', () => {
    const db = freshDb();
    const logs: string[] = [];
    const start = vi.fn(() => {
      throw new Error('action_already_running');
    });
    expect(runDueJobs({ db, dataDir: '/tmp', startActionImpl: start, log: (m) => logs.push(m) })).toEqual([]);
    expect(logs.join(' ')).toContain('action_already_running');
    db.close();
  });
});
