#!/usr/bin/env bash
# egress_guard.sh — blokuje pivot z sieci kag-egress do usług NA HOŚCIE.
#
# Dlaczego istnieje: audyt 2026-09-06 (ustalenie D6-12). `release-openspg-server` jest jedynym
# kontenerem w sieci nie-wewnętrznej (`kag_kag-egress`), bo musi wychodzić do internetu po
# embeddingi. Skutkiem ubocznym było to, że z tego kontenera osiągalne były usługi hosta na
# :80, :443 i :8080 — reguły DOCKER-USER filtrują wyłącznie ruch wchodzący przez `eth0`,
# a ruch kontener→brama nigdy nie przechodzi przez ten warunek. W połączeniu z tym, że
# `base_url` modelu jest wartością konfigurowalną, a `/public/v1/datasource/testConnect`
# działa bez uwierzytelnienia, dawało to gotowy pivot SSRF do usług lokalnych — w tym do
# :8080, którego dostęp z internetu jest CELOWO ograniczony do trzech adresów IP.
#
# Reguła dopasowuje ORYGINALNY (sprzed DNAT) adres docelowy, żeby zablokować wyłącznie ruch
# skierowany do hosta. Ruch do internetu na tym samym porcie 443 (api.openai.com) ma inny
# `--ctorigdst` i przechodzi bez zmian — to jest cała różnica między tą regułą a naiwnym
# `--dport 443 -j DROP`, który zabiłby embeddingi.
#
# Idempotentny: usuwa własne reguły (po komentarzu) i zakłada je od nowa.
# Użycie: egress_guard.sh [--remove] [--check]
set -uo pipefail

TAG="kag-egress-guard"
NETWORK="${EGRESS_NETWORK:-kag_kag-egress}"
PORTS="${EGRESS_BLOCKED_PORTS:-80,443,8080}"

MODE="apply"
case "${1:-}" in
  --remove) MODE="remove" ;;
  --check)  MODE="check" ;;
  "")       ;;
  *) echo "[egress-guard][BŁĄD] nieznany argument: $1" >&2; exit 2 ;;
esac

log() { echo "[egress-guard] $*"; }
die() { echo "[egress-guard][BŁĄD] $*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || die "uruchom jako root"
command -v iptables >/dev/null || die "brak iptables"
command -v docker   >/dev/null || die "brak dockera"

# Usunięcie własnych reguł — po komentarzu, więc nie ruszamy niczego cudzego.
remove_rules() {
  local removed=0 rule
  while read -r rule; do
    [[ -z "${rule}" ]] && continue
    # shellcheck disable=SC2086
    iptables -D DOCKER-USER ${rule#-A DOCKER-USER } 2>/dev/null && removed=$((removed + 1))
  done < <(iptables -S DOCKER-USER 2>/dev/null | grep -F -- "--comment \"${TAG}\"" || true)
  log "usunięto reguł: ${removed}"
}

if [[ "${MODE}" == "remove" ]]; then
  remove_rules
  exit 0
fi

if [[ "${MODE}" == "check" ]]; then
  n=$(iptables -S DOCKER-USER 2>/dev/null | grep -c -F -- "--comment \"${TAG}\"" || true)
  log "aktywnych reguł: ${n}"
  [[ "${n}" -ge 1 ]] || exit 1
  exit 0
fi

# Podsieć czytana z dockera, nie zaszyta: `docker network create` przy odtwarzaniu hosta
# przydziela adresy z puli i zaszyty CIDR po cichu przestałby cokolwiek chronić.
SUBNET="$(docker network inspect "${NETWORK}" --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null)"
[[ -n "${SUBNET}" ]] || die "nie znaleziono sieci ${NETWORK} (czy stack kag jest podniesiony?)"

# Adresy hosta widziane z tej podsieci: brama mostka + wszystkie globalne adresy interfejsów.
GATEWAY="$(docker network inspect "${NETWORK}" --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')"
mapfile -t HOST_ADDRS < <(ip -4 -o addr show scope global | awk '{split($4,a,"/"); print a[1]}')
[[ -n "${GATEWAY}" ]] && HOST_ADDRS+=("${GATEWAY}")

remove_rules

added=0
for addr in $(printf '%s\n' "${HOST_ADDRS[@]}" | sort -u); do
  if iptables -I DOCKER-USER 1 \
      -s "${SUBNET}" -p tcp \
      -m conntrack --ctorigdst "${addr}" \
      -m multiport --dports "${PORTS}" \
      -m comment --comment "${TAG}" \
      -j DROP 2>/dev/null; then
    added=$((added + 1))
  else
    echo "[egress-guard][UWAGA] nie udało się dodać reguły dla ${addr}" >&2
  fi
done

log "sieć ${NETWORK} (${SUBNET}) → host ${PORTS}: reguł DROP założonych ${added}"
[[ ${added} -gt 0 ]] || die "nie założono żadnej reguły"
exit 0
