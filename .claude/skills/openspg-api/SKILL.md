---
name: openspg-api
description: Zweryfikowane API i pułapki serwera OpenSPG 0.8 (self-hosted, obraz release-openspg-server). Używaj przy KAŻDEJ pracy z klientem OpenSPG (packages/shared/src/openspg/), provisioningiem projektów, builder jobami, schematem DSL lub debugowaniu integracji.
---

# OpenSPG 0.8 — zweryfikowane API i pułapki (źródło: analiza optimaKB + rejestr Aliyun, 09/2026)

Serwer: Java 8 / SOFABoot, obraz `spg/openspg-server@sha256:fe6708de...` (== tag 0.8 == latest,
build 2025-07-03). Upstream ZAMROŻONY od 06/2025 — nie zakładać poprawek, pinować digesty.

## Auth
- REST **nie ma żadnej autoryzacji** na :8887 (CORS odbija dowolny Origin z credentials).
  Port NIGDY nie publikowany na host; tylko sieć wewnętrzna docker.
- Produktowy login (dla endpointów /v1/*): `POST /v1/accounts/login` z body
  `{account, password: sha256(password + "OPENSPG")}` → cookie sesyjne (skleić wszystkie
  Set-Cookie w `name=value; name2=value2`). Domyślne konto: openspg / openspg@kag.
  Cookie wygasa — klient musi ponawiać login po 401.
- **Klucze API modeli leżą w MySQL JAWNYM TEKSTEM** (zweryfikowane 2026-09-06 na tej
  instalacji: `kg_user_model` — 1 wiersz, 0 wartości `ENC(...)`, 1 wartość zaczynająca się
  od `sk-`). Konfiguracja ma wprawdzie `jasypt.encryptor.password=openspg` (statyczne
  hasło), ale **w tym buildzie jasypt nie szyfruje niczego** w tabelach `kg_user_model`,
  `kg_config`, `kg_project_info`, `kg_builder_job`, `kg_scheduler_task`.
  Konsekwencje operacyjne (twarde zasady):
  - każdy `mysqldump`, każdy snapshot backupu i każdy zrzut diagnostyczny z tych tabel
    to **bezpośredni wyciek żywego klucza LLM** — traktuj je jak materiał sekretny
    (0600, nigdy poza host bez szyfrowania kanału i pliku);
  - nie wklejaj surowych dumpów MySQL do zgłoszeń, logów ani odpowiedzi API;
  - rotacja klucza LLM u dostawcy MUSI objąć **drugą kopię** w rejestrze modeli serwera
    (`POST /v1/model`) — patrz `docs/runbooks/secret-rotation.md`.

## Projekty i schemat
- `GET /v1/projects/list?isOwner=false&keyword=&pageNo=1&pageSize=200&appId=0` — szukanie po
  namespace = idempotencja provisioningu.
- `POST /v1/projects` body: `{name, namespace, description, visibility:'PRIVATE', tag:'LOCAL',
  config:{vectorizer:{modelId:'<instanceId>@<model>'}}}` → `result` = projectId (liczba).
- modelId embeddingu pochodzi z rejestru modeli SERWERA: `GET /v1/model/list/` (szukać
  entry.model==nazwa && modelType=='embedding'); rejestracja: `POST /v1/model`
  `{provider:'OpenAI', visibility:'PUBLIC_READ', name, config:{api_key, base_url, model,
  modelType:'embedding', customize:{}}}`. Format: `b87d551d...@text-embedding-3-small`.
- **Modelu embeddingu NIE WOLNO zmieniać po utworzeniu projektu** (wektory w grafie).
- `POST /v1/schemas?projectId=N` body `{data:'<cała treść pliku .schema>'}` — upsert; wołać
  też dla istniejącego projektu. Weryfikacja: `GET /v1/schemas/graph/{projectId}` →
  `result.entityTypeDTOList` (mapa nazwa→id; krótkie nazwy po ostatniej kropce).
- **Relacje z DSL NIE materializują się w grafie** → relacje WYŁĄCZNIE jako właściwości
  `*RefId`/`*RefIds` (konwencja `NS:TYPE:...` lub id encji docelowej).
- Schema DSL: wcięcia TABEM; `namespace X`; `Typ(Nazwa): EntityType|ConceptType`;
  `properties:` → `pole(Nazwa): Text` + opcjonalnie `index: Text|TextAndVector`;
  ConceptType ma `hypernymPredicate: isA`. Identyfikatory PO ANGIELSKU (bug #753 psuje
  entity linking dla nie-angielskich nazw). Wszystkie wartości jako Text.
- **Pola >8192 tokenów zabijają wektoryzację** → TextAndVector tylko na krótkich polach
  (nasz standard: chunk.content ≤1800 zn., preview ≤800, summary ≤400).

## Builder (import CSV)
- Upload: `POST /public/v1/reasoner/dialog/uploadFile` (multipart, pole `file`) →
  `result` = URL w MinIO (`http://release-openspg-minio:9000/builder/upload/...`).
- Submit: `POST /public/v1/builder/job/submit` → `result` = jobId. Body:
  `{projectId, createUser, jobName, type:'FILE_EXTRACT', dataSourceType:'CSV', fileUrl,
  lifeCycle:'ONCE', action:'UPSERT', extension:'<ZSERIALIZOWANY JSON>'}` gdzie extension =
  `{dataSourceConfig:{columns:[{name,index}],type:'UPLOAD',fileName,fileUrl,ignoreHeader:true,
  structure:true}, mappingConfig:{mappingType:'entityMapping',
  filter:[{s:'<Ns>.<Entity>',sId:<entityTypeId>,sZhName:'<Entity>',importSchemaCategory:'ENTITY'}],
  config:[{mapping:{kol:[kol],...},name:'<Entity>(<Ns>.<Entity>)',id:'1'}]}}`.
- Status: `GET /public/v1/builder/job/get?id=`; lista:
  `GET /public/v1/builder/job/list?projectId=&start=1&limit=` — **start MUSI być 1**
  (start=0 = bug SQL z ujemnym offsetem).
- Statusy terminalne: FINISH, ERROR, SKIP, TERMINATE, SET_FINISH; aktywne: INIT, WAITING,
  RUNNING. Polling co 3 s, timeout 120 min. Job może wisieć w RUNNING → reuse-active
  tylko gdy (jobName, fileUrl) zgodne i wiek ≤45 min.
- Datasource API wspiera TYLKO ODPS/SLS → import zawsze przez upload CSV + builder job.

## Search / reasoner (otwarte /public/v1) — payloady ZWERYFIKOWANE W BOJU
Jedno źródło prawdy dla `search/*` (zdekompilowane DTO + potwierdzenie na żywym serwerze
2026-09-02, powtórzone 2026-09-06):
- `POST /public/v1/search/text` body `TextSearchRequest`:
  `{projectId (WYMAGANE, int), queryString, labelConstraints: ["Ns.Chunk", ...], page, topk}`
  — limit nazywa się **topk**.
- `POST /public/v1/search/vector` body `VectorSearchRequest`:
  `{projectId (WYMAGANE, int), label: "Ns.Chunk", propertyKey, queryVector, topk, efSearch}`.
- **NIE PRZYWRACAĆ starej wersji** `{queryString, labelConstraints, page, size}` bez
  `projectId`: serwer odpowiada HTTP 400 („There is no such fulltext schema index:
  `_default_text_index`") — dowód z 2026-09-06 na `release-openspg-server`:
  wariant z `size`/bez `projectId` → 400, wariant z `projectId`+`topk` → 200.
- Konsekwencja: klient musi znać `projectId` per namespace (u nas `kb_registry.project_id`),
  więc zapytania idą PER NAMESPACE i są scalane (RRF).
- Klient mimo to zostaje defensywny — ale z INNEGO powodu: niestabilny jest kształt
  **ODPOWIEDZI** (`{success,result}|{data}|goły array`). Stąd normalizator odpowiedzi,
  sonda zgodności przy starcie, log surowej odpowiedzi przy nieznanym kształcie
  i fallback FTS5 z `degraded:true`.
- Wektor zapytania liczymy SAMI (openai-compatible embeddings) modelem IDENTYCZNYM
  z vectorizerem projektu.
- Inne: `/public/v1/reason/run`, `/public/v1/search/custom`, `/v1/chat/completions`
  (produktowy czat: cookie, SSE — NIE UŻYWAMY jako proxy LLM; antywzorzec).

## Infra
- Nazwy kontenerów MUSZĄ być `release-openspg-*` (hardkod nazwy minio w kodzie, issue #396).
- "openspg-mysql" = MariaDB 10.5.8; "openspg-neo4j" = DozerDB 5.25.1.0-alpha.1 (community).
- Sekrety inline w CLOUDEXT_*_URL → warianty *_URLENCODED w .env.
- Obraz serwera patchujemy przy starcie: mount `patch_openspg_openai_client.py:ro` +
  entrypoint `sh -lc 'python patch... && exec java -jar arks-sofaboot-...jar'`.
- Tłumienie logów obowiązkowe: `LOGGING_LEVEL_COM_ANTGROUP_OPENSPG_COMMON_UTIL_PEMJA=OFF`,
  AppController=OFF przez SPRING_APPLICATION_JSON (INFO logował klucze API!), sofaboot WARN.
- `node fetch` bywa rzucał `connect EPERM` tam gdzie curl działał (środowisko optimaKB) —
  przy dziwnych błędach sieci testować curl-em zanim podejrzewasz serwer.
- `/v3/api-docs` zwraca tablicę bajtów (Buffer → utf8), nie obiekt.

## Pierwsze uruchomienie: wymuszona zmiana hasła supera (ZWERYFIKOWANE 2026-09-02)
Świeża instalacja: login openspg/openspg@kag USTAWIA cookie (result:false!), ale **AclFilter
blokuje wszystkie ścieżki poza `POST /v1/accounts/updatePassword`** z błędem "The default
password of the system needs to be changed" (LOGIN_SUPER_PASSWORD_NOT_CHANGE), dopóki hasło
nie zostanie zmienione. Payload (zweryfikowany):
`POST /v1/accounts/updatePassword` z cookie + body
`{"password": sha256(NOWE+"OPENSPG"), "confirmPassword": sha256(NOWE+"OPENSPG")}` → {result:1}.
Po zmianie: login nowym hasłem → result:true i API odblokowane. Warianty ze stringiem w body
dają 400; bez confirmPassword → "confirmPassword is blank". Deployment robi to skryptem
(deploy/scripts — patrz bootstrap-openspg-password w runbooku).

## query/spgType i reason/run — ZWERYFIKOWANE W BOJU (2026-09-04)

- `POST /public/v1/query/spgType` (bez cookie): `{projectId, spgType: "Ns.Chunk",
  ids: ["CHUNK_..."]}` → goły array `[{id, spgType, properties}]`. PUŁAPKI:
  - `properties` zawiera `_content_vector`/`_name_vector` (po 1536 floatów) —
    ZAWSZE odcinaj przed zwróceniem/logowaniem;
  - wszystkie property poza `id` mają LITERALNE cudzysłowy (`name = "\"Tytuł\""`,
    `sectionOrder = "\"0\""`) — quirk buildera przy imporcie CSV; strip `^"..."$`
    (shared: `stripLiteralQuotes` w answer/retrieval.ts).
- `POST /public/v1/reason/run` (KGDSL, synchroniczny): `{projectId, dsl}` →
  `{task: {status: "FINISH", resultTableResult: {total, header, rows}}}`.
  - **LIMIT nie istnieje w KGDSL** (KGDSLInvalidTokenException);
  - równość property musi obejmować literalne cudzysłowy:
    `WHERE s.sourceDocumentRefId == '"DOC_..."'`;
  - **KRYTYCZNE: odpowiedź zawiera `task.graphStoreUrl` z hasłem Neo4j czystym
    tekstem** — NIGDY nie proxy'ować surowo (MCP/API) ani nie logować bez redakcji.
- Flow `/public/v1/reasoner/session|task|dialog/*` — NIE UŻYWAĆ (w optimaKB 12/12
  RUNNING_TIMEOUT + bug projectId=appId).

## Graf NIE MA krawędzi (potwierdzone empirycznie w Neo4j, 2026-09-04)

`MATCH ()-[r]->()` w bazie projektu → **0 relacji**. Relacje `*RefId` z naszego
schematu to zwykłe property typu string — traversal po stronie OpenSPG nie
istnieje. Nawigacja grafowa (neighbors/path) działa na tabeli `graph_edges`
w SQLite (wypełnianej przy eksporcie), NIE przez reasoner.
