---
id: zwroty-detaliczne-zw
title: Zwroty detaliczne (ZW)
area: sprzedaz
order: 130
questions:
  - "Jak policzyć: Zwroty detaliczne (ZW)?"
params:
  od:
    type: date
    description: początek zakresu (włącznie)
    example: 2025-01-01
  do:
    type: date
    description: koniec zakresu (wyłącznie)
    example: 2026-01-01
verified: 2026-09-14
---
- Definicja: miesięczna liczba i wartość zwrotów detalicznych do paragonów (ZW), koszt zwróconego towaru, rodzaj zwrotu i średni czas od paragonu do zwrotu, w relacji do wartości i liczby paragonów (część KPI „korekty i zwroty").
- Formuła: `returns_net = Σ dok_WartNetto (ZW)`; `wskaźnik zwrotów % = returns_net / Σ PA × 100`; `avg_days_from_receipt = AVG(dok_DataWyst ZW − dok_DataWyst paragonu)`.
- Tabele i kolumny: `dok__Dokument` (`dok_Typ`, `dok_Status`, `dok_StatusEx`, `dok_DoDokId`, `dok_DataWyst`, `dok_WartNetto`, `dok_WartMag`); paragon-matka przez `dok_DoDokId`.
- Kody dok_Typ: 14 = ZW (mianownik: 21 = PA); `dok_StatusEx` ZW: 1 zwrot ze sprzedaży, 2 reklamacja, 3 oczywista pomyłka, 0 nieokreślony.

```sql
-- zakres: [@od, @do) — przedział półotwarty
WITH pa_month AS (
  SELECT YEAR(dok_DataWyst) AS year_no, MONTH(dok_DataWyst) AS month_no, SUM(dok_WartNetto) AS receipts_net, COUNT(*) AS receipts_count
  FROM dbo.dok__Dokument
  WHERE dok_Typ = 21 AND dok_Status = 1 AND dok_DataWyst >= @od AND dok_DataWyst < @do
  GROUP BY YEAR(dok_DataWyst), MONTH(dok_DataWyst)
),
zw_month AS (
  SELECT
    YEAR(z.dok_DataWyst)  AS year_no,
    MONTH(z.dok_DataWyst) AS month_no,
    COUNT(*)              AS returns_count,
    SUM(z.dok_WartNetto)  AS returns_net,
    SUM(z.dok_WartMag)    AS returns_cost,
    SUM(CASE WHEN z.dok_StatusEx = 1 THEN 1 ELSE 0 END) AS returns_from_sale,     -- 1 = zwrot ze sprzedaży
    SUM(CASE WHEN z.dok_StatusEx = 2 THEN 1 ELSE 0 END) AS returns_complaint,     -- 2 = reklamacja
    SUM(CASE WHEN z.dok_StatusEx = 3 THEN 1 ELSE 0 END) AS returns_mistake,       -- 3 = oczywista pomyłka
    SUM(CASE WHEN z.dok_StatusEx = 0 OR z.dok_StatusEx IS NULL THEN 1 ELSE 0 END) AS returns_unspecified,
    AVG(DATEDIFF(day, pa.dok_DataWyst, z.dok_DataWyst) * 1.0)                 AS avg_days_from_receipt
  FROM dbo.dok__Dokument z
  LEFT JOIN dbo.dok__Dokument pa ON pa.dok_Id = z.dok_DoDokId
  WHERE z.dok_Typ = 14
    AND z.dok_Status = 1
    AND z.dok_DataWyst >= @od
    AND z.dok_DataWyst <  @do
  GROUP BY YEAR(z.dok_DataWyst), MONTH(z.dok_DataWyst)
)
SELECT
  p.year_no,
  p.month_no,
  COALESCE(r.returns_count, 0)   AS returns_count,
  COALESCE(r.returns_net, 0)     AS returns_net,
  COALESCE(r.returns_cost, 0)    AS returns_cost,
  p.receipts_net,
  ROUND(100.0 * COALESCE(r.returns_net, 0) / NULLIF(p.receipts_net, 0), 2)      AS returns_to_receipts_pct,
  ROUND(100.0 * COALESCE(r.returns_count, 0) / NULLIF(p.receipts_count, 0), 2)  AS returns_count_to_receipts_pct,
  r.returns_from_sale,
  r.returns_complaint,
  r.returns_mistake,
  r.returns_unspecified,
  ROUND(r.avg_days_from_receipt, 1) AS avg_days_from_receipt
FROM pa_month p
LEFT JOIN zw_month r ON r.year_no = p.year_no AND r.month_no = p.month_no
ORDER BY p.year_no, p.month_no
```

- Pułapki: (1) Wartości ZW są dodatnie — to kwota, którą trzeba ODJĄĆ od sprzedaży; w KPI „po zwrotach" idzie ze znakiem minus. (2) Zwrot jest w miesiącu zwrotu, paragon w miesiącu sprzedaży (średnio 15–20 dni wcześniej) — w styczniu wskaźnik jest zawyżony przez zwroty z grudnia; wersja „w miesiącu paragonu" = grupuj po `pa.dok_DataWyst`. (3) ZW dotyczy WYŁĄCZNIE paragonów; zwroty do faktur są korektami KFS (osobny KPI); do paragonu z FSd korekta KFS ma status 0 i jest dublem ZW — ignoruj ją. (4) Zwrot częściowy to ZW o wartości mniejszej niż paragon; `returns_count_to_receipts_pct` liczy dokumenty, nie „udział zwróconych zamówień". (5) `dok_StatusEx` w tej instancji to prawie zawsze 1 (zwrot ze sprzedaży) — rozbicie na reklamacje/pomyłki jest informacyjne. (6) Odbiór własny w sklepie kontra wysyłka nie jest rozróżnialny w nagłówku ZW.
- Interpretacja: w instancji zwroty to ok. 9,5–12% wartości i ok. 10% liczby paragonów (2025) — typowe dla e-commerce z prawem odstąpienia (14 dni), co potwierdza średni czas ok. 15–20 dni od paragonu. `returns_cost` pokazuje, ile wartości magazynowej wraca (towar do ponownej sprzedaży lub odpisu). Wzrost wskaźnika powyżej 12–13% przy stałej sprzedaży to sygnał do sprawdzenia opisów produktów, opakowań i przewoźnika.
