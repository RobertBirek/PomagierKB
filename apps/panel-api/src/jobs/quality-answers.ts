import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_NAMESPACES, saveQualityReport, type Db } from '@pomagierkb/shared/db';
import { aggregateLlmUsage } from '@pomagierkb/shared/llm';
import { computeAnswerQuality, type AnswerSample, type UsageSample } from '../pipeline/quality-answers.js';
import type { JobFn } from './job-types.js';

/**
 * Akcja quality_answers (program ewaluacji F10.2) — tygodniowy raport jakości
 * ODPOWIEDZI z produkcyjnego korpusu: answers (odmowy, degradacje, histogram
 * confidence, p50/p95), feedback (👎-rate), learning_gaps (top evidence),
 * usage-JSONL MCP (per klucz/narzędzie), zużycie tokenów LLM (rejestr llm_usage —
 * jedyny agregat kosztu w systemie, GAP-05) oraz otwarcia breakerów z audytu
 * (incydenty, które auto-recovery zaciera w tabeli breakers — D10-05).
 * Wynik: wiersz quality_reports rodzaju 'answers' per namespace + '__all__'
 * (progi WARN/FAIL w pipeline/quality-answers.ts). Uruchamiana ręcznie
 * (POST /learning/quality-report) albo z harmonogramu (jobs/scheduler.ts).
 */

const WINDOW_DAYS = 7;

interface AnswerRowLite {
  namespaces_json: string;
  confidence: number | null;
  degraded: number;
  no_answer: number;
  took_ms: number | null;
}

function readUsage(dataDir: string, sinceIso: string): UsageSample[] {
  const dir = join(dataDir, 'mcp-usage');
  if (!existsSync(dir)) return [];
  const sinceDay = sinceIso.slice(0, 10);
  const out: UsageSample[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl') || f.slice(0, 10) < sinceDay) continue;
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (line === '') continue;
      try {
        const o = JSON.parse(line) as { at?: string; keyId?: string; tool?: string; tookMs?: number };
        if (typeof o.keyId === 'string' && typeof o.tool === 'string' && (o.at ?? '') >= sinceIso) {
          out.push({ keyId: o.keyId, tool: o.tool, ...(o.tookMs !== undefined ? { tookMs: o.tookMs } : {}) });
        }
      } catch {
        /* uszkodzona linia — pomijamy */
      }
    }
  }
  return out;
}

export interface BreakerIncident {
  breaker: string;
  opens: number;
  lastOpenAt: string | null;
  lastReason: string | null;
}

/**
 * Otwarcia breakerów w oknie raportu — z ŁAŃCUCHA AUDYTU, bo tabela breakers
 * po auto-recovery nie pamięta incydentu (D10-05). Bez tej sekcji nocna awaria
 * LLM/OpenSPG znikała bez śladu w panelu.
 */
export function collectBreakerIncidents(db: Db, sinceIso: string): BreakerIncident[] {
  let rows: { resource_id: string | null; n: number; last_at: string; metadata_json: string | null }[];
  try {
    rows = db
      .prepare(
        `SELECT resource_id, COUNT(*) AS n, MAX(at) AS last_at,
                (SELECT metadata_json FROM audit b
                  WHERE b.resource_id = a.resource_id AND b.action = 'breaker.open' AND b.at >= ?
                  ORDER BY b.at DESC LIMIT 1) AS metadata_json
           FROM audit a
          WHERE a.action = 'breaker.open' AND a.at >= ?
          GROUP BY a.resource_id ORDER BY n DESC`,
      )
      .all(sinceIso, sinceIso) as typeof rows;
  } catch {
    return [];
  }
  return rows.map((r) => {
    let reason: string | null = null;
    if (r.metadata_json !== null) {
      try {
        const meta = JSON.parse(r.metadata_json) as { reason?: unknown };
        if (typeof meta.reason === 'string') reason = meta.reason.slice(0, 200);
      } catch {
        /* metadata nieparsowalne — zostaje null */
      }
    }
    return { breaker: r.resource_id ?? '(nieznany)', opens: r.n, lastOpenAt: r.last_at, lastReason: reason };
  });
}

function collectSamples(db: Db, sinceIso: string): Map<string, AnswerSample[]> {
  const rows = db
    .prepare(
      'SELECT namespaces_json, confidence, degraded, no_answer, took_ms FROM answers WHERE created_at >= ?',
    )
    .all(sinceIso) as AnswerRowLite[];
  const byNs = new Map<string, AnswerSample[]>();
  const push = (ns: string, s: AnswerSample): void => {
    const list = byNs.get(ns);
    if (list === undefined) byNs.set(ns, [s]);
    else list.push(s);
  };
  for (const r of rows) {
    let namespaces: string[] = [];
    try {
      const parsed: unknown = JSON.parse(r.namespaces_json);
      if (Array.isArray(parsed)) namespaces = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      namespaces = [];
    }
    const sample: AnswerSample = {
      namespace: namespaces[0] ?? null,
      confidence: r.confidence,
      degraded: r.degraded === 1,
      noAnswer: r.no_answer === 1,
      tookMs: r.took_ms,
    };
    push(ALL_NAMESPACES, sample);
    for (const ns of namespaces) push(ns, sample);
  }
  return byNs;
}

const runQualityAnswers: JobFn = async (ctx) => {
  const sinceIso = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  ctx.progress({ phase: 'aggregate', current: 1, total: 2, message: `Agregacja odpowiedzi z ${WINDOW_DAYS} dni` });

  const byNs = collectSamples(ctx.db, sinceIso);
  const feedback = ctx.db
    .prepare(
      `SELECT f.verdict, a.namespaces_json FROM feedback f JOIN answers a ON a.id = f.answer_id
       WHERE f.created_at >= ?`,
    )
    .all(sinceIso) as { verdict: 'up' | 'down'; namespaces_json: string }[];
  const gaps = ctx.db
    .prepare(
      "SELECT kb_namespace, question, evidence_count FROM learning_gaps WHERE status = 'open' ORDER BY evidence_count DESC",
    )
    .all() as { kb_namespace: string | null; question: string; evidence_count: number }[];
  const usage = readUsage(ctx.dataDir, sinceIso);

  // Sekcje ogólnosystemowe (tylko raport zbiorczy '__all__').
  const llmUsage = aggregateLlmUsage(ctx.db, sinceIso);
  const breakerIncidents = collectBreakerIncidents(ctx.db, sinceIso);

  ctx.progress({ phase: 'report', current: 2, total: 2, message: 'Zapis raportów quality_reports' });
  let saved = 0;
  for (const [ns, answers] of byNs) {
    const fbForNs = feedback.filter((f) => ns === ALL_NAMESPACES || f.namespaces_json.includes(`"${ns}"`));
    const gapsForNs = gaps.filter((g) => ns === ALL_NAMESPACES || g.kb_namespace === ns);
    const metrics = computeAnswerQuality({
      answers,
      feedback: fbForNs.map((f) => ({ verdict: f.verdict })),
      openGaps: gapsForNs.length,
      topGapEvidence: gapsForNs.map((g) => ({ question: g.question, evidence: g.evidence_count })),
      usage: ns === ALL_NAMESPACES ? usage : [],
    });
    const checks: unknown[] = [
      { id: 'answer_quality_week', level: 'info', ok: metrics.verdict === 'OK', details: metrics },
    ];
    if (ns === ALL_NAMESPACES) {
      // Koszt LLM i incydenty breakerów są ogólnosystemowe — trzymamy je przy
      // raporcie zbiorczym, żeby nie mnożyć tych samych liczb per przestrzeń.
      checks.push({ id: 'llm_usage_week', level: 'info', ok: true, details: llmUsage });
      checks.push({
        id: 'breaker_openings_week',
        level: 'info',
        ok: breakerIncidents.length === 0,
        details: { incidents: breakerIncidents },
      });
    }
    saveQualityReport(ctx.db, ns, null, metrics.verdict, checks, 'answers');
    ctx.log(
      `${ns}: ${metrics.verdict} — odpowiedzi ${metrics.answers}, odmowy ${metrics.noAnswerRate ?? '—'}, 👎 ${metrics.feedback.downRate ?? '—'}${metrics.verdictReasons.length > 0 ? ` (${metrics.verdictReasons.join('; ')})` : ''}`,
    );
    saved++;
  }
  if (saved === 0) {
    // Brak ruchu w oknie — raport __all__ „pusty, OK" (kokpit widzi świeżość analizy).
    saveQualityReport(
      ctx.db,
      ALL_NAMESPACES,
      null,
      'OK',
      [
        { id: 'answer_quality_week', level: 'info', ok: true, details: { answers: 0 } },
        { id: 'llm_usage_week', level: 'info', ok: true, details: llmUsage },
        {
          id: 'breaker_openings_week',
          level: 'info',
          ok: breakerIncidents.length === 0,
          details: { incidents: breakerIncidents },
        },
      ],
      'answers',
    );
    ctx.log('brak odpowiedzi w oknie 7 dni — zapisany pusty raport OK');
  }
};

export default runQualityAnswers;
