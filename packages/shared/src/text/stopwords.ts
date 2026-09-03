/**
 * Jedno źródło stopwords (audyt: dwie rozbieżne listy PL żyły w chunksMirror.ts
 * i pipeline/analyze.ts). Dwa profile, bo zastosowania mają odwrotne wymagania:
 * - QUERY (FTS): słowa pytające/spójniki, które w AND-semantyce trigramów ubijają
 *   całe zapytanie — agresywniejsza, z wariantami bez diakrytyków (wejście bywa
 *   pisane bez ogonków);
 * - TAGS (heurystyka analyze): minimalna, PL+EN — tylko wyrzucenie oczywistych
 *   nie-tagów z rankingu częstości.
 */

export const PL_QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  'jak', 'jaki', 'jaka', 'jakie', 'jakiego', 'jakiej', 'jakich', 'ile', 'czy', 'gdzie',
  'kiedy', 'kto', 'komu', 'czego', 'czym', 'dlaczego', 'ktory', 'która', 'które', 'który',
  'jest', 'sa', 'są', 'ma', 'mają', 'maja', 'byc', 'być', 'oraz', 'lub', 'albo', 'ale',
  'dla', 'przy', 'nad', 'pod', 'przez', 'bez', 'ten', 'tym', 'tej', 'tego', 'sie', 'się',
  'nie', 'tak', 'moze', 'może', 'mozna', 'można', 'trzeba', 'nalezy', 'należy',
  // EN — zapytania agentów bywają angielskie; te tokeny też ubijają AND trigramów
  'the', 'and', 'for', 'what', 'which', 'where', 'when', 'how', 'why', 'does', 'can',
  'are', 'was', 'were', 'with', 'from', 'that', 'this',
]);

export const TAG_STOPWORDS: ReadonlySet<string> = new Set([
  'oraz', 'albo', 'lub', 'ale', 'żeby', 'aby', 'więc', 'czyli', 'jednak', 'także',
  'tylko', 'przez', 'dla', 'przy', 'nad', 'pod', 'bez', 'jako', 'jest', 'być',
  'był', 'była', 'było', 'były', 'będzie', 'mają', 'może', 'można', 'trzeba',
  'tego', 'tej', 'tym', 'tych', 'jego', 'jej', 'ich', 'nas', 'was', 'jak',
  'gdy', 'kiedy', 'gdzie', 'który', 'która', 'które', 'których', 'którym',
  'this', 'that', 'with', 'from', 'have', 'are', 'was', 'were', 'the', 'and', 'for',
]);
