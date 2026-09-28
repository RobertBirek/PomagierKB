---
id: dynamika-yoy-miesieczna
title: Dynamika YoY miesięczna
area: sprzedaz
order: 30
questions:
  - "Jak policzyć: Dynamika YoY miesięczna?"
params:
  od:
    type: date
    description: początek zakresu (włącznie)
    example: 2024-01-01
  do:
    type: date
    description: koniec zakresu (wyłącznie)
    example: 2026-01-01
verified: 2026-09-14
---
- Definicja: przychód netto miesiąca w porównaniu do tego samego miesiąca roku poprzedniego (F2/S10 — wariant miesięczny odporny na sezonowość).
- Formuła: `YoY %(M) = (Przychód(M, R) − Przychód(M, R−1)) / Przychód(M, R−1) × 100`.
- Tabele i kolumny: `dok__Dokument` (`dok_Typ`, `dok_Status`, `dok_DataWyst`, `dok_WartNetto`); CTE miesięczne łączone samo ze sobą po `year_no − 1`.
- Kody dok_Typ: 2 = FS, 21 = PA.

```sql
-- zakres: [@od, @do) — przedział półotwarty
WITH monthly AS (
  SELECT
    YEAR(d.dok_DataWyst)  AS year_no,
    MONTH(d.dok_DataWyst) AS month_no,
    SUM(d.dok_WartNetto)  AS net_sales,
    COUNT(*)              AS doc_count
  FROM dbo.dok__Dokument d
  WHERE d.dok_Typ IN (2, 21)
    AND d.dok_Status = 1
    AND d.dok_DataWyst >= @od   -- rok odniesienia
    AND d.dok_DataWyst <  @do
  GROUP BY YEAR(d.dok_DataWyst), MONTH(d.dok_DataWyst)
)
SELECT
  cur.year_no,
  cur.month_no,
  cur.net_sales,
  prev.net_sales                                    AS net_sales_prev_year,
  cur.net_sales - prev.net_sales                    AS yoy_delta,
  ROUND(100.0 * (cur.net_sales - prev.net_sales) / NULLIF(prev.net_sales, 0), 2) AS yoy_pct,
  cur.doc_count,
  prev.doc_count                                    AS doc_count_prev_year
FROM monthly cur
LEFT JOIN monthly prev
  ON prev.year_no = cur.year_no - 1 AND prev.month_no = cur.month_no
WHERE cur.year_no = 2025
ORDER BY cur.year_no, cur.month_no
```

- Pułapki: (1) Zmieniając rok analizowany, zmień trzy miejsca: początek zakresu (rok−1), koniec zakresu (rok+1) i `WHERE cur.year_no = rok`. (2) Liczba dni roboczych i ruchome święta (Wielkanoc) przesuwają sprzedaż między marcem i kwietniem — patrz też `doc_count`. (3) Miesiąc bieżący (niepełny) zawsze wypadnie ujemnie. (4) Bez korekt i zwrotów.
- Interpretacja: seria 12 wartości YoY pokazuje, czy wzrost jest równomierny, czy skoncentrowany w kilku miesiącach (np. promocje). Rosnący `doc_count` przy płaskim `net_sales` = spadek średniej wartości dokumentu.
