---
id: przychod-netto-ze-sprzedazy-rocznie-z-dynamika-yoy
title: Przychód netto ze sprzedaży — rocznie z dynamiką YoY
area: sprzedaz
order: 20
questions:
  - "O ile procent wzrosła sprzedaż netto w 2025 roku względem 2024?"
  - "Jak rósł przychód netto rok do roku w ostatnich latach?"
params:
  od:
    type: date
    description: początek zakresu (włącznie)
    example: 2016-01-01
  do:
    type: date
    description: koniec zakresu (wyłącznie)
    example: 2026-01-01
verified: 2026-09-28
---
- Definicja: roczna suma wartości netto FS+PA z porównaniem do roku poprzedniego (F2 „Dynamika przychodu YoY").
- Formuła: `YoY % = (Przychód_rok − Przychód_rok−1) / Przychód_rok−1 × 100`; przychód jak w KPI miesięcznym.
- Tabele i kolumny: `dok__Dokument` (`dok_Typ`, `dok_Status`, `dok_DataWyst`, `dok_WartNetto`); okno `LAG()` po roku.
- Kody dok_Typ: 2 = FS, 21 = PA.

```sql
-- zakres: [@od, @do) — przedział półotwarty
WITH yearly AS (
  SELECT
    YEAR(d.dok_DataWyst) AS year_no,
    COUNT(*)             AS doc_count,
    SUM(d.dok_WartNetto) AS net_sales
  FROM dbo.dok__Dokument d
  WHERE d.dok_Typ IN (2, 21)
    AND d.dok_Status = 1
    AND d.dok_DataWyst >= @od
    AND d.dok_DataWyst <  @do
  GROUP BY YEAR(d.dok_DataWyst)
)
SELECT
  year_no,
  doc_count,
  net_sales,
  LAG(net_sales) OVER (ORDER BY year_no)                        AS net_sales_prev_year,
  net_sales - LAG(net_sales) OVER (ORDER BY year_no)            AS yoy_delta,
  ROUND(100.0 * (net_sales - LAG(net_sales) OVER (ORDER BY year_no))
        / NULLIF(LAG(net_sales) OVER (ORDER BY year_no), 0), 2) AS yoy_pct
FROM yearly
ORDER BY year_no
```

- Pułapki: (1) Bieżący, niepełny rok (2026) da fałszywy spadek — zakres kończ na ostatnim pełnym roku albo porównuj YTD do YTD (dodaj warunek `MONTH(dok_DataWyst) <= N` w obu latach). (2) Rok 2015 zaczyna się w sierpniu (pierwszy dokument 2015-08-24), a 2016 to rozruch (638 dokumentów) — dynamika z tych lat nie jest reprezentatywna. (3) `LAG` zwraca NULL, gdy brakuje roku poprzedniego w zakresie — nie interpretuj NULL jako 0. (4) Wartości bez korekt i zwrotów; przy dużym udziale ZW (tu ok. 10% paragonów) policz dynamikę także na przychodzie po zwrotach.
- Interpretacja: > 5% nominalnie w MŚP = wzrost; < 0 wymaga wyjaśnienia (kanał, marka, sezon). W instancji: 2025 vs 2024 = +21,4%.
