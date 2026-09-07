# Disaster recovery: pełne odtworzenie na czystym serwerze

Scenariusz: serwer stracony (awaria hosta, dysk, kompromitacja). Masz **snapshot backupu**
— katalog `/srv/kag-data/backups/nightly/<STAMP>/` skopiowany wcześniej na zewnętrzny
nośnik/offsite. Wszystkie artefakty bierz z **JEDNEGO** snapshotu (mieszanie dat =
rozjazd MySQL↔Neo4j: projekty i joby przestaną się zgadzać z grafem).

## Cele (RPO/RTO) i ostatni pomiar

| Parametr | Cel | Stan zmierzony |
|---|---|---|
| RPO (dopuszczalna utrata danych) | **24 h** | 24 h 10 min — `kag-backup.timer` o 03:20 + `RandomizedDelaySec=10m`, brak WAL/binlog shipping |
| RTO (czas do działającego systemu) | **4 h** | drill 2026-09-06: same datastores **183 s**, cała próba end-to-end **482 s**; kroki 1-2 (OS, docker, `git clone`, bootstrap, `docker load` 3,5 GB, build panel/mcp) **niezmierzone** |

Drill 2026-09-06 (snapshot `2026-09-06_032942`, 1,1 GB): PASS dla MySQL, Neo4j, MinIO,
SQLite panelu i plików panelu; polecenia z tego runbooka pochodzą wprost z niego.
Świadome ryzyko RPO: SQLite panelu jest źródłem prawdy o recenzowanej treści, więc
utrata doby = utrata dnia pracy recenzentów i kluczy MCP wydanych tego dnia
(dzień drillu: audyt 25→49 wpisów, klucze API 4→8).

## Zawartość snapshotu

Nazwy plików są **kontraktem** — pilnuje ich `deploy/scripts/restore.sh` (jedyne źródło
prawdy) i cotygodniowy `verify_backup.sh` (check `docs_artifacts`). Potwierdź w
`_manifest.json` (`files[].name`).

| Plik w snapshocie | Cel przywracania |
|---|---|
| `mysql.sql.zst` | rejestr projektów/jobów/konfiguracji OpenSPG |
| `neo4j-data.tar.zst` | graf wiedzy (archiwum zawiera katalog `data/`) |
| `minio.tar.zst` | pliki builderowe (archiwum zawiera katalog `minio/`) |
| `panel.sqlite` | użytkownicy, drafty, klucze MCP, audyt, rejestr KB, klucze LLM |
| `panel-files.tar.zst` | bloby intake'ów, eksporty CSV, logi akcji, usage MCP |
| `panel-audit.tar.zst` | audyt JSONL panelu (hash-chain) |
| `authentik-pg.sql.zst` | całe SSO (pg_dump, BEZ `CREATE DATABASE`) |
| `caddy-data.tar.zst` | certy Let's Encrypt (oszczędza limity LE) |
| `kuma.tar.zst` | Uptime Kuma: konto admina, monitory, powiadomienia, historia, pliki (`kuma.db` + `db-config.json` + `upload/`, `screenshots/`) |
| `env-edge.env`, `env-kag.env` | sekrety — bez nich reszta backupu jest bezużyteczna |
| `repo-state.txt` | SHA commitu, na którym stał system (do `git checkout`) |
| `edge-compose.yaml`, `kag-compose.yaml`, `*-compose.ps.txt` | stan stacków w chwili backupu |
| `SHA256SUMS`, `_manifest.json` | kontrola kompletności i sum |

Obrazy kontenerów są **poza** snapshotem: `/srv/kag-data/backups/images/<repo>@<digest>.tar.zst`
(`deploy/scripts/save_images.sh`). Bez nich DR zależy od dostępności rejestru Aliyun.

> **Snapshot = żywy sekret.** Zawiera oba `.env`, klucz LLM w dumpie MySQL i klucze prywatne
> certów. Trzymaj go 0700/root, a poza host wypuszczaj tylko zaszyfrowany (patrz krok 0b).
> Po każdym incydencie z backupem traktuj klucze jak skompromitowane i zrotuj je (krok 5).

**Krok 0a — weryfikacja snapshotu (zanim cokolwiek postawisz):**

```bash
SNAP=/srv/kag-data/backups/nightly/<STAMP>
jq '.ok, .neo4jMode, .neo4jCheckpoint, .buildsRunning, .warnings' "$SNAP/_manifest.json"
( cd "$SNAP" && sha256sum -c --quiet SHA256SUMS ) && echo "sumy OK"
```

`ok:false` = snapshot niekompletny — sięgnij po starszy. `neo4jMode: hot` + `buildsRunning > 0`
oznacza tar grafu zrobiony w trakcie zapisów; jeśli graf po odtworzeniu wygląda podejrzanie,
użyj miesięcznego snapshotu `cold` i przebuduj nowsze dokumenty (sekcja 4, punkt końcowy).

**Krok 0b — snapshot z off-site jest ZASZYFROWANY** (`<STAMP>.tar.age` lub `<STAMP>.tar.gpg`;
obok leży jawny `<STAMP>._manifest.json` do kontroli kompletności). Odszyfruj kluczem
PRYWATNYM operatora (nigdy nie trzymanym na tym hoście — menedżer haseł):

```bash
mkdir -p /srv/kag-data/backups/nightly && cd /srv/kag-data/backups/nightly
age -d -i /media/klucz/age-backup.key <STAMP>.tar.age | tar -x     # wariant age
gpg --decrypt <STAMP>.tar.gpg | tar -x                             # wariant gpg
chmod -R go-rwx /srv/kag-data/backups/nightly/<STAMP>
```

## 1. Podstawa systemu

1. OS + SSH, Docker Engine + compose-plugin, `git`, `zstd`, `jq`, `age`/`gpg`.
2. `sudo git clone git@github.com:RobertBirek/PomagierKB.git /kag`
   — potem `git checkout <commit z repo-state.txt>`, żeby kod zgadzał się ze snapshotem.
3. DNS: jeżeli serwer ma **nowy IP** — przestaw rekordy A `auth.` i `kag.` PRZED startem
   Caddy (limity Let's Encrypt; patrz `docs/deployment.md` §1). Przy przywróconych
   certach z backupu Caddy nie musi od razu niczego wystawiać.

## 2. Bootstrap i sekrety

```bash
sudo /kag/deploy/scripts/bootstrap.sh     # edge-net, katalogi /srv/kag-data, swap 8G, tessdata
sudo /kag/deploy/scripts/restore.sh --snapshot "$SNAP" --only images,env
```

`--only env` instaluje `$SNAP/env-edge.env` → `/kag/deploy/edge/.env` i
`$SNAP/env-kag.env` → `/kag/deploy/kag/.env` (0600, root).

**KRYTYCZNE:** używaj `.env` z backupu, nie nowych sekretów. Muszą się zgadzać:
`AUTHENTIK_SECRET_KEY` ↔ dane w PG, hasła MySQL ↔ dump, `MINIO_ROOT_*` ↔ dane minio,
hasło Neo4j ↔ tar grafu. Wygenerowanie świeżych sekretów = nieczytelne dane.

## 3. Przywracanie danych — kolejność obowiązkowa

**UWAGA:** wolumeny datastores przywracaj **PRZED pierwszym startem** ich kontenerów.
Świeżo wystartowany Neo4j/minio zainicjalizuje pusty katalog i pomiesza stan — jeżeli
coś wystartowało za wcześnie: `docker compose down`, wyczyść dany katalog, przywróć,
start od nowa. `restore.sh` odmawia pracy przy działającym kontenerze i odsuwa istniejące
dane na bok jako `*.pre-restore-<stamp>` (nie kasuje ich).

Najpierw **zawsze** obejrzyj plan:

```bash
sudo /kag/deploy/scripts/restore.sh --snapshot "$SNAP" --all --dry-run
```

### 3a. Pliki (przed startem kontenerów)

```bash
sudo /kag/deploy/scripts/restore.sh --snapshot "$SNAP" \
  --only caddy,neo4j,minio,panel-sqlite,panel-files,panel-audit
```

Równoważnik ręczny (użyty w drillu 2026-09-06 — trzymaj się DOKŁADNIE tych nazw):

```bash
zstd -dc $SNAP/caddy-data.tar.zst  | sudo tar -C /srv/kag-data/edge/caddy -x
zstd -dc $SNAP/neo4j-data.tar.zst  | sudo tar -C /srv/kag-data/kag/neo4j  -x   # → .../neo4j/data
zstd -dc $SNAP/minio.tar.zst       | sudo tar -C /srv/kag-data/kag        -x   # → .../minio
sudo install -o 10001 -g 10001 -m 600 $SNAP/panel.sqlite /srv/kag-data/kag/panel/db/kag.db
zstd -dc $SNAP/panel-files.tar.zst | sudo tar -C /srv/kag-data/kag/panel  -x
zstd -dc $SNAP/panel-audit.tar.zst | sudo tar -C /srv/kag-data/kag/panel  -x
sudo chown -R 10001:10001 /srv/kag-data/kag/panel
```

> **Nazwa pliku docelowego bazy panelu to `kag.db`, nie `panel.sqlite`.** Panel czyta
> `${DATA_DIR}/db/kag.db` (compose: `DATA_DIR=/data`). Każda inna nazwa = panel utworzy
> pustą bazę przez migracje i **zaraportuje sukces** — cicha utrata draftów, kluczy MCP,
> audytu i rejestru KB (to dokładnie klasa błędu z 2026-09-03).

### 3b. Stack edge + dump Authentika

```bash
cd /kag/deploy/edge
docker compose up -d postgres redis
watch docker compose ps                       # postgres healthy

sudo /kag/deploy/scripts/restore.sh --snapshot "$SNAP" --only authentik-pg
# równoważnik ręczny (dump BEZ CREATE DATABASE — baza powstaje z compose):
#   zstd -dc $SNAP/authentik-pg.sql.zst | docker exec -i edge-postgres \
#     sh -c 'exec psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

docker compose up -d                          # caddy + authentik server/worker
watch docker compose ps
```

Weryfikacja: `https://auth.ilovelighting.sanok.pl` odpowiada, logowanie akadmin działa
(przy problemach: `docs/runbooks/break-glass-authentik.md`).

### 3c. Stack kag + dump MySQL

```bash
cd /kag/deploy/kag
docker compose up -d mysql
docker compose logs -f mysql   # CZEKAJ na DRUGIE "ready for connections" (init entrypointu)

sudo /kag/deploy/scripts/restore.sh --snapshot "$SNAP" --only mysql
# równoważnik ręczny (hasło przez MYSQL_PWD — nigdy w argv; TCP, bo serwer tymczasowy
# entrypointu MariaDB słucha tylko na sockecie i import w jego oknie ubija kontener):
#   zstd -dc $SNAP/mysql.sql.zst | docker exec -i release-openspg-mysql \
#     sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -h127.0.0.1 --protocol=tcp -uroot'

docker compose build panel mcp
docker compose up -d
watch docker compose ps        # openspg-server: start_period 120s, healthy po ~2-4 min
```

Jeżeli rejestr Aliyun (`spg-registry.us-west-1.cr.aliyuncs.com`) jest niedostępny, obrazy
przywraca krok 2 (`--only images`); ręcznie:

```bash
for f in /srv/kag-data/backups/images/*.tar.zst; do zstd -dc "$f" | docker load; done
```

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
7. Zmierz i **zapisz w tym pliku** czas całego odtworzenia — to jedyny sposób, by RTO
   przestało być deklaracją.

Jeżeli graf wygląda na niespójny (hot-tar DozerDB — znane ryzyko, patrz `neo4jMode`
i `buildsRunning` w manifeście): użyj ostatniego **zimnego** snapshotu miesięcznego Neo4j,
a dokumenty nowsze niż on przebuduj z panelu (manifesty eksportów w SQLite pozwalają
wznowić buildy).

## 5. Domknięcie

```bash
sudo cp /kag/deploy/systemd/kag-backup*.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kag-backup.timer kag-backup-verify.timer kag-backup-cold.timer
sudo systemctl start kag-backup.service      # pierwszy backup NOWEGO serwera od razu
sudo systemctl start kag-backup-verify.service
```

- Sprawdź manifest pierwszego backupu (`ok:true`) i raport verify (`ok:true`).
- Przywróć wysyłkę offsite: `BACKUP_OFFSITE_TARGET` **oraz** `BACKUP_AGE_RECIPIENT`
  (albo `BACKUP_GPG_RECIPIENT`) — bez odbiorcy szyfrowania backup **nie wyśle nic**
  (status `blocked_no_encryption`). Klucz prywatny zostaje poza hostem.
- Usuń katalogi `*.pre-restore-<stamp>` dopiero po potwierdzeniu, że system działa.
- Po incydencie z możliwą kompromitacją (a odtworzenie z backupu zawsze nim jest, jeśli
  snapshot mógł wyciec): zrotuj klucze LLM (Ustawienia), klucze MCP (rotate w panelu),
  hasła w `.env` — pamiętając, że rotacja haseł datastores wymaga zmiany po obu stronach
  (baza + `.env`).
