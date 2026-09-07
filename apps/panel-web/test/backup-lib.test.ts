import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatStamp,
  recoverySteps,
  shouldRemindAboutKeyCustody,
  verdictTone,
  verdictVariant,
} from '../src/lib/backup';

describe('formatBytes', () => {
  it('brak wartości daje kreskę, nie zero', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    // 0 bajtów to FAKT (pusty snapshot!), a nie brak danych — musi być widoczne.
    expect(formatBytes(0)).toBe('0 B');
  });

  it('skaluje jednostki i używa polskiego przecinka', () => {
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(6_500_000)).toBe('6,5 MB');
    expect(formatBytes(409_000_000_000)).toBe('409 GB');
  });
});

describe('formatStamp', () => {
  it('zamienia stempel snapshotu na datę po polsku', () => {
    expect(formatStamp('2026-09-07_142337')).toBe('07.09.2026, 14:23');
  });

  it('nieznany format zostaje bez zmian — lepiej pokazać surowy niż zmyślić', () => {
    expect(formatStamp('cokolwiek')).toBe('cokolwiek');
  });
});

describe('verdictVariant / verdictTone', () => {
  it('nieznany werdykt jest neutralny, nie czerwony', () => {
    expect(verdictVariant('unknown')).toBe('neutral');
    expect(verdictTone('unknown')).toBe('default');
    expect(verdictVariant('down')).toBe('fail');
    expect(verdictTone('warn')).toBe('warn');
  });
});

describe('recoverySteps', () => {
  const local = recoverySteps({ stamp: '2026-09-07_142337', offsiteArtifact: null, offsiteTarget: null, encryption: null });

  it('sprawdzenie integralności wypada PRZED odtworzeniem', () => {
    const check = local.findIndex((s) => s.command.includes('sha256sum -c'));
    const restore = local.findIndex((s) => s.command.includes('restore.sh'));
    expect(check).toBeGreaterThanOrEqual(0);
    expect(restore).toBeGreaterThan(check);
  });

  it('komendy wskazują na wybrany snapshot, nie na ogólny wzorzec', () => {
    expect(local.every((s) => !s.command.includes('<STEMPEL>'))).toBe(true);
    expect(local.some((s) => s.command.includes('/srv/kag-data/backups/nightly/2026-09-07_142337'))).toBe(true);
  });

  it('kończy się dowodem, że odtworzenie wyszło', () => {
    expect(local[local.length - 1]?.command).toContain('verify_backup.sh');
  });

  it('bez skonfigurowanego off-site nie ma kroków pobierania i odszyfrowania', () => {
    expect(local.some((s) => s.command.includes('rclone'))).toBe(false);
    expect(local.some((s) => s.command.includes('age -d'))).toBe(false);
  });

  it('z celem rclone dokłada pobranie i odszyfrowanie, w tej kolejności', () => {
    const steps = recoverySteps({
      stamp: '2026-09-07_142337',
      offsiteArtifact: '2026-09-07_142337.tar.age',
      offsiteTarget: 'rclone://contabo:pomagierkb-backups',
      encryption: 'age',
    });
    const copy = steps.findIndex((s) => s.command.includes('rclone copy'));
    const decrypt = steps.findIndex((s) => s.command.includes('age -d'));
    expect(copy).toBe(0);
    expect(decrypt).toBe(1);
    // Prefiks rclone:// jest naszą konwencją w .env — do komendy nie może trafić.
    expect(steps[0]?.command).not.toContain('rclone://');
    expect(steps[0]?.command).toContain('contabo:pomagierkb-backups');
  });

  it('wariant gpg podaje gpg, nie age', () => {
    const steps = recoverySteps({
      stamp: 's',
      offsiteArtifact: 's.tar.gpg',
      offsiteTarget: 'rclone://r:b',
      encryption: 'gpg',
    });
    expect(steps[1]?.command).toContain('gpg --decrypt');
  });

  it('brak stempla daje czytelny placeholder zamiast ścieżki do nikąd', () => {
    const steps = recoverySteps({ stamp: null, offsiteArtifact: null, offsiteTarget: null, encryption: null });
    expect(steps.some((s) => s.command.includes('<STEMPEL>'))).toBe(true);
  });
});

describe('shouldRemindAboutKeyCustody', () => {
  it('przypomina tylko wtedy, gdy kopia faktycznie wyjechała zaszyfrowana', () => {
    expect(shouldRemindAboutKeyCustody('age', 'ok')).toBe(true);
    expect(shouldRemindAboutKeyCustody('gpg', 'ok')).toBe(true);
    expect(shouldRemindAboutKeyCustody('age', 'not_configured')).toBe(false);
    expect(shouldRemindAboutKeyCustody('plaintext', 'ok')).toBe(false);
    expect(shouldRemindAboutKeyCustody(null, 'ok')).toBe(false);
  });
});
