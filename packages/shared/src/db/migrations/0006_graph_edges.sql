-- 0006_graph_edges.sql — krawędzie grafu wiedzy w SQLite (modernizacja MCP).
-- Graf w Neo4j NIE MA krawędzi (relacje *RefId to property-stringi — zweryfikowane
-- empirycznie 2026-09-04), więc nawigacja kb_graph_neighbors działa na tej tabeli,
-- wypełnianej w całości przy każdym eksporcie (chunk→doc, doc→topic).

CREATE TABLE graph_edges (
  namespace TEXT NOT NULL,
  src_id    TEXT NOT NULL,
  rel       TEXT NOT NULL,               -- 'in_document' | 'about_topic'
  dst_id    TEXT NOT NULL,
  PRIMARY KEY (namespace, src_id, rel, dst_id)
) WITHOUT ROWID;
CREATE INDEX ix_graph_edges_dst ON graph_edges(namespace, dst_id);

-- Idempotencja zgłoszeń MCP: szybki lookup (klucz, idempotencyKey) po metadata draftu.
CREATE INDEX ix_drafts_idem ON drafts(submitted_by_key, json_extract(metadata_json, '$.idempotencyKey'))
  WHERE submitted_by_key IS NOT NULL AND json_extract(metadata_json, '$.idempotencyKey') IS NOT NULL;
