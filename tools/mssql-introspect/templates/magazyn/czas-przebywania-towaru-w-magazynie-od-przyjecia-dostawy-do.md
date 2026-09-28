---
id: czas-przebywania-towaru-w-magazynie-od-przyjecia-dostawy-do
title: Czas przebywania towaru w magazynie (od przyjęcia dostawy do wydania WZ)
area: magazyn
order: 60
questions:
  - "Jak policzyć: Czas przebywania towaru w magazynie (od przyjęcia dostawy do wydania WZ)?"
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
Definicja: ile dni sztuka towaru leżała na magazynie od daty przyjęcia warstwy (PZ/PW/MM/zwrot) do daty wydania na WZ sprzedażowej, miesięcznie, ważone ilością (katalog: Z6 „Lead time" w wariancie magazynowym, M2 uzupełnienie). To jest policzalne dzięki parze rozchód → warstwa (`mr_DoId`).

Formuła: dla każdego rozchodu z WZ (bez WZ→KFZ) dni = DATEDIFF(day, warstwa.`mr_Data`, rozchód.`mr_Data`); średnia ważona = Σ(ilość × dni) / Σ ilość; udziały ilości wydanej do 30 dni i po ponad 365 dniach.

Tabele i kolumny: `dok_MagRuch` (mr_Id, mr_DoId, mr_MagId, mr_Data, mr_Ilosc, mr_PozId) — dwukrotnie (rozchód c, warstwa p); `dok_Pozycja`; `dok__Dokument` (dok_Typ, dok_DoDokId).

Kody dok_Typ: WZ 11, z wykluczeniem powiązanych z KFZ 5.

Szablon SQL:

```sql
-- zakres: [@od, @do) — przedział półotwarty
WITH pairs AS (
  SELECT c.mr_Data AS issue_date, c.mr_Ilosc AS qty,
         DATEDIFF(day, p.mr_Data, c.mr_Data) AS days_in_stock,
         CASE WHEN p.mr_DoId IS NULL THEN 0 ELSE 1 END AS layer_is_derived
  FROM dbo.dok_MagRuch c
  JOIN dbo.dok_MagRuch p ON p.mr_Id = c.mr_DoId AND p.mr_MagId IS NOT NULL
  JOIN dbo.dok_Pozycja z ON z.ob_Id = c.mr_PozId
  JOIN dbo.dok__Dokument d ON d.dok_Id = COALESCE(z.ob_DokMagId, z.ob_DokHanId)
  LEFT JOIN dbo.dok__Dokument l ON l.dok_Id = d.dok_DoDokId
  WHERE c.mr_MagId IS NULL AND c.mr_Data >= @od AND c.mr_Data < @do
    AND d.dok_Typ = 11 AND COALESCE(l.dok_Typ, 0) <> 5
)
SELECT YEAR(issue_date) AS y, MONTH(issue_date) AS m,
       COUNT(*) AS issue_rows,
       SUM(qty) AS qty_issued,
       CAST(SUM(qty * days_in_stock) / NULLIF(SUM(qty), 0) AS decimal(10,1)) AS avg_days_qty_weighted,
       CAST(AVG(CAST(days_in_stock AS float)) AS decimal(10,1)) AS avg_days_simple,
       MAX(days_in_stock) AS max_days,
       CAST(100.0 * SUM(CASE WHEN days_in_stock <= 30 THEN qty ELSE 0 END) / NULLIF(SUM(qty), 0) AS decimal(6,2)) AS pct_qty_le_30d,
       CAST(100.0 * SUM(CASE WHEN days_in_stock > 365 THEN qty ELSE 0 END) / NULLIF(SUM(qty), 0) AS decimal(6,2)) AS pct_qty_gt_365d,
       SUM(layer_is_derived) AS rows_from_transfer_or_return_layer
FROM pairs
GROUP BY YEAR(issue_date), MONTH(issue_date)
ORDER BY 1, 2
```

Pułapki: FIFO wydaje najstarszą warstwę, więc czas przebywania to czas najstarszej sztuki, nie „typowej"; warstwa pochodna (MM, zwrot) liczy od swojej daty — kolumna `rows_from_transfer_or_return_layer` pokazuje skalę (ok. 9% wierszy); dni kalendarzowe; rozkład jest silnie prawoskośny (maksima ~2 000 dni), więc średnia ważona > mediany — dla mediany użyj PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY days_in_stock) OVER (PARTITION BY miesiąc) w podzapytaniu; zwroty do dostawcy celowo wyłączone (ich czas to okres „na próbę", nie sprzedaż).

Interpretacja (2025): średnia ważona 51–93 dni (minimum maj 51,1, maksimum styczeń 93,3 — wyprzedaż poświąteczna starszego towaru); 63–74% sztuk wychodzi w ciągu 30 dni od przyjęcia (obsługa zamówień pod klienta), 3–9% leżało ponad rok. Spójne z DIO 64 dni z KPI „Rotacja".

Test: 2025-01-01..2026-01-01, 12 wierszy, wykonano 2026-09-14.
