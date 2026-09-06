import type { Db, ApiKeyRow, McpProfileRow } from '@pomagierkb/shared/db';
import { verifyKey, keyScopes, touchUsage, getProfile } from '@pomagierkb/shared/db';
import { hashToken } from '@pomagierkb/shared/crypto';
import { appendAudit } from '@pomagierkb/shared/audit';

/**
 * Auth Bearer sk-… dla /mcp/<profil>: lookup po sha256 (repo apiKeys.verifyKey,
 * BEZ zapisu na gorącej ścieżce), LRU cache 60 s (max 500) + negatywny 10 s,
 * liczniki użycia batchowane i flushowane co 30 s (repo touchUsage).
 * Revoke z panelu działa najpóźniej po TTL; wcześniej przez POST /invalidate.
 */

/** Minimalny wiersz users potrzebny do bramki statusu (bez repo w shared). */
export interface UserRow {
  id: string;
  display_name: string;
  role: string;
  status: string;
  kind: string;
}

export interface AuthResult {
  keyRow: ApiKeyRow;
  userRow: UserRow;
  profileRow: McpProfileRow;
  scopes: string[];
}

/** Mini-LRU z TTL na Map (kolejność wstawiania = recencja; get odświeża). */
class TtlLru<V> {
  private readonly map = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // odświeżenie recencji: re-insert na koniec Map
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  clear(): void {
    this.map.clear();
  }
}

export interface AuthServiceOptions {
  db: Db;
  /** TTL cache pozytywnego (default 60 s). */
  ttlMs?: number;
  /** TTL cache negatywnego (default 10 s). */
  negativeTtlMs?: number;
  /** Maks. wpisów w każdym cache (default 500). */
  maxEntries?: number;
  /** Odstęp flushu liczników użycia (default 30 s). */
  flushIntervalMs?: number;
  /** Zegar wstrzykiwany w testach. */
  now?: () => number;
}

export class AuthService {
  private readonly db: Db;
  private readonly cache: TtlLru<AuthResult>;
  private readonly negative: TtlLru<true>;
  private pendingUsage: string[] = [];
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(opts: AuthServiceOptions) {
    this.db = opts.db;
    const now = opts.now ?? Date.now;
    const max = opts.maxEntries ?? 500;
    this.cache = new TtlLru<AuthResult>(max, opts.ttlMs ?? 60_000, now);
    this.negative = new TtlLru<true>(max, opts.negativeTtlMs ?? 10_000, now);
    this.timer = setInterval(() => this.flushUsage(), opts.flushIntervalMs ?? 30_000);
    this.timer.unref?.();
  }

  /**
   * Weryfikacja prezentowanego tokenu: klucz active+nieprzeterminowany, user active,
   * profil istnieje i enabled. null = 401 (powód celowo nierozróżnialny dla klienta).
   */
  verify(rawToken: string): AuthResult | null {
    if (!rawToken.startsWith('sk-')) return null;
    const cacheKey = hashToken(rawToken);
    if (this.negative.get(cacheKey) === true) return null;
    const hit = this.cache.get(cacheKey);
    if (hit !== undefined) {
      this.pendingUsage.push(hit.keyRow.id);
      return hit;
    }
    const keyRow = verifyKey(this.db, rawToken);
    if (keyRow === null) {
      this.negative.set(cacheKey, true);
      return null;
    }
    const userRow = this.db
      .prepare('SELECT id, display_name, role, status, kind FROM users WHERE id = ?')
      .get(keyRow.user_id) as UserRow | undefined;
    if (userRow === undefined || userRow.status !== 'active') {
      this.negative.set(cacheKey, true);
      return null;
    }
    const profileRow = getProfile(this.db, keyRow.profile_id);
    if (profileRow === null || profileRow.enabled !== 1) {
      this.negative.set(cacheKey, true);
      return null;
    }
    const result: AuthResult = { keyRow, userRow, profileRow, scopes: keyScopes(keyRow) };
    this.cache.set(cacheKey, result);
    this.pendingUsage.push(keyRow.id);
    return result;
  }

  /** Flush batcha last_used_at/requests_count (co 30 s + przy shutdownie). */
  flushUsage(): void {
    if (this.pendingUsage.length === 0) return;
    const ids = this.pendingUsage;
    this.pendingUsage = [];
    try {
      touchUsage(this.db, ids);
    } catch {
      // SQLITE_BUSY itp. — liczniki są best-effort, nie blokujemy ruchu
    }
  }

  /** Czyszczenie cache (POST /invalidate po revoke/rotate z panelu). */
  invalidate(): void {
    this.cache.clear();
    this.negative.clear();
  }

  close(): void {
    clearInterval(this.timer);
    this.flushUsage();
  }
}

/** 'Bearer <token>' → token; null gdy nagłówek nieobecny/zniekształcony. */
export function extractBearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m?.[1] ?? null;
}

/** Do audytu/logów WYŁĄCZNIE prefix tokenu ('sk-Ab1'), nigdy całość. */
export function tokenPrefix(token: string | null): string {
  return token === null || token === '' ? '(brak)' : token.slice(0, 6);
}

/**
 * Format identyfikatora profilu MCP — TEN SAM regex, co przy tworzeniu profilu
 * (packages/shared/src/db/repos/mcpProfiles.ts). Segment ścieżki /mcp/<profil>
 * trafia do łańcucha audytu jako resourceId, więc musi być zwalidowany ZANIM
 * cokolwiek zapiszemy (inaczej dowolny ciąg z URL ląduje w audycie).
 */
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidProfileId(id: string): boolean {
  return PROFILE_ID_RE.test(id);
}

export interface AuthFailureDecision {
  /** true = zapisz wpis do łańcucha audytu (pierwsze wystąpienie w oknie). */
  audit: boolean;
  /** Ile wystąpień pominięto od ostatniego zapisu (do metadanych wpisu). */
  suppressed: number;
}

const MAX_FAILURE_KEYS = 5_000;

/**
 * Agregacja nieudanych uwierzytelnień: JEDEN wpis audytu na (prefix, IP, powód)
 * na okno. Bez tego każde żądanie z internetu bez tokenu dopisywało wiersz do
 * hash-chaina (BEGIN IMMEDIATE na SQLite współdzielonym z panel-api) — zalew
 * audytu i kontencja zapisu. Pełny obraz zostaje w logu pino.
 */
export class AuthFailureAggregator {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  record(key: string): AuthFailureDecision {
    const t = this.now();
    const entry = this.windows.get(key);
    if (entry !== undefined && t - entry.start < this.windowMs) {
      entry.count += 1;
      return { audit: false, suppressed: 0 };
    }
    // nowe okno: pierwszy wpis niesie licznik pominiętych z okna poprzedniego
    const suppressed = entry === undefined ? 0 : Math.max(0, entry.count - 1);
    if (entry === undefined && this.windows.size >= MAX_FAILURE_KEYS) this.evict(t);
    this.windows.set(key, { start: t, count: 1 });
    return { audit: true, suppressed };
  }

  /** Usuwa okna przeterminowane; gdy to nie starczy — całość (bezpiecznik pamięci). */
  private evict(t: number): void {
    for (const [key, w] of this.windows) {
      if (t - w.start >= this.windowMs) this.windows.delete(key);
    }
    if (this.windows.size >= MAX_FAILURE_KEYS) this.windows.clear();
  }

  reset(): void {
    this.windows.clear();
  }
}

/** Wpis mcp.auth_failed do łańcucha audytu — z prefiksem tokenu, nigdy całym. */
export function auditAuthFailure(
  db: Db,
  token: string | null,
  profileId: string,
  reason: string,
  extra: Record<string, unknown> = {},
): void {
  try {
    appendAudit(db, {
      actor: tokenPrefix(token),
      actorType: 'api_key',
      action: 'mcp.auth_failed',
      resourceType: 'mcp_profile',
      resourceId: profileId,
      outcome: 'failure',
      metadata: { reason, ...extra },
    });
  } catch {
    // audyt nie może wywrócić odpowiedzi 401 (np. SQLITE_BUSY)
  }
}
