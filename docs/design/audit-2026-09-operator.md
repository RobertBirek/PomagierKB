# Zadania operatora — audyt PomagierKB 2026-09-06

Rzeczy, których faza naprawcza **nie mogła** wykonać: wymagają sekretów, decyzji biznesowej,
uprawnień poza zakresem sesji albo przerwy w działaniu. Kod i konfiguracja są przygotowane —
tutaj są brakujące kroki.

Kolejność w sekcjach = kolejność wykonania.

---

## A. Wymaga decyzji i pieniędzy (P0/P1)

### A1. Kopia off-site (D5-02, P0)
Dziś wszystkie snapshoty i archiwum obrazów leżą **na tym samym dysku co dane produkcyjne**.
Awaria dysku, pomyłkowe `rm -rf` albo ransomware kasują jednocześnie system i wszystkie kopie.
Backup jest sprawdzony (pełny drill DR przeszedł), ale nie przetrwa utraty hosta.

Wymagane: cel off-site (S3-compatible, Backblaze B2, inny VPS, NAS) + `rclone` na hoście
(dziś **brak**) + hasło szyfrowania w `/etc/kag/backup.env`.

```bash
apt-get install -y rclone
rclone config                       # utwórz remote, np. "offsite"
# dopisz do deploy/kag/.env:
#   BACKUP_OFFSITE_TARGET=offsite:pomagierkb-backups
#   BACKUP_OFFSITE_PASSPHRASE_FILE=/etc/kag/backup-passphrase
install -m 600 /dev/null /etc/kag/backup-passphrase   # wpisz hasło (menedżer haseł!)
```

**Uwaga krytyczna:** snapshot zawiera `env-edge.env`, `env-kag.env` i wyrenderowany
`kag-compose.config.yaml` — czyli **komplet sekretów platformy**. Kopia off-site bez szyfrowania
przeniosłaby je do cudzej infrastruktury. Szyfrowanie musi wejść **razem** z wysyłką, nie po niej.

### A2. Rotacja klucza API OpenAI (D6-01, P1)
Klucz leży **jawnym tekstem** w MariaDB `openspg.kg_user_model.config.api_key`, a więc
w każdym nocnym zrzucie i każdym snapshocie. To konstrukcja zamrożonego upstreamu OpenSPG
(jasypt w tym buildzie **nie** szyfruje configów modeli — teza w SKILL-u była nieprawdziwa,
poprawiona w tym audycie).

Ponieważ snapshoty z jawnym kluczem istnieją i nie są szyfrowane, klucz należy uznać za
skompromitowany w miarę słabo kontrolowanego obiegu:

1. Wygeneruj nowy klucz w panelu OpenAI, unieważnij stary.
2. Wprowadź nowy w panelu PomagierKB (**Ustawienia → LLM**, sealed AES-GCM) — nie w `.env`.
3. Zaktualizuj rejestr modeli OpenSPG (druga kopia klucza — `secret-rotation.md` ją pomijał,
   poprawione w tym audycie).
4. Dopiero potem A1 (szyfrowanie kopii), żeby nowy klucz nie trafił w to samo miejsce.

### A3. MFA dla administratora panelu (D3-03, P1)
Jedynym administratorem jest **superuser Authentika `akadmin`**, logujący się hasłem, bez MFA.
Kompromitacja tego jednego hasła daje pełną kontrolę nad platformą **i** nad dostawcą tożsamości.

```
Authentik → Flows → default-authentication-flow → dodaj stage TOTP/WebAuthn
Authentik → Policies → wymuś MFA dla grupy kag-admin
```
Zalecane dodatkowo: utworzyć **osobne** konto administracyjne panelu (nie superusera IdP)
i zejść `akadmin` do roli break-glass z hasłem w sejfie.

### A4. Monitoring zewnętrzny i dead-man's switch (D10-01, D10-02, P1)
Dziś **nie ma żadnego** automatycznego wykrywania niedostępności: Uptime Kuma jest pusta
(0 użytkowników, 0 monitorów, 0 powiadomień), `status.*` zwraca 404, brak sond spoza hosta.
Backup nie ma pingu sukcesu — cicha awaria harmonogramu byłaby niewidoczna do następnego
odtworzenia. To dokładnie ta klasa problemu, która pozwoliła czerwonemu CI przeżyć 42 commity.

1. Napraw `status.*` (patrz D2-02 niżej) albo używaj Kumy z zewnątrz przez tunel.
2. W Kumie: monitor HTTP na `https://kag.ilovelighting.sanok.pl/healthz` co 60 s,
   powiadomienie ntfy/e-mail.
3. Push monitor („heartbeat") dla backupu → skopiuj URL do `deploy/kag/.env`:
   `BACKUP_PING_URL=<url push-monitora>` oraz `VERIFY_PING_URL=<url drugiego push-monitora>`.
   Skrypty wołają je **tylko przy sukcesie**, więc brak pingu = alarm.
4. Sonda **spoza hosta** (bezpłatny plan UptimeRobot/Healthchecks.io) — monitoring działający
   na monitorowanym hoście nie wykryje jego awarii.

### A5. Renovate i wywiad o zależnościach (D11-02, D1-05, D1-03, P1)
`renovate.json` jest poprawny (naprawiony w tym audycie), ale **aplikacja nie jest zainstalowana** —
0 PR-ów, 0 issues. Dependabot dla akcji GitHuba został dodany plikiem `.github/dependabot.yml`
(działa samym istnieniem).

```
https://github.com/apps/renovate → zainstaluj na RobertBirek/PomagierKB
```
Po instalacji: usuń wpis `npm` z `.github/dependabot.yml` (zostaw `github-actions`), żeby nie
dublować PR-ów. Instrukcja jest w komentarzu obu plików.

Osobno — żywy `.env` odstaje od `.env.example`: `KUMA_IMAGE` i `STIRLING_IMAGE` to **ruchome tagi**
mimo polityki pinowania digestów. Digesty poniżej to obrazy **aktualnie działające**, więc
przypięcie niczego nie zmienia w runtime:

```
KUMA_IMAGE=louislam/uptime-kuma@sha256:3d632903e6af34139a37f18055c4f1bfd9b7205ae1138f1e5e8940ddc1d176f9
STIRLING_IMAGE=docker.io/stirlingtools/stirling-pdf@sha256:3b3670fce70b396ec56ba380a3cc7858e0abf83fe13f31c88f7737847763a396
```

Dopisz też tagi linii wydań, żeby miesięczny `update_check.sh` nie zgadywał (bez nich po
`docker image prune` zgłosi „BRAK TAGU"):

```
# deploy/edge/.env
CADDY_IMAGE_CHECK_TAG=2.10
AUTHENTIK_IMAGE_CHECK_TAG=2025.8
POSTGRES_IMAGE_CHECK_TAG=16-alpine
REDIS_IMAGE_CHECK_TAG=7-alpine
KUMA_IMAGE_CHECK_TAG=1
# deploy/kag/.env
TIKA_IMAGE_CHECK_TAG=3.3.1.0
STIRLING_IMAGE_CHECK_TAG=latest
```

---

## B. Zablokowane w tej sesji przez uprawnienia — gotowe do wykonania

### B1. Usunięcie konta `root@'%'` w MariaDB (D6-07)
Konto ma `ALL PRIVILEGES ... WITH GRANT OPTION` i jest osiągalne z **każdego** kontenera
w sieci `kag-datastores`. Nie da się go po prostu skasować: `skip_name_resolve=ON`, więc
połączenie TCP z 127.0.0.1 jako root trafia właśnie na `root@'%'` — zależy od tego healthcheck
w compose (`mysqladmin ping -h 127.0.0.1 -uroot`) **i** ścieżka odtwarzania po TCP.
Dlatego najpierw następca, dopiero potem usunięcie:

```bash
docker exec -i release-openspg-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -N -B' <<'SQL'
SELECT CONCAT("CREATE USER IF NOT EXISTS 'root'@'127.0.0.1' IDENTIFIED BY PASSWORD '", password, "'")
  INTO @s FROM mysql.user WHERE user='root' AND host='%';
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
GRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION;
FLUSH PRIVILEGES;
SQL

# weryfikacja PRZED usunięciem — musi zwrócić root@127.0.0.1
docker exec release-openspg-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -h127.0.0.1 --protocol=tcp -uroot -N -B -e "SELECT CURRENT_USER()"'

# dopiero teraz
docker exec -i release-openspg-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -e "DROP USER '\''root'\''@'\''%'\''; FLUSH PRIVILEGES;"'
docker inspect --format '{{.State.Health.Status}}' release-openspg-mysql   # musi zostać healthy
```

Hasło nie przechodzi przez `argv` ani przez ekran — hash jest kopiowany zmienną sesyjną SQL.

### B2. Blokada pivotu z `kag-egress` do usług hosta (D6-12)
Z kontenera OpenSPG osiągalne są usługi hosta na `:80`, `:443` i `:8080` — w tym trilium,
którego dostęp z internetu jest celowo ograniczony do trzech adresów IP. W połączeniu
z konfigurowalnym `base_url` modelu i nieuwierzytelnionym `/public/v1/datasource/testConnect`
to gotowy pivot SSRF. Skrypt i jednostka są w repo:

```bash
install -m 644 /kag/deploy/systemd/kag-egress-guard.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now kag-egress-guard.service
systemctl status kag-egress-guard --no-pager | head -5
/kag/deploy/scripts/egress_guard.sh --check       # oczekiwane: aktywnych reguł >= 1
```

Weryfikacja, że wyjście do internetu **nie** zostało zepsute (to jest cała trudność tej reguły —
blokuje ruch do hosta na 443, ale nie do `api.openai.com` na 443):

```bash
docker run --rm --network kag_kag-egress --entrypoint sh kag-mcp:local -c \
  'node -e "require(\"https\").request({host:\"api.openai.com\",port:443,method:\"HEAD\"},r=>console.log(r.statusCode)).end()"'
# oczekiwane: 401 (czyli sieć działa, brak klucza)
```

Po każdym odtworzeniu sieci (`docker compose down` + `up`) podsieć może się zmienić —
wtedy `systemctl restart kag-egress-guard`.

---

## C. Wymaga przerwy w działaniu

### C1. Restart hosta (D1-11, P1)
Zainstalowane jest jądro **6.8.0-139** (aktualizacja bezpieczeństwa), działa **6.8.0-138**.
Dostępny jest też Docker CE 29.8.0. Restart to jedyna droga.

```bash
/kag/deploy/scripts/backup.sh            # świeży snapshot PRZED
reboot
# po starcie:
docker ps --format '{{.Names}} {{.Status}}'   # 14 kontenerów up
/kag/deploy/scripts/smoke.sh
/kag/deploy/scripts/drift_check.sh            # oczekiwane exit 0
systemctl status kag-egress-guard --no-pager  # reguły zapory wróciły (jeśli B2 wykonane)
```

### C2. Aktualizacja Authentika (D1-07, P2)
Działa 2025.8.6 (build 2026-02-12); dostępne 2025.10.4 i 2026.2.6. Linia 2025.8 jest
prawdopodobnie poza oknem wsparcia. Aktualizacja IdP to operacja o wysokiej stawce —
wykonaj po C1, ze świeżym `pg_dump` i planem wycofania.

### C3. Aktualizacja Caddy (D2-04, P2)
2.10.2 → 2.11.4 (trzy wydania w tyle). Zmiana pinu w `deploy/edge/.env` + `up -d`.
Po każdej zmianie `Caddyfile` obowiązuje `docker restart edge-caddy` — `reload` wczyta starą
wersję, bo bind-mount pojedynczego pliku podmienia inode.

---

## D. Konfiguracja bez przerwy

### D1. SSH: uwierzytelnianie hasłem (D1-12, P2)
`50-cloud-init.conf` wygrywa nad `99-opencode-hardening.conf` (sshd bierze **pierwszą**
dyrektywę, a pliki wczytuje alfabetycznie), więc `PasswordAuthentication yes` jest efektywne
mimo hardeningu. Dostęp do :22 jest zawężony przez ufw do jednego IP, więc ryzyko jest
ograniczone — ale to nie jest to, co konfiguracja deklaruje.

```bash
sed -i 's/^PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config.d/50-cloud-init.conf
sshd -t && systemctl reload ssh
```
**Zanim zrelooadujesz — otwórz drugą sesję SSH i sprawdź, że klucz działa.** Utrata dostępu
do hosta z zewnętrznym IP na białej liście jest kosztowna.

### D2. Naprawa vhosta `status.*` (D2-02, P2)
`status.ilovelighting.sanok.pl` zwraca 404 z `x-authentik-id`: w Authentiku **nie ma**
Proxy Providera ani aplikacji „Status Monitor", więc outpost nie ma czego obsłużyć
(zachowanie fail-closed, poprawne). Bez tego A4 jest niewykonalne z przeglądarki.

```
Authentik → Providers → Create → Proxy Provider (forward auth, single application)
           external host: https://status.ilovelighting.sanok.pl
Authentik → Applications → Create → Status Monitor (provider jw., policy: grupa kag-admin)
Authentik → Outposts → embedded → dodaj aplikację
```
Procedura jest w `docs/authentik-setup.md`.

### D3. Konto testowe dla narzędzi UX (D4-02, P1 — część operatorska)
Narzędzia `tools/ux-audit/*` logowały się **hasłem superusera Authentika**, czytanym wprost
z `deploy/edge/.env`. Kod został przestawiony na jawnie podane poświadczenia z fail-closed
(brak poświadczeń = czytelny błąd, nigdy fallback na superusera). Brakuje konta:

```
Authentik → Users → Create → e2e-ux (bez uprawnień administratora)
           → dodaj do grupy kag-viewer (albo kag-editor, jeśli E2E tego wymaga)
```
Poświadczenia w pliku poza repo, wskazanym zmienną środowiskową (szczegóły w nagłówku
`tools/ux-audit/e2e.mjs`).

### D4. Strojenie pamięci Neo4j (D6-13, P2)
Neo4j rezerwuje **2,63 GiB** (65,7% limitu 4 GB) przy **6,6 MB** rzeczywistych danych —
heap 2G + pagecache 1G + `AlwaysPreTouch`. Przy 23 GB RAM na hoście to nie boli dzisiaj,
ale jest to czysta strata przy tej wielkości grafu.

```
# deploy/kag/.env
NEO4J_PAGECACHE=256M
NEO4J_HEAP=1G
```
Zastosuj **po** C1 i osobno od innych zmian, żeby regresja wydajności była jednoznacznie
przypisywalna.

---

## E. Do przyjęcia do wiadomości (ryzyko zaakceptowane lub nieusuwalne)

- **D6-10** — graf produkcyjny stoi na **DozerDB 5.25.1.0-alpha.1**, czyli forku Neo4j
  w wersji *alfa*, w linii nie-LTS. To wybór upstreamu OpenSPG, nie nasz. Wpisane do rejestru
  zamrożenia; kontrola kompensująca = udowodniony restore (drill DR) i cotygodniowa weryfikacja.
- **D6-11** — MariaDB bez binlogu: **brak point-in-time recovery**. Jedyną ochroną jest nocny
  zrzut logiczny, więc okno utraty danych to do 24 h. Włączenie binlogu wymaga zmiany
  konfiguracji zamrożonego obrazu i miejsca na dysku — decyzja świadoma.
- **D6-03** — 41 nieuwierzytelnionych endpointów zapisu `/public/**` na porcie 8887.
  Nieusuwalne bez modyfikacji upstreamu. Kontrola kompensująca: port nigdy nie jest publikowany
  na hoście, a sieć `kag-datastores` ma sześciu członków (potwierdzone sondami: zamknięta
  z `kag-internal` i `edge-net`).
- **D6-05** — anonimowy `s3:GetObject` na `builder/*` w MinIO jest **wymagany** przez builder
  OpenSPG: URL-e plików są niepodpisane, a builder pobiera je zwykłym GET-em. Usunięcie polityki
  zepsułoby każdy build. Kontrola kompensująca jak wyżej; listowanie anonimowe jest wyłączone.
- **D7-07** — zawartość produkcyjnych baz została zasilona **poza API** (0 wpisów audytu dla
  intake'ów, promocji i buildów sprzed wdrożenia audytu). Historii nie da się odtworzyć;
  od teraz każda mutacja jest w łańcuchu.
- **D11-07** — host produkcyjny trzyma poświadczenia konta GitHub (klucz SSH użytkownika
  + token `gh` z zakresami `repo`/`workflow`). Kompromitacja hosta daje dostęp do repozytorium.
  Rozważ deploy key ograniczony do odczytu zamiast pełnego konta.
- **D14-07** — przepływ danych do `api.openai.com` (treść dokumentów, pytania, klucze)
  nie jest udokumentowany i nie ma umowy powierzenia. W tym wdrożeniu baza nie zawiera danych
  osobowych, więc DPIA nie jest wymagana — ale gdyby zaczęła zawierać, ten punkt staje się
  blokujący.

---

## F. Kroki, które dołożyła faza napraw

Poprawki wdrożone w kodzie są **fail-closed**: kilka z nich świadomie NIE działa, dopóki
operator nie dostarczy brakującego elementu. To zamierzone — cichy fallback do poprzedniego,
niebezpiecznego zachowania byłby gorszy niż jawna odmowa.

### F1. Konto testowe dla narzędzi UX (D4-02)
`tools/ux-audit/e2e.mjs` **nie uruchomi się** do czasu wykonania tego kroku — kończy się
kodem 2 z instrukcją. Dotąd logował się hasłem superusera Authentika czytanym wprost
z `deploy/edge/.env`; teraz odmawia startu przy `E2E_USER=akadmin`, a także przy włączonym
debugowaniu Playwrighta (`DEBUG=pw:*`), bo tryb ten utrwaliłby hasło wpisywane znak po znaku.

```
Authentik → Users → Create → kag-e2e
           → grupa kag-admin, ale NIE „authentik Admins"
           → wyklucz z polityki MFA (osobna grupa poza stage'em MFA)
```
```bash
install -d -m 700 /etc/kag
printf 'E2E_USER=kag-e2e\nE2E_PASSWORD=%s\n' "$(openssl rand -base64 24)" > /etc/kag/e2e.env
chmod 600 /etc/kag/e2e.env
# ustaw to samo hasło użytkownikowi kag-e2e w Authentiku, potem:
node /kag/tools/ux-audit/e2e.mjs
```

Uwaga na kolejność z A3: po wymuszeniu MFA dla `kag-admin` konto E2E musi zostać w grupie
wyłączonej z MFA, inaczej narzędzie przestanie działać.

### F2. Klucz szyfrowania kopii off-site (D5-03, warunek dla A1)
Sam `BACKUP_OFFSITE_TARGET` **nie wystarczy** — bez odbiorcy szyfrowania wysyłka jest
blokowana, a manifest dostaje `offsite.status: blocked_no_encryption`.

```bash
apt-get install -y age                       # na hoście jest tylko gpg
age-keygen -o /root/kag-offsite.key          # klucz PRYWATNY → menedżer haseł, potem usuń z hosta
# publiczny (age1...) dopisz do /etc/kag/alerts.env (0600):
#   BACKUP_AGE_RECIPIENT=age1...
# dopiero POTEM BACKUP_OFFSITE_TARGET
```

Stare snapshoty nadal zawierają wyrenderowany `compose config` z kompletem sekretów:
```bash
find /srv/kag-data/backups/nightly -maxdepth 2 -name '*-compose.config.yaml' -delete
# uwaga: unieważnia SHA256SUMS tych snapshotów — verify uruchamiaj z --snapshot na nowszych
```

### F3. Wdrożenie (pełna procedura)
Ten deploy odtwarza **wszystkie 14 kontenerów** — zmiany w obu plikach compose (limity
PID/CPU, argumenty budowania, wyciszenie loggera reasonera, konfiguracja APOC, okno logów
Neo4j) zmieniają config-hash każdej usługi.

```bash
cd /kag
npm run build -w packages/shared && npm run lint && npm run typecheck && npm test && npm run build
/kag/deploy/scripts/backup.sh                      # świeży snapshot PRZED

STAMP=$(date +%Y%m%d-%H%M)
docker tag kag-panel:local kag-panel:pre-audit-$STAMP
docker tag kag-mcp:local   kag-mcp:pre-audit-$STAMP
echo "pre-audit-$STAMP" > /srv/kag-data/kag/last-rollback-tag

export GIT_SHA=$(git rev-parse --short HEAD) BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose -f deploy/kag/compose.yaml build panel mcp
docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' kag-panel:local
# ↑ musi zwrócić SHA commitu, nie "unknown"

docker compose -f deploy/kag/compose.yaml up -d
docker compose -f deploy/edge/compose.yaml --profile monitoring up -d   # PROFIL OBOWIĄZKOWY
```

Bez `--profile monitoring` kontener Uptime Kuma zostanie ze starą konfiguracją i
`drift_check.sh` zgłosi dryf.

Migracje uruchamia wyłącznie panel-api; w tym wdrożeniu idą cztery: `0027`, `0033`, `0047`
(przebudowa indeksu FTS w transakcji startu), `0060`.

Weryfikacja:
```bash
/kag/deploy/scripts/smoke.sh          # 2 nowe checki SPA muszą przejść (dziś failują — to dowód)
/kag/deploy/scripts/drift_check.sh    # oczekiwane exit 0 — po raz pierwszy naprawdę
/kag/deploy/scripts/verify_backup.sh  # exit 0
node /kag/tools/ux-audit/e2e.mjs      # wymaga F1
```

**Rollback** (bezpieczny o jedną wersję — migracje są forward-only i addytywne):
```bash
TAG=$(cat /srv/kag-data/kag/last-rollback-tag)
docker tag kag-panel:$TAG kag-panel:local && docker tag kag-mcp:$TAG kag-mcp:local
docker compose -f deploy/kag/compose.yaml up -d panel mcp
```

### F4. Przebudowa baz wiedzy PO wdrożeniu
Tożsamość dokumentów i normalizacja treści zmieniły się, więc graf trzeba przebudować:
panel → **Bazy → Zbuduj** dla każdej aktywnej bazy. Pierwszy build wystawi nagrobki dla
wszystkich starych węzłów i potrwa dłużej niż zwykle — to zamierzone i idempotentne.

Po buildzie sprawdź w raporcie jakości, że przechodzą: `ids_unique_nonempty`,
`graph_stale_nodes`, `no_literal_newlines`, `superseded_documents`.

### F5. Drobne, ale warto od razu
```bash
# wadliwy snapshot bez panel.sqlite — poza wzorzec nazwy, czyli poza retencję
mv /srv/kag-data/backups/nightly/2026-09-03_032613 \
   /srv/kag-data/backups/nightly/_rejected_2026-09-03_032613

# archiwum obrazu diagnostycznego (runbooki używają go w wariancie zapasowym)
/kag/deploy/scripts/save_images.sh

# zdejmuje dwa ostrzeżenia warunkowe bootstrapu
apt-get install -y sqlite3 rclone
```

Po zapisaniu na nowo konfiguracji LLM w panelu (**Ustawienia → LLM**, PUT każdej pozycji)
wypełni się kolumna z nazwą modelu dla wierszy sprzed migracji — bez tego raport kosztu
per model opiera się wyłącznie na wywołaniach wykonanych po wdrożeniu.
