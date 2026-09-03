/**
 * Trwałość wątku /ask (sessionStorage 'kag.ask.thread') + grupowanie historii
 * pytań po dacie. CZYSTE funkcje bez DOM — testy w test/askThread.test.ts.
 * Plik ADDYTYWNY w lib/ (zgoda z planu Fazy 3 — nie modyfikuje istniejących).
 */

/** Klucz sessionStorage z zserializowanym wątkiem. */
export const ASK_THREAD_STORAGE_KEY = 'kag.ask.thread';

/** Maksymalna liczba wpisów utrwalanych w wątku (bound na storage). */
export const ASK_THREAD_MAX_ENTRIES = 50;

// ── Kształt wątku (mirror kontraktu /api/v1/ask — AnswerResult) ──────────────

export interface ThreadCitation {
  n: number;
  id: string;
  namespace: string;
  title?: string;
  snippet?: string;
  sourceRef?: string;
}

export interface ThreadResult {
  answer: string;
  citations: ThreadCitation[];
  confidence: number;
  model: string | null;
  degraded: boolean;
  gapRecorded: boolean;
  noAnswer: boolean;
  answerId: string;
  warnings: string[];
}

/** Wpis wątku BEZ pola phase (stan przejściowy SSE nie jest utrwalany). */
export interface ThreadEntry {
  key: number;
  question: string;
  result: ThreadResult | null;
  error: string | null;
  /** Generowanie przerwane przez użytkownika (AbortError). */
  stopped: boolean;
  /** Werdykt feedbacku użytkownika (persystowany, by nie pytać dwa razy). */
  verdict: 'up' | 'down' | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeCitation(raw: unknown): ThreadCitation | null {
  const o = asRecord(raw);
  if (o === null) return null;
  const n = o['n'];
  const id = o['id'];
  const namespace = o['namespace'];
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return null;
  if (typeof id !== 'string' || typeof namespace !== 'string') return null;
  const out: ThreadCitation = { n, id, namespace };
  if (typeof o['title'] === 'string') out.title = o['title'];
  if (typeof o['snippet'] === 'string') out.snippet = o['snippet'];
  if (typeof o['sourceRef'] === 'string') out.sourceRef = o['sourceRef'];
  return out;
}

function normalizeResult(raw: unknown): ThreadResult | null {
  const o = asRecord(raw);
  if (o === null) return null;
  const answer = o['answer'];
  const answerId = o['answerId'];
  if (typeof answer !== 'string' || typeof answerId !== 'string') return null;
  const citationsRaw = o['citations'];
  const citations: ThreadCitation[] = [];
  if (Array.isArray(citationsRaw)) {
    for (const c of citationsRaw) {
      const norm = normalizeCitation(c);
      if (norm !== null) citations.push(norm);
    }
  }
  const confidence = o['confidence'];
  const warningsRaw = o['warnings'];
  return {
    answer,
    answerId,
    citations,
    confidence: typeof confidence === 'number' && !Number.isNaN(confidence) ? confidence : 0,
    model: typeof o['model'] === 'string' ? o['model'] : null,
    degraded: o['degraded'] === true,
    gapRecorded: o['gapRecorded'] === true,
    noAnswer: o['noAnswer'] === true,
    warnings: Array.isArray(warningsRaw) ? warningsRaw.filter((w): w is string => typeof w === 'string') : [],
  };
}

/**
 * Serializacja wątku do stringa (JSON). Utrwala TYLKO znane pola (pole phase
 * i inne stany przejściowe są pomijane); przycina do ostatnich
 * ASK_THREAD_MAX_ENTRIES wpisów.
 */
export function serializeThread(entries: readonly ThreadEntry[]): string {
  const tail = entries.slice(-ASK_THREAD_MAX_ENTRIES);
  const plain = tail.map((e) => ({
    key: e.key,
    question: e.question,
    result: e.result,
    error: e.error,
    stopped: e.stopped,
    verdict: e.verdict,
  }));
  return JSON.stringify({ v: 1, entries: plain });
}

/**
 * Odtworzenie wątku z sessionStorage. Defensywne: zepsuty JSON, zły kształt,
 * wpisy bez pytania → pomijane; całość nie-obiekt → []. Klucze wpisów są
 * przenumerowywane rosnąco (1..n), by uniknąć kolizji po odtworzeniu.
 */
export function deserializeThread(raw: string | null | undefined): ThreadEntry[] {
  if (typeof raw !== 'string' || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const root = asRecord(parsed);
  const list = root !== null && Array.isArray(root['entries']) ? (root['entries'] as unknown[]) : null;
  if (list === null) return [];
  const out: ThreadEntry[] = [];
  for (const item of list) {
    const o = asRecord(item);
    if (o === null) continue;
    const question = o['question'];
    if (typeof question !== 'string' || question === '') continue;
    const verdictRaw = o['verdict'];
    out.push({
      key: out.length + 1,
      question,
      result: normalizeResult(o['result']),
      error: typeof o['error'] === 'string' ? o['error'] : null,
      stopped: o['stopped'] === true,
      verdict: verdictRaw === 'up' || verdictRaw === 'down' ? verdictRaw : null,
    });
  }
  return out.slice(-ASK_THREAD_MAX_ENTRIES);
}

/** Następny wolny klucz wpisu (1 dla pustego wątku). */
export function nextThreadKey(entries: readonly { key: number }[]): number {
  let max = 0;
  for (const e of entries) if (e.key > max) max = e.key;
  return max + 1;
}

// ── Grupowanie historii pytań po dacie (Dzisiaj/Wczoraj/Ten tydzień/Starsze) ─

export type HistoryGroupId = 'today' | 'yesterday' | 'week' | 'older';

/** Kolejność sekcji w panelu historii. */
export const HISTORY_GROUP_ORDER: readonly HistoryGroupId[] = ['today', 'yesterday', 'week', 'older'];

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Grupa dla daty ISO względem `now`: dzisiaj / wczoraj / bieżący tydzień
 * (od poniedziałku) / starsze. Zepsuta data i przyszłość > dziś → 'older'
 * (defensywnie, nie wysypuje panelu).
 */
export function historyGroupId(createdAt: string, now: Date): HistoryGroupId {
  const d = new Date(createdAt);
  const time = d.getTime();
  if (Number.isNaN(time)) return 'older';
  const todayStart = startOfDay(now);
  const dayMs = 24 * 60 * 60 * 1000;
  if (time >= todayStart) {
    // Przyszłość liczona jak dzisiaj (drobne przesunięcia zegara serwera).
    return 'today';
  }
  if (time >= todayStart - dayMs) return 'yesterday';
  // Poniedziałek 00:00 bieżącego tygodnia (getDay(): 0=niedziela).
  const dow = now.getDay();
  const daysSinceMonday = (dow + 6) % 7;
  const weekStart = todayStart - daysSinceMonday * dayMs;
  if (time >= weekStart) return 'week';
  return 'older';
}

export interface HistoryGroup<T> {
  id: HistoryGroupId;
  items: T[];
}

/**
 * Dzieli listę (posortowaną malejąco po dacie przez API) na sekcje w stałej
 * kolejności; puste sekcje są pomijane. Czysta funkcja — test z fake `now`.
 */
export function groupHistory<T extends { createdAt: string }>(
  items: readonly T[],
  now: Date,
): HistoryGroup<T>[] {
  const buckets = new Map<HistoryGroupId, T[]>();
  for (const item of items) {
    const id = historyGroupId(item.createdAt, now);
    const bucket = buckets.get(id);
    if (bucket === undefined) buckets.set(id, [item]);
    else bucket.push(item);
  }
  const out: HistoryGroup<T>[] = [];
  for (const id of HISTORY_GROUP_ORDER) {
    const bucket = buckets.get(id);
    if (bucket !== undefined && bucket.length > 0) out.push({ id, items: bucket });
  }
  return out;
}
