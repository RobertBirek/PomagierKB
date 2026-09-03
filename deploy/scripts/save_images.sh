#!/usr/bin/env bash
# save_images.sh — archiwum `docker save` wszystkich obrazów obu stacków do
# ${DATA_ROOT}/backups/images/. DR nie może zależeć od dostępności rejestrów
# (obrazy OpenSPG żyją w spg-registry.us-west-1.cr.aliyuncs.com). Skip gdy digest
# już zapisany; stare wersje tego samego repo sprzątane (zostaje najnowsza).
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# env_get ucina komentarz inline (wartość "obraz@sha  # nota" -> "obraz@sha") i białe znaki.
env_get() { local v; v=$(grep -E "^$2=" "$1" 2>/dev/null | tail -n1 | cut -d= -f2-) || true; v=${v%%[[:space:]]#*}; v="${v%"${v##*[![:space:]]}"}"; printf '%s' "${v:-${3:-}}"; }
DATA_ROOT="${DATA_ROOT:-$(env_get "${REPO_ROOT}/deploy/kag/.env" DATA_ROOT /srv/kag-data)}"
OUT="${DATA_ROOT}/backups/images"

log() { echo "[save-images] $*"; }
die() { echo "[save-images][BŁĄD] $*" >&2; exit 1; }
[[ ${EUID} -eq 0 ]] || die "uruchom jako root"
command -v docker >/dev/null || die "brak dockera"
command -v zstd >/dev/null || die "brak zstd"
mkdir -p "${OUT}"

# Obrazy z obu stacków (compose config rozwiązuje zmienne z .env)
images=$(for stack in edge kag; do
  docker compose -f "${REPO_ROOT}/deploy/${stack}/compose.yaml" config --images 2>/dev/null
done | sort -u)
[[ -n "${images}" ]] || die "compose config --images nie zwrócił obrazów (brak .env?)"

failed=0
while IFS= read -r img; do
  [[ -n "${img}" ]] || continue
  digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "${img}" 2>/dev/null | sed 's/.*@sha256://' | cut -c1-16)
  if [[ -z "${digest}" ]]; then
    # obraz budowany lokalnie (kag-panel:local itp.) — id zamiast digestu
    digest=$(docker image inspect --format '{{.Id}}' "${img}" 2>/dev/null | sed 's/sha256://' | cut -c1-16)
  fi
  if [[ -z "${digest}" ]]; then
    log "POMIJAM ${img} — obraz nie jest pobrany lokalnie"
    continue
  fi
  safe=$(printf '%s' "${img}" | tr '/:@' '___')
  f="${OUT}/${safe}@${digest}.tar.zst"
  if [[ -s "${f}" ]]; then
    log "aktualny: ${img} (${digest})"
  else
    log "zapisuję ${img} -> ${f}"
    if docker save "${img}" | zstd -q -o "${f}.tmp" && mv "${f}.tmp" "${f}"; then
      # sprzątnij starsze archiwa tego samego repo (inny digest)
      find "${OUT}" -maxdepth 1 -name "${safe}@*.tar.zst" ! -name "$(basename "${f}")" -delete
    else
      rm -f "${f}.tmp"; echo "[save-images][UWAGA] zapis ${img} nie powiódł się" >&2; failed=1
    fi
  fi
done <<< "${images}"

ls -la "${OUT}" | tail -n +2
[[ ${failed} -eq 0 ]] || die "część obrazów nie została zapisana"
log "gotowe: ${OUT}"
