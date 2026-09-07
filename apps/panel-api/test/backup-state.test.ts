import { describe, expect, it } from 'vitest';
import {
  ageSeconds,
  backupVerdict,
  offsiteVerdict,
  parseBackupState,
  stateIsStale,
  verifyVerdict,
  type BackupRun,
} from '../src/services/backup-state.js';

/**
 * Kontrakt hosta z panelem. Testy pilnują JEDNEJ rzeczy ponad poprawnością parsowania:
 * że brak danych nigdy nie udaje danych. „Nie wiem" i „na pewno źle" muszą zostać
 * rozróżnialne, bo tylko wtedy czerwone na tej stronie coś znaczy.
 */

const NOW = new Date('2026-09-07T12:00:00Z');

function run(overrides: Partial<BackupRun> = {}): BackupRun {
  return {
    stamp: '2026-09-07_030000',
    createdAt: '2026-09-07T11:00:00Z',
    ok: true,
    sizeBytes: 6_500_000,
    coreArtifacts: 5,
    missingRequired: [],
    warnings: [],
    neo4jMode: 'hot',
    offsite: { target: null, status: 'ok', encryption: 'age', artifact: 'x.tar.age' },
    ...overrides,
  };
}

describe('parseBackupState', () => {
  it('czyta pełny stan i liczy wiek pliku', () => {
    const state = parseBackupState(
      JSON.stringify({
        generatedAt: '2026-09-07T11:55:00Z',
        last: { stamp: 'a', ok: true, missingRequired: [], offsite: { status: 'ok' } },
        verify: { ok: true, checks: [{ name: 'mysql_restore', ok: true, detail: '34 tabele' }] },
        snapshots: [{ stamp: '2026-09-06_030000' }, { stamp: '2026-09-07_030000' }],
        timers: [{ unit: 'kag-backup.timer', enabled: true, next: 'x', last: 'y' }],
        config: { encryption: 'age', pingBackupConfigured: true, rcloneRemotes: ['contabo'] },
        disk: { freeBytes: 1234, usedPercent: 13 },
        triggerSupported: true,
      }),
      NOW,
    );
    expect(state?.stateAgeSeconds).toBe(300);
    expect(state?.last?.stamp).toBe('a');
    expect(state?.verify?.checks[0]?.detail).toBe('34 tabele');
    expect(state?.config.rcloneRemotes).toEqual(['contabo']);
    expect(state?.triggerSupported).toBe(true);
  });

  it('sortuje snapshoty od najnowszego — stempel jest sortowalny leksykograficznie', () => {
    const state = parseBackupState(
      JSON.stringify({ snapshots: [{ stamp: '2026-09-05_030000' }, { stamp: '2026-09-07_030000' }, { stamp: '2026-09-06_030000' }] }),
      NOW,
    );
    expect(state?.snapshots.map((s) => s.stamp)).toEqual([
      '2026-09-07_030000',
      '2026-09-06_030000',
      '2026-09-05_030000',
    ]);
  });

  it('nie wywraca się na złych typach — każde pole osobno degraduje do null', () => {
    const state = parseBackupState(
      JSON.stringify({
        generatedAt: 42,
        last: { stamp: [], ok: 'tak', missingRequired: 'brak', offsite: 'nope' },
        verify: { checks: [{ ok: true }, 'śmieć', { name: 'x', ok: false }] },
        snapshots: ['śmieć', { sizeBytes: 1 }, { stamp: 'ok-1' }],
        timers: 'brak',
        disk: null,
      }),
      NOW,
    );
    expect(state).not.toBeNull();
    expect(state?.generatedAt).toBeNull();
    expect(state?.stateAgeSeconds).toBeNull();
    expect(state?.last?.stamp).toBeNull();
    expect(state?.last?.ok).toBeNull();
    expect(state?.last?.missingRequired).toEqual([]);
    expect(state?.last?.offsite.status).toBeNull();
    // Wpisy bez nazwy odpadają — reszta zostaje.
    expect(state?.verify?.checks).toEqual([{ name: 'x', ok: false, detail: null }]);
    expect(state?.snapshots.map((s) => s.stamp)).toEqual(['ok-1']);
    expect(state?.timers).toEqual([]);
    expect(state?.disk).toEqual({ freeBytes: null, usedPercent: null });
  });

  it('null tylko wtedy, gdy to w ogóle nie jest obiekt JSON', () => {
    expect(parseBackupState('to nie json', NOW)).toBeNull();
    expect(parseBackupState('[1,2,3]', NOW)).toBeNull();
    expect(parseBackupState('null', NOW)).toBeNull();
    expect(parseBackupState('{}', NOW)).not.toBeNull();
  });

  it('odtwarza checki ze starszego kształtu, który miał tylko listę nazw', () => {
    const state = parseBackupState(JSON.stringify({ verify: { ok: false, failed: ['mysql_restore'] } }), NOW);
    expect(state?.verify?.checks).toEqual([{ name: 'mysql_restore', ok: false, detail: null }]);
    expect(state?.verify?.failed).toEqual(['mysql_restore']);
  });
});

describe('backupVerdict', () => {
  it('brak raportu to „nie wiem", nie „awaria"', () => {
    expect(backupVerdict(null, NOW).verdict).toBe('unknown');
  });

  it('niekompletny snapshot jest czerwony niezależnie od świeżości', () => {
    const verdict = backupVerdict(run({ ok: false, missingRequired: ['mysql'] }), NOW);
    expect(verdict.verdict).toBe('down');
    expect(verdict.detail).toContain('mysql');
  });

  it('progi wieku: 1 h ok, 27 h ostrzeżenie, 60 h awaria', () => {
    expect(backupVerdict(run(), NOW).verdict).toBe('ok');
    expect(backupVerdict(run({ createdAt: '2026-09-06T09:00:00Z' }), NOW).verdict).toBe('warn');
    expect(backupVerdict(run({ createdAt: '2026-09-05T00:00:00Z' }), NOW).verdict).toBe('down');
  });

  it('nieparsowalna data nie udaje świeżości', () => {
    expect(backupVerdict(run({ createdAt: 'wczoraj' }), NOW).verdict).toBe('unknown');
  });
});

describe('verifyVerdict', () => {
  it('czerwony przy porażce, z nazwami checków', () => {
    const verdict = verifyVerdict(
      { stamp: null, checkedAt: '2026-09-07T10:00:00Z', ok: false, snapshotStamp: null, checks: [], failed: ['neo4j_restore'] },
      NOW,
    );
    expect(verdict.verdict).toBe('down');
    expect(verdict.detail).toContain('neo4j_restore');
  });

  it('progi: 2 dni ok, 10 dni ostrzeżenie, 20 dni awaria', () => {
    const at = (iso: string) => ({ stamp: null, checkedAt: iso, ok: true, snapshotStamp: null, checks: [], failed: [] });
    expect(verifyVerdict(at('2026-09-05T12:00:00Z'), NOW).verdict).toBe('ok');
    expect(verifyVerdict(at('2026-08-28T12:00:00Z'), NOW).verdict).toBe('warn');
    expect(verifyVerdict(at('2026-08-18T12:00:00Z'), NOW).verdict).toBe('down');
  });
});

describe('offsiteVerdict', () => {
  it('zablokowana wysyłka jest czerwona — cel jest, a kopia nie wychodzi', () => {
    expect(offsiteVerdict(run({ offsite: { target: 'x', status: 'blocked_no_encryption', encryption: null, artifact: null } })).verdict).toBe('down');
  });

  it('brak celu i wyłączenie w panelu to ostrzeżenia, nie awarie', () => {
    expect(offsiteVerdict(run({ offsite: { target: null, status: 'not_configured', encryption: null, artifact: null } })).verdict).toBe('warn');
    expect(offsiteVerdict(run({ offsite: { target: null, status: 'disabled', encryption: null, artifact: null } })).verdict).toBe('warn');
  });

  it('wysyłka jawnym tekstem NIE jest zielona, choć się udała', () => {
    const verdict = offsiteVerdict(run({ offsite: { target: 'x', status: 'ok', encryption: 'plaintext', artifact: 'a' } }));
    expect(verdict.verdict).toBe('warn');
    expect(verdict.detail).toContain('BEZ SZYFROWANIA');
  });

  it('udana wysyłka zaszyfrowana jest zielona', () => {
    expect(offsiteVerdict(run()).verdict).toBe('ok');
  });
});

describe('stateIsStale / ageSeconds', () => {
  it('brak znacznika czasu liczy się jako zwietrzały', () => {
    const state = parseBackupState('{}', NOW);
    expect(state).not.toBeNull();
    expect(stateIsStale(state!)).toBe(true);
  });

  it('45 minut to próg', () => {
    const fresh = parseBackupState(JSON.stringify({ generatedAt: '2026-09-07T11:20:00Z' }), NOW);
    const old = parseBackupState(JSON.stringify({ generatedAt: '2026-09-07T11:10:00Z' }), NOW);
    expect(stateIsStale(fresh!)).toBe(false);
    expect(stateIsStale(old!)).toBe(true);
  });

  it('data z przyszłości nie daje ujemnego wieku', () => {
    expect(ageSeconds('2026-09-08T00:00:00Z', NOW)).toBe(0);
  });
});
