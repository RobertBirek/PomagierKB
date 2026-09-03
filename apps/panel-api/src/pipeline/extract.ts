/**
 * Etap 2 pipeline'u — EKSTRAKCJA TEKSTU (pipeline-frontend.md §c, Etap 2).
 * Kaskada dla PDF: Stirling convert → (poniżej progu) Stirling OCR pol →
 * ponowny convert → Tika → uczciwy fail 'extraction_below_quality_threshold'.
 * txt/md/csv/json/xml/yaml — odczyt bezpośredni (walidacja UTF-8);
 * html/docx/xlsx/pptx — Tika (strip XHTML).
 *
 * Wszystkie wywołania HTTP przez wstrzykiwalny fetchImpl (testowalność),
 * timeout 30 s na wywołanie, semafor max 2 równoległych OCR (prosta kolejka
 * w module — OCR jest najcięższym krokiem Stirlinga).
 */

export type ExtractProvider = 'stirling' | 'stirling_ocr' | 'tika' | 'raw';

export interface ExtractResult {
  text: string;
  provider: ExtractProvider;
  /** Ratio znaków drukowalnych finalnego tekstu (0..1) — zapis do extract_quality. */
  quality: number;
}

export interface ExtractInput {
  buffer: Buffer;
  mime: string;
  filename?: string;
}

export interface ExtractDeps {
  stirlingUrl: string;
  tikaUrl: string;
  /** Wstrzykiwany w testach zamiast globalnego fetch. */
  fetchImpl?: typeof globalThis.fetch;
  /** Timeout pojedynczego wywołania zewnętrznego (default 30 000 ms). */
  timeoutMs?: number;
  /** Opcjonalny nagłówek X-API-KEY Stirlinga. */
  stirlingApiKey?: string;
}

/** Kody błędów ekstrakcji — mają wpisy w services/messages.ts (INTAKE_ERROR_CODES). */
export type ExtractErrorCode = 'extraction_below_quality_threshold' | 'invalid_encoding';

export class ExtractError extends Error {
  readonly code: ExtractErrorCode;
  constructor(code: ExtractErrorCode, message: string) {
    super(message);
    this.name = 'ExtractError';
    this.code = code;
  }
}

import { RETRYABLE_STATUS, RetryableError, withRetry } from './retry.js';

const DEFAULT_TIMEOUT_MS = 30_000;
export const QUALITY_MIN_LENGTH = 120;
export const QUALITY_MIN_PRINTABLE_RATIO = 0.72;

// ── Czyste funkcje jakości tekstu (testowane bez HTTP) ──────────────────────

/** Ratio znaków drukowalnych (litery/cyfry/interpunkcja/spacje) do wszystkich. */
export function printableRatio(text: string): number {
  if (text.length === 0) return 0;
  let printable = 0;
  for (const ch of text) {
    if (/[\p{L}\p{N}\p{P}\p{S}\p{Zs}\t\n\r]/u.test(ch)) printable++;
  }
  // Iteracja po code pointach — mianownik liczony tak samo.
  const total = [...text].length;
  return printable / total;
}

/**
 * Czy tekst wygląda na ludzki: ratio drukowalnych ≥0.72 i ≥3 znaki literowe.
 * Czysta funkcja — próg jakości kaskady ekstrakcji (pipeline-frontend Etap 2).
 */
export function looksHumanText(text: string): boolean {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  return letters >= 3 && printableRatio(text) >= QUALITY_MIN_PRINTABLE_RATIO;
}

/** Próg jakości kaskady: length ≥120 && looksHumanText. */
export function passesQualityThreshold(text: string): boolean {
  return text.length >= QUALITY_MIN_LENGTH && looksHumanText(text);
}

/** Strip XHTML z odpowiedzi Tiki: usuwa script/style, tagi, dekoduje encje. */
export function stripXhtml(xhtml: string): string {
  return xhtml
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(p|div|br|li|tr|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Semafor OCR: max 2 równoległe wywołania (prosta kolejka w module) ───────

const MAX_PARALLEL_OCR = 2;
let ocrActive = 0;
const ocrWaiters: (() => void)[] = [];

async function withOcrSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (ocrActive >= MAX_PARALLEL_OCR) {
    await new Promise<void>((resolve) => ocrWaiters.push(resolve));
  }
  ocrActive++;
  try {
    return await fn();
  } finally {
    ocrActive--;
    const next = ocrWaiters.shift();
    if (next) next();
  }
}

/** Liczba aktywnych OCR — do testów semafora. */
export function ocrSlotsInUse(): number {
  return ocrActive;
}

// ── Wywołania HTTP (timeout przez AbortController) ──────────────────────────

async function timedFetch(
  deps: ExtractDeps,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function pdfFormData(buffer: Buffer, filename: string, extra?: Record<string, string>): FormData {
  const fd = new FormData();
  fd.append('fileInput', new Blob([new Uint8Array(buffer)], { type: 'application/pdf' }), filename);
  for (const [k, v] of Object.entries(extra ?? {})) fd.append(k, v);
  return fd;
}

function stirlingHeaders(deps: ExtractDeps): Record<string, string> {
  return deps.stirlingApiKey !== undefined && deps.stirlingApiKey !== ''
    ? { 'X-API-KEY': deps.stirlingApiKey }
    : {};
}

/**
 * Stirling: PDF → markdown. Przejściowe awarie (sieć/timeout/429/5xx) ponawiane
 * z backoffem — wcześniej pojedynczy 502 po cichu degradował kaskadę do OCR/Tiki.
 * Ostateczna porażka → null (kaskada idzie dalej).
 */
async function stirlingConvert(deps: ExtractDeps, buffer: Buffer, filename: string): Promise<string | null> {
  try {
    return await withRetry(async () => {
      const res = await timedFetch(deps, `${deps.stirlingUrl}/api/v1/convert/pdf/markdown`, {
        method: 'POST',
        headers: stirlingHeaders(deps),
        body: pdfFormData(buffer, filename),
      });
      if (RETRYABLE_STATUS.has(res.status)) throw new RetryableError(`stirling convert HTTP ${res.status}`);
      if (!res.ok) return null;
      return await res.text();
    });
  } catch {
    return null;
  }
}

/** Stirling: OCR pol → PDF z warstwą tekstu. Retry przejściowych; null przy porażce. */
async function stirlingOcr(deps: ExtractDeps, buffer: Buffer, filename: string): Promise<Buffer | null> {
  return withOcrSlot(async () => {
    try {
      return await withRetry(async () => {
        const res = await timedFetch(deps, `${deps.stirlingUrl}/api/v1/misc/ocr-pdf`, {
          method: 'POST',
          headers: stirlingHeaders(deps),
          body: pdfFormData(buffer, filename, { languages: 'pol' }),
        });
        if (RETRYABLE_STATUS.has(res.status)) throw new RetryableError(`stirling ocr HTTP ${res.status}`);
        if (!res.ok) return null;
        return Buffer.from(await res.arrayBuffer());
      });
    } catch {
      return null;
    }
  });
}

/** Tika: dowolny dokument → tekst (strip XHTML). Retry przejściowych; null przy porażce. */
async function tikaExtract(deps: ExtractDeps, buffer: Buffer, mime: string): Promise<string | null> {
  try {
    return await withRetry(async () => {
      const res = await timedFetch(deps, `${deps.tikaUrl}/tika`, {
        method: 'PUT',
        headers: { 'content-type': mime },
        body: new Uint8Array(buffer),
      });
      if (RETRYABLE_STATUS.has(res.status)) throw new RetryableError(`tika HTTP ${res.status}`);
      if (!res.ok) return null;
      return stripXhtml(await res.text());
    });
  } catch {
    return null;
  }
}

// ── Routing po mime ─────────────────────────────────────────────────────────

/** Typy czytane bezpośrednio jako tekst (walidacja UTF-8, bez usług zewnętrznych). */
const RAW_TEXT_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/xml',
  'text/xml',
  'application/x-yaml',
  'text/yaml',
]);

function decodeUtf8Strict(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new ExtractError('invalid_encoding', 'plik tekstowy nie jest poprawnym UTF-8');
  }
}

/**
 * Główna funkcja ekstrakcji — kaskada wg pipeline-frontend Etap 2.
 * Rzuca ExtractError, gdy żaden krok nie dał tekstu powyżej progu jakości.
 */
export async function extractContent(input: ExtractInput, deps: ExtractDeps): Promise<ExtractResult> {
  const { buffer, mime } = input;
  const filename = input.filename ?? 'input';

  // txt/md/csv/json/xml/yaml — bezpośrednio (bez progu długości; UTF-8 obowiązkowy).
  if (RAW_TEXT_MIMES.has(mime)) {
    const text = decodeUtf8Strict(buffer).trim();
    if (!looksHumanText(text)) {
      throw new ExtractError(
        'extraction_below_quality_threshold',
        'plik tekstowy nie zawiera czytelnej treści',
      );
    }
    return { text, provider: 'raw', quality: printableRatio(text) };
  }

  if (mime === 'application/pdf') {
    // 1) Stirling convert — PDF z warstwą tekstu.
    const converted = await stirlingConvert(deps, buffer, filename);
    if (converted !== null && passesQualityThreshold(converted)) {
      return { text: converted.trim(), provider: 'stirling', quality: printableRatio(converted) };
    }

    // 2) Skan bez warstwy tekstu → OCR pol → ponowny convert.
    const ocred = await stirlingOcr(deps, buffer, filename);
    if (ocred !== null) {
      const reconverted = await stirlingConvert(deps, ocred, filename);
      if (reconverted !== null && passesQualityThreshold(reconverted)) {
        return {
          text: reconverted.trim(),
          provider: 'stirling_ocr',
          quality: printableRatio(reconverted),
        };
      }
    }

    // 3) Tika jako ostatnia szansa.
    const tika = await tikaExtract(deps, buffer, mime);
    if (tika !== null && passesQualityThreshold(tika)) {
      return { text: tika, provider: 'tika', quality: printableRatio(tika) };
    }

    // 4) Uczciwy błąd zamiast śmieciowego tekstu.
    throw new ExtractError(
      'extraction_below_quality_threshold',
      'ekstrakcja PDF poniżej progu jakości (Stirling, OCR i Tika)',
    );
  }

  // html/docx/xlsx/pptx i pozostałe typy binarne — Tika.
  const text = await tikaExtract(deps, buffer, mime);
  if (text !== null && passesQualityThreshold(text)) {
    return { text, provider: 'tika', quality: printableRatio(text) };
  }
  throw new ExtractError(
    'extraction_below_quality_threshold',
    `ekstrakcja ${mime} przez Tika poniżej progu jakości`,
  );
}
