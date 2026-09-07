#!/usr/bin/env bash
# backup.sh — nocny snapshot stacków edge+kag (PomagierKB), wg docs/design/infra.md §5.
# Zbiera: dump MySQL OpenSPG (w kontenerze, hasło przez env — nie w argv), tar.zst neo4j/minio,
# kopię online SQLite panelu (better-sqlite3 backup API, fallback sqlite3 CLI), pg_dump Authentika,
# certy Caddy, audyt panelu, pliki panelu, kopie obu .env (0600), stan repo + compose ps;
# pisze SHA256SUMS i _manifest.json. Retencja: 14 dni + pierwszy KOMPLETNY snapshot miesiąca
# trzymany 6 mies.
# Użycie: backup.sh [--cold-neo4j]   (zimny snapshot neo4j: stop -> tar -> start; comiesięczne okno)
# Env: DATA_ROOT (domyślnie z deploy/kag/.env lub /srv/kag-data),
#      BACKUP_OFFSITE_TARGET — puste = warning w manifeście; "rclone://remote:ścieżka" albo cel
#      rsync (np. user@host:/sciezka), PANEL_DB_IN_CONTAINER (domyślnie /data/db/kag.db),
#      BACKUP_PING_URL — opcjonalny ping sukcesu (healthchecks/Kuma push), wołany TYLKO przy ok,
#      BACKUP_AGE_RECIPIENT / BACKUP_GPG_RECIPIENT — klucz PUBLICZNY odbiorcy kopii off-site;
#      BACKUP_OFFSITE_ALLOW_PLAINTEXT=true — świadome (odradzane) wyłączenie szyfrowania off-site.
# Kontrakt: brak KTÓREGOKOLWIEK z artefaktów wymaganych (mysql, neo4j, minio, panel.sqlite,
# authentik-pg) => ok:false w manifeście i exit 1 (fail-loudly — cichy sukces to incydent
# z 2026-09-03, gdy literówka nazwy pliku zostawiła panel bez backupu przez dobę).
#
# SEKRETY: snapshot zawiera komplet materiału do przejęcia systemu (oba .env, dump MySQL
# z kluczami LLM, klucze prywatne certów Caddy). Lokalnie chroni go 0700/root + 0600 na plikach;
# poza host wychodzi WYŁĄCZNIE zaszyfrowany (age/gpg) — patrz sekcja 11. `docker compose config`
# NIE trafia już do snapshotu (renderował te same sekrety drugi raz i był odtwarzalny z .env
# + SHA commitu — zapisujemy więc repo-state.txt zamiast niego).
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
# Parametry retencji i off-site pochodzą z PANELU (/settings ➜ strona /backup), który
# zapisuje je do ${DATA_ROOT}/kag/panel/backup-config.json. Panel jest źródłem prawdy dla
# rzeczy NIESEKRETNYCH; sekrety (cel rclone, klucz age, URL-e push-monitorów) zostają
# w /etc/kag/alerts.env i panel ich nie widzi. Kolejność pierwszeństwa:
#   zmienna środowiskowa  >  plik z panelu  >  wartość domyślna.
# Brak pliku, uszkodzony JSON albo bzdurna wartość = wartość domyślna, nigdy błąd:
# backup ma się wykonać nawet wtedy, gdy panel leży.
PANEL_CONFIG="${DATA_ROOT}/kag/panel/backup-config.json"
cfg_get() { # cfg_get <klucz> <domyślna>
  local v=""
  if [[ -f "${PANEL_CONFIG}" ]] && command -v jq >/dev/null 2>&1; then
    v="$(jq -r --arg k "$1" '.[$k] // empty' "${PANEL_CONFIG}" 2>/dev/null)" || v=""
  fi
  printf '%s' "${v:-$2}"
}
cfg_int() { # cfg_int <klucz> <domyślna> <min> <max>
  local v; v="$(cfg_get "$1" "$2")"
  [[ "${v}" =~ ^[0-9]+$ ]] && [[ ${v} -ge $3 ]] && [[ ${v} -le $4 ]] || v="$2"
  printf '%s' "${v}"
}
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-$(cfg_int retentionDays 14 2 365)}"
MONTHLY_RETENTION_MONTHS="${BACKUP_MONTHLY_MONTHS:-$(cfg_int monthlyRetentionMonths 6 0 120)}"
MONTHLY_KEEP_DAYS=$(( MONTHLY_RETENTION_MONTHS * 31 ))   # pierwszy snapshot miesiąca
OFFSITE_ENABLED="$(cfg_get offsiteEnabled true)"
COLD_NEO4J_ENABLED="$(cfg_get coldNeo4jEnabled true)"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
SNAP="${BACKUP_ROOT}/${STAMP}"
PANEL_DB_IN_CONTAINER="${PANEL_DB_IN_CONTAINER:-/data/db/kag.db}"
NEO4J_SERVICE="${NEO4J_SERVICE:-neo4j}"
NEO4J_CONTAINER="${NEO4J_CONTAINER:-release-openspg-neo4j}"
COLD_NEO4J=0
[[ "${1:-}" == "--cold-neo4j" ]] && COLD_NEO4J=1
# Zimny snapshot zatrzymuje Neo4j — jeśli operator wyłączył to w panelu, comiesięczny
# timer ma zrobić kopię GORĄCĄ, a nie nie zrobić żadnej.
if [[ ${COLD_NEO4J} -eq 1 && "${COLD_NEO4J_ENABLED}" != "true" ]]; then
  COLD_NEO4J=0
  warn "zimny snapshot Neo4j wyłączony w konfiguracji panelu — robię snapshot gorący"
fi

# Artefakty WYMAGANE — bez któregokolwiek snapshot jest niekompletny (ok:false, exit 1).
# Ta sama lista rządzi promocją snapshotu miesięcznego (sekcja 13) i jest kontraktem dla
# deploy/scripts/restore.sh oraz docs/runbooks/disaster-recovery.md — nie zmieniaj nazw
# bez równoczesnej aktualizacji tamtych dwóch miejsc.
REQUIRED_ARTIFACTS=(mysql.sql.zst neo4j-data.tar.zst minio.tar.zst panel.sqlite authentik-pg.sql.zst)

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
NEO4J_CHECKPOINT="skipped"
BUILDS_RUNNING="null"

# 2a. Ile buildów trwa w chwili backupu? Hot-tar zrobiony w trakcie zapisów do store'a
#     jest najtrudniejszym przypadkiem odtworzenia — zapisujemy to w manifeście, żeby przy
#     odtwarzaniu było wiadomo, czy sięgać po snapshot zimny.
count_builds_running() {
  ctr_running kag-panel || return 0
  local n
  n=$(docker exec kag-panel node -e '
const db = require("better-sqlite3")(process.argv[1], { readonly: true, fileMustExist: true });
const r = db.prepare("SELECT COUNT(*) AS c FROM build_jobs WHERE status IN (?,?,?)").get("INIT", "WAITING", "RUNNING");
process.stdout.write(String(r.c));
' "${PANEL_DB_IN_CONTAINER}" 2>/dev/null) || return 0
  [[ "${n}" =~ ^[0-9]+$ ]] || return 0
  BUILDS_RUNNING="${n}"
  [[ ${n} -eq 0 ]] || warn "w trakcie backupu trwa ${n} build job(ów) — hot-tar grafu jest tym samym mniej pewny"
}
count_builds_running

# 2b. Checkpoint przed hot-tarem: Neo4j robi checkpoint co ~15 min, więc tar bez wymuszenia
#     łapie store files sprzed nawet kwadransa + tx-logi do odtworzenia. `CALL db.checkpoint()`
#     zrzuciłoby strony na dysk dla KAŻDEJ bazy, ale procedura jest w Neo4j 5 wyłącznie
#     enterprise'owa i w używanym buildzie DozerDB NIE ISTNIEJE (sprawdzone: `SHOW PROCEDURES`
#     nie zna żadnej procedury `*checkpoint*`). Dlatego: próbujemy, a gdy procedury nie ma —
#     zapisujemy to WPROST w manifeście (`neo4jCheckpoint: unavailable`) zamiast udawać, że
#     hot-tar jest spójny. Gwarancję punktu odtworzenia daje wtedy comiesięczny snapshot
#     `cold` + cotygodniowy `verify_backup.sh` (check `neo4j_restore` realnie startuje bazę
#     z archiwum). Best-effort: nic tutaj nie może wywrócić backupu.
neo4j_checkpoint() {
  local dbs db rc=0 have
  ctr_running "${NEO4J_CONTAINER}" || { NEO4J_CHECKPOINT="skipped: kontener ${NEO4J_CONTAINER} nie działa"; return 0; }
  have=$(docker exec "${NEO4J_CONTAINER}" sh -c \
    'NEO4J_USERNAME="$OPENSPG_NEO4J_USER" NEO4J_PASSWORD="$OPENSPG_NEO4J_PASSWORD" exec cypher-shell --format plain "SHOW PROCEDURES YIELD name WHERE name = '"'"'db.checkpoint'"'"' RETURN count(*)"' \
    2>/dev/null | tail -n1 | tr -d '"\r ') || have=""
  if [[ "${have}" != "1" ]]; then
    NEO4J_CHECKPOINT="unavailable: brak procedury db.checkpoint w tym buildzie Neo4j"
    warn "hot-tar grafu bez wymuszonego checkpointu (procedura db.checkpoint niedostępna) — punkt spójności daje snapshot --cold-neo4j"
    return 0
  fi
  dbs=$(docker exec "${NEO4J_CONTAINER}" sh -c \
    'NEO4J_USERNAME="$OPENSPG_NEO4J_USER" NEO4J_PASSWORD="$OPENSPG_NEO4J_PASSWORD" exec cypher-shell -d system --format plain "SHOW DATABASES YIELD name RETURN DISTINCT name"' \
    2>/dev/null | tail -n +2 | tr -d '"' | tr -d '\r') || dbs=""
  if [[ -z "${dbs}" ]]; then
    NEO4J_CHECKPOINT="failed: nie udało się wylistować baz (cypher-shell)"
    warn "checkpoint neo4j pominięty — cypher-shell nie zwrócił listy baz"
    return 0
  fi
  while IFS= read -r db; do
    [[ -n "${db}" ]] || continue
    docker exec -e CDB="${db}" "${NEO4J_CONTAINER}" sh -c \
      'NEO4J_USERNAME="$OPENSPG_NEO4J_USER" NEO4J_PASSWORD="$OPENSPG_NEO4J_PASSWORD" exec cypher-shell -d "$CDB" "CALL db.checkpoint()"' \
      >/dev/null 2>&1 || { rc=1; warn "checkpoint bazy neo4j '${db}' nie powiódł się"; }
  done <<< "${dbs}"
  if [[ ${rc} -eq 0 ]]; then
    NEO4J_CHECKPOINT="ok"
    log "checkpoint neo4j wykonany dla baz: $(echo "${dbs}" | tr '\n' ' ')"
  else
    NEO4J_CHECKPOINT="partial"
  fi
}

if [[ -d "${DATA_ROOT}/kag/neo4j/data" ]]; then
  if [[ ${COLD_NEO4J} -eq 1 ]]; then
    NEO4J_CHECKPOINT="n/a (cold)"
    NEO4J_MODE="cold"
    log "zimny snapshot neo4j: zatrzymuję usługę ${NEO4J_SERVICE}..."
    docker compose -f "${REPO_ROOT}/deploy/kag/compose.yaml" stop "${NEO4J_SERVICE}"
    # gwarancja ponownego startu nawet przy błędzie tar
    trap 'docker compose -f "${REPO_ROOT}/deploy/kag/compose.yaml" start "${NEO4J_SERVICE}" || true' EXIT
  else
    neo4j_checkpoint
  fi
  log "archiwizuję neo4j/data (${NEO4J_MODE}, checkpoint: ${NEO4J_CHECKPOINT})..."
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
      # kopia powstaje w kontenerze jako 10001:10001 0644 — w snapshocie ma być root:root 0600
      # (zawiera zapieczętowane klucze LLM, hashe kluczy MCP i cały audyt).
      chown root:root "${SNAP}/panel.sqlite" 2>/dev/null || true
      chmod 600 "${SNAP}/panel.sqlite"
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

# --- 6b. Uptime Kuma (monitoring: konto admina, monitory, powiadomienia, historia, pliki) ---
# Konfiguracja Kumy żyje WYŁĄCZNIE w tym SQLite. Bez niego odtworzenie hosta przywraca
# platformę i zostawia monitoring pusty — czyli stan sprzed ustalenia D10-01, w którym
# cicha awaria backupu była niewidoczna. `deploy/scripts/kuma_seed_monitors.sh` odtworzy
# same monitory, ale nie konto admina ani historii; ten artefakt odtwarza wszystko.
#
# Katalogi z plikami wymienione są JAWNIE, a nie brane hurtem — do archiwum nie mogą trafić
# `kuma.db-wal`/`-shm` (dokleiłyby się do spójnej kopii bazy przy odtworzeniu i cofnęły ją
# do stanu sprzed `.backup`) ani katalog roboczy tego skryptu. Skutek uboczny listy jest
# taki, że nowy podkatalog Kumy trzeba tu dopisać ręcznie — dlatego stoi w jednym miejscu.
# `docker-tls/` (certy klienckie do monitorów typu „Docker host") świadomie POZA listą:
# jest pusty, a wpuszczenie kluczy prywatnych do snapshotu chcemy mieć jako decyzję,
# nie jako efekt uboczny. Dopisz go, gdy zaczniesz monitorować hosty dockerowe po TLS.
KUMA_FILE_DIRS=(upload screenshots)
backup_kuma() {
  local dir="${DATA_ROOT}/edge/kuma"
  local staging="${dir}/.backup-staging"
  [[ -f "${dir}/kuma.db" ]] || { warn "brak ${dir}/kuma.db — pomijam Uptime Kumę"; return 0; }
  rm -rf "${staging}"; mkdir -p "${staging}"

  # `.backup` sqlite3, nie `cp`: Kuma dopisuje heartbeaty co kilkanaście sekund, więc zwykła
  # kopia łapie bazę w połowie transakcji i daje plik, który wygląda poprawnie aż do pierwszej
  # próby odczytu. Na hoście nie ma binarki sqlite3 — jest w obrazie Kumy, i stamtąd ją bierzemy.
  local image ok=0
  image="$(docker inspect edge-uptime-kuma --format '{{.Config.Image}}' 2>/dev/null)" || image=""
  if ctr_running edge-uptime-kuma; then
    docker exec edge-uptime-kuma sqlite3 /app/data/kuma.db ".backup '/app/data/.backup-staging/kuma.db'" && ok=1
  elif [[ -n "${image}" ]]; then
    # Kuma zatrzymana — ten sam obraz jednorazowo, bez sieci (czyta wyłącznie plik).
    docker run --rm --network none -v "${dir}:/data" --entrypoint sh "${image}" \
      -c 'sqlite3 /data/kuma.db ".backup '"'"'/data/.backup-staging/kuma.db'"'"'"' && ok=1
  else
    warn "Uptime Kuma nie działa i nie znam jej obrazu — pomijam monitoring"
  fi

  if [[ ${ok} -eq 1 && -s "${staging}/kuma.db" ]]; then
    # db-config.json mówi Kumie 2.x, którego backendu użyć; bez niego po odtworzeniu
    # wraca kreator wyboru bazy, mimo że baza jest na miejscu.
    [[ -f "${dir}/db-config.json" ]] && cp "${dir}/db-config.json" "${staging}/db-config.json"
    # Pliki wrzucone przez użytkownika (ikony monitorów, zrzuty stron) dokładamy PROSTO
    # z katalogu danych — nie ma sensu ich kopiować dwa razy. Brakujący katalog wypada
    # z listy zamiast wywalić tar-a.
    local extra=() d
    for d in "${KUMA_FILE_DIRS[@]}"; do
      [[ -d "${dir}/${d}" ]] && extra+=(-C "${dir}" "${d}")
    done
    if tar --zstd -cf "${SNAP}/kuma.tar.zst" -C "${staging}" . "${extra[@]+"${extra[@]}"}"; then
      chmod 600 "${SNAP}/kuma.tar.zst"
    else
      rm -f "${SNAP}/kuma.tar.zst"
      warn "archiwizacja bazy Uptime Kumy nie powiodła się"
    fi
  else
    warn "spójna kopia bazy Uptime Kumy nie powiodła się — monitoring NIE jest w tym snapshocie"
  fi
  rm -rf "${staging}"
}
backup_kuma

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

# --- 9. Stan repo i stacków.
#        `docker compose config` NIE trafia do snapshotu: renderował wszystkie sekrety z .env
#        po raz drugi (hasła w URL-ach CLOUDEXT_*), a jest w pełni odtwarzalny z pary
#        (SHA commitu + .env). Zamiast niego: repo-state.txt + surowe compose.yaml (bez
#        sekretów) + `compose ps` (nazwy/statusy/porty). Odtworzenie: git checkout <sha>,
#        .env z snapshotu, `docker compose config` na miejscu.
{
  printf 'repo=%s\n' "${REPO_ROOT}"
  printf 'commit=%s\n' "$(git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null || echo unknown)"
  printf 'branch=%s\n' "$(git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  printf 'describe=%s\n' "$(git -C "${REPO_ROOT}" describe --always --dirty 2>/dev/null || echo unknown)"
  printf 'dirtyFiles=%s\n' "$(git -C "${REPO_ROOT}" status --porcelain 2>/dev/null | wc -l)"
  printf 'createdAt=%s\n' "$(date -Is)"
} > "${SNAP}/repo-state.txt" 2>/dev/null || warn "nie udało się zapisać repo-state.txt"

for stack in edge kag; do
  cf="${REPO_ROOT}/deploy/${stack}/compose.yaml"
  if [[ -f "${cf}" ]]; then
    cp "${cf}" "${SNAP}/${stack}-compose.yaml" || warn "kopia compose.yaml stacka ${stack} nie powiodła się"
    docker compose -f "${cf}" ps > "${SNAP}/${stack}-compose.ps.txt" 2>/dev/null \
      || rm -f "${SNAP}/${stack}-compose.ps.txt"
  else
    warn "brak ${cf}"
  fi
  # sprzątanie po starszych snapshotach tego samego biegu (gdyby ktoś przywrócił stary skrypt)
  rm -f "${SNAP}/${stack}-compose.config.yaml"
done

# --- 10. Sumy kontrolne ---
# najpierw domykamy tryby: nic w snapshocie nie może być czytelne poza rootem
find "${SNAP}" -maxdepth 1 -type f -exec chmod 600 {} +
( cd "${SNAP}" && find . -maxdepth 1 -type f ! -name SHA256SUMS ! -name _manifest.json -printf '%P\n' \
    | sort | xargs -r sha256sum > SHA256SUMS )

# --- 11. Off-site.
#     Snapshot to komplet sekretów (.env obu stacków, dump MySQL z kluczami LLM, klucze
#     prywatne certów). Lokalnie broni go 0700/root; poza hostem NIE MA takiej ochrony,
#     więc off-site wychodzi wyłącznie jako JEDEN zaszyfrowany plik: <STAMP>.tar.age
#     (age -r <klucz publiczny>) albo <STAMP>.tar.gpg (gpg --encrypt -r). Klucz PRYWATNY
#     nigdy nie mieszka na tym hoście — trzymaj go w menedżerze haseł operatora.
#     Fail-closed: cel off-site bez skonfigurowanego odbiorcy = BRAK wysyłki
#     (status blocked_no_encryption), chyba że operator świadomie ustawi
#     BACKUP_OFFSITE_ALLOW_PLAINTEXT=true (odradzane — zostaje trwałe ostrzeżenie w manifeście).
OFFSITE_TARGET="${BACKUP_OFFSITE_TARGET:-}"
OFFSITE_STATUS="not_configured"
OFFSITE_ENC="none"
OFFSITE_ARTIFACT=""

encrypt_snapshot() { # encrypt_snapshot <plik-wyjściowy> ; szyfruje CAŁY katalog snapshotu
  local out=$1 r
  if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
    command -v age >/dev/null || { warn "BACKUP_AGE_RECIPIENT ustawiony, ale brak binarki age"; return 1; }
    local args=()
    for r in ${BACKUP_AGE_RECIPIENT//,/ }; do args+=(-r "${r}"); done
    tar -C "${BACKUP_ROOT}" -cf - "${STAMP}" | age "${args[@]}" -o "${out}"
    return $?
  fi
  if [[ -n "${BACKUP_GPG_RECIPIENT:-}" ]]; then
    command -v gpg >/dev/null || { warn "BACKUP_GPG_RECIPIENT ustawiony, ale brak binarki gpg"; return 1; }
    local gargs=()
    for r in ${BACKUP_GPG_RECIPIENT//,/ }; do gargs+=(--recipient "${r}"); done
    tar -C "${BACKUP_ROOT}" -cf - "${STAMP}" \
      | gpg --batch --yes --trust-model always --encrypt "${gargs[@]}" --output "${out}"
    return $?
  fi
  return 1
}

offsite_put_file() { # offsite_put_file <plik-lokalny> <nazwa-w-celu>
  if [[ "${OFFSITE_TARGET}" == rclone://* ]]; then
    rclone copyto "$1" "${OFFSITE_TARGET#rclone://}/$2"
  else
    rsync -a "$1" "${OFFSITE_TARGET}/$2"
  fi
}

offsite_put_dir() { # offsite_put_dir <katalog-snapshotu> — tylko tryb plaintext (odradzany)
  if [[ "${OFFSITE_TARGET}" == rclone://* ]]; then
    rclone copy "$1" "${OFFSITE_TARGET#rclone://}/${STAMP}"
  else
    rsync -a "$1" "${OFFSITE_TARGET}/"
  fi
}

if [[ "${OFFSITE_ENABLED}" != "true" ]]; then
  OFFSITE_STATUS="disabled"
  warn "kopia off-site WYŁĄCZONA w konfiguracji panelu — snapshot zostaje wyłącznie na tym dysku"
elif [[ -z "${OFFSITE_TARGET}" ]]; then
  warn "BACKUP_OFFSITE_TARGET pusty — brak kopii off-site (parametr do wypełnienia)"
elif [[ -z "${BACKUP_AGE_RECIPIENT:-}" && -z "${BACKUP_GPG_RECIPIENT:-}" ]]; then
  if [[ "${BACKUP_OFFSITE_ALLOW_PLAINTEXT:-}" == "true" ]]; then
    OFFSITE_ENC="plaintext"
    warn "off-site BEZ SZYFROWANIA (BACKUP_OFFSITE_ALLOW_PLAINTEXT=true) — sekrety obu stacków opuszczają host jawnym tekstem"
    log "wysyłam snapshot off-site (jawnie): ${OFFSITE_TARGET}"
    if offsite_put_dir "${SNAP}"; then OFFSITE_STATUS="ok"; OFFSITE_ARTIFACT="${STAMP}/"; else OFFSITE_STATUS="failed"; warn "wysyłka off-site nie powiodła się"; fi
  else
    OFFSITE_STATUS="blocked_no_encryption"
    warn "off-site ZABLOKOWANY: ustaw BACKUP_AGE_RECIPIENT lub BACKUP_GPG_RECIPIENT (klucz publiczny odbiorcy) — snapshot zawiera komplet sekretów"
  fi
else
  if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then OFFSITE_ENC="age"; else OFFSITE_ENC="gpg"; fi
  ENC_NAME="${STAMP}.tar.${OFFSITE_ENC}"
  ENC_FILE="${BACKUP_ROOT}/.offsite-${ENC_NAME}"
  log "szyfruję snapshot (${OFFSITE_ENC}) do wysyłki off-site..."
  if encrypt_snapshot "${ENC_FILE}" && [[ -s "${ENC_FILE}" ]]; then
    chmod 600 "${ENC_FILE}"
    log "wysyłam snapshot off-site: ${OFFSITE_TARGET}"
    if offsite_put_file "${ENC_FILE}" "${ENC_NAME}"; then
      OFFSITE_STATUS="ok"
      OFFSITE_ARTIFACT="${ENC_NAME}"
    else
      OFFSITE_STATUS="failed"; warn "wysyłka off-site nie powiodła się"
    fi
  else
    OFFSITE_STATUS="failed"; warn "szyfrowanie snapshotu do wysyłki off-site nie powiodło się"
  fi
  rm -f "${ENC_FILE}"
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
  printf '  "neo4jCheckpoint": "%s",\n' "$(json_escape "${NEO4J_CHECKPOINT}")"
  printf '  "buildsRunning": %s,\n' "${BUILDS_RUNNING}"
  printf '  "coreArtifacts": %s,\n' "${CORE_COUNT}"
  printf '  "requiredArtifacts": ['
  first=1
  for a in "${REQUIRED_ARTIFACTS[@]}"; do
    [[ ${first} -eq 1 ]] || printf ', '
    first=0
    printf '"%s"' "${a}"
  done
  printf '],\n'
  printf '  "missingRequired": ['
  first=1
  for m in "${MISSING_REQUIRED[@]+"${MISSING_REQUIRED[@]}"}"; do
    [[ ${first} -eq 1 ]] || printf ', '
    first=0
    printf '"%s"' "$(json_escape "${m}")"
  done
  printf '],\n'
  printf '  "offsite": { "target": "%s", "status": "%s", "encryption": "%s", "artifact": "%s" },\n' \
    "$(json_escape "${OFFSITE_TARGET}")" "${OFFSITE_STATUS}" "${OFFSITE_ENC}" "$(json_escape "${OFFSITE_ARTIFACT}")"
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

# Manifest (wolny od sekretów: nazwy plików, rozmiary, sumy, ostrzeżenia) dosyłamy off-site
# obok zaszyfrowanego archiwum — pozwala sprawdzić kompletność bez odszyfrowywania.
if [[ "${OFFSITE_STATUS}" == "ok" ]]; then
  if [[ "${OFFSITE_ENC}" == "plaintext" ]]; then
    offsite_put_dir "${SNAP}" || true
  else
    offsite_put_file "${SNAP}/_manifest.json" "${STAMP}._manifest.json" || true
  fi
fi

# --- 13. Retencja: 14 dni nightly; pierwszy KOMPLETNY snapshot miesiąca trzymany ~6 mies. ---
#
# Wcześniej regułą był „najstarszy katalog miesiąca po nazwie" — promowało to na 186 dni
# snapshot wadliwy (2026-09-03_032613 nie zawierał panel.sqlite, a miał ok:true ze starego
# kontraktu). Kandydatem na kopię miesięczną może być wyłącznie snapshot KOMPLETNY:
# manifest z ok:true, komplet REQUIRED_ARTIFACTS oraz każdy plik z SHA256SUMS obecny
# i niepusty. Wśród kompletnych preferujemy zimny (neo4jMode: cold) — daje gwarantowany
# punkt spójności grafu. Miesiąc bez ani jednego kompletnego snapshotu NIE dostaje kopii
# miesięcznej (fail-loudly: promowanie wadliwego to fałszywe poczucie bezpieczeństwa).

# snapshot_complete <katalog> — 0 gdy snapshot nadaje się na kopię miesięczną
snapshot_complete() {
  local d=$1 f name
  [[ -f "${d}/_manifest.json" ]] || return 1
  grep -qE '"ok"[[:space:]]*:[[:space:]]*true' "${d}/_manifest.json" || return 1
  for f in "${REQUIRED_ARTIFACTS[@]}"; do
    [[ -s "${d}/${f}" ]] || return 1
  done
  [[ -f "${d}/SHA256SUMS" ]] || return 1
  while read -r _ name; do
    [[ -n "${name}" ]] || continue
    [[ -s "${d}/${name}" ]] || return 1
  done < "${d}/SHA256SUMS"
  return 0
}

snapshot_is_cold() { grep -qE '"neo4jMode"[[:space:]]*:[[:space:]]*"cold"' "$1/_manifest.json" 2>/dev/null; }

prune_snapshots() {
  local now dir name month ts age
  now=$(date +%s)
  declare -A month_keep=() month_cold=() month_any=() month_seen=()
  # kandydaci miesięczni: pierwszy kompletny zimny, w drugiej kolejności pierwszy kompletny
  while IFS= read -r name; do
    dir="${BACKUP_ROOT}/${name}"
    month=${name:0:7}
    month_seen[${month}]=1
    snapshot_complete "${dir}" || continue
    [[ -n "${month_any[${month}]:-}" ]] || month_any[${month}]=${name}
    if snapshot_is_cold "${dir}" && [[ -z "${month_cold[${month}]:-}" ]]; then
      month_cold[${month}]=${name}
    fi
  done < <(find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d -printf '%P\n' \
             | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}$' | sort)
  for month in "${!month_seen[@]}"; do
    if [[ -n "${month_cold[${month}]:-}" ]]; then
      month_keep[${month}]=${month_cold[${month}]}
    elif [[ -n "${month_any[${month}]:-}" ]]; then
      month_keep[${month}]=${month_any[${month}]}
    else
      warn "retencja: miesiąc ${month} nie ma ANI JEDNEGO kompletnego snapshotu — brak kopii miesięcznej"
    fi
  done

  while IFS= read -r name; do
    dir="${BACKUP_ROOT}/${name}"
    ts=$(date -d "${name:0:10}" +%s 2>/dev/null) || continue
    age=$(( (now - ts) / 86400 ))
    if [[ ${age} -le ${RETENTION_DAYS} ]]; then continue; fi
    month=${name:0:7}
    if [[ "${month_keep[${month}]:-}" == "${name}" && ${age} -le ${MONTHLY_KEEP_DAYS} ]]; then
      continue   # miesięczny snapshot zostaje
    fi
    log "retencja: usuwam stary snapshot ${name} (wiek ${age} dni)"
    rm -rf "${dir}"
  done < <(find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d -printf '%P\n' \
             | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}$' | sort)
}
prune_snapshots

cat "${SNAP}/_manifest.json"
# Status dla kokpitu panelu (WOLNY OD SEKRETÓW; /data/backup-status.json w kontenerze):
# sonda backup-freshness w services/status.ts czyta stamp/ok/coreArtifacts.
STATUS_FILE="${DATA_ROOT}/kag/panel/backup-status.json"
{
  printf '{ "stamp": "%s", "createdAt": "%s", "ok": %s, "coreArtifacts": %s, "missingRequired": [' \
    "${STAMP}" "$(date -Is)" "${OK}" "${CORE_COUNT}"
  first=1
  for m in "${MISSING_REQUIRED[@]+"${MISSING_REQUIRED[@]}"}"; do
    [[ ${first} -eq 1 ]] || printf ', '
    first=0
    printf '"%s"' "$(json_escape "${m}")"
  done
  printf '] }\n'
} > "${STATUS_FILE}.tmp" && mv "${STATUS_FILE}.tmp" "${STATUS_FILE}"
chmod 644 "${STATUS_FILE}"
chown 10001:10001 "${STATUS_FILE}" 2>/dev/null || true

# Stan dla strony /backup — świadomie PRZED `die`, żeby panel zobaczył także bieg
# nieudany. Awaria publikacji nie może wywrócić samego backupu, więc tylko ostrzegamy.
"${REPO_ROOT}/deploy/scripts/backup_state.sh" --quiet || warn "nie udało się opublikować stanu dla panelu"

if [[ "${OK}" != "true" ]]; then
  die "snapshot NIEKOMPLETNY — brakuje artefaktów wymaganych: ${MISSING_REQUIRED[*]:-brak żadnego}"
fi
# ping sukcesu (healthchecks/Kuma push) — cisza po drugiej stronie = alarm
if [[ -n "${BACKUP_PING_URL:-}" ]]; then
  curl -fsS -m 10 "${BACKUP_PING_URL}" >/dev/null || warn "ping sukcesu nie doszedł"
fi
log "backup zakończony: ${SNAP}"
