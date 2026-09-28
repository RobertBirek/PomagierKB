---
id: dynamika-yoy-miesieczna
title: Dynamika YoY miesięczna
area: sprzedaz
order: 30
questions:
  - "Ile wyniósł przychód netto we wrześniu 2026 i jak wypada względem września 2025?"
  - "Które miesiące 2025 roku były lepsze, a które gorsze niż rok wcześniej?"
params:
  od:
    type: date
    description: początek okresu analizowanego (włącznie)
    example: 2025-01-01
  do:
    type: date
    description: koniec okresu analizowanego (wyłącznie)
    example: 2026-01-01
  od_prev:
    type: date
    description: początek okresu porównawczego — ta sama data rok wcześniej niż od (włącznie)
    example: 2024-01-01
  do_prev:
    type: date
    description: koniec okresu porównawczego — ta sama data rok wcześniej niż do (wyłącznie)
    example: 2025-01-01
verified: 2026-09-28
---
- Definicja: przychód netto miesiąca w porównaniu do tego samego miesiąca roku poprzedniego (F2/S10 — wariant miesięczny odporny na sezonowość).
- Formuła: `YoY %(M) = (Przychód(M, R) − Przychód(M, R−1)) / Przychód(M, R−1) × 100`.
- Tabele i kolumny: `dok__Dokument` (`dok_Typ`, `dok_Status`, `dok_DataWyst`, `dok_WartNetto`); dwa CTE miesięczne (okres analizowany i porównawczy) łączone po `year_no − 1` i numerze miesiąca.
- Kody dok_Typ: 2 = FS, 21 = PA.

```sql
-- okres analizowany: [@od, @do); okres porównawczy: [@od_prev, @do_prev) — ten sam zakres rok wcześniej
WITH cur AS (
  SELECT
    YEAR(d.dok_DataWyst)  AS year_no,
    MONTH(d.dok_DataWyst) AS month_no,
    SUM(d.dok_WartNetto)  AS net_sales,
    COUNT(*)              AS doc_count
  FROM dbo.dok__Dokument d
  WHERE d.dok_Typ IN (2, 21)
    AND d.dok_Status = 1
    AND d.dok_DataWyst >= @od
    AND d.dok_DataWyst <  @do
  GROUP BY YEAR(d.dok_DataWyst), MONTH(d.dok_DataWyst)
),
prev AS (
  SELECT
    YEAR(d.dok_DataWyst)  AS year_no,
    MONTH(d.dok_DataWyst) AS month_no,
    SUM(d.dok_WartNetto)  AS net_sales,
    COUNT(*)              AS doc_count
  FROM dbo.dok__Dokument d
  WHERE d.dok_Typ IN (2, 21)
    AND d.dok_Status = 1
    AND d.dok_DataWyst >= @od_prev
    AND d.dok_DataWyst <  @do_prev
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
FROM cur
LEFT JOIN prev
  ON prev.year_no = cur.year_no - 1 AND prev.month_no = cur.month_no
ORDER BY cur.year_no, cur.month_no
```

- Pułapki: (1) Okres porównawczy `[@od_prev, @do_prev)` podawaj jako ten sam zakres przesunięty dokładnie o rok (np. `[2026-09-01, 2026-10-01)` vs `[2025-09-01, 2025-10-01)`) — miesiące łączą się po roku−1 i numerze miesiąca, więc inny okres da NULL w kolumnach `_prev_year`. (2) Liczba dni roboczych i ruchome święta (Wielkanoc) przesuwają sprzedaż między marcem i kwietniem — patrz też `doc_count`. (3) Miesiąc bieżący (niepełny) zawsze wypadnie ujemnie — do porównania niepełnego miesiąca ustaw `do` na dziś, a `do_prev` na tę samą datę rok wcześniej (ten sam fragment miesiąca). (4) Bez korekt i zwrotów.
- Interpretacja: seria 12 wartości YoY pokazuje, czy wzrost jest równomierny, czy skoncentrowany w kilku miesiącach (np. promocje). Rosnący `doc_count` przy płaskim `net_sales` = spadek średniej wartości dokumentu.
