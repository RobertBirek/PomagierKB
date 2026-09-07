/**
 * Kontrakt stanu backupu między HOSTEM a panelem — czysta warstwa parsowania.
 *
 * Dlaczego to w ogóle wygląda tak, a nie „panel czyta katalog kopii": kontener panelu
 * ma zamontowany WYŁĄCZNIE własny `/data` (uid 10001, read-only rootfs) i nie widzi
 * `/srv/kag-data/backups` — ten katalog jest 0700 root. Nie ma też socketu dockera ani
 * uprawnień do systemd. Backup i odtwarzanie są operacjami roota i mają nimi zostać;
 * gdyby panel potrafił je wykonać, pierwszy audyt słusznie zgłosiłby to jako eskalację
 * uprawnień przez interfejs WWW.
 *
 * Dlatego most jest jednokierunkowy i płaski: `deploy/scripts/backup_state.sh` (timer
 * co 10 min + po każdym biegu backupu/weryfikacji) zapisuje do katalogu danych panelu
 * plik `backup-state.json` WOLNY OD SEKRETÓW, a panel go tylko czyta. Ten moduł jest
 * czystą funkcją: `parseBackupState(raw, now)`. Zero I/O, zero frameworka — testy
 * w `test/backup-state.test.ts`.
 *
 * Zasada parsowania: host może być starszy niż panel (albo odwrotnie), plik może być
 * ucięty w połowie zapisu, a pola mogą przyjść w złym typie. Każde pole jest więc
 * walidowane osobno, a brak danych daje `null` — NIGDY wyjątek i nigdy zmyśloną
 * wartość. Strona, która nie wie, czy backup działa, musi to powiedzieć wprost.
 */

/** Werdykt sondy — ta sama skala co kokpit (`services/status.ts`). */
export type BackupVerdict = 'ok' | 'warn' | 'down' | 'unknown';

export interface BackupOffsite {
  target: string | null;
  /** Wprost z manifestu: not_configured | ok | failed | blocked_no_encryption | … */
  status: string | null;
  /** none | age | gpg | plaintext */
  encryption: string | null;
  artifact: string | null;
}

export interface BackupRun {
  stamp: string | null;
  createdAt: string | null;
  ok: boolean | null;
  sizeBytes: number | null;
  coreArtifacts: number | null;
  missingRequired: string[];
  warnings: string[];
  /** hot = tar przy działającym Neo4j; cold = po zatrzymaniu bazy (miesięczne okno). */
  neo4jMode: string | null;
  offsite: BackupOffsite;
}

export interface BackupVerifyCheck {
  name: string;
  ok: boolean;
  detail: string | null;
}

export interface BackupVerify {
  stamp: string | null;
  checkedAt: string | null;
  ok: boolean | null;
  snapshotStamp: string | null;
  checks: BackupVerifyCheck[];
  failed: string[];
}

export interface BackupSnapshot {
  stamp: string;
  sizeBytes: number | null;
  ok: boolean | null;
  neo4jMode: string | null;
  /** Snapshot zatrzymany przez retencję miesięczną (pierwszy kompletny w miesiącu). */
  monthly: boolean;
}

export interface BackupTimer {
  unit: string;
  enabled: boolean | null;
  next: string | null;
  last: string | null;
}

export interface BackupHostConfig {
  /** Czy `BACKUP_OFFSITE_TARGET` jest ustawiony na hoście (sama wartość, nie sekret). */
  offsiteTarget: string | null;
  /** age | gpg | none — który odbiorca szyfrowania jest skonfigurowany. */
  encryption: string | null;
  /** TYLKO fakt konfiguracji — URL push-monitora zawiera token i nigdy tu nie trafia. */
  pingBackupConfigured: boolean | null;
  pingVerifyConfigured: boolean | null;
  /** Nazwy remote'ów rclone (bez poświadczeń) — puste = rclone nieskonfigurowany. */
  rcloneRemotes: string[];
  retentionDays: number | null;
  monthlyRetentionMonths: number | null;
}

export interface BackupDisk {
  freeBytes: number | null;
  usedPercent: number | null;
}

export interface BackupState {
  /** Kiedy host wygenerował ten plik (nie: kiedy panel go przeczytał). */
  generatedAt: string | null;
  /** Wiek pliku stanu w sekundach — powyżej progu strona ostrzega, że dane są zwietrzałe. */
  stateAgeSeconds: number | null;
  last: BackupRun | null;
  verify: BackupVerify | null;
  snapshots: BackupSnapshot[];
  timers: BackupTimer[];
  config: BackupHostConfig;
  disk: BackupDisk;
  /** Czy host obsługuje wyzwalanie przez plik-znacznik (jednostka .path zainstalowana). */
  triggerSupported: boolean;
}

/**
 * Progi świeżości — takie same jak sonda `backup` w kokpicie (`services/status.ts`),
 * świadomie zduplikowane jako stałe, a nie import: kokpit ocenia POJEDYNCZĄ sondę,
 * a ta strona ocenia cały łańcuch (backup + weryfikacja + off-site). Gdyby progi
 * miały się rozjechać, rozjadą się WIDOCZNIE, a nie po cichu przez zmianę w cudzym module.
 */
export const BACKUP_WARN_HOURS = 26;
export const BACKUP_DOWN_HOURS = 50;
/** Weryfikacja biega co tydzień; 8 dni ciszy to już nie „w tym tygodniu jeszcze nie było". */
export const VERIFY_WARN_DAYS = 8;
export const VERIFY_DOWN_DAYS = 15;
/** Plik stanu odświeża timer co 10 min — 45 min ciszy znaczy, że timer nie działa. */
export const STATE_STALE_SECONDS = 45 * 60;

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strArray(value: unknown, limit = 50): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v !== '').slice(0, limit);
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Wiek w sekundach albo null, gdy znacznik czasu jest nieparsowalny. */
export function ageSeconds(iso: string | null, now: Date): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now.getTime() - t) / 1000));
}

function parseOffsite(raw: unknown): BackupOffsite {
  const o = obj(raw);
  if (o === null) return { target: null, status: null, encryption: null, artifact: null };
  return {
    target: str(o['target']),
    status: str(o['status']),
    encryption: str(o['encryption']),
    artifact: str(o['artifact']),
  };
}

function parseRun(raw: unknown): BackupRun | null {
  const o = obj(raw);
  if (o === null) return null;
  return {
    stamp: str(o['stamp']),
    createdAt: str(o['createdAt']),
    ok: bool(o['ok']),
    sizeBytes: num(o['sizeBytes']),
    coreArtifacts: num(o['coreArtifacts']),
    missingRequired: strArray(o['missingRequired']),
    warnings: strArray(o['warnings'], 20),
    neo4jMode: str(o['neo4jMode']),
    offsite: parseOffsite(o['offsite']),
  };
}

function parseVerify(raw: unknown): BackupVerify | null {
  const o = obj(raw);
  if (o === null) return null;
  const checks: BackupVerifyCheck[] = [];
  if (Array.isArray(o['checks'])) {
    for (const item of (o['checks'] as unknown[]).slice(0, 40)) {
      const c = obj(item);
      const name = c === null ? null : str(c['name']);
      if (c === null || name === null) continue;
      checks.push({ name, ok: c['ok'] === true, detail: str(c['detail']) });
    }
  }
  const failed = strArray(o['failed'], 40);
  // Gdy host przysłał tylko listę nazw (starszy kształt), odtwarzamy z niej checki —
  // strona ma wtedy mniej szczegółu, ale nadal pokazuje, CO padło.
  if (checks.length === 0 && failed.length > 0) {
    for (const name of failed) checks.push({ name, ok: false, detail: null });
  }
  return {
    stamp: str(o['stamp']),
    checkedAt: str(o['checkedAt']),
    ok: bool(o['ok']),
    snapshotStamp: str(o['snapshotStamp']),
    checks,
    failed: failed.length > 0 ? failed : checks.filter((c) => !c.ok).map((c) => c.name),
  };
}

function parseSnapshots(raw: unknown): BackupSnapshot[] {
  if (!Array.isArray(raw)) return [];
  const out: BackupSnapshot[] = [];
  for (const item of (raw as unknown[]).slice(0, 200)) {
    const o = obj(item);
    const stamp = o === null ? null : str(o['stamp']);
    if (o === null || stamp === null) continue;
    out.push({
      stamp,
      sizeBytes: num(o['sizeBytes']),
      ok: bool(o['ok']),
      neo4jMode: str(o['neo4jMode']),
      monthly: o['monthly'] === true,
    });
  }
  // Najnowsze pierwsze: stempel jest sortowalny leksykograficznie (RRRR-MM-DD_GGMMSS).
  out.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
  return out;
}

function parseTimers(raw: unknown): BackupTimer[] {
  if (!Array.isArray(raw)) return [];
  const out: BackupTimer[] = [];
  for (const item of (raw as unknown[]).slice(0, 20)) {
    const o = obj(item);
    const unit = o === null ? null : str(o['unit']);
    if (o === null || unit === null) continue;
    out.push({ unit, enabled: bool(o['enabled']), next: str(o['next']), last: str(o['last']) });
  }
  return out;
}

function parseConfig(raw: unknown): BackupHostConfig {
  const o = obj(raw);
  if (o === null) {
    return {
      offsiteTarget: null,
      encryption: null,
      pingBackupConfigured: null,
      pingVerifyConfigured: null,
      rcloneRemotes: [],
      retentionDays: null,
      monthlyRetentionMonths: null,
    };
  }
  return {
    offsiteTarget: str(o['offsiteTarget']),
    encryption: str(o['encryption']),
    pingBackupConfigured: bool(o['pingBackupConfigured']),
    pingVerifyConfigured: bool(o['pingVerifyConfigured']),
    rcloneRemotes: strArray(o['rcloneRemotes'], 20),
    retentionDays: num(o['retentionDays']),
    monthlyRetentionMonths: num(o['monthlyRetentionMonths']),
  };
}

/**
 * Parsuje `backup-state.json`. `null` wyłącznie wtedy, gdy to w ogóle nie jest obiekt
 * JSON — każdy inny brak jest reprezentowany polem `null`, żeby strona umiała odróżnić
 * „host nie raportuje" od „host raportuje, że jest źle".
 */
export function parseBackupState(raw: string, now: Date): BackupState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const o = obj(parsed);
  if (o === null) return null;
  const generatedAt = str(o['generatedAt']);
  const disk = obj(o['disk']);
  return {
    generatedAt,
    stateAgeSeconds: ageSeconds(generatedAt, now),
    last: parseRun(o['last']),
    verify: parseVerify(o['verify']),
    snapshots: parseSnapshots(o['snapshots']),
    timers: parseTimers(o['timers']),
    config: parseConfig(o['config']),
    disk: {
      freeBytes: disk === null ? null : num(disk['freeBytes']),
      usedPercent: disk === null ? null : num(disk['usedPercent']),
    },
    triggerSupported: o['triggerSupported'] === true,
  };
}

/**
 * Werdykt świeżości ostatniego backupu. `unknown` (nie `down`) przy braku danych:
 * „nie wiem" i „na pewno źle" to dwie różne informacje i mieszanie ich uczy ignorować
 * czerwone. Niekompletny snapshot to od razu `down` — istnieje, ale nie da się z niego
 * odtworzyć systemu, co jest gorsze niż jego brak, bo wygląda jak sukces.
 */
export function backupVerdict(run: BackupRun | null, now: Date): { verdict: BackupVerdict; detail: string } {
  if (run === null) return { verdict: 'unknown', detail: 'host nie raportuje stanu backupu' };
  if (run.ok === false) {
    const missing = run.missingRequired.length > 0 ? `: brak ${run.missingRequired.join(', ')}` : '';
    return { verdict: 'down', detail: `ostatni snapshot NIEKOMPLETNY${missing}` };
  }
  const age = ageSeconds(run.createdAt, now);
  if (age === null) return { verdict: 'unknown', detail: 'brak daty ostatniego snapshotu' };
  const hours = age / 3600;
  if (hours > BACKUP_DOWN_HOURS) {
    return { verdict: 'down', detail: `ostatni snapshot sprzed ${Math.round(hours)} h` };
  }
  if (hours > BACKUP_WARN_HOURS) {
    return { verdict: 'warn', detail: `ostatni snapshot sprzed ${Math.round(hours)} h` };
  }
  return { verdict: 'ok', detail: `snapshot sprzed ${Math.round(hours)} h` };
}

/** Werdykt weryfikacji odtwarzania — czerwony, gdy padła; żółty, gdy zbyt dawno. */
export function verifyVerdict(verify: BackupVerify | null, now: Date): { verdict: BackupVerdict; detail: string } {
  if (verify === null) return { verdict: 'unknown', detail: 'weryfikacja jeszcze nie raportowała' };
  if (verify.ok === false) {
    const failed = verify.failed.length > 0 ? `: ${verify.failed.join(', ')}` : '';
    return { verdict: 'down', detail: `ostatnia weryfikacja NIE przeszła${failed}` };
  }
  const age = ageSeconds(verify.checkedAt, now);
  if (age === null) return { verdict: 'unknown', detail: 'brak daty weryfikacji' };
  const days = age / 86400;
  if (days > VERIFY_DOWN_DAYS) return { verdict: 'down', detail: `weryfikacja sprzed ${Math.round(days)} dni` };
  if (days > VERIFY_WARN_DAYS) return { verdict: 'warn', detail: `weryfikacja sprzed ${Math.round(days)} dni` };
  return { verdict: 'ok', detail: `zweryfikowano ${Math.round(days)} dni temu` };
}

/**
 * Werdykt kopii off-site. `blocked_no_encryption` jest czerwone celowo: znaczy, że cel
 * JEST ustawiony, a snapshot z kompletem sekretów platformy nie wychodzi tylko dlatego,
 * że `backup.sh` się na to nie zgodził. To stan wymagający reakcji, nie ostrzeżenie.
 */
export function offsiteVerdict(run: BackupRun | null): { verdict: BackupVerdict; detail: string } {
  const status = run?.offsite.status ?? null;
  if (status === null) return { verdict: 'unknown', detail: 'brak informacji o kopii off-site' };
  switch (status) {
    case 'ok':
      return {
        verdict: run?.offsite.encryption === 'plaintext' ? 'warn' : 'ok',
        detail:
          run?.offsite.encryption === 'plaintext'
            ? 'wysłane BEZ SZYFROWANIA — sekrety platformy opuszczają host jawnym tekstem'
            : `wysłane (${run?.offsite.encryption ?? 'szyfrowane'})`,
      };
    case 'not_configured':
      return { verdict: 'warn', detail: 'brak celu — wszystkie kopie leżą na tym samym dysku co dane' };
    case 'disabled':
      // Świadoma decyzja operatora, więc nie „awaria" — ale nadal ostrzeżenie, bo ryzyko
      // jest identyczne jak przy braku celu: utrata dysku = utrata wszystkich kopii.
      return { verdict: 'warn', detail: 'wyłączona w panelu — kopie zostają wyłącznie na tym dysku' };
    case 'blocked_no_encryption':
      return { verdict: 'down', detail: 'cel ustawiony, ale brak klucza szyfrowania — wysyłka wstrzymana' };
    case 'failed':
      return { verdict: 'down', detail: 'wysyłka off-site nie powiodła się' };
    default:
      return { verdict: 'unknown', detail: `nieznany status: ${status}` };
  }
}

/** Czy dane ze stanu są na tyle stare, że nie wolno ich pokazywać jako bieżących. */
export function stateIsStale(state: BackupState): boolean {
  return state.stateAgeSeconds === null || state.stateAgeSeconds > STATE_STALE_SECONDS;
}
