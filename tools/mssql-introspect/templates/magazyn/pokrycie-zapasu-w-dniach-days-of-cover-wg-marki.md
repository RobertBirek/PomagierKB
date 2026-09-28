---
id: pokrycie-zapasu-w-dniach-days-of-cover-wg-marki
title: Pokrycie zapasu w dniach (days of cover) wg marki
area: magazyn
order: 50
questions:
  - "Jak policzyć: Pokrycie zapasu w dniach (days of cover) wg marki?"
params:
  od:
    type: date
    description: początek zakresu (włącznie)
    example: 2026-06-16
  do:
    type: date
    description: koniec zakresu (wyłącznie)
    example: 2026-09-15
verified: 2026-09-14
---
Definicja: na ile dni sprzedaży w tempie z ostatnich 90 dni wystarczy obecny zapas każdej marki (grupy towarowej), z liczbą towarów na stanie bez żadnej sprzedaży w oknie (katalog: M2 wariant ilościowy, M9 „Nadstany").

Formuła: pokrycie = zapas_szt / ((sprzedaż_szt − zwroty_szt) / liczba_dni_okna); sprzedaż z WZ wykonanych niepowiązanych z KFZ, zwroty z PZ powiązanych z ZW/KFS.

Tabele i kolumny: `dok_MagRuch` (mr_TowId, mr_Pozostalo, mr_Cena); `dok_Pozycja` (ob_TowId, ob_IloscMag, ob_DokMagId); `dok__Dokument` (dok_Typ, dok_Status, dok_DataWyst, dok_DoDokId); `tw__Towar` (tw_IdGrupa); `sl_GrupaTw` (grt_Id, grt_Nazwa).

Kody dok_Typ: WZ 11 (bez WZ→KFZ 5); PZ 10 z `dok_DoDokId` → ZW 14 lub KFS 6; `dok_Status = 1`.

Szablon SQL:

```sql
-- zakres: [@od, @do) — przedział półotwarty
WITH stock AS (
  SELECT mr_TowId AS tw_id, SUM(mr_Pozostalo) AS qty, SUM(mr_Pozostalo * mr_Cena) AS value_fifo
  FROM dbo.dok_MagRuch
  WHERE mr_MagId IS NOT NULL AND mr_Pozostalo > 0
  GROUP BY mr_TowId
),
sales AS (
  SELECT z.ob_TowId AS tw_id, SUM(z.ob_IloscMag) AS qty_sold
  FROM dbo.dok_Pozycja z
  JOIN dbo.dok__Dokument d ON d.dok_Id = z.ob_DokMagId
  LEFT JOIN dbo.dok__Dokument l ON l.dok_Id = d.dok_DoDokId
  WHERE d.dok_Typ = 11 AND d.dok_Status = 1 AND COALESCE(l.dok_Typ, 0) <> 5
    AND d.dok_DataWyst >= @od AND d.dok_DataWyst < @do
  GROUP BY z.ob_TowId
),
ret AS (
  SELECT z.ob_TowId AS tw_id, SUM(z.ob_IloscMag) AS qty_ret
  FROM dbo.dok_Pozycja z
  JOIN dbo.dok__Dokument d ON d.dok_Id = z.ob_DokMagId
  JOIN dbo.dok__Dokument l ON l.dok_Id = d.dok_DoDokId AND l.dok_Typ IN (6, 14)
  WHERE d.dok_Typ = 10 AND d.dok_Status = 1
    AND d.dok_DataWyst >= @od AND d.dok_DataWyst < @do
  GROUP BY z.ob_TowId
)
SELECT TOP 30 g.grt_Id, g.grt_Nazwa,
       COUNT(*) AS sku_in_stock,
       SUM(s.qty) AS qty_stock,
       SUM(s.value_fifo) AS value_fifo,
       SUM(COALESCE(sa.qty_sold, 0)) AS qty_sold_90d,
       SUM(COALESCE(rt.qty_ret, 0)) AS qty_ret_90d,
       CAST(SUM(s.qty) / NULLIF((SUM(COALESCE(sa.qty_sold, 0)) - SUM(COALESCE(rt.qty_ret, 0))) / 90.0, 0) AS decimal(10,1)) AS days_of_cover,
       SUM(CASE WHEN COALESCE(sa.qty_sold, 0) = 0 THEN 1 ELSE 0 END) AS sku_no_sales_90d
FROM stock s
JOIN dbo.tw__Towar t ON t.tw_Id = s.tw_id
LEFT JOIN dbo.sl_GrupaTw g ON g.grt_Id = t.tw_IdGrupa
LEFT JOIN sales sa ON sa.tw_id = s.tw_id
LEFT JOIN ret rt ON rt.tw_id = s.tw_id
GROUP BY g.grt_Id, g.grt_Nazwa
ORDER BY value_fifo DESC
```

Pułapki: sprzedaż obejmuje towary sprzedane „z ręki" (zamówione pod klienta), których na stanie nigdy nie było — pokrycie na poziomie marki jest zaniżone względem pokrycia realnie magazynowanych SKU; okno 90 dni latem (czerwiec–wrzesień) to sezonowy dołek — pokrycie na jesień będzie niższe; `NULL` w `days_of_cover` = brak sprzedaży netto w oknie; TOP 30 obcina długi ogon 93 marek — zdejmij TOP, gdy potrzebna pełna lista; nie mnożyć `ob_IloscMag` przez `ob_Znak` (patrz ustalenia wspólne).

Interpretacja (okno 2026-06-16..2026-09-14): TK Lighting 132 dni (476 z 1 006 SKU na stanie bez sprzedaży), Rabalux 148, Zuma Line 242, Azzardo 308, GLOBO i Italux ok. 70–80 dni, Markslojd i Wojnarowscy kilkaset dni (duże ilości niskocennego towaru). Marki z pokryciem powyżej 180 dni i dużym udziałem SKU bez sprzedaży to naturalny cel redukcji zamówień.

Test: 2026-06-16..2026-09-15, 30 wierszy, wykonano 2026-09-14.
