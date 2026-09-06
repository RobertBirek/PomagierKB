#!/usr/bin/env bash
# verify_backup.sh — cotygodniowa weryfikacja ostatniego (lub wskazanego) snapshotu backupu.
# Weryfikacja integralności PLIKÓW nie jest dowodem odtwarzalności — każdy datastore jest
# realnie odtwarzany na EFEMERYCZNYM kontenerze `--network none` i odpytywany:
#  - sha256sum -c SHA256SUMS + obecność artefaktów wymaganych,
#  - tar --zstd -tf wszystkich archiwów + zstd -t na dumpach .sql.zst,
#  - MySQL: restore dumpu do MariaDB (OPENSPG_MYSQL_IMAGE) + zliczenie tabel,
#  - Neo4j: start z hot-tara (OPENSPG_NEO4J_IMAGE) + SHOW DATABASES (wszystkie online)
#    + liczba węzłów — jedyny sposób, by wykryć uszkodzony hot-tar DozerDB,
#  - MinIO: start z tara + `mc ls --recursive` (liczba obiektów = liczba w archiwum),
#  - SQLite panelu: integrity_check + schema_migrations + kb_registry + verifyChain audytu
#    (efemeryczny kag-panel:local; fallback: sqlite3 na hoście — sam integrity_check),
#  - Authentik: pg_dump wgrany do efemerycznego Postgresa + liczba użytkowników,
#  - nazwy artefaktów przywoływane w runbookach/restore.sh istnieją w snapshocie
#    (regresja po literówce `panel.sqlite3` w runbooku DR).
# Raport JSON -> ${DATA_ROOT}/backups/verify/verify-<stamp>.json, status dla kokpitu panelu
# -> ${DATA_ROOT}/kag/panel/backup-verify-status.json. Exit 1 przy niepowodzeniu.
# Użycie: verify_backup.sh [--snapshot <katalog-snapshotu>] [--quick]
#   --quick pomija odtworzenia datastore'ów (zostają sumy, archiwa i SQLite) — do diagnostyki.
# Env: VERIFY_PING_URL (lub BACKUP_PING_URL) — ping sukcesu, wołany TYLKO przy ok:true.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
KAG_ENV="${REPO_ROOT}/deploy/kag/.env"
EDGE_ENV="${REPO_ROOT}/deploy/edge/.env"

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
# Katalog roboczy MUSI leżeć pod DATA_ROOT: jednostka systemd ma PrivateTmp=true, więc /tmp
# widzi tylko ona — demon dockera nie zamontowałby stamtąd żadnego bind-mounta.
WORK="${VERIFY_DIR}/.work-${STAMP}"
EPHEMERAL_CTRS=()

log()  { echo "[verify] $*"; }
die()  { echo "[verify][BŁĄD] $*" >&2; exit 1; }
cleanup() {
  local c
  for c in "${EPHEMERAL_CTRS[@]+"${EPHEMERAL_CTRS[@]}"}"; do docker rm -f "${c}" >/dev/null 2>&1 || true; done
  [[ -n "${WORK}" && -d "${WORK}" ]] && rm -rf "${WORK}"
  return 0
}
trap cleanup EXIT

[[ ${EUID} -eq 0 ]] || die "uruchom jako root"
command -v docker >/dev/null || die "brak dockera"
command -v zstd   >/dev/null || die "brak zstd"

# wybór snapshotu: --snapshot albo najnowszy katalog w nightly/
SNAP=""
DEEP=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --snapshot) SNAP="${2:?podaj katalog snapshotu}"; shift 2 ;;
    --quick)    DEEP=0; shift ;;
    *)          die "nieznany argument: $1" ;;
  esac
done
if [[ -z "${SNAP}" ]]; then
  SNAP=$(find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d -printf '%P\n' 2>/dev/null \
           | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}$' | sort | tail -n1 || true)
  [[ -n "${SNAP}" ]] && SNAP="${BACKUP_ROOT}/${SNAP}"
fi
[[ -n "${SNAP}" && -d "${SNAP}" ]] || die "nie znaleziono snapshotu w ${BACKUP_ROOT}"
log "weryfikuję snapshot: ${SNAP}"
mkdir -p "${WORK}"

# Rozpakowanie archiwum na potrzeby efemerycznego restore'u. Bramka miejsca: wymagamy 5x
# rozmiaru archiwum (zstd na danych store'a Neo4j potrafi ściskać ~4:1).
extract_archive() { # extract_archive <plik.tar.zst> <katalog-docelowy>
  local src=$1 dst=$2 need avail
  need=$(( $(stat -c %s "${src}") / 1024 * 5 ))
  avail=$(df -Pk "${VERIFY_DIR}" | awk 'NR==2 {print $4}')
  [[ ${avail} -ge ${need} ]] || { echo "za mało miejsca (potrzeba ~${need} kB, wolne ${avail} kB)"; return 1; }
  mkdir -p "${dst}"
  zstd -dc "${src}" | tar -C "${dst}" -x
}

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
  # Sonda MUSI iść po TCP, nie po sockecie unixowym. Entrypoint obrazu MariaDB uruchamia
  # najpierw SERWER TYMCZASOWY z --skip-networking: odpowiada on na `SELECT 1` po sockecie
  # już po ~6 s, ale zanim wykonają się wbudowane skrypty init (initdb.sql, openspg-initdb.sql).
  # Import startujący w tym oknie tworzy tabele kg_*, po czym skrypt init entrypointu przewraca
  # się na `ERROR 1050 Table 'kg_app' already exists`, `set -e` ubija kontener (exit 1), a
  # `docker exec` dostaje 137. TCP nasłuchuje dopiero na serwerze FINALNYM — po "MySQL init
  # process done" / drugim "ready for connections" — więc jest jedyną wiarygodną bramką.
  local ready=false
  for i in $(seq 1 90); do
    if docker exec -e MYSQL_PWD="${pw}" "${ctr}" \
         mysql -h127.0.0.1 --protocol=tcp -uroot -N -e 'SELECT 1' >/dev/null 2>&1; then
      ready=true; break
    fi
    [[ "$(docker inspect -f '{{.State.Running}}' "${ctr}" 2>/dev/null)" == "true" ]] \
      || { check "mysql_restore" false "kontener testowy padł przed gotowością (entrypoint init)"; return; }
    sleep 2
  done
  [[ "${ready}" == "true" ]] || { check "mysql_restore" false "kontener testowy nie wstał (TCP) w 180 s"; return; }

  # Import po TCP, ze STDERR zachowanym w raporcie (dawniej odrzucanym do /dev/null — przez co
  # każda awaria importu raportowała ten sam bezużyteczny komunikat). Jeden retry na wypadek
  # przejściowego zerwania połączenia tuż po starcie serwera finalnego.
  local imp_err imp_rc attempt=0
  while :; do
    attempt=$((attempt + 1))
    imp_err=$(zstd -dc "${SNAP}/mysql.sql.zst" \
      | docker exec -i -e MYSQL_PWD="${pw}" "${ctr}" mysql -h127.0.0.1 --protocol=tcp -uroot 2>&1 >/dev/null) \
      && imp_rc=0 || imp_rc=$?
    [[ ${imp_rc} -eq 0 || ${attempt} -ge 2 ]] && break
    log "import dumpu nie powiódł się (próba ${attempt}), ponawiam..."
    sleep 3
  done
  if [[ ${imp_rc} -ne 0 ]]; then
    check "mysql_restore" false "import dumpu nie powiódł się (rc=${imp_rc}, prób: ${attempt}): $(printf '%s' "${imp_err}" | head -c 400)"
    return
  fi
  if [[ "$(docker inspect -f '{{.State.Running}}' "${ctr}" 2>/dev/null)" != "true" ]]; then
    check "mysql_restore" false "kontener testowy padł w trakcie importu (rc importu 0, ale serwer nie żyje)"
    return
  fi
  tables=$(docker exec -e MYSQL_PWD="${pw}" -e DB="${MYSQL_DB}" "${ctr}" \
    sh -c 'exec mysql -h127.0.0.1 --protocol=tcp -uroot -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=\"$DB\""' \
    2>/dev/null || echo "")
  if [[ "${tables}" =~ ^[0-9]+$ && ${tables} -ge 1 ]]; then
    check "mysql_restore" true "restore OK, tabel w ${MYSQL_DB}: ${tables}"
  else
    check "mysql_restore" false "restore przeszedł, ale zliczenie tabel dało: '${tables}'"
  fi
}
if [[ ${DEEP} -eq 1 ]]; then
  verify_mysql
else
  log "--quick: pomijam restore MySQL"
fi

# --- 5. Neo4j: realny start z hot-tara na efemerycznym kontenerze ---
#     `tar -tf` mówi tylko, że archiwum się rozpakuje. Hot-tar działającego DozerDB może
#     zawierać store files w stanie sprzed checkpointu — jedynym dowodem odtwarzalności jest
#     wystartowanie bazy i sprawdzenie, że wszystkie bazy są `online`.
verify_neo4j() {
  local ctr="kag-verify-neo4j-$$" host="kagverifyneo4j" img user pass dir="${WORK}/neo4j" \
        i err dbs offline db name counts=() n bad=""
  [[ -s "${SNAP}/neo4j-data.tar.zst" ]] || { check "neo4j_restore" false "brak archiwum neo4j-data.tar.zst"; return; }
  img="$(env_get "${KAG_ENV}" OPENSPG_NEO4J_IMAGE "")"
  user="$(env_get "${KAG_ENV}" OPENSPG_NEO4J_USER "")"
  pass="$(env_get "${KAG_ENV}" OPENSPG_NEO4J_PASSWORD "")"
  [[ -n "${img}" && -n "${user}" && -n "${pass}" ]] \
    || { check "neo4j_restore" false "brak OPENSPG_NEO4J_IMAGE/USER/PASSWORD w ${KAG_ENV}"; return; }
  if ! err=$(extract_archive "${SNAP}/neo4j-data.tar.zst" "${dir}" 2>&1); then
    check "neo4j_restore" false "rozpakowanie archiwum nie powiodło się: $(printf '%s' "${err}" | head -c 300)"
    return
  fi
  [[ -d "${dir}/data/databases" ]] || { check "neo4j_restore" false "archiwum nie zawiera data/databases"; return; }
  log "startuję efemeryczny Neo4j z hot-tara..."
  EPHEMERAL_CTRS+=("${ctr}")
  # bez NEO4J_PLUGINS: apoc pobierałby się z sieci, a kontener jest --network none;
  # hasło zgodne z .env, bo w tarze jest data/dbms/auth.ini z produkcji.
  # --hostname + --add-host są OBOWIĄZKOWE: przy --network none docker nie wpisuje nazwy
  # kontenera do /etc/hosts, log4j Neo4j wywala się na `InetAddress.getLocalHost()`
  # (UnknownHostException) i serwer kończy pracę z exit 3 zanim zdąży wstać.
  if ! docker run -d --name "${ctr}" --network none \
        --hostname "${host}" --add-host "${host}:127.0.0.1" \
        -e NEO4J_AUTH="${user}/${pass}" \
        -e NEO4J_server_memory_heap_max__size=1G \
        -e NEO4J_server_memory_pagecache_size=512M \
        -v "${dir}/data:/data" "${img}" >/dev/null 2>&1; then
    check "neo4j_restore" false "nie udało się uruchomić kontenera testowego (${img})"
    return
  fi
  local ready=false
  for i in $(seq 1 90); do
    if docker exec -e NEO4J_USERNAME="${user}" -e NEO4J_PASSWORD="${pass}" "${ctr}" \
         cypher-shell "RETURN 1;" >/dev/null 2>&1; then ready=true; break; fi
    [[ "$(docker inspect -f '{{.State.Running}}' "${ctr}" 2>/dev/null)" == "true" ]] \
      || { check "neo4j_restore" false "kontener testowy padł przed gotowością: $(docker logs "${ctr}" 2>&1 | tail -n 3 | head -c 400)"; return; }
    sleep 2
  done
  [[ "${ready}" == "true" ]] || { check "neo4j_restore" false "Neo4j nie wstał z archiwum w 180 s"; return; }
  dbs=$(docker exec -e NEO4J_USERNAME="${user}" -e NEO4J_PASSWORD="${pass}" "${ctr}" \
    cypher-shell -d system --format plain "SHOW DATABASES YIELD name, currentStatus RETURN name, currentStatus" 2>&1 | tail -n +2 || true)
  offline=$(printf '%s\n' "${dbs}" | grep -vc 'online' || true)
  if [[ -z "${dbs}" ]]; then
    check "neo4j_restore" false "SHOW DATABASES nie zwróciło nic"
    docker rm -f "${ctr}" >/dev/null 2>&1 || true
    return
  fi
  if [[ "${offline}" != "0" ]]; then
    check "neo4j_restore" false "bazy nie w stanie online: $(printf '%s' "${dbs}" | tr '\n' ';' | head -c 300)"
    docker rm -f "${ctr}" >/dev/null 2>&1 || true
    return
  fi
  # Dane KB żyją w bazach per-KB (nazwa = namespace małymi literami), nie w domyślnej `neo4j`
  # — liczymy węzły w KAŻDEJ bazie poza `system`. Błąd zapytania = baza otwarta tylko z nazwy.
  while IFS= read -r db; do
    name=$(printf '%s' "${db}" | cut -d, -f1 | tr -d '" \r')
    [[ -n "${name}" && "${name}" != "system" ]] || continue
    n=$(docker exec -e NEO4J_USERNAME="${user}" -e NEO4J_PASSWORD="${pass}" -e CDB="${name}" "${ctr}" \
      sh -c 'exec cypher-shell -d "$CDB" --format plain "MATCH (n) RETURN count(n);"' 2>/dev/null \
      | tail -n1 | tr -d '"\r ' || echo "")
    if [[ "${n}" =~ ^[0-9]+$ ]]; then counts+=("${name}=${n}"); else counts+=("${name}=BŁĄD"); bad="${name}"; fi
  done <<< "${dbs}"
  if [[ -n "${bad}" ]]; then
    check "neo4j_restore" false "baza '${bad}' online, ale zapytanie o węzły nie przeszło: ${counts[*]}"
  else
    check "neo4j_restore" true "start z archiwum OK, baz online: $(printf '%s\n' "${dbs}" | grep -c 'online'), węzły: ${counts[*]}"
  fi
  docker rm -f "${ctr}" >/dev/null 2>&1 || true
  rm -rf "${dir}"
}

# --- 6. MinIO: start z tara + zliczenie obiektów przez mc (obraz zawiera mc i curl) ---
verify_minio() {
  local ctr="kag-verify-minio-$$" img user pass dir="${WORK}/minio" i err expected got
  [[ -s "${SNAP}/minio.tar.zst" ]] || { check "minio_restore" false "brak archiwum minio.tar.zst"; return; }
  img="$(env_get "${KAG_ENV}" OPENSPG_MINIO_IMAGE "")"
  user="$(env_get "${KAG_ENV}" MINIO_ROOT_USER "")"
  pass="$(env_get "${KAG_ENV}" MINIO_ROOT_PASSWORD_URLENCODED "$(env_get "${KAG_ENV}" MINIO_ROOT_PASSWORD "")")"
  [[ -n "${img}" && -n "${user}" && -n "${pass}" ]] \
    || { check "minio_restore" false "brak OPENSPG_MINIO_IMAGE/MINIO_ROOT_* w ${KAG_ENV}"; return; }
  # obiekt MinIO w formacie xl = katalog z plikiem xl.meta; .minio.sys to metadane serwera
  expected=$(tar --zstd -tf "${SNAP}/minio.tar.zst" 2>/dev/null | grep 'xl\.meta$' | grep -vc '\.minio\.sys' || true)
  if ! err=$(extract_archive "${SNAP}/minio.tar.zst" "${dir}" 2>&1); then
    check "minio_restore" false "rozpakowanie archiwum nie powiodło się: $(printf '%s' "${err}" | head -c 300)"
    return
  fi
  [[ -d "${dir}/minio/.minio.sys" ]] || { check "minio_restore" false "archiwum nie zawiera minio/.minio.sys (format nie do odtworzenia)"; return; }
  log "startuję efemeryczny MinIO z archiwum..."
  EPHEMERAL_CTRS+=("${ctr}")
  if ! docker run -d --name "${ctr}" --network none \
        -e MINIO_ROOT_USER="${user}" -e MINIO_ROOT_PASSWORD="${pass}" \
        -v "${dir}/minio:/data" "${img}" server /data >/dev/null 2>&1; then
    check "minio_restore" false "nie udało się uruchomić kontenera testowego (${img})"
    return
  fi
  local ready=false
  for i in $(seq 1 30); do
    if docker exec "${ctr}" curl -sf -m 3 http://127.0.0.1:9000/minio/health/live >/dev/null 2>&1; then ready=true; break; fi
    [[ "$(docker inspect -f '{{.State.Running}}' "${ctr}" 2>/dev/null)" == "true" ]] \
      || { check "minio_restore" false "kontener testowy padł: $(docker logs "${ctr}" 2>&1 | tail -n 3 | head -c 400)"; return; }
    sleep 2
  done
  [[ "${ready}" == "true" ]] || { check "minio_restore" false "MinIO nie wstał z archiwum w 60 s"; return; }
  # poświadczenia przez MC_HOST_* (env kontenera), nie w argv
  got=$(docker exec -e MC_HOST_v="http://${user}:${pass}@127.0.0.1:9000" "${ctr}" \
    sh -c 'mc ls --recursive v/ 2>/dev/null | wc -l' 2>/dev/null | tr -d '\r' || echo "")
  if [[ "${got}" =~ ^[0-9]+$ && "${got}" == "${expected}" ]]; then
    check "minio_restore" true "odczytano ${got} obiekt(ów) — zgodnie z archiwum"
  else
    check "minio_restore" false "obiektów w archiwum: ${expected}, odczytanych z odtworzonego MinIO: '${got}'"
  fi
  docker rm -f "${ctr}" >/dev/null 2>&1 || true
  rm -rf "${dir}"
}

# --- 7. Authentik: pg_dump wgrany do efemerycznego Postgresa + liczba użytkowników ---
verify_authentik_pg() {
  local ctr="kag-verify-pg-$$" img user db pw="verify-tmp-$$" i imp_err imp_rc users
  [[ -s "${SNAP}/authentik-pg.sql.zst" ]] || { check "authentik_pg_restore" false "brak dumpu authentik-pg.sql.zst"; return; }
  img="$(env_get "${EDGE_ENV}" POSTGRES_IMAGE "")"
  user="$(env_get "${EDGE_ENV}" AUTHENTIK_PG_USER "")"
  db="$(env_get "${EDGE_ENV}" AUTHENTIK_PG_DB "")"
  [[ -n "${img}" && -n "${user}" && -n "${db}" ]] \
    || { check "authentik_pg_restore" false "brak POSTGRES_IMAGE/AUTHENTIK_PG_USER/AUTHENTIK_PG_DB w ${EDGE_ENV}"; return; }
  log "startuję efemeryczny Postgres (${db})..."
  EPHEMERAL_CTRS+=("${ctr}")
  if ! docker run -d --name "${ctr}" --network none \
        -e POSTGRES_PASSWORD="${pw}" -e POSTGRES_USER="${user}" -e POSTGRES_DB="${db}" \
        "${img}" >/dev/null 2>&1; then
    check "authentik_pg_restore" false "nie udało się uruchomić kontenera testowego (${img})"
    return
  fi
  # jak w MySQL: entrypoint Postgresa najpierw stawia serwer tymczasowy z listen_addresses='',
  # więc gotowość sprawdzamy WYŁĄCZNIE po TCP — inaczej import trafiłby w okno inicjalizacji.
  local ready=false
  for i in $(seq 1 60); do
    if docker exec "${ctr}" pg_isready -h 127.0.0.1 -U "${user}" -d "${db}" >/dev/null 2>&1; then ready=true; break; fi
    [[ "$(docker inspect -f '{{.State.Running}}' "${ctr}" 2>/dev/null)" == "true" ]] \
      || { check "authentik_pg_restore" false "kontener testowy padł przed gotowością: $(docker logs "${ctr}" 2>&1 | tail -n 3 | head -c 400)"; return; }
    sleep 2
  done
  [[ "${ready}" == "true" ]] || { check "authentik_pg_restore" false "Postgres nie wstał (TCP) w 120 s"; return; }
  imp_err=$(zstd -dc "${SNAP}/authentik-pg.sql.zst" \
    | docker exec -i -e PGPASSWORD="${pw}" "${ctr}" \
        psql -h 127.0.0.1 -U "${user}" -d "${db}" -v ON_ERROR_STOP=1 -q 2>&1 >/dev/null) && imp_rc=0 || imp_rc=$?
  if [[ ${imp_rc} -ne 0 ]]; then
    check "authentik_pg_restore" false "import dumpu nie powiódł się (rc=${imp_rc}): $(printf '%s' "${imp_err}" | head -c 400)"
    return
  fi
  users=$(docker exec -e PGPASSWORD="${pw}" "${ctr}" \
    psql -h 127.0.0.1 -U "${user}" -d "${db}" -tAc 'SELECT COUNT(*) FROM authentik_core_user' 2>/dev/null | tr -d '\r ' || echo "")
  if [[ "${users}" =~ ^[0-9]+$ && ${users} -ge 1 ]]; then
    check "authentik_pg_restore" true "restore OK, użytkowników Authentika: ${users}"
  else
    check "authentik_pg_restore" false "restore przeszedł, ale zliczenie użytkowników dało: '${users}'"
  fi
  docker rm -f "${ctr}" >/dev/null 2>&1 || true
}

# --- 8. SQLite panelu: integralność PLIKU + warstwa APLIKACYJNA (migracje, rejestr KB, audyt) ---
#     Sam integrity_check nie wychwyci backupu, który jest technicznie poprawną, ale PUSTĄ
#     bazą (dokładnie to zdarzyło się 2026-09-03) ani zerwanego łańcucha audytu.
verify_sqlite() {
  local res dir="${WORK}/sqlite" tmp
  [[ -s "${SNAP}/panel.sqlite" ]] || { check "sqlite_integrity" false "brak kopii panel.sqlite"; return; }
  if docker image inspect kag-panel:local >/dev/null 2>&1; then
    mkdir -p "${dir}"
    cp "${SNAP}/panel.sqlite" "${dir}/panel.sqlite"
    chmod 755 "${dir}"; chmod 644 "${dir}/panel.sqlite"
    chown -R 10001:10001 "${dir}" 2>/dev/null || true
    res=$(docker run --rm --network none --entrypoint node -v "${dir}:/verify" kag-panel:local -e '
const Database = require("better-sqlite3");
const { verifyChain } = require("/app/packages/shared/dist/audit/verify.js");
const db = new Database("/verify/panel.sqlite", { readonly: true, fileMustExist: true });
const out = [];
out.push("integrity=" + db.pragma("integrity_check", { simple: true }));
const q = (sql, d) => { try { return db.prepare(sql).get(); } catch { return d; } };
out.push("migrations=" + (q("SELECT MAX(id) AS v FROM schema_migrations", { v: null }).v ?? "BRAK"));
out.push("kb_registry=" + (q("SELECT COUNT(*) AS v FROM kb_registry", { v: "BRAK" }).v));
out.push("users=" + (q("SELECT COUNT(*) AS v FROM users", { v: "BRAK" }).v));
const chain = verifyChain(db);
out.push("audit=" + (chain.valid ? "valid" : "BROKEN@" + chain.firstBrokenSeq) + "/" + chain.checked);
console.log(out.join(" "));
' 2>&1) || res="run-failed: ${res}"
    rm -rf "${dir}"
    if [[ "${res}" == integrity=ok\ * && "${res}" != *"=BRAK"* && "${res}" != *"audit=BROKEN"* ]]; then
      check "sqlite_app" true "${res}"
    else
      check "sqlite_app" false "${res:0:300}"
    fi
    return
  fi
  # fallback: brak obrazu panelu — zostaje sam integrity_check
  if command -v sqlite3 >/dev/null; then
    tmp=$(mktemp -d)
    cp "${SNAP}/panel.sqlite" "${tmp}/panel.sqlite"
    res=$(sqlite3 "${tmp}/panel.sqlite" "PRAGMA integrity_check;" 2>&1 || true)
    rm -rf "${tmp}"
    if [[ "${res}" == "ok" ]]; then
      check "sqlite_integrity" true "PRAGMA integrity_check = ok (brak obrazu kag-panel:local — bez kontroli warstwy aplikacyjnej)"
    else
      check "sqlite_integrity" false "integrity_check: ${res:0:200}"
    fi
  else
    check "sqlite_integrity" false "brak obrazu kag-panel:local i brak sqlite3 na hoście"
  fi
}
verify_sqlite

# --- 9. Nazwy artefaktów w runbookach i restore.sh muszą istnieć w snapshocie ---
#     Regresja po incydencie: runbook DR kazał instalować `panel.sqlite3` (plik nazywa się
#     `panel.sqlite`), więc odtworzenie „wg runbooka" zostawiało panel z pustą bazą.
verify_docs_artifacts() {
  local f names missing=() n
  names=$(grep -rhoE '\$\{?(SNAP|SNAPSHOT)\}?/[A-Za-z0-9._-]+|<SNAPSHOT>/[A-Za-z0-9._-]+' \
            "${REPO_ROOT}/docs/runbooks/" "${REPO_ROOT}/deploy/scripts/restore.sh" 2>/dev/null \
          | sed -E 's#.*/##' | sort -u || true)
  if [[ -z "${names}" ]]; then
    check "docs_artifacts" false "nie znaleziono ani jednej nazwy artefaktu w runbookach (zmienił się format?)"
    return
  fi
  while IFS= read -r n; do
    [[ -n "${n}" ]] || continue
    [[ -e "${SNAP}/${n}" ]] || missing+=("${n}")
  done <<< "${names}"
  if [[ ${#missing[@]} -eq 0 ]]; then
    check "docs_artifacts" true "wszystkie nazwy z runbooków obecne w snapshocie ($(printf '%s\n' "${names}" | wc -l))"
  else
    check "docs_artifacts" false "nazwy z runbooków nieobecne w snapshocie: ${missing[*]}"
  fi
}
verify_docs_artifacts

if [[ ${DEEP} -eq 1 ]]; then
  verify_neo4j
  verify_minio
  verify_authentik_pg
else
  log "--quick: pomijam odtworzenia Neo4j/MinIO/Postgres"
fi

# --- 10. Raport JSON ---
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

# --- 11. Status dla kokpitu panelu (WOLNY OD SEKRETÓW; obok backup-status.json).
#     Nazwa i kształt to kontrakt z `parseVerifyReport`/`readLatestVerifyReport`
#     w apps/panel-api/src/services/status.ts — {ok, checkedAt, failed:[nazwy checków]}.
STATUS_FILE="${DATA_ROOT}/kag/panel/backup-verify-status.json"
if [[ -d "${DATA_ROOT}/kag/panel" ]]; then
  {
    printf '{ "stamp": "%s", "checkedAt": "%s", "ok": %s, "snapshotStamp": "%s", "failed": [' \
      "${STAMP}" "$(date -Is)" "${ALL_OK}" "$(json_escape "$(basename "${SNAP}")")"
    first=1
    for c in "${CHECKS[@]}"; do
      IFS='|' read -r cname cok _ <<< "${c}"
      [[ "${cok}" == "true" ]] && continue
      [[ ${first} -eq 1 ]] || printf ', '
      first=0
      printf '"%s"' "$(json_escape "${cname}")"
    done
    printf '] }\n'
  } > "${STATUS_FILE}.tmp" && mv "${STATUS_FILE}.tmp" "${STATUS_FILE}"
  # 0600, nie 0644: plik należy do uid 10001, a panel działa na tym samym uid — szerszy
  # tryb niczego nie umożliwia, a łamie regułę „wszystko pod panel/ ma 0600” (D4-07).
  chmod 600 "${STATUS_FILE}"
  chown 10001:10001 "${STATUS_FILE}" 2>/dev/null || true
fi

if [[ "${ALL_OK}" != "true" ]]; then
  die "weryfikacja backupu NIE przeszła — szczegóły w ${REPORT}"
fi
# ping sukcesu (healthchecks/Kuma push) — cisza po drugiej stronie = alarm
PING_URL="${VERIFY_PING_URL:-${BACKUP_PING_URL:-}}"
if [[ -n "${PING_URL}" ]]; then
  curl -fsS -m 10 "${PING_URL}" >/dev/null || echo "[verify][UWAGA] ping sukcesu nie doszedł" >&2
fi
log "weryfikacja backupu przeszła"
