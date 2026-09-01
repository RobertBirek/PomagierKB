# PODSYSTEM 1: INFRASTRUKTURA I DEPLOYMENT (projekt KAG)

Cel: dwa stacki compose (`edge`, `kag`) na czystym serwerze, TLS przez Caddy, SSO przez Authentik, OpenSPG całkowicie schowany w sieci wewnętrznej (zero portów na hoście poza 80/443), fail-fast na sekretach, backup z timerem systemd.

---

## 1. Topologia sieci Docker

```
INTERNET ── 80/443(+udp) ──► [edge-caddy]
                                  │ edge-net (external, bridge; utworzona raz: docker network create edge-net)
        ┌─────────────────────────┼───────────────────────────┐
        ▼                         ▼                           ▼
[edge-authentik-server]      [kag-panel:8080]           [kag-mcp:3001]
[edge-authentik-worker]           │                           │
        │ edge-internal           │ kag-internal (internal: true — bez NAT/internetu)
        ▼                         ▼
[edge-postgres]        [release-openspg-server:8887] [release-openspg-mysql]
[edge-redis]           [release-openspg-neo4j]       [release-openspg-minio]
                       [kag-tika:9998]  [kag-stirling:8080]
                                  │
                       [release-openspg-server] ─ kag-egress (bridge, NAT) ─► API LLM
```

**Sieci:**
| Sieć | Typ | Członkowie | Po co |
|---|---|---|---|
| `edge-net` | external bridge (tworzona poza compose, wspólna dla przyszłych appek) | caddy, authentik-server, authentik-worker, kag-panel, kag-mcp | ruch Caddy→aplikacje; egress panel/mcp do LLM |
| `edge-internal` | `internal: true` (stack edge) | authentik-server, worker, postgres, redis | izolacja PG/Redis od świata |
| `kag-internal` | `internal: true` (stack kag) | wszystkie usługi kag | OpenSPG bez internetu i bez dostępu z zewnątrz |
| `kag-egress` | bridge (stack kag) | TYLKO release-openspg-server | serwer OpenSPG musi wołać API LLM (wektoryzacja, ekstrakcja); reszta datastores zostaje odcięta |

**Twarde zasady:** ŻADNA usługa OpenSPG nie publikuje portu na host (nawet 127.0.0.1 — różnica vs optimaKB, który publikował 8887 i 9998; diagnostyka przez `docker compose exec` albo `docker run --rm --network kag_kag-internal curlimages/curl ...`). Jedyne porty hosta: 80/tcp, 443/tcp, 443/udp (Caddy, HTTP/3).

**Trik hairpin/OIDC:** usługa caddy dostaje w `edge-net` aliasy sieciowe `auth.ilovelighting.sanok.pl` i `kag.ilovelighting.sanok.pl`. Dzięki temu panel-api robi discovery/token-exchange OIDC na publiczny URL issuer-a bez wychodzenia z hosta (i z prawdziwym certem LE), niezależnie od NAT reflection.

---

## 2. Stack `edge` (deploy/edge/compose.yaml)

Wspólne kotwice (wzorzec optimaKB + rotacja logów):
```yaml
x-security-defaults: &security_defaults
  security_opt: ["no-new-privileges:true"]
  cap_drop: ["ALL"]
x-logging: &logging
  logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }
```

**Obrazy (tag → przy wdrożeniu przypiąć digest `@sha256:` + komentarz z datą, wzorzec optimaKB):**
- `caddy:2.10` (oficjalny; pin digest)
- `ghcr.io/goauthentik/server:2025.8` — jeden obraz dla server i worker (Authentik 2025.x; wziąć najnowszy patch linii 2025.x i przypiąć digest)
- `postgres:16-alpine`
- `redis:7-alpine`

**Usługi:**

| Usługa | container_name | mem_limit | sieci | healthcheck |
|---|---|---|---|---|
| caddy | edge-caddy | 256m | edge-net (aliasy: oba vhosty) | `wget -qO- http://127.0.0.1:2019/metrics` |
| authentik-server (`command: server`) | edge-authentik-server | 1g | edge-net, edge-internal | `ak healthcheck` (wbudowany) |
| authentik-worker (`command: worker`) | edge-authentik-worker | 1g | edge-internal, edge-net (egress SMTP) | `ak healthcheck` |
| postgres | edge-postgres | 512m | edge-internal | `pg_isready -U $POSTGRES_USER -d $POSTGRES_DB` |
| redis | edge-redis | 256m | edge-internal | `redis-cli ping` |

- caddy: `cap_add: [NET_BIND_SERVICE]`, wolumeny `${DATA_ROOT}/edge/caddy/data:/data`, `.../caddy/config:/config`, `./Caddyfile:/etc/caddy/Caddyfile:ro`.
- authentik-server/worker: wolumeny `${DATA_ROOT}/edge/authentik/media:/media`, `.../custom-templates:/templates`, `.../certs:/certs`. **BEZ montowania docker.sock** (używamy tylko embedded outpost — worker nie zarządza kontenerami outpostów). Env: `AUTHENTIK_SECRET_KEY: ${AUTHENTIK_SECRET_KEY:?required}`, `AUTHENTIK_POSTGRESQL__HOST: edge-postgres`, `__USER/__NAME/__PASSWORD` z `:?required`, `AUTHENTIK_REDIS__HOST: edge-redis`, `AUTHENTIK_ERROR_REPORTING__ENABLED: "false"`, `AUTHENTIK_DISABLE_UPDATE_CHECK: "true"`, `AUTHENTIK_DISABLE_STARTUP_ANALYTICS: "true"`, opcjonalnie `AUTHENTIK_EMAIL__*`. `depends_on: postgres/redis: service_healthy`.
- postgres: wolumen `${DATA_ROOT}/edge/authentik/postgres:/var/lib/postgresql/data`, `POSTGRES_PASSWORD: ${AUTHENTIK_PG_PASSWORD:?required}`.

### Caddyfile (deploy/edge/Caddyfile)

```caddyfile
{
	email {$ACME_EMAIL}
	# Na czas testów DNS/konfiguracji odkomentować staging CA (limity Let's Encrypt!):
	# acme_ca https://acme-staging-v02.api.letsencrypt.org/directory
}

(security_headers) {
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		-Server
	}
}

auth.ilovelighting.sanok.pl {
	import security_headers
	reverse_proxy edge-authentik-server:9000
}

kag.ilovelighting.sanok.pl {
	import security_headers
	encode zstd gzip
	log { output file /data/access-kag.log { roll_size 20mb roll_keep 5 } format json }

	# 1) MCP — Streamable HTTP; auth per-user tokenem WEWNĄTRZ serwera MCP.
	#    ŚWIADOMIE BEZ forward_auth (klienci MCP nie przejdą redirectu OIDC).
	handle /mcp* {
		reverse_proxy kag-mcp:3001 { flush_interval -1 }
	}

	# 2) Endpointy embedded outpostu Authentika (wymagane, by forward_auth działał na tym vhoście)
	handle /outpost.goauthentik.io/* {
		reverse_proxy edge-authentik-server:9000 { header_up Host {host} }
	}

	# 3) (OPCJA, domyślnie wyłączone) produktowe UI OpenSPG za forward-auth (tylko kag-admin).
	#    Wymaga dopięcia caddy do sieci kag-internal — świadoma decyzja administratora.
	# handle /openspg/* {
	# 	forward_auth edge-authentik-server:9000 {
	# 		uri /outpost.goauthentik.io/auth/caddy
	# 		copy_headers X-Authentik-Username X-Authentik-Groups X-Authentik-Email
	# 	}
	# 	uri strip_prefix /openspg
	# 	reverse_proxy release-openspg-server:8887
	# }

	# 4) Panel (SPA + /api) — OIDC obsługuje panel-api samodzielnie; bez forward_auth.
	handle {
		request_body { max_size 64MB }   # upload plików do ingestu
		reverse_proxy kag-panel:8080     # SSE (log akcji) Caddy flushuje automatycznie
	}
}
```

Uzasadnienie kluczowej decyzji: **panel przez OIDC w aplikacji (Authorization Code + PKCE), NIE przez forward-auth** — panel potrzebuje tożsamości/grup w API (role, audyt), a forward-auth dawałby tylko nagłówki na proxy; **MCP wyłącznie tokenem per-user** (`Authorization: Bearer sk-...`, weryfikacja sha256 w SQLite panelu) — klient MCP (Claude/IDE) nie umie interaktywnego SSO. Forward-auth zostaje jako mechanizm dla usług „bez własnego auth" (opcjonalne UI OpenSPG, przyszłe appki).

### Konfiguracja Authentika — krok po kroku (docs/authentik-setup.md)

1. **Bootstrap:** `docker compose up -d` w deploy/edge → wejść na `https://auth.ilovelighting.sanok.pl/if/flow/initial-setup/` → ustawić hasło `akadmin` (silne, do menedżera haseł).
2. **Grupy:** Directory → Groups → utworzyć `kag-admin`, `kag-operator`, `kag-viewer`. Dodać siebie do `kag-admin`.
3. **Provider OIDC dla panelu:** Applications → Providers → Create → *OAuth2/OpenID Provider*:
   - Name: `kag-panel-oidc`; Authorization flow: `default-provider-authorization-explicit-consent` (lub implicit-consent — bez ekranu zgody);
   - Client type: **Confidential**; Client ID: `kag-panel` (zapisać), Client Secret → do `deploy/kag/.env` jako `PANEL_OIDC_CLIENT_SECRET`;
   - Redirect URI (strict): `https://kag.ilovelighting.sanok.pl/api/auth/callback`;
   - Signing Key: `authentik Self-signed Certificate`;
   - Scopes: domyślne mapowania `openid`, `email`, `profile` — mapping `profile` w Authentiku emituje claim **`groups`** (lista nazw grup); nic customowego nie trzeba, panel czyta `groups` z ID tokena/userinfo i mapuje: `kag-admin`→admin, `kag-operator`→operator, `kag-viewer`→viewer (pierwsza pasująca, w tej kolejności).
   - Subject mode: `Based on the User's UUID` (stabilny `sub` do rejestru użytkowników MCP w panelu).
4. **Aplikacja:** Applications → Create: Name `KAG Panel`, slug `kag-panel`, Provider `kag-panel-oidc`, Launch URL `https://kag.ilovelighting.sanok.pl/`.
5. **Polityka dostępu:** na aplikacji `KAG Panel` → Policy/Group/User Bindings → dodać bindingi grup `kag-admin`, `kag-operator`, `kag-viewer` (dostęp = członek którejś z grup; reszta kont dostanie 403 od Authentika zanim dotknie panelu).
   - Issuer dla panelu: `https://auth.ilovelighting.sanok.pl/application/o/kag-panel/` (discovery: `.../.well-known/openid-configuration`).
6. **Forward-auth (embedded outpost) dla ścieżek chronionych:**
   - Providers → Create → *Proxy Provider*, tryb **Forward auth (single application)**; Name `kag-openspg-fwd`; External host: `https://kag.ilovelighting.sanok.pl`;
   - Application: Name `OpenSPG Admin`, slug `kag-openspg`, provider `kag-openspg-fwd`; binding: TYLKO grupa `kag-admin`;
   - Applications → Outposts → edytować **`authentik Embedded Outpost`** → w Applications zaznaczyć `OpenSPG Admin` → Update. (Embedded outpost żyje w procesie authentik-server, stąd routing `/outpost.goauthentik.io/*` w Caddyfile na tym samym vhoście co chroniona ścieżka.)
   - Test: po odkomentowaniu bloku `/openspg/*` w Caddyfile niezalogowany dostaje redirect do auth.*, zalogowany bez `kag-admin` — 403.
7. **Higiena:** Flows → `default-authentication-flow` → włączyć MFA (TOTP/WebAuthn) przynajmniej dla `kag-admin`; System → Brand: logo/nazwa po polsku.

---

## 3. Stack `kag` (deploy/kag/compose.yaml)

Te same kotwice `x-security-defaults` + `x-logging`. **Nazwy kontenerów OpenSPG MUSZĄ zostać `release-openspg-*`** (hardkod nazwy minio w kodzie OpenSPG, issue #396).

**Obrazy (digesty startowe = zweryfikowane w optimaKB; komentarz z datą builda obowiązkowy):**
```bash
OPENSPG_MYSQL_IMAGE=spg-registry.us-west-1.cr.aliyuncs.com/spg/openspg-mysql@sha256:71eb546d5fc5faf70b3d8a358c022f601591b54a029b79298f2fa0302e46de9a    # 2025-06-30
OPENSPG_NEO4J_IMAGE=spg-registry.us-west-1.cr.aliyuncs.com/spg/openspg-neo4j@sha256:4bc5b7f6b83d333b1d2c8f60ac145c068d77d50bca65b3a07c927f9e2a541eb9    # 2024-11-20 (DozerDB 5.25.1.0-alpha.1)
OPENSPG_MINIO_IMAGE=spg-registry.us-west-1.cr.aliyuncs.com/spg/openspg-minio@sha256:9493c8e8f77edb10d556255d49ba8b5761b0fe57889235dfd10619c0513da007   # 2024-12-19
OPENSPG_SERVER_IMAGE=spg-registry.us-west-1.cr.aliyuncs.com/spg/openspg-server@sha256:fe6708deef9ebb8da8da7b1cb643e83b827769a5be8811961311639aa1f2cb88 # 2025-07-03, ==0.8/latest
TIKA_IMAGE=apache/tika@sha256:90b7fa1dc018434075fce9e1d9b88b1e3d0ea6979d0cf86e116c79a8073ae973
STIRLING_IMAGE=docker.io/stirlingtools/stirling-pdf:<najnowszy-1.x>   # przypiąć digest przy wdrożeniu
PANEL_IMAGE=kag-panel:local    # build lokalny (services/panel/Dockerfile)
MCP_IMAGE=kag-mcp:local        # build lokalny (services/mcp/Dockerfile)
```

**Tabela usług:**

| Usługa | container_name | cap_add | mem_limit (profil 32G) | sieci | healthcheck |
|---|---|---|---|---|---|
| mysql | release-openspg-mysql | SETUID, SETGID | 2g | kag-internal | `mysqladmin ping` (jak optimaKB) |
| neo4j | release-openspg-neo4j | CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID | 5g | kag-internal | `cypher-shell 'RETURN 1;'` |
| minio | release-openspg-minio | — | 768m | kag-internal | `mc ready local` |
| server | release-openspg-server | — | 5g | kag-internal, **kag-egress** | `curl -fsS -I http://127.0.0.1:8887/`, start_period 120s |
| tika | kag-tika | — | 1.5g | kag-internal | `bash -c 'exec 3<>/dev/tcp/127.0.0.1/9998'` (obraz bez curl/wget) |
| stirling | kag-stirling | — | 2g | kag-internal | `curl -f http://127.0.0.1:8080/api/v1/info/status` |
| panel | kag-panel | — | 512m | kag-internal, edge-net | `wget -qO /dev/null http://127.0.0.1:8080/healthz` |
| mcp | kag-mcp | — | 384m | kag-internal, edge-net | `wget -qO /dev/null http://127.0.0.1:3001/healthz` |

Szczegóły per usługa (delta względem wzorca optimaKB):

- **mysql:** command `--character-set-server=utf8mb4 --collation-server=utf8mb4_general_ci`; wolumeny `${DATA_ROOT}/kag/mysql:/var/lib/mysql` + **`./mysql-init:/docker-entrypoint-initdb.d:ro`** — nowość vs optimaKB: skrypt `10-create-app-user.sh` (wykonywany raz, przy pustym wolumenie) tworzy użytkownika aplikacyjnego:
  ```sh
  #!/bin/sh
  mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL
  CREATE USER IF NOT EXISTS '${MYSQL_APP_USER}'@'%' IDENTIFIED BY '${MYSQL_APP_PASSWORD}';
  GRANT ALL PRIVILEGES ON \`${MYSQL_DATABASE}\`.* TO '${MYSQL_APP_USER}'@'%';
  FLUSH PRIVILEGES;
  SQL
  ```
  (env `MYSQL_APP_USER/MYSQL_APP_PASSWORD` dodane do environment mysql). Server loguje się jako `openspg_app`, nie root.
- **neo4j:** heap/pagecache z .env (patrz sizing): `NEO4J_server_memory_heap_initial__size: ${NEO4J_HEAP:-2G}`, `..._heap_max__size: ${NEO4J_HEAP:-2G}`, `..._pagecache_size: ${NEO4J_PAGECACHE:-1G}`; APOC jak w optimaKB; wolumeny `${DATA_ROOT}/kag/neo4j/{data,logs,plugins,import}`.
- **server:** dokładnie wzorzec optimaKB: `entrypoint: ["/bin/sh","-lc"]`, `command: /home/admin/miniconda3/bin/python /opt/openspg/patch_openspg_openai_client.py && exec java -jar arks-sofaboot-0.0.1-SNAPSHOT-executable.jar`; mount `./openspg/patch_openspg_openai_client.py:/opt/openspg/patch_openspg_openai_client.py:ro` (napisany od zera wg tych samych napraw: enable_thinking tylko poza api.openai.com, max_completion_tokens dla OpenAI, temperature=NOT_GIVEN dla OpenAI, wycięcie logowania configów pipeline'u — logują klucze API). Env: `JAVA_TOOL_OPTIONS: -Dfile.encoding=UTF-8 -Xms${OPENSPG_SERVER_XMS:-1024m} -Xmx${OPENSPG_SERVER_XMX:-3072m}`, `SERVER_REPOSITORY_IMPL_JDBC_HOST: release-openspg-mysql`, `..._USERNAME: ${MYSQL_APP_USER:?...}`, `..._PASSWORD: ${MYSQL_APP_PASSWORD:?...}`, `BUILDER_MODEL_EXECUTE_NUM: ${BUILDER_MODEL_EXECUTE_NUM:-4}`,
  `CLOUDEXT_GRAPHSTORE_URL` i `CLOUDEXT_SEARCHENGINE_URL: neo4j://release-openspg-neo4j:7687?user=${OPENSPG_NEO4J_USER:?}&password=${OPENSPG_NEO4J_PASSWORD_URLENCODED:?}&database=neo4j`,
  `CLOUDEXT_OBJECTSTORAGE_URL: minio://release-openspg-minio:9000?accessKey=${MINIO_ROOT_USER:?}&secretKey=${MINIO_ROOT_PASSWORD_URLENCODED:?}` + komplet tłumienia logów (`LOGGING_LEVEL_COM_ANTGROUP_OPENSPG_COMMON_UTIL_PEMJA: "OFF"`, AppController OFF, sofaboot WARN). `depends_on` na healthy mysql/neo4j/minio. **BEZ sekcji ports.**
- **stirling (OCR PL):** obraz standardowy Stirling-PDF przypięty digestem; polski OCR przez wolumen `${DATA_ROOT}/kag/stirling/tessdata:/usr/share/tessdata` — bootstrap.sh pobiera `pol.traineddata`, `eng.traineddata`, `osd.traineddata` z repo tessdata_fast (deterministycznie, bez zależności od wariantu „fat" i od egressu kontenera). Env: `SECURITY_ENABLELOGIN: "false"` (usługa tylko w kag-internal, auth zapewnia sieć), `SYSTEM_DEFAULTLOCALE: pl-PL`, `JAVA_OPTS: -Xmx1g`. RAM 2g (OCR potrafi skoczyć na dużych skanach; kolejkowanie po stronie panel-api: max 1-2 równoległe OCR).
- **panel (kag-panel):** JEDEN obraz dla API i frontendu — multi-stage Dockerfile: stage build-web (`node:22-alpine` → `vite build`), stage runtime (`node:22-alpine`, Fastify + `@fastify/static` serwuje `web/dist` z fallbackiem SPA). Decyzja: **statyki serwuje panel-api, nie Caddy** — jeden origin (proste cookies OIDC), atomiczny deploy UI+API, Caddy pozostaje generyczny (nie zna buildów aplikacji). Hardening: `user: "10001:10001"`, `read_only: true` + `tmpfs: /tmp`, wolumen rw tylko `${DATA_ROOT}/kag/panel:/data` (SQLite, inbox, exporty CSV, audit JSONL). Panel widzi: OpenSPG (`http://release-openspg-server:8887`), tika, stirling, LLM (egress przez edge-net), Authentik (alias caddy).
- **mcp (kag-mcp):** własny obraz `node:22-alpine`, ten sam hardening; czyta bazę kluczy przez wewnętrzne API panelu (`http://kag-panel:8080/internal/...` z tokenem serwisowym) — NIE współdzieli pliku SQLite (jeden pisarz). Port 3001 tylko w sieciach docker.

---

## 4. Układ .env / sekretów i katalogów danych

**Zasady:** wszystkie sekrety z `:?required` (zero defaultów dla tożsamości — wzorzec optimaKB); `.env` poza gitem (`.gitignore`: `deploy/**/.env`), chmod 600, właściciel root; `.env.example` kompletny z komendami generowania. Hasła wklejane do URL-i OpenSPG wymagają wariantu `*_URLENCODED` (helper w docs: `python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' 'HASŁO'`). Klucze LLM (openie_llm/chat_llm) NIE żyją w .env — trzymane w ustawieniach panelu (SQLite, maskowane w API), wstrzykiwane do OpenSPG per projekt przy jego tworzeniu.

**deploy/edge/.env.example:**
```bash
TZ=Europe/Warsaw
DATA_ROOT=/srv/kag-data
ACME_EMAIL=jarekapka@gmail.com
CADDY_IMAGE=caddy@sha256:...            # pin przy wdrożeniu, komentarz z wersją/datą
AUTHENTIK_IMAGE=ghcr.io/goauthentik/server@sha256:...   # 2025.x
POSTGRES_IMAGE=postgres@sha256:...      # 16-alpine
REDIS_IMAGE=redis@sha256:...            # 7-alpine
AUTHENTIK_SECRET_KEY=change-me          # openssl rand -base64 48
AUTHENTIK_PG_USER=authentik
AUTHENTIK_PG_DB=authentik
AUTHENTIK_PG_PASSWORD=change-me         # openssl rand -base64 36
# AUTHENTIK_EMAIL__HOST/PORT/USERNAME/PASSWORD/FROM (opcjonalnie, SMTP)
```

**deploy/kag/.env.example:** TZ, DATA_ROOT, 6 obrazów jw., `MYSQL_DATABASE=openspg`, `MYSQL_ROOT_PASSWORD`, `MYSQL_APP_USER=openspg_app`, `MYSQL_APP_PASSWORD`, `OPENSPG_NEO4J_USER=neo4j`, `OPENSPG_NEO4J_PASSWORD` + `_URLENCODED`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` + `_URLENCODED`, `OPENSPG_SERVER_XMS/XMX`, `NEO4J_HEAP`, `NEO4J_PAGECACHE`, `BUILDER_MODEL_EXECUTE_NUM`, `PANEL_PUBLIC_URL=https://kag.ilovelighting.sanok.pl`, `PANEL_OIDC_ISSUER=https://auth.ilovelighting.sanok.pl/application/o/kag-panel/`, `PANEL_OIDC_CLIENT_ID=kag-panel`, `PANEL_OIDC_CLIENT_SECRET`, `PANEL_SESSION_SECRET`, `PANEL_INTERNAL_TOKEN` (panel↔mcp), `MCP_PUBLIC_URL=https://kag.ilovelighting.sanok.pl/mcp` — wszystkie sekrety w compose przez `${X:?X is required}`.

**Katalogi danych (bind mounty — proste backupy; tworzone przez bootstrap.sh z właściwymi uprawnieniami):**
```
/srv/kag-data/
├── edge/
│   ├── caddy/{data,config}                 # certy LE (data — KRYTYCZNE do backupu)
│   └── authentik/{postgres,media,certs,custom-templates}
├── kag/
│   ├── mysql/                              # projekty, joby, konfiguracje LLM (jasypt)
│   ├── neo4j/{data,logs,plugins,import}    # graf wiedzy
│   ├── minio/                              # uploady builderowe
│   ├── stirling/tessdata/                  # pol/eng/osd.traineddata
│   └── panel/{db,inbox,exports,audit}      # SQLite + cykl wiedzy (0700, uid 10001)
└── backups/{nightly,verify}
```

---

## 5. Backup i aktualizacje

**Backup — co:** (1) dump logiczny MySQL (`docker exec release-openspg-mysql mysqldump --single-transaction`), (2) tar.zst `kag/neo4j/data`, (3) tar.zst `kag/minio`, (4) kopia online SQLite panelu (`docker exec kag-panel node scripts/db-backup.mjs` → better-sqlite3 `.backup()` do `/data/backup-staging/`, potem zabierany z bind mountu), (5) `pg_dump` Authentika (`docker exec edge-postgres`), (6) tar `edge/caddy/data` (certy), (7) kopie obu `.env` (0600), (8) audit JSONL panelu, (9) `compose config` + `compose ps` (stan). Manifest `_manifest.json` (ok, timestamps, rozmiary, sha256, warnings) — wzorzec backup_openspg_stack.mjs, ale w bash (host bez node).

**Czym i kiedy:** `deploy/scripts/backup.sh` + systemd `kag-backup.service` (Type=oneshot, Nice=10, IOSchedulingClass=idle) i `kag-backup.timer` (`OnCalendar=*-*-* 03:20:00`, `RandomizedDelaySec=10m`, `Persistent=true` — jak OpenSPG_Backup.timer z optimaKB). Retencja: 14 snapshotów nightly + pierwszy snapshot miesiąca trzymany 6 mies. **Weryfikacja** (`kag-backup-verify.timer`, niedziela 04:30): test integralności archiwów, restore dumpu MySQL do jednorazowego kontenera mariadb + zliczenie tabel, `PRAGMA integrity_check` na kopii SQLite; raport JSON do `backups/verify/`. **Cold snapshot Neo4j** raz w miesiącu (opcja w skrypcie: `compose stop neo4j` → tar → `start`; hot-tar DozerDB może być niespójny — stąd weryfikacja + zimna kopia). Off-site: rsync/rclone snapshotu na zewnętrzny storage — parametr `BACKUP_OFFSITE_TARGET` (puste = pomijane, warning w manifeście).

**Aktualizacje — bez Watchtowera (pinning digestów jest celowy):**
- `deploy/scripts/update_check.sh`: `skopeo inspect` (lub `docker manifest inspect`) dla każdego obrazu → raport „nowy digest dostępny"; człowiek podnosi digest w `.env`, robi backup, `docker compose pull && up -d`, czeka na healthy, odpala smoke test (`deploy/scripts/smoke.sh`: healthz panelu/mcp, login-flow HEAD, `/v1/projects/list` przez exec).
- Authentik: tylko w ramach przeczytanych release notes; server+worker zawsze razem (jeden tag); migracje DB robi sam przy starcie — backup PG przed.
- OpenSPG: **domyślnie zamrożony** (martwy upstream KAG-framework, ograniczenie „nie zmieniać modelu embeddingów", nieznane migracje) — aktualizacja tylko jako świadoma operacja z pełnym snapshotem i testem na kopii.
- OS: unattended-upgrades (tylko security); docker engine ręcznie w oknie serwisowym.

---

## 6. Wymagania sprzętowe i przycięcie heapów

Dwa profile (zmienne w `.env`, żadnej edycji compose):

| Składnik | Profil S — 32 GB RAM / 8 vCPU (DOMYŚLNY) | Profil M — 64 GB / 12 vCPU (jak optimaKB) |
|---|---|---|
| neo4j mem_limit / heap / pagecache | 5g / 2G / 1G | 10g / 4G / 2G |
| openspg-server mem_limit / Xms / Xmx | 5g / 1024m / 3072m | 6g / 2048m / 4096m |
| BUILDER_MODEL_EXECUTE_NUM | 4 | 6 |
| mysql / minio / tika / stirling | 2g / 768m / 1.5g / 2g | 2g / 1g / 2g / 2g |
| panel / mcp | 512m / 384m | 512m / 512m |
| stack edge łącznie | ~3g | ~3g |
| **Suma mem_limitów** | **~20.5g** (zapas na OS page cache) | **~34g** |

Dysk: min. 250 GB NVMe (dane + 14 dni backupów lokalnych; neo4j+minio rosną z korpusem — alarm przy 80% w runbooku). Sieć: publiczne IPv4, rekordy A `auth.` i `kag.ilovelighting.sanok.pl` ustawione **przed** pierwszym startem Caddy (inaczej ACME wypali limity — na testy staging CA). Swap 4-8 GB + `vm.swappiness=10` jako bezpiecznik OOM.

---

## 7. Kolejność wdrożenia (runbook — docs/deployment.md)

1. DNS A dla obu vhostów → IP serwera; instalacja docker + compose-plugin.
2. `git clone` repo do `/opt/kag`; `deploy/scripts/bootstrap.sh`: tworzy `docker network create edge-net`, katalogi `/srv/kag-data/*` z uprawnieniami (panel 10001, postgres 999...), pobiera traineddata tesseracta, kopiuje `.env.example`→`.env` (przypomina o chmod 600).
3. Wypełnić `deploy/edge/.env` → `docker compose -f deploy/edge/compose.yaml up -d` → initial-setup Authentika → sekcja 2 (grupy, provider, aplikacja, outpost) → client secret do `deploy/kag/.env`.
4. Wypełnić `deploy/kag/.env` (helper urlencode) → `docker compose -f deploy/kag/compose.yaml build panel mcp && up -d` → wszystkie healthy (`compose ps`).
5. Logowanie do panelu jako członek `kag-admin`; w Ustawieniach wpisać klucze LLM; smoke.sh.
6. `systemctl enable --now kag-backup.timer kag-backup-verify.timer` (unit-y z deploy/systemd/, ExecStart wskazuje na /opt/kag/deploy/scripts/).

## Krytyczne pliki dla implementacji
- /kag/deploy/kag/compose.yaml
- /kag/deploy/edge/compose.yaml
- /kag/deploy/edge/Caddyfile
- /kag/deploy/kag/.env.example
- /kag/deploy/scripts/bootstrap.sh
(wzorce: /tmp/claude-0/-kag/f4ed8b2b-28a2-4090-98d4-1eb1b4e15be8/scratchpad/optimaKB/compose.yaml, .../.env.example, .../scripts/backup_openspg_stack.mjs, .../scripts/patch_openspg_openai_client.py, .../docs/reference/OpenSPG_Backup.timer)


## FILE LAYOUT
- deploy/edge/compose.yaml — stack edge: Caddy + Authentik server/worker + PostgreSQL + Redis, sieci edge-net(external)/edge-internal, healthchecki, mem_limity
- deploy/edge/Caddyfile — vhosty auth.* i kag.*, routing /mcp (bez forward-auth, flush_interval -1), /outpost.goauthentik.io, opcjonalny /openspg za forward-auth, fallback na panel
- deploy/edge/.env.example — obrazy z digestami, ACME_EMAIL, sekrety Authentika/PG z :?required
- deploy/kag/compose.yaml — 5 usług OpenSPG (release-openspg-*) + tika + stirling + panel + mcp; x-security-defaults, cap_add minimalne, digest-pinning, kag-internal(internal:true)/kag-egress, zero portów na host
- deploy/kag/.env.example — digesty OpenSPG, MYSQL_APP_USER, warianty *_URLENCODED, heapy (NEO4J_HEAP, OPENSPG_SERVER_XMX), OIDC panelu
- deploy/kag/mysql-init/10-create-app-user.sh — tworzy użytkownika openspg_app przy pierwszej inicjalizacji wolumenu MySQL
- deploy/kag/openspg/patch_openspg_openai_client.py — patch klienta OpenAI w obrazie serwera (enable_thinking/max_completion_tokens/temperature + wyciszenie logów z kluczami), montowany :ro
- deploy/scripts/bootstrap.sh — edge-net, katalogi /srv/kag-data z uprawnieniami, pobranie pol/eng/osd.traineddata, szkielet .env
- deploy/scripts/backup.sh — snapshot: mysqldump, tar.zst neo4j/minio, kopia SQLite panelu, pg_dump Authentika, certy Caddy, manifest JSON, retencja
- deploy/scripts/verify_backup.sh — cotygodniowa weryfikacja: testy archiwów, restore MySQL do kontenera tymczasowego, PRAGMA integrity_check
- deploy/scripts/update_check.sh — skopeo/manifest inspect vs przypięte digesty, raport dostępnych aktualizacji
- deploy/scripts/smoke.sh — test dymny po deployu/aktualizacji (healthz, projects/list, login-flow)
- deploy/systemd/kag-backup.service — oneshot uruchamiający backup.sh (Nice=10, IOSchedulingClass=idle)
- deploy/systemd/kag-backup.timer — OnCalendar 03:20, RandomizedDelaySec=10m, Persistent=true
- deploy/systemd/kag-backup-verify.service — oneshot verify_backup.sh
- deploy/systemd/kag-backup-verify.timer — niedziela 04:30
- docs/deployment.md — runbook wdrożenia krok po kroku (PL)
- docs/authentik-setup.md — konfiguracja Authentika: grupy kag-*, provider OIDC, aplikacja, embedded outpost, forward-auth (PL)
- docs/runbook.md — operacje: aktualizacje, restore z backupu, diagnostyka bez portów na hoście (PL)
- services/panel/Dockerfile — multi-stage: vite build frontendu + runtime Fastify serwujący statyki (interfejs do podsystemu panelu)
- services/mcp/Dockerfile — runtime node:22-alpine serwera MCP (interfejs do podsystemu MCP)

## RISKS
- Hot-tar katalogu Neo4j/DozerDB może dać niespójny backup — mitigacja: cotygodniowa weryfikacja restore + comiesięczny zimny snapshot (stop→tar→start) w oknie nocnym
- Rejestr Aliyun (spg-registry.us-west-1.cr.aliyuncs.com) bywa wolny/niedostępny z EU — mitigacja: po pierwszym pullu `docker save` obrazów do /srv/kag-data/backups/images/ (odtwarzalność bez rejestru)
- OpenSPG REST :8887 bez auth jest osiągalny dla KAŻDEGO kontenera w kag-internal (w tym stirling/tika) — mitigacja: te usługi nie mają ingressu z internetu ani egressu (internal:true), minimalny attack surface; opcjonalnie osobna podsieć datastores w fazie 2
- Statyczne jasypt.encryptor.password=openspg → dump MySQL pozwala odszyfrować klucze LLM — mitigacja: backupy 0600 na szyfrowanym wolumenie, offsite tylko przez szyfrowany kanał, rotacja kluczy LLM po incydencie
- Wspólna edge-net: przyszła skompromitowana appka dojdzie do kag-panel:8080/kag-mcp:3001 — mitigacja: oba wymagają auth na każdym endpoincie (OIDC session/Bearer), zero endpointów anonimowych poza /healthz; docelowo per-app sieci proxy
- Limity Let's Encrypt przy błędnej konfiguracji DNS (5 fail/h) — mitigacja: staging CA w Caddyfile na czas testów, DNS przed pierwszym startem
- Skoki RAM Stirling przy OCR dużych skanów mogą ubić kontener (OOM w mem_limit 2g) — mitigacja: kolejkowanie OCR w panel-api (1-2 równoległe), restart: always, Tika jako fallback ścieżki ekstrakcji
- Aktualizacja Authentika 2025.x→2026.x może zmienić embedded outpost/forward-auth — mitigacja: pin digest, upgrade tylko po release notes, backup PG przed, test forward-auth w smoke.sh
- Hairpin NAT dla OIDC (panel→auth.*) — zmitygowane aliasami sieciowymi caddy w edge-net; UWAGA: aliasy działają tylko dla kontenerów w edge-net, nie w kag-internal
- Profil S (32GB): równoległy duży build (BUILDER_MODEL_EXECUTE_NUM) + OCR może zbliżyć się do limitu — mitigacja: BUILDER=4, swap 4-8G jako bezpiecznik, monitoring w health cockpicie panelu

## OPEN QUESTIONS
- Jakie są realne parametry serwera docelowego (RAM/vCPU/dysk)? Domyślnie projektuję profil S (32 GB RAM, 8 vCPU, 250 GB NVMe) z przełączeniem na profil M przez .env — potwierdzić który obowiązuje
- Czy w v1 wystawiać produktowe UI OpenSPG pod kag.*/openspg/ za forward-auth (tylko kag-admin), czy zostawić blok wykomentowany (domyślna propozycja: wykomentowany — mniejsza powierzchnia ataku)?
- Czy jest konto SMTP do skonfigurowania w Authentiku (reset haseł, zaproszenia użytkowników)? Bez SMTP zarządzanie kontami działa, ale tylko ręcznie przez akadmin
- Czy backup off-site (rclone/rsync na zewnętrzny storage) ma wejść w v1, czy wystarczy lokalna retencja 14 dni + parametr BACKUP_OFFSITE_TARGET do późniejszego wypełnienia?