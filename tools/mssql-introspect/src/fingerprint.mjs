import { FINGERPRINT_TABLES } from './queries.mjs';

/** Rozpoznaje produkt po nazwach tabel (case-insensitive). Zwraca {product, matched, score}. */
export function fingerprint(tableNames) {
  const set = new Set(tableNames.map((n) => n.toLowerCase()));
  const results = [];
  for (const [product, markers] of Object.entries(FINGERPRINT_TABLES)) {
    const matched = markers.filter((m) => set.has(m.toLowerCase()));
    results.push({ product, matched, score: matched.length / markers.length });
  }
  results.sort((a, b) => b.score - a.score);
  const best = results[0];
  return {
    product: best && best.score >= 0.5 ? best.product : 'unknown',
    matched: best?.matched ?? [],
    score: best?.score ?? 0,
    all: results,
  };
}

export const PRODUCT_LABELS = {
  insertGt: 'InsERT GT (Subiekt/Rewizor/Rachmistrz/Gratyfikant/Gestor)',
  insertNexo: 'InsERT nexo',
  comarchOptima: 'Comarch ERP Optima',
  unknown: '—',
};
