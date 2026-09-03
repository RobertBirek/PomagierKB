/**
 * Routing hints cross-KB (CZYSTA logika): dopasowanie zapytania do
 * kb_registry.routing_keywords (+nazwy bazy) daje wagę [1, MAX_WEIGHT] dla list
 * danej KB w ważonym RRF. Hints tylko RE-WAŻĄ niejawne „szukaj wszędzie" —
 * jawny parametr namespaces agenta ma zawsze pierwszeństwo (bez zmian wejścia).
 * Kolumna routing_keywords istniała w schemacie od v1 i była martwa.
 */

export interface RoutableKb {
  namespace: string;
  name: string;
  /** JSON array w kolumnie routing_keywords (parsowany przez wołającego). */
  routingKeywords: readonly string[];
}

export interface RoutingDecision {
  /** Waga per namespace (1 = neutralna). */
  weights: Map<string, number>;
  /** Namespace'y, które dostały boost (diagnostyka: matchedRouting w kb_search). */
  matched: string[];
}

const MAX_WEIGHT = 1.5;
const WEIGHT_PER_MATCH = 0.25;

/** Tokeny zapytania: litery/cyfry, lower-case, ≥3 znaki (spójne z FTS stems). */
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= 3);
}

/** Prefiksowe dopasowanie tokenu do keyworda (polska fleksja: 'szynoprzewodów' ~ 'szynoprzewod'). */
function tokenMatches(token: string, keyword: string): boolean {
  return token.startsWith(keyword) || keyword.startsWith(token);
}

export function routeNamespaces(query: string, kbs: readonly RoutableKb[]): RoutingDecision {
  const tokens = tokenize(query);
  const weights = new Map<string, number>();
  const matched: string[] = [];
  for (const kb of kbs) {
    const keywords = [
      ...kb.routingKeywords.map((k) => k.toLowerCase().trim()).filter((k) => k.length >= 3),
      ...tokenize(kb.name),
    ];
    let hits = 0;
    for (const token of tokens) {
      if (keywords.some((k) => tokenMatches(token, k))) hits++;
    }
    const weight = Math.min(1 + hits * WEIGHT_PER_MATCH, MAX_WEIGHT);
    weights.set(kb.namespace, weight);
    if (weight > 1) matched.push(kb.namespace);
  }
  return { weights, matched: matched.sort() };
}
