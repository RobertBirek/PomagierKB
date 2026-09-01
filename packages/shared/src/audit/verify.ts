import type { Db } from '../db/index.js';
import { computeAuditHash } from './append.js';

/**
 * Weryfikacja łańcucha audytu: przeliczenie hashy ostatnich `limit` wpisów
 * i ciągłości prev_hash → hash. Przy oknie uciętym (starsze wpisy poza limitem)
 * nie sprawdzamy pochodzenia łańcucha (prev_hash='' pierwszego wpisu okna).
 */

export type AuditProblemKind = 'hash_mismatch' | 'chain_mismatch';

export interface AuditProblem {
  seq: number;
  kind: AuditProblemKind;
}

export interface VerifyChainResult {
  valid: boolean;
  checked: number;
  firstBrokenSeq?: number;
  problems: AuditProblem[];
}

interface AuditRow {
  seq: number;
  id: string;
  at: string;
  actor: string;
  actor_type: string;
  role: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  outcome: string;
  before_json: string | null;
  after_json: string | null;
  metadata_json: string | null;
  prev_hash: string;
  hash: string;
}

/** Parsuje kolumnę *_json; nieparsowalny JSON zgłaszamy jako zepsuty hash wpisu. */
function parseJsonColumn(raw: string | null): { ok: boolean; value: unknown } {
  if (raw === null) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, value: null };
  }
}

export function verifyChain(db: Db, limit = 5000): VerifyChainResult {
  const bounds = db.prepare('SELECT MIN(seq) AS min, MAX(seq) AS max FROM audit').get() as {
    min: number | null;
    max: number | null;
  };
  if (bounds.max === null || bounds.min === null) {
    return { valid: true, checked: 0, problems: [] };
  }

  const fromSeq = bounds.max - limit; // sprawdzamy wpisy o seq > fromSeq
  const rows = db
    .prepare('SELECT * FROM audit WHERE seq > ? ORDER BY seq ASC')
    .all(fromSeq) as AuditRow[];
  const first = rows[0];
  if (!first) return { valid: true, checked: 0, problems: [] };
  const truncated = first.seq > bounds.min;

  const problems: AuditProblem[] = [];
  let prevHash: string | null = null;

  for (const row of rows) {
    const before = parseJsonColumn(row.before_json);
    const after = parseJsonColumn(row.after_json);
    const metadata = parseJsonColumn(row.metadata_json);
    const recomputed =
      before.ok && after.ok && metadata.ok
        ? computeAuditHash({
            id: row.id,
            at: row.at,
            actor: row.actor,
            actor_type: row.actor_type,
            role: row.role,
            action: row.action,
            resource_type: row.resource_type,
            resource_id: row.resource_id,
            outcome: row.outcome,
            before: before.value,
            after: after.value,
            metadata: metadata.value,
            prev_hash: row.prev_hash,
          })
        : null;
    if (recomputed !== row.hash) problems.push({ seq: row.seq, kind: 'hash_mismatch' });

    if (prevHash === null) {
      // pierwszy wpis okna: origin (prev_hash='') sprawdzany tylko bez ucięcia
      if (!truncated && row.prev_hash !== '') problems.push({ seq: row.seq, kind: 'chain_mismatch' });
    } else if (row.prev_hash !== prevHash) {
      problems.push({ seq: row.seq, kind: 'chain_mismatch' });
    }
    prevHash = row.hash;
  }

  const result: VerifyChainResult = {
    valid: problems.length === 0,
    checked: rows.length,
    problems,
  };
  const firstProblem = problems[0];
  if (firstProblem) result.firstBrokenSeq = firstProblem.seq;
  return result;
}
