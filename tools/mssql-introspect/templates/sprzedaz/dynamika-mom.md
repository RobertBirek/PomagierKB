---
id: dynamika-mom
title: Dynamika MoM
area: sprzedaz
order: 40
questions:
  - "Jak zmieniała się sprzedaż netto miesiąc do miesiąca w ostatnim roku?"
  - "Czy sierpień 2026 był lepszy od lipca i jaki jest trend z 3 miesięcy?"
params:
  od:
    type: date
    description: początek zakresu (włącznie)
    example: 2025-08-01
  do:
    type: date
    description: koniec zakresu (wyłącznie)
    example: 2026-09-01
verified: 2026-09-28
---
- Definicja: zmiana przychodu netto miesiąca względem miesiąca poprzedniego oraz średnia krocząca 3-miesięczna (F3 „Dynamika MoM", S9 „Trend — moving average").
- Formuła: `MoM % = (Przychód(M) − Przychód(M−1)) / Przychód(M−1) × 100`; `avg_3m = średnia z M, M−1, M−2`.
- Tabele i kolumny: `dok__Dokument` (`dok_Typ`, `dok_Status`, `dok_DataWyst`, `dok_WartNetto`); `DATEFROMPARTS` do klucza miesiąca, `LAG()` i `AVG() OVER (ROWS 2 PRECEDING)`.
- Kody dok_Typ: 2 = FS, 21 = PA.

```sql
-- zakres: [@od, @do) — przedział półotwarty
WITH monthly AS (
  SELECT
    DATEFROMPARTS(YEAR(d.dok_DataWyst), MONTH(d.dok_DataWyst), 1) AS month_start,
    SUM(d.dok_WartNetto) AS net_sales,
    COUNT(*)             AS doc_count
  FROM dbo.dok__Dokument d
  WHERE d.dok_Typ IN (2, 21)
    AND d.dok_Status = 1
    AND d.dok_DataWyst >= @od
    AND d.dok_DataWyst <  @do
  GROUP BY DATEFROMPARTS(YEAR(d.dok_DataWyst), MONTH(d.dok_DataWyst), 1)
)
SELECT
  month_start,
  net_sales,
  LAG(net_sales) OVER (ORDER BY month_start)                         AS net_sales_prev_month,
  net_sales - LAG(net_sales) OVER (ORDER BY month_start)             AS mom_delta,
  ROUND(100.0 * (net_sales - LAG(net_sales) OVER (ORDER BY month_start))
        / NULLIF(LAG(net_sales) OVER (ORDER BY month_start), 0), 2)  AS mom_pct,
  AVG(net_sales) OVER (ORDER BY month_start ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS avg_3m,
  doc_count
FROM monthly
ORDER BY month_start
```

- Pułapki: (1) Pierwszy miesiąc zakresu ma NULL w MoM (brak poprzednika) — zaczynaj zakres miesiąc wcześniej niż potrzebujesz. (2) Nigdy nie kończ zakresu w środku miesiąca — bieżący miesiąc zawsze wygląda jak załamanie. (3) Wahania m/m są głównie sezonowe (spadek w styczniu po grudniu jest normalny) — interpretuj razem z YoY. (4) `avg_3m` dla dwóch pierwszych wierszy liczy się z mniejszej liczby miesięcy.
- Interpretacja: MoM pokazuje impuls (promocja, awaria sklepu, zmiana cennika); trend czytaj z `avg_3m`, a ocenę „lepiej/gorzej" z YoY.
