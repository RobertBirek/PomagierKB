# SubiektKB — projekt importu masowego dokumentacji InsERT GT (2026-09-09)

Zatwierdzony plan (sesja 2026-09-09) i jego wynik. Szczegóły operacyjne: `docs/runbooks/new-kb-bulk-import.md`;
decyzja architektoniczna: `docs/design/PLAN.md` § „Zmiany decyzji" (2026-09-09).

## Cel

Nowa baza wiedzy `SubiektKB`: pełna dokumentacja linii InsERT GT 1.89 HF1 (Subiekt, Rachmistrz, Rewizor,
Gratyfikant, Gestor GT, Sfera, EDI++, Własne COM/XML, HomeBanking, HopWin) z publicznego folderu Google
Drive oraz dokumentacja bazy danych potwierdzona na żywej instancji MSSQL (`OPTIMA`, baza `pomagier`).

## Decyzje

| Decyzja | Uzasadnienie |
|---|---|
| Dwa narzędzia hostowe (`tools/kb-import`, `tools/mssql-introspect`), zero zmian w panel-api poza poprawką GAP-03 | kontenery celowo odcięte od tunelu (`wg_guard.sh`); panel nie zna `.chm`/`.zip`; jednorazowa migracja nie uzasadnia kodu produktowego |
| Konwersja do Markdown na hoście, upload JSON `{text,title,sourceUrl}` | kontrola podziału (100 000 zn., okno analyze 12 000), profil `docs`, unikalny `sourceUrl` per fragment (precedencja `source_ref`) |
| MSSQL: tylko katalog (`sys.*`), zapytania jako stałe + test read-only, liczności bez modułów kadrowych | zakres „metadane" nie uruchamia DPIA; definicje obiektów i tak są zaszyfrowane — treść ze `Skrypty_SQL` |
| Scalanie trzech źródeł bazy: żywy katalog + `Dokumentacja_DB.xml` + skrypty SQL, plus raport różnic | „potwierdzenie" z prośby użytkownika; 950 tabel z opisami, 10 779 opisanych kolumn, 0 różnic typów, 7 tabel technicznych tylko w bazie |
| Generyczny schemat OpenSPG (bez encji per KB) | encje per KB = Kreator v1.5 (PLAN.md), poza zakresem |
| Recenzja: agent zatwierdza masowo po kontroli wyrywkowej (decyzja użytkownika) | 400+ szkiców; próbki sprawdzane per partia (routing, kategoria, polskie znaki, streszczenie) |
| Poświadczenie MSSQL w `/etc/kag/mssql-optima.env` (0600, host) | konwencja `/etc/kag/*.env`; panel go nie potrzebuje |

## Zakres źródeł

Wchodzi: 20 PDF (pdfjs), `Pomoc/InsERTGT.chm` (pomoc, 97 fragmentów), `Pomoc/gta.chm` (model obiektowy
Sfery, 56), `Pomoc/InfoGT.chm` (8), ZIP-y z HTML/XML/XSD/skryptami (kurowane), dokumentacja bazy (160 fragmentów).
Pominięte świadomie: `GTA.chm` w korzeniu (starsza kopia), `Pomoc.zip` i rozpakowane podfoldery (duplikaty),
`Opis_struktury_zbiorow_danych.htm` (duplikat XML), `Lista_zmian.htm` (podzbiór), `.doc`/`.xls`/`.mdb` (brak konwertera na hoście).
`czerwony_PLUS.pdf` (skan) wszedł przez OCR pipeline'u (`upload-file.mjs`) po trzech poprawkach ekstrakcji;
26 stron ze zrzutami ekranu z `Zmiany_w_InsERT_GT.pdf` odrzucone (OCR daje same nagłówki).

## Rozszerzenie 2026-09-09 (wieczór): e-Pomoc techniczna InsERT

Na prośbę użytkownika dodano publiczne FAQ producenta: 5 888 artykułów dla linii GT (crawler
`tools/kb-import/fetch-epomoc.mjs`, 1 żądanie/0,7 s, User-Agent z kontaktem), pogrupowane w 369 dokumentów
program × kategoria (`prepare-epomoc.mjs`), typ dokumentu „FAQ e-Pomoc". Stan po buildzie: 743 dokumenty,
22 661 chunków, quality gate OK; eval fts przechodzi (MRR 0,86).

## Rozszerzenie 2026-09-10: forum.insert.com.pl

Sekcje GT forum (9 sekcji, 8 635 wątków, 0 błędów pobierania) → 7 695 wątków z odpowiedzią (6 756 z odpowiedzią
pracownika InsERT), 940 pominiętych (bez odpowiedzi/krótkie) → 226 dokumentów sekcja × rok, typ „forum
użytkowników". Zapisywana rola autora, nie nazwisko; cytaty usuwane; wątek do 12 000 zn. Stan po buildzie:
969 dokumentów, 34 972 chunki, quality gate OK (build 21 min); eval fts MRR 0,88.

## Weryfikacja

`npm test` (w tym 40 testów narzędzi), lint, quality gate OK po każdym buildzie, goldens `SubiektKB.jsonl`,
`npm run eval` vs baseline, E2E `tools/ux-audit/e2e.mjs`, `smoke.sh`.
