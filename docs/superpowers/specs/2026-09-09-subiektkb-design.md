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
`Opis_struktury_zbiorow_danych.htm` (duplikat XML), `Lista_zmian.htm` (podzbiór), `czerwony_PLUS.pdf` (skan bez
tekstu — wymaga OCR), `.doc`/`.xls`/`.mdb` (brak konwertera na hoście).

## Weryfikacja

`npm test` (w tym 40 testów narzędzi), lint, quality gate OK po każdym buildzie, goldens `SubiektKB.jsonl`,
`npm run eval` vs baseline, E2E `tools/ux-audit/e2e.mjs`, `smoke.sh`.
