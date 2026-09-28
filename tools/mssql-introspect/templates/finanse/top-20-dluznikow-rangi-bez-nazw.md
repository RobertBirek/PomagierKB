---
id: top-20-dluznikow-rangi-bez-nazw
title: Top 20 dłużników (rangi, bez nazw)
area: finanse
order: 150
questions:
  - "Jak policzyć: Top 20 dłużników (rangi, bez nazw)?"
params: {}
verified: 2026-09-14
---
Definicja: dwudziestu kontrahentów z największym otwartym saldem należności na dzień odniesienia, z kwotą po terminie, maksymalnym opóźnieniem i identyfikatorem kontrahenta (bez nazwy).

Formuła: per `nzf_IdObiektu`: Σ `nzf_Wartosc`, Σ po terminie, MAX dni po terminie, MIN terminu; ranga po saldzie malejąco.

Tabele i kolumny: `nz__Finanse` (nzf_IdObiektu, nzf_Wartosc, nzf_TerminPlatnosci), `sl_FormaPlatnosci` (operatorzy). Nazwa kontrahenta jest w `adr__Ewid`/`kh__Kontrahent` — poza strażnikiem; identyfikator wystarcza do odszukania w programie.

Kody: `nzf_Typ` 39; `nzf_TypObiektu` 1.

```sql
-- KPI 14: Top 20 dłużników (rangi i identyfikatory kontrahentów, bez nazw) — stan bieżący
-- zakres: zamień datę odniesienia '2026-09-14' (we wszystkich miejscach)
SELECT TOP (20)
  ROW_NUMBER() OVER (ORDER BY SUM(f.nzf_Wartosc) DESC) AS ranga,
  f.nzf_IdObiektu AS kontrahent_id,
  CASE WHEN op.id IS NULL THEN 'kontrahent' ELSE 'operator platnosci' END AS rodzaj_dluznika,
  COUNT(*) AS liczba_rozrachunkow,
  SUM(f.nzf_Wartosc) AS saldo_pln,
  SUM(CASE WHEN f.nzf_TerminPlatnosci < '2026-09-14' THEN f.nzf_Wartosc ELSE 0 END) AS po_terminie_pln,
  MAX(CASE WHEN f.nzf_TerminPlatnosci < '2026-09-14' THEN DATEDIFF(day, f.nzf_TerminPlatnosci, '2026-09-14') ELSE 0 END) AS max_dni_po_terminie,
  MIN(f.nzf_TerminPlatnosci) AS najstarszy_termin
FROM dbo.nz__Finanse f
LEFT JOIN (
  SELECT fp_CentId AS id FROM dbo.sl_FormaPlatnosci WHERE fp_CentId IS NOT NULL
  UNION
  SELECT fp_InstKredytId FROM dbo.sl_FormaPlatnosci WHERE fp_InstKredytId IS NOT NULL
) op ON op.id = f.nzf_IdObiektu
WHERE f.nzf_Typ = 39
  AND f.nzf_TypObiektu = 1
  AND f.nzf_Wartosc <> 0
GROUP BY f.nzf_IdObiektu, CASE WHEN op.id IS NULL THEN 'kontrahent' ELSE 'operator platnosci' END
ORDER BY saldo_pln DESC
```

Pułapki:
- Operatorzy płatności zajmują czołowe rangi — lista windykacyjna wymaga filtra `WHERE op.id IS NULL` (lub osobnego raportu „wypłaty operatorów do uzgodnienia").
- Saldo netto z kontrahentem (należności minus zobowiązania, katalog N11) wymaga dołączenia typu 40 — dłużnik z KFS do wypłaty ma w rzeczywistości mniejsze saldo.
- Klienci powiązani (kilka `kh_Id`) rozmywają ranking.
- Rozliczenia częściowe: `saldo_pln` to reszta, `liczba_rozrachunkow` — liczba otwartych pozycji, nie faktur wystawionych.
- Lista zawiera identyfikatory kontrahentów; nie łącz jej z nazwami w dokumentach publikowanych w bazie wiedzy.

Interpretacja (2026-09-14): rangi 1, 2, 4, 5 i 10 to operatorzy płatności i instytucja pobraniowa (łącznie ok. 422 tys. PLN, maksymalnie 18–34 dni od terminu — bieżące cykle wypłat). Największy dłużnik-kontrahent ma 72,6 tys. PLN w całości przed terminem; najstarsze przeterminowanie wśród Top 20 to 321 dni (8,9 tys. PLN, 3 rozrachunki) — jedyna pozycja kwalifikująca się do windykacji twardej.
