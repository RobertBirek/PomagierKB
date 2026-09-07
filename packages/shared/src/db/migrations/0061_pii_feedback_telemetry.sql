-- 0061 — trzy dodatki wynikające z przeglądu zewnętrznego raportu „deep-research-tools.md"
-- (2026-09-07). Wszystkie ADDYTYWNE: kolumny dopuszczają NULL, więc historyczne wiersze
-- pozostają ważne, a migracje w tym projekcie są forward-only.

-- 1) Polityka danych osobowych per baza wiedzy. Świadomie OSOBNA KOLUMNA, a nie klucz
--    w config_json: to kontrola decydująca o tym, czy dane osobowe opuszczają EOG, więc
--    ma być widoczna w zrzucie schematu i pilnowana przez CHECK, a nie zakopana w blobie,
--    który da się nadpisać przy okazji zmiany czegoś zupełnie innego.
--    Domyślnie 'flag' (wykrywaj i licz, nie zmieniaj treści) — najpierw chcemy wiedzieć,
--    czy PII w ogóle występuje, zanim zaczniemy niszczyć treść dokumentów.
ALTER TABLE kb_registry ADD COLUMN pii_policy TEXT NOT NULL DEFAULT 'flag'
  CHECK (pii_policy IN ('off','flag','mask'));

-- 2) Taksonomia przyczyn błędu przy negatywnej ocenie odpowiedzi. Do tej pory `verdict`
--    ('up'/'down') plus wolny komentarz nie mówiły, CO zawiodło — a bez tego nie da się
--    odróżnić braku wiedzy w bazie od halucynacji modelu. NULL dla wpisów historycznych
--    i dla ocen pozytywnych.
ALTER TABLE feedback ADD COLUMN category TEXT
  CHECK (category IS NULL OR category IN (
    'retrieval_miss','hallucination','citation_error','outdated','incomplete','wrong_kb','other'
  ));

-- 3) Telemetria zapytań: wersja promptu i czasy per kanał retrievalu. Bez wersji promptu
--    nie da się porównać dwóch jego wariantów na tym samym zbiorze; bez rozbicia czasów
--    wiadomo tylko, że „odpowiedź trwała 2 s", ale nie który kanał to zjadł.
ALTER TABLE answers ADD COLUMN prompt_version TEXT;
ALTER TABLE answers ADD COLUMN retrieval_ms_json TEXT;
