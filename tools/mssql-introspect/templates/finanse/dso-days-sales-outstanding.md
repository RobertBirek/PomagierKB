---
id: dso-days-sales-outstanding
title: DSO (Days Sales Outstanding)
area: finanse
order: 70
questions:
  - "Jak policzyć: DSO (Days Sales Outstanding)?"
params:
  od:
    type: date
    description: początek zakresu (włącznie)
    example: 2025-09-14
  do:
    type: date
    description: koniec zakresu (wyłącznie)
    example: 2026-09-14
verified: 2026-09-14
---
Definicja: liczba dni sprzedaży „zamrożonych" w należnościach — saldo AR podzielone przez średnią dzienną sprzedaż brutto z 365 dni.

Formuła: DSO = AR / sprzedaż brutto (365 dni) × 365; wariant bez operatorów: (AR − należności od operatorów) / sprzedaż × 365. Sprzedaż = Σ `dok_WartBrutto` dla FS + PA + KFS (KFS ujemne), `dok_Status = 1`, bez FSd.

Tabele i kolumny: `nz__Finanse` (nzf_Wartosc, nzf_IdObiektu), `sl_FormaPlatnosci` (operatorzy), `dok__Dokument` (dok_Typ, dok_Podtyp, dok_Status, dok_DataWyst, dok_WartBrutto).

Kody: `nzf_Typ` 39; `dok_Typ` 2, 6, 21; wykluczenie `dok_Typ = 2 AND dok_Podtyp = 1`.

```sql
-- KPI 6: DSO — dni należności w sprzedaży (saldo AR / sprzedaż brutto 365 dni x 365)
-- zakres: [@od, @do) — przedział półotwarty
WITH ar AS (
  SELECT
    SUM(f.nzf_Wartosc) AS naleznosci_pln,
    SUM(CASE WHEN op.id IS NULL THEN f.nzf_Wartosc ELSE 0 END) AS naleznosci_bez_operatorow_pln
  FROM dbo.nz__Finanse f
  LEFT JOIN (
    SELECT fp_CentId AS id FROM dbo.sl_FormaPlatnosci WHERE fp_CentId IS NOT NULL
    UNION
    SELECT fp_InstKredytId FROM dbo.sl_FormaPlatnosci WHERE fp_InstKredytId IS NOT NULL
  ) op ON op.id = f.nzf_IdObiektu
  WHERE f.nzf_Typ = 39 AND f.nzf_TypObiektu = 1 AND f.nzf_Wartosc <> 0
), sprz AS (
  SELECT SUM(d.dok_WartBrutto) AS sprzedaz_brutto_pln, COUNT(*) AS liczba_dok
  FROM dbo.dok__Dokument d
  WHERE d.dok_Typ IN (2, 6, 21)
    AND d.dok_Status = 1
    AND NOT (d.dok_Typ = 2 AND d.dok_Podtyp = 1)
    AND d.dok_DataWyst >= @od AND d.dok_DataWyst < @do
)
SELECT
  ar.naleznosci_pln,
  ar.naleznosci_bez_operatorow_pln,
  sprz.sprzedaz_brutto_pln,
  sprz.liczba_dok,
  365 AS dni_okresu,
  ROUND(365.0 * ar.naleznosci_pln / NULLIF(sprz.sprzedaz_brutto_pln, 0), 1) AS dso_dni,
  ROUND(365.0 * ar.naleznosci_bez_operatorow_pln / NULLIF(sprz.sprzedaz_brutto_pln, 0), 1) AS dso_bez_operatorow_dni
FROM ar CROSS JOIN sprz
```

Pułapki:
- Mianownik to CAŁA sprzedaż (także gotówkowa i przedpłacona), zgodnie z prostą formułą z katalogu; DSO „kredytowe" wymagałoby ograniczenia sprzedaży do FS z `dok_PlatId IS NOT NULL` (odroczone) — wtedy licznik też tylko należności podtypu 1 od kontrahentów.
- Sezonowość: IV kwartał ma ok. 1,5× więcej dokumentów niż czerwiec — DSO liczony na 90 dniach skacze; 365 dni wygładza, ale spóźnia reakcję.
- Korekty: KFS ujemne w mianowniku; KFZ (należność od dostawcy) w liczniku — dla czystości odejmij ją (grupowanie po `dok_Typ` źródłowym z KPI 2).
- Waluty: `dok_WartBrutto` już w PLN; nie przeliczać.
- Paragony bez rozrachunku wchodzą do sprzedaży, ale nigdy do AR — obniżają DSO (poprawnie: są zapłacone).

Interpretacja (2026-09-14): DSO 21,5 dnia (AR 853,9 tys. / sprzedaż 14,50 mln PLN z 53 544 dokumentów), po wyłączeniu operatorów 3,3 dnia. Realny cykl kredytu kupieckiego jest znikomy; 18 dni DSO to czas rozliczeń marketplace'ów i bramek płatniczych — dźwignia gotówkowa leży w negocjacji cykli wypłat z operatorami, nie w windykacji klientów.
