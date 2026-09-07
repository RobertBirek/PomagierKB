#!/usr/bin/env bash
# kuma_seed_monitors.sh — odtwarza komplet monitorów i kanał powiadomień w Uptime Kumie.
#
# Dlaczego istnieje: konfiguracja Kumy żyje wyłącznie w jej SQLite (`/app/data/kuma.db`).
# Od 2026-09-07 ten plik wchodzi do nocnego snapshotu (`kuma.tar.zst`, odtwarzany przez
# `restore.sh --only kuma`), więc pełne odtworzenie hosta przywraca też konto admina
# i historię — czego ten skrypt NIE zrobi. Skrypt zostaje z dwóch powodów: jest czytelnym
# zapisem tego, CO ma być monitorowane (snapshot jest nieczytelny bez otwierania SQLite),
# i ratuje sytuację, gdy backup Kumy zawiódł albo stawiasz instancję od zera.
# Traktuj go jak źródło prawdy o zestawie monitorów, a klikanie w UI jako rzecz
# do odzwierciedlenia tutaj.
#
# Idempotentny: monitory i powiadomienie dopasowuje po NAZWIE — istniejące aktualizuje
# (zachowując id, tokeny push i historię beatów), brakujące zakłada. Bezpiecznie uruchamiać
# wielokrotnie.
#
# Sekrety: temat ntfy i tokeny push czyta z /etc/kag/alerts.env (0600) i NIGDY ich nie drukuje.
# Brakujące tokeny push generuje i dopisuje do tego pliku — dzięki temu `backup.sh`
# i `verify_backup.sh` (EnvironmentFile) dostają URL-e bez ręcznego przepisywania.
#
# Użycie: kuma_seed_monitors.sh
set -euo pipefail

ALERTS_ENV="${ALERTS_ENV:-/etc/kag/alerts.env}"
DATA_ROOT="${DATA_ROOT:-/srv/kag-data}"
KUMA_DATA="${KUMA_DATA:-${DATA_ROOT}/edge/kuma}"
CONTAINER="${KUMA_CONTAINER:-edge-uptime-kuma}"
# Vhosty są zaszyte tak samo jak w Caddyfile — jedna instalacja, jedna domena.
PANEL_HOST="${PANEL_HOST:-kag.ilovelighting.sanok.pl}"
AUTH_HOST="${AUTH_HOST:-auth.ilovelighting.sanok.pl}"
STATUS_HOST="${STATUS_HOST:-status.ilovelighting.sanok.pl}"

log()  { echo "[kuma-seed] $*"; }
die()  { echo "[kuma-seed][BŁĄD] $*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || die "uruchom jako root (czyta ${ALERTS_ENV} 0600)"
command -v docker >/dev/null || die "brak dockera"
[[ -f "${KUMA_DATA}/kuma.db" ]] || die "brak ${KUMA_DATA}/kuma.db — najpierw przejdź kreator Kumy w przeglądarce"
[[ -f "${ALERTS_ENV}" ]] || die "brak ${ALERTS_ENV}"

umask 077

IMAGE="$(docker inspect "${CONTAINER}" --format '{{.Config.Image}}' 2>/dev/null)" \
  || die "kontener ${CONTAINER} nie istnieje"

# --- sekrety: temat ntfy + tokeny push -------------------------------------------------
# shellcheck disable=SC1090
NTFY_SERVER=""; NTFY_TOPIC=""
# shellcheck source=/dev/null  # plik operatora, poza repo
webhook="$(. "${ALERTS_ENV}"; printf '%s' "${ALERT_WEBHOOK_URL:-}")"
if [[ -n "${webhook}" ]]; then
  NTFY_SERVER="$(printf '%s' "${webhook}" | sed -E 's#^(https?://[^/]+).*#\1#')"
  NTFY_TOPIC="$(printf '%s' "${webhook}" | sed -E 's#.*/##')"
fi
[[ -n "${NTFY_TOPIC}" ]] || die "ALERT_WEBHOOK_URL w ${ALERTS_ENV} nie wygląda jak URL ntfy — bez kanału alertów monitoring nic nie daje"

gen_token() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32; }

# Token bierzemy z istniejącego *_PING_URL, żeby nie unieważnić działającego pingu.
token_from() {  # $1 = nazwa zmiennej
  # shellcheck source=/dev/null  # plik operatora, poza repo
  (. "${ALERTS_ENV}"; printf '%s' "${!1:-}") | sed -E 's#.*/##'
}
PUSH_BASE="https://${STATUS_HOST}/api/push"
BACKUP_TOKEN="$(token_from BACKUP_PING_URL)"
VERIFY_TOKEN="$(token_from VERIFY_PING_URL)"
appended=0
if [[ -z "${BACKUP_TOKEN}" ]]; then BACKUP_TOKEN="$(gen_token)"; appended=1; fi
if [[ -z "${VERIFY_TOKEN}" ]]; then VERIFY_TOKEN="$(gen_token)"; appended=1; fi
if [[ ${appended} -eq 1 ]]; then
  cp -a "${ALERTS_ENV}" "${ALERTS_ENV}.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  sed -i -E '/^(BACKUP_PING_URL|VERIFY_PING_URL)=/d' "${ALERTS_ENV}"
  {
    echo "# Push-monitory Uptime Kumy (dead-man's switch) — wołane TYLKO przy sukcesie."
    echo "BACKUP_PING_URL=${PUSH_BASE}/${BACKUP_TOKEN}"
    echo "VERIFY_PING_URL=${PUSH_BASE}/${VERIFY_TOKEN}"
  } >> "${ALERTS_ENV}"
  chmod 600 "${ALERTS_ENV}"
  log "dopisano brakujące *_PING_URL do ${ALERTS_ENV}"
fi

# --- budowa SQL ------------------------------------------------------------------------
WORK="$(mktemp -d)"; trap 'rm -rf "${WORK}"' EXIT
count="$(python3 - "${WORK}/seed.sql" "${NTFY_SERVER}" "${NTFY_TOPIC}" "${BACKUP_TOKEN}" "${VERIFY_TOKEN}" \
         "${PANEL_HOST}" "${AUTH_HOST}" "${STATUS_HOST}" <<'PY'
import json, sys
out, server, topic, btok, vtok, panel, auth, status = sys.argv[1:9]

NOTIF_NAME = "ntfy — alerty PomagierKB"
notif = {
    "name": NOTIF_NAME, "type": "ntfy", "isDefault": True, "applyExisting": False,
    "ntfyserverurl": server, "ntfytopic": topic, "ntfyPriority": 4,
    "ntfyAuthenticationMethod": "none", "ntfyIcon": "",
}

def q(v):
    return "NULL" if v is None else "'" + str(v).replace("'", "''") + "'"

# name, type, url, keyword, interval, retry_interval, maxretries, timeout,
# accepted, maxredirects, push_token, description
MON = [
 ("Panel — przez ingress", "keyword", f"https://{panel}/healthz", '"ok":true',
  60, 60, 2, 48, '["200-299"]', 10, None,
  "Pełna ścieżka użytkownika: DNS -> Caddy -> kag-panel. Pilnuje też ważności certyfikatu."),
 ("Panel — bezpośrednio (edge-net)", "keyword", "http://kag-panel:8080/healthz", '"ok":true',
  60, 60, 2, 48, '["200-299"]', 10, None,
  "Ten sam healthz z pominięciem Caddy'ego. Czerwony ingress + zielony ten = awaria ingressu, nie aplikacji."),
 ("MCP — readyz (edge-net)", "keyword", "http://kag-mcp:3001/readyz", '"ok":true',
  60, 60, 2, 48, '["200-299"]', 10, None,
  "Gotowość serwera MCP: baza, migracje, profile. Przez Caddy nieosiągalny — tam /mcp/* przyjmuje wyłącznie POST."),
 ("Authentik — liveness (przez ingress)", "http", f"https://{auth}/-/health/live/", None,
  60, 60, 2, 48, '["200-299"]', 10, None,
  "Dostawca tożsamości. Jego awaria odcina logowanie do panelu I do status.*."),
 ("Authentik — readiness (edge-net)", "http", "http://edge-authentik-server:9000/-/health/ready/", None,
  60, 60, 2, 48, '["200-299"]', 10, None,
  "Readiness sprawdza Postgres i Redis Authentika — odróżnia „proces żyje” od „proces działa”."),
 ("Bramka SSO na status.*", "http", f"https://{status}/", None,
  300, 120, 2, 48, '["302"]', 0, None,
  "maxredirects=0, bo sprawdzamy właśnie przekierowanie: 302 do Authentika = forward_auth działa. 200 oznaczałoby monitoring stojący otworem."),
 ("Backup nocny — dead-man's switch", "push", None, None,
  93600, 600, 0, 0, '["200-299"]', 10, btok,
  "backup.sh pinguje TYLKO przy sukcesie. Cisza ponad 26 h = backup nie wystartował, zawisł albo padł przed zapisem statusu. Timer: codziennie 03:20 +10 min losowo."),
 ("Weryfikacja odtwarzania — dead-man's switch", "push", None, None,
  691200, 3600, 0, 0, '["200-299"]', 10, vtok,
  "verify_backup.sh (realne odtworzenie MySQL/Neo4j/MinIO/SQLite) pinguje tylko przy ok:true. Cisza ponad 8 dni = weryfikacja nie biegła albo nie przeszła. Timer: niedziela 04:30 +10 min losowo."),
]

L = ["PRAGMA foreign_keys=ON;", "BEGIN;"]

cfg = q(json.dumps(notif, ensure_ascii=False))
L.append(f"UPDATE notification SET active=1, is_default=1, config={cfg} WHERE name={q(NOTIF_NAME)};")
L.append("INSERT INTO notification (name, active, user_id, is_default, config) "
         f"SELECT {q(NOTIF_NAME)}, 1, (SELECT MIN(id) FROM user), 1, {cfg} "
         f"WHERE NOT EXISTS (SELECT 1 FROM notification WHERE name={q(NOTIF_NAME)});")

for (name, typ, url, kw, iv, ri, mr, to, acc, mrd, tok, desc) in MON:
    n = q(name)
    # istniejący monitor: aktualizuj wszystko poza push_token (żeby nie zerwać działającego pingu)
    L.append(
        f"UPDATE monitor SET type={q(typ)}, url={q(url)}, keyword={q(kw)}, `interval`={iv}, "
        f"retry_interval={ri}, maxretries={mr}, timeout={to}, accepted_statuscodes_json={q(acc)}, "
        f"maxredirects={mrd}, description={q(desc)}, active=1, upside_down=0, invert_keyword=0, "
        f"method='GET', expiry_notification={1 if typ != 'push' else 0} WHERE name={n};")
    if tok:
        L.append(f"UPDATE monitor SET push_token={q(tok)} WHERE name={n} "
                 f"AND (push_token IS NULL OR push_token='');")
    L.append(
        "INSERT INTO monitor (name, type, url, keyword, `interval`, retry_interval, maxretries, "
        "timeout, accepted_statuscodes_json, maxredirects, push_token, description, active, user_id, "
        "method, weight, expiry_notification, upside_down, invert_keyword, resend_interval, conditions) "
        f"SELECT {n}, {q(typ)}, {q(url)}, {q(kw)}, {iv}, {ri}, {mr}, {to}, {q(acc)}, {mrd}, {q(tok)}, "
        f"{q(desc)}, 1, (SELECT MIN(id) FROM user), 'GET', 2000, {1 if typ != 'push' else 0}, 0, 0, 0, '[]' "
        f"WHERE NOT EXISTS (SELECT 1 FROM monitor WHERE name={n});")

# każdy monitor podpięty do kanału ntfy (bez duplikatów)
L.append("INSERT INTO monitor_notification (monitor_id, notification_id) "
         "SELECT m.id, n.id FROM monitor m CROSS JOIN notification n "
         f"WHERE n.name={q(NOTIF_NAME)} AND NOT EXISTS ("
         "SELECT 1 FROM monitor_notification mn WHERE mn.monitor_id=m.id AND mn.notification_id=n.id);")
L.append("COMMIT;")
open(out, "w", encoding="utf-8").write("\n".join(L) + "\n")
print(len(MON))
PY
)"

# --- zapis: Kuma trzyma monitory w pamięci, więc piszemy przy zatrzymanym kontenerze ----
was_running=0
if [[ "$(docker inspect "${CONTAINER}" --format '{{.State.Running}}')" == "true" ]]; then
  was_running=1
  log "zatrzymuję ${CONTAINER} (zapis przy działającej Kumie zostałby nadpisany z pamięci)"
  docker stop "${CONTAINER}" >/dev/null
fi

BAK="$(dirname "${KUMA_DATA}")/kuma-db.bak-$(date -u +%Y%m%dT%H%M%SZ).db"
cp -a "${KUMA_DATA}/kuma.db" "${BAK}"; chmod 600 "${BAK}"
log "kopia bazy: ${BAK}"

docker run --rm --entrypoint sh \
  -v "${KUMA_DATA}:/data" -v "${WORK}:/seed:ro" "${IMAGE}" \
  -c 'sqlite3 /data/kuma.db < /seed/seed.sql'

if [[ ${was_running} -eq 1 ]]; then
  docker start "${CONTAINER}" >/dev/null
  log "wystartowano ${CONTAINER}; czekam na pierwsze beaty"
  sleep 45
fi

docker run --rm --entrypoint sh -v "${KUMA_DATA}:/data:ro" "${IMAGE}" -c '
cp /data/kuma.db /tmp/k.db
cp /data/kuma.db-wal /tmp/k.db-wal 2>/dev/null || true
cp /data/kuma.db-shm /tmp/k.db-shm 2>/dev/null || true
sqlite3 -header -column /tmp/k.db "
select m.id, substr(m.name,1,44) as monitor, m.type,
       coalesce((select case h.status when 1 then \"UP\" when 0 then \"DOWN\" when 2 then \"PENDING\" end
                 from heartbeat h where h.monitor_id=m.id order by h.id desc limit 1), \"(brak beatu)\") as stan
from monitor m order by m.id;"'

log "gotowe — ${count} monitorów, kanał ntfy podpięty do wszystkich"
