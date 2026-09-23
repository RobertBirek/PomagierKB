#!/usr/bin/env bash
# kag-external-probe.sh — sonda SPOZA hosta pim (uruchamiana na pomagierze z timera co 5 min).
# Kuma stoi na pimie, więc gdy pim pada, pada też monitoring — ta sonda jest jedynym sygnałem
# „VPS nie odpowiada z internetu". Sprawdza publiczne punkty (bez logowania), liczy kolejne
# porażki w pliku stanu i alarmuje na ntfy (ten sam kanał co /etc/kag/alerts.env na pimie)
# dopiero po FAILS_TO_ALERT porażkach z rzędu; przy powrocie wysyła jedno „OK". Gdy wszystko
# działa, pinguje push-monitor Kumy „Sonda zewnętrzna (pomagier)" — cisza tam = pomagier/timer padł.
# Sekrety (ALERT_WEBHOOK_URL, PROBE_PING_URL) wyłącznie z /etc/kag/probe.env (0600); URL-e idą
# do curl przez stdin (-K -), nigdy w argv.
set -uo pipefail
ENV_FILE="${PROBE_ENV:-/etc/kag/probe.env}"
STATE_DIR="${PROBE_STATE_DIR:-/var/lib/kag-probe}"
LOG="${PROBE_LOG:-/var/log/kag-probe.log}"
FAILS_TO_ALERT="${FAILS_TO_ALERT:-2}"
TIMEOUT="${PROBE_TIMEOUT:-20}"
# nazwa|url|oczekiwany kod HTTP (status.* MUSI dać 302 — 200 = forward-auth zdjęty)
CHECKS=(
  "panel|https://kag.ilovelighting.sanok.pl/healthz|200"
  "authentik|https://auth.ilovelighting.sanok.pl/-/health/live/|200"
  "status-sso|https://status.ilovelighting.sanok.pl/|302"
)
mkdir -p "${STATE_DIR}"
log() { printf '%s [probe] %s\n' "$(date -Is)" "$*" >> "${LOG}"; }
# shellcheck source=/dev/null  # plik operatora, poza repo
[[ -r "${ENV_FILE}" ]] && . "${ENV_FILE}"
notify() { # notify <tytuł> <treść> <priorytet>
  [[ -n "${ALERT_WEBHOOK_URL:-}" ]] || { log "brak ALERT_WEBHOOK_URL — alert nie wysłany: $1"; return; }
  printf 'url = "%s"\n' "${ALERT_WEBHOOK_URL}" | curl -fsS -m 20 -K - -o /dev/null \
    -H "Title: $1" -H "Priority: $3" -H "Tags: satellite" --data-binary "$2" \
    || log "ntfy nieosiągalny"
}
failed=(); details=()
for c in "${CHECKS[@]}"; do
  IFS='|' read -r name url want <<< "${c}"
  got="$(curl -s -o /dev/null -m "${TIMEOUT}" -w '%{http_code}' "${url}" 2>/dev/null || echo 000)"
  if [[ "${got}" != "${want}" ]]; then failed+=("${name}"); details+=("${name}: HTTP ${got} (oczekiwano ${want})"); fi
done
cnt_file="${STATE_DIR}/fails"; alerted_file="${STATE_DIR}/alerted"
cnt=$(cat "${cnt_file}" 2>/dev/null || echo 0)
if (( ${#failed[@]} > 0 )); then
  cnt=$((cnt+1)); printf '%s' "${cnt}" > "${cnt_file}"
  log "PORAŻKA #${cnt}: ${details[*]}"
  if (( cnt >= FAILS_TO_ALERT )) && [[ ! -f "${alerted_file}" ]]; then
    notify "PomagierKB: pim NIE odpowiada z internetu" "Sonda z pomagiera, ${cnt} kolejne porażki: ${details[*]}. Kuma na pimie może być martwa — sprawdź VPS (ssh pim), Caddy, DNS." 5
    touch "${alerted_file}"
  fi
  exit 0
fi
if [[ -f "${alerted_file}" ]]; then
  notify "PomagierKB: pim znów odpowiada" "Sonda z pomagiera: wszystkie punkty OK po ${cnt} porażkach." 3
  rm -f "${alerted_file}"
fi
[[ "${cnt}" == 0 ]] || log "OK po ${cnt} porażkach"
printf '0' > "${cnt_file}"
if [[ -n "${PROBE_PING_URL:-}" ]]; then
  printf 'url = "%s?status=up&msg=ok&ping="\n' "${PROBE_PING_URL}" | curl -fsS -m 20 -K - -o /dev/null || log "ping Kumy nieudany"
fi
