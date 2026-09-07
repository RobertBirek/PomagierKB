import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Db } from '@pomagierkb/shared/db';
import { getSetting } from '@pomagierkb/shared/db';
import { AppError } from '@pomagierkb/shared/errors';
import type { AppConfig } from '../config.js';
import {
  backupVerdict,
  offsiteVerdict,
  parseBackupState,
  stateIsStale,
  verifyVerdict,
  type BackupState,
  type BackupVerdict,
} from './backup-state.js';

/**
 * Serwis strony /backup. Trzy operacje, wszystkie przez katalog danych panelu (`/data`),
 * bo to JEDYNY punkt styku kontenera z hostem — panel nie ma socketu dockera, nie widzi
 * `/srv/kag-data/backups` i nie ma dostępu do systemd (i nie powinien mieć).
 *
 *  1. ODCZYT stanu — `backup-state.json` pisany przez `deploy/scripts/backup_state.sh`.
 *  2. ZAPIS konfiguracji NIESEKRETNEJ — ustawienie `backup` w SQLite jest źródłem prawdy,
 *     a `backup-config.json` jego eksportem dla skryptów hosta. Sekrety (poświadczenia
 *     rclone, klucz age, URL-e push-monitorów z tokenami) zostają w `/etc/kag/alerts.env`
 *     i przez panel NIE przechodzą — ani w tę, ani w tamtą stronę.
 *  3. WYZWOLENIE biegu — plik-znacznik `backup-request.json`, który na hoście podnosi
 *     jednostka `kag-backup-request.path`. Świadomie NIE jest to zdalne wykonanie
 *     polecenia: znacznik niesie wyłącznie `kind` z dwuelementowego enuma, host go
 *     waliduje po swojej stronie i sam decyduje, którą jednostkę uruchomić. Najgorsze,
 *     co daje przejęcie tej ścieżki, to wymuszony backup.
 *
 * ODTWARZANIE NIE MA TU SWOJEJ OPERACJI i mieć nie będzie. Restore nadpisuje wszystkie
 * magazyny naraz; przycisk w przeglądarce robiący to jednym kliknięciem byłby najkrótszą
 * drogą do utraty danych, jaką da się dodać do tego systemu. Strona prowadzi za rękę
 * konkretnymi komendami — wykonuje je człowiek na hoście.
 */

const STATE_FILE = 'backup-state.json';
const CONFIG_FILE = 'backup-config.json';
const REQUEST_FILE = 'backup-request.json';

/** Ile sekund znacznik uznajemy za „jeszcze nieobsłużony" (blokada spamu przyciskiem). */
const REQUEST_PENDING_SECONDS = 120;

export type BackupRunKind = 'backup' | 'verify';

export interface BackupConfig {
  /** Ile dni trzymać snapshoty dzienne. */
  retentionDays: number;
  /** Ile miesięcy trzymać pierwszy KOMPLETNY snapshot każdego miesiąca. */
  monthlyRetentionMonths: number;
  /** Czy wysyłać kopię off-site (cel i klucz szyfrowania konfiguruje operator na hoście). */
  offsiteEnabled: boolean;
  /** Czy comiesięczny snapshot Neo4j robić „na zimno" (stop → tar → start). */
  coldNeo4jEnabled: boolean;
}

export const BACKUP_CONFIG_DEFAULT: BackupConfig = {
  retentionDays: 14,
  monthlyRetentionMonths: 6,
  offsiteEnabled: true,
  coldNeo4jEnabled: true,
};

/**
 * Granice sanity. Retencja 0 dni skasowałaby snapshot zaraz po jego zrobieniu, a 3650 dni
 * zapełniłoby dysk — bramka jest tu, a nie w UI, bo UI to tylko UX.
 */
const LIMITS = {
  retentionDays: { min: 2, max: 365 },
  monthlyRetentionMonths: { min: 0, max: 120 },
} as const;

function clampError(field: string, min: number, max: number): AppError {
  return new AppError('validation_error', `${field}: wartość poza zakresem ${min}–${max}`);
}

/** Waluje i normalizuje wartość ustawienia `backup` (czysta funkcja — testowana). */
export function coerceBackupConfig(value: unknown): BackupConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('validation_error', 'ustawienie backup wymaga obiektu konfiguracji');
  }
  const o = value as Record<string, unknown>;
  const out: BackupConfig = { ...BACKUP_CONFIG_DEFAULT };

  for (const field of ['retentionDays', 'monthlyRetentionMonths'] as const) {
    const raw = o[field];
    if (raw === undefined) continue;
    if (typeof raw !== 'number' || !Number.isInteger(raw)) {
      throw new AppError('validation_error', `${field}: wymagana liczba całkowita`);
    }
    const { min, max } = LIMITS[field];
    if (raw < min || raw > max) throw clampError(field, min, max);
    out[field] = raw;
  }
  for (const field of ['offsiteEnabled', 'coldNeo4jEnabled'] as const) {
    const raw = o[field];
    if (raw === undefined) continue;
    if (typeof raw !== 'boolean') throw new AppError('validation_error', `${field}: wymagana wartość logiczna`);
    out[field] = raw;
  }
  return out;
}

/** Konfiguracja z SQLite (źródło prawdy) z domyślnymi przy braku/uszkodzeniu wpisu. */
export function readBackupConfig(db: Db): BackupConfig {
  try {
    const stored = getSetting(db, 'backup')?.value ?? null;
    if (stored === null) return { ...BACKUP_CONFIG_DEFAULT };
    return coerceBackupConfig(stored);
  } catch {
    // Uszkodzony wpis nie może zablokować strony — pokazujemy domyślne i pozwalamy zapisać.
    return { ...BACKUP_CONFIG_DEFAULT };
  }
}

/** Atomowy zapis pliku w katalogu danych (tmp + rename — skrypty hosta czytają go w tle). */
function writeAtomic(dataDir: string, name: string, body: string): void {
  const target = join(dataDir, name);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, target);
}

/**
 * Eksport konfiguracji dla skryptów hosta. Wołany po KAŻDYM zapisie ustawienia, żeby
 * `backup.sh` nie musiał czytać SQLite (nie ma tam klienta sqlite — host nie ma nawet
 * binarki `sqlite3`). Brak pliku = skrypty biorą własne wartości domyślne.
 */
export function exportBackupConfig(config: AppConfig, value: BackupConfig): void {
  writeAtomic(
    config.dataDir,
    CONFIG_FILE,
    JSON.stringify({ schema: 1, updatedAt: new Date().toISOString(), ...value }, null, 2) + '\n',
  );
}

export interface BackupStateView {
  state: BackupState | null;
  /** true, gdy host nie raportował od dłuższego czasu — dane są archiwalne, nie bieżące. */
  stale: boolean;
  verdicts: {
    backup: { verdict: BackupVerdict; detail: string };
    verify: { verdict: BackupVerdict; detail: string };
    offsite: { verdict: BackupVerdict; detail: string };
  };
  config: BackupConfig;
  /** Znacznik czeka na obsłużenie przez hosta (przycisk ma być wtedy zablokowany). */
  requestPending: boolean;
}

/**
 * Pełny widok dla strony /backup. Brak pliku stanu NIE jest błędem 500 — to normalny stan
 * świeżej instalacji albo hosta bez zainstalowanego timera; strona ma wtedy powiedzieć
 * „host nie raportuje", a nie wysypać się na czerwono.
 */
export function readBackupState(db: Db, config: AppConfig, now: Date = new Date()): BackupStateView {
  let state: BackupState | null = null;
  try {
    state = parseBackupState(readFileSync(join(config.dataDir, STATE_FILE), 'utf8'), now);
  } catch {
    state = null;
  }
  return {
    state,
    stale: state !== null && stateIsStale(state),
    verdicts: {
      backup: backupVerdict(state?.last ?? null, now),
      verify: verifyVerdict(state?.verify ?? null, now),
      offsite: offsiteVerdict(state?.last ?? null),
    },
    config: readBackupConfig(db),
    requestPending: requestIsPending(config, now),
  };
}

function requestIsPending(config: AppConfig, now: Date): boolean {
  try {
    const st = statSync(join(config.dataDir, REQUEST_FILE));
    return now.getTime() - st.mtimeMs < REQUEST_PENDING_SECONDS * 1000;
  } catch {
    return false;
  }
}

export interface BackupRunRequest {
  kind: BackupRunKind;
  requestedAt: string;
  requestId: string;
}

/**
 * Kładzie znacznik żądania biegu. Odmawia, gdy poprzedni jeszcze nie został sprzątnięty —
 * host kasuje plik natychmiast po odczycie, więc świeży znacznik znaczy „host jeszcze nie
 * zareagował albo nie działa", a nie „można dołożyć kolejny".
 */
export function requestBackupRun(config: AppConfig, kind: BackupRunKind, now: Date = new Date()): BackupRunRequest {
  if (requestIsPending(config, now)) {
    throw new AppError(
      'action_already_running',
      'poprzednie żądanie czeka na obsługę przez hosta — odczekaj chwilę albo sprawdź jednostkę kag-backup-request.path',
    );
  }
  const request: BackupRunRequest = { kind, requestedAt: now.toISOString(), requestId: randomUUID() };
  writeAtomic(config.dataDir, REQUEST_FILE, JSON.stringify(request) + '\n');
  return request;
}
