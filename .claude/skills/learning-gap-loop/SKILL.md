---
name: learning-gap-loop
description: Domykanie otwartych luk wiedzy PomagierKB (learning_gaps: pytania z panelu/MCP, na które kb_answer odmówił lub odpowiedział z niską pewnością) — klasyfikacja luki, sprawdzenie czy treść już jest w bazie, uzupełnienie (dokument, wpis w słowniku, szablon SQL zweryfikowany na produkcji), golden i zamknięcie luki przez API. Używaj gdy użytkownik mówi o lukach wiedzy, „pytaniach bez odpowiedzi", pętli uczenia, „dlaczego bot nie wie…", albo gdy przegląd stanu pokazuje otwarte luki.
---

# Pętla uczenia: od luki do zamknięcia

Luka to realne pytanie użytkownika, na które system nie odpowiedział (`reason`: `out_of_scope`,
`low_confidence`, `no_answer_gate`). Zamknięcie luki = wiedza w bazie ORAZ dowód, że pytanie
teraz dostaje odpowiedź. Samo „wiem, że to jest w dokumentacji" nie wystarcza.

## Kroki

1. **Lista i sondy**
   ```bash
   node tools/eval/gaps.mjs list
   node tools/eval/gaps.mjs probes /tmp/gaps.jsonl
   ```
2. **Odpowiedz offline na wszystkie naraz** (kopia bazy, żywy OpenSPG+LLM, zero zapisu; profil
   z kilkoma bazami, bo tak widzą je użytkownicy):
   ```bash
   (set -a; . deploy/kag/.env; set +a; OPENSPG_BASE_URL=http://$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' release-openspg-server | awk '{print $1}'):8887 \
    DATA_DIR=/srv/kag-data/kag/panel node tools/eval/answer-offline.mjs /tmp/gaps.jsonl --ns SubiektKB,IloveKB,AnalizyERP --out /tmp/gaps.json)
   ```
   Kolumny: `ODMOWA*` = model sam postawił SCOPE, `ODMOWA` = heurystyka „Nie wiem…" w kodzie;
   `cyt 0` przy odmowie = bramka retrievalu (nic nie znalazła), `cyt N` = znalazła, ale model
   uznał źródła za niewystarczające. Czytaj pełną treść z `--out`, nie tylko podgląd.
3. **Sklasyfikuj każdą lukę** (to decyduje, co robisz):
   - **treść JEST, odpowiedź nie trafia** — sprawdź mirror (`chunks_mirror`, `title/section_heading/
     content LIKE`) i ranking: `searchFts` (fallback) oraz `hybridSearch` z `topVectorScore`.
     Zwykle winne: naturalne pytanie kontra słownictwo dokumentu, nagłówek chunka bez kluczowego
     słowa, tytuł dokumentu bez wersji/terminu. Naprawa po stronie TREŚCI (tytuł, pierwsze zdanie
     sekcji, synonimy w słowniku ontologicznym), nie promptu.
   - **treści brak, źródło publiczne** — e-Pomoc/forum/dokumentacja: sprawdź `WebSearch` z
     `allowed_domains: insert.com.pl`; jeśli artykuł istnieje, zwykle jest już w SubiektKB
     (crawl e-Pomocy) → wracasz do poprzedniego przypadku. Nowe źródło → `fetch-epomoc.mjs`/
     `prepare-*` → skill `kb-reimport`.
   - **wiedza instancyjna** (jak coś działa W NASZEJ bazie) → szablon/konwencja do IloveKB,
     KAŻDY fakt zweryfikowany `node tools/mssql-introspect/run-select.mjs "SELECT …"` (tylko
     agregaty, zero nazw/NIP/adresów, liczności osób <10 → „<10"), z datą testu w dokumencie.
   - **nieudokumentowane przez producenta** (np. parametry CLI programów GT) → dopisz do słownika
     wprost „nie ma", żeby odpowiedź była uczciwa, i zamknij lukę.
   - **szum** (staging, test) → `node tools/eval/gaps.mjs ignore <id>`.
4. **Uzupełnij** wg skillu `kb-reimport` (słownik ontologiczny: `/srv/kag-data/import/subiektkb/
   out/slownik/`; IloveKB KPI/konwencje: `/srv/kag-data/import/ilovekb/out/docs/`). Jedna
   przebudowa SubiektKB na koniec, nie per luka.
5. **Golden per luka** w `tools/eval/goldens/<NS>.jsonl` — pytanie w słownictwie użytkownika,
   `expectedSourceRefs` dla dokumentów odświeżanych, `mustContain` z identyfikatorem, który MUSI
   paść w odpowiedzi. Uruchom `run-eval.mjs` na pliku i na całym katalogu.
6. **Powtórz krok 2** na sondach. Luka zamknięta = odpowiedź z cytowaniem i bez odmowy
   (`node tools/eval/gaps.mjs resolve <id>`). Jeśli treść jest, a model nadal odmawia mimo
   cytowań — zostaw lukę otwartą i napisz to wprost: to problem jakości odpowiedzi, którego nie
   naprawisz dokładaniem treści; nie rozszerzaj reguł SCOPE w prompcie (sprawdzone: 22/40
   fałszywych odmów).

## Raport
Tabela: luka → klasa → co zrobiono → wynik po (odp./odmowa, pewność) → status. Osobno: pytania
do właściciela (konwencje „DO POTWIERDZENIA") i to, co zostało otwarte i dlaczego.
