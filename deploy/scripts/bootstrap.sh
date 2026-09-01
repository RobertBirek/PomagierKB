#!/usr/bin/env bash
# bootstrap.sh — przygotowanie hosta pod stacki edge+kag (PomagierKB).
# Wg docs/design/infra.md §7 pkt 2 + PLAN.md Faza 1.1. Idempotentny — można uruchamiać wielokrotnie.
# Robi: sieć edge-net, katalogi /srv/kag-data/* z uprawnieniami, swap 8G + vm.swappiness=10,
# tessdata (pol/eng/osd) dla Stirling OCR, kopie .env.example -> .env.
# Użycie: sudo ./bootstrap.sh   (env: DATA_ROOT, SWAPFILE — opcjonalne nadpisania)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DATA_ROOT="${DATA_ROOT:-/srv/kag-data}"
SWAPFILE="${SWAPFILE:-/swapfile}"
SWAP_SIZE_MB=8192   # 8G — profil RAM 24 GB (PLAN.md nadpisuje profil S z infra.md)
TESSDATA_BASE_URL="https://github.com/tesseract-ocr/tessdata_fast/raw/main"

log()  { echo "[bootstrap] $*"; }
warn() { echo "[bootstrap][UWAGA] $*" >&2; }
die()  { echo "[bootstrap][BŁĄD] $*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || die "uruchom jako root (sudo $0)"
command -v docker >/dev/null || die "brak dockera w PATH"
command -v curl   >/dev/null || die "brak curl (apt install curl)"
command -v zstd   >/dev/null || warn "brak zstd — wymagany przez backup.sh (apt install zstd)"

# --- 1. Sieć edge-net (external; wspólna dla Caddy, panelu, mcp i przyszłych appek) ---
if docker network inspect edge-net >/dev/null 2>&1; then
  log "sieć edge-net już istnieje"
else
  docker network create edge-net >/dev/null
  log "utworzono sieć edge-net"
fi

# --- 2. Katalogi danych z uprawnieniami (uid-y zgodne z obrazami) ---
# install -d jest idempotentny: ustawia właściciela/tryb także na istniejącym katalogu (nierekursywnie).
mkdir -p "${DATA_ROOT}"

# edge: Caddy (root w kontenerze), Postgres (postgres:16-alpine => uid 70; przy obrazie
# debianowym uid=999 — wtedy poprawić), Authentik (uid 1000).
install -d -m 755 -o 0 -g 0 \
  "${DATA_ROOT}/edge" "${DATA_ROOT}/edge/caddy" \
  "${DATA_ROOT}/edge/caddy/data" "${DATA_ROOT}/edge/caddy/config" \
  "${DATA_ROOT}/edge/authentik"
install -d -m 700 -o 70 -g 70 "${DATA_ROOT}/edge/authentik/postgres"
install -d -m 755 -o 1000 -g 1000 \
  "${DATA_ROOT}/edge/authentik/media" \
  "${DATA_ROOT}/edge/authentik/certs" \
  "${DATA_ROOT}/edge/authentik/custom-templates"
install -d -m 755 -o 0 -g 0 "${DATA_ROOT}/edge/kuma"   # Uptime Kuma (profil monitoring)

# kag: MariaDB (999), Neo4j (7474; obraz ma cap CHOWN), MinIO (root),
# Stirling tessdata (odczyt dla wszystkich), panel+mcp (uid 10001, dane 0700).
install -d -m 755 -o 0 -g 0 "${DATA_ROOT}/kag" "${DATA_ROOT}/kag/stirling"
install -d -m 700 -o 999 -g 999 "${DATA_ROOT}/kag/mysql"
install -d -m 755 -o 7474 -g 7474 "${DATA_ROOT}/kag/neo4j"
install -d -m 700 -o 7474 -g 7474 "${DATA_ROOT}/kag/neo4j/data" "${DATA_ROOT}/kag/neo4j/logs"
install -d -m 755 -o 7474 -g 7474 "${DATA_ROOT}/kag/neo4j/plugins" "${DATA_ROOT}/kag/neo4j/import"
install -d -m 700 -o 0 -g 0 "${DATA_ROOT}/kag/minio"
install -d -m 755 -o 0 -g 0 "${DATA_ROOT}/kag/stirling/tessdata"
install -d -m 700 -o 10001 -g 10001 \
  "${DATA_ROOT}/kag/panel" \
  "${DATA_ROOT}/kag/panel/db" "${DATA_ROOT}/kag/panel/inbox" \
  "${DATA_ROOT}/kag/panel/exports" "${DATA_ROOT}/kag/panel/audit" \
  "${DATA_ROOT}/kag/panel/backup-staging"
install -d -m 700 -o 0 -g 0 \
  "${DATA_ROOT}/backups" "${DATA_ROOT}/backups/nightly" "${DATA_ROOT}/backups/verify" \
  "${DATA_ROOT}/backups/images"
log "katalogi danych w ${DATA_ROOT} gotowe"

# --- 3. Swap 8G + vm.swappiness=10 (bezpiecznik OOM przy 24 GB RAM) ---
if grep -q "^${SWAPFILE} " /proc/swaps; then
  log "swap ${SWAPFILE} już aktywny"
else
  if [[ ! -f ${SWAPFILE} ]]; then
    log "tworzę plik swap ${SWAPFILE} (${SWAP_SIZE_MB} MB)..."
    if ! fallocate -l "${SWAP_SIZE_MB}M" "${SWAPFILE}" 2>/dev/null; then
      # fallocate nie działa np. na starych fs — fallback na dd
      dd if=/dev/zero of="${SWAPFILE}" bs=1M count="${SWAP_SIZE_MB}" status=none
    fi
    chmod 600 "${SWAPFILE}"
    mkswap "${SWAPFILE}" >/dev/null
  fi
  swapon "${SWAPFILE}"
  log "swap ${SWAPFILE} włączony"
fi
if ! grep -qE "^[^#]*${SWAPFILE}[[:space:]]" /etc/fstab; then
  echo "${SWAPFILE} none swap sw 0 0" >> /etc/fstab
  log "dodano wpis swap do /etc/fstab"
fi
SYSCTL_FILE=/etc/sysctl.d/99-kag.conf
if [[ ! -f ${SYSCTL_FILE} ]] || ! grep -q '^vm.swappiness=10$' "${SYSCTL_FILE}"; then
  printf '# PomagierKB: swap tylko jako bezpiecznik OOM\nvm.swappiness=10\n' > "${SYSCTL_FILE}"
  log "zapisano ${SYSCTL_FILE}"
fi
sysctl -q -p "${SYSCTL_FILE}"

# --- 4. Tesseract traineddata (pol/eng/osd) dla Stirling OCR — deterministycznie z tessdata_fast ---
for lang in pol eng osd; do
  dest="${DATA_ROOT}/kag/stirling/tessdata/${lang}.traineddata"
  if [[ -s ${dest} ]]; then
    log "tessdata: ${lang}.traineddata już jest"
    continue
  fi
  log "pobieram ${lang}.traineddata (tessdata_fast)..."
  curl -fsSL --retry 3 -o "${dest}.part" "${TESSDATA_BASE_URL}/${lang}.traineddata"
  [[ -s ${dest}.part ]] || die "pobrany ${lang}.traineddata jest pusty"
  mv "${dest}.part" "${dest}"
  chmod 644 "${dest}"
done

# --- 5. Pliki .env z szablonów (bez nadpisywania istniejących) ---
for stack in edge kag; do
  env_file="${REPO_ROOT}/deploy/${stack}/.env"
  example="${REPO_ROOT}/deploy/${stack}/.env.example"
  if [[ -f ${env_file} ]]; then
    log ".env stacka ${stack} już istnieje — nie ruszam"
  elif [[ -f ${example} ]]; then
    cp "${example}" "${env_file}"
    chmod 600 "${env_file}"
    warn "utworzono ${env_file} z szablonu (chmod 600 ustawiony) — UZUPEŁNIJ SEKRETY przed startem stacka"
  else
    warn "brak ${example} — pomijam tworzenie .env dla stacka ${stack}"
  fi
done

log "bootstrap zakończony. Dalej: wypełnij deploy/edge/.env i deploy/kag/.env, potem 'docker compose up -d' wg docs/deployment.md"
