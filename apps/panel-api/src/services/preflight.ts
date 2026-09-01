import { mkdirSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getKb, getSetting, listDrafts, type Db } from '@pomagierkb/shared/db';
import { OpenSpgClient, listProjects } from '@pomagierkb/shared/openspg';
import { AppError } from '@pomagierkb/shared/errors';
import type { AppConfig } from '../config.js';
import { humanize } from './messages.js';
import { modelNameOf, readEmbeddingsSettings } from './embeddings.js';

/**
 * SILNIK CHECKÓW PREFLIGHT (dry-run przed startem akcji):
 * runPreflight(checks) → {ok, checks:[{id,ok,severity,message}]};
 * ok = wszystkie checki o severity 'error' przeszły (warn nie blokuje).
 * Kompozycja checków per typ akcji w rejestrze PREFLIGHTS; trasy używają
 * runPreflightFor(type, ctx) + assertPreflight(result) → 422 preflight_failed
 * z details.checks (kształt z backend-mcp §2.2/§5).
 *
 * SCALONE (Faza 4): to jest JEDYNA kompozycja preflightu buildu —
 * services/kb.ts:preflightBuild deleguje tutaj; check embeddingu czyta sekret
 * przez unseal (services/embeddings.ts) i egzekwuje TWARDY guard niezmienności
 * zamrożonego vector_model_id.
 */

/** Identyfikatory checków kompozycji build_kb (1:1 z PREFLIGHT_CODES słownika PL). */
export const PREFLIGHT_CHECK_IDS = [
  'disk_space',
  'dir_writable',
  'openspg_reachable',
  'kb_active',
  'embedding_model',
  'promoted_drafts',
  'no_running_action',
] as const;

export type PreflightCheckId = (typeof PREFLIGHT_CHECK_IDS)[number];
export type PreflightSeverity = 'error' | 'warn';

/** Pojedynczy check: id + domyślna severity + run() (może nadpisać severity). */
export interface Check {
  id: string;
  severity: PreflightSeverity;
  run: () =>
    | Promise<{ ok: boolean; message: string; severity?: PreflightSeverity }>
    | { ok: boolean; message: string; severity?: PreflightSeverity };
}

export interface PreflightCheckResult {
  id: string;
  ok: boolean;
  severity: PreflightSeverity;
  message: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheckResult[];
}

/** Uruchamia checki sekwencyjnie; wyjątek w checku = ok:false z komunikatem błędu. */
export async function runPreflight(checks: Check[]): Promise<PreflightResult> {
  const results: PreflightCheckResult[] = [];
  for (const check of checks) {
    try {
      const r = await check.run();
      results.push({ id: check.id, ok: r.ok, severity: r.severity ?? check.severity, message: r.message });
    } catch (err) {
      results.push({
        id: check.id,
        ok: false,
        severity: check.severity,
        message: `${humanize(check.id).label}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  const ok = results.every((r) => r.ok || r.severity !== 'error');
  return { ok, checks: results };
}

/** Wynik z błędami severity=error → 422 preflight_failed z details.checks. */
export function assertPreflight(result: PreflightResult): void {
  if (!result.ok) {
    throw new AppError('preflight_failed', 'kontrola wstępna nie przeszła — usuń przyczyny błędów i spróbuj ponownie', {
      checks: result.checks,
    });
  }
}

// ── checki generyczne (fabryki) ─────────────────────────────────────────────

const GIB = 1024 * 1024 * 1024;

/** Wolne miejsce na wolumenie danych (statfs; minimum domyślnie 1 GiB). */
export function diskSpaceCheck(dir: string, minBytes = GIB): Check {
  return {
    id: 'disk_space',
    severity: 'error',
    run: () => {
      mkdirSync(dir, { recursive: true });
      const st = statfsSync(dir);
      const freeBytes = st.bavail * st.bsize;
      const freeGib = (freeBytes / GIB).toFixed(2);
      const minGib = (minBytes / GIB).toFixed(2);
      return freeBytes >= minBytes
        ? { ok: true, message: `wolne miejsce: ${freeGib} GiB (wymagane ≥ ${minGib} GiB)` }
        : { ok: false, message: `za mało miejsca na dysku: ${freeGib} GiB wolne, wymagane ≥ ${minGib} GiB` };
    },
  };
}

/** Zapisywalność katalogu (mkdir + plik-sonda + sprzątanie). */
export function dirWritableCheck(dir: string): Check {
  return {
    id: 'dir_writable',
    severity: 'error',
    run: () => {
      const probe = join(dir, `.preflight-${randomBytes(4).toString('hex')}`);
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(probe, 'probe');
        return { ok: true, message: `katalog zapisywalny: ${dir}` };
      } catch (err) {
        return { ok: false, message: `katalog niezapisywalny: ${dir} (${(err as Error).message})` };
      } finally {
        try {
          rmSync(probe, { force: true });
        } catch {
          /* sonda mogła nie powstać */
        }
      }
    },
  };
}

/** OpenSPG odpowiada (listProjects przez klienta z shared, krótki timeout). */
export function openspgAliveCheck(client: OpenSpgClient): Check {
  return {
    id: 'openspg_alive',
    severity: 'error',
    run: async () => {
      const projects = await listProjects(client);
      return { ok: true, message: `OpenSPG odpowiada (projekty: ${projects.length})` };
    },
  };
}

/** KB istnieje i ma status active w rejestrze (jedyne źródło prawdy). */
export function kbActiveCheck(db: Db, namespace: string): Check {
  return {
    id: 'kb_active',
    severity: 'error',
    run: () => {
      const kb = getKb(db, namespace);
      if (kb === null) return { ok: false, message: `baza '${namespace}' nie istnieje w rejestrze` };
      return kb.status === 'active'
        ? { ok: true, message: `baza '${namespace}' jest aktywna (projectId: ${kb.project_id ?? 'brak'})` }
        : { ok: false, message: `baza '${namespace}' nie jest aktywna (status: ${kb.status})` };
    },
  };
}

/** Model embeddingów skonfigurowany w settings ('llm.embeddings' → model). */
export function configuredEmbeddingModel(db: Db): string | null {
  const setting = getSetting(db, 'llm.embeddings');
  if (setting === null) return null;
  const value = setting.value;
  if (typeof value === 'string' && value !== '') return value;
  if (value !== null && typeof value === 'object') {
    const model = (value as Record<string, unknown>)['model'];
    if (typeof model === 'string' && model !== '') return model;
  }
  return null;
}

/**
 * Zgodność modelu embeddingów: embedding projektu OpenSPG jest NIEZMIENIALNY,
 * więc model z rejestru KB musi się zgadzać ze skonfigurowanym. Brak
 * konfiguracji lub brak modelu w rejestrze → warn (degradacja, nie blokada).
 */
export function embeddingMatchesCheck(db: Db, namespace: string, configured: string | null): Check {
  return {
    id: 'embedding_matches',
    severity: 'error',
    run: () => {
      const kb = getKb(db, namespace);
      if (kb === null) return { ok: false, message: `baza '${namespace}' nie istnieje w rejestrze` };
      if (kb.embedding_model === '') {
        return { ok: false, severity: 'warn', message: `baza '${namespace}' nie ma zapisanego modelu embeddingów w rejestrze` };
      }
      if (configured === null) {
        return { ok: false, severity: 'warn', message: 'brak skonfigurowanego modelu embeddingów (settings llm.embeddings) — wyszukiwanie zdegraduje się do tekstowego' };
      }
      return configured === kb.embedding_model
        ? { ok: true, message: `model embeddingów zgodny: ${kb.embedding_model}` }
        : {
            ok: false,
            message: `model embeddingów NIEZGODNY: rejestr '${kb.embedding_model}' vs konfiguracja '${configured}' — model projektu jest niezmienialny`,
          };
    },
  };
}

/**
 * Brak innej akcji running tego samego (type, resource). excludeActionId pozwala
 * jobowi build_kb odpalić preflight z WŁASNEGO wiersza akcji bez samoblokady.
 */
export function noRunningActionCheck(db: Db, type: string, resource: string, excludeActionId?: string): Check {
  return {
    id: 'no_running_action',
    severity: 'error',
    run: () => {
      const row = db
        .prepare(
          "SELECT id FROM actions WHERE type = ? AND resource = ? AND status = 'running' AND (? IS NULL OR id <> ?)",
        )
        .get(type, resource, excludeActionId ?? null, excludeActionId ?? null) as { id: string } | undefined;
      return row === undefined
        ? { ok: true, message: `brak trwającej akcji ${type} na ${resource}` }
        : { ok: false, message: `akcja ${type} na ${resource} już trwa (${row.id})` };
    },
  };
}

/** OpenSPG odpowiada — wariant kompozycji build_kb (id historyczne 'openspg_reachable'). */
export function openspgReachableCheck(client: OpenSpgClient): Check {
  return {
    id: 'openspg_reachable',
    severity: 'error',
    run: async () => {
      const projects = await listProjects(client);
      return { ok: true, message: `OpenSPG odpowiada (projekty: ${projects.length})` };
    },
  };
}

/**
 * TWARDY GUARD NIEZMIENNOŚCI EMBEDDINGU: zamrożony vector_model_id z rejestru
 * musi zgadzać się z modelem w settings 'llm.embeddings' (odczyt przez unseal —
 * w odróżnieniu od embeddingMatchesCheck, który sekretu nie odszyfrowuje).
 * Brak konfiguracji lub rozjazd przy zamrożonym modelu → error; baza bez
 * zamrożonego modelu (provisioning niekompletny) → warn.
 */
export function embeddingModelGuardCheck(db: Db, config: AppConfig, namespace: string): Check {
  return {
    id: 'embedding_model',
    severity: 'error',
    run: () => {
      const kb = getKb(db, namespace);
      if (kb === null) return { ok: false, message: `baza '${namespace}' nie istnieje w rejestrze` };
      if (kb.vector_model_id === '') {
        return {
          ok: false,
          severity: 'warn' as const,
          message: 'baza bez zamrożonego modelu embeddingu (provisioning niekompletny?)',
        };
      }
      const frozen = modelNameOf(kb.vector_model_id);
      const embeddings = readEmbeddingsSettings(db, config);
      if (embeddings === null) {
        return {
          ok: false,
          message: `brak konfiguracji llm.embeddings w Ustawieniach (projekt zamrożony na modelu '${frozen}')`,
        };
      }
      if (embeddings.model !== frozen) {
        return {
          ok: false,
          message: `model embeddingu w Ustawieniach ('${embeddings.model}') różni się od zamrożonego w projekcie ('${frozen}') — modelu NIE wolno zmieniać po utworzeniu projektu`,
        };
      }
      return { ok: true, message: `model embeddingu zgodny ('${frozen}')` };
    },
  };
}

/** Eksport da ≥1 dokument (są promowane drafty). */
export function promotedDraftsCheck(db: Db, namespace: string): Check {
  return {
    id: 'promoted_drafts',
    severity: 'error',
    run: () => {
      const promoted = listDrafts(db, { namespace, status: 'promoted', limit: 1 }).total;
      return promoted > 0
        ? { ok: true, message: `wypromowanych draftów: ${promoted}` }
        : { ok: false, message: 'brak wypromowanych draftów — eksport nie da żadnego dokumentu' };
    },
  };
}

// ── kompozycja per typ akcji ────────────────────────────────────────────────

export interface PreflightContext {
  db: Db;
  config: AppConfig;
  /** Wymagany dla typów operujących na KB (build_kb). */
  namespace?: string;
  /** Wstrzykiwalny klient OpenSPG (testy); domyślnie budowany z config. */
  openspg?: OpenSpgClient;
  /** Id akcji wołającej preflight z własnego joba (wyłączony z no_running_action). */
  excludeActionId?: string;
}

/** Klient OpenSPG z krótkim timeoutem — preflight ma odpowiadać szybko. */
function openspgClient(ctx: PreflightContext): OpenSpgClient {
  return (
    ctx.openspg ??
    new OpenSpgClient({
      baseUrl: ctx.config.openspg.baseUrl,
      account: ctx.config.openspg.account,
      password: ctx.config.openspg.password,
      timeoutMs: 3_000,
    })
  );
}

function requireNamespace(ctx: PreflightContext, type: string): string {
  if (ctx.namespace === undefined || ctx.namespace === '') {
    throw new AppError('validation_error', `preflight '${type}' wymaga namespace`);
  }
  return ctx.namespace;
}

/** JEDEN rejestr kompozycji checków per typ akcji (typ bez wpisu = bez preflightu). */
export const PREFLIGHTS: Record<string, (ctx: PreflightContext) => Check[]> = {
  // Job testowy — tylko checki lokalne (dysk + zapis katalogu logów).
  noop: (ctx) => [
    diskSpaceCheck(ctx.config.dataDir),
    dirWritableCheck(join(ctx.config.dataDir, 'actions')),
  ],
  create_kb: (ctx) => [
    diskSpaceCheck(ctx.config.dataDir),
    dirWritableCheck(join(ctx.config.dataDir, 'actions')),
    openspgAliveCheck(openspgClient(ctx)),
  ],
  // JEDYNA kompozycja preflightu buildu (scalona z services/kb.ts:preflightBuild
  // w Fazie 4): twardy guard embeddingu przez unseal + promoted_drafts.
  build_kb: (ctx) => {
    const namespace = requireNamespace(ctx, 'build_kb');
    return [
      diskSpaceCheck(ctx.config.dataDir),
      dirWritableCheck(join(ctx.config.dataDir, 'exports', namespace)),
      openspgReachableCheck(openspgClient(ctx)),
      kbActiveCheck(ctx.db, namespace),
      embeddingModelGuardCheck(ctx.db, ctx.config, namespace),
      promotedDraftsCheck(ctx.db, namespace),
      noRunningActionCheck(ctx.db, 'build_kb', `kb:${namespace}`, ctx.excludeActionId),
    ];
  },
};

/** Preflight dla typu akcji; typ bez wpisu w rejestrze → {ok:true, checks:[]}. */
export async function runPreflightFor(type: string, ctx: PreflightContext): Promise<PreflightResult> {
  const compose = PREFLIGHTS[type];
  if (compose === undefined) return { ok: true, checks: [] };
  return runPreflight(compose(ctx));
}
