/**
 * Markery nagrobka w grafie OpenSPG — WSPÓLNE dla producenta i konsumentów.
 *
 * Dlaczego tu, a nie w aplikacji: builder OpenSPG działa wyłącznie w trybie UPSERT i nie
 * ma zweryfikowanej w boju ścieżki kasowania encji (audyt 2026-09-06, D7-02/D14-01).
 * Wycofanie dokumentu realizujemy więc nadpisując węzeł pustym stubem z tymi markerami —
 * treść i wektory znikają, węzeł zostaje. Marker PISZE `apps/panel-api/src/pipeline/graph-ids.ts`,
 * a CZYTAJĄ go co najmniej dwa niezależne pakiety (retrieval i narzędzia MCP), które nie
 * mogą od siebie zależeć. Zduplikowany literał w dwóch miejscach jest tu klasą błędu,
 * której żaden test by nie wychwycił: rozjazd oznaczałby ciche ujawnianie wycofanej treści.
 *
 * Token jest celowo nieporadny po polsku, żeby nie trafiał w zapytania użytkowników.
 */
export const TOMBSTONE_CONTENT = '__WITHDRAWN__';
export const TOMBSTONE_SEMANTIC_TYPE = 'tombstone';

/** Czy `properties` węzła z grafu to nagrobek (a więc treść wycofana i nie wolno jej wydać). */
export function isTombstoneProperties(properties: Record<string, unknown> | null | undefined): boolean {
  if (!properties) return false;
  return (
    properties['semanticType'] === TOMBSTONE_SEMANTIC_TYPE ||
    properties['content'] === TOMBSTONE_CONTENT
  );
}
