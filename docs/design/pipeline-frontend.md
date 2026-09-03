# PODSYSTEM 3: Pipeline wiedzy + frontend panelu

Zakres: rejestr KB w SQLite, generyczny szablon schema DSL, provisioning projektów OpenSPG, pipeline ingest (ekstrakcja → czyszczenie → analyze → inbox → promote → chunking → CSV → builder → quality gate), luki wiedzy, frontend React 18 + Vite.

Konwencje wspólne (kontrakt z pozostałymi podsystemami): jedna baza `data/kag.db` (better-sqlite3, `journal_mode=WAL`, `busy_timeout=5000`, dostęp przez pakiet `packages/db` współdzielony z procesem MCP), klient OpenSPG w `packages/openspg-client` (auto-login `POST /v1/accounts/login` z `sha256(password+"OPENSPG")`, cookie w pamięci + odświeżanie po 401), audyt hash-chained przez globalny hook na każdą mutację (podsystem 2), akcje długobieżne wg wzorca 202+actionId.

---

## (a) Rejestr KB — jedyne źródło prawdy (SQLite)

Tabela `kb_registry` (DDL):

```sql
CREATE TABLE kb_registry (
  id            INTEGER PRIMARY KEY,
  namespace     TEXT NOT NULL UNIQUE,          -- ^[A-Z][A-Za-z0-9]{2,29}$ (po angielsku; limit długości backendu OpenSPG)
  name          TEXT NOT NULL,                 -- nazwa wyświetlana (może być PL)
  description   TEXT NOT NULL DEFAULT '',
  project_id    INTEGER,                       -- OpenSPG projectId; NULL dopóki nie sprovisionowany
  schema_version INTEGER NOT NULL DEFAULT 0,   -- ile razy commitowano schema do OpenSPG
  schema_hash   TEXT NOT NULL DEFAULT '',      -- sha256 ostatnio scommitowanego pliku .schema
  vector_model_id TEXT NOT NULL DEFAULT '',    -- zamrożony po provisioningu; NIGDY nie zmieniać
  job_prefix    TEXT NOT NULL,                 -- ≤8 znaków, do nazw builder jobów (limit MySQL na jobName)
  routing_keywords TEXT NOT NULL DEFAULT '[]', -- JSON array; heurystyczny routing analyze/gaps
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','provisioning','active','error','archived')),
  dirty         INTEGER NOT NULL DEFAULT 0,    -- 1 = promocja/withdraw od ostatniego builda; Overview pokazuje "wymaga builda"
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```

Przejścia stanów: `draft → provisioning → active` (provision), `active → error` (nieudany build/gate FAIL — z powodem w `last_error` w akcji), `active → archived` (soft delete; nie kasujemy projektu OpenSPG). Rejestr czytają: eksporter, builder, MCP (lista dozwolonych namespace w profilach), frontend, analyze (routing). Zakaz duplikacji — żaden moduł nie trzyma własnej listy KB (lekcja z optimaKB: rejestr był w 5+ miejscach).

API (Fastify, role w nawiasach):
- `GET /api/kb` (viewer) → `{ items: KbEntry[] }` z totalsami (docs/chunks/topics z tabel pipeline, lastBuildAt, lastQualityVerdict)
- `POST /api/kb` (admin) `{namespace, name, description}` → walidacja regex + unikalność; `job_prefix` auto (inicjały namespace) z możliwością nadpisania
- `POST /api/kb/:namespace/provision` (admin) → 202 `{actionId}` (sekcja b)
- `POST /api/kb/:namespace/build` (operator) `{force?: boolean}` → 202 `{actionId}`; 409 gdy akcja trwa; 422 z listą checks preflight
- `POST /api/kb/:namespace/archive` (admin)
- `GET /api/kb/:namespace` (viewer) → detal + historia buildów + ostatni raport jakości

```ts
type KbEntry = {
  namespace: string; name: string; description: string;
  projectId: number | null; schemaVersion: number; vectorModelId: string;
  status: 'draft'|'provisioning'|'active'|'error'|'archived';
  dirty: boolean;
  totals: { documents: number; chunks: number; topics: number; pendingDrafts: number };
  lastBuildAt: string | null; lastQualityVerdict: 'OK'|'WARN'|'FAIL'|null;
};
```

---

## (b) Generyczny szablon schema DSL + tworzenie projektu

### Szablon `schemas/document_kb.schema.tpl` — KOMPLETNY plik

Placeholder `__NAMESPACE__` podmieniany przy provisioningu (string replace, potem walidacja że nie został żaden placeholder). Wcięcia TABEM (jak w plikach wzorcowych). Wszystko po angielsku (bug #753). Relacje WYŁĄCZNIE przez właściwości `*RefId` / `*RefIds` (relacje z DSL nie materializują się w grafie). Wzorzec czwórki na ReferenceDocument i Chunk; `index: TextAndVector` tylko na `contentPreview` (≤800 znaków) i na krótkim `summary` — nigdy na pełnym `content` (pola >8192 tokenów zabijają wektoryzację).

```
namespace __NAMESPACE__

ConceptTaxonomy(ConceptTaxonomy): ConceptType
	hypernymPredicate: isA

Topic(Topic): EntityType
	properties:
		description(description): Text
		name(name): Text
		semanticType(semanticType): Text
			index: Text
		topicSlug(topicSlug): Text
			index: Text
		usageCount(usageCount): Text
		summary(summary): Text
			index: TextAndVector

ReferenceDocument(ReferenceDocument): EntityType
	properties:
		description(description): Text
		name(name): Text
		semanticType(semanticType): Text
			index: Text
		sourceUrl(sourceUrl): Text
			index: Text
		sourceType(sourceType): Text
		documentCategory(documentCategory): Text
		language(language): Text
		sourceTier(sourceTier): Text
		publishedAt(publishedAt): Text
		retrievedAt(retrievedAt): Text
		topicRefIds(topicRefIds): Text
		conceptRefIds(conceptRefIds): Text
		content(content): Text
		contentPreview(contentPreview): Text
			index: TextAndVector
		contentHash(contentHash): Text
			index: Text
		contentLength(contentLength): Text
		summary(summary): Text
			index: TextAndVector

Chunk(Chunk): EntityType
	properties:
		description(description): Text
		name(name): Text
		semanticType(semanticType): Text
			index: Text
		sourceDocumentRefId(sourceDocumentRefId): Text
			index: Text
		sourceUrl(sourceUrl): Text
			index: Text
		sectionHeading(sectionHeading): Text
		sectionOrder(sectionOrder): Text
		content(content): Text
		contentPreview(contentPreview): Text
			index: TextAndVector
		contentHash(contentHash): Text
			index: Text
		contentLength(contentLength): Text
```

Uwagi projektowe:
- Wszystkie wartości jako `Text` (także liczby/daty) — jak w repo wzorcowym; upraszcza CSV import.
- Konwencja id (kolumna `id` w CSV = główny identyfikator encji, do niego celują `*RefId`): `DOC_<sha1(ns+sourceUrl|contentHash)[:8]>_<SLUG≤80>`, `CHUNK_<docHash8>_<order 3 cyfry>`, `TOPIC_<SLUG>`. Funkcja `makeId` z sufiksem hasha przy truncacji (unikaty przy długich wspólnych prefiksach — wzorzec z export_utils optimaKB).
- Retrieval (kontrakt dla MCP kb.answer): wektorowo po `contentPreview`/`summary`, następnie dociągnięcie PEŁNEGO `content` trafionych chunków do kontekstu LLM — preview to indeks, content to payload.
- `ConceptTaxonomy` jest w schemacie od v1 (żeby nie zmieniać schematu później), ale pipeline v1 NIE eksportuje conceptów (fakt zweryfikowany dotyczy tylko `importSchemaCategory: 'ENTITY'`; import CSV do ConceptType — faza 2 po weryfikacji na żywym serwerze). Tagowanie w v1 robi `Topic` (EntityType) + `topicRefIds`.

### Skąd modelId embeddingu (zweryfikowane w repo wzorcowym)

`config.vectorizer.modelId` ma format `<instanceId>@<nazwa-modelu>` (np. `b87d551d4ba14909907c6e29218fa011@text-embedding-3-small`) i pochodzi z **rejestru modeli serwera OpenSPG**, nie z API OpenAI. optimaKB trzymał go w env, ale rejestr modeli ma pełne API (użyte w `rotate_openspg_chat_model.mjs`):
- `GET /v1/model/list/` → grupy `{ group: {provider, name, visibility}, model: [{ modelId, model, base_url, modelType, type, api_key:'******' }] }`
- `POST /v1/model` → rejestracja: `{ provider:'OpenAI', visibility:'PUBLIC_READ', name:<displayName>, config:{ api_key, base_url, model, modelType, customize:{} } }` (dla embeddingu `modelType:'embedding'`)

Funkcja `ensureEmbeddingModel()` w provisioningu:
1. `GET /v1/model/list/` → znajdź entry, gdzie `entry.model === EMBEDDING_MODEL` (env) i `entry.modelType === 'embedding'`.
2. Brak → `POST /v1/model` z kluczem z konfiguracji sekretów, `base_url` = `LLM_BASE_URL`; ponowny list.
3. Zwróć `entry.modelId` → to idzie do `config.vectorizer.modelId`.

### Provisioning projektu (akcja `kb_provision`, idempotentna)

1. Rejestr: status → `provisioning` (transakcja).
2. `GET /v1/projects/list?isOwner=false&keyword=&pageNo=1&pageSize=200&appId=0` → jeśli projekt o tym `namespace` istnieje, przejmij jego `id` (resume po awarii).
3. Jeśli nie istnieje: `ensureEmbeddingModel()` → `POST /v1/projects`:

```json
{
  "name": "Dokumentacja oświetlenia",
  "namespace": "LightingDocs",
  "description": "Baza dokumentowa ...",
  "visibility": "PRIVATE",
  "tag": "LOCAL",
  "config": { "vectorizer": { "modelId": "b87d551d4ba14909907c6e29218fa011@text-embedding-3-small" } }
}
```
   `result` = projectId (liczba).
4. Render szablonu (`__NAMESPACE__` → namespace) → `POST /v1/schemas?projectId=N` z body `{ "data": "<treść .schema>" }`.
5. Weryfikacja: `GET /v1/schemas/graph/{projectId}` — wszystkie 4 typy obecne w `entityTypeDTOList` (Chunk, ReferenceDocument, Topic, ConceptTaxonomy).
6. Rejestr (transakcja): `project_id`, `vector_model_id`, `schema_hash`, `schema_version=1`, status → `active`. Audyt.

Guard niezmienności embeddingu: jeżeli `vector_model_id` w rejestrze jest ustawiony i różni się od aktualnie wyliczonego z env — provisioning/build zgłasza FAIL w preflight (modelu NIE wolno zmieniać po utworzeniu projektu). Zmiana schematu (nowe pola/typy addytywnie): akcja `schema_sync` re-renderuje szablon i `POST /v1/schemas` ponownie, `schema_version++`; zakaz zmiany nazw istniejących typów/pól (walidacja diffem przed pushem).

---

## (c) Pipeline ingest

### Model danych (SQLite)

```sql
CREATE TABLE intakes (            -- jedno "wejście treści" i jego przebieg przez etapy
  id TEXT PRIMARY KEY,            -- intake_<data>_<hex8>
  source_kind TEXT NOT NULL CHECK (source_kind IN ('upload','url','text')),
  original_name TEXT, mime TEXT, source_url TEXT,
  blob_path TEXT,                 -- data/blobs/<sha256[:2]>/<sha256> (oryginał)
  status TEXT NOT NULL CHECK (status IN ('received','extracted','cleaned','analyzed','drafted','failed')),
  extract_provider TEXT, extract_quality REAL,
  clean_profile TEXT, cleaned_chars INTEGER, removed_ratio REAL,
  analysis TEXT,                  -- JSON: {title,tags,kbNamespace,summary,language,provider,confidence,warnings}
  draft_id TEXT, error TEXT, created_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE drafts (             -- inbox
  id TEXT PRIMARY KEY,            -- draft_<YYYY-MM-DD>_<hex8>_<slug>
  kb_namespace TEXT NOT NULL REFERENCES kb_registry(namespace),
  title TEXT NOT NULL, content TEXT NOT NULL,        -- content = wyczyszczony markdown/tekst
  source_url TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',                   -- JSON array
  metadata TEXT NOT NULL DEFAULT '{}',               -- JSON: sourceTier, language, intakeId, analyzeProvider...
  status TEXT NOT NULL DEFAULT 'pending'
         CHECK (status IN ('pending','promoted','rejected','withdrawn')),
  created_by TEXT NOT NULL,       -- 'panel:<sub>' | 'mcp:<keyPrefix>'
  created_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT
);

-- manifesty w SQLite (zamiast plików JSON — decyzja z briefu)
CREATE TABLE export_runs  (id INTEGER PRIMARY KEY, kb_namespace TEXT NOT NULL, status TEXT NOT NULL,
                           doc_count INTEGER, chunk_count INTEGER, started_at TEXT, finished_at TEXT);
CREATE TABLE export_files (run_id INTEGER REFERENCES export_runs(id), file_name TEXT, row_count INTEGER,
                           columns TEXT, sha256 TEXT, path TEXT, PRIMARY KEY (run_id, file_name));
CREATE TABLE upload_records (kb_namespace TEXT, file_name TEXT, file_sha256 TEXT, uploaded_url TEXT,
                             uploaded_at TEXT, PRIMARY KEY (kb_namespace, file_name, file_sha256));
CREATE TABLE build_jobs (id INTEGER PRIMARY KEY, kb_namespace TEXT, run_id INTEGER, file_name TEXT,
                         openspg_job_id INTEGER, job_name TEXT, entity_type TEXT, entity_type_id INTEGER,
                         row_count INTEGER, uploaded_url TEXT, status TEXT, gmt_create TEXT, gmt_modified TEXT,
                         finished_at TEXT);
CREATE TABLE quality_reports (id INTEGER PRIMARY KEY, kb_namespace TEXT, run_id INTEGER,
                              verdict TEXT CHECK (verdict IN ('OK','WARN','FAIL')),
                              checks TEXT, created_at TEXT);  -- checks = JSON array
```

### Etap 1 — Intake

`POST /api/content` (operator): multipart plik (≤50 MB; pdf/docx/xlsx/pptx/html/txt/md — obrazy poza v1) LUB `{url}` (safe_http: blok prywatnych IPv4/v6, DNS lookup all, re-walidacja redirectów) LUB `{text, title?}`. Zwraca 202 `{intakeId}`; przetwarzanie asynchroniczne in-process (kolejka w tabeli, jeden worker — bez spawnowania procesów na intake; spawn tylko dla buildów).

### Etap 2 — Ekstrakcja (kaskada z progiem jakości)

Dla PDF (kolejność z briefu: Stirling OCR pol → Tika → próg):
1. Stirling: `POST {STIRLING_URL}/api/v1/convert/pdf/markdown` (multipart `fileInput`, nagłówek `X-API-KEY`) → markdown; **próg jakości**: `length ≥ 120 && looksHumanText(text)` (looksHumanText: ratio znaków drukowalnych ≥0.72, ≥3 znaki literowe, weird ≤ printable — czysta funkcja z testami).
2. Poniżej progu (skan bez warstwy tekstu): `POST /api/v1/misc/ocr-pdf` z `languages=pol` → OCR-owany PDF → ponownie convert/markdown → próg.
3. Nadal poniżej: Tika `PUT {TIKA_URL}/tika` (`Content-Type: application/pdf`) → strip XHTML → próg.
4. Nadal poniżej: `status='failed'`, `error='extraction_below_quality_threshold'` — widoczne w UI (bez własnego parsera PDF jak w optimaKB; uczciwy błąd zamiast śmieciowego tekstu).

Inne typy: txt/md → odczyt bezpośredni (walidacja UTF-8); html/docx/xlsx/pptx → Tika; URL → safe_http fetch, potem wg content-type. Timeout 30 s na wywołanie zewnętrzne, zapis `extract_provider` ('stirling'|'stirling_ocr'|'tika'|'raw') i `extract_quality` (ratio z looksHumanText).

### Etap 3 — Czyszczenie

`cleanContent(text, profile)` — czysta funkcja, profile regexowe w `cleanProfiles.ts`: `news`, `blog`, `docs`, `pdf`, `generic` (własne listy PL wzorowane na optimaKB: inlinePatterns — REKLAMA/newsletter/cookies/udostępnij...; dropLinePatterns — menu/nawigacja/tagi/stopki/©/numery strony/`^\d+$`; normalizacja paginacji i whitespace). Wybór profilu: heurystyka po sourceType/URL + możliwość nadpisania w UI. Opcjonalny przebieg LLM (`CONTENT_AI_CLEAN=1`, tekst ≤12k znaków, model **openie_llm** — tańszy): prompt "usuń boilerplate, zachowaj treść merytoryczną, zwróć czysty markdown"; guard bezpieczeństwa: wynik musi mieć ≥60% długości wejścia i przechodzić looksHumanText, inaczej pozostaje wynik regexowy (fallback jak w briefie). Zapis `clean_profile`, `removed_ratio`.

### Etap 4 — Analyze (chat_llm + fallback heurystyczny)

`analyzeContent({content, sourceUrl, titleHint, registry})` → wywołanie **chat_llm** (OpenAI-compatible, JSON mode) z listą namespace z rejestru + `routing_keywords`; oczekiwany JSON: `{title ≤200, tags ≤8×64, kbNamespace ∈ registry, summary ≤400, language}`. Walidacja odpowiedzi (kbNamespace musi istnieć i mieć status active). Fallback heurystyczny przy błędzie/timeout: `title` = pierwszy H1/pierwsze zdanie ≥8 znaków; `tags` = top słowa kluczowe (bez stopwords PL); `kbNamespace` = pierwszy match `routing_keywords` z rejestru albo domyślny KB (flaga `is_default` — pole dodatkowe w rejestrze). Wynik zawsze z polem `provider: 'chat_llm' | 'heuristic'` + `warnings[]` (pokazywane w UI badge — wzorzec DraftAnalyzeBadge).

### Etap 5 — Draft w inboxie

Po analyze intake automatycznie tworzy wpis w `drafts` (status `pending`, `metadata.intakeId`, `metadata.analyzeProvider`) — inbox jest punktem recenzji, więc bez osobnego kroku potwierdzenia w /add (edycja tytułu/tagów/KB możliwa w inboxie przed promote). Limity jak w optimaKB: 100 draftów/dzień, content ≤50k znaków. MCP `kb.submit_draft` pisze DOKŁADNIE tutaj (nigdy do grafu — human-in-the-loop).

API inboxu: `GET /api/drafts?status&kb&q&page&pageSize`, `GET /api/drafts/:id`, `PATCH /api/drafts/:id` (tylko pending: title/tags/kb_namespace), `POST /api/drafts/:id/promote|reject`, `POST /api/drafts/:id/withdraw` (tylko promoted; odwracalne), `POST /api/drafts/bulk {action, ids, dryRun}` — dwufazowo: `dryRun:true` zwraca per-id `{ok|conflict, reason}`, UI pokazuje preflight, potem apply. Promote/withdraw ustawia `kb_registry.dirty=1` + audyt.

### Etap 6 — Chunking (decyzja)

**Algorytm: split po nagłówkach markdown, potem pakowanie akapitów do limitu 1800 znaków (jak optimaKB), bez overlapu.** Czysta funkcja `chunkDocument(markdown, {maxLen=1800, previewLen=800})`:
1. Podział na sekcje po liniach `#`–`###` (oraz linie ALL-CAPS ≤80 znaków jako pseudo-nagłówki dla tekstu z OCR); nagłówek → `sectionHeading`.
2. W sekcji: akapity (split `\n\s*\n`) pakowane zachłannie do ≤1800; akapit >1800 dzielony na granicy zdania (`. ` najbliżej limitu), w ostateczności twardo co 1800.
3. Dla każdego chunka: `sectionOrder` (globalny licznik), `contentPreview` = pierwsze ≤800 znaków ucięte na granicy słowa, `contentHash` = sha256(content), `contentLength` = content.length, `name` = `«tytuł doc» — «heading|fragment» #N` (≤180).
Uzasadnienie: 1800 znaków ≈ 500–900 tokenów PL — bezpiecznie poniżej limitu wektoryzacji; granice nagłówków trzymają spójność semantyczną; brak overlapu = brak duplikatów przy UPSERT. Testy właściwości: żaden chunk >1800; konkatenacja chunków == tekst modulo whitespace; determinizm.

### Etap 7 — Eksport CSV (dokładne kolumny per plik)

Artefakty na dysk `data/exports/<ns>/<runId>/` (builder potrzebuje fizycznych plików do multipart), metadane w `export_runs`/`export_files`. Źródło: WSZYSTKIE drafty `promoted` danego KB (pełny rebuild stanu docelowego — id deterministyczne, więc UPSERT jest idempotentny). csvEscape wg RFC (cudzysłowy podwajane). Pliki:

- `reference_document.csv`: `id,name,description,semanticType,sourceUrl,sourceType,documentCategory,language,sourceTier,publishedAt,retrievedAt,topicRefIds,conceptRefIds,content,contentPreview,contentHash,contentLength,summary` — 1 wiersz per promowany draft; `semanticType='reference_document'`; `topicRefIds` = id topiców rozdzielone przecinkami; `conceptRefIds` puste w v1.
- `chunk.csv`: `id,name,description,semanticType,sourceDocumentRefId,sourceUrl,sectionHeading,sectionOrder,content,contentPreview,contentHash,contentLength` — `sourceDocumentRefId` = id dokumentu; `semanticType='chunk'`.
- `topic.csv`: `id,name,description,semanticType,topicSlug,usageCount,summary` — agregacja tagów promowanych draftów; `usageCount` = liczba dokumentów.

(Bez `concept.csv` w v1 — patrz sekcja b.)

### Etap 8 — Builder job (akcja `kb_build`, 202+actionId, resume, FORCE)

Preflight (422 z listą checks przy fail): KB `active` z `project_id`; `vector_model_id` zgodny z env; OpenSPG healthy (`GET /v1/projects/list` odpowiada); brak innej akcji build dla tego KB (409); eksport da ≥1 dokument.

Sekwencja per plik (kolejność: `topic.csv` → `reference_document.csv` → `chunk.csv`, żeby refId celowały w istniejące encje):
1. **Upload**: jeśli `upload_records` ma wpis (kb, fileName, sha256 pliku) i nie ma `force` → reuse `uploaded_url`. Inaczej `POST /public/v1/reasoner/dialog/uploadFile` (multipart) → URL MinIO → zapis wpisu. To jest resume: zmiana treści = nowy sha = nowy upload automatycznie; FORCE potrzebny tylko do wymuszenia re-importu bez zmiany treści (np. po odtworzeniu grafu).
2. **Skip**: jeśli istnieje `build_jobs` FINISH dla (kb, fileName, sha256 przez uploaded_url) i nie ma `force` → pomiń.
3. **Reuse aktywnego**: `GET /public/v1/builder/job/list?projectId=&start=1&limit=100` (**start=1**, 0 = bug SQL); job w INIT/WAITING/RUNNING z tym samym `jobName` i `fileUrl`, młodszy niż 45 min → tylko polling zamiast duplikatu.
4. **Submit** `POST /public/v1/builder/job/submit` — payload (dokładnie wzorzec z briefu; `sId` z `GET /v1/schemas/graph/{projectId}` → `entityTypeDTOList`, mapowanie nazwa→id z obsługą krótkich nazw):

```json
{
  "projectId": 4, "createUser": "openspg", "jobName": "LDOC Chunk CSV Import",
  "type": "FILE_EXTRACT", "dataSourceType": "CSV", "fileUrl": "<minio-url>",
  "lifeCycle": "ONCE", "action": "UPSERT",
  "extension": "{\"dataSourceConfig\":{\"columns\":[{\"name\":\"id\",\"index\":0},{\"name\":\"name\",\"index\":1}, \"...\"],\"type\":\"UPLOAD\",\"fileName\":\"chunk.csv\",\"fileUrl\":\"<minio-url>\",\"ignoreHeader\":true,\"structure\":true},\"mappingConfig\":{\"mappingType\":\"entityMapping\",\"filter\":[{\"s\":\"LightingDocs.Chunk\",\"sId\":123,\"sZhName\":\"Chunk\",\"importSchemaCategory\":\"ENTITY\"}],\"config\":[{\"mapping\":{\"id\":[\"id\"],\"name\":[\"name\"],\"content\":[\"content\"]},\"name\":\"Chunk(LightingDocs.Chunk)\",\"id\":\"1\"}]}}"
}
```
   (`extension` = zserializowany JSON; `mapping` = każda kolumna → [ta sama kolumna]; `jobName` = `<job_prefix> <EntityType> CSV Import`).
5. **Polling** `GET /public/v1/builder/job/get?id=` co 3 s, timeout 120 min; statusy terminalne `FINISH/ERROR/SKIP/TERMINATE/SET_FINISH`; wynik do `build_jobs`. Status ≠ FINISH → akcja FAIL (log z logTail), KB zostaje `active` ale raport pokazuje błąd.
6. Po wszystkich plikach: `dirty=0`, uruchom quality gate, audyt. Log akcji do `data/logs/actions/<actionId>.log`, `GET /api/actions/:id` z logTail.

### Etap 9 — Quality gate (checki)

Uruchamiany po buildzie i na żądanie (`POST /api/kb/:ns/quality` → 202). Każdy check: `{id, level: 'error'|'warn', ok, details}`; verdict = FAIL gdy jakikolwiek error, WARN gdy tylko warny. Checki v1:
1. `export_files_exist` (error): każdy plik z `export_files` istnieje na dysku, sha zgodny.
2. `row_count_match` (error): rowCount w manifescie == faktyczna liczba wierszy CSV.
3. `ids_unique_nonempty` (error): kolumna id — brak pustych i duplikatów.
4. `indexed_field_limits` (error): `contentPreview` ≤800, `summary` ≤400, `content` chunka ≤1800; `contentLength`==len(content), `contentHash` zgodny.
5. `referential_integrity` (error): każdy `chunk.sourceDocumentRefId` ∈ id z reference_document.csv; każdy element `topicRefIds` ∈ topic.csv.
6. `promoted_coverage` (error): każdy promowany draft ma ≥1 wiersz chunk (match po docId zawierającym hash draftu).
7. `builds_finished` (error): każdy niepusty plik ma job FINISH w `build_jobs` bieżącego runu.
8. `duplicate_source_urls` (warn): sourceUrl występujący >1 raz w reference_document.csv.
9. `live_search_sanity` (warn): `POST /public/v1/search/text` frazą z losowego promowanego tytułu zwraca ≥1 wynik (tolerancja na opóźnienie indeksu — dlatego warn).
10. `dirty_flag` (warn): `dirty=1` (są promocje po ostatnim buildzie).
Wynik do `quality_reports` (JSON w SQLite, render w panelu) — bez plików .md (raport eksportowalny z UI jako download).

---

## (d) Luki wiedzy

**Decyzja: v1 BEZ auto-draftów z sieci.** Uzasadnienie: human-in-the-loop to naczelna zasada, Exa/Tavily to opcjonalny sekret, a auto-pobieranie treści z sieci dokłada SSRF/jakość/koszty. Ścieżka v1: gap → operator klika "Utwórz szkic" → prefill strony /add pytaniem (operator dostarcza treść/URL) → normalny pipeline. Faza 2: cron auto-draft za flagą `LEARNING_AUTO_DRAFT=1` + skonfigurowanym kluczem Exa/Tavily (schema danych już to przewiduje przez `metadata`).

```sql
CREATE TABLE learning_gaps (
  id TEXT PRIMARY KEY,                       -- gap_<data>_<hex8>
  question TEXT NOT NULL, normalized_question TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'mcp_kb_answer',
  kb_namespace TEXT, confidence REAL NOT NULL, evidence_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_draft','resolved','ignored')),
  draft_id TEXT, metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, processed_at TEXT, processed_by TEXT
);
CREATE UNIQUE INDEX gaps_open_dedupe ON learning_gaps(normalized_question) WHERE status='open';
```

Zapis: `kb.answer` (proces MCP) po policzeniu confidence (czysta funkcja: `0.6*min(evidence/5,1) + 0.3*min(maxScore/10,1) + 0.1*freshness`) — gdy `confidence < LEARNING_CONFIDENCE_THRESHOLD` (default 0.35) wywołuje `recordGap()` z współdzielonego pakietu db (ten sam plik SQLite, WAL; dedupe przez partial unique index zamiast skanu JSONL — naprawa wzorca z optimaKB). API panelu: `GET /api/learning/gaps?status&kb`, `GET /api/learning/stats`, `POST /api/learning/gaps/:id/resolve|ignore`, `POST /api/learning/gaps/:id/start-draft` (status→in_draft, zwraca prefill dla /add; po promocie draftu gap→resolved automatycznie po `draft_id`).

---

## (e) Frontend: React 18 + Vite

### Decyzje
- **Routing: TanStack Router** (zamiast react-router): typowane ścieżki i **typowane search-params** — deep-linki filtrów (inbox `?status=pending&kb=X`) to wymaganie z wzorców optimaKB, a search-params API TanStack robi to deklaratywnie; naturalna integracja z TanStack Query. Konfiguracja code-based (jeden plik tras — bez plugina file-based, mniej magii w v1).
- **TanStack Query v5**: klucze `['kb']`, `['kb', ns]`, `['drafts', filters]`, `['action', id]` (refetchInterval 2000 dopóki status `running`), `['gaps', filters]`, `['me']`, `['overview']` (refetchInterval 15000). Mutacje inwalidują klucze zasobu.
- **i18n: minimalna warstwa tłumaczeń** (nie stringi wprost, nie i18next): jeden słownik `src/i18n/pl.ts` (`export const pl = { 'inbox.promote': 'Zatwierdź', ... } as const`) + helper `t(key, params?)` z prostą interpolacją `{name}` i typowanymi kluczami (`keyof typeof pl`). Koszt ~30 linii, kod trzyma identyfikatory po angielsku, przyszłe EN bez refaktoru. Daty/liczby przez `Intl` z locale `pl-PL`.
- **Motyw**: CSS variables w `:root` (light) i `[data-theme="dark"]`; tokeny: `--bg`, `--surface`, `--border`, `--text`, `--text-muted`, `--accent`, `--ok`, `--warn`, `--fail`; toggle w headerze, persist w localStorage, start z `prefers-color-scheme`.

### Sesja OIDC i rola (kontrakt z backendem)

Cały flow OIDC po stronie backendu (Fastify) — frontend NIGDY nie widzi tokenów:
1. Frontend przy starcie woła `GET /api/me`. 401 → `window.location = '/auth/login?next=' + encodeURIComponent(pathname+search)`.
2. `GET /auth/login` → redirect 302 do Authentik authorize (Authorization Code + PKCE + state).
3. `GET /auth/callback` → wymiana kodu, weryfikacja ID tokena, mapowanie grup (`kag-admin`→admin, `kag-operator`→operator, `kag-viewer`→viewer; brak grupy = 403 strona "brak dostępu"), utworzenie sesji w tabeli `sessions` (SQLite), cookie `kag_session` HttpOnly+Secure+SameSite=Lax, redirect na `next`.
4. `GET /api/me` → `{ user: {sub, email, name}, role: 'admin'|'operator'|'viewer', csrfToken }`. CSRF: token per-sesja w wierszu sesji (przeżywa restart — naprawa buga optimaKB), wysyłany nagłówkiem `X-CSRF-Token` przy mutacjach.
5. Wylogowanie: `POST /auth/logout` → kasacja sesji + redirect do end-session Authentika.
Rola w UI: hook `useMe()`; `can(role, permission)` — czysta funkcja z mapą uprawnień (viewer: read; operator: +content/drafts/build/gaps; admin: +kb create/provision, settings, MCP keys). Gating w UI to tylko UX — egzekwuje backend.

### Strony (funkcje per strona)

- **/overview** — health cockpit (karta sygnałów + status ogólny), kafle: liczba KB / dokumentów / chunków / pending draftów / otwartych luk; lista ostatnich akcji (status, czas, link do logu); KB z `dirty=1` ("wymaga builda") z przyciskiem build.
- **/kb** — DataTable rejestru (namespace, nazwa, status, projectId, totals, ostatni build, verdict gate); akcje wierszowe wg roli: Provision, Build (modal preflight z listą checks i opcją force), Quality gate, Szczegóły (drawer: historia buildów per plik, raport jakości z listą checków, wersja schematu); modal "Nowa baza" (admin): namespace z walidacją live regex + podgląd wyrenderowanego schematu.
- **/inbox** — DataTable draftów; filtry w search-params (status/kb/fraza/strona); podgląd draftu w modalu (render markdown, metadane, badge providera analizy); akcje: Zatwierdź/Odrzuć/Wycofaj/Zmień KB/Edytuj (pending); bulk: checkboxy → pasek akcji → dryRun preflight (tabela per-draft ok/konflikt) → potwierdzenie.
- **/add** — trzy taby: Plik (drag&drop, progress), URL, Tekst; wybór profilu czyszczenia (auto + override); stepper statusu intake (przyjęto → ekstrakcja(provider, jakość) → czyszczenie(usunięto %) → analiza(tytuł/tagi/KB/provider/confidence) → szkic utworzony → link do inboxu); lista ostatnich intake'ów z błędami ekstrakcji.
- **/learning** — kafle statystyk (open/in_draft/resolved/ignored); tabela luk (pytanie, KB, confidence, źródło, data); akcje: Utwórz szkic (nawigacja do /add z prefill), Rozwiązana, Ignoruj.
- **/mcp** — (dane z podsystemu 4) lista użytkowników/kluczy (prefix, scope, ostatnie użycie, TTL), tworzenie klucza (raw pokazany JEDEN raz w modalu z copy), rotate/revoke, lista profili z manifestu (namespaces, tools, mode), snippety konfiguracyjne (Claude Code/Desktop JSON z copy), health per profil.
- **/system** — lista akcji (filtr status) z viewerem logTail (polling); przeglądarka audytu (filtr aktor/zdarzenie/data); health usług (OpenSPG, Stirling, Tika, DB, MCP); status backupów.
- **/settings** (admin) — provider LLM: base_url + modele openie_llm/chat_llm, klucz maskowany (`configured` + preview 4 znaki, zapis tylko-nadpisanie), przycisk "Testuj połączenie"; model embeddingu (read-only gdy ≥1 KB active, z ostrzeżeniem o niezmienności); progi (confidence, chunk size — advanced); opcjonalne klucze Exa/Tavily (maskowane, opisane jako "faza 2: auto-drafty").

### Komponenty wspólne i logika czysta (z testami vitest)

`StatusBadge` (mapa status→wariant jako czysta fn `statusVariant()`), `DataTable` (headless: sort/paginacja/selekcja kontrolowane propami), `Modal` (focus trap, Esc), `ConfirmButton`, `Stepper`, `CopyField`, `SafeExternalLink` (noopener+noreferrer, tylko http/https), `EmptyState`, `Skeleton`, `Toast`, `ThemeToggle`, `MetricTile`. Logika czysta w `.ts` bez Reacta: `lib/health.ts` — `normalizeStatus()` (PASS/FINISH/OK→OK, FAIL/ERROR→FAIL, WARN/RUNNING/STALE→WARN), `worstStatus()`, `buildHealthCockpit(overview)` → `{overallStatus, signals: [{id,label,value,status}]}` z sygnałami: openspg, mcp, quality (najgorszy verdict aktywnych KB), inbox (pending>0→WARN), akcje (failed→FAIL, running→WARN), luki (open>próg→WARN), dirty KB; `lib/bulkSelection.ts` (reducer selekcji), `lib/permissions.ts` (`can()`), `i18n/t.ts` — wszystkie z testami jednostkowymi.

---

## Kolejność implementacji

1. `packages/db` (schema.sql + migracje + repozytoria) i `packages/openspg-client` (login, projects, models, schemas, builder, upload) — fundament, testy na fixture'ach.
2. Rejestr KB + provisioning (szablon schema, ensureEmbeddingModel) — pierwszy KB end-to-end na czystym serwerze.
3. Pipeline: extract → clean → analyze → draft (intake worker) + API inboxu.
4. Exporter + chunker + builder runner + quality gate (akcje 202/preflight/resume/FORCE).
5. Luki wiedzy (zapis z MCP przez współdzielony pakiet db + API panelu).
6. Frontend: shell + auth/me + Overview/KB → Inbox/Add → Learning/System/Settings → MCP.

## Krytyczne pliki do implementacji

- /kag/packages/openspg-client/src/client.ts — cały kontrakt REST OpenSPG (projects/models/schemas/upload/builder)
- /kag/apps/panel-api/src/pipeline/builder.ts — runner buildów (resume z SQLite, reuse-active, FORCE, polling)
- /kag/schemas/document_kb.schema.tpl — generyczny szablon schema DSL
- /kag/packages/db/src/schema.sql — jedno źródło prawdy stanu (rejestr, drafty, manifesty, luki)
- /kag/apps/panel-web/src/lib/health.ts — health cockpit jako czyste funkcje z testami


## FILE LAYOUT
- /kag/schemas/document_kb.schema.tpl — generyczny szablon schema DSL z placeholderem __NAMESPACE__
- /kag/packages/db/src/schema.sql — pełny DDL SQLite (kb_registry, intakes, drafts, export_runs/files, upload_records, build_jobs, quality_reports, learning_gaps, sessions)
- /kag/packages/db/src/index.ts — otwarcie bazy (WAL, busy_timeout), migracje, eksport repozytoriów
- /kag/packages/db/src/repos/kbRegistry.ts — repozytorium rejestru KB (CRUD + przejścia stanów w transakcjach)
- /kag/packages/db/src/repos/drafts.ts — repozytorium inboxu (promote/reject/withdraw/bulk z dryRun)
- /kag/packages/db/src/repos/manifests.ts — manifesty export/upload/build w SQLite (logika resume)
- /kag/packages/db/src/repos/learningGaps.ts — luki wiedzy (recordGap z dedupe, statusy, statystyki)
- /kag/packages/openspg-client/src/client.ts — klient REST OpenSPG: projects, schemas, schema graph, uploadFile, builder submit/get/list
- /kag/packages/openspg-client/src/models.ts — rejestr modeli: list/register, ensureEmbeddingModel (modelId dla vectorizera)
- /kag/packages/openspg-client/src/login.ts — auto-login produktowy (sha256(pass+'OPENSPG'), cookie, refresh po 401)
- /kag/apps/panel-api/src/routes/kb.ts — endpointy rejestru KB, provision/build/quality (202+actionId, preflight 422)
- /kag/apps/panel-api/src/routes/content.ts — intake (upload/URL/tekst) + status intake'u
- /kag/apps/panel-api/src/routes/drafts.ts — inbox API (lista/filtr/patch/promote/reject/withdraw/bulk)
- /kag/apps/panel-api/src/routes/learning.ts — API luk wiedzy
- /kag/apps/panel-api/src/routes/auth.ts — OIDC Authorization Code + PKCE, callback, sesje, /api/me, logout
- /kag/apps/panel-api/src/pipeline/extract.ts — kaskada Stirling→Stirling OCR(pol)→Tika z progiem jakości i looksHumanText
- /kag/apps/panel-api/src/pipeline/cleanProfiles.ts — profile regexowe czyszczenia (news/blog/docs/pdf/generic)
- /kag/apps/panel-api/src/pipeline/clean.ts — cleanContent + opcjonalny przebieg LLM (openie_llm) z guardem długości
- /kag/apps/panel-api/src/pipeline/analyze.ts — analiza chat_llm (JSON) + fallback heurystyczny, provider w wyniku
- /kag/apps/panel-api/src/pipeline/chunker.ts — chunking nagłówki+akapity, limit 1800, preview 800 (czysta funkcja)
- /kag/apps/panel-api/src/pipeline/exporter.ts — generacja CSV (dokładne kolumny) + export_runs/files, deterministyczne id (makeId)
- /kag/apps/panel-api/src/pipeline/provision.ts — tworzenie projektu OpenSPG + commit schematu + weryfikacja graph + zapis rejestru
- /kag/apps/panel-api/src/pipeline/builder.ts — runner buildów: upload z resume po sha256, reuse-active jobów, submit, polling, FORCE
- /kag/apps/panel-api/src/pipeline/qualityGate.ts — checki jakości + zapis quality_reports
- /kag/apps/panel-api/src/pipeline/intakeWorker.ts — asynchroniczny worker przetwarzający intakes przez etapy
- /kag/apps/panel-api/test/chunker.test.ts — testy właściwości chunkera (limit, rekonstrukcja, determinizm)
- /kag/apps/panel-api/test/builderPayload.test.ts — snapshot payloadu builder joba (extension JSON)
- /kag/apps/panel-web/src/router.tsx — definicja tras TanStack Router z typowanymi search-params
- /kag/apps/panel-web/src/routes/OverviewPage.tsx — health cockpit + kafle + ostatnie akcje
- /kag/apps/panel-web/src/routes/KbPage.tsx — rejestr KB, provision/build/quality, drawer szczegółów
- /kag/apps/panel-web/src/routes/InboxPage.tsx — drafty: filtry deep-link, podgląd, promote/reject/withdraw, bulk z dryRun
- /kag/apps/panel-web/src/routes/AddContentPage.tsx — taby plik/URL/tekst + stepper pipeline'u
- /kag/apps/panel-web/src/routes/LearningPage.tsx — luki wiedzy: tabela, utwórz szkic (prefill /add), resolve/ignore
- /kag/apps/panel-web/src/routes/McpPage.tsx — klucze/profile/snippety (dane z podsystemu 4)
- /kag/apps/panel-web/src/routes/SystemPage.tsx — akcje z logTail, audyt, health usług
- /kag/apps/panel-web/src/routes/SettingsPage.tsx — konfiguracja LLM/embedding/progi, sekrety maskowane
- /kag/apps/panel-web/src/lib/health.ts — normalizeStatus/worstStatus/buildHealthCockpit (czyste funkcje)
- /kag/apps/panel-web/src/lib/health.test.ts — testy health cockpitu
- /kag/apps/panel-web/src/lib/permissions.ts — mapa ról i can() (czysta funkcja)
- /kag/apps/panel-web/src/i18n/pl.ts — słownik PL (jedyne źródło stringów UI)
- /kag/apps/panel-web/src/i18n/t.ts — helper t() z typowanymi kluczami i interpolacją
- /kag/apps/panel-web/src/components/ — StatusBadge, DataTable, Modal, Stepper, CopyField, SafeExternalLink, EmptyState, Toast, ThemeToggle
- /kag/apps/panel-web/src/styles/theme.css — tokeny CSS variables light/dark

## RISKS
- Import CSV do ConceptType niezweryfikowany (fakty briefu potwierdzają tylko importSchemaCategory:'ENTITY') — mitigacja: ConceptTaxonomy jest w schemacie od v1, ale eksport concept.csv przesunięty do fazy 2 po teście na żywym serwerze; tagowanie w v1 robi Topic (EntityType).
- Endpointy Stirling PDF różnią się między wersjami (convert/pdf/markdown, misc/ocr-pdf, nazwy parametrów languages) — mitigacja: pinowanie obrazu Stirling po digestcie, adapter extract.ts z jednym miejscem definicji endpointów i testem integracyjnym smoke przy deploymencie; pełny fallback do Tika.
- ~~Indeks TextAndVector tylko na contentPreview~~ NIEAKTUALNE - rozstrzygniete inaczej: implementacja (exporter.ts/schema tpl) indeksuje TextAndVector na PELNYM chunk.content (do 1800 zn.), zgodnie z decyzja PLAN.md - swiadome odstepstwo od wzorca preview-only; contentPreview pozostaje polem Text do wyswietlania.
- Model embeddingu niezmienialny po utworzeniu projektu — mitigacja: vector_model_id zamrożony w rejestrze, preflight buildu i provisioningu porównuje z env i twardo blokuje rozjazd; Settings pokazuje pole read-only z ostrzeżeniem gdy istnieje ≥1 aktywny KB.
- Współdzielony plik SQLite między procesem panelu a MCP (zapis luk wiedzy i draftów z MCP) — mitigacja: WAL + busy_timeout=5000, krótkie transakcje, wszystkie zapisy przez jeden pakiet repozytoriów; w razie problemów fallback: MCP woła wewnętrzny endpoint panelu po sieci docker (zmiana izolowana w repos-adapterze).
- Builder job może wisieć w RUNNING (znane z optimaKB duplikaty MsgEntry) — mitigacja: reuse-active z progiem wieku 45 min + logowanie pominiętych stale jobów, timeout pollingu 120 min, statusy terminalne pełną listą FINISH/ERROR/SKIP/TERMINATE/SET_FINISH, start=1 w list (bug SQL przy 0).
- Limity długości backendu (nazwy typów, jobName w MySQL) — mitigacja: namespace ≤30 znaków (walidacja przy tworzeniu KB), job_prefix ≤8 znaków w rejestrze, nazwy typów szablonu krótkie i stałe.
- LLM (chat_llm/openie_llm) niedostępny lub zwraca śmieci — mitigacja: analyze i czyszczenie mają deterministyczne fallbacki heurystyczne z polem provider w wyniku (widoczne w UI), guard długości na wyniku czyszczenia LLM, pipeline nigdy nie blokuje się na LLM.
- Pełny re-eksport wszystkich promowanych draftów przy każdym buildzie rośnie liniowo z korpusem — akceptowalne w v1 (UPSERT idempotentny, resume po sha pomija niezmienione pliki); faza 2: eksport przyrostowy per plik gdy czas buildu przekroczy próg.

## OPEN QUESTIONS
- Jaki model embeddingu ma być domyślny (env EMBEDDING_MODEL) — text-embedding-3-small jak w optimaKB, czy inny z Waszego endpointu OpenAI-compatible? (Decyzja nieodwracalna per projekt OpenSPG.)
- Czy pierwszy KB ma powstać automatycznie przy pierwszym starcie (seed, np. namespace 'GeneralDocs' jako KB domyślny dla analyze-fallbacku), czy zawsze ręcznie przez admina w panelu?
- Czy operator może promować draft do KB w stanie draft/provisioning (draft czeka na build), czy promote ma być zablokowany dopóki KB nie jest active? (Proponuję: zablokowany — mniej stanów pośrednich.)