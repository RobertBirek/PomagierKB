#!/usr/bin/env bash
# verify_backup.sh — cotygodniowa weryfikacja ostatniego (lub wskazanego) snapshotu backupu:
#  - sha256sum -c SHA256SUMS,
#  - tar --zstd -tf wszystkich archiwów + zstd -t na dumpach .sql.zst,
#  - restore dumpu MySQL do efemerycznego kontenera MariaDB (obraz OPENSPG_MYSQL_IMAGE z .env)
#    + zliczenie tabel,
#  - PRAGMA integrity_check na kopii SQLite panelu (sqlite3 na hoście, fallback: node w kag-panel).
# Raport JSON -> ${DATA_ROOT}/backups/verify/verify-<stamp>.json. Exit 1 przy niepowodzeniu.
# Użycie: verify_backup.sh [--snapshot <katalog-snapshotu>]
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
KAG_ENV="${REPO_ROOT}/deploy/kag/.env"

# env_get ucina komentarz inline (wartość "obraz@sha  # nota" -> "obraz@sha") i białe znaki.
env_get() { local v; v=$(grep -E "^$2=" "$1" 2>/dev/null | tail -n1 | cut -d= -f2-) || true; v=${v%%[[:space:]]#*}; v="${v%"${v##*[![:space:]]}"}"; printf '%s' "${v:-${3:-}}"; }
json_escape() { local s=$1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\r'/\\r}; s=${s//$'\t'/\\t}; printf '%s' "$s"; }

DATA_ROOT="${DATA_ROOT:-$(env_get "${KAG_ENV}" DATA_ROOT /srv/kag-data)}"
BACKUP_ROOT="${BACKUP_ROOT:-${DATA_ROOT}/backups/nightly}"
VERIFY_DIR="${DATA_ROOT}/backups/verify"
MYSQL_IMAGE="$(env_get "${KAG_ENV}" OPENSPG_MYSQL_IMAGE "")"
MYSQL_DB="$(env_get "${KAG_ENV}" MYSQL_DATABASE openspg)"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
REPORT="${VERIFY_DIR}/verify-${STAMP}.json"

log()  { echo "[verify] $*"; }
die()  { echo "[verify][BŁĄD] $*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || die "uruchom jako root"
command -v docker >/dev/null || die "brak dockera"
command -v zstd   >/dev/null || die "brak zstd"

# wybór snapshotu: --snapshot albo najnowszy katalog w nightly/
SNAP=""
if [[ "${1:-}" == "--snapshot" ]]; then
  SNAP="${2:?podaj katalog snapshotu}"
else
  SNAP=$(find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d -printf '%P\n' 2>/dev/null \
           | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}$' | sort | tail -n1 || true)
  [[ -n "${SNAP}" ]] && SNAP="${BACKUP_ROOT}/${SNAP}"
fi
[[ -n "${SNAP}" && -d "${SNAP}" ]] || die "nie znaleziono snapshotu w ${BACKUP_ROOT}"
log "weryfikuję snapshot: ${SNAP}"

CHECKS=()   # elementy: "nazwa|ok|szczegół"
ALL_OK=true
check() { # check <nazwa> <ok:true/false> <szczegół>
  CHECKS+=("$1|$2|$3")
  [[ "$2" == "true" ]] || ALL_OK=false
  local tag="OK "; [[ "$2" == "true" ]] || tag="FAIL"
  echo "[verify] [${tag}] $1: $3"
}

# --- 1. Sumy kontrolne ---
if [[ -f "${SNAP}/SHA256SUMS" ]]; then
  if ( cd "${SNAP}" && sha256sum -c --quiet SHA256SUMS ) >/dev/null 2>&1; then
    check "sha256sums" true "wszystkie sumy zgodne"
  else
    check "sha256sums" false "niezgodne sumy kontrolne (sha256sum -c)"
  fi
else
  check "sha256sums" false "brak pliku SHA256SUMS"
fi

# --- 2. Obecność kluczowych artefaktów ---
for f in mysql.sql.zst neo4j-data.tar.zst minio.tar.zst panel.sqlite authentik-pg.sql.zst caddy-data.tar.zst; do
  if [[ -s "${SNAP}/${f}" ]]; then
    check "obecny:${f}" true "$(stat -c %s "${SNAP}/${f}") B"
  else
    check "obecny:${f}" false "brak pliku lub pusty"
  fi
done

# --- 3. Test archiwów: tar -tf (przez zstd) + zstd -t na dumpach ---
for f in "${SNAP}"/*.tar.zst; do
  [[ -e "${f}" ]] || continue
  name=$(basename "${f}")
  if tar --zstd -tf "${f}" >/dev/null 2>&1; then
    check "tar:${name}" true "archiwum czytelne"
  else
    check "tar:${name}" false "tar -tf nie powiódł się"
  fi
done
for f in "${SNAP}"/*.sql.zst; do
  [[ -e "${f}" ]] || continue
  name=$(basename "${f}")
  if zstd -t -q "${f}" 2>/dev/null; then
    check "zstd:${name}" true "kompresja poprawna"
  else
    check "zstd:${name}" false "zstd -t nie powiódł się"
  fi
done

# --- 4. Restore MySQL do efemerycznego kontenera + zliczenie tabel ---
verify_mysql() {
  local ctr="kag-verify-mysql-$$" pw="verify-tmp-$$" i tables
  [[ -s "${SNAP}/mysql.sql.zst" ]] || { check "mysql_restore" false "brak dumpu"; return; }
  [[ -n "${MYSQL_IMAGE}" ]] || { check "mysql_restore" false "brak OPENSPG_MYSQL_IMAGE w ${KAG_ENV}"; return; }
  log "startuję efemeryczny kontener MariaDB (${MYSQL_IMAGE})..."
  # MYSQL_DATABASE wymagane: initdb.sql wbudowany w obraz zakłada istnienie tej bazy.
  if ! docker run -d --rm --name "${ctr}" --network none \
        -e MYSQL_ROOT_PASSWORD="${pw}" -e MYSQL_DATABASE="${MYSQL_DB}" "${MYSQL_IMAGE}" >/dev/null 2>&1; then
    check "mysql_restore" false "nie udało się uruchomić kontenera testowego"
    return
  fi
  trap 'docker rm -f "'"${ctr}"'" >/dev/null 2>&1 || true' RETURN
  # hasło jednorazowe dla kontenera bez sieci — przekazanie przez -e jest tu bezpieczne.
  # Sonda = realne zapytanie SQL, NIE mysqladmin ping: ping odpowiada "alive" już w fazie
  # tymczasowego serwera entrypointu (przed ustawieniem hasła) i import startował za wcześnie.
  for i in $(seq 1 90); do
    docker exec -e MYSQL_PWD="${pw}" "${ctr}" mysql -uroot -N -e 'SELECT 1' >/dev/null 2>&1 && break
    sleep 2
    [[ ${i} -eq 90 ]] && { check "mysql_restore" false "kontener testowy nie wstał w 180 s"; return; }
  done
  if ! zstd -dc "${SNAP}/mysql.sql.zst" | docker exec -i -e MYSQL_PWD="${pw}" "${ctr}" mysql -uroot >/dev/null 2>&1; then
    check "mysql_restore" false "import dumpu nie powiódł się"
    return
  fi
  tables=$(docker exec -e MYSQL_PWD="${pw}" -e DB="${MYSQL_DB}" "${ctr}" \
    sh -c 'exec mysql -uroot -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=\"$DB\""' \
    2>/dev/null || echo "")
  if [[ "${tables}" =~ ^[0-9]+$ && ${tables} -ge 1 ]]; then
    check "mysql_restore" true "restore OK, tabel w ${MYSQL_DB}: ${tables}"
  else
    check "mysql_restore" false "restore przeszedł, ale zliczenie tabel dało: '${tables}'"
  fi
}
verify_mysql

# --- 5. PRAGMA integrity_check na kopii SQLite panelu ---
verify_sqlite() {
  local res tmp staging="${DATA_ROOT}/kag/panel/backup-staging"
  [[ -s "${SNAP}/panel.sqlite" ]] || { check "sqlite_integrity" false "brak kopii panel.sqlite"; return; }
  if command -v sqlite3 >/dev/null; then
    tmp=$(mktemp -d)
    cp "${SNAP}/panel.sqlite" "${tmp}/panel.sqlite"
    res=$(sqlite3 "${tmp}/panel.sqlite" "PRAGMA integrity_check;" 2>&1 || true)
    rm -rf "${tmp}"
  elif [[ "$(docker inspect -f '{{.State.Running}}' kag-panel 2>/dev/null)" == "true" ]]; then
    # fallback: better-sqlite3 w kontenerze panelu (kopia przez wspólny bind mount)
    mkdir -p "${staging}"
    cp "${SNAP}/panel.sqlite" "${staging}/verify.sqlite"
    chown 10001:10001 "${staging}/verify.sqlite" 2>/dev/null || true
    res=$(docker exec kag-panel node -e '
const db = require("better-sqlite3")("/data/backup-staging/verify.sqlite", { readonly: true });
console.log(db.pragma("integrity_check", { simple: true }));
' 2>&1 || true)
    rm -f "${staging}/verify.sqlite"
  else
    check "sqlite_integrity" false "brak sqlite3 na hoście i kag-panel nie działa"
    return
  fi
  if [[ "${res}" == "ok" ]]; then
    check "sqlite_integrity" true "PRAGMA integrity_check = ok"
  else
    check "sqlite_integrity" false "integrity_check: ${res:0:200}"
  fi
}
verify_sqlite

# --- 6. Raport JSON ---
mkdir -p "${VERIFY_DIR}"
{
  printf '{\n'
  printf '  "ok": %s,\n' "${ALL_OK}"
  printf '  "checkedAt": "%s",\n' "$(date -Is)"
  printf '  "snapshotDir": "%s",\n' "$(json_escape "${SNAP}")"
  printf '  "checks": [\n'
  first=1
  for c in "${CHECKS[@]}"; do
    IFS='|' read -r cname cok cdetail <<< "${c}"
    [[ ${first} -eq 1 ]] || printf ',\n'
    first=0
    printf '    { "name": "%s", "ok": %s, "detail": "%s" }' \
      "$(json_escape "${cname}")" "${cok}" "$(json_escape "${cdetail}")"
  done
  printf '\n  ]\n'
  printf '}\n'
} > "${REPORT}"
chmod 600 "${REPORT}"
log "raport: ${REPORT}"

if [[ "${ALL_OK}" != "true" ]]; then
  die "weryfikacja backupu NIE przeszła — szczegóły w ${REPORT}"
fi
log "weryfikacja backupu przeszła"
