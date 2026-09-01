# Disaster recovery: pełne odtworzenie na czystym serwerze

Scenariusz: serwer stracony (awaria hosta, dysk, kompromitacja). Masz **snapshot backupu**
— katalog `/srv/kag-data/backups/nightly/<STAMP>/` skopiowany wcześniej na zewnętrzny
nośnik/offsite. Wszystkie artefakty bierz z **JEDNEGO** snapshotu (mieszanie dat =
rozjazd MySQL↔Neo4j: projekty i joby przestaną się zgadzać z grafem).

Zawartość snapshotu (nazwy plików potwierdź w `_manifest.json`):

| Artefakt | Cel przywracania |
|---|---|
| dump MySQL (mysqldump) | rejestr projektów/jobów/konfiguracji OpenSPG |
| tar.zst `neo4j/data` | graf wiedzy |
| tar.zst `minio` | pliki builderowe |
| kopia SQLite panelu | użytkownicy, drafty, klucze MCP, audyt, rejestr KB |
| pg_dump Authentika | całe SSO |
| tar `edge/caddy/data` | certy Let's Encrypt (oszczędza limity LE) |
| kopie `.env` (edge + kag) | sekrety — bez nich reszta backupu jest bezużyteczna |
| `_manifest.json`, compose config/ps | kontrola kompletności i sum sha256 |

**Krok 0 — weryfikacja snapshotu (zanim cokolwiek postawisz):**

```bash
cat <SNAPSHOT>/_manifest.json | jq '.ok, .warnings'
sha256sum -c ...           # wg sum w manifeście
zstd -t <SNAPSHOT>/*.zst   # test integralności archiwów
```

## 1. Podstawa systemu

1. OS + SSH, Docker Engine + compose-plugin, `git`, `zstd`, `jq`.
2. `sudo git clone git@github.com:RobertBirek/PomagierKB.git /kag`
3. DNS: jeżeli serwer ma **nowy IP** — przestaw rekordy A `auth.` i `kag.` PRZED startem
   Caddy (limity Let's Encrypt; patrz `docs/deployment.md` §1). Przy przywróconych
   certach z backupu Caddy nie musi od razu niczego wystawiać.

## 2. Bootstrap i sekrety

```bash
sudo /kag/deploy/scripts/bootstrap.sh     # edge-net, katalogi /srv/kag-data, swap 8G, tessdata
sudo install -m 600 <SNAPSHOT>/env-edge /kag/deploy/edge/.env
sudo install -m 600 <SNAPSHOT>/env-kag  /kag/deploy/kag/.env
```

**KRYTYCZNE:** używaj `.env` z backupu, nie nowych sekretów. Muszą się zgadzać:
`AUTHENTIK_SECRET_KEY` ↔ dane w PG, hasła MySQL ↔ dump, `MINIO_ROOT_*` ↔ dane minio,
hasło Neo4j ↔ tar grafu. Wygenerowanie świeżych sekretów = nieczytelne dane.

## 3. Przywracanie danych — kolejność obowiązkowa

**UWAGA:** wolumeny datastores przywracaj **PRZED pierwszym startem** ich kontenerów.
Świeżo wystartowany Neo4j/minio zainicjalizuje pusty katalog i pomiesza stan — jeżeli
coś wystartowało za wcześnie: `docker compose down`, wyczyść dany katalog, przywróć,
start od nowa.

### 3a. Stack edge

```bash
# certy + media (przed startem caddy/authentika)
sudo tar -C /srv/kag-data/edge/caddy -xf <SNAPSHOT>/caddy-data.tar

cd /kag/deploy/edge
docker compose up -d postgres redis
watch docker compose ps                       # postgres healthy

# świeży wolumen PG utworzył pustą bazę $POSTGRES_DB — wgraj dump
docker exec -i edge-postgres sh -lc 'psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < <SNAPSHOT>/authentik-pg.sql

docker compose up -d                          # caddy + authentik server/worker
watch docker compose ps
```

Weryfikacja: `https://auth.ilovelighting.sanok.pl` odpowiada, logowanie akadmin działa
(przy problemach: `docs/runbooks/break-glass-authentik.md`).

### 3b. Dane stacka kag (pliki, przed startem kontenerów)

```bash
sudo zstdcat <SNAPSHOT>/neo4j.tar.zst | sudo tar -C /srv/kag-data/kag/neo4j -x   # → .../neo4j/data
sudo zstdcat <SNAPSHOT>/minio.tar.zst | sudo tar -C /srv/kag-data/kag -x         # → .../minio
sudo install -o 10001 -g 10001 -m 600 <SNAPSHOT>/panel.sqlite3 /srv/kag-data/kag/panel/db/
# (dokładne ścieżki wewnątrz tarów potwierdź w _manifest.json; audyt JSONL panelu analogicznie)
```

### 3c. Stack kag

```bash
cd /kag/deploy/kag
docker compose up -d mysql
watch docker compose ps        # mysql healthy; mysql-init założył użytkownika openspg_app

# dump z --databases zawiera CREATE DATABASE — wgrywamy wprost
docker exec -i release-openspg-mysql sh -lc 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD"' \
  < <SNAPSHOT>/mysql.sql

docker compose build panel mcp
docker compose up -d
watch docker compose ps        # openspg-server: start_period 120s, healthy po ~2-4 min
```

Jeżeli rejestr Aliyun (`spg-registry.us-west-1.cr.aliyuncs.com`) jest niedostępny,
załaduj obrazy z lokalnej kopii: `zstdcat .../images/openspg-images.tar.zst | docker load`.

## 4. Weryfikacja (smoke)

```bash
docker compose -f /kag/deploy/edge/compose.yaml ps
docker compose -f /kag/deploy/kag/compose.yaml ps      # wszystko healthy
sudo /kag/deploy/scripts/smoke.sh
```

Następnie ręcznie:

1. Logowanie do panelu kontem `kag-admin` (sesje sprzed awarii wygasły — to normalne).
2. Bazy wiedzy: rejestr kompletny, statusy `active`.
3. **Zapytaj**: pytanie o znaną treść → odpowiedź z cytowaniami (dowód, że graf i wektory
   wróciły spójnie).
4. Ustawienia → System: historia akcji/audyt obecne; test połączenia LLM przechodzi
   (klucze LLM żyją w SQLite panelu — wróciły z bazą).
5. Klucz MCP: `initialize` + `tools/list` + testowe `kb_search`.
6. `docker ps` — porty tylko 80/443 przy caddy.

Jeżeli graf wygląda na niespójny (Neo4j z hot-tara potrafi być uszkodzony — znane ryzyko
DozerDB): użyj ostatniego **zimnego** snapshotu miesięcznego Neo4j, a dokumenty nowsze
niż on przebuduj z panelu (manifesty eksportów w SQLite pozwalają wznowić buildy).

## 5. Domknięcie

```bash
sudo cp /kag/deploy/systemd/kag-backup*.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kag-backup.timer kag-backup-verify.timer
sudo systemctl start kag-backup.service      # pierwszy backup NOWEGO serwera od razu
```

- Sprawdź manifest pierwszego backupu (`ok:true`).
- Przywróć wysyłkę offsite (`BACKUP_OFFSITE_TARGET`), jeśli była skonfigurowana.
- Po incydencie z możliwą kompromitacją: zrotuj klucze LLM (Ustawienia), klucze MCP
  (rotate w panelu), hasła w `.env` — pamiętając, że rotacja haseł datastores wymaga
  zmiany po obu stronach (baza + `.env`).
