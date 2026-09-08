#!/usr/bin/env bash
# wg_guard.sh — izoluje tunel WireGuard od sieci docker, w OBIE strony.
#
# Dlaczego istnieje: samo podniesienie `wg0` daje efekt ODWROTNY do zamierzonego. Reguła
# `-A DOCKER-USER -i eth0 -j DROP`, która chroni kontenery przed ruchem z internetu, dopasowuje
# INTERFEJS — ruch wchodzący przez `wg0` jej nie dotyka, spada do `RETURN`, trafia do
# `DOCKER-FORWARD` i zostaje przepuszczony. ufw też nie pomoże mimo `deny (routed)`, bo łańcuch
# Dockera stoi w `FORWARD` PRZED łańcuchami ufw i akceptuje ruch, zanim ufw go zobaczy.
# Bez tego skryptu sieć za tunelem miałaby bezpośredni dostęp do `kag-datastores`, gdzie
# OpenSPG na :8887 nie ma ŻADNEGO uwierzytelnienia, a obok stoją MySQL, Neo4j i MinIO.
#
# Drugi kierunek jest równie ważny. Host ma mieć trasę do całej sieci zdalnej, więc ta trasa
# realnie istnieje w tablicy routingu — a `release-openspg-server` ma konfigurowalny `base_url`
# modelu i nieuwierzytelniony `/public/v1/datasource/testConnect`, czyli gotowy pivot SSRF.
# `egress_guard.sh` blokuje mu drogę do usług TEGO hosta, ale o tunelu nic nie wie, bo powstał,
# zanim tunel istniał. Kierunek „host → sieć zdalna" idzie przez OUTPUT hosta i te reguły
# go NIE dotykają — administrator zachowuje pełny dostęp.
#
# Idempotentny: usuwa własne reguły (po komentarzu) i zakłada je od nowa.
# Użycie: wg_guard.sh [--remove] [--check]
set -uo pipefail

TAG="kag-wg-guard"
WG_IFACE="${WG_IFACE:-wg0}"
# Podsieci chronione po stronie tunelu: podsieć samego tunelu + sieć zdalna. Czytane
# z konfiguracji, nie zaszyte — zmiana adresacji nie może po cichu zostawić dziury.
WG_CONF="${WG_CONF:-/etc/wireguard/${WG_IFACE}.conf}"

MODE="apply"
case "${1:-}" in
  --remove) MODE="remove" ;;
  --check)  MODE="check" ;;
  "")       ;;
  *) echo "[wg-guard][BŁĄD] nieznany argument: $1" >&2; exit 2 ;;
esac

log() { echo "[wg-guard] $*"; }
die() { echo "[wg-guard][BŁĄD] $*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || die "uruchom jako root"
command -v iptables >/dev/null || die "brak iptables"
command -v docker   >/dev/null || die "brak dockera"

remove_rules() {
  local removed=0 rule
  while read -r rule; do
    [[ -z "${rule}" ]] && continue
    # shellcheck disable=SC2086
    iptables -D DOCKER-USER ${rule#-A DOCKER-USER } 2>/dev/null && removed=$((removed + 1))
  done < <(iptables -S DOCKER-USER 2>/dev/null | grep -F -- "--comment ${TAG} " || true)
  log "usunięto reguł: ${removed}"
}

if [[ "${MODE}" == "remove" ]]; then
  remove_rules
  exit 0
fi

if [[ "${MODE}" == "check" ]]; then
  n=$(iptables -S DOCKER-USER 2>/dev/null | grep -c -F -- "--comment ${TAG} " || true)
  log "aktywnych reguł: ${n}"
  [[ "${n}" -ge 1 ]] || exit 1
  exit 0
fi

# ── Podsieci po stronie tunelu ──────────────────────────────────────────────────────────
# Bierzemy je z konfiguracji, a nie z `wg show`: guard musi dać się założyć także wtedy, gdy
# tunel akurat leży — inaczej po restarcie interfejsu istniałoby okno bez ochrony.
[[ -f "${WG_CONF}" ]] || die "brak ${WG_CONF} — nie wiem, jakie podsieci chronić"
# SUMA dwóch źródeł, i to nie z ostrożności, tylko z incydentu 2026-09-08: peer dodany
# w locie (`wg set`) bez zapisania do pliku był dla guarda NIEWIDZIALNY, więc sieć biurowa
# 192.168.1.0/24 nie miała ani jednej reguły i kontener OpenSPG dostawał HTTP 200 z routera
# w biurze. Czytanie samego pliku nie chroni tego, co realnie istnieje; czytanie samego
# runtime'u nie zadziała, gdy tunel akurat leży. Bierzemy więc oba:
#   - z PLIKU: AllowedIPs peerów + Address interfejsu (prefiks całej podsieci tunelu),
#   - z RUNTIME'U: AllowedIPs faktycznie skonfigurowanych peerów.
mapfile -t TUNNEL_NETS < <(
  {
    grep -iE '^\s*(AllowedIPs|Address)\s*=' "${WG_CONF}" | cut -d= -f2- | tr ',' '\n'
    # Pole 1 to klucz publiczny, reszta to podsieci; brak interfejsu = brak wyjścia, nie błąd.
    wg show "${WG_IFACE}" allowed-ips 2>/dev/null | cut -f2- | tr ' \t' '\n'
  } | tr -d ' \t' | grep -E '^[0-9]+\.' | sort -u
)
[[ ${#TUNNEL_NETS[@]} -gt 0 ]] || die "ani ${WG_CONF}, ani interfejs ${WG_IFACE} nie dały żadnej podsieci"

# ── Podsieci docker ─────────────────────────────────────────────────────────────────────
# Czytane z dockera, nie zaszyte: `docker network create` przy odtwarzaniu hosta przydziela
# adresy z puli i zaszyty CIDR po cichu przestałby cokolwiek chronić.
mapfile -t DOCKER_NETS < <(
  docker network ls --format '{{.Name}}' | while read -r net; do
    docker network inspect "${net}" --format '{{range .IPAM.Config}}{{.Subnet}}{{"\n"}}{{end}}' 2>/dev/null
  done | grep -E '^[0-9]+\.' | sort -u
)
[[ ${#DOCKER_NETS[@]} -gt 0 ]] || die "nie znalazłem żadnej podsieci docker (czy docker działa?)"

remove_rules

added=0
add_rule() { # add_rule <src> <dst>
  if iptables -I DOCKER-USER 1 -s "$1" -d "$2" -m comment --comment "${TAG}" -j DROP 2>/dev/null; then
    added=$((added + 1))
  else
    echo "[wg-guard][UWAGA] nie udało się dodać reguły $1 → $2" >&2
  fi
}

for tunnel in "${TUNNEL_NETS[@]}"; do
  for dnet in "${DOCKER_NETS[@]}"; do
    add_rule "${tunnel}" "${dnet}"   # tunel → docker (sieć zdalna nie dosięga platformy)
    add_rule "${dnet}" "${tunnel}"   # docker → tunel (kontener nie dosięga sieci zdalnej)
  done
done

log "tunel ${TUNNEL_NETS[*]} ⇄ docker ${DOCKER_NETS[*]}: reguł DROP założonych ${added}"
[[ ${added} -gt 0 ]] || die "nie założono żadnej reguły"
exit 0
