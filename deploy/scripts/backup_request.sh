#!/usr/bin/env bash
# backup_request.sh — obsługuje żądanie biegu backupu złożone przez panel.
#
# Dlaczego akurat plik-znacznik: panel działa w kontenerze jako uid 10001, bez socketu
# dockera i bez dostępu do systemd. Żeby dać administratorowi przycisk „zrób backup teraz",
# trzeba było przekroczyć tę granicę — i jedynym akceptowalnym sposobem było przekroczenie
# jej NAJWĘŻSZYM możliwym kanałem. Panel zapisuje plik z jednym polem `kind`, którego
# dziedzina ma DWA elementy. Nie ma tu polecenia do wykonania, argumentów, ścieżek ani
# nazw jednostek — host czyta enum i sam decyduje, co uruchomić. Najgorsze, co daje
# przejęcie tej ścieżki, to wymuszony backup albo weryfikacja.
#
# Podnoszone przez `kag-backup-request.path` (PathExists), które uzbraja się ponownie,
# gdy plik zniknie — dlatego znacznik kasujemy ZAWSZE i jako pierwszą czynność.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KAG_ENV="${REPO_ROOT}/deploy/kag/.env"
env_get() { local v; v=$(grep -E "^$2=" "$1" 2>/dev/null | tail -n1 | cut -d= -f2-) || true; v=${v%%[[:space:]]#*}; v="${v%"${v##*[![:space:]]}"}"; printf '%s' "${v:-${3:-}}"; }

DATA_ROOT="${DATA_ROOT:-$(env_get "${KAG_ENV}" DATA_ROOT /srv/kag-data)}"
REQUEST_FILE="${DATA_ROOT}/kag/panel/backup-request.json"
# Znacznik starszy niż to okno ignorujemy. Chroni przed jednym konkretnym scenariuszem:
# odtworzeniem katalogu danych panelu z backupu, w którym leżał niezobsłużony znacznik —
# bez tego odtworzenie hosta wyzwalałoby backup w losowym momencie.
MAX_AGE_SECONDS=300

log()  { echo "[backup-request] $*"; }
warn() { echo "[backup-request][UWAGA] $*" >&2; }

[[ -f "${REQUEST_FILE}" ]] || { log "brak znacznika — nic do zrobienia"; exit 0; }

payload="$(head -c 4096 "${REQUEST_FILE}" 2>/dev/null)" || payload=""
# Kasujemy natychmiast: jednostka .path uzbraja się dopiero po zniknięciu pliku, więc
# znacznik zostawiony po błędzie zablokowałby wszystkie kolejne żądania.
rm -f "${REQUEST_FILE}"

kind="$(printf '%s' "${payload}" | jq -r '.kind // empty' 2>/dev/null)" || kind=""
requested_at="$(printf '%s' "${payload}" | jq -r '.requestedAt // empty' 2>/dev/null)" || requested_at=""
request_id="$(printf '%s' "${payload}" | jq -r '.requestId // empty' 2>/dev/null)" || request_id=""

case "${kind}" in
  backup) unit="kag-backup.service" ;;
  verify) unit="kag-backup-verify.service" ;;
  *) warn "nieznany rodzaj żądania: '${kind}' — ignoruję"; exit 0 ;;
esac

if [[ -n "${requested_at}" ]]; then
  ts="$(date -d "${requested_at}" +%s 2>/dev/null)" || ts=""
  if [[ -n "${ts}" ]]; then
    age=$(( $(date +%s) - ts ))
    if [[ ${age} -gt ${MAX_AGE_SECONDS} || ${age} -lt -60 ]]; then
      warn "znacznik z ${requested_at} (wiek ${age} s) poza oknem ${MAX_AGE_SECONDS} s — ignoruję"
      exit 0
    fi
  fi
fi

if systemctl is-active --quiet "${unit}"; then
  warn "${unit} już działa — nie uruchamiam drugi raz (żądanie ${request_id:-bez id})"
  exit 0
fi

log "żądanie ${request_id:-bez id} (${kind}) → uruchamiam ${unit}"
# --no-block: `kag-backup.service` biegnie kilka minut, a `kag-backup-verify.service`
# nawet kilkanaście — nie ma sensu blokować jednostki obsługującej znacznik na ten czas.
systemctl start --no-block "${unit}"
