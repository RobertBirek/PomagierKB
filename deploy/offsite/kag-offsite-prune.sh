#!/usr/bin/env bash
# kag-offsite-prune.sh — strona ODBIORCY kopii off-site PomagierKB (host pomagier), uruchamiany jako root
# z timera co godzinę. Trzy zadania:
#   1. ZAMROŻENIE: każdy kompletny blob <STAMP>.tar.age i sidecar <STAMP>._manifest.json starszy niż
#      FREEZE_AFTER_MIN dostaje chattr +i — od tej chwili nawet użytkownik kagbackup (klucz pim,
#      rrsync -wo -no-del -no-overwrite) ani błąd po stronie pim nie zmieni kopii.
#   2. RETENCJA: zostaje KEEP_DAILY najnowszych kompletów + najstarszy komplet każdego z ostatnich
#      KEEP_MONTHS miesięcy kalendarzowych; nigdy mniej niż MIN_KEEP kompletów. Gdy wolne < LOW_FREE_GB,
#      najstarsze komplety lecą aż do MIN_KEEP (dysk pomagiera dzielą inne usługi).
#      Kasowanie = najpierw chattr -i, potem rm; bloby bez sidecara starsze niż ORPHAN_HOURS też lecą
#      (przerwana wysyłka). Wynik w logu.
#   3. DEAD-MAN'S SWITCH: gdy najnowszy komplet ma < MAX_AGE_HOURS, blob >= MIN_BYTES i sha256 zgadza się
#      z sidecarem (archiveSha256) → ping OFFSITE_PING_URL (Uptime Kuma na pim). Cisza = alarm tam.
# Sekrety: URL pingu wyłącznie z /etc/kag/offsite.env (0600). Blobów NIE odszyfrowujemy — klucza age tu nie ma.
set -euo pipefail
DIR="${OFFSITE_DIR:-/backups/pim/nightly}"
ENV_FILE="${OFFSITE_ENV:-/etc/kag/offsite.env}"
LOG="${OFFSITE_LOG:-/var/log/kag-offsite.log}"
KEEP_DAILY="${KEEP_DAILY:-5}"; KEEP_MONTHS="${KEEP_MONTHS:-2}"; MIN_KEEP="${MIN_KEEP:-2}"
# Bezpiecznik miejsca: gdy wolne < LOW_FREE_GB, kasuj najstarsze komplety (nawet „do zachowania") aż do MIN_KEEP.
LOW_FREE_GB="${LOW_FREE_GB:-12}"
FREEZE_AFTER_MIN="${FREEZE_AFTER_MIN:-15}"; ORPHAN_HOURS="${ORPHAN_HOURS:-12}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-26}"; MIN_BYTES="${MIN_BYTES:-1000000000}"
DRY="${DRY_RUN:-0}"
log() { printf '%s [offsite] %s\n' "$(date -Is)" "$*" | tee -a "${LOG}" >&2; }
[[ -d "${DIR}" ]] || { log "brak katalogu ${DIR}"; exit 1; }
cd "${DIR}"
stamp_of() { local n=${1##*/}; n=${n%.tar.age}; n=${n%._manifest.json}; printf '%s' "${n}"; }
complete() { [[ -s "$1.tar.age" && -s "$1._manifest.json" ]]; }
sha_in_sidecar() { sed -n 's/.*"archiveSha256": *"\([0-9a-f]\{64\}\)".*/\1/p' "$1._manifest.json" | head -1; }

# --- 1. zamrożenie kompletów starszych niż FREEZE_AFTER_MIN ---
frozen=0
while IFS= read -r f; do
  st="$(stamp_of "${f}")"
  complete "${st}" || continue
  for x in "${st}.tar.age" "${st}._manifest.json"; do
    if ! lsattr -d "${x}" 2>/dev/null | cut -d' ' -f1 | grep -q i; then
      [[ "${DRY}" == 1 ]] || chattr +i "${x}"; frozen=$((frozen+1))
    fi
  done
done < <(find . -maxdepth 1 -name '*.tar.age' -mmin +"${FREEZE_AFTER_MIN}" -printf '%f\n')
[[ ${frozen} -eq 0 ]] || log "zamrożono plików: ${frozen}"

# --- 2. retencja ---
mapfile -t all < <(ls -1 *.tar.age 2>/dev/null | sed 's/\.tar\.age$//' | sort)
keep=(); comp=()
for st in "${all[@]}"; do complete "${st}" && comp+=("${st}"); done
n=${#comp[@]}
if (( n > 0 )); then
  start=$(( n > KEEP_DAILY ? n - KEEP_DAILY : 0 ))
  for (( i=start; i<n; i++ )); do keep+=("${comp[$i]}"); done
  # najstarszy komplet każdego z ostatnich KEEP_MONTHS miesięcy
  for (( m=0; m<KEEP_MONTHS; m++ )); do
    ym="$(date -d "-${m} month" +%Y-%m)"
    for st in "${comp[@]}"; do
      if [[ "${st}" == "${ym}"-* ]]; then keep+=("${st}"); break; fi
    done
  done
fi
is_kept() { local s; for s in "${keep[@]}"; do [[ "$s" == "$1" ]] && return 0; done; return 1; }
removed=0
for st in "${all[@]}"; do
  if complete "${st}"; then
    is_kept "${st}" && continue
    (( n - removed > MIN_KEEP )) || { log "retencja: zostawiam ${st} — nie schodzę poniżej ${MIN_KEEP} kompletów"; continue; }
    log "retencja: usuwam komplet ${st}"
    [[ "${DRY}" == 1 ]] || { chattr -i "${st}.tar.age" "${st}._manifest.json" 2>/dev/null || true; rm -f "${st}.tar.age" "${st}._manifest.json"; }
    removed=$((removed+1))
  else
    # sierota (blob bez sidecara albo odwrotnie) starsza niż ORPHAN_HOURS — przerwana wysyłka
    if [[ -n "$(find . -maxdepth 1 -name "${st}.*" -mmin +$(( ORPHAN_HOURS * 60 )) -print -quit)" ]]; then
      log "retencja: usuwam niekompletny ${st}"
      [[ "${DRY}" == 1 ]] || { chattr -i "${st}".* 2>/dev/null || true; rm -f "${st}".*; }
    fi
  fi
done

# --- 2b. bezpiecznik miejsca (komplet ~5,4 GB; 5+2 kompletów ≈ 38 GB; dysk pomagiera dzieli inne usługi) ---
free_gb=$(df --output=avail -BG . | tail -1 | tr -dc '0-9')
mapfile -t left < <(ls -1 *.tar.age 2>/dev/null | sed 's/\.tar\.age$//' | sort)
while (( free_gb < LOW_FREE_GB && ${#left[@]} > MIN_KEEP )); do
  st="${left[0]}"; log "MAŁO MIEJSCA (${free_gb} GB < ${LOW_FREE_GB} GB): usuwam najstarszy komplet ${st}"
  [[ "${DRY}" == 1 ]] || { chattr -i "${st}".* 2>/dev/null || true; rm -f "${st}".* ".sha-${st}"; }
  left=("${left[@]:1}"); removed=$((removed+1)); free_gb=$(df --output=avail -BG . | tail -1 | tr -dc '0-9')
done

# --- 3. dead-man's switch ---
latest=""; (( n > 0 )) && latest="${comp[$((n-1))]}"
if [[ -z "${latest}" ]]; then log "brak kompletnej kopii — bez pingu"; exit 0; fi
age_h=$(( ( $(date +%s) - $(stat -c %Y "${latest}.tar.age") ) / 3600 ))
bytes=$(stat -c %s "${latest}.tar.age")
want="$(sha_in_sidecar "${latest}")"
have=""
if [[ -n "${want}" ]]; then
  # suma liczona raz: zapamiętana w .sha-cache (blob jest zamrożony, więc wynik nie może się zmienić)
  cache=".sha-${latest}"
  if [[ -s "${cache}" ]]; then have="$(cat "${cache}")"; else have="$(sha256sum "${latest}.tar.age" | cut -d' ' -f1)"; [[ "${DRY}" == 1 ]] || printf '%s' "${have}" > "${cache}"; fi
fi
status="ok"
(( age_h < MAX_AGE_HOURS )) || status="stale(${age_h}h)"
(( bytes >= MIN_BYTES )) || status="${status},small(${bytes}B)"
[[ -z "${want}" || "${want}" == "${have}" ]] || status="${status},sha_mismatch"
log "najnowsza kopia ${latest}: ${age_h} h, ${bytes} B, sha $( [[ -n "${want}" ]] && ( [[ "${want}" == "${have}" ]] && echo zgodna || echo NIEZGODNA ) || echo brak-w-sidecarze ), kompletów ${n}, usunięto ${removed}, wolne $(df -h --output=avail . | tail -1 | tr -d ' ')"
find . -maxdepth 1 -name '.sha-*' -mtime +60 -delete 2>/dev/null || true
if [[ "${status}" == "ok" ]]; then
  if [[ -r "${ENV_FILE}" ]]; then
    # shellcheck source=/dev/null  # plik operatora, poza repo
    url="$(. "${ENV_FILE}"; printf '%s' "${OFFSITE_PING_URL:-}")"
    if [[ -n "${url}" ]]; then
      # URL przez stdin (-K -), nigdy w argv/ps
      printf 'url = "%s?status=up&msg=%s&ping="\n' "${url}" "${latest}" | curl -fsS -m 20 -K - -o /dev/null && log "ping OK" || log "ping nieudany (Kuma/sieć)"
    else log "OFFSITE_PING_URL nieustawiony w ${ENV_FILE} — bez pingu"; fi
  else log "brak ${ENV_FILE} — bez pingu"; fi
else
  log "BEZ pingu: ${status}"
fi
