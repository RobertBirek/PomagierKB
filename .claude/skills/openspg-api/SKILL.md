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
- `jasypt.encryptor.password=openspg` (statyczne!) szyfruje klucze API modeli w MySQL —
  dump MySQL = odszyfrowywalne klucze. Backupy 0600.

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

## Search / reasoner (otwarte /public/v1)
- `POST /public/v1/search/text` (prawdopodobnie `{queryString, labelConstraints, page, size}`)
  i `POST /public/v1/search/vector` (`{label, propertyKey, queryVector, topk, efSearch}`) —
  **payloady NIEZWERYFIKOWANE W BOJU** (optimaKB ich nie używał!). Klient defensywny:
  normalizator odpowiedzi (`{success,result}|{data}|array`), sonda zgodności przy starcie,
  logowanie surowej odpowiedzi przy nieznanym kształcie, fallback FTS5 z degraded:true.
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

## search/text i search/vector — payloady ZWERYFIKOWANE W BOJU (2026-09-02)
Zdekompilowane DTO + potwierdzone na żywym serwerze (wcześniej HTTP 400):
- `POST /public/v1/search/text` body TextSearchRequest:
  `{projectId (WYMAGANE, int), queryString, labelConstraints: ["Ns.Chunk",...], page, topk}`
  — limit to **topk**, NIE "size".
- `POST /public/v1/search/vector` body VectorSearchRequest:
  `{projectId (WYMAGANE), label: "Ns.Chunk", propertyKey, queryVector, topk, efSearch}`.
Konsekwencja: klient musi znać projectId per namespace (u nas: kb_registry.project_id),
więc zapytania idą PER NAMESPACE i są scalane (RRF).
