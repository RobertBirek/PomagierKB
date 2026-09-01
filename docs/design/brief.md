# BRIEF: Projekt "KAG" — generyczna baza wiedzy OpenSPG + panel + MCP

## Cel
Nowy projekt w /kag (pusty katalog): samodzielnie hostowana baza wiedzy oparta o OpenSPG
Knowledge Graph, z panelem WWW (dostęp, nauka/ingest, MCP) i serwerem MCP dla agentów.
Domena: **kag.ilovelighting.sanok.pl**. Authentik (SSO) pod **auth.ilovelighting.sanok.pl**.
Serwer docelowy CZYSTY (nic na nim nie ma). Wszystko po polsku w UI; kod/identyfikatory po angielsku.
Pisane OD ZERA (bez kopiowania kodu), wzorowane na działającym repo RobertBirek/optimaKB
(sklonowane w /tmp/claude-0/-kag/f4ed8b2b-28a2-4090-98d4-1eb1b4e15be8/scratchpad/optimaKB —
möżna zaglądać dla wzorców) i lekcjach z jego 4 audytów.

## Decyzje już podjęte (użytkownik)
- Deployment w całości w tym projekcie; TLS przez własny reverse proxy.
- **Dwa stacki compose**: (1) `edge` — Caddy (80/443, auto-TLS Let's Encrypt) + Authentik
  (server+worker+PostgreSQL+Redis) pod auth.ilovelighting.sanok.pl; obsłuży też przyszłe
  aplikacje na tym serwerze; (2) `kag` — cała reszta; łączność przez zewnętrzną wspólną sieć docker.
- Authentik = globalne logowanie WSZYSTKICH aplikacji: panel przez OIDC (Authorization Code),
  usługi bez OIDC (ew. UI OpenSPG) przez forward-auth Caddy → embedded outpost.
- LLM: API OpenAI-compatible (klucz w konfiguracji). Rozdział openie_llm (tańszy model do
  ekstrakcji) i chat_llm (mocniejszy do odpowiedzi) jak w KAG.
- Stirling PDF w stacku kag jako OCR dokumentów (pierwszy stopień ekstrakcji PDF; potem Tika).

## Decyzja stackowa (moja, po analizie optimaKB — uzasadnienie w planie)
- Backend panelu: **Node.js 22 + Fastify** (deklaratywny routing + schema-validation zamiast
  4372-liniowego monolitu node:http z ręcznymi if-ami — bezpośrednia lekcja z optimaKB).
- Frontend: **React 18 + Vite** (jak optimaKB), + TanStack Router/Query zamiast hash-routingu
  i prop-drillingu; UI po polsku; motyw light/dark na CSS variables.
- MCP: **oficjalny @modelcontextprotocol/sdk** (TypeScript), transport Streamable HTTP —
  naprawia niezgodność framingu stdio (Content-Length zamiast NDJSON) i pseudo-SSE z optimaKB.
- Stan aplikacji: **SQLite (better-sqlite3)** zamiast plików JSON (naprawia wyścigi
  verifyApiKey/registry, O(n) skan, brak transakcji).
- Pipeline wiedzy: Node, komunikacja z OpenSPG przez REST (jak optimaKB) — bez frameworka
  Python openspg-kag (martwy od 06/2025, stare pinowane zależności; server w trybie
  produktowym i tak ma KAG w środku przez PemJa — builder joby i reasoner działają serwerowo).

## Fakty o OpenSPG (zweryfikowane; NIE zgadywać inaczej)
- Obrazy TYLKO z rejestru Aliyun spg-registry.us-west-1.cr.aliyuncs.com/spg/*.
  `latest`==`0.8` dla openspg-server (digest sha256:fe6708de...). Pinujemy po digestach
  (wzorzec optimaKB: digest + komentarz z datą builda). "openspg-mysql"=MariaDB 10.5.8;
  "openspg-neo4j"=DozerDB 5.25.1.0-alpha.1 (community fork).
- Oficjalny compose BEZ wolumenów danych → dodać własne. Kontener minio bywa szukany po
  nazwie `release-openspg-minio` (hardkod, issue #396) → nazwy kontenerów zostają release-openspg-*.
- Server: Java 8, jasypt.encryptor.password=openspg (statyczne! szyfruje klucze API LLM w MySQL),
  brak JAKIEJKOLWIEK autoryzacji na REST API :8887 (F-22 z audytu optimaKB), CORS odbija dowolny
  Origin z credentials — NIGDY nie wystawiać 8887 publicznie; tylko sieć wewn. + ew. forward-auth.
- Login produktowego UI: POST /v1/accounts/login, hasło = sha256(password+"OPENSPG"),
  auth = cookie sesyjne; optimaKB ma skrypt auto-loginu i cookie w pliku 0600.
- REST używane przez optimaKB (sprawdzone w boju):
  GET /v1/projects/list?...  POST /v1/projects {name,namespace,visibility,tag,config.vectorizer.modelId}
  POST /v1/schemas?projectId=N {data:<schema DSL>}  GET /v1/schemas/graph/{projectId}
  POST /public/v1/reasoner/dialog/uploadFile (multipart → URL MinIO)
  POST /public/v1/builder/job/submit (type FILE_EXTRACT, dataSourceType CSV, action UPSERT,
    extension = zserializowany JSON z dataSourceConfig{columns,fileUrl,ignoreHeader}
    + mappingConfig{entityMapping,filter[{s,sId}],config[{mapping}]})
  GET /public/v1/builder/job/get?id=  GET /public/v1/builder/job/list?projectId=&start=1&limit=
    (start MUSI być 1; 0 = bug SQL) — statusy terminalne FINISH/ERROR/SKIP/TERMINATE/SET_FINISH
  POST /v1/chat/completions (produktowy czat: cookie, body {app_id,session_id,prompt:[{type:'text',
    content}],thinking_enabled,search_enabled}; odpowiedź JSON lub SSE data:... [DONE])
  otwarte też: /public/v1/search/text|vector|custom, /public/v1/reason/run
- Pułapki: relacje z DSL schematu NIE materializują się w grafie → relacje jako właściwości
  refId (konwencja `NS:TABLE:...`); pola >8192 tokenów zabijają wektoryzację → wzorzec
  "czwórki": description (pełny, Text) + descriptionPreview (≤800 zn., TextAndVector) +
  descriptionHash (sha256) + descriptionLength; schema po ANGIELSKU (bug #753 psuje linking
  dla nie-angielskich nazw); embedding modelu NIE zmieniać po utworzeniu projektu.
- Schema DSL (plik .schema, commit przez POST /v1/schemas): namespace X; Typ(Nazwa): EntityType/
  ConceptType; properties: pole(Nazwa): Text + "index: Text|TextAndVector"; ConceptType ma
  hypernymPredicate: isA.
- RAM: JVM Xmx (optimaKB: 4g, mem_limit 6g), Neo4j 10g limit; BUILDER_MODEL_EXECUTE_NUM=6.
- optimaKB patchuje obraz serwera przy starcie: montuje patch_openspg_openai_client.py :ro
  i entrypoint = python patch && exec java -jar ... (naprawa klienta OpenAI) — przewidzieć
  taki sam mechanizm.
- Compose hardening z optimaKB (do skopiowania jako wzorzec): x-security-defaults z
  no-new-privileges + cap_drop:[ALL]; cap_add minimalny: mysql [SETUID,SETGID], neo4j
  [CHOWN,DAC_OVERRIDE,FOWNER,SETUID,SETGID], reszta zero; mem_limit per usługa; healthchecki
  (mysql mysqladmin ping, neo4j cypher-shell RETURN 1, minio mc ready local, server curl -I,
  start_period 90s); depends_on service_healthy; sekrety w .env z `:?required` (zero defaultów
  dla tożsamości); MYSQL_APP_USER=openspg_app (nie root); sekrety inline w CLOUDEXT_*_URL
  wymagają wariantów *_URLENCODED; tłumienie logów (PEMJA=OFF itd., bo logują klucze API).

## Sprawdzone wzorce optimaKB do przeniesienia (idee, nie kod)
- Cykl wiedzy: draft (inbox, JSON+MD) → analyze (LLM z fallbackiem heurystycznym, provider
  w odpowiedzi) → promote (rejestr, audyt, odwracalne withdraw/reopen) → export (CSV +
  _manifest.json) → build (upload → job → polling; manifesty upload/build = resume;
  FORCE_FILES po promocji) → quality gate (raport .md+.json). MCP/LLM NIGDY nie pisze
  do grafu bezpośrednio — tylko draft do inboxu (human-in-the-loop).
- Akcje długobieżne: 202 + actionId, spawn procesu, log do pliku, GET /api/actions/:id
  z logTail; guard 409 action_already_running; preflight (422 z listą checks) przed buildem.
- Audyt: hash-chained JSONL, redakcja po regexie nazw kluczy, globalny hook na każdą mutację.
- Klucze API MCP: sk-<base64url>, w bazie tylko sha256+prefix, raw jeden raz, rotate/revoke,
  limit aktywnych; osobne tokeny read/write; deny-by-default (writeAllowed !== true);
  REQUIRE_AUTH_ON_PUBLIC_BIND (odmowa startu bez tokenu poza loopback).
- Profile MCP: deklaratywny manifest (id, mode, namespaces, tools, scopes) + multipleks
  po ścieżce /mcp/<profile> w jednym procesie; test kontraktowy tools/list == manifest.
- SSRF guard (safe_http): prywatne IPv4/v6 + DNS lookup all + re-walidacja redirectów.
- Sekrety: wzorzec ENV lub *_FILE; maskowanie w API (configured+preview); 0600.
- Ekstrakcja PDF: Stirling → Tika → próg jakości ≥120 znaków + looksHumanText.
- Czyszczenie treści: profile regexowe per typ (news/blog/docs/pdf) + opcjonalne LLM
  z powrotnym przejściem heurystyki i fallbackiem.
- Luki wiedzy: odpowiedź z confidence<progu → JSONL → (cron) → auto-draft → recenzja.
- Frontend: logika czysta w plikach .js z testami; health cockpit (normalizacja statusów,
  worstStatus); dwufazowy bulk z dryRun preflight; snippety konfiguracyjne MCP w UI;
  klucz pokazany raz; SafeExternalLink; deep-link filtrów.

## Błędy optimaKB których NIE powtarzamy
- Monolit 4372 linii, routing if-ami (martwe endpointy), 3 implementacje atomic write,
  stan w JSON-ach (wyścigi), verifyApiKey zapisujący plik przy każdej weryfikacji,
  spawnSync w /api/status, spin-lock audytu, RATE_BUCKETS bez sprzątania, rate limit po
  remoteAddress za proxy, CSRF per proces (restart = 403), ALLOW_ANON=admin, sekrety
  w git (F-01), retrieval przez grep CSV zamiast OpenSPG, 22 fasadowe narzędzia MCP,
  auth-proxy bez scope, klucze bez TTL, brak CI/testów (node --check to nie testy),
  duplikacja rejestru KB w 5+ miejscach (ma być JEDEN rejestr — w SQLite/konfigu),
  hardkodowane IP/ścieżki, crontab przez execSync, brak dev/staging.

## Wymagania funkcjonalne v1 (proponowany zakres)
1. Stack edge: Caddy + Authentik; vhosty auth.* i kag.*; forward-auth.
2. Stack kag: OpenSPG core (5 usług) + Stirling PDF + panel + MCP.
3. Panel (OIDC przez Authentik; role z grup: kag-admin/kag-operator/kag-viewer):
   - Overview (health cockpit), Bazy wiedzy (rejestr, totals, build), Inbox (drafty:
     lista/filtr/promote/reject/withdraw + bulk z preflight), Dodaj treść (URL/tekst/plik,
     analyze z LLM), Uczenie (luki wiedzy), MCP (użytkownicy, klucze, profile, snippety),
     System (akcje, log, audyt), Ustawienia (klucze LLM/providerów — maskowane).
4. Pipeline: rejestr KB (jedno źródło prawdy), tworzenie projektu OpenSPG + schema DSL
   (generyczny szablon: ReferenceDocument + Chunk + Concept/Topic), ingest dokumentów
   (Stirling OCR → Tika → czyszczenie → chunking → CSV → builder job → quality gate).
5. MCP (oficjalne SDK, Streamable HTTP pod https://kag.ilovelighting.sanok.pl/mcp):
   narzędzia: kb.search (realny OpenSPG search/vector), kb.answer (retrieval + chat_llm
   z cytowaniami), kb.list, kb.submit_draft (write, tylko inbox); auth per-user API keys;
   scoping namespace przez profile.
6. Operacyjność: backup (skrypt + timer), healthchecki, audyt, testy (vitest/node:test),
   CI-ready (npm test), .env.example kompletny, README + docs po polsku.
Poza v1 (fazy późniejsze — zaznaczyć w planie): discovery/monitoring źródeł,
automatyzacja/autopilot/canary, trendy, testpacki QA.
