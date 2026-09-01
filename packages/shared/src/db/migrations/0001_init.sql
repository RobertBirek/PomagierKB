-- PomagierKB — schemat początkowy (scalony z docs/design/backend-mcp.md §4 i pipeline-frontend.md).
-- Konwencje: czasy TEXT ISO-8601 UTC; JSON w kolumnach *_json; identyfikatory tekstowe.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,               -- uuid v7
  sub           TEXT UNIQUE,                    -- OIDC sub (UUID z Authentika); NULL dla kind='service'
  email         TEXT,
  display_name  TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('oidc','service')),
  role          TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE sessions (
  id_hash             TEXT PRIMARY KEY,          -- sha256(sid) — kradzież pliku DB nie daje sesji
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                TEXT NOT NULL,             -- snapshot roli (odświeżany przy refresh tokenu)
  tokens_enc          BLOB,                      -- AES-256-GCM({refresh_token,id_token,access_token,expires_at})
  ip                  TEXT,
  user_agent          TEXT,
  created_at          TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  idle_expires_at     TEXT NOT NULL
);
CREATE INDEX ix_sessions_user ON sessions(user_id);
CREATE INDEX ix_sessions_exp  ON sessions(absolute_expires_at);

CREATE TABLE kb_registry (                       -- JEDYNE źródło prawdy o bazach wiedzy
  namespace        TEXT PRIMARY KEY,             -- ^[A-Z][A-Za-z0-9]{2,29}$ (ANGIELSKI — bug #753)
  name             TEXT NOT NULL,                -- etykieta PL dla UI
  description      TEXT NOT NULL DEFAULT '',
  project_id       INTEGER,                      -- OpenSPG projectId; NULL do provisioningu
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','provisioning','active','error','archived')),
  vector_model_id  TEXT NOT NULL DEFAULT '',     -- '<instanceId>@<model>' — ZAMROŻONY po provisioningu
  embedding_model  TEXT NOT NULL DEFAULT '',     -- nazwa modelu (np. text-embedding-3-small)
  schema_version   INTEGER NOT NULL DEFAULT 0,
  schema_hash      TEXT NOT NULL DEFAULT '',
  job_prefix       TEXT NOT NULL,                -- ≤8 znaków, do nazw builder jobów
  routing_keywords TEXT NOT NULL DEFAULT '[]',   -- JSON array — heurystyczny routing analyze
  is_default       INTEGER NOT NULL DEFAULT 0,   -- KB domyślny dla fallbacku routingu
  dirty            INTEGER NOT NULL DEFAULT 0,   -- 1 = promocje/withdraw od ostatniego builda
  config_json      TEXT NOT NULL DEFAULT '{}',   -- typy dokumentów, profile czyszczenia itp.
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE schema_versions (
  id         INTEGER PRIMARY KEY,
  namespace  TEXT NOT NULL REFERENCES kb_registry(namespace),
  version    INTEGER NOT NULL,
  hash       TEXT NOT NULL,                      -- sha256 treści .schema
  content    TEXT NOT NULL,                      -- pełna treść scommitowanego DSL
  created_at TEXT NOT NULL,
  created_by TEXT,
  UNIQUE (namespace, version)
);

CREATE TABLE intakes (                           -- jedno "wejście treści" i jego przebieg przez etapy
  id               TEXT PRIMARY KEY,             -- intake_<yyyymmdd>_<hex8>
  source_kind      TEXT NOT NULL CHECK (source_kind IN ('upload','text','api')),
  original_name    TEXT,
  mime             TEXT,
  source_url       TEXT,                         -- tylko metadana provenance (v1 bez fetchu)
  blob_path        TEXT,                         -- /data/uploads/<sha256[:2]>/<sha256>
  status           TEXT NOT NULL DEFAULT 'received'
                   CHECK (status IN ('received','extracted','cleaned','analyzed','drafted','failed')),
  extract_provider TEXT,                         -- stirling|stirling_ocr|tika|raw
  extract_quality  REAL,
  clean_profile    TEXT,
  cleaned_chars    INTEGER,
  removed_ratio    REAL,
  analysis_json    TEXT,                         -- {title,tags,kbNamespace,summary,language,provider,confidence,warnings}
  draft_id         TEXT,
  error            TEXT,
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX ix_intakes_status ON intakes(status, created_at DESC);

CREATE TABLE drafts (                            -- inbox: JEDYNA droga zapisu wiedzy (human-in-the-loop)
  id               TEXT PRIMARY KEY,             -- draft_<yyyy-mm-dd>_<hex8>_<slug>
  namespace        TEXT REFERENCES kb_registry(namespace),
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','promoted','rejected','withdrawn')),
  title            TEXT NOT NULL,
  content_md       TEXT NOT NULL,                -- wyczyszczony markdown (treść w DB = transakcyjność)
  content_hash     TEXT NOT NULL,                -- sha256 — dedup i Idempotency
  content_length   INTEGER NOT NULL,
  source_type      TEXT NOT NULL CHECK (source_type IN ('upload','text','api','mcp','gap')),
  source_ref       TEXT,                         -- URL/nazwa pliku (provenance)
  document_category TEXT,                        -- typ dokumentu z config_json bazy (Kreator KB v1)
  tags_json        TEXT NOT NULL DEFAULT '[]',
  metadata_json    TEXT NOT NULL DEFAULT '{}',   -- intakeId, analyzeProvider, sourceTier...
  analysis_json    TEXT,
  reject_reason    TEXT,
  submitted_by_user TEXT REFERENCES users(id),
  submitted_by_key  TEXT,                        -- api_keys.id dla source_type='mcp'
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  decided_by       TEXT,
  decided_at       TEXT,
  promoted_at      TEXT
);
CREATE INDEX ix_drafts_status ON drafts(status, created_at DESC);
CREATE INDEX ix_drafts_ns     ON drafts(namespace, status);
CREATE INDEX ix_drafts_hash   ON drafts(namespace, content_hash);

CREATE TABLE actions (
  id            TEXT PRIMARY KEY,                -- act_<yyyymmdd>_<hex8>
  type          TEXT NOT NULL,                   -- build_kb|create_kb|analyze_draft|export_drafts|quality_gate|...
  resource      TEXT NOT NULL,                   -- 'kb:LightingDocs' | 'draft:draft_...'
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','success','error','cancelled')),
  params_json   TEXT NOT NULL DEFAULT '{}',
  progress_json TEXT,                            -- {phase,current,total,message}
  started_by    TEXT,
  pid           INTEGER,
  exit_code     INTEGER,
  log_path      TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT
);
-- Idempotencja bez wyścigów: druga akcja tego samego (type,resource) w stanie running = SQLITE_CONSTRAINT.
CREATE UNIQUE INDEX ux_actions_running ON actions(type, resource) WHERE status = 'running';
CREATE INDEX ix_actions_status ON actions(status, started_at DESC);

CREATE TABLE audit (                             -- hash-chained, append-only
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL UNIQUE,
  at            TEXT NOT NULL,
  actor         TEXT NOT NULL,
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('user','api_key','system')),
  role          TEXT,
  action        TEXT NOT NULL,
  resource_type TEXT,
  resource_id   TEXT,
  outcome       TEXT NOT NULL DEFAULT 'success',
  before_json   TEXT,
  after_json    TEXT,
  metadata_json TEXT,
  prev_hash     TEXT NOT NULL,
  hash          TEXT NOT NULL
);
CREATE INDEX ix_audit_at     ON audit(at);
CREATE INDEX ix_audit_action ON audit(action, at);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;

CREATE TABLE mcp_profiles (
  id              TEXT PRIMARY KEY,              -- slug: 'default', 'lighting-read', ...
  name            TEXT NOT NULL,
  description     TEXT,
  namespaces_json TEXT,                          -- NULL = wszystkie active z kb_registry
  tools_json      TEXT NOT NULL,                 -- podzbiór narzędzi MCP
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE api_keys (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  label          TEXT NOT NULL,
  prefix         TEXT NOT NULL,                  -- np. 'sk-Ab1' (do identyfikacji w UI)
  hash           TEXT NOT NULL UNIQUE,           -- sha256 hex całego raw; raw pokazany JEDEN raz
  scopes_json    TEXT NOT NULL DEFAULT '["read"]',
  profile_id     TEXT NOT NULL REFERENCES mcp_profiles(id),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  created_at     TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,                  -- TTL OBOWIĄZKOWY (lekcja optimaKB: klucze bez TTL)
  last_used_at   TEXT,
  requests_count INTEGER NOT NULL DEFAULT 0,
  revoked_at     TEXT
);
CREATE INDEX ix_api_keys_user ON api_keys(user_id, status);

CREATE TABLE learning_gaps (
  id                  TEXT PRIMARY KEY,          -- gap_<yyyymmdd>_<hex8>
  question            TEXT NOT NULL,
  normalized_question TEXT NOT NULL,
  source              TEXT NOT NULL CHECK (source IN ('mcp','panel','feedback')),
  kb_namespace        TEXT,
  confidence          REAL,
  evidence_count      INTEGER NOT NULL DEFAULT 0,
  answer_preview      TEXT,                      -- max 500 znaków
  api_key_id          TEXT,
  status              TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','in_draft','resolved','ignored')),
  draft_id            TEXT REFERENCES drafts(id),
  metadata_json       TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL,
  processed_at        TEXT,
  processed_by        TEXT
);
CREATE UNIQUE INDEX ux_gaps_open_dedupe ON learning_gaps(normalized_question) WHERE status = 'open';
CREATE INDEX ix_gaps_status ON learning_gaps(status, created_at DESC);

CREATE TABLE answers (                           -- pod feedback i diagnostykę jakości
  id            TEXT PRIMARY KEY,                -- ans_<yyyymmdd>_<hex8>
  question      TEXT NOT NULL,
  namespaces_json TEXT NOT NULL DEFAULT '[]',
  citations_json  TEXT NOT NULL DEFAULT '[]',   -- [{n,id,namespace}]
  confidence    REAL,
  model         TEXT,
  degraded      INTEGER NOT NULL DEFAULT 0,
  no_answer     INTEGER NOT NULL DEFAULT 0,
  source        TEXT NOT NULL CHECK (source IN ('mcp','panel','api')),
  api_key_id    TEXT,
  user_id       TEXT,
  took_ms       INTEGER,
  created_at    TEXT NOT NULL
);
CREATE INDEX ix_answers_at ON answers(created_at DESC);

CREATE TABLE feedback (
  id         TEXT PRIMARY KEY,
  answer_id  TEXT NOT NULL REFERENCES answers(id),
  verdict    TEXT NOT NULL CHECK (verdict IN ('up','down')),
  comment    TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,                   -- biała lista w kodzie: llm.chat, llm.openie, llm.embeddings, ...
  value_json TEXT NOT NULL,                      -- sekrety: {"sealed":"<base64 AES-GCM>"}
  is_secret  INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

-- Manifesty pipeline'u (resume) — w DB zamiast plików JSON (lekcja optimaKB: wyścigi, rozjazdy).
CREATE TABLE export_runs (
  id          INTEGER PRIMARY KEY,
  namespace   TEXT NOT NULL REFERENCES kb_registry(namespace),
  status      TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','error')),
  doc_count   INTEGER,
  chunk_count INTEGER,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE export_files (
  run_id     INTEGER NOT NULL REFERENCES export_runs(id),
  file_name  TEXT NOT NULL,
  row_count  INTEGER NOT NULL,
  columns_json TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  path       TEXT NOT NULL,
  PRIMARY KEY (run_id, file_name)
);
CREATE TABLE upload_records (                    -- cache uploadów do MinIO; klucz zawiera sha256 TREŚCI
  namespace   TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  uploaded_url TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  PRIMARY KEY (namespace, file_name, file_sha256)
);
CREATE TABLE build_jobs (
  id             INTEGER PRIMARY KEY,
  namespace      TEXT NOT NULL,
  run_id         INTEGER,
  file_name      TEXT NOT NULL,
  file_sha256    TEXT NOT NULL,
  openspg_job_id INTEGER,
  job_name       TEXT NOT NULL,
  entity_type    TEXT NOT NULL,
  entity_type_id INTEGER,
  row_count      INTEGER,
  uploaded_url   TEXT,
  status         TEXT NOT NULL,                  -- INIT|WAITING|RUNNING|FINISH|ERROR|SKIP|TERMINATE|SET_FINISH
  gmt_create     TEXT,
  gmt_modified   TEXT,
  finished_at    TEXT
);
CREATE INDEX ix_build_jobs_ns ON build_jobs(namespace, file_name, status);

CREATE TABLE quality_reports (
  id          INTEGER PRIMARY KEY,
  namespace   TEXT NOT NULL,
  run_id      INTEGER,
  verdict     TEXT NOT NULL CHECK (verdict IN ('OK','WARN','FAIL')),
  checks_json TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE breakers (                          -- circuit breakery z TTL i half-open (lekcja F-10)
  name          TEXT PRIMARY KEY,                -- 'llm.chat' | 'openspg' | 'stirling' | ...
  state         TEXT NOT NULL DEFAULT 'closed' CHECK (state IN ('closed','open','half_open')),
  reason        TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  opened_at     TEXT,
  retry_after   TEXT,                            -- po tym czasie automatyczna sonda half-open
  updated_at    TEXT NOT NULL
);

-- Mirror chunków: hybrydowy retrieval (FTS5 trigram — polska fleksja) + fallback gdy OpenSPG leży.
CREATE TABLE chunks_mirror (
  id              TEXT PRIMARY KEY,              -- id encji Chunk (to samo co w grafie)
  namespace       TEXT NOT NULL,
  doc_id          TEXT NOT NULL,                 -- id ReferenceDocument
  title           TEXT,
  section_heading TEXT,
  content         TEXT NOT NULL,
  source_ref      TEXT,
  updated_at      TEXT NOT NULL
);
CREATE INDEX ix_chunks_ns ON chunks_mirror(namespace);
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  title, content,
  content=chunks_mirror, content_rowid=rowid,
  tokenize='trigram'
);
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks_mirror BEGIN
  INSERT INTO chunks_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks_mirror BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
END;
CREATE TRIGGER chunks_au AFTER UPDATE ON chunks_mirror BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO chunks_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;

-- Seed: profil domyślny MCP (wszystkie narzędzia read + feedback; wszystkie aktywne KB).
INSERT INTO mcp_profiles (id, name, description, namespaces_json, tools_json, enabled, created_at, updated_at)
VALUES ('default', 'Domyślny (odczyt)', 'Wszystkie aktywne bazy; narzędzia tylko-do-odczytu + feedback',
        NULL, '["kb_search","kb_answer","kb_list","kb_feedback"]', 1,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
