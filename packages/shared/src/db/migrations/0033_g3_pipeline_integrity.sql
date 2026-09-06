-- 0027_g3_pipeline_integrity.sql — integralność pipeline'u wiedzy (audyt G3).
--
-- Zakres:
--  * graph_ids  — rejestr id wyeksportowanych do grafu OpenSPG; podstawa propagacji
--    usunięć (D14-01/D7-02/D14-02): builder jest UPSERT-only, więc wycofany dokument
--    musi zostać nadpisany wierszem-nagrobkiem (tombstone) w kolejnym eksporcie.
--  * kb_registry.dirty_version/built_version — wersjonowanie flagi dirty (D7-04):
--    promocja/withdraw W TRAKCIE builda nie może zniknąć przez bezwarunkowe clearDirty.
--  * export_runs.params_json — parametry, które wyprodukowały artefakty (GAP-04).
--  * drafts.source_owner/source_license/source_date — metadane źródła (GAP-03).
--  * intakes.error_detail — treść błędu obok kodu (D10-08).
--
-- Forward-only: żadna kolumna nie jest usuwana, wszystkie nowe mają wartości domyślne.

-- ── Rejestr id w grafie (stan docelowy vs. to, co faktycznie wysłaliśmy) ─────
CREATE TABLE graph_ids (
  namespace        TEXT NOT NULL,
  id               TEXT NOT NULL,          -- id encji w grafie (DOC_*/CHUNK_*/TOPIC_*)
  entity           TEXT NOT NULL,          -- 'Topic' | 'ReferenceDocument' | 'Chunk'
  live             INTEGER NOT NULL DEFAULT 1,  -- 1 = jest w stanie docelowym
  last_seen_run    INTEGER,                -- ostatni run eksportu, w którym id było żywe
  tombstone_run_id INTEGER,                -- run eksportu, który wystawił nagrobek
  tombstoned_at    TEXT,                   -- POTWIERDZENIE po udanym buildzie (NULL = zaległy)
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  PRIMARY KEY (namespace, id)
) WITHOUT ROWID;
CREATE INDEX ix_graph_ids_state ON graph_ids(namespace, live, tombstoned_at);

-- Backfill: to, co realnie trafiło do grafu w poprzednich buildach, znamy z mirroru
-- (chunki + dokumenty) i z krawędzi (tematy). Bez tego pierwszy build po zmianie
-- tożsamości dokumentu (D7-01) nie wiedziałby, co posprzątać.
INSERT OR IGNORE INTO graph_ids (namespace, id, entity, live, first_seen_at, last_seen_at)
  SELECT namespace, id, 'Chunk', 1, updated_at, updated_at FROM chunks_mirror;
INSERT OR IGNORE INTO graph_ids (namespace, id, entity, live, first_seen_at, last_seen_at)
  SELECT namespace, doc_id, 'ReferenceDocument', 1, MIN(updated_at), MAX(updated_at)
    FROM chunks_mirror GROUP BY namespace, doc_id;
INSERT OR IGNORE INTO graph_ids (namespace, id, entity, live, first_seen_at, last_seen_at)
  SELECT DISTINCT namespace, dst_id, 'Topic', 1, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'
    FROM graph_edges WHERE rel = 'about_topic';

-- ── Wersjonowanie dirty (D7-04) ─────────────────────────────────────────────
ALTER TABLE kb_registry ADD COLUMN dirty_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kb_registry ADD COLUMN built_version INTEGER NOT NULL DEFAULT 0;
-- KB brudna dziś = wersja 1 > built 0 (build i tak musi ją domknąć).
UPDATE kb_registry SET dirty_version = 1 WHERE dirty = 1;

-- Trigger zamiast zmiany repo kbRegistry: KAŻDE markDirty (UPDATE ... SET dirty = 1)
-- podbija licznik. Wewnętrzny UPDATE nie dotyka kolumny `dirty`, więc się nie zapętla.
CREATE TRIGGER kb_registry_dirty_bump AFTER UPDATE OF dirty ON kb_registry
  WHEN NEW.dirty = 1
BEGIN
  UPDATE kb_registry SET dirty_version = OLD.dirty_version + 1 WHERE namespace = NEW.namespace;
END;

-- ── Reprodukowalność eksportu (GAP-04) ──────────────────────────────────────
ALTER TABLE export_runs ADD COLUMN params_json TEXT;

-- ── Metadane źródła (GAP-03) ────────────────────────────────────────────────
ALTER TABLE drafts ADD COLUMN source_owner   TEXT;   -- kto odpowiada merytorycznie
ALTER TABLE drafts ADD COLUMN source_license TEXT;   -- czy wolno cytować/wysyłać do LLM
ALTER TABLE drafts ADD COLUMN source_date    TEXT;   -- data samego dokumentu (YYYY-MM-DD)

-- ── Diagnostyka nieudanych intake'ów (D10-08) ───────────────────────────────
ALTER TABLE intakes ADD COLUMN error_detail TEXT;    -- ≤300 zn., po sanitizerze audytu
