# Plan: PomagierKB — samodzielnie hostowana baza wiedzy (OpenSPG) z panelem i MCP

## Kontekst

W `/kag` (pusty katalog, ten VPS) powstaje od zera generyczna platforma baz wiedzy oparta
o **OpenSPG Knowledge Graph**: panel WWW (dostęp przez SSO, nauka/ingest dokumentów, zarządzanie
MCP), serwer **MCP** dla agentów oraz strona „Zapytaj bazę" dla pracowników. Domena:
**kag.ilovelighting.sanok.pl**; globalne SSO (Authentik) pod **auth.ilovelighting.sanok.pl**.
Wzorzec: działające repo `RobertBirek/optimaKB` (ERP Knowledge Assistant; przebadane w tej sesji
przez 12 agentów eksploracyjnych + 4 audyty własne repo) — przenosimy sprawdzone WZORCE i lekcje,
kod piszemy od nowa. Treści będą po polsku; UI po polsku; kod/identyfikatory po angielsku.

Zbadano też: aktualny stan OpenSPG/KAG (upstream de facto zamrożony od 06/2025 — pinujemy
digesty i projektujemy odtwarzalność), szkic KagBox, oraz panel 4 soczewek ulepszeń (41 propozycji,
skuratowane niżej). Szczegółowe projekty 3 podsystemów leżą w scratchpadzie
(`design_infra.md`, `design_backend-mcp.md`, `design_pipeline-frontend.md`, `improvements.txt`,
`optimakb_*.txt`) — pierwszym krokiem implementacji jest skopiowanie ich do `/kag/docs/design/`.

## Stan zastany i parametry

- VPS: **8 vCPU, 24 GB RAM, 435 GB dysku (429 wolne), bez swapa**; Docker 29.7.2 zainstalowany;
  działa kontener `trilium` (host port 8080 — bez kolizji: my publikujemy TYLKO 80/443 Caddy).
- Użytkownik: „masz pełne zasoby tego VPS, jak braknie — zwiększymy stopniowo".
- SMTP i backup offsite: NIE teraz (parametry do późniejszego wypełnienia).
- **Embeddingi: `text-embedding-3-small`** (decyzja użytkownika; zamrażana per projekt OpenSPG —
  pole `vector_model_id` w rejestrze, preflight blokuje rozjazd).
- LLM: API OpenAI-compatible; klucze w ustawieniach panelu (SQLite, sealed AES-GCM), NIE w .env.
  **Wywołania LLM bezpośrednio przez SDK** (chat_llm = mocniejszy, openie_llm = tańszy) —
  NIGDY przez proxy /v1/chat/completions OpenSPG (antywzorzec optimaKB: timeouty 90 s, wyciek
  klucza do logów AppController, brak structured outputs).

## Decyzje kluczowe (rozstrzygnięte)

| Obszar | Decyzja |
|---|---|
| Stack | Node 22 + TypeScript, monorepo npm workspaces (`apps/panel-api`, `apps/panel-web`, `apps/mcp-server`, `packages/*`) |
| Backend | Fastify (deklaratywny routing + JSON Schema + pluginy; koperta `{ok,data}/{ok:false,error}`; 405 z Allow) |
| Frontend | React 18 + Vite + **TanStack Router** (typowane search-params) + TanStack Query; i18n: słownik `pl.ts` + typowane `t()` |
| MCP | **@modelcontextprotocol/sdk**, Streamable HTTP **stateless** (`enableJsonResponse`), multipleks profili po ścieżce `/mcp/<profil>` |
| Stan | **SQLite WAL** (`better-sqlite3`) współdzielony przez panel-api i mcp-server na jednym lokalnym wolumenie (`busy_timeout=5000`, krótkie transakcje `BEGIN IMMEDIATE`); migracje uruchamia tylko panel-api, mcp-server sprawdza wersję i odmawia startu przy rozjeździe |
| Auth panelu | OIDC Authorization Code + PKCE (openid-client v6) w aplikacji; sesja cookie `kag_sid` (HttpOnly/Secure/Lax, host-only, w DB sha256(sid)); role z grup Authentika `kag-admin/operator/viewer` (viewer = domyślna grupa całej firmy); ŻADNEGO trybu anon |
| CSRF | Stateless: weryfikacja `Origin` + `Sec-Fetch-Site` na mutacjach (SameSite=Lax jako baza) — bez tokenów |
| Auth MCP | Klucze `sk-<base64url 24B>` per tożsamość (user LUB **konto serwisowe**); w DB sha256+prefix; **TTL obowiązkowy** (90 dni default); scope read/write (write tworzy tylko admin); limit 5 aktywnych; rotate/revoke + invalidate cache |
| Retrieval | **Hybryda od v1**: FTS5 (trigram — polska fleksja, twarde kody E27/IP65) w SQLite (mirror chunków) + OpenSPG `search/vector` (+`search/text` sondą), fuzja **RRF**; klient OpenSPG defensywny (normalizator odpowiedzi + sonda zgodności + `degraded:true` przy fallbacku) |
| Chunking | Nagłówki markdown → pakowanie akapitów ≤1800 zn., bez overlapu; **Chunk.content indeksowany TextAndVector bezpośrednio** (1800 zn. ≪ limit 8192 tok. — świadome odstępstwo od wzorca preview-only, likwiduje utratę recallu); ReferenceDocument zostaje przy czwórce content/preview≤800/hash/length + summary |
| Build | Domyślnie **lightweight/chunk-only** (bez pełnego OpenIE — koszty, bug #753); dedup po contentHash; kolejność topic→document→chunk; resume po sha256 w SQLite; FORCE po promocji; `builder/job/list` ze `start=1` |
| kb_answer | Bramka odmowy PRZED chat_llm (słaby retrieval → `no_answer` po polsku + luka wiedzy); cytowania `[n]` walidowane post-hoc; `confidence = 0.5*llmSelf + 0.3*topScore + 0.2*coverage`; < progu → learning_gap |
| Izolacja | 1 KB = 1 projekt OpenSPG = 1 namespace; `kb_id/namespace NOT NULL` w każdej tabeli stanu; klucze/profile z jawną listą namespace |
| Sieci | ZERO portów OpenSPG na hoście (nawet 127.0.0.1); `kag-internal` (internal:true) + `kag-egress` tylko dla openspg-server (LLM); `edge-net` (external) łączy Caddy↔panel/mcp; alias sieciowy Caddy = oba vhosty (hairpin OIDC) |
| Ingest v1 | Wklejony tekst + upload pliku + API. **Bez fetch URL-i** (SSRF poza krytyczną ścieżką; URL = tylko metadana provenance; fetch przez n8n lub v1.5 z safe_http) |
| Panel v1 | 6 stron: **Zapytaj** (czat z cytowaniami, mobile-first+PWA), Dodaj treść, Inbox (+luki wiedzy jako zakładka), Bazy wiedzy, MCP, Ustawienia (admin; system/akcje/audyt) |
| Akcje | 202+actionId; guard = partial unique index `(type,resource) WHERE running` (idempotencja bez wyścigów); spawn detached z logiem do pliku; **SSE** `/actions/:id/events` + polling fallback; preflight 422 z `checks[]`; orphan sweep przy starcie |
| Audyt | Hash-chained w SQLite (BEGIN IMMEDIATE, triggery append-only), redakcja po regexie nazw kluczy; wszystkie mutacje + auth_failed; odczyty MCP do usage-JSONL (poza łańcuchem) |
| Obrazy | Wszystko pinowane po digestach (zweryfikowane digesty OpenSPG w design_infra); nazwy kontenerów `release-openspg-*` (hardkod minio #396); patch `patch_openspg_openai_client.py` montowany :ro (własna implementacja) |
| Profil RAM (24 GB) | Neo4j heap 2G/pagecache 1G (limit 4g), OpenSPG Xms 1g/Xmx 3g (limit 4.5g), mysql 2g, minio 768m, tika 1.5g, stirling 2g, panel 512m, mcp 384m, edge ~3g → suma ~21g; **bootstrap tworzy swap 8G + vm.swappiness=10**; BUILDER_MODEL_EXECUTE_NUM=4; wszystkie wartości w .env (skalowanie bez edycji compose) |

## Architektura docelowa

```
INTERNET ──80/443──► [edge-caddy] ── auth.ilovelighting.sanok.pl ──► [authentik server+worker+pg+redis]
                          │ (edge-net, external)
                          ├── kag.ilovelighting.sanok.pl/        ──► [kag-panel :8080]  (SPA+API, OIDC)
                          └── kag.ilovelighting.sanok.pl/mcp/*  ──► [kag-mcp :3001]    (Bearer sk-...)
                                          │ (kag-internal, internal:true)
        [release-openspg-server :8887] [release-openspg-mysql] [release-openspg-neo4j] [release-openspg-minio]
        [kag-tika :9998] [kag-stirling :8080 (OCR pol)]
        openspg-server dodatkowo w kag-egress (wyjście do API LLM)
        panel-api + mcp-server: wspólny wolumen /srv/kag-data/kag/panel (SQLite WAL, uploady, exporty, logi akcji)
```

Cykl wiedzy: intake (tekst/plik/API) → ekstrakcja (Stirling → Stirling-OCR pol → Tika, próg
jakości ≥120 zn. + looksHumanText; bez własnego parsera PDF) → czyszczenie (profile regexowe PL
+ opcjonalny LLM z guardem) → analyze (chat_llm JSON + fallback heurystyczny, `provider` w wyniku)
→ draft w Inboxie → recenzja człowieka (promote/reject; MCP i LLM NIGDY nie piszą do grafu) →
eksport CSV + mirror FTS5 → builder job (upload → submit → polling) → quality gate (10 checków)
→ `dirty=0`. Luki wiedzy: `no_answer`/niski confidence/👎 → rejestr → operator „Utwórz szkic"
(prefill Dodaj treść); auto-drafty z sieci dopiero v1.5 za flagą.

## Struktura repo /kag

```
/kag
├── deploy/
│   ├── edge/{compose.yaml, Caddyfile, .env.example}
│   ├── kag/{compose.yaml, .env.example, mysql-init/10-create-app-user.sh,
│   │        openspg/patch_openspg_openai_client.py}
│   ├── scripts/{bootstrap.sh, backup.sh, verify_backup.sh, update_check.sh, smoke.sh, drift_check.sh}
│   └── systemd/{kag-backup.service|.timer, kag-backup-verify.service|.timer}
├── apps/
│   ├── panel-api/   # Fastify: plugins/ routes/ services/ pipeline/ jobs/ test/
│   ├── panel-web/   # React+Vite: router.tsx routes/ components/ lib/ i18n/ styles/
│   └── mcp-server/  # SDK MCP: server.ts mcp.ts auth.ts profiles.ts tools/ usage-log.ts
├── packages/
│   ├── shared/      # db (open/migrate/migrations/*.sql), audit, crypto (keys, seal),
│   │                # openspg (client/search/builder/login/models), llm (openai-client),
│   │                # schemas (JSON Schema $id), errors
│   └── (ew. eslint-config)
├── schemas/document_kb.schema.tpl        # generyczny szablon DSL (ANGIELSKI, relacje=refId)
├── integrations/n8n/                     # v1.5: szablony workflow
├── docs/{design/, deployment.md, authentik-setup.md, runbooks/*.md}   # PL
├── .claude/{skills/openspg-api/SKILL.md, skills/kag-runbook/, agents/openspg-expert.md,
│            agents/security-reviewer.md}
├── .github/workflows/ci.yml
├── CLAUDE.md  .gitleaks.toml  renovate.json  package.json (workspaces)
```

Schemat SQLite (scalony z projektów 2+3): `users` (oidc|service), `sessions`, `kb_registry`
(namespace PK, project_id, vector_model_id zamrożony, schema_version+hash, job_prefix,
routing_keywords, dirty, status draft→provisioning→active→error/archived), `intakes`, `drafts`,
`actions` (+ partial unique running), `audit` (+ triggery), `api_keys` (TTL!), `mcp_profiles`,
`learning_gaps` (dedupe partial unique na open), `answers` (answerId, pytanie, chunki, confidence
— pod feedback), `feedback`, `settings` (sealed), `schema_versions`, `export_runs/export_files/
upload_records/build_jobs/quality_reports` (manifesty=resume), `breakers`, `webhooks/outbox`
(v1.5), `chunks_mirror` + `chunks_fts` (FTS5 trigram).

## NOWA FUNKCJA (na prośbę użytkownika): Kreator KB z analizą dokumentów

Cel: admin podaje NAZWĘ nowej bazy + **rodzaje dokumentów, które będą w niej uczestniczyć**
(+ po 1-3 PRÓBKI każdego rodzaju), a system sam bada zależności i encje i proponuje schemat.

- **v1 (fundamenty)**: formularz „Nowa baza" z listą typów dokumentów (nazwa+opis, np. „karta
  katalogowa", „norma", „instrukcja montażu") zapisywaną w `kb_registry.config_json`; provisioning
  z generycznego szablonu; `document_category` nadawane draftom przy analyze (klasyfikacja do
  jednego ze zdeklarowanych typów); wersjonowanie schematu + strażnik zmian (blokada destrukcyjnych).
- **v1.5 (pełny kreator AI)**: krok 1 — upload próbek per typ → ekstrakcja tekstu; krok 2 —
  chat_llm (structured output) analizuje próbki ZBIORCZO: proponuje typy encji z właściwościami,
  taksonomie pojęć (ConceptType/hypernym), zależności między typami dokumentów wyrażone JAKO
  WŁAŚCIWOŚCI `*RefId` (twardy constraint OpenSPG), słowa kluczowe routingu, profil czyszczenia
  i chunkingu per typ; krok 3 — render propozycji do DSL + **deterministyczny linter schematu**
  (identyfikatory angielskie `^[A-Za-z][A-Za-z0-9]*$`, wszystkie pola Text, TextAndVector tylko
  na polach ≤800 zn./chunk-content, zakaz linii relacji, obowiązkowe typy bazowe
  ReferenceDocument/Chunk/Topic zawsze obecne) + diff vs szablon pokazany adminowi do
  edycji/zatwierdzenia (human-in-the-loop jak przy draftach); krok 4 — provisioning + zapis
  mapowania typ-dokumentu→encja, używanego potem przez pipeline (ekstrakcja właściwości encji
  z dokumentów danego typu przez openie_llm — schema-constrained, flagą per typ).
- Bezpieczniki: baza ZAWSZE działa na retrievalu chunków nawet gdy encje AI okażą się słabe;
  zmiana schematu tylko addytywna; koszt ekstrakcji widoczny (licznik tokenów per job).

## Fazy implementacji

### Faza 0 — narzędzia i szkielet repo (na prośbę użytkownika wykonać najpierw)
1. Instalacje pluginów (user-scope): `typescript-lsp`, `frontend-design`, `commit-commands`.
2. `git init` w /kag + `.gitignore` (`.env`, `*.env`, `/srv`, dist, node_modules) + **gitleaks**
   pre-commit (core.hooksPath) + `.gitleaks.toml` (reguły: `sk-[A-Za-z0-9_-]{32}`, CLOUDEXT_*_URL)
   — historia czysta od zerowego commita (lekcja F-01).
   **Repo GitHub: `RobertBirek/PomagierKB` (PRYWATNE)** — użytkownik tworzy puste repo w www
   (bez README); ja: `git remote add origin git@github.com:RobertBirek/PomagierKB.git`
   (klucz SSH `id_ed25519_github_robertbirek` zweryfikowany — auth działa), commit początkowy
   i push `main` po scaffoldzie; potem push po każdej ukończonej fazie.
3. Skopiowanie projektów do `docs/design/` (design_infra/backend-mcp/pipeline-frontend,
   improvements, syntezy optimakb_*) — trwały kontekst dla przyszłych sesji.
4. `/kag/.claude/skills/openspg-api/SKILL.md` (endpointy+pułapki OpenSPG z tej sesji),
   agenci `openspg-expert.md`, `security-reviewer.md` (checklista z audytów optimaKB);
   `CLAUDE.md` (komendy, architektura, zasady — uzupełniany po scaffolde).
5. Monorepo: root package.json (workspaces), tsconfig, eslint, vitest; CI `.github/workflows/ci.yml`
   (lint+tsc, testy, compose config -q obu stacków, gitleaks, build obrazów).

### Faza 1 — infra (deploy/)
1. `bootstrap.sh`: `docker network create edge-net`, katalogi `/srv/kag-data/*` z uprawnieniami,
   **swap 8G + vm.swappiness=10**, pobranie `pol/eng/osd.traineddata` (tessdata_fast), .env z example.
2. Stack **edge**: compose (Caddy 2.10 + Authentik 2025.x + Postgres 16 + Redis 7, digesty,
   x-security-defaults, x-logging json-file 10m×3, healthchecki, edge-internal); Caddyfile
   (vhosty, `/mcp*` bez forward-auth z flush_interval -1, `/outpost.goauthentik.io/*`,
   blok `/openspg/*` WYKOMENTOWANY, fallback → panel, request_body 64MB).
3. Stack **kag**: compose 8 usług wg design_infra (digesty OpenSPG zweryfikowane; mysql-init
   tworzy `openspg_app`; entrypoint serwera z patchem; CLOUDEXT_* z wariantami URLENCODED;
   komplet tłumienia logów PEMJA/AppController; Stirling z tessdata wolumenem,
   SECURITY_ENABLELOGIN=false; panel/mcp: `user 10001`, `read_only`+tmpfs, multi-stage Dockerfile).
4. `docs/authentik-setup.md` (PL, krok po kroku: initial-setup, grupy kag-*, provider OIDC
   confidential `kag-panel` + redirect `https://kag.../api/auth/callback`, aplikacja, bindingi
   grup, embedded outpost, MFA dla kag-admin) + `docs/deployment.md` (runbook wdrożenia).
5. `smoke.sh` (healthz, discovery OIDC, 302 panelu, initialize+tools/list na /mcp, search).

### Faza 2 — fundamenty backendu (packages/shared)
1. `db/open.ts` (WAL, pragmy) + `migrate.ts` (BEGIN EXCLUSIVE; tryb check-only dla mcp) +
   `migrations/0001_init.sql` (pełny scalony DDL) + repozytoria.
2. `crypto/` (sk-keys sha256+prefix+timingSafeEqual; seal AES-256-GCM), `errors.ts`, `schemas/`.
3. `audit/append.ts` (hash-chain, redakcja, verify) + testy łańcucha.
4. `openspg/`: client (baza+cookie login `sha256(pass+'OPENSPG')`+refresh po 401), models
   (`ensureEmbeddingModel` przez GET/POST /v1/model — modelId format `<instance>@<model>`),
   builder (submit/get/list start=1, statusy terminalne), search (payloady text/vector,
   normalizator odpowiedzi, sonda zgodności, RRF) — testy na fixtures.
5. `llm/openai-client.ts` (chat+embeddings, structured outputs, timeout, 1 retry 5xx, zero logów
   kluczy) + tabela `breakers` (circuit breaker TTL/half-open wokół LLM/OpenSPG/Stirling).
6. **Stub OpenSPG** (mały Fastify na nagranych fixtures: projects/schemas/builder/search) +
   `compose.dev.yaml` (panel+mcp+SQLite+stub — dev bez 16 GB stacka) + seed 2-3 dokumentów PL.

### Faza 3 — panel-api core
1. Pluginy: config (env *_FILE), db, session, oidc (PKCE, grupy→role, refresh, degradacja roli),
   rbac (deny-by-default z route.config), csrf (Origin/Sec-Fetch-Site), rate-limit (trustProxy:1,
   per-sesja na mutacjach), audit hook, error-handler (koperta, 405+Allow, requestId), sse.
2. Trasy: `/auth/*`, `/healthz`, `/api/v1/{me,status,kbs,drafts,actions,audit,learning,
   mcp-admin(profiles/keys/snippets),settings,users}` — pełna tabela w design_backend-mcp §2.2;
   @fastify/swagger → `/openapi.json` (za auth); Idempotency-Key + dedup sha256 na ingest.
3. Actions runner (partial-unique guard, spawn detached, @@progress, SSE, cancel, orphan sweep)
   + preflight; settings (sealed, maskowanie configured+preview, test-llm).
4. KB registry + provisioning (akcja `create_kb`: projects/list → POST /v1/projects z
   config.vectorizer.modelId → render szablonu → POST /v1/schemas → weryfikacja graph →
   zapis rejestru; guard niezmienności embeddingu; `schema_sync` addytywny ze strażnikiem diffów).
5. Słownik komunikatów PL (stany techniczne → ludzkie komunikaty z akcją naprawczą; test na
   kompletność mapowania).

### Faza 4 — pipeline wiedzy
1. Intake worker (kolejka w tabeli, jeden worker in-process; limity: plik ≤50 MB, 100 draftów/dz.).
2. `extract.ts` (kaskada Stirling markdown → Stirling OCR pol → Tika → fail z uczciwym błędem;
   `looksHumanText` czysta funkcja z testami; max 1-2 równoległe OCR).
3. `clean.ts` + `cleanProfiles.ts` (news/blog/docs/pdf/generic PL; opcjonalny openie_llm z guardem
   ≥60% długości); `analyze.ts` (chat_llm JSON → walidacja → fallback heurystyczny; provider+warnings).
4. `chunker.ts` (czysta funkcja; testy właściwości: limit/rekonstrukcja/determinizm).
5. `exporter.ts` (CSV: topic/reference_document/chunk — dokładne kolumny wg design;
   `makeId` z sufiksem sha1; csvEscape RFC; równolegle zapis `chunks_mirror`+FTS5;
   manifesty w SQLite) + `builder.ts` (upload resume po sha256 → reuse-active ≤45 min → submit
   payload FILE_EXTRACT/CSV/UPSERT z extension JSON → polling 3 s/120 min; FORCE po promocji)
   + `qualityGate.ts` (10 checków, verdict OK/WARN/FAIL do quality_reports).
6. Inbox API (promote/reject/withdraw/bulk z dryRun; edycja pending; `dirty=1`).
7. Luki wiedzy (recordGap z dedupe; API; start-draft z prefill).

### Faza 5 — mcp-server
1. Shell Fastify + fabryka McpServer per żądanie (Streamable HTTP stateless, enableJsonResponse);
   `/healthz`, `/readyz` (migracje+profil+sonda search); internal :8091 cache-invalidate.
2. Auth Bearer (lookup po hash, LRU 60 s, batch last_used; 401 JSON-RPC; deny-by-default write).
3. Profile z DB (tools/list == manifest — test kontraktowy w CI).
4. Narzędzia (schematy w design_backend-mcp §7.4): `kb_search` (hybryda RRF + degraded),
   `kb_answer` (bramka odmowy → kontekst ≤6k tok. → chat_llm → walidacja cytowań → confidence
   → gap; zapis `answers`), `kb_list`, `kb_submit_draft` (scope write → inbox), `kb_feedback`
   (👍/👎 → luki). Usage-JSONL poza łańcuchem audytu.

### Faza 6 — frontend (apps/panel-web)
1. Shell: TanStack Router+Query, i18n `pl.ts`+`t()`, theme light/dark (CSS variables), `useMe()`
   + `can()` (nawigacja renderuje tylko dostępne strony; viewer widzi Zapytaj+Dodaj treść).
2. **/ask „Zapytaj bazę"** — mobile-first + manifest PWA; streaming SSE z `/api/ask` (ta sama
   logika co kb_answer); cytowania jako rozwijane karty (drawer z fragmentem); 👍/👎 + „co jest
   nie tak?"; historia per użytkownik; jawne „Nie znalazłem tego w bazie" + plakietka niepewności.
3. /add (taby Plik/Tekst [URL=metadana]; stepper ludzkich etapów; badge providera analizy),
   /inbox (filtry w search-params, podgląd, promote/reject/withdraw, bulk dryRun→confirm,
   zakładka Luki), /kb (rejestr, provision/build/quality, drawer historii, modal Nowa baza
   z typami dokumentów i ostrzeżeniem o embeddingu), /mcp (klucze raw-raz, konta serwisowe,
   profile, snippety claude-code/cursor/generic), /settings (LLM maskowane+test, progi,
   system: akcje z logTail SSE, audyt, health, backupy).
4. Komponenty + czysta logika z testami (health cockpit jako pasek statusu w nagłówku,
   normalizeStatus/worstStatus, bulkSelection, permissions, statusVariant, SafeExternalLink).

### Faza 7 — ops
1. `backup.sh` (mysqldump w kontenerze, tar.zst neo4j/minio, SQLite `.backup()`, pg_dump
   Authentika, certy Caddy, .env 0600, manifest sha256; retencja 14 dni + 1. snapshot miesiąca
   6 mies.) + `verify_backup.sh` (restore MySQL do efemerycznego kontenera, PRAGMA
   integrity_check, tar -tf) + timery systemd (03:20 / niedziela 04:30) + comiesięczny zimny
   snapshot Neo4j (stop→tar→start); parametr `BACKUP_OFFSITE_TARGET` (puste = warning).
2. Uptime Kuma w edge (za forward-auth) + monitory + ntfy; zewnętrzna sonda (healthchecks.io).
3. `drift_check.sh` (config-hash kontenerów vs compose) + `update_check.sh` (skopeo vs digesty);
   `renovate.json` (Caddy/Authentik/Stirling/node = PR; spg-registry WYKLUCZONE; bez Watchtowera).
4. `docs/runbooks/*.md` (PL): disaster recovery, **break-glass gdy padnie Authentik** (SSH +
   `docker exec` + `ak create_recovery_key` — SSO to pojedynczy punkt blokady), dysk pełny,
   zawieszony builder job, restore pojedynczej KB.

### Wdrożenie (runbook docs/deployment.md)
DNS A `auth.` i `kag.ilovelighting.sanok.pl` → VPS (PRZED startem Caddy; na testy staging CA)
→ bootstrap.sh → edge up → konfiguracja Authentika wg docs → kag up (build panel/mcp) →
logowanie kag-admin → Ustawienia: klucz LLM → utworzenie 1. bazy (namespace angielski, typy
dokumentów) → provision → pierwszy dokument → build → Zapytaj → smoke.sh → timery backupu.

## Zakres v1.5 (zaraz po MVP) i roadmap

**v1.5**: pełny **Kreator KB z analizą AI** (wyżej); query rewriting PL + rerank top-20; cache
odpowiedzi wersjonowany kbVersion; ekspansja grafowa po refId; normalizacja polskich nazw encji;
endpoint **OpenAI-compatible** (`/v1/chat/completions`+`/v1/models`, model=`kag:<ns>`); webhooki
(outbox+HMAC; draft.awaiting_review, build.failed, api_key.expiring...); szablony n8n
(integrations/n8n: powiadomienia, scraping→ingest, Google Drive→upload); fetch URL z safe_http;
restore-drill miesięczny + offsite; strona „Czego baza nie wie" (grupowanie po podobieństwie);
kreator onboardingu; auto-drafty z sieci za flagą (Exa/Tavily); eksport/import KB jako paczka.

**Roadmap**: profil ekstrakcji „katalog produktowy" (tabele fotometryczne → encje Product:
moc/strumień/barwa/IP/SKU — kluczowe dla firmy oświetleniowej); progressive trust z optimaKB
(shadow→adjudykacja→canary→aprobata) + self-learning bez ML + shadowCalibration; discovery źródeł;
mini-eval rozszerzony o LLM-judge; budżety tokenów per KB/dzień.

**Eval (goldens) — w v1, budowany przyrostowo**: `goldens.jsonl` zaczyna się od ~20 pytań
zebranych przy pierwszych ingestach (w tym pytania negatywne); `npm run eval` liczy hit@k/MRR
na retrievalu (zero kosztu LLM); wynik w quality gate.

## Weryfikacja end-to-end

1. **CI zielone**: lint+tsc, vitest (chunker properties, audit chain, makeId, health, permissions,
   słownik komunikatów), testy kontraktowe (koperta REST, 405, tools/list==profil na stubie),
   `docker compose config -q` × 2, gitleaks.
2. **Dev-stub**: pełny cykl na compose.dev (intake→draft→promote→export→build na stubie→gate)
   + MCP initialize/tools/call kluczem testowym.
3. **Staging namespace na żywym OpenSPG**: provision `StagingSmoke` → ingest 3 przykładowych
   dokumentów PL → build FINISH → `search/vector` zwraca chunki → kb_answer z cytowaniami →
   goldens hit@5 sensowne; potem pierwszy realny KB.
4. **Smoke po deployu**: `deploy/scripts/smoke.sh` (patrz Faza 1.5) — musi przechodzić po każdej
   aktualizacji; `verify_backup` po pierwszej nocy.
5. **Bezpieczeństwo**: `docker ps` — żadnych portów poza 80/443; próba wejścia na panel bez
   grupy kag-* = 403; klucz revoked → 401 ≤60 s; audit/verify OK; gitleaks na historii czysty.

## Założenia i kwestie otwarte (przyjęte domyślnie, do zmiany w trakcie)

- Klucze write MCP tworzy wyłącznie admin; operator tylko własne read.
- Sesja: absolutna 12 h + idle 60 min (offline_access w providerze — wg docs/authentik-setup.md).
- W usage-logu MCP: metadane + preview odpowiedzi 500 zn. (nie pełne treści).
- Promote zablokowany dopóki KB nie jest `active`.
- Pierwsza baza tworzona ręcznie przez admina (bez auto-seeda); domyślny KB dla fallback
  routingu = pierwsza utworzona baza (flaga w rejestrze).
- Produktowe UI OpenSPG niewystawiane (blok w Caddyfile wykomentowany).
- Trilium na porcie 8080 hosta zostaje bez zmian (nie koliduje); ewentualne wpięcie go za
  Caddy/Authentika = osobna, późniejsza decyzja użytkownika.
