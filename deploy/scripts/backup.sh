#!/usr/bin/env bash
# backup.sh — nocny snapshot stacków edge+kag (PomagierKB), wg docs/design/infra.md §5.
# Zbiera: dump MySQL OpenSPG (w kontenerze, hasło przez env — nie w argv), tar.zst neo4j/minio,
# kopię online SQLite panelu (better-sqlite3 backup API, fallback sqlite3 CLI), pg_dump Authentika,
# certy Caddy, audyt panelu, kopie obu .env (0600), compose config/ps; pisze SHA256SUMS
# i _manifest.json. Retencja: 14 dni + pierwszy snapshot miesiąca trzymany 6 mies.
# Użycie: backup.sh [--cold-neo4j]   (zimny snapshot neo4j: stop -> tar -> start; comiesięczne okno)
# Env: DATA_ROOT (domyślnie z deploy/kag/.env lub /srv/kag-data),
#      BACKUP_OFFSITE_TARGET — puste = warning w manifeście; "rclone://remote:ścieżka" albo cel
#      rsync (np. user@host:/sciezka), PANEL_DB_IN_CONTAINER (domyślnie /data/db/kag.db),
#      BACKUP_PING_URL — opcjonalny ping sukcesu (healthchecks/Kuma push), wołany TYLKO przy ok.
# Kontrakt: brak KTÓREGOKOLWIEK z artefaktów wymaganych (mysql, neo4j, minio, panel.sqlite,
# authentik-pg) => ok:false w manifeście i exit 1 (fail-loudly — cichy sukces to incydent
# z 2026-09-03, gdy literówka nazwy pliku zostawiła panel bez backupu przez dobę).
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
EDGE_ENV="${REPO_ROOT}/deploy/edge/.env"
KAG_ENV="${REPO_ROOT}/deploy/kag/.env"

# Bezpieczne czytanie pojedynczych kluczy z .env (bez source — wartości bywają ze znakami specjalnymi)
# env_get ucina komentarz inline (wartość "obraz@sha  # nota" -> "obraz@sha") i białe znaki.
env_get() { local v; v=$(grep -E "^$2=" "$1" 2>/dev/null | tail -n1 | cut -d= -f2-) || true; v=${v%%[[:space:]]#*}; v="${v%"${v##*[![:space:]]}"}"; printf '%s' "${v:-${3:-}}"; }

DATA_ROOT="${DATA_ROOT:-$(env_get "${KAG_ENV}" DATA_ROOT /srv/kag-data)}"
BACKUP_ROOT="${BACKUP_ROOT:-${DATA_ROOT}/backups/nightly}"
RETENTION_DAYS=14
MONTHLY_KEEP_DAYS=186   # ~6 miesięcy dla pierwszego snapshotu miesiąca
STAMP="$(date +%Y-%m-%d_%H%M%S)"
SNAP="${BACKUP_ROOT}/${STAMP}"
PANEL_DB_IN_CONTAINER="${PANEL_DB_IN_CONTAINER:-/data/db/kag.db}"
NEO4J_SERVICE="${NEO4J_SERVICE:-neo4j}"
COLD_NEO4J=0
[[ "${1:-}" == "--cold-neo4j" ]] && COLD_NEO4J=1

WARNINGS=()
CORE_COUNT=0   # liczba kluczowych artefaktów (mysql/neo4j/minio/sqlite/pg)
MISSING_REQUIRED=()   # nazwy brakujących artefaktów wymaganych — niepuste => ok:false + exit 1
require_missing() { MISSING_REQUIRED+=("$1"); }
log()  { echo "[backup] $*"; }
warn() { echo "[backup][UWAGA] $*" >&2; WARNINGS+=("$*"); }
die()  { echo "[backup][BŁĄD] $*" >&2; exit 1; }
json_escape() { local s=$1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\r'/\\r}; s=${s//$'\t'/\\t}; printf '%s' "$s"; }
ctr_running() { [[ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" == "true" ]]; }

[[ ${EUID} -eq 0 ]] || die "uruchom jako root"
command -v docker >/dev/null || die "brak dockera"
command -v zstd   >/dev/null || die "brak zstd (apt install zstd)"

mkdir -p "${SNAP}"
# blokada przed równoległym uruchomieniem
exec 9>"${BACKUP_ROOT}/.lock"
flock -n 9 || die "inny backup już trwa (${BACKUP_ROOT}/.lock)"

# --- 1. Dump logiczny MySQL OpenSPG (single-transaction; hasło z env kontenera, nie z argv hosta) ---
if ctr_running release-openspg-mysql; then
  log "dump MySQL (OpenSPG)..."
  if docker exec release-openspg-mysql sh -c \
      'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -uroot --single-transaction --routines --events --databases "$MYSQL_DATABASE"' \
      | zstd -q -o "${SNAP}/mysql.sql.zst"; then
    CORE_COUNT=$((CORE_COUNT + 1))
  else
    rm -f "${SNAP}/mysql.sql.zst"
    warn "mysqldump nie powiódł się"
    require_missing mysql
  fi
else
  warn "kontener release-openspg-mysql nie działa — pomijam dump MySQL"
  require_missing mysql
fi

# --- 2. Neo4j (graf wiedzy). Hot-tar może być niespójny (DozerDB) — stąd cotygodniowa weryfikacja
#        i comiesięczny zimny snapshot przez --cold-neo4j (stop -> tar -> start).
NEO4J_MODE="hot"
if [[ -d "${DATA_ROOT}/kag/neo4j/data" ]]; then
  if [[ ${COLD_NEO4J} -eq 1 ]]; then
    NEO4J_MODE="cold"
    log "zimny snapshot neo4j: zatrzymuję usługę ${NEO4J_SERVICE}..."
    docker compose -f "${REPO_ROOT}/deploy/kag/compose.yaml" stop "${NEO4J_SERVICE}"
    # gwarancja ponownego startu nawet przy błędzie tar
    trap 'docker compose -f "${REPO_ROOT}/deploy/kag/compose.yaml" start "${NEO4J_SERVICE}" || true' EXIT
  fi
  log "archiwizuję neo4j/data (${NEO4J_MODE})..."
  if tar --zstd -cf "${SNAP}/neo4j-data.tar.zst" -C "${DATA_ROOT}/kag/neo4j" data; then
    CORE_COUNT=$((CORE_COUNT + 1))
  else
    warn "archiwizacja neo4j nie powiodła się"
    require_missing neo4j
  fi
  if [[ ${COLD_NEO4J} -eq 1 ]]; then
    docker compose -f "${REPO_ROOT}/deploy/kag/compose.yaml" start "${NEO4J_SERVICE}"
    trap - EXIT
  fi
else
  warn "brak katalogu ${DATA_ROOT}/kag/neo4j/data — pomijam neo4j"
  require_missing neo4j
fi

# --- 3. MinIO (uploady builderowe) ---
if [[ -d "${DATA_ROOT}/kag/minio" ]]; then
  log "archiwizuję minio..."
  if tar --zstd -cf "${SNAP}/minio.tar.zst" -C "${DATA_ROOT}/kag" minio; then
    CORE_COUNT=$((CORE_COUNT + 1))
  else
    warn "archiwizacja minio nie powiodła się"
    require_missing minio
  fi
else
  warn "brak katalogu ${DATA_ROOT}/kag/minio — pomijam minio"
  require_missing minio
fi

# --- 4. Kopia online SQLite panelu (better-sqlite3 backup API; fallback: sqlite3 CLI na hoście) ---
backup_sqlite() {
  local staging_host="${DATA_ROOT}/kag/panel/backup-staging"
  local host_db="${DATA_ROOT}/kag/panel${PANEL_DB_IN_CONTAINER#/data}"
  if ctr_running kag-panel; then
    mkdir -p "${staging_host}"
    chown 10001:10001 "${staging_host}" 2>/dev/null || true
    log "kopia SQLite przez better-sqlite3 backup API (kag-panel)..."
    if docker exec kag-panel node -e '
const Database = require("better-sqlite3");
const [src, dst] = [process.argv[1], process.argv[2]];
const db = new Database(src, { readonly: true, fileMustExist: true });
db.backup(dst).then(() => db.close()).catch((e) => { console.error(String(e)); process.exit(1); });
' "${PANEL_DB_IN_CONTAINER}" /data/backup-staging/panel.sqlite \
       && [[ -s "${staging_host}/panel.sqlite" ]]; then
      mv "${staging_host}/panel.sqlite" "${SNAP}/panel.sqlite"
      CORE_COUNT=$((CORE_COUNT + 1))
      return 0
    fi
    rm -f "${staging_host}/panel.sqlite"
    warn "kopia SQLite przez kontener nie powiodła się — próbuję sqlite3 CLI na hoście"
  else
    warn "kontener kag-panel nie działa — próbuję sqlite3 CLI na hoście"
  fi
  if command -v sqlite3 >/dev/null && [[ -f "${host_db}" ]]; then
    if sqlite3 "${host_db}" ".backup '${SNAP}/panel.sqlite'"; then
      CORE_COUNT=$((CORE_COUNT + 1))
      return 0
    fi
    rm -f "${SNAP}/panel.sqlite"
  fi
  warn "brak kopii SQLite panelu (ani kontener, ani sqlite3 CLI nie zadziałały)"
  require_missing panel.sqlite
}
backup_sqlite

# --- 5. pg_dump Authentika (rola z env kontenera, auth po sockecie lokalnym) ---
if ctr_running edge-postgres; then
  log "pg_dump Authentika..."
  if docker exec edge-postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
      | zstd -q -o "${SNAP}/authentik-pg.sql.zst"; then
    CORE_COUNT=$((CORE_COUNT + 1))
  else
    rm -f "${SNAP}/authentik-pg.sql.zst"
    warn "pg_dump Authentika nie powiódł się"
    require_missing authentik-pg
  fi
else
  warn "kontener edge-postgres nie działa — pomijam pg_dump"
  require_missing authentik-pg
fi

# --- 6. Certy Caddy (Let's Encrypt — krytyczne przy odtwarzaniu bez wypalania limitów ACME) ---
if [[ -d "${DATA_ROOT}/edge/caddy/data" ]]; then
  tar --zstd -cf "${SNAP}/caddy-data.tar.zst" -C "${DATA_ROOT}/edge/caddy" data \
    || warn "archiwizacja certów Caddy nie powiodła się"
else
  warn "brak katalogu ${DATA_ROOT}/edge/caddy/data — pomijam certy"
fi

# --- 7. Kopie .env (sekrety stacków; 0600 wymusza też umask 077) ---
if [[ -f "${EDGE_ENV}" ]]; then cp "${EDGE_ENV}" "${SNAP}/env-edge.env" && chmod 600 "${SNAP}/env-edge.env"; else warn "brak ${EDGE_ENV}"; fi
if [[ -f "${KAG_ENV}"  ]]; then cp "${KAG_ENV}"  "${SNAP}/env-kag.env"  && chmod 600 "${SNAP}/env-kag.env";  else warn "brak ${KAG_ENV}"; fi

# --- 8. Audyt panelu (JSONL, hash-chain) ---
if [[ -d "${DATA_ROOT}/kag/panel/audit" ]]; then
  tar --zstd -cf "${SNAP}/panel-audit.tar.zst" -C "${DATA_ROOT}/kag/panel" audit \
    || warn "archiwizacja audytu panelu nie powiodła się"
fi

# --- 8b. Pliki panelu (bloby intake'ów, eksporty CSV, logi akcji, usage MCP) — bez nich
#         restore SQLite zostawia wiszące blob_path/eksporty. Best-effort (nie-wymagane).
PANEL_TREES=()
for tree in uploads exports inbox actions mcp-usage; do
  [[ -d "${DATA_ROOT}/kag/panel/${tree}" ]] && PANEL_TREES+=("${tree}")
done
if [[ ${#PANEL_TREES[@]} -gt 0 ]]; then
  log "archiwizuję pliki panelu: ${PANEL_TREES[*]}..."
  tar --zstd -cf "${SNAP}/panel-files.tar.zst" -C "${DATA_ROOT}/kag/panel" "${PANEL_TREES[@]}" \
    || warn "archiwizacja plików panelu nie powiodła się"
fi

# --- 9. Stan compose (config zawiera zrenderowane sekrety — snapshot jest 0700/root) ---
for stack in edge kag; do
  cf="${REPO_ROOT}/deploy/${stack}/compose.yaml"
  if [[ -f "${cf}" ]]; then
    docker compose -f "${cf}" config > "${SNAP}/${stack}-compose.config.yaml" 2>/dev/null \
      || { warn "compose config stacka ${stack} nie powiódł się"; rm -f "${SNAP}/${stack}-compose.config.yaml"; }
    docker compose -f "${cf}" ps > "${SNAP}/${stack}-compose.ps.txt" 2>/dev/null \
      || rm -f "${SNAP}/${stack}-compose.ps.txt"
  else
    warn "brak ${cf}"
  fi
done

# --- 10. Sumy kontrolne ---
( cd "${SNAP}" && find . -maxdepth 1 -type f ! -name SHA256SUMS ! -name _manifest.json -printf '%P\n' \
    | sort | xargs -r sha256sum > SHA256SUMS )

# --- 11. Off-site (BACKUP_OFFSITE_TARGET puste = tylko warning w manifeście) ---
OFFSITE_TARGET="${BACKUP_OFFSITE_TARGET:-}"
OFFSITE_STATUS="not_configured"
if [[ -z "${OFFSITE_TARGET}" ]]; then
  warn "BACKUP_OFFSITE_TARGET pusty — brak kopii off-site (parametr do wypełnienia)"
else
  log "wysyłam snapshot off-site: ${OFFSITE_TARGET}"
  if [[ "${OFFSITE_TARGET}" == rclone://* ]]; then
    if rclone copy "${SNAP}" "${OFFSITE_TARGET#rclone://}/${STAMP}"; then OFFSITE_STATUS="ok"; else OFFSITE_STATUS="failed"; warn "rclone off-site nie powiódł się"; fi
  else
    if rsync -a "${SNAP}" "${OFFSITE_TARGET}/"; then OFFSITE_STATUS="ok"; else OFFSITE_STATUS="failed"; warn "rsync off-site nie powiódł się"; fi
  fi
fi

# --- 12. Manifest JSON ---
OK=false
[[ ${CORE_COUNT} -gt 0 && ${#MISSING_REQUIRED[@]} -eq 0 ]] && OK=true
{
  printf '{\n'
  printf '  "ok": %s,\n' "${OK}"
  printf '  "createdAt": "%s",\n' "$(date -Is)"
  printf '  "stamp": "%s",\n' "${STAMP}"
  printf '  "snapshotDir": "%s",\n' "$(json_escape "${SNAP}")"
  printf '  "retentionDays": %s,\n' "${RETENTION_DAYS}"
  printf '  "monthlyKeepDays": %s,\n' "${MONTHLY_KEEP_DAYS}"
  printf '  "neo4jMode": "%s",\n' "${NEO4J_MODE}"
  printf '  "coreArtifacts": %s,\n' "${CORE_COUNT}"
  printf '  "missingRequired": ['
  first=1
  for m in "${MISSING_REQUIRED[@]+"${MISSING_REQUIRED[@]}"}"; do
    [[ ${first} -eq 1 ]] || printf ', '
    first=0
    printf '"%s"' "$(json_escape "${m}")"
  done
  printf '],\n'
  printf '  "offsite": { "target": "%s", "status": "%s" },\n' "$(json_escape "${OFFSITE_TARGET}")" "${OFFSITE_STATUS}"
  printf '  "files": [\n'
  first=1
  while read -r sum name; do
    [[ -n "${name}" ]] || continue
    size=$(stat -c %s "${SNAP}/${name}")
    [[ ${first} -eq 1 ]] || printf ',\n'
    first=0
    printf '    { "name": "%s", "sizeBytes": %s, "sha256": "%s" }' "$(json_escape "${name}")" "${size}" "${sum}"
  done < "${SNAP}/SHA256SUMS"
  printf '\n  ],\n'
  printf '  "warnings": ['
  first=1
  for w in "${WARNINGS[@]+"${WARNINGS[@]}"}"; do
    [[ ${first} -eq 1 ]] || printf ', '
    first=0
    printf '"%s"' "$(json_escape "${w}")"
  done
  printf ']\n'
  printf '}\n'
} > "${SNAP}/_manifest.json"
chmod 600 "${SNAP}/_manifest.json"

# manifest dosyłamy off-site na końcu (best-effort)
if [[ "${OFFSITE_STATUS}" == "ok" ]]; then
  if [[ "${OFFSITE_TARGET}" == rclone://* ]]; then
    rclone copy "${SNAP}/_manifest.json" "${OFFSITE_TARGET#rclone://}/${STAMP}" || true
  else
    rsync -a "${SNAP}/_manifest.json" "${OFFSITE_TARGET}/${STAMP}/" || true
  fi
fi

# --- 13. Retencja: 14 dni nightly; pierwszy snapshot miesiąca trzymany ~6 mies. ---
prune_snapshots() {
  local now dir name month ts age
  now=$(date +%s)
  declare -A month_first=()
  # pierwszy (najstarszy) snapshot każdego miesiąca
  while IFS= read -r name; do
    month=${name:0:7}
    [[ -n "${month_first[${month}]:-}" ]] || month_first[${month}]=${name}
  done < <(find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d -printf '%P\n' \
             | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}$' | sort)
  while IFS= read -r name; do
    dir="${BACKUP_ROOT}/${name}"
    ts=$(date -d "${name:0:10}" +%s 2>/dev/null) || continue
    age=$(( (now - ts) / 86400 ))
    if [[ ${age} -le ${RETENTION_DAYS} ]]; then continue; fi
    month=${name:0:7}
    if [[ "${month_first[${month}]:-}" == "${name}" && ${age} -le ${MONTHLY_KEEP_DAYS} ]]; then
      continue   # miesięczny snapshot zostaje
    fi
    log "retencja: usuwam stary snapshot ${name} (wiek ${age} dni)"
    rm -rf "${dir}"
  done < <(find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d -printf '%P\n' \
             | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}$' | sort)
}
prune_snapshots

cat "${SNAP}/_manifest.json"
if [[ "${OK}" != "true" ]]; then
  die "snapshot NIEKOMPLETNY — brakuje artefaktów wymaganych: ${MISSING_REQUIRED[*]:-brak żadnego}"
fi
# ping sukcesu (healthchecks/Kuma push) — cisza po drugiej stronie = alarm
if [[ -n "${BACKUP_PING_URL:-}" ]]; then
  curl -fsS -m 10 "${BACKUP_PING_URL}" >/dev/null || warn "ping sukcesu nie doszedł"
fi
log "backup zakończony: ${SNAP}"
