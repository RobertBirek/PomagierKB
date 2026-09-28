---
id: sezonowosc-sprzedazy
title: Sezonowość sprzedaży
area: sprzedaz
order: 110
questions:
  - "Które miesiące są dla nas najmocniejsze, a które najsłabsze w roku?"
  - "Jaki procent rocznej sprzedaży przypada na grudzień?"
params:
  od:
    type: date
    description: początek zakresu (włącznie)
    example: 2023-01-01
  do:
    type: date
    description: koniec zakresu (wyłącznie)
    example: 2026-01-01
verified: 2026-09-28
---
- Definicja: indeks sezonowości każdego miesiąca kalendarzowego = przychód miesiąca / przeciętny miesiąc danego roku, uśredniony z kilku pełnych lat (S8 „Analiza sezonowości").
- Formuła: `indeks(M, R) = Przychód(M, R) / AVG_M Przychód(·, R)`; `indeks(M) = AVG_R indeks(M, R)`; `udział roku % = indeks(M) / 12 × 100`.
- Tabele i kolumny: `dok__Dokument` (`dok_Typ`, `dok_Status`, `dok_DataWyst`, `dok_WartNetto`); `AVG() OVER (PARTITION BY year_no)`.
- Kody dok_Typ: 2 = FS, 21 = PA.

```sql
-- zakres: [@od, @do) — przedział półotwarty
WITH monthly AS (
  SELECT
    YEAR(d.dok_DataWyst)  AS year_no,
    MONTH(d.dok_DataWyst) AS month_no,
    SUM(d.dok_WartNetto)  AS net_sales
  FROM dbo.dok__Dokument d
  WHERE d.dok_Typ IN (2, 21)
    AND d.dok_Status = 1
    AND d.dok_DataWyst >= @od
    AND d.dok_DataWyst <  @do
  GROUP BY YEAR(d.dok_DataWyst), MONTH(d.dok_DataWyst)
),
indexed AS (
  SELECT
    year_no,
    month_no,
    net_sales,
    net_sales / NULLIF(AVG(net_sales) OVER (PARTITION BY year_no), 0) AS season_index_year   -- 1,00 = przeciętny miesiąc danego roku
  FROM monthly
)
SELECT
  month_no,
  COUNT(*)                              AS years_count,
  ROUND(AVG(net_sales), 2)              AS avg_month_net_sales,
  ROUND(AVG(season_index_year), 3)      AS season_index,
  ROUND(MIN(season_index_year), 3)      AS season_index_min,
  ROUND(MAX(season_index_year), 3)      AS season_index_max,
  ROUND(100.0 * AVG(season_index_year) / 12.0, 2) AS avg_share_of_year_pct
FROM indexed
GROUP BY month_no
ORDER BY month_no
```

- Pułapki: (1) Zakres MUSI obejmować całe lata kalendarzowe — niepełny rok zaburza średnią roczną (mianownik). (2) Minimum 2, lepiej 3–5 lat; pojedynczy rok z anomalią (np. 2020) zniekształca indeks — patrz rozstęp `season_index_min`/`max`. (3) Indeks liczony w ramach roku neutralizuje trend wzrostowy (każdy rok ma własny mianownik) — dlatego nie licz go z surowej średniej wieloletniej. (4) Bez korekt i zwrotów; zwroty mają własną sezonowość (szczyt w styczniu po grudniu). (5) Kalendarz: liczba dni handlowych i ruchome święta różnią się między latach.
- Interpretacja: w instancji grudzień ≈ 1,38 (ok. 11,5% rocznej sprzedaży), styczeń ≈ 0,86; to podstawa do planowania zakupów (lead time dostawców przed IV kwartałem) i do oczyszczania YoY/MoM z sezonu (dynamika odsezonowana = surowa / indeks).
