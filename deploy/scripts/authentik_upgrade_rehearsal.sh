#!/usr/bin/env bash
# authentik_upgrade_rehearsal.sh — próba generalna podbicia Authentika na KOPII bazy.
# Wgrywa ostatni nocny pg_dump do efemerycznego Postgresa w sieci --internal i po kolei
# uruchamia serwer każdego wydania ze ścieżki (migracje startują w entrypoincie). Niczego
# nie dotyka na produkcji; sekrety tylko w pliku env 0600 w katalogu roboczym (nie w argv).
# Użycie: sudo deploy/scripts/authentik_upgrade_rehearsal.sh [<katalog snapshotu>]
set -euo pipefail

REPO="ghcr.io/goauthentik/server"
STEPS=(
  "2025.10.4 sha256:4b4f9ae106dbda902b836aa7a79d2f456b8302f090b862f7ad1bf268402730b2"
  "2025.12.6 sha256:d4c1750e26bb7faa4d09e23305d75b54957ce4b81cee8e3acf4cc4bb8635d705"
  "2026.2.7 sha256:da7024c4a7136b2f0fbbae3740c5ed54633edb393b10dc4fae2cdc056b8f70a8"
  "2026.5.7 sha256:76bf433fd434c067cb25dc3e197cee793998441cda912441ea275293e76cc32c"
  "2026.8.3 sha256:ab9b4e8cc4ab3f8d1198d2db6aeea66bafea1963b3f2843589e0d163f97d9849"
)
BACKUPS="${BACKUPS:-/srv/kag-data/backups/nightly}"
SNAP="${1:-$(find "${BACKUPS}" -mindepth 1 -maxdepth 1 -type d | sort | tail -n1)}"
DUMP="${SNAP}/authentik-pg.sql.zst"
NET="ak-rehearsal-$$"; PG="ak-rehearsal-pg-$$"; AK="ak-rehearsal-srv-$$"
WORK="$(mktemp -d /srv/kag-data/backups/.ak-rehearsal-XXXXXX)"
log() { echo "[rehearsal] $*"; }
die() { echo "[rehearsal][BŁĄD] $*" >&2; exit 1; }
cleanup() {
  docker rm -f "${AK}" "${PG}" >/dev/null 2>&1 || true
  docker network rm "${NET}" >/dev/null 2>&1 || true
  rm -rf "${WORK}"
}
trap cleanup EXIT

[[ -s "${DUMP}" ]] || die "brak dumpu ${DUMP}"
PG_IMAGE="$(docker inspect -f '{{.Config.Image}}' edge-postgres)"
PG_USER="$(docker exec edge-postgres printenv POSTGRES_USER)"
PG_DB="$(docker exec edge-postgres printenv POSTGRES_DB)"

# plik env 0600: sekret produkcyjny (wierne odtworzenie) + jednorazowe hasło bazy próbnej
umask 077
{
  printf 'AUTHENTIK_SECRET_KEY=%s\n' "$(docker exec edge-authentik-server printenv AUTHENTIK_SECRET_KEY)"
  printf 'AUTHENTIK_POSTGRESQL__PASSWORD=%s\n' "rehearsal-$$-${RANDOM}${RANDOM}"
} > "${WORK}/ak.env"
sed -n 's/^AUTHENTIK_POSTGRESQL__PASSWORD=/POSTGRES_PASSWORD=/p' "${WORK}/ak.env" > "${WORK}/pg.env"
mkdir -p "${WORK}/data/media" "${WORK}/templates" "${WORK}/certs"
chown -R 1000:1000 "${WORK}/data" "${WORK}/templates" "${WORK}/certs"

log "snapshot: ${SNAP}"
docker network create --internal "${NET}" >/dev/null
docker run -d --name "${PG}" --network "${NET}" --env-file "${WORK}/pg.env" \
  -e POSTGRES_USER="${PG_USER}" -e POSTGRES_DB="${PG_DB}" "${PG_IMAGE}" >/dev/null
for _ in $(seq 1 60); do
  docker exec "${PG}" pg_isready -h 127.0.0.1 -U "${PG_USER}" -d "${PG_DB}" >/dev/null 2>&1 && break
  sleep 2
done
docker exec "${PG}" pg_isready -h 127.0.0.1 -U "${PG_USER}" -d "${PG_DB}" >/dev/null || die "Postgres próbny nie wstał"
zstd -dc "${DUMP}" | docker exec -i "${PG}" psql -h 127.0.0.1 -U "${PG_USER}" -d "${PG_DB}" -v ON_ERROR_STOP=1 -q >/dev/null \
  || die "import dumpu nie powiódł się"

q() { docker exec "${PG}" psql -h 127.0.0.1 -U "${PG_USER}" -d "${PG_DB}" -tAc "$1" | tr -d '\r '; }
counts() { echo "users=$(q 'select count(*) from authentik_core_user') groups=$(q 'select count(*) from authentik_core_group') oauth2=$(q 'select count(*) from authentik_providers_oauth2_oauth2provider') migrations=$(q 'select count(*) from django_migrations')"; }
BASE="$(counts)"; log "przed: ${BASE}"
SLUG="$(q "select a.slug from authentik_core_application a join authentik_providers_oauth2_oauth2provider o on o.provider_ptr_id = a.provider_id order by a.slug limit 1")"
[[ -n "${SLUG}" ]] || die "brak aplikacji OIDC w kopii bazy"

FAILED=0
for step in "${STEPS[@]}"; do
  tag="${step%% *}"; digest="${step##* }"; t0=$(date +%s)
  docker rm -f "${AK}" >/dev/null 2>&1 || true
  docker run -d --name "${AK}" --network "${NET}" --env-file "${WORK}/ak.env" \
    -e AUTHENTIK_POSTGRESQL__HOST="${PG}" -e AUTHENTIK_POSTGRESQL__USER="${PG_USER}" -e AUTHENTIK_POSTGRESQL__NAME="${PG_DB}" \
    -e AUTHENTIK_ERROR_REPORTING__ENABLED=false -e AUTHENTIK_DISABLE_UPDATE_CHECK=true -e AUTHENTIK_DISABLE_STARTUP_ANALYTICS=true \
    -v "${WORK}/data:/data" -v "${WORK}/templates:/templates" -v "${WORK}/certs:/certs" \
    "${REPO}@${digest}" server >/dev/null
  ok=false
  for _ in $(seq 1 180); do
    [[ "$(docker inspect -f '{{.State.Running}}' "${AK}" 2>/dev/null)" == "true" ]] || break
    if docker exec "${AK}" ak healthcheck >/dev/null 2>&1; then ok=true; break; fi
    sleep 5
  done
  secs=$(( $(date +%s) - t0 ))
  disc="brak"; disc_err=""
  if [[ "${ok}" == "true" ]]; then
    # healthcheck = liveness; aplikacja bywa gotowa kilka-kilkanaście sekund później — ponawiamy
    for _ in $(seq 1 24); do
      disc="$(docker exec "${AK}" python -c "import urllib.request,sys; r=urllib.request.urlopen('http://127.0.0.1:9000/application/o/${SLUG}/.well-known/openid-configuration', timeout=20); sys.stdout.write(str(r.status))" 2>"${WORK}/disc.err" || echo "błąd")"
      [[ "${disc}" == "200" ]] && break
      disc_err="$(tail -n 1 "${WORK}/disc.err" | head -c 300)"
      sleep 5
    done
    secs=$(( $(date +%s) - t0 ))
  fi
  if [[ "${ok}" == "true" && "${disc}" == "200" ]]; then
    log "OK   ${tag}  ${secs}s  discovery=${disc}  $(counts)"
  else
    FAILED=1
    log "FAIL ${tag}  ${secs}s  healthy=${ok} discovery=${disc} (${disc_err})  $(counts)"
    docker logs --tail 25 "${AK}" 2>&1 | cut -c1-300 | sed 's/^/    | /'
    break
  fi
done
AFTER="$(counts)"; log "po:     ${AFTER}"
[[ "${BASE%% migrations=*}" == "${AFTER%% migrations=*}" ]] || { log "FAIL liczności users/groups/oauth2 zmieniły się"; FAILED=1; }
exit "${FAILED}"
