import { statfsSync, readFileSync, readdirSync } from 'node:fs';
import { connect as tlsConnect } from 'node:tls';
import { join } from 'node:path';
import type { Db } from '@pomagierkb/shared/db';
import { OpenSpgClient, listProjects } from '@pomagierkb/shared/openspg';
import { getBreakerStates, resetBreaker, type BreakerState } from '@pomagierkb/shared/llm';
import { AppError } from '@pomagierkb/shared/errors';
import type { AppConfig } from '../config.js';

/**
 * Health cockpit (GET /api/v1/status): sondy WSZYSTKICH komponentów równolegle,
 * każda z własnym timeoutem; wynik cache'owany 10 s w pamięci procesu.
 * ZERO spawnSync (lekcja optimaKB) — wyłącznie fetch/SQL/odczyt stanu breakerów.
 */

export type ComponentStatus = 'ok' | 'warn' | 'down' | 'unknown';

/**
 * Rodzaj komponentu (ustalenie D10-07): 'health' to ZDROWIE TECHNICZNE (składa się
 * na `overall` i na kropkę w nagłówku), 'work' to KOLEJKA PRACY człowieka (szkice
 * do recenzji, otwarte luki). Kolejka pracy jest normalnym stanem systemu
 * human-in-the-loop — gdy podnosiła `overall` do 'warn', wskaźnik świecił
 * na żółto praktycznie zawsze i operator przestawał reagować na realne
 * ostrzeżenia (dysk, backup, certyfikat, breaker).
 */
export type ComponentKind = 'health' | 'work';

export interface StatusComponent {
  id: string;
  /** Etykieta PL do UI. */
  label: string;
  status: ComponentStatus;
  detail: string;
  latencyMs: number;
  /** 'work' NIE wpływa na `overall` (patrz ComponentKind). Domyślnie 'health'. */
  kind?: ComponentKind;
  /**
   * Tylko sonda 'inbox': liczba szkiców czekających na recenzję (badge
   * w nawigacji panelu czyta ją wprost, bez parsowania detail).
   */
  pendingDrafts?: number;
  /** Tylko sonda 'gaps': liczba otwartych luk wiedzy (licznik dla UI). */
  openGaps?: number;
  /** Tylko sonda 'actions': liczby akcji w toku / zakończonych błędem. */
  runningActions?: number;
  failedActions?: number;
}

export interface StatusCockpit {
  components: StatusComponent[];
  /** Najgorszy status komponentów ZDROWIA (down > warn > unknown > ok). */
  overall: ComponentStatus;
  /** Najgorszy status komponentów kolejki pracy — informacyjnie, poza `overall`. */
  workload: ComponentStatus;
  generatedAt: string;
  breakers: BreakerState[];
}

const STATUS_RANK: Record<ComponentStatus, number> = { ok: 0, unknown: 1, warn: 2, down: 3 };

/** Czysta funkcja: najgorszy ze statusów (pusta lista → unknown). */
export function worstStatus(statuses: ComponentStatus[]): ComponentStatus {
  let worst: ComponentStatus = 'unknown';
  let first = true;
  for (const s of statuses) {
    if (first || STATUS_RANK[s] > STATUS_RANK[worst]) worst = s;
    first = false;
  }
  return worst;
}

const CACHE_TTL_MS = 10_000;
const PROBE_TIMEOUT_MS = 3_000;

export interface StatusServiceDeps {
  db: Db;
  config: AppConfig;
  /** Wstrzykiwany w testach; default globalThis.fetch (rozwiązywany PRZY wywołaniu). */
  fetchImpl?: typeof fetch;
}

export interface StatusService {
  /** Cockpit z cache 10 s — drugi odczyt w oknie NIE wykonuje sond. */
  getStatus(): Promise<StatusCockpit>;
  /** Ręczne zamknięcie breakera; nieznana nazwa → 404. Unieważnia cache. */
  resetBreakerByName(name: string): BreakerState[];
}

/** GET z timeoutem — {ok, status|null}; błąd/timeout NIE rzuca (mapowane na down). */
async function probeHttp(
  fetchImpl: typeof fetch,
  url: string,
): Promise<{ ok: boolean; status: number | null; timedOut: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: controller.signal });
    return { ok: res.ok, status: res.status, timedOut: false };
  } catch (err) {
    return { ok: false, status: null, timedOut: err instanceof Error && err.name === 'AbortError' };
  } finally {
    clearTimeout(timer);
  }
}

/** Wynik sondy: status + detail + opcjonalne liczniki domenowe dla UI. */
type ProbeResult = Omit<StatusComponent, 'id' | 'label' | 'latencyMs'>;

/**
 * Opakowanie sondy: mierzy latencję i zamienia wyjątki/timeouty na status down.
 * `kind` nadaje wołający (nie treść wyniku) — także ścieżka timeoutu/wyjątku musi
 * trafić do właściwej grupy: zdrowie vs kolejka pracy.
 */
async function timedProbe(
  id: string,
  label: string,
  fn: () => Promise<ProbeResult>,
  kind: ComponentKind = 'health',
): Promise<StatusComponent> {
  const startedAt = Date.now();
  try {
    const timeout = new Promise<ProbeResult>((resolve) => {
      const t = setTimeout(
        () => resolve({ status: 'down', detail: `timeout sondy (${PROBE_TIMEOUT_MS + 500} ms)` }),
        PROBE_TIMEOUT_MS + 500,
      );
      t.unref();
    });
    const result = await Promise.race([fn(), timeout]);
    return { id, label, ...result, kind, latencyMs: Date.now() - startedAt };
  } catch (err) {
    return {
      id,
      label,
      status: 'down',
      detail: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      kind,
      latencyMs: Date.now() - startedAt,
    };
  }
}

/** Werdykt ostatniej weryfikacji backupu, znormalizowany z obu kształtów raportu. */
export interface BackupVerifyReport {
  ok: boolean | null;
  checkedAt: string | null;
  /** Nazwy checków, które nie przeszły (puste, gdy raport nie podaje szczegółów). */
  failed: string[];
}

interface RawVerifyReport {
  ok?: unknown;
  checkedAt?: unknown;
  checks?: unknown;
  failed?: unknown;
}

/** Normalizacja: {ok, checkedAt, checks:[{name,ok}]} albo {ok, checkedAt, failed:[]}. */
export function parseVerifyReport(raw: string): BackupVerifyReport | null {
  let parsed: RawVerifyReport;
  try {
    parsed = JSON.parse(raw) as RawVerifyReport;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const failed: string[] = [];
  if (Array.isArray(parsed.checks)) {
    for (const c of parsed.checks) {
      if (c !== null && typeof c === 'object') {
        const check = c as { name?: unknown; ok?: unknown };
        if (check.ok === false && typeof check.name === 'string') failed.push(check.name);
      }
    }
  }
  if (Array.isArray(parsed.failed)) {
    for (const name of parsed.failed) if (typeof name === 'string') failed.push(name);
  }
  return {
    ok: typeof parsed.ok === 'boolean' ? parsed.ok : null,
    checkedAt: typeof parsed.checkedAt === 'string' ? parsed.checkedAt : null,
    failed: failed.slice(0, 20),
  };
}

/**
 * Najnowszy raport weryfikacji backupu widziany z kontenera panelu. Dwa źródła,
 * w tej kolejności:
 *  1) <dataDir>/backup-verify-status.json — podsumowanie pisane przez
 *     verify_backup.sh obok backup-status.json (wolne od sekretów, 0644);
 *  2) <dataDir>/backups/verify/verify-<stamp>.json — pełne raporty, gdy katalog
 *     jest widoczny dla panelu (dev albo bind-mount read-only).
 * Nazwy plików zawierają stempel czasu, więc największa leksykograficznie jest
 * najnowsza. Brak obu źródeł → null (sonda 'unknown', nie 'down').
 */
export function readLatestVerifyReport(dataDir: string): BackupVerifyReport | null {
  try {
    const summary = parseVerifyReport(readFileSync(join(dataDir, 'backup-verify-status.json'), 'utf8'));
    if (summary !== null) return summary;
  } catch {
    /* brak podsumowania — próbujemy katalogu raportów */
  }
  const dir = join(dataDir, 'backups', 'verify');
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.startsWith('verify-') && f.endsWith('.json'));
  } catch {
    return null;
  }
  names.sort().reverse();
  for (const name of names.slice(0, 5)) {
    try {
      const report = parseVerifyReport(readFileSync(join(dir, name), 'utf8'));
      if (report !== null) return report;
    } catch {
      /* uszkodzony/nieczytelny raport — spróbuj starszego */
    }
  }
  return null;
}

export function createStatusService(deps: StatusServiceDeps): StatusService {
  const { db, config } = deps;
  let cache: { expiresAt: number; data: StatusCockpit } | null = null;

  async function collect(): Promise<StatusCockpit> {
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

    const dbProbe = timedProbe('db', 'Baza danych (SQLite)', async () => {
      const row = db.prepare('PRAGMA quick_check(1)').get() as Record<string, string> | undefined;
      const verdict = row !== undefined ? Object.values(row)[0] : undefined;
      return verdict === 'ok'
        ? { status: 'ok', detail: 'quick_check: ok' }
        : { status: 'down', detail: `quick_check: ${String(verdict ?? 'brak wyniku')}` };
    });

    const openspgProbe = timedProbe('openspg', 'OpenSPG (graf wiedzy)', async () => {
      const client = new OpenSpgClient({
        baseUrl: config.openspg.baseUrl,
        account: config.openspg.account,
        password: config.openspg.password,
        timeoutMs: PROBE_TIMEOUT_MS,
        fetchImpl,
      });
      const projects = await listProjects(client);
      return { status: 'ok', detail: `projekty: ${projects.length}` };
    });

    const stirlingProbe = timedProbe('stirling', 'Stirling-PDF (ekstrakcja)', async () => {
      const res = await probeHttp(fetchImpl, `${config.stirlingUrl.replace(/\/+$/, '')}/api/v1/info/status`);
      if (res.ok) return { status: 'ok', detail: 'odpowiada' };
      return {
        status: 'down',
        detail: res.timedOut ? 'timeout' : res.status !== null ? `HTTP ${res.status}` : 'niedostępny',
      };
    });

    const tikaProbe = timedProbe('tika', 'Apache Tika (ekstrakcja)', async () => {
      const res = await probeHttp(fetchImpl, `${config.tikaUrl.replace(/\/+$/, '')}/tika`);
      if (res.ok) return { status: 'ok', detail: 'odpowiada' };
      return {
        status: 'down',
        detail: res.timedOut ? 'timeout' : res.status !== null ? `HTTP ${res.status}` : 'niedostępny',
      };
    });

    const mcpProbe = timedProbe('mcp', 'Serwer MCP', async () => {
      const res = await probeHttp(fetchImpl, config.mcpHealthUrl);
      if (res.ok) return { status: 'ok', detail: 'odpowiada' };
      return {
        status: 'down',
        detail: res.timedOut ? 'timeout' : res.status !== null ? `HTTP ${res.status}` : 'niedostępny',
      };
    });

    // Komponenty liczone lokalnie (BEZ wywołań sieciowych i BEZ wywołań LLM).
    const breakers = getBreakerStates(db);

    const llmProbe = timedProbe('llm', 'LLM (chat/openie/embeddings)', async () => {
      const llmBreakers = breakers.filter((b) => b.name.startsWith('llm.'));
      if (llmBreakers.length === 0) {
        return { status: 'unknown', detail: 'brak danych — LLM nie był jeszcze wywoływany' };
      }
      const open = llmBreakers.filter((b) => b.state === 'open');
      const half = llmBreakers.filter((b) => b.state === 'half_open');
      if (open.length > 0) {
        return { status: 'down', detail: `breaker open: ${open.map((b) => b.name).join(', ')}` };
      }
      if (half.length > 0) {
        return { status: 'warn', detail: `breaker half-open: ${half.map((b) => b.name).join(', ')}` };
      }
      return { status: 'ok', detail: `breakery zamknięte (${llmBreakers.length})` };
    });

    const breakersProbe = timedProbe('breakers', 'Bezpieczniki (circuit breakers)', async () => {
      const open = breakers.filter((b) => b.state === 'open');
      const half = breakers.filter((b) => b.state === 'half_open');
      if (open.length > 0) {
        return { status: 'down', detail: `otwarte: ${open.map((b) => b.name).join(', ')}` };
      }
      if (half.length > 0) {
        return { status: 'warn', detail: `half-open: ${half.map((b) => b.name).join(', ')}` };
      }
      return { status: 'ok', detail: `wszystkie zamknięte (${breakers.length})` };
    });

    // Akcje: ZDROWIE mierzy tylko akcje zakończone błędem. Akcja „w toku" to
    // normalna praca (build KB potrafi trwać kwadranse) — nie ostrzeżenie.
    const actionsProbe = timedProbe('actions', 'Akcje długobieżne', async () => {
      const running = (db.prepare("SELECT COUNT(*) AS n FROM actions WHERE status = 'running'").get() as { n: number }).n;
      const failed = (db.prepare("SELECT COUNT(*) AS n FROM actions WHERE status = 'error'").get() as { n: number }).n;
      const detail = `w toku: ${running}, nieudane: ${failed}`;
      return { status: failed > 0 ? 'warn' : 'ok', detail, runningActions: running, failedActions: failed };
    });

    // Inbox i luki: KOLEJKA PRACY (kind 'work') — zawsze 'ok', bo szkic czekający
    // na recenzję jest istotą cyklu human-in-the-loop, a nie usterką. Liczniki
    // idą wprost do UI (badge w nawigacji, kafle na /overview).
    const inboxProbe = timedProbe(
      'inbox',
      'Inbox (szkice do recenzji)',
      async () => {
        const pending = (db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE status = 'pending'").get() as { n: number })
          .n;
        // detail zostaje w formacie 'oczekujące: N' (fallback starszych klientów).
        return { status: 'ok', detail: `oczekujące: ${pending}`, pendingDrafts: pending };
      },
      'work',
    );

    const gapsProbe = timedProbe(
      'gaps',
      'Luki wiedzy',
      async () => {
        const open = (
          db.prepare("SELECT COUNT(*) AS n FROM learning_gaps WHERE status = 'open'").get() as { n: number }
        ).n;
        return { status: 'ok', detail: `otwarte: ${open}`, openGaps: open };
      },
      'work',
    );

    // ── Sondy operacyjne (program rozbudowy F11): dysk / świeżość backupu / cert ──
    const diskProbe = timedProbe('disk', 'Dysk (wolne miejsce)', async () => {
      let st: ReturnType<typeof statfsSync>;
      try {
        st = statfsSync(config.dataDir);
      } catch (err) {
        // Nie można zmierzyć (środowisko testowe/nietypowy mount) ≠ pełny dysk.
        return { status: 'unknown', detail: `statfs: ${err instanceof Error ? err.message : String(err)}` };
      }
      const total = st.blocks * st.bsize;
      const free = st.bavail * st.bsize;
      const freePct = total > 0 ? (free / total) * 100 : 0;
      const detail = `wolne ${(free / 1e9).toFixed(1)} GB (${freePct.toFixed(0)}%)`;
      if (freePct < 5) return { status: 'down', detail: `${detail} — krytycznie mało` };
      if (freePct < 15) return { status: 'warn', detail };
      return { status: 'ok', detail };
    });

    const backupProbe = timedProbe('backup', 'Backup (świeżość)', async () => {
      // backup.sh pisze wolny od sekretów /data/backup-status.json po KAŻDYM biegu.
      let raw: string;
      try {
        raw = readFileSync(join(config.dataDir, 'backup-status.json'), 'utf8');
      } catch {
        return { status: 'unknown', detail: 'brak backup-status.json — backup jeszcze nie raportował' };
      }
      const parsed = JSON.parse(raw) as { createdAt?: string; ok?: boolean; missingRequired?: string[] };
      const ageH = parsed.createdAt !== undefined
        ? (Date.now() - Date.parse(parsed.createdAt)) / 3_600_000
        : Infinity;
      const detail = `ostatni: ${parsed.createdAt ?? '?'} (${Number.isFinite(ageH) ? ageH.toFixed(1) : '?'} h temu), ok=${String(parsed.ok)}`;
      if (parsed.ok !== true) return { status: 'down', detail: `${detail}; brakuje: ${(parsed.missingRequired ?? []).join(', ')}` };
      if (ageH > 50) return { status: 'down', detail: `${detail} — dawniej niż 50 h` };
      if (ageH > 26) return { status: 'warn', detail: `${detail} — dawniej niż 26 h` };
      return { status: 'ok', detail };
    });

    // Weryfikacja odtwarzalności backupu (kag-backup-verify.timer, cotygodniowo).
    // Bez tej sondy kokpit świecił na zielono przez cztery dni, w których unit
    // był w stanie failed — świeżość snapshotu NIE JEST dowodem odtwarzalności.
    const backupVerifyProbe = timedProbe('backup-verify', 'Backup (weryfikacja odtwarzania)', async () => {
      const report = readLatestVerifyReport(config.dataDir);
      if (report === null) {
        return {
          status: 'unknown',
          detail:
            'brak raportu weryfikacji — verify_backup.sh jeszcze nie raportował do katalogu danych panelu',
        };
      }
      const ageDays = report.checkedAt !== null ? (Date.now() - Date.parse(report.checkedAt)) / 86_400_000 : Infinity;
      const ageText = Number.isFinite(ageDays) ? `${ageDays.toFixed(1)} d temu` : 'data nieznana';
      const detail = `ostatnia: ${report.checkedAt ?? '?'} (${ageText}), ok=${String(report.ok)}`;
      if (report.ok !== true) {
        const failed = report.failed.length > 0 ? `; nieudane: ${report.failed.join(', ')}` : '';
        return { status: 'down', detail: `${detail}${failed}` };
      }
      if (!Number.isFinite(ageDays)) return { status: 'warn', detail: `${detail} — brak daty weryfikacji` };
      if (ageDays > 8) return { status: 'warn', detail: `${detail} — dawniej niż 8 dni` };
      return { status: 'ok', detail };
    });

    const certProbe = timedProbe('cert', 'Certyfikat TLS', async () => {
      let publicHost = '';
      try {
        const url = new URL(config.publicUrl);
        if (url.protocol === 'https:') publicHost = url.hostname;
      } catch {
        publicHost = '';
      }
      if (publicHost === '') return { status: 'unknown', detail: 'publicUrl bez https — sonda pominięta' };
      let days: number;
      try {
        // Własny limit ostrzejszy niż timedProbe: wolny DNS/host → unknown, nie down.
        const probe = new Promise<number>((resolve, reject) => {
        const sock = tlsConnect({ host: publicHost, port: 443, servername: publicHost, timeout: PROBE_TIMEOUT_MS }, () => {
          const cert = sock.getPeerCertificate();
          sock.end();
          resolve((Date.parse(cert.valid_to) - Date.now()) / 86_400_000);
        });
          sock.on('error', reject);
          sock.on('timeout', () => { sock.destroy(); reject(new Error('timeout TLS')); });
        });
        const limit = new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error('limit czasu sondy TLS')), PROBE_TIMEOUT_MS - 500);
          t.unref();
        });
        days = await Promise.race([probe, limit]);
      } catch (err) {
        // Niedostępny host ≠ zły certyfikat (dev/test bez DNS) — nie wywracaj cockpitu.
        return { status: 'unknown', detail: `nie można sprawdzić: ${err instanceof Error ? err.message : String(err)}` };
      }
      const detail = `wygasa za ${days.toFixed(0)} dni`;
      if (days < 7) return { status: 'down', detail };
      if (days < 21) return { status: 'warn', detail };
      return { status: 'ok', detail };
    });

    const components = await Promise.all([
      dbProbe,
      openspgProbe,
      stirlingProbe,
      tikaProbe,
      llmProbe,
      mcpProbe,
      actionsProbe,
      inboxProbe,
      gapsProbe,
      breakersProbe,
      diskProbe,
      backupProbe,
      backupVerifyProbe,
      certProbe,
    ]);

    // Sondy pomocnicze (backup/verify/cert/disk): 'unknown' = nie można ocenić
    // (świeża instalacja, dev bez DNS) — nie obniża overall; warn/down liczą się
    // normalnie.
    const AUX_UNKNOWN_AS_OK = new Set(['backup', 'backup-verify', 'cert', 'disk']);
    const effective = (c: StatusComponent): ComponentStatus =>
      AUX_UNKNOWN_AS_OK.has(c.id) && c.status === 'unknown' ? 'ok' : c.status;
    // overall = wyłącznie zdrowie techniczne (D10-07): kolejka pracy nie żółci
    // wskaźnika w nagłówku, bo wtedy realne ostrzeżenia giną w tle.
    const health = components.filter((c) => c.kind !== 'work');
    const work = components.filter((c) => c.kind === 'work');
    return {
      components,
      overall: worstStatus(health.map(effective)),
      workload: work.length > 0 ? worstStatus(work.map(effective)) : 'ok',
      generatedAt: new Date().toISOString(),
      breakers,
    };
  }

  return {
    async getStatus(): Promise<StatusCockpit> {
      const now = Date.now();
      if (cache !== null && now < cache.expiresAt) return cache.data;
      const data = await collect();
      cache = { expiresAt: Date.now() + CACHE_TTL_MS, data };
      return data;
    },

    resetBreakerByName(name: string): BreakerState[] {
      const found = resetBreaker(db, name);
      if (!found) throw new AppError('not_found', `breaker nie istnieje: ${name}`);
      cache = null; // stan breakerów zmienił się — cockpit ma to pokazać od razu
      return getBreakerStates(db);
    },
  };
}
