#!/usr/bin/env bash
# update_check.sh — porównuje digesty obrazów z deploy/{edge,kag}/.env z rejestrami.
# Narzędzie: skopeo inspect (fallback: docker buildx imagetools inspect). TYLKO raportuje —
# aktualizacja to świadoma operacja człowieka (backup -> podniesienie digestu w .env -> pull/up -> smoke).
# Konwencje:
#  - obraz "repo@sha256:..." — porównywany z tagiem LINII WYDAŃ, z której pochodzi pin
#    (kolejność wyprowadzania tagu: patrz resolve_check_tag); gdy linii nie da się ustalić,
#    pozycja jest raportowana jako BRAK TAGU i NIE liczy się do "aktualizacje dostępne";
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

# data budowy obrazu (ISO8601) — tylko skopeo; puste gdy nieznana
resolve_created() {
  local ref=$1 out
  [[ "${TOOL}" == "skopeo" ]] || return 1
  out=$(skopeo inspect --no-tags "docker://${ref}" 2>/dev/null) || return 1
  sed -nE 's/.*"Created"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' <<< "${out}" | head -n1
}

# Tag linii wydań dla lokalnie obecnego obrazu o danym digeście (np. postgres@sha256:... ->
# "16-alpine"). Preferuje tag najkrótszy i różny od "latest" — czyli najbardziej "liniowy".
local_repo_tag() {
  local repo=$1 pinned=$2 tags t tagpart best=""
  command -v docker >/dev/null || return 1
  tags=$(docker image inspect -f '{{range .RepoTags}}{{println .}}{{end}}' "${repo}@${pinned}" 2>/dev/null) || return 1
  while read -r t; do
    [[ -n "${t}" && "${t}" != *@* && "${t}" == *:* ]] || continue   # pomiń referencje digestowe
    tagpart=${t##*:}
    [[ -n "${tagpart}" ]] || continue
    if [[ -z "${best}" ]]; then
      best=${tagpart}
    elif [[ "${best}" == "latest" && "${tagpart}" != "latest" ]]; then
      best=${tagpart}
    elif [[ "${tagpart}" != "latest" && ${#tagpart} -lt ${#best} ]]; then
      best=${tagpart}
    fi
  done <<< "${tags}"
  [[ -n "${best}" ]] || return 1
  printf '%s' "${best}"
}

# Tag do porównania z przypiętym digestem. Kolejność:
#  1) <NAZWA>_CHECK_TAG z .env — jawna intencja operatora;
#  2) tag lokalnego obrazu o TYM digeście (RepoTags) — faktyczna linia, z której wzięto pin;
#  3) dla obrazów FROZEN (spg-registry.*) — "latest" (wynik i tak tylko informacyjny).
# NIGDY nie zakładamy "latest" dla obrazów przypiętych do linii: to dawało fałszywe "NOWY"
# i sugerowało operatorowi skok majora (postgres 16->18, redis 7->8) albo wręcz DOWNGRADE
# (goauthentik/server:latest = 2025.2 przy pinie 2025.8) — patrz audyt D1-04/D11-04.
# Wypisuje "tag<TAB>źródło" (wołane w podstawieniu komendy, więc wynik NIE może iść
# przez zmienną globalną — podpowłoka jej nie propaguje).
resolve_check_tag() {
  local env_file=$1 name=$2 repo=$3 pinned=$4 frozen=$5 tag
  tag=$(env_get "${env_file}" "${name}_CHECK_TAG" "")
  if [[ -n "${tag}" ]]; then printf '%s\t%s' "${tag}" "${name}_CHECK_TAG"; return 0; fi
  if tag=$(local_repo_tag "${repo}" "${pinned}") && [[ -n "${tag}" ]]; then
    printf '%s\ttag obrazu lokalnego' "${tag}"; return 0
  fi
  if [[ ${frozen} -eq 1 ]]; then printf 'latest\tdomyślny dla FROZEN'; return 0; fi
  return 1
}

UPDATES=0; ERRORS=0; FROZEN_UPDATES=0; NOTAG=0; ANOMALIES=0

check_env_file() {
  local env_file=$1 line name value repo pinned tag remote frozen label src rcreated pcreated
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
      if ! src=$(resolve_check_tag "${env_file}" "${name}" "${repo}" "${pinned}" "${frozen}"); then
        printf '  %-24s BRAK TAGU nie ustalono linii wydań pinu — dopisz %s_CHECK_TAG do .env (np. =16-alpine)\n' \
          "${name}" "${name}"
        NOTAG=$((NOTAG + 1))
        continue
      fi
      tag=${src%%$'\t'*}
      src=${src#*$'\t'}
      if ! remote=$(resolve_remote_digest "${repo}:${tag}") || [[ -z "${remote}" ]]; then
        printf '  %-24s BŁĄD      nie udało się odpytać rejestru o %s:%s\n' "${name}" "${repo}" "${tag}"
        ERRORS=$((ERRORS + 1))
        continue
      fi
      if [[ "${remote}" == "${pinned}" ]]; then
        printf '  %-24s %sOK        digest aktualny (tag %s, źródło: %s)\n' "${name}" "${label}" "${tag}" "${src}"
      elif [[ ${frozen} -eq 1 ]]; then
        # OpenSPG celowo zamrożony — tylko informacja, bez zalecenia aktualizacji
        printf '  %-24s FROZEN    informacyjnie: tag %s ma inny digest (%s) — NIE aktualizować bez pełnego snapshotu i testu\n' \
          "${name}" "${tag}" "${remote}"
        FROZEN_UPDATES=$((FROZEN_UPDATES + 1))
      else
        # Sanity check: obraz spod tagu MUSI być nowszy niż pin. Starszy = zły tag linii
        # (albo cofnięty tag w rejestrze) — nigdy nie zalecamy takiej "aktualizacji".
        rcreated=$(resolve_created "${repo}:${tag}" 2>/dev/null || true)
        pcreated=$(resolve_created "${repo}@${pinned}" 2>/dev/null || true)
        if [[ -n "${rcreated}" && -n "${pcreated}" && "${rcreated}" < "${pcreated}" ]]; then
          printf '  %-24s ANOMALIA  tag %s (źródło: %s) wskazuje obraz STARSZY niż pin (%s < %s) — NIE aktualizować, popraw %s_CHECK_TAG\n' \
            "${name}" "${tag}" "${src}" "${rcreated}" "${pcreated}" "${name}"
          ANOMALIES=$((ANOMALIES + 1))
        else
          printf '  %-24s NOWY      nowy digest dostępny (tag %s, źródło: %s): %s\n' "${name}" "${tag}" "${src}" "${remote}"
          UPDATES=$((UPDATES + 1))
        fi
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

# Bez argumentów: oba stacki produkcyjne. Z argumentami: podane pliki .env
# (przydatne do testu na fixture bez dotykania produkcji).
if [[ $# -gt 0 ]]; then
  for ef in "$@"; do check_env_file "${ef}"; done
else
  for stack in edge kag; do
    ef="${REPO_ROOT}/deploy/${stack}/.env"
    if [[ ! -f "${ef}" && -f "${REPO_ROOT}/deploy/${stack}/.env.example" ]]; then
      log "UWAGA: brak ${ef} — sprawdzam .env.example (wartości przykładowe!)"
      ef="${REPO_ROOT}/deploy/${stack}/.env.example"
    fi
    check_env_file "${ef}"
  done
fi

echo
echo "----------------------------------------------"
echo "Podsumowanie: aktualizacje dostępne=${UPDATES}, FROZEN (informacyjnie)=${FROZEN_UPDATES}, bez tagu linii=${NOTAG}, anomalie=${ANOMALIES}, błędy zapytań=${ERRORS}"
if [[ ${NOTAG} -gt 0 ]]; then
  echo "BRAK TAGU: dopisz <NAZWA>_IMAGE_CHECK_TAG do .env (wzorce w .env.example) — bez tego nie da się"
  echo "  odróżnić aktualizacji w obrębie linii od skoku na inną linię wydań."
fi
if [[ ${ANOMALIES} -gt 0 ]]; then
  echo "ANOMALIA: tag linii wskazuje obraz starszy niż pin — to zwykle zły *_CHECK_TAG. NIE aktualizować."
fi
if [[ ${UPDATES} -gt 0 ]]; then
  echo "Procedura aktualizacji: backup.sh -> podnieś digest w .env -> docker compose pull && up -d -> smoke.sh"
  echo "UWAGA: procedura dotyczy WYŁĄCZNIE aktualizacji w obrębie tej samej linii wydań."
  echo "  Zmiana majora (np. postgres 16->18, redis 7->8, authentik 2025.8->2026.x) = osobny runbook:"
  echo "  release notes + migracja katalogu danych + test odtworzenia z backupu."
fi
