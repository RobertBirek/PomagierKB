import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { nowIso } from '../db/index.js';

/**
 * Audyt hash-chained (append-only, triggery blokują UPDATE/DELETE).
 * BEGIN IMMEDIATE serializuje append między procesami panel-api ↔ mcp-server
 * (busy_timeout 5000 w openDb); transakcja obejmuje tylko odczyt ostatniego
 * hasha + INSERT — sanitize i hashowanie liczone poza sekcją krytyczną tam,
 * gdzie to możliwe.
 */

export interface AuditEvent {
  actor: string;
  actorType: 'user' | 'api_key' | 'system';
  role?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  /** Domyślnie 'success'. */
  outcome?: string;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
}

export interface AuditAppendResult {
  id: string;
  seq: number;
  at: string;
  hash: string;
  prevHash: string;
}

// ── Redakcja ────────────────────────────────────────────────────────────────

const SECRET_KEY_RE = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|refresh/i;
const BEARER_RE = /Bearer\s+\S+/g;

const MAX_STRING = 4000;
const MAX_ARRAY = 100;
const MAX_FIELDS = 200;
const MAX_DEPTH = 8;

/**
 * Rekurencyjna redakcja przed zapisem do łańcucha: sekretne klucze → '[REDACTED]',
 * 'Bearer X' w stringach → 'Bearer [REDACTED]', limity rozmiaru i głębokości.
 */
export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[MAX_DEPTH]';
  if (typeof value === 'string') {
    const redacted = value.replace(BEARER_RE, 'Bearer [REDACTED]');
    return redacted.length > MAX_STRING ? redacted.slice(0, MAX_STRING) : redacted;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((v) => sanitizeForAudit(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  let fields = 0;
  for (const [k, v] of Object.entries(value)) {
    if (fields >= MAX_FIELDS) break;
    fields += 1;
    out[k] = SECRET_KEY_RE.test(k) ? '[REDACTED]' : sanitizeForAudit(v, depth + 1);
  }
  return out;
}

// ── Hash ────────────────────────────────────────────────────────────────────

/** Kanoniczna forma do hashowania: rekurencyjne sortowanie kluczy obiektów. */
export function stableSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = stableSort(src[k]);
    return out;
  }
  return value;
}

/** Pola wpisu wchodzące do hasha (wszystko poza samym hash). */
export interface AuditHashInput {
  id: string;
  at: string;
  actor: string;
  actor_type: string;
  role: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  outcome: string;
  before: unknown;
  after: unknown;
  metadata: unknown;
  prev_hash: string;
}

/** sha256(JSON.stringify(stableSort(wpis bez hash))) — wspólne dla append i verify. */
export function computeAuditHash(entry: AuditHashInput): string {
  return createHash('sha256')
    .update(JSON.stringify(stableSort(entry)), 'utf8')
    .digest('hex');
}

// ── Append ──────────────────────────────────────────────────────────────────

const INSERT_SQL = `INSERT INTO audit
  (id, at, actor, actor_type, role, action, resource_type, resource_id,
   outcome, before_json, after_json, metadata_json, prev_hash, hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** JSON kolumny: SQL NULL gdy brak wartości; inaczej kanoniczny (posortowany) JSON. */
function toJsonColumn(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(stableSort(value));
}

export function appendAudit(db: Db, event: AuditEvent): AuditAppendResult {
  const id = 'aud_' + randomUUID();
  const at = nowIso();
  const before = event.before === undefined ? null : sanitizeForAudit(event.before);
  const after = event.after === undefined ? null : sanitizeForAudit(event.after);
  const metadata = event.metadata === undefined ? null : sanitizeForAudit(event.metadata);

  db.exec('BEGIN IMMEDIATE');
  try {
    const last = db.prepare('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1').get() as
      | { hash: string }
      | undefined;
    const prevHash = last?.hash ?? ''; // pierwszy wpis łańcucha: prev_hash = ''
    const hash = computeAuditHash({
      id,
      at,
      actor: event.actor,
      actor_type: event.actorType,
      role: event.role ?? null,
      action: event.action,
      resource_type: event.resourceType ?? null,
      resource_id: event.resourceId ?? null,
      outcome: event.outcome ?? 'success',
      before,
      after,
      metadata,
      prev_hash: prevHash,
    });
    const info = db.prepare(INSERT_SQL).run(
      id,
      at,
      event.actor,
      event.actorType,
      event.role ?? null,
      event.action,
      event.resourceType ?? null,
      event.resourceId ?? null,
      event.outcome ?? 'success',
      toJsonColumn(before),
      toJsonColumn(after),
      toJsonColumn(metadata),
      prevHash,
      hash,
    );
    db.exec('COMMIT');
    return { id, seq: Number(info.lastInsertRowid), at, hash, prevHash };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
