---
name: kb-reimport
description: Re-import, odświeżenie lub dopisanie dokumentu do istniejącej bazy wiedzy PomagierKB narzędziami hostowymi (tools/kb-import: upload → promote → build) — w tym ręczne odświeżenie IloveKB, poprawka pojedynczego dokumentu (słownik, KPI, dokument różnic), regeneracja dokumentów z prepare-instance/prepare-db. Używaj zawsze, gdy trzeba zmienić treść w KB inaczej niż przez panel, gdy upload kończy się rate_limited/409/„pominięto", gdy po re-imporcie padają goldens (nowe DOC_id), albo gdy bramka po buildzie pokazuje nagrobki.
---

# Re-import dokumentu do bazy wiedzy (ścieżka hostowa)

Łańcuch: plik `.md` w katalogu roboczym z `manifest.json` → `upload.mjs` (POST /content, dedup
sha256, polling do `drafted`) → `promote.mjs` (bulk promote po intakeId z manifestu) → `build.mjs`
(pełny eksport + builder OpenSPG + bramka). Runbook: `docs/runbooks/new-kb-bulk-import.md`.
Katalogi robocze: `/srv/kag-data/import/<kb>/out/<zestaw>/` (SubiektKB: `docs`, `db`, `slownik`,
`epomoc`, `forum`; IloveKB: `dicts`, `docs`; AnalizyERP: `out`).

## Zanim cokolwiek wyślesz: czy baza już to ma?

Re-import kosztuje build (nowy `DOC_id`, nagrobki, dla SubiektKB 25 min), więc najpierw ustal, czy
treść w bazie różni się od pliku: `sha256sum <plik>` vs `state.json` w katalogu (identyczny hash =
upload i tak pominie), diff pliku vs treść promowanego szkicu (`drafts.content` w SQLite tylko do
odczytu), albo po prostu `kb_search`/mirror (`chunks_mirror.content LIKE`). Plik na dysku bywa
edytowany poza łańcuchem (23.09: literówka istniała tylko w pliku, baza była poprawna) — wtedy
poprawiasz plik, żeby następne odświeżenie nie cofnęło stanu, i NIE budujesz.

## Kolejność (i dlaczego)

1. **Zmień treść u źródła, nie w mirrorze.** Dokumenty generowane (`prepare-instance.mjs`,
   `prepare-db.mjs`, `prepare-dicts.mjs`) poprawiaj w generatorze I w wygenerowanym pliku (albo
   uruchom generator ponownie) — inaczej następne odświeżenie cofnie poprawkę. Ręczne dokumenty
   (KPI, konwencje, słownik ontologiczny) edytuj bezpośrednio; `prepare-instance` zachowuje ich
   wpisy w manifeście (merge), więc nie znikną.
2. **Ten sam `sourceUrl` = ta sama tożsamość.** Precedencja `source_ref` wycofa starą wersję przy
   buildzie. Zmiana tytułu wymaga też poprawki `title` w `manifest.json` (upload bierze tytuł
   z manifestu).
3. **Limity szkiców**: konto importu (`kag-e2e`) ma 25 szkiców/dzień — po kilku uploadach
   dostaniesz `rate_limited`. Zawsze w tej ramce:
   ```bash
   node tools/kb-import/set-limits.mjs 1500 1500
   node tools/kb-import/upload.mjs  --dir <katalog>
   node tools/kb-import/promote.mjs --dir <katalog> --namespace <NS>
   node tools/kb-import/set-limits.mjs 100 25        # PRZYWRÓĆ — inaczej limit anty-spam nie działa
   ```
4. **Upload, który „się udał", mógł nic nie wysłać.** Czytaj podsumowanie: `✓ … → draft` = nowy
   szkic; `pominięto N` = identyczna treść (sha256 w `state.json`) — to dobrze, gdy plik się nie
   zmienił, źle, gdy zmienił. Plik oznaczony `failed_final` w `state.json` jest pomijany na zawsze:
   usuń jego wpis (`state.items[<plik>]`) przed ponowną próbą.
5. **Identyczna treść tego samego dnia** trafia w dedup serwera na STARY, nieudany intake
   (po wyczerpaniu prób `retry` daje 409 „zgłoś treść ponownie"). Wyjście: zmień hash — dopisz
   pusty wiersz na końcu pliku — i usuń wpis ze `state.json`.
6. **Build**: `node tools/kb-import/build.mjs --namespace <NS>`. Mała baza 3–5 min; SubiektKB
   ~25 min. Kilku baz nie buduj równolegle (jeden builder, jeden Neo4j). Jeśli faza `topic.csv`
   trwa >10 min: `docker stats` Neo4j ~400 % CPU + `stop-the-world` w `/logs/debug.log` = burza GC,
   nie zawieszony job (runbook typowe-awarie §2) — heap w `deploy/kag/.env` (`NEO4J_HEAP`).
7. **Po buildzie** bramka pokaże `graph_stale_nodes: WARN` (nagrobki wycofanych wersji) —
   to normalne: `sudo deploy/scripts/purge_graph_nodes.sh --namespace <NS> --limit 4000 --apply`,
   potem `node tools/kb-import/quality-gate.mjs <NS>`. `superseded_documents: WARN` jest
   informacyjne.
8. **Goldens**: re-import daje NOWY `DOC_…` (id zależy od draftu, nie od sourceUrl). Goldens dla
   dokumentów odświeżanych kotwicz przez `expectedSourceRefs: ["#dokumentacja/<fragment>"]`
   (README goldens), nigdy przez `DOC_`. Po buildzie:
   `DATA_DIR=/srv/kag-data/kag/panel node tools/eval/run-eval.mjs tools/eval/goldens/<NS>.jsonl`.
   Jeśli zmiana ma wpływać na ODPOWIEDZI (nie tylko retrieval), sprawdź harnessem:
   `node tools/eval/answer-offline.mjs <sondy.jsonl> --ns <NS>` (kopia bazy, zero zapisu).

## Odświeżenie IloveKB w całości

`sudo systemctl start kag-ilovekb-refresh.service` robi wszystko (dump z produkcji przez
`run-select`/`dump-*.mjs`, regeneracja, limity, upload, promote, build, przywrócenie limitów) w ~8 min;
timer 5. dnia miesiąca 02:30. Po nim zawsze purge nagrobków (pkt 7). Fakty z instancji, które
wchodzą do KPI/konwencji, weryfikuj wyłącznie `node tools/mssql-introspect/run-select.mjs "SELECT …"`
(agregaty, bez danych kontrahentów) i zapisuj w dokumencie z datą testu.

## Czego nie robić

- Nie edytuj `chunks_mirror`/rejestru w SQLite ręcznie — build i tak nadpisze, a bramka wykryje.
- Nie promuj szkiców innych ludzi ani nie omijaj Inboxu dla treści merytorycznych z zewnątrz;
  ścieżka hostowa jest dla dokumentów, które sam wygenerowałeś/poprawiłeś na zlecenie właściciela.
- Nie zostawiaj limitów 1500/1500.
