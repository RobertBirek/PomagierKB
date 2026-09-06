-- 0027_g10_observability.sql — obserwowalność kosztu LLM i rozróżnienie raportów jakości.
--
-- 1) quality_reports.kind — jedna tabela trzyma DWA różne rodzaje raportów:
--    'gate'    = quality gate builda KB (per przestrzeń, z run_id eksportu),
--    'answers' = tygodniowy raport jakości ODPOWIEDZI (job quality_answers,
--                run_id NULL, dodatkowo pseudo-przestrzeń '__all__').
--    Bez tej kolumny „ostatni raport przestrzeni" mieszał werdykty i pierwszy
--    bieg quality_answers przesłoniłby werdykt builda w /kb (ustalenie D10-09).
--    Backfill: raportem odpowiedzi jest wiersz pseudo-przestrzeni '__all__' albo
--    taki, którego checks zawierają 'answer_quality_week' — reszta to gate.
--    (Sam run_id NIE wystarcza: quality gate zapisuje raport z run_id NULL, gdy
--    baza nie ma jeszcze żadnego eksportu — pipeline/quality-gate.ts:185.)
ALTER TABLE quality_reports ADD COLUMN kind TEXT NOT NULL DEFAULT 'gate'
  CHECK (kind IN ('gate','answers'));
UPDATE quality_reports
   SET kind = CASE
     WHEN namespace = '__all__' THEN 'answers'
     WHEN checks_json LIKE '%answer_quality_week%' THEN 'answers'
     ELSE 'gate'
   END;
CREATE INDEX ix_quality_reports_ns_kind ON quality_reports(namespace, kind, id DESC);

-- 2) llm_usage — TRWAŁY rejestr zużycia tokenów LLM (ustalenie GAP-05).
--    Do tej pory tokeny trafiały wyłącznie do logu pino rotowanego przez dockera
--    (10 MB × 3), więc kosztu nie dało się ani zbudżetować, ani przypisać do
--    modelu/bazy. Wiersz = jedno wywołanie LLM; agregaty liczy
--    packages/shared/src/llm/usage.ts (bez cennika w kodzie — stawki z settings).
--    Retencja: worker retencji, klucz polityki llmUsageDays (domyślnie 365 dni).
CREATE TABLE llm_usage (
  id                INTEGER PRIMARY KEY,
  at                TEXT NOT NULL,               -- ISO-8601 UTC
  endpoint          TEXT NOT NULL,               -- 'chat' | 'embeddings'
  purpose           TEXT NOT NULL,               -- nazwa breakera/wołającego, np. 'llm.chat'
  model             TEXT NOT NULL,
  namespace         TEXT,                        -- baza wiedzy, gdy znana (koszt per KB)
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_llm_usage_at    ON llm_usage(at);
CREATE INDEX ix_llm_usage_model ON llm_usage(model, at);
