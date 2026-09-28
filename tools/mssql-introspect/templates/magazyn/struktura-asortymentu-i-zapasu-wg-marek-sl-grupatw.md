---
id: struktura-asortymentu-i-zapasu-wg-marek-sl-grupatw
title: Struktura asortymentu i zapasu wg marek (sl_GrupaTw)
area: magazyn
order: 110
questions:
  - "Jak policzyć: Struktura asortymentu i zapasu wg marek (sl_GrupaTw)?"
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
Definicja: dla każdej marki (grupa towarowa = marka na tej instancji) liczność kartoteki, aktywnych, w e-sklepie, na stanie, wartość zapasu i jej udział, koszt sprzedaży w okresie i „rotacja na bieżącym zapasie" — Top 30 wg wartości zapasu (katalog: M4 „Struktura wartości magazynu", Z2 „Zakupy wg grup", raport 11.5.1).

Formuła: udział = FIFO marki / FIFO ogółem; rotacja na bieżącym zapasie = Σ `ob_WartMag` WZ sprzedażowych w okresie / FIFO marki dziś (przybliżenie rotacji bez rekonstrukcji historycznej).

Tabele i kolumny: `tw__Towar` (tw_IdGrupa, tw_Zablokowany, tw_SklepInternet); `sl_GrupaTw` (grt_Id, grt_Nazwa); `dok_MagRuch`; `dok_Pozycja` (ob_TowId, ob_IloscMag, ob_WartMag, ob_DokMagId); `dok__Dokument` (dok_Typ, dok_Status, dok_DataWyst, dok_DoDokId).

Kody dok_Typ: WZ 11 (bez WZ→KFZ 5), `dok_Status = 1`.

```sql
-- zakres: [@od, @do) — przedział półotwarty
WITH stock AS (
  SELECT mr_TowId AS tw_id, SUM(mr_Pozostalo) AS qty, SUM(mr_Pozostalo * mr_Cena) AS value_fifo
  FROM dbo.dok_MagRuch
  WHERE mr_MagId IS NOT NULL AND mr_Pozostalo > 0
  GROUP BY mr_TowId
),
sold AS (
  SELECT z.ob_TowId AS tw_id, SUM(z.ob_IloscMag) AS qty_sold, SUM(z.ob_WartMag) AS cost_sold
  FROM dbo.dok_Pozycja z
  JOIN dbo.dok__Dokument d ON d.dok_Id = z.ob_DokMagId
  LEFT JOIN dbo.dok__Dokument l ON l.dok_Id = d.dok_DoDokId
  WHERE d.dok_Typ = 11 AND d.dok_Status = 1 AND COALESCE(l.dok_Typ, 0) <> 5
    AND d.dok_DataWyst >= @od AND d.dok_DataWyst < @do
  GROUP BY z.ob_TowId
)
SELECT TOP 30 g.grt_Id, g.grt_Nazwa,
       COUNT(*) AS sku_cnt,
       SUM(CASE WHEN t.tw_Zablokowany = 0 THEN 1 ELSE 0 END) AS sku_active,
       SUM(CASE WHEN t.tw_SklepInternet = 1 THEN 1 ELSE 0 END) AS sku_eshop,
       SUM(CASE WHEN s.qty > 0 THEN 1 ELSE 0 END) AS sku_in_stock,
       SUM(COALESCE(s.qty, 0)) AS qty_stock,
       SUM(COALESCE(s.value_fifo, 0)) AS value_fifo,
       CAST(100.0 * SUM(COALESCE(s.value_fifo, 0)) / NULLIF(SUM(SUM(COALESCE(s.value_fifo, 0))) OVER (), 0) AS decimal(6,2)) AS value_share_pct,
       SUM(COALESCE(so.qty_sold, 0)) AS qty_sold_period,
       SUM(COALESCE(so.cost_sold, 0)) AS cost_sold_period,
       CAST(SUM(COALESCE(so.cost_sold, 0)) / NULLIF(SUM(COALESCE(s.value_fifo, 0)), 0) AS decimal(10,2)) AS turnover_on_current_stock
FROM dbo.tw__Towar t
LEFT JOIN dbo.sl_GrupaTw g ON g.grt_Id = t.tw_IdGrupa
LEFT JOIN stock s ON s.tw_id = t.tw_Id
LEFT JOIN sold so ON so.tw_id = t.tw_Id
WHERE t.tw_Usuniety = 0
GROUP BY g.grt_Id, g.grt_Nazwa
ORDER BY SUM(COALESCE(s.value_fifo, 0)) DESC
```

Pułapki: grupa to jedna marka na towar — towary bez grupy trafiają do wiersza z `grt_Id NULL` (grupa 1 „Podstawowa" to domyślna); rotacja liczona na zapasie „dziś" przy koszcie z innego okresu — porównawcza, nie księgowa (marki, które właśnie dostały dużą dostawę, mają zaniżoną); `cost_sold_period` obejmuje towar sprzedany bez magazynowania; udział procentowy liczony nad wszystkimi 93 markami (okno OVER działa przed TOP).

Interpretacja (zapas 2026-09-14, koszt 2025): TK Lighting 16,9% wartości zapasu (294 tys. zł), Zuma Line 16,2%, Rabalux 13,1%, Azzardo 11,6%, Markslojd 9,8% — pięć marek to 67% zapasu; rotacja na bieżącym zapasie: Italux 21,9 i GLOBO 8,8 (sprzedawane głównie pod zamówienie), TK Lighting 4,6, Rabalux 3,6, Zuma 3,3, Markslojd 1,4, Paul Neuhaus 1,1 (droższy zapas, wolny obrót). Markslojd ma tylko 539 z 2 957 SKU w e-sklepie, a 9,8% wartości zapasu — sprawdź ekspozycję online.
