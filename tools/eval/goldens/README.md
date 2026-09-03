# Goldens — zbiory pytań referencyjnych per baza

Jeden plik `<Namespace>.jsonl` na bazę + `cross-kb.jsonl` (pytania sprawdzające
routing między bazami, z polem `expectedNamespace`). Workflow: każda partia
promocji szkiców dodaje 2-3 pytania (w tym NEGATYWNE spoza bazy) — patrz
docs/operator-manual.md. Uruchomienie: `DATA_DIR=/srv/kag-data/kag/panel npm run eval`
(tryb `EVAL_CHANNELS=full` mierzy produkcyjny hybrid — wymaga żywego OpenSPG i LLM).
