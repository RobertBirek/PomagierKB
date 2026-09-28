---
id: udzial-towarow-w-e-sklepie-tw-sklepinternet
title: Udział towarów w e-sklepie (tw_SklepInternet)
area: magazyn
order: 120
questions:
  - "Jaka część towarów i wartości zapasu jest oznaczona do sklepu internetowego?"
  - "Ile towarów bez flagi e-sklepu sprzedaliśmy w 2025 roku?"
params:
  od:
    type: date
    description: początek zakresu (włącznie)
    example: 2025-01-01
  do:
    type: date
    description: koniec zakresu (wyłącznie)
    example: 2026-01-01
verified: 2026-09-28
---
Definicja: jaka część towarów (kartoteka, zapas, sprzedaż) ma flagę „przeznaczony do sklepu internetowego", w rozbiciu na aktywne i zablokowane, z flagami serwisu aukcyjnego i sprzedaży mobilnej (katalog: 6.7, raport spójności kanałów).

Formuła: udziały liczności i wartości FIFO w grupach (tw_SklepInternet × tw_Zablokowany); liczba SKU sprzedanych w okresie.

Tabele i kolumny: `tw__Towar` (tw_SklepInternet, tw_Zablokowany, tw_SerwisAukcyjny, tw_SprzedazMobilna, tw_Rodzaj); `dok_MagRuch`; `dok_Pozycja`; `dok__Dokument`.

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
  SELECT z.ob_TowId AS tw_id, SUM(z.ob_IloscMag) AS qty_sold
  FROM dbo.dok_Pozycja z
  JOIN dbo.dok__Dokument d ON d.dok_Id = z.ob_DokMagId
  LEFT JOIN dbo.dok__Dokument l ON l.dok_Id = d.dok_DoDokId
  WHERE d.dok_Typ = 11 AND d.dok_Status = 1 AND COALESCE(l.dok_Typ, 0) <> 5
    AND d.dok_DataWyst >= @od AND d.dok_DataWyst < @do
  GROUP BY z.ob_TowId
)
SELECT t.tw_SklepInternet, t.tw_Zablokowany,
       COUNT(*) AS sku_cnt,
       CAST(100.0 * COUNT(*) / SUM(COUNT(*)) OVER () AS decimal(6,2)) AS sku_share_pct,
       SUM(CASE WHEN s.qty > 0 THEN 1 ELSE 0 END) AS sku_in_stock,
       SUM(COALESCE(s.qty, 0)) AS qty_stock,
       SUM(COALESCE(s.value_fifo, 0)) AS value_fifo,
       CAST(100.0 * SUM(COALESCE(s.value_fifo, 0)) / NULLIF(SUM(SUM(COALESCE(s.value_fifo, 0))) OVER (), 0) AS decimal(6,2)) AS value_share_pct,
       SUM(CASE WHEN COALESCE(so.qty_sold, 0) > 0 THEN 1 ELSE 0 END) AS sku_sold_period,
       SUM(COALESCE(so.qty_sold, 0)) AS qty_sold_period,
       SUM(CASE WHEN t.tw_SerwisAukcyjny = 1 THEN 1 ELSE 0 END) AS sku_auction_flag,
       SUM(CASE WHEN t.tw_SprzedazMobilna = 1 THEN 1 ELSE 0 END) AS sku_mobile_flag
FROM dbo.tw__Towar t
LEFT JOIN stock s ON s.tw_id = t.tw_Id
LEFT JOIN sold so ON so.tw_id = t.tw_Id
WHERE t.tw_Usuniety = 0 AND t.tw_Rodzaj = 1
GROUP BY t.tw_SklepInternet, t.tw_Zablokowany
ORDER BY t.tw_SklepInternet, t.tw_Zablokowany
```

Pułapki: flagi kartoteki i zapas to stan bieżący (bez historii) — tylko sprzedaż zależy od `[@od, @do)`, więc flagi dzisiejsze zestawiane są ze sprzedażą z okresu; flaga `tw_SklepInternet` jest flagą Subiekta (dla Vendero/Sello, nieużywanych na instancji) — to, czy towar faktycznie jest w sklepie, decyduje integrator (`sublinker_*`); flaga nie mówi, w którym sklepie/marketplace (to kategorie dokumentów, `sl_Kategoria`); sprzedaż „bez flagi" może pochodzić ze sprzedaży stacjonarnej (terminale Sanok/Krosno) albo z towaru dodanego do e-sklepu po sprzedaży; `tw_SprzedazMobilna` pokrywa się z flagą e-sklepu (21 848 vs 21 851) — prawdopodobnie ustawiane razem przez integrator.

Interpretacja (2026-09-14, sprzedaż 2025): flagę e-sklepu ma 21 851 aktywnych SKU (27,4% kartoteki), ale skupiają 82,7% wartości zapasu (1,44 mln zł) i 4 342 z 5 682 SKU na stanie; 49 951 aktywnych bez flagi (62,7%) to w większości pozycje historyczne — 1 340 na stanie (303 tys. zł), a 4 992 z nich sprzedano w 2025 (30 tys. szt.) — wart sprawdzenia kanał tej sprzedaży; 540 zablokowanych z flagą sprzedano w 2025, czyli blokada nastąpiła po sprzedaży. Serwis aukcyjny: 4 346 SKU (podzbiór e-sklepu).
