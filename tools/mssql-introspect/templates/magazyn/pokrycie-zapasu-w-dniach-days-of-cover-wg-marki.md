---
id: pokrycie-zapasu-w-dniach-days-of-cover-wg-marki
title: Pokrycie zapasu w dniach (days of cover) wg marki
area: magazyn
order: 50
questions:
  - "Ile dni zapasu mamy dla 10 najlepiej sprzedających się marek?"
  - "Na ile dni sprzedaży wystarczy obecny zapas TK Lighting i Rabalux przy tempie z ostatnich 90 dni?"
params:
  od:
    type: date
    description: początek okna sprzedaży (włącznie) — zwykle dziś minus 90 dni
    example: 2026-06-30
  do:
    type: date
    description: koniec okna sprzedaży (wyłącznie) — zwykle jutro, żeby okno kończyło się na dziś
    example: 2026-09-28
  n:
    type: int
    description: liczba marek w rankingu (TOP N, ≥ 1); ranking wg kosztu sprzedaży netto marki w oknie
    required: false
    default: 10
    example: 10
verified: 2026-09-28
---
Definicja: na ile dni sprzedaży w tempie z okna `[@od, @do)` (zwykle ostatnie 90 dni) wystarczy obecny zapas każdej marki (grupy towarowej), z liczbą towarów na stanie bez żadnej sprzedaży w oknie — dla N marek o największym koszcie sprzedaży netto w oknie (katalog: M2 wariant ilościowy, M9 „Nadstany").

Formuła: pokrycie = zapas_szt / ((sprzedaż_szt − zwroty_szt) / liczba_dni_okna), liczba_dni_okna = DATEDIFF(day, `@od`, `@do`); sprzedaż z WZ wykonanych niepowiązanych z KFZ, zwroty z PZ powiązanych z ZW/KFS; ranking marek = Σ `ob_WartMag` WZ sprzedażowych − Σ `ob_WartMag` PZ zwrotów w oknie po WSZYSTKICH towarach marki (`brand_cost_of_sales_net`).

Tabele i kolumny: `dok_MagRuch` (mr_TowId, mr_Pozostalo, mr_Cena); `dok_Pozycja` (ob_TowId, ob_IloscMag, ob_WartMag, ob_DokMagId); `dok__Dokument` (dok_Typ, dok_Status, dok_DataWyst, dok_DoDokId); `tw__Towar` (tw_IdGrupa); `sl_GrupaTw` (grt_Id, grt_Nazwa).

Kody dok_Typ: WZ 11 (bez WZ→KFZ 5); PZ 10 z `dok_DoDokId` → ZW 14 lub KFS 6; `dok_Status = 1`.

```sql
-- okno sprzedaży: [@od, @do) — przedział półotwarty (zwykle ostatnie 90 dni); zapas = stan bieżący; @n = liczba marek (ranking wg kosztu sprzedaży netto marki w oknie)
WITH stock AS (
  SELECT mr_TowId AS tw_id, SUM(mr_Pozostalo) AS qty, SUM(mr_Pozostalo * mr_Cena) AS value_fifo
  FROM dbo.dok_MagRuch
  WHERE mr_MagId IS NOT NULL AND mr_Pozostalo > 0
  GROUP BY mr_TowId
),
sales AS (
  SELECT z.ob_TowId AS tw_id, SUM(z.ob_IloscMag) AS qty_sold, SUM(z.ob_WartMag) AS cost_sold
  FROM dbo.dok_Pozycja z
  JOIN dbo.dok__Dokument d ON d.dok_Id = z.ob_DokMagId
  LEFT JOIN dbo.dok__Dokument l ON l.dok_Id = d.dok_DoDokId
  WHERE d.dok_Typ = 11 AND d.dok_Status = 1 AND COALESCE(l.dok_Typ, 0) <> 5
    AND d.dok_DataWyst >= @od AND d.dok_DataWyst < @do
  GROUP BY z.ob_TowId
),
ret AS (
  SELECT z.ob_TowId AS tw_id, SUM(z.ob_IloscMag) AS qty_ret, SUM(z.ob_WartMag) AS cost_ret
  FROM dbo.dok_Pozycja z
  JOIN dbo.dok__Dokument d ON d.dok_Id = z.ob_DokMagId
  JOIN dbo.dok__Dokument l ON l.dok_Id = d.dok_DoDokId AND l.dok_Typ IN (6, 14)
  WHERE d.dok_Typ = 10 AND d.dok_Status = 1
    AND d.dok_DataWyst >= @od AND d.dok_DataWyst < @do
  GROUP BY z.ob_TowId
),
brand_sales AS (
  SELECT t.tw_IdGrupa AS brand_id,
         SUM(COALESCE(sa.cost_sold, 0)) - SUM(COALESCE(rt.cost_ret, 0)) AS brand_cost_of_sales_net
  FROM dbo.tw__Towar t
  LEFT JOIN sales sa ON sa.tw_id = t.tw_Id
  LEFT JOIN ret rt ON rt.tw_id = t.tw_Id
  WHERE sa.tw_id IS NOT NULL OR rt.tw_id IS NOT NULL
  GROUP BY t.tw_IdGrupa
)
SELECT TOP (@n) g.grt_Id, g.grt_Nazwa,
       MAX(COALESCE(bs.brand_cost_of_sales_net, 0)) AS brand_cost_of_sales_net,
       COUNT(*) AS sku_in_stock,
       SUM(s.qty) AS qty_stock,
       SUM(s.value_fifo) AS value_fifo,
       SUM(COALESCE(sa.qty_sold, 0)) AS qty_sold_window,
       SUM(COALESCE(rt.qty_ret, 0)) AS qty_ret_window,
       DATEDIFF(day, @od, @do) AS window_days,
       CAST(SUM(s.qty) / NULLIF((SUM(COALESCE(sa.qty_sold, 0)) - SUM(COALESCE(rt.qty_ret, 0))) / CAST(DATEDIFF(day, @od, @do) AS float), 0) AS decimal(10,1)) AS days_of_cover,
       SUM(CASE WHEN COALESCE(sa.qty_sold, 0) = 0 THEN 1 ELSE 0 END) AS sku_no_sales_window
FROM stock s
JOIN dbo.tw__Towar t ON t.tw_Id = s.tw_id
LEFT JOIN dbo.sl_GrupaTw g ON g.grt_Id = t.tw_IdGrupa
LEFT JOIN brand_sales bs ON bs.brand_id = t.tw_IdGrupa
LEFT JOIN sales sa ON sa.tw_id = s.tw_id
LEFT JOIN ret rt ON rt.tw_id = s.tw_id
GROUP BY g.grt_Id, g.grt_Nazwa
ORDER BY MAX(COALESCE(bs.brand_cost_of_sales_net, 0)) DESC
```

Pułapki: zapas to stan bieżący (bez historii), więc okno sprzedaży powinno kończyć się dziś — okno z przeszłości zestawi dzisiejszy zapas z dawnym tempem sprzedaży; `days_of_cover` i `qty_sold_window` liczą sprzedaż wyłącznie towarów, które są dziś na stanie — towary sprzedane „z ręki" (zamówione pod klienta) i wyprzedane do zera nie wchodzą ani do zapasu, ani do tempa, więc to pokrycie magazynowanego asortymentu, nie całej sprzedaży marki; ranking (`brand_cost_of_sales_net`) liczy za to całą sprzedaż marki w cenach zakupu, także towarów bez stanu — marka sprzedająca głównie pod zamówienie (np. Italux) jest wysoko w rankingu przy małym zapasie; okno 90 dni latem (czerwiec–wrzesień) to sezonowy dołek — pokrycie na jesień będzie niższe; `NULL` w `days_of_cover` = brak sprzedaży netto w oknie; `TOP (@n)` obcina długi ogon 93 marek — dla pełnej listy podaj `n` = 100; marki bez żadnego towaru na stanie nie pojawiają się w wyniku; nie mnożyć `ob_IloscMag` przez `ob_Znak` (patrz ustalenia wspólne). „Najlepiej sprzedające się” marki to tu ranking wg kosztu sprzedaży netto w cenach zakupu, nie wg przychodu — kolejność może różnić się od szablonu `top-marek-wg-wartosci-sprzedazy`.

Interpretacja (okno 2026-06-16..2026-09-14): TK Lighting 132 dni (476 z 1 006 SKU na stanie bez sprzedaży), Rabalux 148, Zuma Line 242, Azzardo 308, GLOBO i Italux ok. 70–80 dni, Markslojd i Wojnarowscy kilkaset dni (duże ilości niskocennego towaru). Marki z pokryciem powyżej 180 dni i dużym udziałem SKU bez sprzedaży to naturalny cel redukcji zamówień. Przebieg 2026-09-28 (okno 2026-06-30..2026-09-27, 90 dni, ranking wg kosztu sprzedaży): TK Lighting 117 dni, Italux 95, Rabalux 141, GLOBO 72, Zuma Line 218, Azzardo 274, SIGMA 93, SuMa 110, Nowodvorski 94, Markslojd 1 333 dni.
