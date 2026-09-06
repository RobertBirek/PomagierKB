-- 0060 (G12/D8-08, D8-11, GAP-05): treść odpowiedzi, znacznik cache i jawna
-- nazwa modelu w ustawieniach.
--
-- D8-08 — sędzia LLM (tools/eval/judge.mjs) ocenia groundedness/relevance TREŚCI
-- odpowiedzi, a tabela `answers` jej nie przechowywała. Jedynym miejscem, gdzie
-- treść w ogóle lądowała, było `learning_gaps.answer_preview` — zapisywane
-- WYŁĄCZNIE dla odpowiedzi poniżej progu pewności. Sędzia mierzył więc próbkę
-- obciążoną (same słabe odpowiedzi), a dla reszty zwracał null.
--
-- D8-11 — trafienie cache jest ODPOWIEDZIĄ (ma własny wiersz w `answers`), ale
-- nie dało się go odróżnić od świeżego wywołania LLM: wolumen chatu i koszt per
-- odpowiedź były nie do policzenia.
--
-- GAP-05 — `answers.model` było NULL w 100 % wierszy, bo ustawienie `llm.chat`
-- jest zapieczętowane (is_secret=1) i nazwa modelu nie dawała się odczytać bez
-- klucza AES-GCM. Nazwa modelu NIE jest sekretem (sekretem jest apiKey), więc
-- ląduje w osobnej, jawnej kolumnie `settings.model_name` — raportowanie kosztu
-- per model działa bez odszyfrowywania czegokolwiek.

-- Treść odpowiedzi (podgląd o rozsądnej długości — limit narzuca recordAnswer).
ALTER TABLE answers ADD COLUMN answer_text TEXT;

-- 1 = odpowiedź wydana z cache (bez wywołania chat_llm), 0 = policzona na świeżo.
ALTER TABLE answers ADD COLUMN from_cache INTEGER NOT NULL DEFAULT 0;

-- RODO/retencja: treść odpowiedzi bywa pochodną pytania użytkownika, więc musi
-- podlegać DOKŁADNIE tej samej polityce co `answers.question` (anonimizacja po
-- 180 dniach, twarde usunięcie po 365). Usunięcie wiersza kolumnę zabiera samo;
-- anonimizacja to UPDATE, który o nowej kolumnie nie wie — dlatego gwarancję daje
-- wyzwalacz, a nie pamięć wołającego.
--
-- Warunek celowo NIE odwołuje się do literału znacznika anonimizacji
-- ('[usunięte]' żyje w apps/panel-api/src/services/retention.ts i mógłby się
-- rozjechać) — rozpoznajemy SYGNATURĘ operacji: podmiana treści pytania przy
-- jednoczesnym odcięciu atrybucji (user_id i api_key_id już NULL). Nic innego
-- w systemie nie modyfikuje `answers.question`.
CREATE TRIGGER trg_answers_anonymize_text
AFTER UPDATE OF question ON answers
FOR EACH ROW
WHEN NEW.question <> OLD.question
 AND NEW.user_id IS NULL
 AND NEW.api_key_id IS NULL
 AND OLD.answer_text IS NOT NULL
BEGIN
  UPDATE answers SET answer_text = NULL WHERE id = NEW.id;
END;

-- Jawna (NIEsekretna) nazwa modelu ustawienia llm.* — uzupełniana przez
-- setSetting przy każdym zapisie; dla wierszy sprzed migracji zostaje NULL
-- do najbliższego PUT /settings/:key.
ALTER TABLE settings ADD COLUMN model_name TEXT;
