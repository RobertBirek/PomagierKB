import type { Db } from '@pomagierkb/shared/db';
import type { AppConfig } from './config.js';
import type { OidcProvider } from './plugins/oidc.js';

/**
 * Wspólne typy panel-api + augmentacje Fastify (dekoratory i route.config).
 * Ten plik jest KONTRAKTEM dla modułów tras — importują stąd Role/AppUser
 * i dostają typowane req.user / app.db / app.config / reply.sse().
 */

/** Hierarchia ról: admin ⊃ operator ⊃ viewer. */
export type Role = 'viewer' | 'operator' | 'admin';

/** Użytkownik zalogowanej sesji (ustawiany przez plugin session; w szkielecie zawsze null). */
export interface AppUser {
  id: string;
  email: string | null;
  displayName: string;
  role: Role;
  /** sha256(sid) — klucz rate-limitu per sesja i identyfikator wiersza sessions. */
  sessionHash: string;
}

/** Kontekst audytu wypełniany przez serwis przed wysłaniem odpowiedzi (reply.auditContext = {...}). */
export interface AuditContext {
  resourceType?: string;
  resourceId?: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

/** Uchwyt strumienia SSE zwracany przez reply.sse(). */
export interface SseSink {
  /** Wysyła event: `event: <name>\ndata: <JSON>\n\n`. Po zamknięciu — no-op. */
  send(event: string, data: unknown): void;
  /** Kończy strumień (cleanup + end na socket). */
  close(): void;
  /** Rejestruje sprzątanie wołane przy rozłączeniu klienta lub close(). */
  onClose(fn: () => void): void;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: AppConfig;
    /** Leniwe discovery OIDC (dekorowane w plugins/session.ts, używane przez /auth/*). */
    oidc: OidcProvider;
  }
  interface FastifyRequest {
    /** null = brak zalogowanej sesji (ustawia hook w plugins/session.ts). */
    user: AppUser | null;
  }
  interface FastifyReply {
    /** Ustawiany przez serwisy dla tras z config.audit — trafia do hash-chaina. */
    auditContext: AuditContext | null;
    /** Przejmuje odpowiedź jako text/event-stream (heartbeat 15 s, cleanup na close). */
    sse(opts?: { heartbeatMs?: number }): SseSink;
  }
  interface FastifyContextConfig {
    /**
     * DENY-BY-DEFAULT: każda trasa MUSI zadeklarować rbac.
     * Rola minimalna ('viewer'|'operator'|'admin') albo jawne false (trasa publiczna
     * — tylko /healthz, /auth/* i statyki). Brak deklaracji → domyślnie 'viewer'
     * (wymagane zalogowanie).
     */
    rbac?: Role | false;
    /** Jawne oznaczenie trasy publicznej (równoważne rbac:false) — nigdy domyślne. */
    public?: boolean;
    /** Nazwa akcji audytu (np. 'draft.promote') albo false — hook onResponse pisze do łańcucha. */
    audit?: string | false;
    /** true = trasa mutująca objęta kontrolą Origin/Sec-Fetch-Site (szkielet: stub przepuszcza). */
    csrf?: boolean;
    /** Grupa limitu: 'auth' 10/min/IP, 'mutation' 60/min/sesja. Bez deklaracji: globalny 300/min/IP. */
    rateLimitGroup?: 'auth' | 'mutation';
  }
}
