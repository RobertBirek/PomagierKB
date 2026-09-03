-- 0004_url_intake.sql — ingest URL: 'url' w CHECK intakes.source_kind.
-- Rebuild TYLKO intakes (żadna tabela nie ma FK do intakes, więc drop+rename
-- w transakcji migratora jest bezpieczny). drafts NIE jest przebudowywana
-- (learning_gaps.draft_id ma FK — drop wewnątrz transakcji z foreign_keys=ON
-- padłby na danych): draft z URL-a dostaje source_type='api' + URL w source_ref.

CREATE TABLE intakes_new (
  id               TEXT PRIMARY KEY,
  source_kind      TEXT NOT NULL CHECK (source_kind IN ('upload','text','api','url')),
  original_name    TEXT,
  mime             TEXT,
  source_url       TEXT,
  blob_path        TEXT,
  status           TEXT NOT NULL DEFAULT 'received'
                   CHECK (status IN ('received','extracted','cleaned','analyzed','drafted','failed')),
  extract_provider TEXT,
  extract_quality  REAL,
  clean_profile    TEXT,
  cleaned_chars    INTEGER,
  removed_ratio    REAL,
  analysis_json    TEXT,
  draft_id         TEXT,
  error            TEXT,
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  size_bytes       INTEGER
);

INSERT INTO intakes_new SELECT id, source_kind, original_name, mime, source_url, blob_path,
  status, extract_provider, extract_quality, clean_profile, cleaned_chars, removed_ratio,
  analysis_json, draft_id, error, created_by, created_at, updated_at, attempts, size_bytes
FROM intakes;

DROP TABLE intakes;
ALTER TABLE intakes_new RENAME TO intakes;
CREATE INDEX ix_intakes_status ON intakes(status, created_at DESC);
