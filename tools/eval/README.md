# tools/eval — pomiar jakości retrievalu i odpowiedzi

| plik | co robi |
| --- | --- |
| `run-eval.mjs` | metryki retrievalu na goldens (hit@1/hit@5/MRR, negatywy, routing, `mustContain`); **bramki domyślnie włączone**, exit 1 przy regresji |
| `judge.mjs` | LLM-judge jakości odpowiedzi (budżetowany, ręczny/miesięczny); zapisuje podsumowanie do `quality_reports` |
| `goldens/` | zbiory pytań referencyjnych per baza — format i ograniczenia w `goldens/README.md` |
| `baseline.json` | REFERENCYJNY pomiar wydajności i jakości z audytu D8 (2026-09-06) do porównań po zmianach |
| `goldens.example.jsonl` | szablon wiersza dla nowej bazy |

## Uruchomienie

```bash
# tryb domyślny 'fts' — deterministycznie, zero kosztu, mierzy lokalny fallback FTS5
DATA_DIR=/srv/kag-data/kag/panel npm run eval

# pełny hybrid (OpenSPG + embeddingi z settings) — mierzy ścieżkę PRODUKCYJNĄ, kosztuje embeddingi
EVAL_CHANNELS=full TOKEN_ENC_KEY=... OPENSPG_BASE_URL=... DATA_DIR=... npm run eval

# LLM-judge (kosztuje wywołania chat — budżet w JUDGE_MAX)
DATA_DIR=/srv/kag-data/kag/panel TOKEN_ENC_KEY=... node tools/eval/judge.mjs
```

`judge.mjs` zapisuje raport domyślnie do `$DATA_DIR/exports/` — **poza repozytorium**,
bo zawiera pytania użytkowników. Nadpisując `JUDGE_OUT`, nie kieruj go do drzewa repo.

## Bramki i progi

`run-eval.mjs` kończy się kodem 1, gdy: `hit@5 < 0.8`, `MRR < 0.5`,
`negativeAccuracy < 0.9`, `namespaceAccuracy < 0.9`, `mustContainAccuracy < 1`,
albo gdy zbiór goldens nie ma ani jednego pozytywu lub ani jednego negatywu.
Nadpisanie: `EVAL_MIN_HIT5`, `EVAL_MIN_MRR`, `EVAL_MIN_NEG`, `EVAL_MIN_NS`,
`EVAL_MIN_RELEVANCE`. `EVAL_NO_GATE=1` wyłącza bramki (eksploracja, nigdy CI).

Negatywy ocenia **ta sama funkcja**, co produkcyjna bramka odmowy
(`packages/shared/src/answer/gate.ts`) — metryka mierzy trafność, a nie to, które
kanały akurat działały.

Deterministyczna bramka w CI (bez żywego stacka) siedzi osobno w
`packages/shared/test/eval-retrieval-fixture.test.ts` — działa na fixturach,
tym samym progiem bramki odmowy.

## OGRANICZENIE (stan 2026-09-06)

Korpus produkcyjny to **1 dokument / 2 chunki** (StagingSmoke) i **0 chunków**
(PomagierOps). Goldens zbudowano wyłącznie z realnej treści — bez danych zmyślonych —
więc `hit@5 = 1.0` jest DETEKTOREM REGRESJI, a nie dowodem jakości rankingu.
Szczegóły i lista brakujących pokryć: `goldens/README.md`.
