#!/usr/bin/env bash
# selfcheck.sh — cykliczny test dymny + kontrola dryfu, uruchamiany na HOŚCIE.
#
# Dlaczego nie w CI: `smoke.sh` sprawdza zdrowie przez `docker exec` na konkretnych
# kontenerach, a `drift_check.sh` porównuje działające kontenery, sieci i porty z plikami
# `.env`, których w repozytorium nie ma. Runner GitHuba nie ma żadnej z tych rzeczy, więc
# uruchomiony tam obydwa skrypty wypluwałyby FAIL-e bez związku ze zmianą — czyli dokładnie
# ten rodzaj szumu, przez który 42 czerwone przebiegi CI przeżyły bez reakcji. W CI została
# bramka statyczna (składnia, shellcheck, bit wykonywalności), a wykonanie jest tutaj.
#
# Oba skrypty biegną ZAWSZE, nawet gdy pierwszy padnie: alert ma nieść komplet obrazu, a nie
# pierwszy napotkany objaw. Kod wyjścia != 0, gdy którykolwiek zawiódł — resztą zajmuje się
# `OnFailure=kag-alert@` w jednostce systemd.
#
# Użycie: selfcheck.sh [--quiet]
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

QUIET=0
[[ "${1:-}" == "--quiet" ]] && QUIET=1
log() { [[ ${QUIET} -eq 1 ]] || echo "[selfcheck] $*"; }

declare -a FAILED=()

run_check() { # run_check <nazwa> <ścieżka skryptu>
  local name="$1" script="$2" rc=0 out
  if [[ ! -x "${script}" ]]; then
    echo "[selfcheck][BŁĄD] ${name}: brak lub nie-wykonywalny ${script}" >&2
    FAILED+=("${name}")
    return
  fi
  log "── ${name} ──"
  # Wynik idzie do journala w całości: przy alercie o 4 nad ranem liczy się to, co skrypt
  # napisał, a nie sam kod wyjścia.
  out="$("${script}" 2>&1)" || rc=$?
  printf '%s\n' "${out}"
  if [[ ${rc} -ne 0 ]]; then
    echo "[selfcheck][BŁĄD] ${name}: exit ${rc}" >&2
    FAILED+=("${name}")
  fi
}

run_check smoke       "${SCRIPT_DIR}/smoke.sh"
run_check drift_check "${SCRIPT_DIR}/drift_check.sh"

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "[selfcheck][BŁĄD] nie przeszły: ${FAILED[*]}" >&2
  exit 1
fi
log "wszystko przeszło: smoke + drift_check"
