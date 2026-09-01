# Wdrożenie PomagierKB — runbook krok po kroku

Runbook wdrożenia platformy na czystym serwerze wg `docs/design/infra.md` §7 i planu
(`docs/design/PLAN.md`, sekcja „Wdrożenie"). Wykonuj kroki **w kolejności** — kilka z nich
(DNS, przywracanie danych, model embeddingu) jest nieodwracalnych lub kosztownych przy pomyłce.

**Założenia:**

- Domeny: panel `kag.ilovelighting.sanok.pl`, SSO `auth.ilovelighting.sanok.pl`.
- Repo wdrożeniowe: `/kag`. Jeżeli repo leży gdzie indziej (np. `/kag` na tym VPS),
  podmień ścieżki we wszystkich komendach **i w plikach unit systemd** (`ExecStart`).
- Dane runtime: `/srv/kag-data/` (bind mounty, tworzy `bootstrap.sh`).
- Serwer: 8 vCPU / **24 GB RAM** / ~435 GB dysku. Wartości heapów w `.env.example` są już
  ustawione pod profil 24 GB (tabela niżej) — **ten profil nadpisuje profil S/32G z infra.md**.

**Profil RAM 24 GB (wiążący, z PLAN.md):**

| Składnik | mem_limit | heap / parametry |
|---|---|---|
| neo4j | 4g | `NEO4J_HEAP=2G`, `NEO4J_PAGECACHE=1G` |
| openspg-server | 4.5g | `OPENSPG_SERVER_XMS=1024m`, `OPENSPG_SERVER_XMX=3072m` |
| mysql | 2g | — |
| minio | 768m | — |
| tika | 1.5g | — |
| stirling | 2g | `JAVA_OPTS=-Xmx1g` |
| panel / mcp | 512m / 384m | — |
| stack edge łącznie | ~3g | — |
| **Suma** | **~21g** | + swap 8G (`bootstrap.sh`) jako bezpiecznik OOM |

`BUILDER_MODEL_EXECUTE_NUM=4`. Wszystkie wartości siedzą w `.env` — skalowanie w górę
(mocniejszy serwer) to edycja `.env` + `docker compose up -d`, bez dotykania compose.

---

## 0. Wymagania wstępne

- Linux z dostępem root (SSH), publiczne IPv4.
- Docker Engine + plugin compose (`docker compose version` ≥ 2.x), `git`, `curl`.
- Do backupów/weryfikacji: `zstd`, `jq`; do `update_check.sh`: `skopeo` (opcjonalnie).
- Wolne porty **80/tcp, 443/tcp, 443/udp** na hoście. Inne usługi hosta (np. trilium na 8080)
  nie kolidują — platforma nie publikuje nic poza Caddy.

```bash
docker version && docker compose version && git --version
ss -tlnp | grep -E ':80|:443' || echo "porty 80/443 wolne — OK"
```

## 1. DNS — PRZED pierwszym startem Caddy

Ustaw rekordy A **zanim** wystartujesz stack edge:

```
auth.ilovelighting.sanok.pl  A  <IP-serwera>
kag.ilovelighting.sanok.pl   A  <IP-serwera>
```

Sprawdź propagację (musi zwrócić IP serwera):

```bash
dig +short auth.ilovelighting.sanok.pl @1.1.1.1
dig +short kag.ilovelighting.sanok.pl @1.1.1.1
```

**UWAGA — limity Let's Encrypt:** przy złym DNS Caddy będzie ponawiał walidacje ACME
i wypali limity LE (m.in. 5 nieudanych walidacji/h na hostname; limity duplikatów certów).
Odblokowanie potrafi trwać godziny/dni. Dlatego:

1. Na czas testów konfiguracji odkomentuj w `deploy/edge/Caddyfile` (blok globalny):
   `acme_ca https://acme-staging-v02.api.letsencrypt.org/directory`
   (staging CA — bez limitów; przeglądarka pokaże „niezaufany certyfikat" — to oczekiwane).
2. Gdy oba vhosty dostają cert ze stagingu i odpowiadają, zakomentuj linię z powrotem i:

```bash
cd /kag/deploy/edge
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

Caddy sam pobierze produkcyjne certy. Katalog certów: `/srv/kag-data/edge/caddy/data`
(krytyczny do backupu — przywrócenie certów po awarii oszczędza limity LE).

## 2. Klonowanie repo i bootstrap

```bash
sudo git clone git@github.com:RobertBirek/PomagierKB.git /kag
cd /kag
sudo deploy/scripts/bootstrap.sh
```

`bootstrap.sh` (idempotentny — można uruchamiać ponownie):

- tworzy sieć `docker network create edge-net` (wspólna dla przyszłych aplikacji),
- tworzy katalogi `/srv/kag-data/*` z właściwymi uprawnieniami (panel `10001`, postgres itd.),
- zakłada **swap 8G** i ustawia `vm.swappiness=10` (bezpiecznik OOM przy 24 GB RAM),
- pobiera `pol/eng/osd.traineddata` (tessdata_fast) do `/srv/kag-data/kag/stirling/tessdata/`,
- kopiuje `.env.example` → `.env` w obu stackach (jeśli nie istnieją) i przypomina o `chmod 600`.

Sprawdź: `swapon --show`, `docker network ls | grep edge-net`, `ls /srv/kag-data`.

## 3. Stack edge (Caddy + Authentik)

Wypełnij `deploy/edge/.env` (plik ma `chmod 600`, właściciel root; sekrety generuj tak):

```bash
openssl rand -base64 48   # AUTHENTIK_SECRET_KEY
openssl rand -base64 36   # AUTHENTIK_PG_PASSWORD
```

**UWAGA:** `AUTHENTIK_SECRET_KEY` po pierwszym starcie jest żenaty z danymi w Postgresie —
nie zmieniaj go później (utrata sesji/podpisów). Trzymaj kopię w menedżerze haseł.

Start i weryfikacja:

```bash
cd /kag/deploy/edge
docker compose up -d
watch docker compose ps          # czekaj aż wszystko healthy (authentik ~1-2 min)
curl -fsS https://auth.ilovelighting.sanok.pl/ -o /dev/null -w '%{http_code}\n'
```

## 4. Konfiguracja Authentika

Wykonaj **całą** instrukcję `docs/authentik-setup.md`: initial-setup (hasło `akadmin`),
grupy `kag-admin/operator/viewer`, provider OIDC `kag-panel`, aplikacja + bindingi grup,
embedded outpost (opcjonalny `/openspg`), MFA dla `kag-admin`.

Z tej konfiguracji wynosisz **Client Secret** providera → wpiszesz go za chwilę do
`deploy/kag/.env` jako `PANEL_OIDC_CLIENT_SECRET`.

## 5. Stack kag (OpenSPG + panel + MCP)

Wypełnij `deploy/kag/.env`. Wszystkie sekrety są wymagane (`${VAR:?...}` — compose odmówi
startu bez nich). Hasła wklejane do URL-i OpenSPG (`neo4j`, `minio`) wymagają wariantu
`*_URLENCODED` — wygeneruj helperem:

```bash
python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' 'TWOJE-HASŁO'
```

Minimalna lista do wypełnienia: `MYSQL_ROOT_PASSWORD`, `MYSQL_APP_PASSWORD`,
`OPENSPG_NEO4J_PASSWORD` (+`_URLENCODED`), `MINIO_ROOT_PASSWORD` (+`_URLENCODED`),
`PANEL_OIDC_CLIENT_SECRET` (z kroku 4), `PANEL_SESSION_SECRET`, `PANEL_INTERNAL_TOKEN`.
Heapy/limity zostaw na wartościach z example (profil 24 GB).

**UWAGA:** kluczy LLM (OpenAI itp.) NIE wpisuje się do `.env` — trafiają do panelu
(Ustawienia), krok 7.

Build i start (pierwszy pull obrazów OpenSPG z rejestru Aliyun bywa wolny — cierpliwie):

```bash
cd /kag/deploy/kag
docker compose build panel mcp
docker compose up -d
watch docker compose ps    # openspg-server ma start_period 120s — healthy po ~2-4 min
```

Po pierwszym udanym starcie warto zabezpieczyć obrazy OpenSPG na wypadek zniknięcia rejestru:

```bash
docker save $(docker compose config --images | grep spg-registry) \
  | zstd -o /srv/kag-data/backups/images/openspg-images.tar.zst
```

## 6. Pierwsze logowanie do panelu

Wejdź na `https://kag.ilovelighting.sanok.pl/` kontem należącym do grupy `kag-admin`
(NIE `akadmin` — to konto break-glass). Przekierowanie na `auth.*`, login, powrót do panelu.

- 403 od Authentika = konto bez żadnej grupy `kag-*` (patrz `docs/authentik-setup.md` §3).
- Błąd callbacku = sprawdź `PANEL_OIDC_CLIENT_SECRET`, Redirect URI w providerze
  (`https://kag.ilovelighting.sanok.pl/api/auth/callback`) i `PANEL_OIDC_ISSUER` w `.env`.

## 7. Klucz LLM w Ustawieniach

Panel → **Ustawienia → LLM** (tylko admin):

- `chat_llm` — model mocniejszy (odpowiedzi, analiza dokumentów),
- `openie_llm` — model tańszy (czyszczenie, ekstrakcja),
- base URL + klucz API (OpenAI-compatible). Klucz jest przechowywany w SQLite w formie
  zaszyfrowanej (sealed AES-GCM) i maskowany w API — nigdy w `.env` ani logach.
- Kliknij **Testuj połączenie** — musi przejść, zanim ruszysz dalej.

Embeddingi: platforma używa `text-embedding-3-small` — model jest **zamrażany per baza**
przy jej tworzeniu (patrz krok 8).

## 8. Utworzenie pierwszej bazy wiedzy

Panel → **Bazy wiedzy → Nowa baza**:

1. Nazwa wyświetlana — może być po polsku (np. „Katalog oświetlenia").
2. **Namespace — WYŁĄCZNIE PO ANGIELSKU**, wzorzec `^[A-Za-z][A-Za-z0-9]*$`,
   np. `LightingCatalog`. **UWAGA — nieodwracalne:** nieangielskie/nieprawidłowe
   identyfikatory psują entity linking w OpenSPG (bug #753), a namespace'u nie da się
   później zmienić bez założenia nowej bazy.
3. **Typy dokumentów** — zadeklaruj rodzaje treści, które trafią do bazy (nazwa + opis,
   np. „karta katalogowa", „norma", „instrukcja montażu"). Pipeline użyje ich do
   klasyfikacji draftów (`document_category`); listę można później rozszerzać.
4. Przeczytaj ostrzeżenie o embeddingu: model `text-embedding-3-small` zostaje
   **zamrożony dla tej bazy na zawsze** (wektory w grafie) — zmiana = nowa baza + pełny
   rebuild treści.
5. Zapisz → uruchom **Provision**. Postęp akcji obejrzysz w Ustawienia → System → Akcje
   (log na żywo). Status bazy: `draft → provisioning → active`.

## 9. Pierwszy dokument: ingest → build → Zapytaj

1. **Dodaj treść** → zakładka Tekst (wklej) albo Plik (≤50 MB; PDF przechodzi kaskadę
   Stirling → OCR pol → Tika). URL możesz podać tylko jako metadaną źródła.
2. **Inbox** → obejrzyj draft (wynik ekstrakcji + analizy), popraw jeśli trzeba →
   **Zatwierdź** (promote). Nic nie trafia do grafu bez recenzji człowieka.
3. **Bazy wiedzy** → przy bazie ze znacznikiem „niezbudowane zmiany" uruchom **Buduj**.
   Builder job: upload CSV → submit → polling (status w drawerze historii). Sukces =
   `FINISH` + quality gate `OK`.
4. **Zapytaj** → zadaj pytanie o treść dokumentu. Sprawdź: odpowiedź po polsku,
   cytowania `[n]` rozwijalne do fragmentów, a dla pytania spoza bazy — uczciwe
   „Nie znalazłem tego w bazie" (i wpis w lukach wiedzy).

## 10. Test dymny

```bash
sudo /kag/deploy/scripts/smoke.sh
```

Sprawdza m.in.: `healthz` panelu i MCP, discovery OIDC, 302 panelu bez sesji,
`initialize` + `tools/list` na `/mcp` (wymaga `SMOKE_MCP_KEY`), sondę wyszukiwania OpenSPG (wymaga `SMOKE_STAGING_NS`).
**Musi przechodzić po każdym wdrożeniu i każdej aktualizacji.**

## 11. Backupy — timery systemd

```bash
sudo cp /kag/deploy/systemd/kag-backup.service /kag/deploy/systemd/kag-backup.timer /etc/systemd/system/
sudo cp /kag/deploy/systemd/kag-backup-verify.service /kag/deploy/systemd/kag-backup-verify.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kag-backup.timer kag-backup-verify.timer
systemctl list-timers 'kag-backup*'
```

Harmonogram: backup codziennie 03:20 (±10 min), weryfikacja w niedzielę 04:30.
Uruchom pierwszy backup ręcznie i obejrzyj manifest:

```bash
sudo systemctl start kag-backup.service
cat /srv/kag-data/backups/nightly/*/_manifest.json | tail -50   # ok:true, bez warnings
```

Po pierwszej nocy odpal ręcznie weryfikację: `sudo systemctl start kag-backup-verify.service`
i sprawdź raport w `/srv/kag-data/backups/verify/`. Parametr `BACKUP_OFFSITE_TARGET`
jest na razie pusty (backup offsite dojdzie później) — manifest będzie to raportował
jako warning; to znane i zaakceptowane.

## 12. Aktualizacje

Zasada ogólna: **żadnych auto-aktualizacji** (bez Watchtowera). Obrazy są przypięte
digestami; podnosi je człowiek, świadomie.

Wykrywanie dostępnych aktualizacji:

```bash
sudo /kag/deploy/scripts/update_check.sh   # skopeo/manifest inspect vs digesty w .env
```

Procedura standardowa (Caddy, Postgres, Redis, Tika, Stirling):

1. `sudo systemctl start kag-backup.service` (świeży snapshot),
2. podnieś digest w odpowiednim `.env` (zostaw komentarz z wersją i datą),
3. `docker compose pull && docker compose up -d` w katalogu stacka,
4. poczekaj na healthy → `smoke.sh`.

Zasady szczególne:

- **OpenSPG (mysql/neo4j/minio/server): ZAMROŻONY.** Upstream martwy od 06/2025,
  migracje nieznane, model embeddingu nietykalny. Aktualizacja tylko jako osobna,
  świadoma operacja: pełny snapshot + próba na kopii danych, nigdy „przy okazji".
- **Authentik:** tylko po przeczytaniu release notes danej linii (2025.x); **zawsze
  backup Postgresa przed** (`kag-backup.service` albo ręczny `pg_dump`); server+worker
  aktualizowane razem (jeden obraz/digest); migracje DB robi sam przy starcie;
  po aktualizacji sprawdź logowanie do panelu i forward-auth (`smoke.sh`).
- **Panel/MCP (kod własny):** `git -C /kag pull` →
  `docker compose -f /kag/deploy/kag/compose.yaml build panel mcp && docker compose -f /kag/deploy/kag/compose.yaml up -d panel mcp` → `smoke.sh`.
- **OS:** unattended-upgrades tylko security; Docker Engine ręcznie w oknie serwisowym.
- Renovate otwiera PR-y dla Caddy/Authentik/Stirling/node; obrazy `spg-registry.*` są
  wykluczone celowo.

## 13. Kontrola bezpieczeństwa po wdrożeniu

```bash
docker ps --format '{{.Names}}\t{{.Ports}}'   # porty TYLKO przy edge-caddy: 80, 443, 443/udp
sudo ls -l /kag/deploy/edge/.env /kag/deploy/kag/.env   # 0600, root
```

- Konto spoza grup `kag-*` → 403 na panelu (test na świeżym koncie).
- Zrewokowany klucz MCP przestaje działać ≤60 s.
- Żaden kontener OpenSPG nie publikuje portu (nawet na 127.0.0.1) — diagnostyka wyłącznie
  przez `docker compose exec` / `docker run --rm --network kag_kag-internal ...`.

Powiązane dokumenty: `docs/authentik-setup.md`, `docs/runbooks/break-glass-authentik.md`,
`docs/runbooks/disaster-recovery.md`, `docs/runbooks/typowe-awarie.md`.
