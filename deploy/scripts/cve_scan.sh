#!/usr/bin/env bash
# cve_scan.sh — skan podatności obrazów obu stacków (edge + kag) przez Trivy.
#
# Dlaczego istnieje: audyt 2026-09-06 (ustalenie D6-04) wykazał 653 podatności HIGH/CRITICAL
# w czterech obrazach OpenSPG i BRAK jakiejkolwiek rutyny skanowania. Upstream OpenSPG jest
# świadomie zamrożony (docs/runbooks/openspg-frozen.md), więc celem tego skryptu NIE jest
# zerowanie licznika, tylko:
#   1) utrzymanie aktualnego rejestru ryzyka zamrożenia (ile, jakie, w czym),
#   2) wykrycie PRZYROSTU — nowa krytyczna podatność w obrazie, którego nie możemy podnieść,
#      jest decyzją operacyjną (kontrola kompensująca, wyjątek, ewentualny backport),
#   3) twarda bramka dla obrazów, które budujemy SAMI (kag-panel, kag-mcp) — tam nowe
#      HIGH/CRITICAL są błędem do naprawienia, nie ryzykiem do zaakceptowania.
#
# Skan idzie przez `docker save` → `trivy image --input`, a NIE przez zamontowany
# /var/run/docker.sock: montowanie socketu dockera do kontenera skanera daje mu uprawnienia
# równoważne rootowi na hoście, czego nie chcemy dla obrazu z zewnątrz.
#
# Wyniki: ${DATA_ROOT}/security/cve/cve-<stamp>.json (pełny) + summary.json (ostatni przebieg)
#         ${DATA_ROOT}/security/cve/baseline.json  (znany, zaakceptowany stan)
# Exit: 0 = brak nowych podatności względem baseline; 1 = przyrost albo błąd skanu.
# Użycie: cve_scan.sh [--update-baseline] [--image <obraz>] [--quiet]
#   --update-baseline  zapisuje bieżący wynik jako nowy stan zaakceptowany (po decyzji operatora)
#   --image            skanuje tylko wskazany obraz (diagnostyka)
set -uo pipefail
umask 077


DATA_ROOT="${DATA_ROOT:-/srv/kag-data}"
OUT_DIR="${DATA_ROOT}/security/cve"
CACHE_DIR="${DATA_ROOT}/security/trivy-cache"
BASELINE="${OUT_DIR}/baseline.json"
SUMMARY="${OUT_DIR}/summary.json"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
REPORT="${OUT_DIR}/cve-${STAMP}.json"
TRIVY_IMAGE="${TRIVY_IMAGE:-aquasec/trivy:0.65.0}"
SEVERITY="${CVE_SEVERITY:-HIGH,CRITICAL}"
RETAIN_REPORTS="${CVE_RETAIN:-12}"

# Obrazy, które budujemy sami — tu nowe HIGH/CRITICAL są błędem, nie ryzykiem zamrożenia.
OWN_IMAGE_RE='^kag-(panel|mcp)'

ONLY_IMAGE=""
UPDATE_BASELINE=0
QUIET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --update-baseline) UPDATE_BASELINE=1; shift ;;
    --image)           ONLY_IMAGE="${2:?podaj obraz}"; shift 2 ;;
    --quiet)           QUIET=1; shift ;;
    *) echo "[cve][BŁĄD] nieznany argument: $1" >&2; exit 2 ;;
  esac
done

log() { [[ ${QUIET} -eq 1 ]] || echo "[cve] $*"; }
die() { echo "[cve][BŁĄD] $*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || die "uruchom jako root (docker save wymaga dostępu do demona)"
command -v docker >/dev/null || die "brak dockera"
command -v jq     >/dev/null || die "brak jq"

mkdir -p "${OUT_DIR}" "${CACHE_DIR}"

docker image inspect "${TRIVY_IMAGE}" >/dev/null 2>&1 \
  || docker pull "${TRIVY_IMAGE}" >/dev/null 2>&1 \
  || die "nie ma obrazu ${TRIVY_IMAGE} i nie udało się go pobrać"

# --- lista obrazów: wszystko, co należy do któregokolwiek projektu compose na tym hoście ---
collect_images() {
  if [[ -n "${ONLY_IMAGE}" ]]; then printf '%s\n' "${ONLY_IMAGE}"; return; fi
  docker ps -a --filter label=com.docker.compose.project --format '{{.Image}}' \
    | grep -v '^$' | sort -u
}

mapfile -t IMAGES < <(collect_images)
[[ ${#IMAGES[@]} -gt 0 ]] || die "nie znaleziono obrazów do skanu"
log "obrazów do skanu: ${#IMAGES[@]}"

# --- skan pojedynczego obrazu przez docker save (bez montowania socketu) ---
WORK="$(mktemp -d "${OUT_DIR}/.work-XXXXXX")"
cleanup() { rm -rf "${WORK}"; }
trap cleanup EXIT

RESULTS="${WORK}/results.jsonl"
: > "${RESULTS}"
SCAN_ERRORS=0

for img in "${IMAGES[@]}"; do
  short="$(printf '%s' "${img}" | sed -E 's#[^A-Za-z0-9._-]+#_#g' | cut -c1-80)"
  tar="${WORK}/${short}.tar"
  log "skanuję ${img%%@*}..."
  if ! docker save "${img}" -o "${tar}" 2>/dev/null; then
    echo "[cve][BŁĄD] docker save nie powiódł się dla ${img}" >&2
    SCAN_ERRORS=$((SCAN_ERRORS + 1))
    continue
  fi
  # --network host: Trivy pobiera bazę podatności z ghcr.io. Katalog cache jest współdzielony
  # między przebiegami, więc pobranie bazy zdarza się raz na dobę, nie raz na obraz.
  scan_json="$(docker run --rm \
      -v "${CACHE_DIR}:/root/.cache/trivy" \
      -v "${tar}:/scan.tar:ro" \
      "${TRIVY_IMAGE}" image \
        --input /scan.tar \
        --scanners vuln \
        --severity "${SEVERITY}" \
        --format json \
        --quiet 2>"${WORK}/trivy.err")" || {
    echo "[cve][BŁĄD] trivy nie powiódł się dla ${img}: $(head -c 300 "${WORK}/trivy.err")" >&2
    SCAN_ERRORS=$((SCAN_ERRORS + 1))
    rm -f "${tar}"
    continue
  }
  rm -f "${tar}"
  # Obrazy przypięte digestem `docker ps` zwraca jako gołe sha — nieczytelne w raporcie.
  # Klucz zostaje referencją obrazu (stabilny dla porównania z baseline), a `name` służy
  # wyłącznie do wyświetlania.
  name="$(docker image inspect "${img}" --format '{{if .RepoTags}}{{index .RepoTags 0}}{{else}}{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}{{end}}' 2>/dev/null || printf '%s' "${img}")"
  # KLUCZ do porównania z baseline MUSI być stabilny. `docker ps` zwraca dla obrazów bez
  # użytecznego tagu KRÓTKI ID, który zmienia się przy odtworzeniu kontenera z pinu
  # digestowego — po deployu 2026-09-06 te same obrazy dostały inne klucze i skan zgłosił
  # 161 „nowych" podatności, których nie było. Bierzemy więc RepoDigest (stabilny dla
  # obrazów firm trzecich przypiętych digestem), a dla obrazów budowanych u nas —
  # repo:tag (`kag-panel:local`), bo tam przyrost między buildami JEST informacją.
  # Dla obrazów firm trzecich stabilną tożsamością jest RepoDigest (zmienia się dopiero
  # przy świadomym podniesieniu pinu). Dla obrazów budowanych U NAS jest ODWROTNIE:
  # buildkit nadaje im RepoDigest, który zmienia się przy KAŻDYM buildzie — kluczowanie
  # po nim znaczyłoby, że po każdym deployu cała lista podatności panelu i mcp raportuje
  # się jako „nowa", czyli dokładnie tam, gdzie przyrost ma być wiarygodny, alarm byłby
  # bezwartościowy. Dlatego dla nich klucz to repo:tag.
  if [[ "${name}" =~ ${OWN_IMAGE_RE} ]]; then
    key="${name}"
  else
    key="$(docker image inspect "${img}" --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{if .RepoTags}}{{index .RepoTags 0}}{{else}}{{.Id}}{{end}}{{end}}' 2>/dev/null || printf '%s' "${img}")"
  fi
  printf '%s' "${scan_json}" | jq -c --arg img "${key}" --arg name "${name}" '
    {
      image: $img,
      name: $name,
      vulns: [ (.Results // [])[] | (.Vulnerabilities // [])[]
               | {id: .VulnerabilityID, sev: .Severity, pkg: .PkgName, ver: .InstalledVersion,
                  fixed: (.FixedVersion // "")} ]
    }
    | .critical = ([.vulns[] | select(.sev == "CRITICAL")] | length)
    | .high     = ([.vulns[] | select(.sev == "HIGH")]     | length)
    | .ids      = ([.vulns[] | .id] | unique)
  ' >> "${RESULTS}"
done

# --- raport zbiorczy ---
jq -s --arg stamp "${STAMP}" --arg sev "${SEVERITY}" '
  {
    generatedAt: $stamp,
    severityFilter: $sev,
    images: (. | map({key: .image, value: {name, critical, high, ids, vulns}}) | from_entries),
    totals: {
      images:   (. | length),
      critical: (map(.critical) | add // 0),
      high:     (map(.high) | add // 0)
    }
  }
' "${RESULTS}" > "${REPORT}" || die "nie udało się złożyć raportu"

# --- porównanie z baseline: interesuje nas PRZYROST, nie wartość bezwzględna ---
if [[ ! -s "${BASELINE}" ]]; then
  log "brak baseline — zapisuję bieżący wynik jako stan wyjściowy"
  cp "${REPORT}" "${BASELINE}"
  NEW_JSON='{"newByImage":{},"newTotal":0,"newOwnTotal":0,"firstRun":true}'
else
  NEW_JSON="$(jq -n --slurpfile cur "${REPORT}" --slurpfile base "${BASELINE}" --arg ownre "${OWN_IMAGE_RE}" '
    ($cur[0].images) as $c | ($base[0].images) as $b
    | [ $c | to_entries[]
        | .key as $img
        | ((.value.ids) - (($b[$img].ids) // [])) as $new
        | select($new | length > 0)
        | {image: $img, new: $new,
           own: ($img | test($ownre)),
           newCritical: [ $c[$img].vulns[] | select(.sev=="CRITICAL") | select(.id as $i | $new | index($i)) | .id ] | unique}
      ] as $rows
    | {newByImage: ($rows | map({key: .image, value: {count: (.new|length), ids: .new, critical: .newCritical, own: .own}}) | from_entries),
       newTotal: ($rows | map(.new | length) | add // 0),
       newOwnTotal: ($rows | map(select(.own) | .new | length) | add // 0),
       firstRun: false}
  ')"
fi

TOT_CRIT="$(jq -r '.totals.critical' "${REPORT}")"
TOT_HIGH="$(jq -r '.totals.high' "${REPORT}")"
NEW_TOTAL="$(printf '%s' "${NEW_JSON}" | jq -r '.newTotal')"
NEW_OWN="$(printf '%s' "${NEW_JSON}" | jq -r '.newOwnTotal')"

jq -n --slurpfile rep "${REPORT}" --argjson new "${NEW_JSON}" --arg stamp "${STAMP}" \
      --argjson errs "${SCAN_ERRORS}" '
  {generatedAt: $stamp, totals: $rep[0].totals, scanErrors: $errs,
   perImage: ($rep[0].images | with_entries(.value |= {name, critical, high})),
   new: $new,
   ok: (($new.newTotal == 0) and ($errs == 0))}
' > "${SUMMARY}"

log "razem: CRITICAL=${TOT_CRIT}, HIGH=${TOT_HIGH}; nowych względem baseline: ${NEW_TOTAL} (w obrazach własnych: ${NEW_OWN}); błędów skanu: ${SCAN_ERRORS}"
log "raport: ${REPORT}"

if [[ ${UPDATE_BASELINE} -eq 1 ]]; then
  cp "${REPORT}" "${BASELINE}"
  log "baseline zaktualizowany na życzenie operatora"
fi

# retencja raportów
find "${OUT_DIR}" -maxdepth 1 -name 'cve-*.json' -type f -printf '%T@ %p\n' 2>/dev/null \
  | sort -rn | tail -n "+$((RETAIN_REPORTS + 1))" | cut -d' ' -f2- | xargs -r rm -f

# --- alert: tylko przyrost, nigdy stały licznik zamrożenia (inaczej alarm zostanie zignorowany) ---
if [[ "${NEW_TOTAL}" -gt 0 || ${SCAN_ERRORS} -gt 0 ]]; then
  # shellcheck disable=SC1091
  [[ -r /etc/kag/alerts.env ]] && . /etc/kag/alerts.env
  if [[ -n "${ALERT_WEBHOOK_URL:-}" ]]; then
    DETAIL="$(printf '%s' "${NEW_JSON}" | jq -r '
      .newByImage | to_entries | map("\(.key): +\(.value.count)\(if (.value.critical|length)>0 then " (CRITICAL: \(.value.critical|join(", ")))" else "" end)") | .[0:10] | join("\n")')"
    # URL przez `-K -`, nie jako argument — nazwa tematu ntfy jest sekretem kanału,
    # a argv procesu widzi każdy użytkownik hosta (zasada: sekrety nigdy w argv).
    printf 'url = "%s"\n' "${ALERT_WEBHOOK_URL}" \
      | curl -fsS -m 15 -o /dev/null -K - \
          -d "Nowe podatności w obrazach PomagierKB — $(hostname), $(date -Is):
nowych: ${NEW_TOTAL} (w obrazach własnych: ${NEW_OWN}), błędów skanu: ${SCAN_ERRORS}
${DETAIL}
Stan łączny: CRITICAL=${TOT_CRIT}, HIGH=${TOT_HIGH}
Raport: ${REPORT}
Procedura: docs/runbooks/openspg-frozen.md (obrazy zamrożone) / naprawa w kodzie (kag-panel, kag-mcp)." \
      || echo "[cve] webhook nie odpowiedział (curl rc=$?)" >&2
  fi
  exit 1
fi

exit 0
