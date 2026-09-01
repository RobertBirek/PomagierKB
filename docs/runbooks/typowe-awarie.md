# Typowe awarie — diagnoza i naprawa

Szybkie procedury dla najczęstszych problemów. Ścieżki: repo `/kag`, dane
`/srv/kag-data`. Zasada nadrzędna: **nie publikujemy portów na hoście** — diagnostykę
wewnątrz sieci rób przez `docker compose exec` albo
`docker run --rm --network kag_kag-internal curlimages/curl ...`.

---

## 1. Dysk pełny (lub >80%)

Objawy: pady Postgresa/MySQL, `no space left on device` w logach, backup z warningiem.

```bash
df -h /srv /var/lib/docker
sudo du -xh --max-depth=2 /srv/kag-data | sort -rh | head -20
sudo du -xh --max-depth=1 /var/lib/docker | sort -rh | head
```

**Bezpieczne do czyszczenia (w tej kolejności):**

```bash
# 1) stare snapshoty backupów (retencję sprząta backup.sh, ale ręcznie wolno usuwać
#    NAJSTARSZE katalogi; zostaw min. 2 ostatnie nightly + snapshoty miesięczne)
ls -1t /srv/kag-data/backups/nightly/

# 2) nieużywane obrazy/cache buildów dockera
docker image prune -af
docker builder prune -af

# 3) journal systemd
sudo journalctl --vacuum-time=7d

# 4) stare logi dostępowe Caddy (roll_keep=5 sprząta sam; ręcznie tylko pliki .log.* )
ls -lh /srv/kag-data/edge/caddy/data/access-kag.log* 2>/dev/null
```

**UWAGA — NIGDY nie usuwaj:** `kag/mysql`, `kag/neo4j`, `kag/minio`, `kag/panel`,
`edge/authentik/postgres`, `edge/caddy/data` (certy) ani niczego komendą
`docker system prune --volumes` / `docker volume prune`. Logi kontenerów są już
ograniczone (json-file 10m×3) — nie ruszaj ich ręcznie.

Jeśli po czyszczeniu nadal >80%: rośnie korpus (neo4j+minio) — czas powiększyć dysk;
do tego momentu można przenieść `backups/` na inny wolumen.

## 2. Zawieszony builder job

Objawy: build w panelu „kręci się" dziesiątki minut, kolejny build zablokowany.

Diagnoza — najpierw panel (Bazy wiedzy → drawer historii buildów), potem bezpośrednio
API buildera. **`start` MUSI być 1** (start=0 to bug SQL w OpenSPG):

```bash
docker run --rm --network kag_kag-internal curlimages/curl -fsS \
  'http://release-openspg-server:8887/public/v1/builder/job/list?projectId=<ID>&start=1&limit=20'
# pojedynczy job:
docker run --rm --network kag_kag-internal curlimages/curl -fsS \
  'http://release-openspg-server:8887/public/v1/builder/job/get?id=<JOBID>'
docker logs --tail 300 release-openspg-server | grep -i -E 'builder|error'
```

Interpretacja statusów: terminalne = `FINISH`, `ERROR`, `SKIP`, `TERMINATE`,
`SET_FINISH`; aktywne = `INIT`, `WAITING`, `RUNNING`.

Co robi panel sam: przy ponownym buildzie **reuse-active** — podłącza się do
aktywnego joba tylko gdy `jobName` i `fileUrl` się zgadzają **i job ma ≤45 min**.
Starszy wiszący job jest ignorowany i składany jest nowy.

Kiedy uznać job za martwy (kandydat do TERMINATE):

- `RUNNING` > 120 min (timeout pollingu panelu) bez zmiany statusu,
- logi serwera nie pokazują żadnej aktywności buildera,
- przyczyną bywa: padnięty klucz/endpoint LLM (sprawdź Ustawienia → test LLM),
  OOM serwera (patrz §5), niedostępne minio.

Procedura:

1. Usuń przyczynę (LLM, RAM, minio) — często job sam się dokończy.
2. Jeśli nie: restart serwera OpenSPG przerywa wykonywanie —
   `docker compose -f /kag/deploy/kag/compose.yaml restart server`.
   **UWAGA:** wpis joba w MySQL może pozostać w `RUNNING` na zawsze — to nieszkodliwe
   (reuse-active go pominie po 45 min), ale odnotuj to w historii bazy.
3. Po restarcie: odpal build ponownie z panelu — eksport/upload wznowi się po sha256
   (manifesty w SQLite), bez dublowania danych (action UPSERT + dedup po contentHash).

## 3. Certyfikat nie odnowiony / wygasł

Objawy: przeglądarka krzyczy o cercie, `curl: (60) SSL certificate problem`.

```bash
echo | openssl s_client -connect kag.ilovelighting.sanok.pl:443 -servername kag.ilovelighting.sanok.pl 2>/dev/null | openssl x509 -noout -dates -issuer
docker logs --tail 200 edge-caddy | grep -i -E 'acme|certificate|error'
dig +short kag.ilovelighting.sanok.pl @1.1.1.1     # DNS nadal wskazuje ten serwer?
sudo ss -tlnp | grep -E ':80 |:443 '               # 80/443 słucha caddy? (walidacja HTTP-01 wymaga 80)
df -h /srv                                          # pełny dysk blokuje zapis certów
```

Typowe przyczyny: DNS przestawiony/wygasły, port 80 zajęty lub odcięty firewallem,
pełny dysk, wygaszony kontener caddy, issuer = **staging** (ktoś zostawił odkomentowane
`acme_ca` w Caddyfile po testach — sprawdź `issuer` w komendzie wyżej).

Naprawa: usuń przyczynę, potem

```bash
cd /kag/deploy/edge
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile   # lub: docker compose restart caddy
docker logs -f edge-caddy | grep -i acme
```

**UWAGA — limity Let's Encrypt:** nie restartuj caddy w pętli przy niepoprawnym DNS —
5 nieudanych walidacji/h blokuje wydawanie. Najpierw DNS/port 80, potem reload.
Certy leżą w `/srv/kag-data/edge/caddy/data` i są w backupie nocnym.

## 4. Kontener unhealthy

```bash
docker ps --format '{{.Names}}\t{{.Status}}' | grep -v healthy      # co dokładnie leży
docker inspect --format '{{json .State.Health}}' <NAZWA> | jq .     # ostatnie wyniki healthchecku
docker logs --tail 200 <NAZWA>
```

Zależności startu w stacku kag: mysql/neo4j/minio → **server** → panel/mcp.
Unhealthy datastore pociąga za sobą serwer — naprawiaj od dołu.

- `release-openspg-server`: ma `start_period: 120s` — po (re)starcie bywa „unhealthy"
  do ~2-4 min; to jeszcze nie awaria. Dłużej → logi (`docker logs`), najczęściej
  nie może dojść do mysql/neo4j/minio (sprawdź ich health) albo OOM (§5).
- Pojedynczy restart usługi:
  `docker compose -f /kag/deploy/kag/compose.yaml restart <usluga>`.
- `kag-stirling` ubity przy OCR dużego skanu → wstaje sam (`restart: always`);
  powtarzające się pady = przytnij równoległość OCR / patrz §5.
- Panel/mcp unhealthy przy działającym OpenSPG: sprawdź `/healthz` od środka
  (`docker run --rm --network kag_kag-internal curlimages/curl -fsS http://kag-panel:8080/healthz`)
  i logi — typowo problem z SQLite (dysk, uprawnienia 10001) albo z migracjami
  (mcp odmawia startu przy rozjeździe wersji schematu — zaktualizuj/zrestartuj panel
  PRZED mcp).

Po każdej naprawie: `sudo /kag/deploy/scripts/smoke.sh`.

## 5. OOM (Out Of Memory)

Objawy: kontener znika/restartuje bez wyraźnego błędu w logach aplikacji, build pada
w połowie, host muli.

**Jak czytać dmesg:**

```bash
sudo dmesg -T | grep -i -E 'oom|killed process' | tail -20
sudo journalctl -k --since -2days | grep -i oom | tail -20
docker inspect --format '{{.State.OOMKilled}} {{.State.ExitCode}}' <NAZWA>   # true/137 = OOM
free -h && swapon --show      # swap 8G z bootstrapa obecny? swappiness=10?
docker stats --no-stream     # kto ile je TERAZ
```

W linii `Killed process` z dmesg patrz na nazwę procesu i cgroup — wskazują kontener
(java = neo4j/openspg-server/tika/stirling; node = panel/mcp).

**Które heapy przycinać** — wszystko w `deploy/kag/.env` (bez edycji compose),
po zmianie `docker compose up -d` (przetworzy tylko zmienione usługi):

| Ofiara OOM | Co przyciąć (wartość profilu 24 GB → krok w dół) |
|---|---|
| release-openspg-server | `OPENSPG_SERVER_XMX=3072m` → `2560m`; NAJPIERW jednak `BUILDER_MODEL_EXECUTE_NUM=4` → `2` (mniejsza równoległość buildera to najtańsza ulga) |
| release-openspg-neo4j | `NEO4J_HEAP=2G` → `1G` i/lub `NEO4J_PAGECACHE=1G` → `512M` (wolniejsze zapytania, ale stabilnie) |
| kag-stirling (OCR) | `JAVA_OPTS=-Xmx1g` bez zmian; ogranicz równoległe OCR do 1 (ustawienie panelu) — skoki RAM robi wielkość skanu, nie heap |
| kag-tika | mem_limit 1.5g zwykle wystarcza; pady = podejrzany pojedynczy plik — odrzuć go z Inboxa |
| kag-panel / kag-mcp | 512m/384m; wzrost zużycia = zgłoś bug (nie podnoś limitu w ciemno) |

**UWAGA:** suma limitów (~21g) jest dobrana pod 24 GB RAM — podnosząc jeden limit,
obniż inny albo najpierw powiększ RAM serwera. Nie wyłączaj swapa: to bezpiecznik,
`vm.swappiness=10` i tak trzyma go w rezerwie.

Po zmianach: obserwuj `docker stats` podczas następnego builda; jeżeli OOM dotknął
builder job — patrz §2 (job mógł zawisnąć).

---

Powiązane: `break-glass-authentik.md` (SSO leży), `disaster-recovery.md` (utrata
serwera), `docs/deployment.md` §12 (aktualizacje).
