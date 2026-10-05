---
id: przychod-netto-ze-sprzedazy-miesiecznie
title: Przychód netto ze sprzedaży — miesięcznie
area: sprzedaz
order: 10
questions:
  - "Ile wyniósł przychód netto ze sprzedaży w każdym miesiącu 2025 roku?"
  - "Jaka była sprzedaż netto w sierpniu 2026 w podziale na faktury i paragony?"
  - "Ile sprzedał netto magazyn w Krośnie miesiąc po miesiącu?"
params:
  od:
    type: date
    description: początek zakresu (włącznie)
    example: 2025-01-01
  do:
    type: date
    description: koniec zakresu (wyłącznie)
    example: 2026-01-01
  mag:
    type: enum
    description: magazyn (dok_MagId) — 1 MAG Główny, 5 RKR Krosno (sprzedaż od 2025-08), 6 KOS Koszt (bez sprzedaży); brak = wszystkie magazyny łącznie
    values: [1, 5, 6]
    required: false
    example: 5
verified: 2026-09-28
---
- Definicja: suma wartości netto faktur sprzedaży (FS) i paragonów (PA) wykonanych w miesiącu, przed korektami i zwrotami (odpowiednik KPI F1 „Revenue" i S1 „Sprzedaż wg okresów" z katalogu ERP).
- Formuła: `Przychód netto (M) = Σ dok_WartNetto` dla `dok_Typ IN (2, 21)`, `dok_Status = 1`, `dok_DataWyst` w miesiącu M; dodatkowo rozbicie na towary (`dok_WartTwNetto`) i usługi (`dok_WartUsNetto`) oraz FS vs PA.
- Tabele i kolumny: `dok__Dokument` (`dok_Typ`, `dok_Status`, `dok_DataWyst`, `dok_MagId`, `dok_WartNetto`, `dok_WartTwNetto`, `dok_WartUsNetto`, `dok_WartBrutto`).
- Kody dok_Typ: 2 = FS, 21 = PA (bez 6 KFS i 14 ZW — te wchodzą w KPI „po korektach i zwrotach"; bez 11 WZ i 16 ZK).

```sql
-- zakres: [@od, @do) — przedział półotwarty; @mag opcjonalny (NULL = wszystkie magazyny)
SELECT
  YEAR(d.dok_DataWyst)  AS year_no,
  MONTH(d.dok_DataWyst) AS month_no,
  COUNT(*)                                            AS doc_count,
  SUM(d.dok_WartNetto)                                AS net_sales,
  SUM(d.dok_WartTwNetto)                              AS goods_net,
  SUM(d.dok_WartUsNetto)                              AS services_net,
  SUM(CASE WHEN d.dok_Typ = 2  THEN d.dok_WartNetto ELSE 0 END) AS invoices_net,
  SUM(CASE WHEN d.dok_Typ = 21 THEN d.dok_WartNetto ELSE 0 END) AS receipts_net,
  SUM(d.dok_WartBrutto)                               AS gross_sales
FROM dbo.dok__Dokument d
WHERE d.dok_Typ IN (2, 21)          -- 2 = FS (faktura sprzedaży), 21 = PA (paragon)
  AND d.dok_Status = 1              -- 1 = wykonany; wyklucza FSd (status 0, dubel paragonu) i odłożone (3)
  AND d.dok_DataWyst >= @od
  AND d.dok_DataWyst <  @do
  AND (@mag IS NULL OR d.dok_MagId = @mag)   -- magazyn opcjonalnie; NULL = wszystkie
GROUP BY YEAR(d.dok_DataWyst), MONTH(d.dok_DataWyst)
ORDER BY year_no, month_no
```

- Pułapki: (1) FSd (`dok_Podtyp = 1`) to ten sam przychód co paragon — filtr `dok_Status = 1` je wyklucza, ale gdybyś liczył bez statusu, dodaj `AND NOT (dok_Typ = 2 AND dok_Podtyp = 1)`. (2) Faktury zaliczkowe pośrednie (podtyp 3, status 0) nie wchodzą — to ok. 0,2% przychodu rocznie; jeśli chcesz je ująć w miesiącu zaliczki, dodaj `OR (d.dok_Typ = 2 AND d.dok_Podtyp = 3 AND d.dok_Status = 0)`. (3) WZ bez faktury nie są przychodem — nie sumuj `dok_Typ = 11`. (4) Kwoty są w PLN także dla faktur w EUR/CZK/HUF. (5) Korekty i zwroty (KFS/ZW) NIE są tu odjęte — to „sprzedaż brutto"; przychód netto po zwrotach jest w osobnym KPI. (6) Usługi (koszty wysyłki) są w `net_sales`; jeśli KPI ma dotyczyć samego towaru, bierz `goods_net`. (7) Od 03.2026 sprzedaż detaliczna jest dokumentowana fakturą FS zamiast paragonu PA, a zwroty korektą KFS zamiast ZW (potwierdzone przez właściciela 2026-09-28) — w porównaniach przez tę datę detal = PA + FS detaliczne, zwroty = ZW + KFS; spadek PA i ZW po 02.2026 to zmiana dokumentowania, nie sprzedaży.
- Interpretacja: bazowy szereg trendu; porównuj z tym samym miesiącem roku poprzedniego (sezonowość: grudzień ≈ 1,4× przeciętnego miesiąca, styczeń–luty ≈ 0,85×). Wzrost nominalny ≠ realny — zestaw z inflacją i mixem marek. `gross_sales` (brutto) służy tylko do uzgodnienia z kasą/fiskalizacją.
