# Break-glass: awaria Authentika (SSO leży — nikt się nie zaloguje)

Authentik jest pojedynczym punktem blokady logowania: gdy leży, **nowe logowania do
panelu nie działają** (OIDC), podobnie forward-auth na `/openspg`. Co nadal działa:

- **istniejące sesje panelu** — cookie `kag_sid` żyje w SQLite panelu, ważne do
  wygaśnięcia (absolutnie 12 h / idle 60 min),
- **MCP w całości** — klucze `sk-...` są weryfikowane lokalnie przez kag-mcp, bez SSO,
- cały stack kag (OpenSPG, pipeline, backupy).

Nie panikuj i nie restartuj wszystkiego na ślepo — idź po kolei.

## 1. Diagnoza (przez SSH)

```bash
docker ps --filter name=edge- --format '{{.Names}}\t{{.Status}}'
docker logs --tail 200 edge-authentik-server
docker logs --tail 200 edge-authentik-worker
docker logs --tail 100 edge-postgres
docker logs --tail 50  edge-redis
docker inspect --format '{{json .State.Health}}' edge-authentik-server
df -h /srv /var/lib/docker        # pełny dysk to częsta przyczyna padu PG
```

Typowe przyczyny:

| Objaw w logach | Przyczyna | Ruch |
|---|---|---|
| `connection refused` do postgres / `pg_isready` fail | PG nie wstał / dysk pełny | napraw dysk (`typowe-awarie.md` §1), restart PG |
| błędy migracji przy starcie | nieudany upgrade Authentika | wróć na poprzedni digest w `.env` + przywróć PG z backupu (§4) |
| `SECRET_KEY` / błędy deszyfrowania | zmieniony `AUTHENTIK_SECRET_KEY` w `.env` | przywróć poprzednią wartość (menedżer haseł / backup `.env`) |
| server healthy, ale 502 na auth.* | Caddy | `docker logs edge-caddy`, restart caddy |

## 2. Restart stacka edge

```bash
cd /kag/deploy/edge
docker compose restart authentik-worker authentik-server
watch docker compose ps       # ak healthcheck ~1-2 min
```

Jeśli to nie pomaga — pełny cykl (dane są na bind mountach, `down` ich nie rusza):

```bash
docker compose down
docker compose up -d
```

**UWAGA — nieodwracalne:** NIGDY `docker compose down -v` i nigdy nie kasuj
`/srv/kag-data/edge/authentik/postgres` — to cała baza SSO.

Weryfikacja po starcie:

```bash
curl -fsS https://auth.ilovelighting.sanok.pl/application/o/kag-panel/.well-known/openid-configuration -o /dev/null -w '%{http_code}\n'
```

i testowe logowanie do panelu w przeglądarce.

## 3. Odzyskanie konta akadmin (utracone hasło / MFA)

Authentik działa, ale nikt nie ma dostępu administracyjnego:

```bash
docker exec edge-authentik-server ak create_recovery_key 10 akadmin
```

Komenda wypisze jednorazowy link `https://auth.ilovelighting.sanok.pl/recovery/use-token/...`.
Otwarcie linku loguje jako `akadmin` bez hasła i MFA.

**UWAGA:** link = pełne przejęcie administratora; argument `10` to ważność klucza
**w latach**. Po użyciu: ustaw nowe hasło akadmin i **usuń token** w
Directory → Tokens & App passwords. Linku nie wysyłaj otwartym kanałem.

## 4. Dostęp awaryjny, gdy panel niedostępny (SSO leży dłużej)

Do czasu naprawy SSO operacje wykonuj przez SSH — **nie** wystawiaj tymczasowo portów
(`-p 8887:8887` itp. jest zakazane) i nie wyłączaj auth w panelu.

```bash
# stan stacka kag
docker compose -f /kag/deploy/kag/compose.yaml ps

# API OpenSPG od środka (przykład: lista projektów)
docker run --rm --network kag_kag-internal curlimages/curl -fsS \
  'http://release-openspg-server:8887/v1/projects/list?isOwner=false&keyword=&pageNo=1&pageSize=200&appId=0'

# healthz panelu/mcp od środka
docker run --rm --network kag_kag-internal curlimages/curl -fsS http://kag-panel:8080/healthz
```

Agenci korzystający z MCP pracują dalej (Bearer) — poinformuj tylko użytkowników panelu.

## 5. Przywracanie Authentika z backupu Postgresa

Kiedy: nieudany upgrade, uszkodzona baza, skasowana konfiguracja. Backup nocny zawiera
`pg_dump` (snapshot w `/srv/kag-data/backups/nightly/<stamp>/` — nazwę pliku sprawdź
w `_manifest.json`).

**UWAGA — nieodwracalne:** restore nadpisuje bieżącą bazę SSO. Konta/grupy/tokeny
utworzone PO dacie backupu przepadną. Najpierw zrób zrzut stanu bieżącego:

```bash
cd /kag/deploy/edge
docker compose stop authentik-server authentik-worker     # postgres zostaje
docker exec edge-postgres sh -lc 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  > /srv/kag-data/backups/authentik-pre-restore-$(date +%F-%H%M).sql
```

Kolejność przywracania:

```bash
# 1) drop + create bazy (server/worker już zatrzymane)
docker exec edge-postgres sh -lc 'dropdb   -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker exec edge-postgres sh -lc 'createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'

# 2) wgranie dumpu (jeśli plik jest .zst: zstdcat plik | docker exec -i ...)
docker exec -i edge-postgres sh -lc 'psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < /srv/kag-data/backups/nightly/<STAMP>/authentik-pg.sql

# 3) start worker → server, czekaj na healthy
docker compose up -d authentik-worker authentik-server
watch docker compose ps
```

Weryfikacja: discovery 200 (komenda w §2), logowanie do panelu, forward-auth (jeśli
`/openspg` włączony). Jeżeli po backupie rotowano Client Secret providera `kag-panel`,
restore cofnął go — uzgodnij z `PANEL_OIDC_CLIENT_SECRET` w `deploy/kag/.env`
(wartość widać w Authentiku: Providers → kag-panel-oidc) i zrestartuj panel.

## 6. Gdy padło więcej niż Authentik

Serwer nie żyje / dysk stracony → pełna procedura `docs/runbooks/disaster-recovery.md`.
