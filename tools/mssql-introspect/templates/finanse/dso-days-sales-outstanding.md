---
id: dso-days-sales-outstanding
title: DSO (Days Sales Outstanding)
area: finanse
order: 70
questions:
  - "Ile dni średnio czekamy na pieniądze ze sprzedaży (DSO) w ostatnich 12 miesiącach?"
  - "Jakie było DSO za 2025 rok i ile wynosi bez operatorów płatności?"
params:
  od:
    type: date
    description: początek okresu sprzedaży (włącznie)
    example: 2025-09-14
  do:
    type: date
    description: koniec okresu sprzedaży (wyłącznie); saldo należności liczone na koniec dnia poprzedzającego
    example: 2026-09-14
verified: 2026-09-28
---
Definicja: liczba dni sprzedaży „zamrożonych" w należnościach — saldo AR na koniec okresu podzielone przez średnią dzienną sprzedaż brutto z okresu (domyślnie 365 dni).

Formuła: DSO = AR / sprzedaż brutto (okres) × liczba dni okresu, okres = [`@od`, `@do`), liczba dni = DATEDIFF(day, `@od`, `@do`); AR = saldo na koniec dnia przed `@do`, odtworzone z historii spłat jak w KPI 1 (gdy `@do` = jutro, czyli okres obejmuje dzisiaj, AR = bieżące `nzf_Wartosc`); wariant bez operatorów: (AR − należności od operatorów) / sprzedaż × liczba dni okresu. Sprzedaż = Σ `dok_WartBrutto` dla FS + PA + KFS (KFS ujemne), `dok_Status = 1`, bez FSd.

Tabele i kolumny: `nz__Finanse` (nzf_Wartosc, nzf_IdObiektu), `nz_FinanseSplata` (saldo na koniec okresu), `sl_FormaPlatnosci` (operatorzy), `dok__Dokument` (dok_Typ, dok_Podtyp, dok_Status, dok_DataWyst, dok_WartBrutto).

Kody: `nzf_Typ` 39; `dok_Typ` 2, 6, 21; wykluczenie `dok_Typ = 2 AND dok_Podtyp = 1`.

```sql
-- KPI 6: DSO — dni należności w sprzedaży (saldo AR na koniec okresu / sprzedaż brutto okresu x dni okresu)
-- zakres: [@od, @do) — przedział półotwarty; saldo AR na koniec dnia przed @do (odtworzone z historii spłat)
WITH splaty AS (
  SELECT s.nzs_IdDlugu, SUM(s.nzs_WartoscWalutaDlugu) AS splacono_w_walucie_dlugu
  FROM dbo.nz_FinanseSplata s
  WHERE s.nzs_Data < @do
  GROUP BY s.nzs_IdDlugu
), otwarte AS (
  SELECT n.nzf_IdObiektu,
         ROUND((n.nzf_WartoscPierwotnaWaluta - ISNULL(sp.splacono_w_walucie_dlugu, 0)) * n.nzf_Kurs / n.nzf_LiczbaJednostek, 2) AS saldo_pln
  FROM dbo.nz__Finanse n
  LEFT JOIN splaty sp ON sp.nzs_IdDlugu = n.nzf_Id
  WHERE n.nzf_Typ = 39
    AND n.nzf_TypObiektu = 1
    AND n.nzf_Data < @do
    AND n.nzf_WartoscPierwotnaWaluta - ISNULL(sp.splacono_w_walucie_dlugu, 0) <> 0
), ar AS (
  SELECT
    SUM(f.saldo_pln) AS naleznosci_pln,
    SUM(CASE WHEN op.id IS NULL THEN f.saldo_pln ELSE 0 END) AS naleznosci_bez_operatorow_pln
  FROM otwarte f
  LEFT JOIN (
    SELECT fp_CentId AS id FROM dbo.sl_FormaPlatnosci WHERE fp_CentId IS NOT NULL
    UNION
    SELECT fp_InstKredytId FROM dbo.sl_FormaPlatnosci WHERE fp_InstKredytId IS NOT NULL
  ) op ON op.id = f.nzf_IdObiektu
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
  DATEDIFF(day, @od, @do) AS dni_okresu,
  ROUND(1.0 * DATEDIFF(day, @od, @do) * ar.naleznosci_pln / NULLIF(sprz.sprzedaz_brutto_pln, 0), 1) AS dso_dni,
  ROUND(1.0 * DATEDIFF(day, @od, @do) * ar.naleznosci_bez_operatorow_pln / NULLIF(sprz.sprzedaz_brutto_pln, 0), 1) AS dso_bez_operatorow_dni
FROM ar CROSS JOIN sprz
```

Pułapki:
- Mianownik to CAŁA sprzedaż (także gotówkowa i przedpłacona), zgodnie z prostą formułą z katalogu; DSO „kredytowe" wymagałoby ograniczenia sprzedaży do FS z `dok_PlatId IS NOT NULL` (odroczone) — wtedy licznik też tylko należności podtypu 1 od kontrahentów.
- Sezonowość: IV kwartał ma ok. 1,5× więcej dokumentów niż czerwiec — DSO liczony na 90 dniach skacze; 365 dni wygładza, ale spóźnia reakcję.
- Korekty: KFS ujemne w mianowniku; KFZ (należność od dostawcy) w liczniku — dla czystości odejmij ją (grupowanie po `dok_Typ` źródłowym z KPI 2).
- Waluty: `dok_WartBrutto` już w PLN; nie przeliczać.
- Paragony bez rozrachunku wchodzą do sprzedaży, ale nigdy do AR — obniżają DSO (poprawnie: są zapłacone).
- Saldo AR na koniec przeszłego okresu jest odtwarzane z dat spłat (`nzs_Data` = data dokumentu spłaty): spłaty zaksięgowane później z wcześniejszą datą obniżają je wstecz, więc DSO za przeszły okres może być niższe niż wyliczone wtedy z salda w programie (2026-09-14: AR w programie 853,9 tys., odtworzone ok. 101,8 tys. — zaległe wyciągi z wypłatami operatorów). Interpretacja niżej pochodzi z salda w programie z 2026-09-14.
- Należności od operatorów płatności są istotne dopiero od 02–03.2026 (wcześniej kilkadziesiąt rozrachunków podtypu 4 miesięcznie, od 03.2026 ok. 2,7–3,6 tys.; sprzedaż z zamówień dokumentowana FS z płatnikiem zamiast PA) — DSO z operatorami za okresy sprzed marca 2026 nie jest porównywalne z późniejszymi.

Interpretacja (2026-09-14): DSO 21,5 dnia (AR 853,9 tys. / sprzedaż 14,50 mln PLN z 53 544 dokumentów), po wyłączeniu operatorów 3,3 dnia. Realny cykl kredytu kupieckiego jest znikomy; 18 dni DSO to czas rozliczeń marketplace'ów i bramek płatniczych — dźwignia gotówkowa leży w negocjacji cykli wypłat z operatorami, nie w windykacji klientów.
