/**
 * Kontrakt evidence claim→cytowania (raport MCP §structured evidence) — CZYSTA
 * logika: dzieli gotową odpowiedź na zdania-twierdzenia i mapuje każde na numery
 * [n] występujące w tym zdaniu. ZERO dodatkowych wywołań LLM — strukturyzujemy
 * to, co model już wyprodukował z wymuszonymi cytowaniami.
 */

export interface AnswerClaim {
  claim: string;
  /** Numery źródeł [n] cytowane w tym zdaniu (puste = twierdzenie bez cytowania). */
  evidenceNs: number[];
}

const MIN_CLAIM_CHARS = 15;
const MAX_CLAIMS = 20;

/** Podział na zdania odporny na markdown: listy/nagłówki po liniach, proza po '. '. */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || /^#{1,6}\s/.test(trimmed)) continue;
    const body = trimmed.replace(/^[-*+]\s+|^\d+\.\s+/, '');
    // proza: tnij po kropce/wykrzykniku/pytajniku + spacja + wielka litera/cyfra/[
    const parts = body.split(/(?<=[.!?])\s+(?=[A-ZĄĆĘŁŃÓŚŹŻ0-9[])/);
    out.push(...parts);
  }
  return out;
}

export function extractClaims(answer: string): AnswerClaim[] {
  const claims: AnswerClaim[] = [];
  for (const sentence of splitSentences(answer)) {
    const clean = sentence.trim();
    const withoutMarkers = clean
      .replace(/\s*\[\d{1,3}\]/g, '')
      .replace(/\s+([.,;:!?])/g, '$1')
      .trim();
    if (withoutMarkers.length < MIN_CLAIM_CHARS) continue;
    const ns = [...clean.matchAll(/\[(\d{1,3})\]/g)]
      .map((m) => Number(m[1]))
      .filter((n, i, arr) => arr.indexOf(n) === i)
      .sort((a, b) => a - b);
    claims.push({ claim: withoutMarkers.replace(/\s{2,}/g, ' '), evidenceNs: ns });
    if (claims.length >= MAX_CLAIMS) break;
  }
  return claims;
}

/**
 * Udział BLOKÓW odpowiedzi (akapit / lista — rozdzielone pustą linią) bez żadnego cytowania [n].
 * Liczone po blokach, nie po zdaniach: lista z cytowaniem w ostatnim punkcie albo w zdaniu
 * wprowadzającym jest poparta jako całość (formatowanie nie może obniżać pewności). Nagłówki
 * i bloki krótsze niż MIN_CLAIM_CHARS są pomijane. Wejście do kary pewności w answer.ts:
 * sędzia LLM (2026-09-10) łapał akapity dokładające wiedzę spoza źródeł („SQL Server 2025").
 */
export function uncitedShare(answer: string): { blocks: number; uncited: number; share: number } {
  let blocks = 0;
  let uncited = 0;
  for (const raw of answer.split(/\n\s*\n/)) {
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !/^#{1,6}\s/.test(l));
    const text = lines.join(' ').replace(/\s*\[\d{1,3}\]/g, '').trim();
    if (text.length < MIN_CLAIM_CHARS) continue;
    blocks++;
    if (!/\[\d{1,3}\]/.test(raw)) uncited++;
  }
  return { blocks, uncited, share: blocks === 0 ? 0 : uncited / blocks };
}
