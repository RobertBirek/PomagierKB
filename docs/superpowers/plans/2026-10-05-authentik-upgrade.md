# Podbicie Authentika 2025.8.6 → 2026.8.3 — plan wykonania

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. To jest operacja na produkcyjnym SSO — każdy krok z `compose up` wymaga zgody właściciela na okno serwisowe.

**Goal:** Authentik (stack `edge`) działa na wydaniu 2026.8.3 z usuniętą krytyczną podatnością `CVE-2026-102268` (PyJWT 2.10.1 → ≥ 2.14.0), bez utraty kont, grup, providerów i MFA.

**Architecture:** Producent wymaga przejścia przez KAŻDĄ linię wydań po kolei i nie wspiera downgrade'u — więc pięć skoków, każdy na najnowszy patch linii, każdy z własnym zrzutem bazy jako punktem powrotu. Cały łańcuch migracji jest najpierw przećwiczony na KOPII bazy w odciętej sieci (próba generalna), a dopiero potem wykonany na produkcji w jednym oknie serwisowym.

**Tech Stack:** docker compose (`deploy/edge/compose.yaml`, obrazy przypięte digestem w `deploy/edge/.env`), PostgreSQL 16.15 (`edge-postgres`), Caddy (ingress + forward_auth), bash, `deploy/scripts/{backup,smoke,cve_scan,save_images}.sh`, `tools/ux-audit/e2e.mjs`.

**Spec:** brak osobnego dokumentu — źródłem są noty wydań producenta (`https://docs.goauthentik.io/docs/releases/<linia>`), polityka `https://docs.goauthentik.io/docs/install-config/upgrade` oraz wpis z 2026-10-05 w `docs/ops/cve-baseline-log.md`.

## Stan wyjściowy (zmierzony 2026-10-05)

| Fakt | Wartość | Skąd |
|---|---|---|
| Obecny pin | `ghcr.io/goauthentik/server@sha256:f162a266…` = tag `2025.8.6` (najnowszy patch linii 2025.8) | `docker buildx imagetools inspect` |
| Baza | PostgreSQL 16.15, `max_connections` 100, 17 połączeń w spoczynku | `psql` w `edge-postgres` |
| Zawartość | 4 użytkowników, 5 grup, 0 zdublowanych nazw grup | `authentik_core_user`, `authentik_core_group` |
| Własne mapowania / polityki z `ak_groups` | 0 / 0 (brak własnych property mappings w ogóle) | `authentik_core_propertymapping where managed is null` |
| Outposty | tylko `authentik Embedded Outpost` (proxy) — w procesie serwera, wersja zawsze zgodna | `authentik_outposts_outpost` |
| Media | `/srv/kag-data/edge/authentik/media/public` — pusty katalog | `ls` |
| Sieci | `edge-net` 172.19.0.0/16, `edge_edge-internal` 172.20.0.0/16 | `docker network inspect` |
| `email_verified` w kodzie panelu/MCP | brak odwołań | `grep -rn email_verified apps packages` |
| Zasoby hosta | 219 GB wolnego dysku, 12 GB wolnej pamięci | `df`, `free` |
| Aplikacje | dokładnie dwie: `kag-panel` (provider OIDC `kag-panel-oidc`) i `status-monitor` (proxy `status-monitor-fwd`) | `authentik_core_application` |
| Proces Authentika | uid 1000; IPv6 w kontenerze włączone (`disable_ipv6 = 0`) | `docker exec … id -u`, `/proc/sys/net/ipv6/conf/all/disable_ipv6` |
| PyJWT w obrazie | 2.10.1 | `python -c "import jwt; print(jwt.__version__)"` |

## Ścieżka i digesty (rozwiązane 2026-10-05 — przed użyciem sprawdź ponownie, Task 1 Step 2)

| Skok | Tag | Digest |
|---|---|---|
| 1 | `2025.10.4` | `sha256:4b4f9ae106dbda902b836aa7a79d2f456b8302f090b862f7ad1bf268402730b2` |
| 2 | `2025.12.6` | `sha256:d4c1750e26bb7faa4d09e23305d75b54957ce4b81cee8e3acf4cc4bb8635d705` |
| 3 | `2026.2.7` | `sha256:da7024c4a7136b2f0fbbae3740c5ed54633edb393b10dc4fae2cdc056b8f70a8` |
| 4 | `2026.5.7` | `sha256:76bf433fd434c067cb25dc3e197cee793998441cda912441ea275293e76cc32c` |
| 5 | `2026.8.3` | `sha256:ab9b4e8cc4ab3f8d1198d2db6aeea66bafea1963b3f2843589e0d163f97d9849` |

## Zmiany łamiące per linia i ich wpływ na tę instancję

| Linia | Zmiana producenta | Wpływ u nas | Działanie |
|---|---|---|---|
| 2025.10 | Redis usunięty całkowicie (cache, zadania, sesje, websockety → Postgres); ~50% więcej połączeń do PG | usługa `redis` i `AUTHENTIK_REDIS__HOST` stają się martwe; sesje SSO w Redis przepadają (ponowne logowanie do Authentika) | Task 3: usunąć usługę, zmienną i `REDIS_IMAGE`; 17 → ~26 połączeń przy limicie 100 — bez zmian w PG |
| 2025.10 | domyślne `email_verified` w scope `email`: `true` → `false` | jedyny klient OIDC to panel, który tego claimu nie czyta; `status-monitor` to proxy | nic; Task 1 Step 4 potwierdza, że lista aplikacji się nie zmieniła |
| 2025.12 | nazwy grup muszą być unikalne (inaczej migracja pada) | 0 duplikatów | ponowne sprawdzenie tuż przed skokiem (Task 4 Step 1) |
| 2025.12 | storage: montowanie `/media` → `/data` (pliki w `/data/media`), serwowanie spod `/files` | katalog pusty; Caddy nie ma reguł na `/media` | Task 4: nowy katalog `…/authentik/data`, przeniesienie `media`, zmiana wolumenu w obu usługach |
| 2025.12 | RBAC: uprawnienia tylko przez role; `Group.parent` → `Group.parents` | brak własnych wyrażeń; role panelu idą z NAZW grup w claimie `groups` | weryfikacja claimu `groups` po skoku (E2E loguje się i sprawdza rolę) |
| 2026.2 | SCIM: filtrowanie po politykach; `User.ak_groups` przestarzałe | brak SCIM, 0 użyć `ak_groups` | nic |
| 2026.5 | domyślny nasłuch `0.0.0.0` → `[::]` | kontener ma stos IPv6 (zmierzone), więc powinno zadziałać bez zmian | próba generalna to potwierdzi; plan awaryjny: `AUTHENTIK_LISTEN__HTTP: 0.0.0.0:9000` i `AUTHENTIK_LISTEN__METRICS: 0.0.0.0:9300` w `x-authentik-env` |
| 2026.8 | nagłówki `X-Forwarded-*` honorowane tylko z zaufanych sieci proxy | Caddy łączy się z 172.19.0.0/16 — mieści się w domyślnym 172.16.0.0/12 | weryfikacja po skoku: logowanie nie wpada w pętlę HTTP/HTTPS, `status.*` daje 302; plan awaryjny: `AUTHENTIK_LISTEN__TRUSTED_PROXY_CIDRS: 172.19.0.0/16` |
| 2026.8 | `hash_password` bez hasła w argumencie; usunięta opcja WebAuthn „Prevent duplicate devices" | nieużywane w skryptach | nic |

## Global Constraints

- Kolejność skoków jest sztywna: 2025.10 → 2025.12 → 2026.2 → 2026.5 → 2026.8. Żadnego pomijania linii.
- Downgrade nie istnieje. Powrót = poprzedni digest + przywrócenie zrzutu bazy sprzed TEGO skoku (procedura: `docs/runbooks/break-glass-authentik.md` §5).
- Obrazy wyłącznie po digestach z tabeli powyżej, z komentarzem `# <tag>, pin <data>` w `.env`.
- Sekrety nigdy w argv, logach ani w rozmowie: `AUTHENTIK_SECRET_KEY` i hasło PG przechodzą tylko przez plik env 0600 w katalogu roboczym próby i `docker exec … printenv` do pliku.
- `deploy/edge/.env` nie jest w git i jego edycja może wymagać rąk właściciela — każdy krok edycji `.env` podaje gotową komendę `sed`.
- NIE używać `docker compose up --remove-orphans` w stacku `edge` (Uptime Kuma jest w profilu `monitoring`); Redis usuwamy jawnie po nazwie kontenera.
- Po edycji `deploy/edge/Caddyfile` (ten plan jej nie przewiduje) obowiązuje `docker restart edge-caddy`, nie `caddy reload`.
- Commity po angielsku (conventional), zakończone `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; gitleaks musi przejść.
- W trakcie okna: nowe logowania do panelu i `status.*` nie działają; MCP (Bearer `sk-…`) i istniejące sesje panelu działają dalej. Szacowany czas okna: wynik próby generalnej × 2, wstępnie 60–90 min.

## Review Focus

1. **Migracja pada w połowie skoku** (np. zdublowana grupa utworzona między preflightem a oknem) → stan bazy nieokreślony; oczekiwane: zatrzymanie, przywrócenie zrzutu sprzed skoku, nie „naprawianie w przód". Pokrycie: Task 2 (próba na kopii) + zrzut per skok w Task 3–7.
2. **Kontener nie wstaje po zmianie nasłuchu na `[::]`** (skok 4) → healthcheck czerwony mimo udanej migracji. Pokrycie: Task 2 wykrywa na tym samym hoście; plan awaryjny w tabeli.
3. **Pętla przekierowań albo „insecure" po skoku 5** (nagłówki proxy odrzucone) → logowanie niemożliwe mimo `healthy`. Pokrycie: Task 7 Step 4 (E2E = prawdziwe logowanie OIDC przez Caddy).
4. **Rola w panelu znika po zmianie RBAC** (claim `groups` pusty lub inny) → użytkownik loguje się, ale dostaje 403. Pokrycie: E2E po skoku 2 sprawdza strony wymagające roli; dodatkowo ręczne logowanie `akadmin` po skoku 5.
5. **MFA / klucze WebAuthn przestają działać po migracji** → właściciel odcięty od administracji. Pokrycie: Task 1 Step 5 (recovery key przygotowany PRZED oknem), Task 8 Step 2 (ręczne logowanie z MFA).

---

### Task 1: Preflight (tylko odczyt + kopie) — do wykonania w dniu okna, przed nim

**Files:**
- Create: `/srv/kag-data/backups/authentik-upgrade/` (katalog zrzutów per skok, poza repo)

- [ ] **Step 1: Stan wyjściowy jest zdrowy**

```bash
cd /kag && bash .claude/skills/kag-daily-ops/scripts/status.sh | sed -n '/failed/p;/## kontenery/,/## backup/p'
deploy/scripts/smoke.sh | tail -3
node tools/ux-audit/e2e.mjs | tail -1
```
Expected: `failed: 0`, `wszystkie healthy`, smoke `FAIL=0`, E2E `10/10 PASS`. Jeśli nie — STOP, najpierw napraw stan.

- [ ] **Step 2: Digesty z tabeli nadal wskazują najnowsze patche linii**

```bash
for t in 2025.10 2025.12 2026.2 2026.5 2026.8; do
  gh api 'repos/goauthentik/authentik/releases?per_page=100' --jq '.[]|select(.prerelease==false)|.tag_name' \
    | sed 's#version/##' | grep "^$t\." | sort -V | tail -1
done
```
Expected: `2025.10.4 2025.12.6 2026.2.7 2026.5.7 2026.8.3`. Jeśli wyszedł nowszy patch — rozwiąż jego digest (`docker buildx imagetools inspect ghcr.io/goauthentik/server:<tag> | awk '/^Digest:/{print $2;exit}'`), popraw tabelę w tym pliku i przeczytaj noty tego patcha.

- [ ] **Step 3: Pobierz wszystkie obrazy z wyprzedzeniem i zachowaj obecny offline**

```bash
for d in 4b4f9ae106dbda902b836aa7a79d2f456b8302f090b862f7ad1bf268402730b2 d4c1750e26bb7faa4d09e23305d75b54957ce4b81cee8e3acf4cc4bb8635d705 da7024c4a7136b2f0fbbae3740c5ed54633edb393b10dc4fae2cdc056b8f70a8 76bf433fd434c067cb25dc3e197cee793998441cda912441ea275293e76cc32c ab9b4e8cc4ab3f8d1198d2db6aeea66bafea1963b3f2843589e0d163f97d9849; do
  docker pull -q ghcr.io/goauthentik/server@sha256:$d
done
sudo /kag/deploy/scripts/save_images.sh
```
Expected: pięć linii z digestami; `save_images.sh` kończy się kodem 0 (obraz 2025.8.6 jest w archiwum offline na wypadek powrotu).

- [ ] **Step 4: Lista aplikacji OIDC i ich zależność od `email_verified`**

```bash
docker exec edge-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select a.slug, p.name from authentik_core_application a left join authentik_core_provider p on p.id = a.provider_id order by 1"'
```
Expected: dokładnie `kag-panel|kag-panel-oidc` i `status-monitor|status-monitor-fwd` (stan z 2026-10-05). Jeśli doszła nowa aplikacja OIDC — sprawdź w jej konfiguracji, czy wymaga `email_verified = true`; jeśli tak, przed skokiem 1 utwórz w Authentiku własne mapowanie scope `email` zwracające `"email_verified": True` i podepnij je do jej providera. Wynik zapisz w „Dzienniku wykonania".

- [ ] **Step 5: Wyjście awaryjne dla administratora przygotowane**

```bash
sed -n '/^## .*recovery\|create_recovery_key/,+6p' /kag/docs/runbooks/break-glass-authentik.md | head -20
```
Expected: widać procedurę `ak create_recovery_key`. Nie generuj klucza teraz (link jest sekretem) — tylko potwierdź, że komenda jest pod ręką i że właściciel ma dostęp do terminala hosta w czasie okna.

- [ ] **Step 6: Świeży pełny backup z kopią off-site**

```bash
sudo systemctl start kag-backup.service; systemctl is-failed kag-backup.service
bash /kag/.claude/skills/kag-daily-ops/scripts/status.sh | sed -n '/## backup/,/off-site:/p' | cut -c1-200
sudo mkdir -p /srv/kag-data/backups/authentik-upgrade && sudo chmod 700 /srv/kag-data/backups/authentik-upgrade
```
Expected: `inactive` (nie `failed`), `ostatni snapshot` z dzisiejszą datą i `ok=True`, `off-site: status=ok`.

---

### Task 2: Próba generalna łańcucha migracji na kopii bazy

**Files:**
- Create: `deploy/scripts/authentik_upgrade_rehearsal.sh`
- Modify: `.github/workflows/ci.yml` — nic; skrypt łapie istniejący job `shell-scripts` (shellcheck)

**Interfaces:**
- Consumes: najnowszy `authentik-pg.sql.zst` z `/srv/kag-data/backups/nightly/<stamp>/`, `POSTGRES_IMAGE` z działającego `edge-postgres`, digesty z tabeli.
- Produces: raport na stdout — per skok `OK/FAIL`, czas migracji w sekundach, liczby `users/groups/providers`, status discovery OIDC; kod wyjścia 0 tylko gdy wszystkie pięć skoków `OK`. Zero zmian na produkcji: sieć `--internal`, własny Postgres, kontenery usuwane w `trap`.

- [ ] **Step 1: Napisz skrypt**

```bash
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
  disc="brak"
  if [[ "${ok}" == "true" ]]; then
    disc="$(docker exec "${AK}" python -c "import urllib.request,sys; r=urllib.request.urlopen('http://127.0.0.1:9000/application/o/${SLUG}/.well-known/openid-configuration', timeout=20); sys.stdout.write(str(r.status))" 2>/dev/null || echo "błąd")"
  fi
  if [[ "${ok}" == "true" && "${disc}" == "200" ]]; then
    log "OK   ${tag}  ${secs}s  discovery=${disc}  $(counts)"
  else
    FAILED=1
    log "FAIL ${tag}  ${secs}s  healthy=${ok} discovery=${disc}  $(counts)"
    docker logs --tail 60 "${AK}" 2>&1 | sed 's/^/    | /'
    break
  fi
done
AFTER="$(counts)"; log "po:     ${AFTER}"
[[ "${BASE%% migrations=*}" == "${AFTER%% migrations=*}" ]] || { log "FAIL liczności users/groups/oauth2 zmieniły się"; FAILED=1; }
exit "${FAILED}"
```

- [ ] **Step 2: Sprawdź skrypt statycznie**

Run: `chmod +x deploy/scripts/authentik_upgrade_rehearsal.sh && shellcheck deploy/scripts/authentik_upgrade_rehearsal.sh && bash -n deploy/scripts/authentik_upgrade_rehearsal.sh`
Expected: brak wyjścia, kod 0.

- [ ] **Step 3: Uruchom próbę**

Run: `sudo deploy/scripts/authentik_upgrade_rehearsal.sh 2>&1 | tee /tmp/ak-rehearsal.log; echo "exit=${PIPESTATUS[0]}"`
Expected: pięć linii `OK <tag> <s>s discovery=200 users=4 groups=5 oauth2=<n> migrations=<rosnące>`, `exit=0`. Zanotuj sumę sekund — okno produkcyjne = suma × 2 + 20 min na weryfikacje.

Jeśli `FAIL`:
- na 2025.12.x z błędem unikalności grup → usuń duplikat w produkcyjnym Authentiku, powtórz backup i próbę;
- na 2026.5.x bez `healthy` przy udanych migracjach (log bez błędów migracji, błąd bind `[::]`) → dodaj do wywołania `-e AUTHENTIK_LISTEN__HTTP=0.0.0.0:9000 -e AUTHENTIK_LISTEN__METRICS=0.0.0.0:9300`, powtórz; jeśli pomaga, Task 6 dopisuje te dwie zmienne do `x-authentik-env`;
- każdy inny błąd migracji → STOP, okno produkcyjne nie startuje; zgłoś właścicielowi z 60 liniami logu.

- [ ] **Step 4: Po próbie nie zostały kontenery ani sieć**

Run: `docker ps -a --format '{{.Names}}' | grep -c ak-rehearsal; docker network ls --format '{{.Name}}' | grep -c ak-rehearsal; ls -d /srv/kag-data/backups/.ak-rehearsal-* 2>/dev/null | wc -l`
Expected: `0`, `0`, `0`.

- [ ] **Step 5: Commit**

```bash
git add deploy/scripts/authentik_upgrade_rehearsal.sh
git commit -m "feat(ops): Authentik upgrade rehearsal on a database copy in an isolated network"
```

---

### Wspólna procedura skoku (używana w Task 3–7)

Każdy skok to te same cztery ruchy; taski poniżej podają tylko to, co jest dla danego skoku inne.

**A. Zrzut bazy tuż przed skokiem** (`<N>` = numer skoku, `<TAG>` = tag docelowy):

```bash
cd /kag/deploy/edge
docker compose stop authentik-server authentik-worker
docker exec edge-postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | zstd -q \
  | sudo tee /srv/kag-data/backups/authentik-upgrade/pre-<N>-<TAG>.sql.zst >/dev/null
zstd -t /srv/kag-data/backups/authentik-upgrade/pre-<N>-<TAG>.sql.zst && ls -la /srv/kag-data/backups/authentik-upgrade/
```
Expected: plik > 1 MB, `zstd -t` bez błędu.

**B. Podmiana digestu** (właściciel, jeśli edycja `.env` jest zablokowana dla agenta):

```bash
sudo sed -i -E 's|^AUTHENTIK_IMAGE=.*|AUTHENTIK_IMAGE=ghcr.io/goauthentik/server@<DIGEST>   # <TAG>, pin '"$(date +%F)"'|' /kag/deploy/edge/.env
docker compose -f /kag/deploy/edge/compose.yaml config -q && docker compose -f /kag/deploy/edge/compose.yaml config | grep -c '<DIGEST>'
```
Expected: `2` (server i worker).

**C. Start i oczekiwanie** (worker pierwszy — on prowadzi migracje):

```bash
cd /kag/deploy/edge
docker compose up -d authentik-worker && docker compose up -d authentik-server
for i in $(seq 1 120); do s="$(docker inspect -f '{{.State.Health.Status}}' edge-authentik-worker edge-authentik-server | tr '\n' ' ')"; [ "$s" = "healthy healthy " ] && break; sleep 5; done; echo "$s"
docker logs --since 15m edge-authentik-worker 2>&1 | grep -iE "error|traceback|migration.*fail" | head
```
Expected: `healthy healthy`, grep bez linii o nieudanej migracji.

**D. Weryfikacja skoku:**

```bash
/kag/deploy/scripts/smoke.sh | tail -3
cd /kag && node tools/ux-audit/e2e.mjs | tail -1
curl -s -o /dev/null -w '%{http_code}\n' https://status.ilovelighting.sanok.pl/
docker exec edge-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from authentik_core_user; select count(*) from authentik_core_group"'
```
Expected: smoke `FAIL=0`, E2E `10/10 PASS` (to prawdziwe logowanie OIDC przez Caddy), `302`, `4` i `5`.

**Powrót z nieudanego skoku `<N>`:** `docker compose stop authentik-server authentik-worker` → przywróć poprzedni digest w `.env` (i `git checkout -- deploy/edge/compose.yaml`, jeśli skok zmieniał compose; dla skoku 2 dodatkowo `sudo mv /srv/kag-data/edge/authentik/data/media /srv/kag-data/edge/authentik/media`) → `dropdb`/`createdb`/import `pre-<N>-<TAG>.sql.zst` wg `docs/runbooks/break-glass-authentik.md` §5 (`zstdcat plik | docker exec -i …`) → `docker compose up -d` (dla skoku 1 także `redis`) → procedura D. Nie próbuj kolejnego skoku tego samego dnia.

---

### Task 3: Skok 1 — 2025.10.4 (usunięcie Redis)

**Files:**
- Modify: `deploy/edge/compose.yaml` (linia `AUTHENTIK_REDIS__HOST: edge-redis` w `x-authentik-env`; `depends_on.redis` w `authentik-server` i `authentik-worker`; cała usługa `redis`; nagłówek pliku)
- Modify: `deploy/edge/.env.example` (wiersz `REDIS_IMAGE=…`)
- Modify: `deploy/edge/.env` (wiersz `REDIS_IMAGE=…` — poza git)

- [ ] **Step 1: Procedura A** z `<N>=1`, `<TAG>=2025.10.4`.

- [ ] **Step 2: Usuń Redis z compose**

W `deploy/edge/compose.yaml`: usuń linię `  AUTHENTIK_REDIS__HOST: edge-redis`; w obu usługach Authentika usuń z `depends_on` blok

```yaml
      redis:
        condition: service_healthy
```

usuń całą usługę `redis:` (od linii `  redis:` do pustej linii przed komentarzem `# ── Uptime Kuma`); w pierwszej linii pliku zamień `Authentik (SSO) + Postgres + Redis` na `Authentik (SSO) + Postgres`. W `deploy/edge/.env.example` i `deploy/edge/.env` usuń wiersz `REDIS_IMAGE=`.

Run: `docker compose -f deploy/edge/compose.yaml config -q && docker compose -f deploy/edge/compose.yaml config --services | sort | tr '\n' ' '`
Expected: kod 0; lista usług bez `redis` (`authentik-server authentik-worker caddy postgres`; `uptime-kuma` pojawia się tylko z `--profile monitoring`).

- [ ] **Step 3: Procedura B** z digestem `sha256:4b4f9ae106dbda902b836aa7a79d2f456b8302f090b862f7ad1bf268402730b2`, potem **procedura C**.

- [ ] **Step 4: Usuń osierocony kontener Redis jawnie**

Run: `docker rm -f edge-redis && docker ps -a --format '{{.Names}}' | grep -c '^edge-redis$'`
Expected: `edge-redis`, potem `0`.

- [ ] **Step 5: Procedura D** oraz kontrola połączeń do PG

Run: `docker exec edge-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from pg_stat_activity"'`
Expected: liczba < 60 (limit 100; przed skokiem 17).

- [ ] **Step 6: Commit**

```bash
git add deploy/edge/compose.yaml deploy/edge/.env.example
git commit -m "feat(edge): Authentik 2025.10.4 — Redis removed from the edge stack"
```

---

### Task 4: Skok 2 — 2025.12.6 (storage `/data`, RBAC)

**Files:**
- Modify: `deploy/edge/compose.yaml` (wolumen `…/authentik/media:/media` w `authentik-server` i `authentik-worker`)

- [ ] **Step 1: Nazwy grup nadal unikalne**

Run: `docker exec edge-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select name,count(*) from authentik_core_group group by name having count(*)>1"' | wc -l`
Expected: `0`. Inaczej STOP — zmień nazwę duplikatu w panelu Authentika przed skokiem.

- [ ] **Step 2: Procedura A** z `<N>=2`, `<TAG>=2025.12.6` (kontenery Authentika są po niej zatrzymane).

- [ ] **Step 3: Przenieś media pod `/data`**

```bash
sudo mkdir -p /srv/kag-data/edge/authentik/data
sudo mv /srv/kag-data/edge/authentik/media /srv/kag-data/edge/authentik/data/media
sudo chown -R 1000:1000 /srv/kag-data/edge/authentik/data
ls -la /srv/kag-data/edge/authentik/data/media
```
Expected: katalog `public` należący do uid 1000.

W `deploy/edge/compose.yaml` w OBU usługach zamień linię
`      - ${DATA_ROOT}/edge/authentik/media:/media` na `      - ${DATA_ROOT}/edge/authentik/data:/data`.

Run: `docker compose -f deploy/edge/compose.yaml config | grep -c 'target: /data$'`
Expected: `2`.

- [ ] **Step 4: Procedura B** z digestem `sha256:d4c1750e26bb7faa4d09e23305d75b54957ce4b81cee8e3acf4cc4bb8635d705`, potem **procedura C** i **D**.

- [ ] **Step 5: Role panelu nadal wynikają z grup**

E2E z procedury D loguje się kontem `kag-e2e` i otwiera strony wymagające roli (`/kb`, `/settings`). `10/10 PASS` = claim `groups` dociera. Przy `403` na tych stronach: w Authentiku sprawdź członkostwo `kag-e2e` w grupach `kag-*` i podgląd tokenu providera `kag-panel` (Applications → Providers → Preview) — claim `groups` ma zawierać nazwy grup.

- [ ] **Step 6: Commit**

```bash
git add deploy/edge/compose.yaml
git commit -m "feat(edge): Authentik 2025.12.6 — storage mounted at /data"
```

---

### Task 5: Skok 3 — 2026.2.7

**Files:** tylko `deploy/edge/.env` (poza git).

- [ ] **Step 1: Procedura A** z `<N>=3`, `<TAG>=2026.2.7`.
- [ ] **Step 2: Procedura B** z digestem `sha256:da7024c4a7136b2f0fbbae3740c5ed54633edb393b10dc4fae2cdc056b8f70a8`, potem **C** i **D**.
- [ ] **Step 3: Brak ostrzeżeń konfiguracyjnych o SCIM / `ak_groups`**

Run: `docker logs --since 15m edge-authentik-worker 2>&1 | grep -ciE "ak_groups|scim"`
Expected: `0`.

---

### Task 6: Skok 4 — 2026.5.7 (nasłuch `[::]`)

**Files:**
- Modify (tylko jeśli próba generalna to wykazała): `deploy/edge/compose.yaml` — w `x-authentik-env` dopisać `AUTHENTIK_LISTEN__HTTP: 0.0.0.0:9000` i `AUTHENTIK_LISTEN__METRICS: 0.0.0.0:9300`

- [ ] **Step 1: Procedura A** z `<N>=4`, `<TAG>=2026.5.7`.
- [ ] **Step 2:** jeśli Task 2 Step 3 wymagał zmiennych nasłuchu — dopisz je teraz do `x-authentik-env` i sprawdź `docker compose -f deploy/edge/compose.yaml config -q` (kod 0).
- [ ] **Step 3: Procedura B** z digestem `sha256:76bf433fd434c067cb25dc3e197cee793998441cda912441ea275293e76cc32c`, potem **C** i **D**.
- [ ] **Step 4: Serwer odpowiada po IPv4 z sieci `edge-net`** (tak łączy się Caddy i monitor Kumy)

Run: `docker exec edge-caddy wget -qO- http://edge-authentik-server:9000/-/health/ready/ >/dev/null && echo OK`
Expected: `OK`.
- [ ] **Step 5: Commit** (tylko gdy Step 2 zmienił compose)

```bash
git add deploy/edge/compose.yaml
git commit -m "feat(edge): Authentik 2026.5.7 — explicit IPv4 listen addresses"
```

---

### Task 7: Skok 5 — 2026.8.3 (zaufane proxy, poprawka PyJWT)

**Files:**
- Modify (tylko przy pętli przekierowań): `deploy/edge/compose.yaml` — w `x-authentik-env` dopisać `AUTHENTIK_LISTEN__TRUSTED_PROXY_CIDRS: 172.19.0.0/16`

- [ ] **Step 1: Procedura A** z `<N>=5`, `<TAG>=2026.8.3`.
- [ ] **Step 2: Procedura B** z digestem `sha256:ab9b4e8cc4ab3f8d1198d2db6aeea66bafea1963b3f2843589e0d163f97d9849`, potem **C**.
- [ ] **Step 3: Discovery podaje adresy HTTPS** (nagłówki z Caddy są honorowane)

Run: `curl -s https://auth.ilovelighting.sanok.pl/application/o/kag-panel/.well-known/openid-configuration | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['issuer']); print(all(str(v).startswith('https://') for k,v in d.items() if k.endswith('_endpoint')))"`
Expected: `https://auth.ilovelighting.sanok.pl/application/o/kag-panel/` i `True`. Jeśli `False` albo adresy `http://` — dopisz `AUTHENTIK_LISTEN__TRUSTED_PROXY_CIDRS: 172.19.0.0/16` do `x-authentik-env`, `docker compose up -d authentik-worker authentik-server`, powtórz ten krok.
- [ ] **Step 4: Procedura D** (E2E = logowanie przez Caddy; `status.*` = forward_auth przez embedded outpost, ma dać `302`).
- [ ] **Step 5: PyJWT naprawiony**

Run: `docker exec edge-authentik-server python -c "import jwt; print(jwt.__version__)"`
Expected: wersja ≥ `2.14.0`.
- [ ] **Step 6: Commit** (tylko gdy Step 3 zmienił compose)

```bash
git add deploy/edge/compose.yaml
git commit -m "feat(edge): Authentik 2026.8.3 — trusted proxy CIDR for the edge network"
```

---

### Task 8: Domknięcie — weryfikacja ręczna, skan, dokumentacja

**Files:**
- Modify: `docs/design/infra.md` (linie z `edge-redis`, `redis:7-alpine`, tabela usług i sieci, `REDIS_IMAGE=`, opis wolumenu `/media`, opis stacka edge)
- Modify: `docs/runbooks/break-glass-authentik.md` (linia `docker logs --tail 50  edge-redis`; §5 — wzmianka o katalogu `authentik-upgrade` i braku downgrade'u)
- Modify: `deploy/scripts/kuma_seed_monitors.sh:129` (opis „Readiness sprawdza Postgres i Redis Authentika")
- Modify: `deploy/scripts/update_check.sh:82,203` (przykłady `redis 7->8`, `authentik 2025.8->2026.x`)
- Modify: `docs/design/PLAN.md` (sekcja „Zmiany decyzji po zatwierdzeniu" — APPEND)
- Modify: `docs/ops/cve-baseline-log.md` (nowy wiersz)

- [ ] **Step 1: Wersja w interfejsie**

Właściciel: `https://auth.ilovelighting.sanok.pl/if/admin/` → Dashboards → Overview pokazuje `2026.8.3`, bez ostrzeżeń „outpost version mismatch".

- [ ] **Step 2: Ręczne logowanie administratora z MFA**

Właściciel loguje się w oknie prywatnym kontem `akadmin` (hasło + drugi składnik) do Authentika i do panelu `https://kag.ilovelighting.sanok.pl`. Oczekiwane: oba logowania udane, w panelu rola administratora (widoczne Ustawienia). Jeśli MFA nie przechodzi: `docker exec edge-authentik-server ak create_recovery_key 1 akadmin` (link jest sekretem — osobna sesja SSH, nie ta rozmowa) i ponowna rejestracja urządzenia.

- [ ] **Step 3: Zadania w tle działają bez Redis**

Run: `docker logs --since 30m edge-authentik-worker 2>&1 | grep -ciE "redis|connection refused"`
Expected: `0`.

- [ ] **Step 4: Monitoring zielony**

Run: `bash /kag/.claude/skills/kag-daily-ops/scripts/status.sh | sed -n '/failed/p;/## kontenery/,/## backup/p;/## push-monitory/,/## bazy/p'`
Expected: `failed: 0`, `wszystkie healthy`, wszystkie push-monitory `UP`. W Kumie (`https://status.ilovelighting.sanok.pl`) monitory „Authentik — liveness" i „Authentik — readiness" zielone.

- [ ] **Step 5: Zaktualizuj dokumentację**

- `docs/design/infra.md`: usuń `edge-redis` z diagramu, tabeli usług i opisu sieci `edge-internal`; usuń `redis:7-alpine` i `REDIS_IMAGE=`; wolumen Authentika opisz jako `${DATA_ROOT}/edge/authentik/data:/data`; w opisie stacka edge „Caddy + Authentik server/worker + PostgreSQL".
- `docs/runbooks/break-glass-authentik.md`: usuń linię z `edge-redis`; w §5 dopisz zdanie: „Authentik nie wspiera downgrade'u — powrót na starsze wydanie to zawsze poprzedni digest ORAZ zrzut bazy sprzed podbicia (`/srv/kag-data/backups/authentik-upgrade/pre-<N>-<tag>.sql.zst`)."
- `deploy/scripts/kuma_seed_monitors.sh:129`: „Readiness sprawdza Postgres Authentika — odróżnia „proces żyje" od „proces działa"."
- `deploy/scripts/update_check.sh`: w obu komentarzach usuń przykład Redis, a `authentik 2025.8->2026.x` zamień na `authentik 2026.8->2026.11`.
- `docs/design/PLAN.md`, na końcu sekcji „Zmiany decyzji po zatwierdzeniu": wpis z datą wykonania — „Stack edge bez Redis: Authentik ≥ 2025.10 trzyma cache, zadania i sesje w PostgreSQL. Dowód: `deploy/edge/compose.yaml` (brak usługi `redis`), commit `feat(edge): Authentik 2025.10.4 — Redis removed from the edge stack`. Wersja Authentika: 2026.8.3 (pin digestem w `deploy/edge/.env`)."

Run: `grep -rn -i "redis" deploy/edge deploy/scripts docs/design/infra.md docs/runbooks | grep -v "\.env:" | grep -vi "audit-2026" ; bash -n deploy/scripts/kuma_seed_monitors.sh deploy/scripts/update_check.sh && shellcheck deploy/scripts/update_check.sh`
Expected: grep bez wyników, składnia i shellcheck bez błędów.

- [ ] **Step 6: Skan CVE i baza odniesienia**

```bash
sudo /kag/deploy/scripts/cve_scan.sh | grep -E "razem|BŁĄD"
python3 -c "import json;s=json.load(open('/srv/kag-data/security/cve/summary.json'));print(s['scanErrors'],[ (k.split('@')[0][-28:],v['count'],v.get('critical')) for k,v in s['new']['newByImage'].items()])"
```
Expected: `błędów skanu: 0`; nowy digest Authentika pojawia się jako „nowy obraz", bez `CVE-2026-102268` na liście krytycznych; obrazu `redis` nie ma w skanie. Po przeglądzie: wiersz w `docs/ops/cve-baseline-log.md` (data, raport, liczby CRITICAL/HIGH Authentika przed: 13/209 i po, decyzja „re-baseline po podbiciu Authentika 2025.8.6 → 2026.8.3; `CVE-2026-102268` usunięty; obraz redis wycofany"), następnie `sudo /kag/deploy/scripts/cve_scan.sh --update-baseline` i skan kontrolny (`nowych względem baseline: 0`).

- [ ] **Step 7: Nocny backup i weryfikacja odtwarzania rozumieją nowy stan**

Run: `sudo systemctl start kag-backup.service; systemctl is-failed kag-backup.service; sudo systemctl start kag-backup-verify.service; systemctl is-failed kag-backup-verify.service`
Expected: dwa razy `inactive`; w `status.sh` `verify … authentik_pg_restore ok=True`.

- [ ] **Step 8: Commit, PR, sprzątanie**

```bash
git add docs deploy/scripts
git commit -m "docs(edge): Authentik 2026.8.3 — runbooks, infra design, decision log, CVE baseline entry"
git push -u origin ops/authentik-upgrade
gh pr create --base main --title "ops: Authentik 2025.8.6 → 2026.8.3 (Redis removed, storage at /data)" --body "Plan: docs/superpowers/plans/2026-10-05-authentik-upgrade.md"
```
Zrzuty `pre-<N>-*.sql.zst` zostają 14 dni (do pierwszej udanej niedzielnej weryfikacji odtwarzania i jednego pełnego cyklu off-site), potem `sudo rm -r /srv/kag-data/backups/authentik-upgrade` — po potwierdzeniu właściciela.

---

## Decyzje dla właściciela przed startem

1. **Termin okna** — wieczór dnia roboczego albo weekend; w oknie nie da się zalogować do panelu ani `status.*` (MCP i trwające sesje działają).
2. **Jedno okno czy dwa** — rekomendacja: jedno okno na wszystkie pięć skoków, jeśli próba generalna przejdzie czysto (krótszy łączny przestój, jeden komplet testów końcowych). Wariant ostrożny: skoki 1–2 (zmiany w compose) jednego dnia, 3–5 następnego.
3. **Kto edytuje `deploy/edge/.env`** — agent albo właściciel (pięć komend `sed` z procedury B).

## Dziennik wykonania

**Wykonano 2026-10-05, jedno okno 11:21–11:30 CEST (ok. 9 minut łącznej niedostępności logowania, w pięciu krótkich przerwach).**

- Preflight: stan zdrowy, smoke 6/6, E2E 10/10; aplikacje: `kag-panel` (OIDC) i `status-monitor` (proxy) — żadna nie czyta `email_verified`. Pełny backup `2026-10-05_110935` z kopią off-site przed startem.
- Próba generalna na snapshocie `2026-10-05_032332`: 2025.10.4 24 s, 2025.12.6 40 s, 2026.2.7 29 s, 2026.5.7 24 s, 2026.8.3 68 s; discovery 200 po każdym; `users=4 groups=5 oauth2=2`, migracje 611 → 777. Pierwsze podejście dało fałszywy FAIL na 2025.12.6 (kontrola discovery ścigała się ze startem aplikacji) — skrypt dostał ponawianie.
- Produkcja: po każdym skoku `healthy healthy`, discovery 200, smoke 6/6, E2E 10/10, `status.*` 302, 4 użytkowników, 17 połączeń do PG. Zrzuty `pre-1…pre-5` w `/srv/kag-data/backups/authentik-upgrade/`.
- Odstępstwa i obserwacje:
  - Skok 2: w logu workera dwa wyjątki `UndefinedColumn … pagination_default_page_size` SPRZED zwolnienia blokady migracji (worker odpytał bazę, zanim serwer skończył migrację dodającą tę kolumnę). Jednorazowe, kolumna istnieje, bez powtórek.
  - Zrzut bazy skurczył się z 60 MB do 11 MB po skoku 1 (migracja 2025.10 czyści stare tabele zadań/sesji); liczności kont, grup i providerów bez zmian.
  - Grup jest 6, nie 5: wydania 2026.x dokładają wbudowane `authentik Read-only` i `authentik Agent-Users` (bez uprawnień superużytkownika). Próba tego nie pokazała, bo uruchamiała sam serwer bez workera (blueprinty stosuje worker).
  - Zmienne nasłuchu i `TRUSTED_PROXY_CIDRS` okazały się niepotrzebne (IPv6 w kontenerze, sieć Caddy w domyślnym zakresie zaufanych).
  - **Cel CVE osiągnięty częściowo**: obraz 13 CRITICAL / 209 HIGH → 3 / 72, ale `CVE-2026-102268` zostaje — 2026.8.3 niesie `PyJWT` 2.13.0 (poprawka w 2.14.0). Założenie planu, że najnowsze wydanie ma poprawkę, było błędne; do zamknięcia kolejnym patchem linii 2026.8.
  - `deploy/edge/.env`: zmienne `AUTHENTIK_IMAGE_CHECK_TAG` (ma być `2026.8`) i `REDIS_IMAGE_CHECK_TAG` (do usunięcia) poprawia właściciel — edycja zablokowana dla agenta.
- Do wykonania przez właściciela: Task 8 Step 1–2 (wersja w interfejsie, ręczne logowanie `akadmin` z MFA).
