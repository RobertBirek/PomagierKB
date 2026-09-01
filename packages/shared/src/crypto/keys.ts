import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Klucze API MCP: raw pokazywany DOKŁADNIE raz, w DB tylko sha256(raw) + prefix do UI.
 */

export interface GeneratedApiKey {
  /** Pełny sekret 'sk-<base64url 24B>' — nigdy nie zapisywać, pokazać raz. */
  raw: string;
  /** sha256(raw) hex — jedyna forma przechowywana w api_keys.hash. */
  hash: string;
  /** Pierwsze 6 znaków raw ('sk-Ab1') — identyfikacja klucza w UI/logach. */
  prefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const raw = 'sk-' + randomBytes(24).toString('base64url');
  return { raw, hash: hashToken(raw), prefix: raw.slice(0, 6) };
}

/** sha256 hex prezentowanego tokenu — do lookupu po api_keys.hash. */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Porównanie stałoczasowe dwóch stringów. Różne długości nie skracają obliczeń:
 * oba bufory są dopełniane zerami do wspólnej długości, timingSafeEqual zawsze
 * przebiega po całości, a równość długości dokłada się na końcu.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  const len = Math.max(ba.length, bb.length, 1);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  ba.copy(pa);
  bb.copy(pb);
  const contentEqual = timingSafeEqual(pa, pb);
  return contentEqual && ba.length === bb.length;
}
