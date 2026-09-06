#!/usr/bin/env bash
# smoke.sh — test dymny po wdrożeniu/aktualizacji (PLAN.md Faza 1.5).
# Checki: healthz panelu i MCP (docker exec, sieć wewnętrzna), discovery OIDC Authentika,
# SPA publiczna + API chronione (401), MCP initialize+tools/list (klucz z env SMOKE_MCP_KEY — brak = SKIP),
# sonda search OpenSPG na namespace stagingowym (env SMOKE_STAGING_NS — brak = SKIP).
# Env dodatkowe: SMOKE_MCP_URL (nadpisuje URL MCP, np. z profilem /mcp/<profil>),
#                SMOKE_INSECURE=1 (curl -k, TYLKO na czas staging CA),
#                PANEL_DB_IN_CONTAINER (ścieżka SQLite w kontenerze, domyślnie /data/db/kag.db).
# Raport PASS/FAIL/SKIP per check; exit != 0 gdy jakikolwiek FAIL.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
KAG_ENV="${REPO_ROOT}/deploy/kag/.env"

env_get() { local v; v=$(grep -E "^$2=" "$1" 2>/dev/null | tail -n1 | cut -d= -f2-) || true; printf '%s' "${v:-${3:-}}"; }

PANEL_PUBLIC_URL="$(env_get "${KAG_ENV}" PANEL_PUBLIC_URL "https://kag.ilovelighting.sanok.pl")"
PANEL_OIDC_ISSUER="$(env_get "${KAG_ENV}" PANEL_OIDC_ISSUER "https://auth.ilovelighting.sanok.pl/application/o/kag-panel/")"
MCP_PUBLIC_URL="$(env_get "${KAG_ENV}" MCP_PUBLIC_URL "${PANEL_PUBLIC_URL}/mcp")"
MCP_URL="${SMOKE_MCP_URL:-${MCP_PUBLIC_URL%/}/default}"   # domyślnie profil "default"
DISCOVERY_URL="${PANEL_OIDC_ISSUER%/}/.well-known/openid-configuration"
# Ścieżka bazy SQLite WEWNĄTRZ kontenera panelu (jak w backup.sh) — rejestr KB.
PANEL_DB_IN_CONTAINER="${PANEL_DB_IN_CONTAINER:-/data/db/kag.db}"

CURL=(curl -sS --max-time 20)
if [[ "${SMOKE_INSECURE:-0}" == "1" ]]; then
  CURL+=(-k)
  echo "[smoke][UWAGA] SMOKE_INSECURE=1 — pomijam weryfikację TLS (tylko na czas staging CA)" >&2
fi

PASS=0; FAIL=0; SKIP=0
RESULTS=()
res() { # res <PASS|FAIL|SKIP> <nazwa> [szczegół]
  local st=$1 name=$2 det=${3:-}
  det=${det//$'\n'/ } ; det=${det//$'\r'/ }   # szczegóły w jednej linii (błędy curl bywają wieloliniowe)
  RESULTS+=("$(printf '%-4s  %-34s %s' "${st}" "${name}" "${det}")")
  case ${st} in
    PASS) PASS=$((PASS + 1));;
    FAIL) FAIL=$((FAIL + 1));;
    SKIP) SKIP=$((SKIP + 1));;
  esac
}

# --- 1+2. healthz panelu i MCP przez docker exec (obrazy node:22-alpine mają busybox wget) ---
check_healthz() { # check_healthz <nazwa> <kontener> <port>
  local name=$1 ctr=$2 port=$3 out
  if [[ "$(docker inspect -f '{{.State.Running}}' "${ctr}" 2>/dev/null)" != "true" ]]; then
    res FAIL "${name}" "kontener ${ctr} nie działa"
    return
  fi
  if out=$(docker exec "${ctr}" wget -qO- "http://127.0.0.1:${port}/healthz" 2>&1); then
    res PASS "${name}" "${out:0:60}"
  else
    res FAIL "${name}" "healthz nie odpowiada: ${out:0:120}"
  fi
}
check_healthz "healthz panelu" kag-panel 8080
check_healthz "healthz mcp"    kag-mcp   3001

# --- 3. Discovery OIDC Authentika (przez publiczny vhost — testuje też Caddy i certy) ---
check_discovery() {
  local resp code body
  if ! resp=$("${CURL[@]}" -w $'\n%{http_code}' "${DISCOVERY_URL}" 2>&1); then
    res FAIL "discovery OIDC" "curl: ${resp:0:120}"
    return
  fi
  code="${resp##*$'\n'}"; body="${resp%$'\n'*}"
  if [[ "${code}" == "200" ]] && grep -q '"authorization_endpoint"' <<< "${body}"; then
    res PASS "discovery OIDC" "HTTP 200, issuer OK"
  else
    res FAIL "discovery OIDC" "HTTP ${code} lub brak authorization_endpoint"
  fi
}
check_discovery

# --- 4. Ochrona API: SPA jest publiczna (200), ale API bez sesji musi zwracać 401 ---
check_api_protected() {
  local spa api
  spa=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "${PANEL_PUBLIC_URL}/" 2>/dev/null) || spa=err
  api=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "${PANEL_PUBLIC_URL}/api/v1/me" 2>/dev/null) || api=err
  if [ "${spa}" = "200" ] && [ "${api}" = "401" ]; then
    res PASS "SPA publiczna + API chronione" "SPA ${spa}, /api/v1/me ${api}"
  else
    res FAIL "SPA publiczna + API chronione" "SPA ${spa} (oczek. 200), /api/v1/me ${api} (oczek. 401)"
  fi
}
check_api_protected

# --- 5. MCP initialize + tools/list (Streamable HTTP stateless, enableJsonResponse) ---
check_mcp() {
  local hdr=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
             -H "Authorization: Bearer ${SMOKE_MCP_KEY}")
  local resp code body
  if ! resp=$("${CURL[@]}" -w $'\n%{http_code}' -X POST "${MCP_URL}" "${hdr[@]}" -d \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"kag-smoke","version":"0.1.0"}}}' 2>&1); then
    res FAIL "mcp initialize" "curl: ${resp:0:120}"
    return
  fi
  code="${resp##*$'\n'}"; body="${resp%$'\n'*}"
  if [[ "${code}" == "200" ]] && grep -q '"result"' <<< "${body}"; then
    res PASS "mcp initialize" "HTTP 200"
  else
    res FAIL "mcp initialize" "HTTP ${code}: ${body:0:120}"
    return
  fi
  if ! resp=$("${CURL[@]}" -w $'\n%{http_code}' -X POST "${MCP_URL}" "${hdr[@]}" -d \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' 2>&1); then
    res FAIL "mcp tools/list" "curl: ${resp:0:120}"
    return
  fi
  code="${resp##*$'\n'}"; body="${resp%$'\n'*}"
  if [[ "${code}" == "200" ]] && grep -q '"tools"' <<< "${body}"; then
    res PASS "mcp tools/list" "HTTP 200, lista narzędzi obecna"
  else
    res FAIL "mcp tools/list" "HTTP ${code}: ${body:0:120}"
  fi
}
if [[ -n "${SMOKE_MCP_KEY:-}" ]]; then
  check_mcp
else
  res SKIP "mcp initialize+tools/list" "brak SMOKE_MCP_KEY — ustaw klucz sk-... aby przetestować MCP"
fi

# --- 6. Sonda search OpenSPG na namespace stagingowym (przez docker exec — zero portów na hoście).
#        Payload /public/v1/search/text wg skilla openspg-api (TextSearchRequest, zweryfikowany
#        na żywym serwerze 2026-09-02 i 2026-09-06): {projectId, queryString, labelConstraints,
#        page, topk}. Wariantu bez projectId (ze `size`) NIE używać — serwer zwraca HTTP 400
#        („There is no such fulltext schema index"), czyli sonda kłamałaby na zielono/czerwono.
#        projectId bierzemy z rejestru KB w SQLite (kb_registry = jedyne źródło prawdy o bazach),
#        czytanego przez kontener panelu (better-sqlite3) — na hoście nie ma sqlite3.
#        PASS = HTTP 200 i poprawny JSON, nie oceniamy trafień.

# Wypisuje project_id namespace'u z kb_registry albo nic (gdy brak bazy/kontenera).
kb_project_id() {
  local ns=$1 out
  [[ "$(docker inspect -f '{{.State.Running}}' kag-panel 2>/dev/null)" == "true" ]] || return 0
  out=$(docker exec kag-panel node -e '
const db = require("better-sqlite3")(process.argv[1], { readonly: true, fileMustExist: true });
const r = db.prepare("SELECT project_id FROM kb_registry WHERE namespace = ?").get(process.argv[2]);
process.stdout.write(r && r.project_id != null ? String(r.project_id) : "");
' "${PANEL_DB_IN_CONTAINER}" "${ns}" 2>/dev/null) || return 0
  [[ "${out}" =~ ^[0-9]+$ ]] && printf '%s' "${out}"
}

check_staging_search() {
  local ns=$1 out code body project_id
  if [[ "$(docker inspect -f '{{.State.Running}}' release-openspg-server 2>/dev/null)" != "true" ]]; then
    res FAIL "search staging (${ns})" "kontener release-openspg-server nie działa"
    return
  fi
  project_id=$(kb_project_id "${ns}")
  if [[ -z "${project_id}" ]]; then
    res FAIL "search staging (${ns})" \
      "brak project_id w kb_registry (kontener kag-panel nie działa albo baza ${ns} nie jest sprowizjonowana)"
    return
  fi
  if ! out=$(docker exec release-openspg-server curl -sS -m 15 -w $'\n%{http_code}' -X POST \
      "http://127.0.0.1:8887/public/v1/search/text" \
      -H "Content-Type: application/json" \
      -d "{\"projectId\":${project_id},\"queryString\":\"smoke\",\"labelConstraints\":[\"${ns}.Chunk\"],\"page\":1,\"topk\":1}" 2>&1); then
    res FAIL "search staging (${ns})" "curl w kontenerze: ${out:0:120}"
    return
  fi
  code="${out##*$'\n'}"; body="${out%$'\n'*}"
  if [[ "${code}" != "200" ]]; then
    res FAIL "search staging (${ns})" "HTTP ${code} (projectId=${project_id}): ${body:0:120}"
    return
  fi
  case "${body}" in
    \{*|\[*) res PASS "search staging (${ns})" "HTTP 200, projectId=${project_id}, odpowiedź JSON";;
    *)       res FAIL "search staging (${ns})" "nieoczekiwana odpowiedź: ${body:0:120}";;
  esac
}
if [[ -n "${SMOKE_STAGING_NS:-}" ]]; then
  check_staging_search "${SMOKE_STAGING_NS}"
else
  res SKIP "search staging" "brak SMOKE_STAGING_NS — ustaw namespace stagingowy aby przetestować search"
fi

# --- Fallback SPA: trasa dostaje HTML, brakujący plik dostaje 404 (D13-01) ---
# Przed audytem KAŻDA nieznana ścieżka dostawała index.html z kodem 200 — literówka w nazwie
# chunku albo niekompletne wdrożenie objawiały się białą stroną, a monitoring widział dwusetki.
check_spa_fallback() {
  local body code
  # (a) trasa SPA z końcowym ukośnikiem → HTML z BEZWZGLĘDNYMI ścieżkami assetów.
  #     Ścieżki względne („./assets/…") dawały białą stronę właśnie na trasach zagnieżdżonych.
  if body=$(docker exec kag-panel wget -qO- 'http://127.0.0.1:8080/inbox/' 2>&1); then
    if printf '%s' "${body}" | grep -q 'src="/assets/'; then
      res PASS "spa trasa /inbox/" "HTML z bezwzględnymi ścieżkami assetów"
    else
      res FAIL "spa trasa /inbox/" "HTML bez src=\"/assets/ — sprawdź base w vite.config.ts"
    fi
  else
    res FAIL "spa trasa /inbox/" "brak odpowiedzi: ${body:0:120}"
  fi
  # (b) nieistniejący artefakt builda → 404, NIE 200 z HTML-em.
  code=$(docker exec kag-panel wget -S -qO /dev/null \
    'http://127.0.0.1:8080/assets/nie-ma-takiego-pliku.js' 2>&1 \
    | awk '/HTTP\// {c=$2} END {print c+0}')
  if [[ "${code}" == "404" ]]; then
    res PASS "spa brakujący asset" "404 zgodnie z oczekiwaniem"
  else
    res FAIL "spa brakujący asset" "HTTP ${code} zamiast 404 — fallback maskuje błąd wdrożenia"
  fi
}
check_spa_fallback

# --- Raport ---
echo
echo "== Smoke test PomagierKB — $(date -Is) =="
for r in "${RESULTS[@]}"; do echo "  ${r}"; done
echo "----------------------------------------------"
echo "Podsumowanie: PASS=${PASS}  FAIL=${FAIL}  SKIP=${SKIP}"
if [[ ${FAIL} -gt 0 ]]; then
  echo "[smoke][BŁĄD] ${FAIL} check(ów) nie przeszło" >&2
  exit 1
fi
echo "[smoke] wszystkie wykonane checki przeszły"
