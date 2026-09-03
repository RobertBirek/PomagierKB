import { statfsSync, readFileSync } from 'node:fs';
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

export interface StatusComponent {
  id: string;
  /** Etykieta PL do UI. */
  label: string;
  status: ComponentStatus;
  detail: string;
  latencyMs: number;
  /**
   * Tylko sonda 'inbox': liczba szkiców czekających na recenzję (badge
   * w nawigacji panelu czyta ją wprost, bez parsowania detail).
   */
  pendingDrafts?: number;
}

export interface StatusCockpit {
  components: StatusComponent[];
  /** Najgorszy status komponentów (down > warn > unknown > ok). */
  overall: ComponentStatus;
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

/** Opakowanie sondy: mierzy latencję i zamienia wyjątki/timeouty na status down. */
async function timedProbe(
  id: string,
  label: string,
  fn: () => Promise<{ status: ComponentStatus; detail: string; pendingDrafts?: number }>,
): Promise<StatusComponent> {
  const startedAt = Date.now();
  try {
    const timeout = new Promise<{ status: ComponentStatus; detail: string; pendingDrafts?: number }>((resolve) => {
      const t = setTimeout(
        () => resolve({ status: 'down', detail: `timeout sondy (${PROBE_TIMEOUT_MS + 500} ms)` }),
        PROBE_TIMEOUT_MS + 500,
      );
      t.unref();
    });
    const result = await Promise.race([fn(), timeout]);
    return { id, label, ...result, latencyMs: Date.now() - startedAt };
  } catch (err) {
    return {
      id,
      label,
      status: 'down',
      detail: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      latencyMs: Date.now() - startedAt,
    };
  }
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

    const actionsProbe = timedProbe('actions', 'Akcje długobieżne', async () => {
      const running = (db.prepare("SELECT COUNT(*) AS n FROM actions WHERE status = 'running'").get() as { n: number }).n;
      const failed = (db.prepare("SELECT COUNT(*) AS n FROM actions WHERE status = 'error'").get() as { n: number }).n;
      const detail = `w toku: ${running}, nieudane: ${failed}`;
      return running > 0 ? { status: 'warn', detail } : { status: 'ok', detail };
    });

    const inboxProbe = timedProbe('inbox', 'Inbox (szkice do recenzji)', async () => {
      const pending = (db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE status = 'pending'").get() as { n: number }).n;
      const detail = `oczekujące: ${pending}`;
      // pendingDrafts: liczba wprost dla UI (badge Inboxu) — detail zostaje
      // dla ludzi i jako fallback starszych klientów.
      return pending > 0
        ? { status: 'warn', detail, pendingDrafts: pending }
        : { status: 'ok', detail, pendingDrafts: pending };
    });

    const gapsProbe = timedProbe('gaps', 'Luki wiedzy', async () => {
      const open = (db.prepare("SELECT COUNT(*) AS n FROM learning_gaps WHERE status = 'open'").get() as { n: number }).n;
      const detail = `otwarte: ${open}`;
      return open > 0 ? { status: 'warn', detail } : { status: 'ok', detail };
    });

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
      certProbe,
    ]);

    // Sondy pomocnicze (backup/cert): 'unknown' = nie można ocenić (świeża instalacja,
    // dev bez DNS) — nie obniża overall; warn/down liczą się normalnie.
    const AUX_UNKNOWN_AS_OK = new Set(['backup', 'cert', 'disk']);
    return {
      components,
      overall: worstStatus(
        components.map((c) => (AUX_UNKNOWN_AS_OK.has(c.id) && c.status === 'unknown' ? 'ok' : c.status)),
      ),
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
