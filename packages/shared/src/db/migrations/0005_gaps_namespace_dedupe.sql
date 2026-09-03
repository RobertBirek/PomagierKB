-- 0005_gaps_namespace_dedupe.sql — dedupe otwartych luk PER NAMESPACE (dotąd
-- globalny: to samo pytanie do dwóch KB zlewało się w jedną lukę o arbitralnym
-- namespace). Przed nowym indeksem: scal ewentualne przyszłe duplikaty w obrębie
-- (pytanie, ns) — dziś być ich nie może (stary indeks był OSTRZEJSZY), krok
-- defensywny na wypadek ręcznych ingerencji w DB.

UPDATE learning_gaps SET evidence_count = (
  SELECT SUM(g2.evidence_count) FROM learning_gaps g2
  WHERE g2.normalized_question = learning_gaps.normalized_question
    AND g2.status = 'open'
    AND (g2.kb_namespace IS learning_gaps.kb_namespace)
)
WHERE status = 'open'
  AND id = (
    SELECT MIN(g3.id) FROM learning_gaps g3
    WHERE g3.normalized_question = learning_gaps.normalized_question
      AND g3.status = 'open'
      AND (g3.kb_namespace IS learning_gaps.kb_namespace)
  );

DELETE FROM learning_gaps
WHERE status = 'open'
  AND id != (
    SELECT MIN(g3.id) FROM learning_gaps g3
    WHERE g3.normalized_question = learning_gaps.normalized_question
      AND g3.status = 'open'
      AND (g3.kb_namespace IS learning_gaps.kb_namespace)
  );

DROP INDEX ux_gaps_open_dedupe;
CREATE UNIQUE INDEX ux_gaps_open_dedupe
  ON learning_gaps(normalized_question, COALESCE(kb_namespace, ''))
  WHERE status = 'open';
