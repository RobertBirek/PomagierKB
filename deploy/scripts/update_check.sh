#!/usr/bin/env bash
# update_check.sh — porównuje digesty obrazów z deploy/{edge,kag}/.env z rejestrami.
# Narzędzie: skopeo inspect (fallback: docker buildx imagetools inspect). TYLKO raportuje —
# aktualizacja to świadoma operacja człowieka (backup -> podniesienie digestu w .env -> pull/up -> smoke).
# Konwencje:
#  - obraz "repo@sha256:..." — sprawdzany jest tag z zmiennej <NAZWA>_CHECK_TAG w .env,
#    a gdy jej nie ma: "latest";
#  - obraz "repo:tag" (bez digestu) — raport digestu do przypięcia;
#  - obrazy spg-registry.* (OpenSPG) = FROZEN: upstream zamrożony, wynik tylko informacyjny;
#  - obrazy *:local (build lokalny panel/mcp) — pomijane.
# Exit 0 (informacyjny); exit 1 tylko przy braku narzędzi/plików.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

env_get() { local v; v=$(grep -E "^$2=" "$1" 2>/dev/null | tail -n1 | cut -d= -f2-) || true; printf '%s' "${v:-${3:-}}"; }
log() { echo "[update_check] $*"; }
die() { echo "[update_check][BŁĄD] $*" >&2; exit 1; }

TOOL=""
if command -v skopeo >/dev/null; then
  TOOL="skopeo"
elif docker buildx version >/dev/null 2>&1; then
  TOOL="buildx"
else
  echo "[update-check][UWAGA] brak skopeo (apt install skopeo) i docker buildx — pomijam odpytanie rejestrów" >&2
  exit 0
fi
log "narzędzie: ${TOOL}"

# zdalny digest manifestu dla repo:tag (puste = błąd zapytania)
# Uwaga: najpierw przechwytujemy całe wyjście, dopiero potem parsujemy — wczesne zamknięcie
# potoku (awk/head) przy pipefail ubijało zapytanie SIGPIPE dla długich manifestów multi-arch.
resolve_remote_digest() {
  local ref=$1 out
  if [[ "${TOOL}" == "skopeo" ]]; then
    out=$(skopeo inspect --no-tags "docker://${ref}" 2>/dev/null) || return 1
    sed -nE 's/.*"Digest"[[:space:]]*:[[:space:]]*"(sha256:[a-f0-9]{64})".*/\1/p' <<< "${out}" | head -n1
  else
    out=$(docker buildx imagetools inspect "${ref}" 2>/dev/null) || return 1
    awk '/^Digest:/{print $2; exit}' <<< "${out}"
  fi
}

UPDATES=0; ERRORS=0; FROZEN_UPDATES=0

check_env_file() {
  local env_file=$1 line name value repo pinned tag remote frozen label
  if [[ ! -f "${env_file}" ]]; then
    log "UWAGA: brak ${env_file} — pomijam"
    return
  fi
  echo
  echo "== ${env_file} =="
  while IFS= read -r line; do
    name=${line%%=*}
    value=${line#*=}
    value=${value%%#*}                       # utnij komentarz w linii
    value=$(xargs <<< "${value}" || true)    # przytnij białe znaki
    [[ -n "${value}" ]] || continue
    [[ "${name}" == *_CHECK_TAG ]] && continue

    if [[ "${value}" == *:local ]]; then
      printf '  %-24s LOCAL     %s (build lokalny — pomijam)\n' "${name}" "${value}"
      continue
    fi

    frozen=0; label=""
    [[ "${value}" == spg-registry.* ]] && { frozen=1; label="FROZEN "; }

    if [[ "${value}" == *@sha256:* ]]; then
      repo=${value%%@*}
      pinned="sha256:${value##*@sha256:}"
      tag=$(env_get "${env_file}" "${name}_CHECK_TAG" latest)
      if ! remote=$(resolve_remote_digest "${repo}:${tag}") || [[ -z "${remote}" ]]; then
        printf '  %-24s BŁĄD      nie udało się odpytać rejestru o %s:%s\n' "${name}" "${repo}" "${tag}"
        ERRORS=$((ERRORS + 1))
        continue
      fi
      if [[ "${remote}" == "${pinned}" ]]; then
        printf '  %-24s %sOK        digest aktualny (tag %s)\n' "${name}" "${label}" "${tag}"
      elif [[ ${frozen} -eq 1 ]]; then
        # OpenSPG celowo zamrożony — tylko informacja, bez zalecenia aktualizacji
        printf '  %-24s FROZEN    informacyjnie: tag %s ma inny digest (%s) — NIE aktualizować bez pełnego snapshotu i testu\n' \
          "${name}" "${tag}" "${remote}"
        FROZEN_UPDATES=$((FROZEN_UPDATES + 1))
      else
        printf '  %-24s NOWY      nowy digest dostępny (tag %s): %s\n' "${name}" "${tag}" "${remote}"
        UPDATES=$((UPDATES + 1))
      fi
    elif [[ "${value}" == *:* ]]; then
      # tag bez digestu — zaraportuj digest do przypięcia
      if ! remote=$(resolve_remote_digest "${value}") || [[ -z "${remote}" ]]; then
        printf '  %-24s BŁĄD      nie udało się odpytać rejestru o %s\n' "${name}" "${value}"
        ERRORS=$((ERRORS + 1))
        continue
      fi
      printf '  %-24s NIEPRZYPIĘTY  tag %s = %s — przypnij digest w .env\n' "${name}" "${value}" "${remote}"
      UPDATES=$((UPDATES + 1))
    else
      printf '  %-24s UWAGA     nierozpoznany format: %s\n' "${name}" "${value}"
    fi
  done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*_IMAGE=' "${env_file}" || true)
}

for stack in edge kag; do
  ef="${REPO_ROOT}/deploy/${stack}/.env"
  if [[ ! -f "${ef}" && -f "${REPO_ROOT}/deploy/${stack}/.env.example" ]]; then
    log "UWAGA: brak ${ef} — sprawdzam .env.example (wartości przykładowe!)"
    ef="${REPO_ROOT}/deploy/${stack}/.env.example"
  fi
  check_env_file "${ef}"
done

echo
echo "----------------------------------------------"
echo "Podsumowanie: aktualizacje dostępne=${UPDATES}, FROZEN (informacyjnie)=${FROZEN_UPDATES}, błędy zapytań=${ERRORS}"
if [[ ${UPDATES} -gt 0 ]]; then
  echo "Procedura aktualizacji: backup.sh -> podnieś digest w .env -> docker compose pull && up -d -> smoke.sh"
fi
