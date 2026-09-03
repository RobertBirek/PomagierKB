/**
 * Metryki strony /overview — CZYSTE funkcje budujące wartości kafli
 * z odpowiedzi API (GET /kbs, meta.total list, GET /learning/stats).
 * Testy w test/overviewMetrics.test.ts. Plik ADDYTYWNY w lib/ (plan Fazy 3).
 */
import type { PlKey } from '../i18n/pl';
import type { ListMeta } from './api';

// ── Kafel „Bazy wiedzy" + „Dokumenty/Chunki" (suma totals z GET /kbs) ────────

export interface KbStatsInput {
  status?: unknown;
  totals?: { documents?: unknown; chunks?: unknown } | null;
}

export interface KbStats {
  total: number;
  active: number;
  documents: number;
  chunks: number;
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Agregacja listy KB: liczność, aktywne, suma dokumentów i chunków. */
export function computeKbStats(items: readonly KbStatsInput[] | null | undefined): KbStats {
  const out: KbStats = { total: 0, active: 0, documents: 0, chunks: 0 };
  if (!Array.isArray(items)) return out;
  for (const kb of items) {
    out.total += 1;
    if (kb.status === 'active') out.active += 1;
    out.documents += asCount(kb.totals?.documents);
    out.chunks += asCount(kb.totals?.chunks);
  }
  return out;
}

// ── meta.total z koperty list (drafts/actions z limit=1) ─────────────────────

/** Licznik z meta koperty; brak/nieprawidłowy → null (kafel pokaże „—"). */
export function metaTotal(meta: ListMeta | undefined): number | null {
  const total = meta?.total;
  return typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : null;
}

// ── Otwarte luki z GET /learning/stats ───────────────────────────────────────

/** Licznik otwartych luk ze stats {open,in_draft,...}; brak → null. */
export function openGapsCount(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null;
  const stats = (data as { stats?: unknown }).stats;
  if (typeof stats !== 'object' || stats === null) return null;
  const open = (stats as Record<string, unknown>)['open'];
  return typeof open === 'number' && Number.isFinite(open) && open >= 0 ? open : null;
}

// ── Ludzka etykieta typu akcji (lista „Ostatnie akcje") ──────────────────────

const ACTION_TYPE_KEYS: Record<string, PlKey> = {
  build_kb: 'overview.actionType.build_kb',
  create_kb: 'overview.actionType.create_kb',
  quality_gate: 'overview.actionType.quality_gate',
  schema_sync: 'overview.actionType.schema_sync',
};

/** Klucz PL dla znanego typu akcji; nieznany typ → null (UI pokaże surowy). */
export function actionTypeLabelKey(type: string): PlKey | null {
  return ACTION_TYPE_KEYS[type] ?? null;
}
