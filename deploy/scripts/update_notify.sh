#!/usr/bin/env bash
# update_notify.sh — miesięczny nasłuch aktualizacji obrazów (wrapper update_check.sh):
# uruchamia raport i — gdy są dostępne aktualizacje — wysyła go na ALERT_WEBHOOK_URL
# (z /etc/kag/alerts.env; brak webhooka = tylko log w journalu). TYLKO raportuje,
# niczego nie aktualizuje. Błąd zapytań rejestrów → exit != 0 (OnFailure alarmuje).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORT="$(DATA_ROOT="${DATA_ROOT:-/srv/kag-data}" "${SCRIPT_DIR}/update_check.sh" 2>&1)"
RC=$?
echo "${REPORT}"
[[ ${RC} -ne 0 ]] && exit "${RC}"

# "aktualizacje dostępne=N" z podsumowania (0 → cisza).
UPDATES=$(printf '%s\n' "${REPORT}" | sed -n 's/.*aktualizacje dostępne=\([0-9]\+\).*/\1/p' | tail -1)
if [[ -n "${UPDATES:-}" && "${UPDATES}" -gt 0 && -n "${ALERT_WEBHOOK_URL:-}" ]]; then
  SUMMARY=$(printf '%s\n' "${REPORT}" | grep -E "NOWY|NIEPRZYPIĘTY|Podsumowanie" | head -20)
  curl -fsS -m 15 \
    -d "Aktualizacje obrazów PomagierKB (${UPDATES}) — $(hostname), $(date -Is):
${SUMMARY}
Procedura: docs/deployment.md §aktualizacje (OpenSPG ZAMROŻONY — pomiń)." \
    "${ALERT_WEBHOOK_URL}" >/dev/null || echo "[update-notify] webhook nie odpowiedział" >&2
fi
exit 0
