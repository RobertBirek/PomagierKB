#!/usr/bin/env bash
# purge_graph_nodes.sh — FIZYCZNE usunięcie z grafu węzłów wycofanych ze stanu docelowego.
#
# Dlaczego istnieje: builder OpenSPG działa w trybie UPSERT i — potwierdzone na produkcji
# 2026-09-06 — NIE nadpisuje węzła wierszem-nagrobkiem. Job kończy się sukcesem, rejestr
# `graph_ids` oznacza nagrobek jako potwierdzony, a węzeł zachowuje pełną treść i pozostaje
# w indeksach. Retrieval odsiewa takie id po `graph_ids.live = 0`, więc treść nie wychodzi
# do użytkownika — ale FIZYCZNIE nadal jest w bazie grafu i w kopiach zapasowych. Dla żądania
# usunięcia danych (RODO, sprostowanie, wycofanie poufnej treści) to za mało.
#
# Bezpieczeństwo — najważniejsza właściwość tego skryptu: lista do usunięcia pochodzi
# WYŁĄCZNIE z rejestru panelu (`graph_ids` gdzie `live = 0`). Nie da się nim skasować węzła,
# który należy do stanu docelowego, nawet podając jego id ręcznie — id spoza rejestru albo
# oznaczone jako żywe jest odrzucane. Endpointów DELETE OpenSPG świadomie NIE używamy:
# są niezweryfikowane w boju, a Cypher na własnej bazie grafu jest sprawdzalny co do węzła.
#
# Użycie:
#   purge_graph_nodes.sh --namespace <NS> [--apply] [--ids id1,id2] [--limit N]
#     (bez --apply = tryb podglądu: pokazuje, co zostałoby usunięte, i nic nie zmienia)
#
# Po usunięciu: kolejny bieg bramki jakości (check graph_stale_nodes) powinien przejść na OK.
set -euo pipefail
umask 077


NAMESPACE=""
APPLY=0
ONLY_IDS=""
LIMIT=1000
while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace) NAMESPACE="${2:?podaj namespace}"; shift 2 ;;
    --apply)     APPLY=1; shift ;;
    --ids)       ONLY_IDS="${2:?podaj listę id po przecinku}"; shift 2 ;;
    --limit)     LIMIT="${2:?podaj limit}"; shift 2 ;;
    *) echo "[purge][BŁĄD] nieznany argument: $1" >&2; exit 2 ;;
  esac
done

log() { echo "[purge] $*"; }
die() { echo "[purge][BŁĄD] $*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || die "uruchom jako root"
[[ -n "${NAMESPACE}" ]] || die "wymagane --namespace <NS>"
command -v docker >/dev/null || die "brak dockera"
command -v jq     >/dev/null || die "brak jq"

PANEL_CTR="${PANEL_CTR:-kag-panel}"
NEO4J_CTR="${NEO4J_CTR:-release-openspg-neo4j}"
# Neo4j OpenSPG trzyma jedną bazę na projekt, nazwaną namespace'em małymi literami.
NEO4J_DB="$(printf '%s' "${NAMESPACE}" | tr '[:upper:]' '[:lower:]')"

for c in "${PANEL_CTR}" "${NEO4J_CTR}"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "${c}" 2>/dev/null)" == "true" ]] \
    || die "kontener ${c} nie działa"
done

# --- 1. Lista kandydatów Z REJESTRU (jedyne źródło prawdy o tym, co wycofane) ---
CANDIDATES_JSON="$(docker exec -e PURGE_NS="${NAMESPACE}" -e PURGE_IDS="${ONLY_IDS}" -e PURGE_LIMIT="${LIMIT}" \
  "${PANEL_CTR}" node -e '
const db = require("better-sqlite3")(process.env.DATA_DIR ? process.env.DATA_DIR + "/db/kag.db" : "/data/db/kag.db", { readonly: true });
const ns = process.env.PURGE_NS;
const only = (process.env.PURGE_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
// Bez LIMIT: usunięte id zostają w rejestrze jako nagrobki (live=0) na zawsze, więc limit
// stosowany TU zwracał w każdym przebiegu tę samą, już pustą partię — purge partiami nie
// posuwał się naprzód (2026-09-10, SubiektKB: 11 734 nagrobków). Limit nakłada krok 1b,
// po odsianiu id, których w grafie już nie ma.
let rows = db
  .prepare("SELECT id, entity FROM graph_ids WHERE namespace = ? AND live = 0 ORDER BY id")
  .all(ns);
if (only.length > 0) {
  const allowed = new Set(rows.map((r) => r.id));
  const rejected = only.filter((id) => !allowed.has(id));
  rows = rows.filter((r) => only.includes(r.id));
  if (rejected.length > 0) console.error("ODRZUCONE (nie sa wycofane w rejestrze): " + rejected.join(", "));
}
console.log(JSON.stringify(rows));
' 2>/tmp/purge-stderr.$$ )" || die "nie udało się odczytać rejestru"
[[ -s /tmp/purge-stderr.$$ ]] && cat /tmp/purge-stderr.$$ >&2
rm -f /tmp/purge-stderr.$$

COUNT="$(printf '%s' "${CANDIDATES_JSON}" | jq 'length')"
if [[ "${COUNT}" -eq 0 ]]; then
  log "brak węzłów wycofanych do usunięcia w ${NAMESPACE} — nic do zrobienia"
  exit 0
fi
log "kandydatów z rejestru (live=0): ${COUNT}"

# --- 1b. Tylko te, które FAKTYCZNIE są w grafie; potem limit partii ---
cypher() { # cypher <zapytanie>
  printf '%s\n' "$1" | docker exec -i "${NEO4J_CTR}" sh -c \
    'NEO4J_USERNAME="$OPENSPG_NEO4J_USER" NEO4J_PASSWORD="$OPENSPG_NEO4J_PASSWORD" exec cypher-shell -d '"${NEO4J_DB}"' --format plain'
}
ALL_IDS="$(printf '%s' "${CANDIDATES_JSON}" | jq -c '[.[].id]')"
# Lista obecnych id idzie przez PLIK (--slurpfile), nie przez argument: przy ~12 tys. id
# przekracza limit długości pojedynczego argumentu (jq: "Argument list too long").
PRESENT_FILE="$(mktemp)"
cypher "MATCH (n) WHERE n.id IN ${ALL_IDS} RETURN collect(DISTINCT n.id) AS ids;" | tail -1 > "${PRESENT_FILE}"
CANDIDATES_JSON="$(printf '%s' "${CANDIDATES_JSON}" | jq -c --slurpfile present "${PRESENT_FILE}" --argjson lim "${LIMIT}" \
  '($present[0] | map({key: ., value: true}) | from_entries) as $m | [.[] | select($m[.id])] | .[:$lim]')"
rm -f "${PRESENT_FILE}"
COUNT="$(printf '%s' "${CANDIDATES_JSON}" | jq 'length')"
if [[ "${COUNT}" -eq 0 ]]; then
  log "wszystkie wycofane id są już poza grafem — nic do zrobienia"
  exit 0
fi
log "z tego nadal w grafie (do tej partii, limit ${LIMIT}): ${COUNT}"
printf '%s' "${CANDIDATES_JSON}" | jq -r '.[] | "  \(.entity)\t\(.id)"'

# --- 2. Stan grafu PRZED (tylko te id; potwierdzenie, że faktycznie tam są) ---

# Tablica JSON stringów jest jednocześnie poprawną listą Cyphera (["a","b"]) — bez ręcznego
# sklejania cudzysłowów, więc id z apostrofem czy przecinkiem nie rozwali zapytania.
ID_LIST="$(printf '%s' "${CANDIDATES_JSON}" | jq -c '[.[].id]')"

log "stan grafu przed:"
cypher "MATCH (n) WHERE n.id IN ${ID_LIST} RETURN count(n) AS w_grafie;" | tail -2
TOTAL_BEFORE="$(cypher 'MATCH (n) RETURN count(n) AS wszystkie;' | tail -1 | tr -d '[:space:]')"
log "węzłów w bazie ${NEO4J_DB} przed: ${TOTAL_BEFORE}"

if [[ ${APPLY} -eq 0 ]]; then
  log "TRYB PODGLĄDU — nic nie usunięto. Dodaj --apply, żeby wykonać."
  exit 0
fi

# --- 3. Usunięcie (DETACH na wszelki wypadek; w tym wdrożeniu graf nie ma relacji) ---
# Podpartie po 200 węzłów w OSOBNYCH transakcjach: chunk niesie treść + wektor embeddingu,
# a jedna transakcja na 3000 takich węzłów wysypała Neo4j (heap 2G) OutOfMemoryError
# 2026-09-10 — kasowanie się zatwierdziło, serwer padł tuż po nim. Wymaga Neo4j 5 (CALL … IN
# TRANSACTIONS) i auto-commitu cypher-shell (domyślnie).
log "usuwam ${COUNT} węzłów z bazy ${NEO4J_DB} (podpartie po 200)..."
cypher "MATCH (n) WHERE n.id IN ${ID_LIST} CALL { WITH n DETACH DELETE n } IN TRANSACTIONS OF 200 ROWS;" | tail -2

# --- 4. Weryfikacja: znikły wycofane, a NIC innego nie ubyło ---
LEFT="$(cypher "MATCH (n) WHERE n.id IN ${ID_LIST} RETURN count(n) AS zostalo;" | tail -1 | tr -d '[:space:]')"
TOTAL_AFTER="$(cypher 'MATCH (n) RETURN count(n) AS wszystkie;' | tail -1 | tr -d '[:space:]')"
EXPECTED=$(( TOTAL_BEFORE - COUNT ))
log "po usunięciu: pozostało z listy=${LEFT}, węzłów w bazie=${TOTAL_AFTER} (oczekiwane ${EXPECTED})"
[[ "${LEFT}" == "0" ]] || die "część węzłów NIE została usunięta (zostało ${LEFT})"
[[ "${TOTAL_AFTER}" == "${EXPECTED}" ]] \
  || die "liczba węzłów nie zgadza się z oczekiwaną — usunięto coś poza listą! (było ${TOTAL_BEFORE}, jest ${TOTAL_AFTER})"

# --- 5. Wpis audytu (mutacja stanu produkcyjnego musi zostawić ślad) ---
# Lista id idzie przez PLIK na wolumenie danych panelu, nie przez -e: JSON 3000 wpisów ma ~160 KB,
# a limit pojedynczego argumentu/zmiennej to 128 KB — `docker exec -e` padał z "Argument list too
# long" PO kasowaniu, zostawiając partię bez wpisu (2026-09-11; odtwarzane ręcznie).
PANEL_DATA_HOST="${PANEL_DATA_HOST:-$(docker inspect "${PANEL_CTR}" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')}"
[[ -d "${PANEL_DATA_HOST}" ]] || die "nie znajduję katalogu danych panelu (mount /data w ${PANEL_CTR})"
AUDIT_FILE="purge-audit-$$.json"
printf '%s' "${CANDIDATES_JSON}" > "${PANEL_DATA_HOST}/${AUDIT_FILE}"
docker exec -i -w /app -e PURGE_NS="${NAMESPACE}" -e PURGE_FILE="${AUDIT_FILE}" "${PANEL_CTR}" \
  node --input-type=module <<'NODE' >/dev/null
import { readFileSync } from 'node:fs';
import { openDb } from '@pomagierkb/shared/db';
import { appendAudit } from '@pomagierkb/shared/audit';
const dataDir = process.env.DATA_DIR ?? '/data';
const db = openDb(`${dataDir}/db/kag.db`);
const rows = JSON.parse(readFileSync(`${dataDir}/${process.env.PURGE_FILE}`, 'utf8'));
appendAudit(db, {
  actor: 'purge_graph_nodes.sh',
  actorType: 'system',
  action: 'graph.purge_nodes',
  resourceType: 'kb',
  resourceId: process.env.PURGE_NS,
  outcome: 'success',
  metadata: { count: rows.length, ids: rows.map((r) => r.id) },
});
NODE
rm -f "${PANEL_DATA_HOST}/${AUDIT_FILE}"
log "wpis audytu graph.purge_nodes dodany"
log "GOTOWE — uruchom bramkę jakości; check graph_stale_nodes powinien przejść na OK"
