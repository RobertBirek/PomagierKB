#!/usr/bin/env bash
# restore.sh — odtworzenie stanu PomagierKB ze snapshotu `backup.sh`.
# Kod zamiast prozy: runbook DR podawał nazwy plików z pamięci i 7 z nich było błędnych
# (m.in. `panel.sqlite3` zamiast `panel.sqlite` → panel wstawał z PUSTĄ bazą i raportował
# sukces). Ten skrypt jest jedynym źródłem prawdy o nazwach artefaktów i ścieżkach docelowych;
# `docs/runbooks/disaster-recovery.md` go wywołuje, a `verify_backup.sh` sprawdza, że
# wymienione tu nazwy naprawdę istnieją w snapshocie.
#
# Użycie:
#   restore.sh --snapshot <katalog> --all [--yes]
#   restore.sh --snapshot <katalog> --only neo4j,minio,panel-sqlite [--yes]
#   restore.sh --snapshot <katalog> --all --dry-run      # tylko wypisz plan
#
# Komponenty (--only):
#   env            kopie .env obu stacków -> /kag/deploy/{edge,kag}/.env         (0600)
#   caddy          caddy-data.tar.zst     -> ${DATA_ROOT}/edge/caddy/data        (certy LE)
#   authentik-pg   authentik-pg.sql.zst   -> działający kontener edge-postgres
#   neo4j          neo4j-data.tar.zst     -> ${DATA_ROOT}/kag/neo4j/data         (kontener STOP)
#   minio          minio.tar.zst          -> ${DATA_ROOT}/kag/minio              (kontener STOP)
#   panel-sqlite   panel.sqlite           -> ${DATA_ROOT}/kag/panel/db/kag.db    (kontener STOP)
#   panel-files    panel-files.tar.zst    -> ${DATA_ROOT}/kag/panel/{uploads,exports,inbox,actions,mcp-usage}
#   panel-audit    panel-audit.tar.zst    -> ${DATA_ROOT}/kag/panel/audit
#   mysql          mysql.sql.zst          -> działający kontener release-openspg-mysql
#   images         ${DATA_ROOT}/backups/images/*.tar.zst -> docker load
#
# Kolejność przy --all jest obowiązkowa: images, env, caddy, neo4j, minio, panel-*,
# authentik-pg, mysql. Wolumeny datastores przywracaj PRZED pierwszym startem ich kontenerów;
# dumpy SQL — do kontenerów już działających.
#
# Bezpieczniki: wymaga roota; weryfikuje SHA256SUMS; odmawia pracy na snapshocie z ok:false
# (chyba że --force); odmawia nadpisania katalogu, którego kontener DZIAŁA; istniejące dane
# odsuwa na bok jako <katalog>.pre-restore-<stamp> zamiast kasować.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
EDGE_ENV="${REPO_ROOT}/deploy/edge/.env"
KAG_ENV="${REPO_ROOT}/deploy/kag/.env"

env_get() { local v; v=$(grep -E "^$2=" "$1" 2>/dev/null | tail -n1 | cut -d= -f2-) || true; v=${v%%[[:space:]]#*}; v="${v%"${v##*[![:space:]]}"}"; printf '%s' "${v:-${3:-}}"; }

DATA_ROOT="${DATA_ROOT:-$(env_get "${KAG_ENV}" DATA_ROOT /srv/kag-data)}"
IMAGES_DIR="${IMAGES_DIR:-${DATA_ROOT}/backups/images}"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
PANEL_UID=10001
PANEL_GID=10001

SNAP=""
DRY=0
FORCE=0
ASSUME_YES=0
COMPONENTS=()
ALL_COMPONENTS=(images env caddy neo4j minio panel-sqlite panel-files panel-audit authentik-pg mysql)

log()  { echo "[restore] $*"; }
warn() { echo "[restore][UWAGA] $*" >&2; }
die()  { echo "[restore][BŁĄD] $*" >&2; exit 1; }
run()  { if [[ ${DRY} -eq 1 ]]; then echo "[restore][dry-run] $*"; else eval "$@"; fi; }
ctr_running() { [[ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" == "true" ]]; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --snapshot) SNAP="${2:?podaj katalog snapshotu}"; shift 2 ;;
    --only)     IFS=',' read -r -a COMPONENTS <<< "${2:?podaj listę komponentów}"; shift 2 ;;
    --all)      COMPONENTS=("${ALL_COMPONENTS[@]}"); shift ;;
    --dry-run)  DRY=1; shift ;;
    --force)    FORCE=1; shift ;;
    --yes|-y)   ASSUME_YES=1; shift ;;
    -h|--help)  sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)          die "nieznany argument: $1 (użyj --help)" ;;
  esac
done

[[ ${EUID} -eq 0 ]] || die "uruchom jako root"
command -v docker >/dev/null || die "brak dockera"
command -v zstd   >/dev/null || die "brak zstd (apt install zstd)"
[[ -n "${SNAP}" && -d "${SNAP}" ]] || die "podaj istniejący --snapshot <katalog>"
[[ ${#COMPONENTS[@]} -gt 0 ]] || die "podaj --all albo --only <lista> (patrz --help)"

for c in "${COMPONENTS[@]}"; do
  [[ " ${ALL_COMPONENTS[*]} " == *" ${c} "* ]] || die "nieznany komponent: ${c}"
done
wanted() { [[ " ${COMPONENTS[*]} " == *" $1 "* ]]; }

# --- Preflight: kompletność i spójność snapshotu ---
log "snapshot: ${SNAP}"
if [[ -f "${SNAP}/_manifest.json" ]]; then
  if grep -qE '"ok"[[:space:]]*:[[:space:]]*true' "${SNAP}/_manifest.json"; then
    log "manifest: ok:true"
  elif [[ ${FORCE} -eq 1 ]]; then
    warn "manifest ma ok:false — kontynuuję na żądanie (--force)"
  else
    die "manifest ma ok:false — snapshot NIEKOMPLETNY (użyj --force, jeśli świadomie odtwarzasz część)"
  fi
  grep -E '"(stamp|neo4jMode|neo4jCheckpoint|buildsRunning|coreArtifacts)"' "${SNAP}/_manifest.json" || true
else
  [[ ${FORCE} -eq 1 ]] || die "brak ${SNAP}/_manifest.json (użyj --force, jeśli wiesz co robisz)"
fi
if [[ -f "${SNAP}/SHA256SUMS" ]]; then
  if ( cd "${SNAP}" && sha256sum -c --quiet SHA256SUMS ) >/dev/null 2>&1; then
    log "SHA256SUMS: wszystkie sumy zgodne"
  else
    [[ ${FORCE} -eq 1 ]] || die "SHA256SUMS NIE zgadzają się — snapshot uszkodzony (przerywam)"
    warn "SHA256SUMS niezgodne — kontynuuję na żądanie (--force)"
  fi
else
  warn "brak SHA256SUMS w snapshocie"
fi

need_file() { [[ -s "${SNAP}/$1" ]] || die "brak artefaktu ${SNAP}/$1 — sprawdź nazwy w _manifest.json"; }

if [[ ${DRY} -eq 0 && ${ASSUME_YES} -eq 0 ]]; then
  echo "[restore] ODTWARZAM: ${COMPONENTS[*]}"
  echo "[restore] cel: ${DATA_ROOT} (istniejące dane trafią do *.pre-restore-${STAMP})"
  read -r -p "[restore] Kontynuować? wpisz TAK: " answer
  [[ "${answer}" == "TAK" ]] || die "przerwane przez operatora"
fi

# stash_dir <katalog> — odsuwa istniejące dane zamiast je kasować
stash_dir() {
  local d=$1
  [[ -e "${d}" ]] || return 0
  if [[ -z "$(ls -A "${d}" 2>/dev/null)" ]]; then return 0; fi
  log "odsuwam istniejące ${d} -> ${d}.pre-restore-${STAMP}"
  run "mv '${d}' '${d}.pre-restore-${STAMP}'"
}

# require_stopped <kontener> — restore wolumenu przy działającym kontenerze = rozjazd stanu
require_stopped() {
  ctr_running "$1" || return 0
  [[ ${DRY} -eq 1 ]] || die "kontener $1 DZIAŁA — zatrzymaj go przed odtwarzaniem (docker compose stop) i spróbuj ponownie"
  warn "[dry-run] kontener $1 DZIAŁA — w prawdziwym biegu skrypt by tu przerwał"
}

require_running() {
  ctr_running "$1" && return 0
  [[ ${DRY} -eq 1 ]] || die "kontener $1 nie działa — wystartuj go przed importem dumpu"
  warn "[dry-run] kontener $1 nie działa — w prawdziwym biegu skrypt by tu przerwał"
}

# ============================ komponenty ============================

restore_images() {
  [[ -d "${IMAGES_DIR}" ]] || { warn "brak ${IMAGES_DIR} — pomijam docker load"; return 0; }
  local f n=0
  for f in "${IMAGES_DIR}"/*.tar.zst; do
    [[ -e "${f}" ]] || { warn "brak archiwów obrazów w ${IMAGES_DIR}"; return 0; }
    log "docker load < $(basename "${f}")"
    run "zstd -dc '${f}' | docker load"
    n=$((n + 1))
  done
  log "załadowano archiwów obrazów: ${n}"
}

restore_env() {
  need_file env-edge.env
  need_file env-kag.env
  log "przywracam .env obu stacków (KRYTYCZNE: sekrety muszą pochodzić z TEGO snapshotu)"
  run "install -o root -g root -m 600 '${SNAP}/env-edge.env' '${EDGE_ENV}'"
  run "install -o root -g root -m 600 '${SNAP}/env-kag.env'  '${KAG_ENV}'"
}

restore_caddy() {
  [[ -s "${SNAP}/caddy-data.tar.zst" ]] || { warn "brak caddy-data.tar.zst — pomijam certy"; return 0; }
  require_stopped edge-caddy
  stash_dir "${DATA_ROOT}/edge/caddy/data"
  run "mkdir -p '${DATA_ROOT}/edge/caddy'"
  log "przywracam certy Caddy -> ${DATA_ROOT}/edge/caddy/data"
  run "zstd -dc '${SNAP}/caddy-data.tar.zst' | tar -C '${DATA_ROOT}/edge/caddy' -x"
}

restore_neo4j() {
  need_file neo4j-data.tar.zst
  require_stopped release-openspg-neo4j
  stash_dir "${DATA_ROOT}/kag/neo4j/data"
  run "mkdir -p '${DATA_ROOT}/kag/neo4j'"
  log "przywracam graf -> ${DATA_ROOT}/kag/neo4j/data (archiwum zawiera katalog 'data/')"
  run "zstd -dc '${SNAP}/neo4j-data.tar.zst' | tar -C '${DATA_ROOT}/kag/neo4j' -x"
}

restore_minio() {
  need_file minio.tar.zst
  require_stopped release-openspg-minio
  stash_dir "${DATA_ROOT}/kag/minio"
  run "mkdir -p '${DATA_ROOT}/kag'"
  log "przywracam MinIO -> ${DATA_ROOT}/kag/minio (archiwum zawiera katalog 'minio/')"
  run "zstd -dc '${SNAP}/minio.tar.zst' | tar -C '${DATA_ROOT}/kag' -x"
}

restore_panel_sqlite() {
  need_file panel.sqlite
  require_stopped kag-panel
  require_stopped kag-mcp
  local dst="${DATA_ROOT}/kag/panel/db/kag.db"
  # NAZWA PLIKU DOCELOWEGO JEST KRYTYCZNA: panel czyta ${DATA_DIR}/db/kag.db. Każda inna
  # nazwa = panel tworzy pustą bazę przy starcie (migracje) i raportuje sukces.
  run "mkdir -p '${DATA_ROOT}/kag/panel/db'"
  if [[ -f "${dst}" ]]; then
    log "odsuwam istniejącą bazę panelu -> ${dst}.pre-restore-${STAMP}"
    run "mv '${dst}' '${dst}.pre-restore-${STAMP}'"
  fi
  # WAL/SHM po starej bazie muszą zniknąć, inaczej SQLite dosklei je do nowego pliku
  run "rm -f '${dst}-wal' '${dst}-shm'"
  log "przywracam bazę panelu -> ${dst}"
  run "install -o ${PANEL_UID} -g ${PANEL_GID} -m 600 '${SNAP}/panel.sqlite' '${dst}'"
}

restore_panel_files() {
  [[ -s "${SNAP}/panel-files.tar.zst" ]] || { warn "brak panel-files.tar.zst — bloby/eksporty NIE wrócą"; return 0; }
  require_stopped kag-panel
  log "przywracam pliki panelu (uploads/exports/inbox/actions/mcp-usage) -> ${DATA_ROOT}/kag/panel"
  run "mkdir -p '${DATA_ROOT}/kag/panel'"
  run "zstd -dc '${SNAP}/panel-files.tar.zst' | tar -C '${DATA_ROOT}/kag/panel' -x"
  run "chown -R ${PANEL_UID}:${PANEL_GID} '${DATA_ROOT}/kag/panel'"
}

restore_panel_audit() {
  [[ -s "${SNAP}/panel-audit.tar.zst" ]] || { warn "brak panel-audit.tar.zst — pomijam audyt JSONL"; return 0; }
  require_stopped kag-panel
  log "przywracam audyt JSONL -> ${DATA_ROOT}/kag/panel/audit"
  run "mkdir -p '${DATA_ROOT}/kag/panel'"
  run "zstd -dc '${SNAP}/panel-audit.tar.zst' | tar -C '${DATA_ROOT}/kag/panel' -x"
  run "chown -R ${PANEL_UID}:${PANEL_GID} '${DATA_ROOT}/kag/panel/audit'"
}

restore_authentik_pg() {
  need_file authentik-pg.sql.zst
  require_running edge-postgres
  log "czekam na gotowość edge-postgres (TCP)..."
  local i ok=0
  for i in $(seq 1 60); do
    if [[ ${DRY} -eq 1 ]]; then ok=1; break; fi
    if docker exec edge-postgres sh -c 'pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  [[ ${ok} -eq 1 ]] || die "edge-postgres nie odpowiada po TCP w 120 s"
  log "importuję pg_dump Authentika (dump nie zawiera CREATE DATABASE — baza z compose)"
  run "zstd -dc '${SNAP}/authentik-pg.sql.zst' | docker exec -i edge-postgres sh -c 'exec psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\"'"
}

restore_mysql() {
  need_file mysql.sql.zst
  require_running release-openspg-mysql
  # Sonda MUSI iść po TCP: entrypoint MariaDB uruchamia najpierw serwer tymczasowy
  # z --skip-networking i wykonuje na nim własne skrypty init. Import w tym oknie kończy się
  # `ERROR 1050 Table 'kg_app' already exists` i ubiciem kontenera (lekcja z verify_backup.sh).
  log "czekam na gotowość release-openspg-mysql (TCP, serwer finalny)..."
  local i ok=0
  for i in $(seq 1 90); do
    if [[ ${DRY} -eq 1 ]]; then ok=1; break; fi
    if docker exec release-openspg-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -h127.0.0.1 --protocol=tcp -uroot -N -e "SELECT 1"' >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  [[ ${ok} -eq 1 ]] || die "release-openspg-mysql nie odpowiada po TCP w 180 s"
  log "importuję dump MySQL (--databases: zawiera CREATE DATABASE, hasło przez MYSQL_PWD)"
  run "zstd -dc '${SNAP}/mysql.sql.zst' | docker exec -i release-openspg-mysql sh -c 'MYSQL_PWD=\"\$MYSQL_ROOT_PASSWORD\" exec mysql -h127.0.0.1 --protocol=tcp -uroot'"
}

# ============================ przebieg ============================

for c in "${ALL_COMPONENTS[@]}"; do
  wanted "${c}" || continue
  case "${c}" in
    images)       restore_images ;;
    env)          restore_env ;;
    caddy)        restore_caddy ;;
    neo4j)        restore_neo4j ;;
    minio)        restore_minio ;;
    panel-sqlite) restore_panel_sqlite ;;
    panel-files)  restore_panel_files ;;
    panel-audit)  restore_panel_audit ;;
    authentik-pg) restore_authentik_pg ;;
    mysql)        restore_mysql ;;
  esac
done

log "gotowe: ${COMPONENTS[*]}"
if [[ ${DRY} -eq 0 ]]; then
  cat <<EOF
[restore] DALEJ:
  1. wystartuj stacki: docker compose -f ${REPO_ROOT}/deploy/edge/compose.yaml up -d
                       docker compose -f ${REPO_ROOT}/deploy/kag/compose.yaml up -d
  2. smoke:            ${REPO_ROOT}/deploy/scripts/smoke.sh
  3. weryfikacja ręczna wg docs/runbooks/disaster-recovery.md §4
  4. katalogi *.pre-restore-${STAMP} usuń dopiero po potwierdzeniu, że system działa
EOF
fi
