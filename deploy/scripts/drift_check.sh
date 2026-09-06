#!/usr/bin/env bash
# drift_check.sh — wykrywa dryf między konfiguracją compose a stanem faktycznym:
#  1) etykieta com.docker.compose.config-hash działających kontenerów vs `docker compose config --hash`
#     dla obu stacków (edge, kag) — łapie też ręczne grzebanie w kontenerach i zmiany .env bez `up -d`;
#  2) kontenery-sieroty w sieci edge-net (spoza projektów edge/kag);
#  3) obrazy działających kontenerów o digestach innych niż przypięte w .env (przez RepoDigests);
#  4) kontrakt portów hosta: publikować je może WYŁĄCZNIE edge-caddy. Kontener z innego
#     stacka łamiący ten kontrakt = DRYF; kontener spoza obu stacków = UWAGA (świadoma
#     instalacja operatora — nie jest dryfem NASZEJ konfiguracji, ale musi być widoczny).
# Usługi z profilami opcjonalnymi (np. uptime-kuma w profilu "monitoring") są sprawdzane
# wtedy, gdy działają; ich brak = informacja o nieaktywnym profilu, nie dryf.
# Exit 1 przy jakimkolwiek dryfie; 0 gdy czysto.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

env_get() { local v; v=$(grep -E "^$2=" "$1" 2>/dev/null | tail -n1 | cut -d= -f2-) || true; printf '%s' "${v:-${3:-}}"; }

DRIFT=0
drift() { echo "[DRYF] $*"; DRIFT=1; }
ok()    { echo "[ok]   $*"; }
info()  { echo "[i]    $*"; }
warn()  { echo "[UWAGA] $*" >&2; }
die()   { echo "[drift_check][BŁĄD] $*" >&2; exit 2; }

command -v docker >/dev/null || die "brak dockera"

# nazwy projektów compose (do rozpoznawania sierot); domyślnie = nazwa katalogu stacka
declare -A PROJECT_OF=()
for stack in edge kag; do
  PROJECT_OF[${stack}]=$(env_get "${REPO_ROOT}/deploy/${stack}/.env" COMPOSE_PROJECT_NAME "${stack}")
done
unset stack   # nie zostawiaj globalnej zmiennej o tej samej nazwie co lokalna w check_stack

# id działającego kontenera usługi w projekcie (pusty gdy brak)
service_cid() {
  docker ps -q \
    --filter "label=com.docker.compose.project=$1" \
    --filter "label=com.docker.compose.service=$2" | head -n1
}

# "usługa <hash>" dla pliku compose; kolejne argumenty = flagi przed podkomendą (np. --profile '*')
compose_hashes() { local cf=$1; shift; docker compose -f "${cf}" "$@" config --hash '*' 2>/dev/null || true; }

check_stack() {
  # UWAGA: osobne instrukcje `local` — w jednym `local a=$1 b=${a}` wszystkie słowa są
  # rozwijane PRZED przypisaniem, więc ${a} wzięłoby wartość zmiennej globalnej (bug: edge
  # był sprawdzany przeciwko compose.yaml stacka kag).
  local stack=$1
  local cf="${REPO_ROOT}/deploy/${stack}/compose.yaml"
  local project="${PROJECT_OF[${stack}]}"
  local svc want have cid found=0 default_svcs
  if [[ ! -f "${cf}" ]]; then
    warn "brak ${cf} — pomijam stack ${stack}"
    return
  fi
  echo "== stack ${stack} (projekt: ${project}) =="

  # usługi profilu domyślnego — reszta (profile opcjonalne, np. "monitoring") jest
  # sprawdzana tylko gdy faktycznie działa
  default_svcs=" $(compose_hashes "${cf}" | awk '{print $1}' | tr '\n' ' ') "

  # --- 1. config-hash: definicja vs działające kontenery ---
  while read -r svc want; do
    [[ -n "${svc}" ]] || continue
    found=1
    cid=$(service_cid "${project}" "${svc}")
    if [[ -z "${cid}" ]]; then
      if [[ "${default_svcs}" != *" ${svc} "* ]]; then
        info "stack ${stack}: ${svc} — usługa profilu opcjonalnego nie działa (pomijam)"
      else
        drift "stack ${stack}: usługa ${svc} nie ma działającego kontenera"
      fi
      continue
    fi
    have=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.config-hash" }}' "${cid}")
    if [[ "${have}" == "${want}" ]]; then
      ok "stack ${stack}: ${svc} — config-hash zgodny"
    else
      drift "stack ${stack}: ${svc} — config-hash różny (kontener uruchomiony ze starszej/innej konfiguracji; wykonaj 'docker compose up -d')"
    fi
  done < <(compose_hashes "${cf}" --profile '*')
  if [[ ${found} -eq 0 ]]; then
    drift "stack ${stack}: 'docker compose config --hash' nie zwrócił usług (błąd configu lub brak .env?)"
    return
  fi

  # --- 3. digesty obrazów: przypięte w .env (przez compose config) vs RepoDigests działających obrazów ---
  if ! command -v python3 >/dev/null; then
    warn "brak python3 — pomijam porównanie digestów obrazów dla stacka ${stack}"
    return
  fi
  local img exp repod imgid
  while IFS=$'\t' read -r svc img; do
    [[ -n "${svc}" ]] || continue
    if [[ "${img}" != *@sha256:* ]]; then
      # *:local = obrazy budowane lokalnie (panel/mcp) — z założenia bez digestu;
      # reszta bez digestu to luka w kontroli supply-chain: nie ma z czym porównać
      [[ "${img}" == *:local ]] || warn "stack ${stack}: ${svc} — obraz '${img}' nie jest przypięty digestem w .env (brak kontroli supply-chain; przypnij repo@sha256:...)"
      continue
    fi
    exp="sha256:${img##*@sha256:}"
    cid=$(service_cid "${project}" "${svc}")
    [[ -n "${cid}" ]] || continue   # brak kontenera zgłoszony już w checku 1
    imgid=$(docker inspect -f '{{.Image}}' "${cid}")
    repod=$(docker image inspect -f '{{join .RepoDigests " "}}' "${imgid}" 2>/dev/null || true)
    if [[ " ${repod} " == *"@${exp}"* ]]; then
      ok "stack ${stack}: ${svc} — obraz zgodny z digestem z .env"
    else
      drift "stack ${stack}: ${svc} — działający obraz ma inny digest niż w .env (oczekiwano ${exp})"
    fi
  done < <(docker compose -f "${cf}" --profile '*' config --format json 2>/dev/null | python3 -c '
import json, sys
cfg = json.load(sys.stdin)
for name, svc in sorted((cfg.get("services") or {}).items()):
    img = svc.get("image")
    if img:
        print(f"{name}\t{img}")
' 2>/dev/null || true)
}

# --- 2. sieroty w edge-net: kontenery spoza projektów edge/kag ---
check_orphans() {
  local ids id proj name
  if ! docker network inspect edge-net >/dev/null 2>&1; then
    warn "sieć edge-net nie istnieje — pomijam check sierot"
    return
  fi
  echo "== sieć edge-net =="
  ids=$(docker network inspect edge-net -f '{{range $id, $c := .Containers}}{{$id}} {{end}}')
  for id in ${ids}; do
    # wpisy niebędące kontenerami (np. endpointy lb) — pomiń
    proj=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "${id}" 2>/dev/null) || continue
    name=$(docker inspect -f '{{.Name}}' "${id}" | sed 's|^/||')
    if [[ "${proj}" == "${PROJECT_OF[edge]}" || "${proj}" == "${PROJECT_OF[kag]}" ]]; then
      ok "edge-net: ${name} (projekt ${proj})"
    else
      drift "sierota w edge-net: ${name} (projekt: ${proj:-brak — kontener spoza compose})"
    fi
  done
}

# --- 4. kontrakt portów hosta: publikuje TYLKO edge-caddy ---
check_host_ports() {
  local id name proj ports
  echo "== porty publikowane na hoście =="
  while read -r id; do
    [[ -n "${id}" ]] || continue
    ports=$(docker inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{$p}} {{end}}' "${id}" 2>/dev/null) || continue
    ports=$(printf '%s' "${ports}" | xargs || true)
    [[ -n "${ports}" ]] || continue
    name=$(docker inspect -f '{{.Name}}' "${id}" | sed 's|^/||')
    proj=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "${id}" 2>/dev/null || true)
    if [[ "${name}" == "edge-caddy" ]]; then
      ok "porty hosta: ${name} — ${ports} (jedyny kontener z kontraktu ingressu)"
    elif [[ "${proj}" == "${PROJECT_OF[edge]}" || "${proj}" == "${PROJECT_OF[kag]}" ]]; then
      drift "kontener ${name} (projekt ${proj}) publikuje porty hosta: ${ports} — kontrakt dopuszcza tylko edge-caddy"
    else
      # świadoma instalacja operatora poza naszymi stackami — nie jest dryfem naszej
      # konfiguracji, ale musi być widoczna (powierzchnia ataku na hoście)
      warn "kontener spoza stacków edge/kag publikuje porty hosta: ${name} (projekt: ${proj:-brak}) — ${ports}"
    fi
  done < <(docker ps -q)
}

check_stack edge
check_stack kag
check_orphans
check_host_ports

echo "----------------------------------------------"
if [[ ${DRIFT} -eq 1 ]]; then
  echo "[drift_check] WYKRYTO DRYF — szczegóły wyżej" >&2
  exit 1
fi
echo "[drift_check] brak dryfu — stan zgodny z konfiguracją"
