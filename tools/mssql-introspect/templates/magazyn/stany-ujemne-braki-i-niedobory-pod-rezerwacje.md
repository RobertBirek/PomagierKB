---
id: stany-ujemne-braki-i-niedobory-pod-rezerwacje
title: Stany ujemne, braki i niedobory pod rezerwacje
area: magazyn
order: 80
questions:
  - "Czy mamy gdzieś ujemne stany magazynowe?"
  - "Ilu sztuk brakuje na magazynie, żeby pokryć rezerwacje z zamówień klientów?"
  - "Ile towarów sprzedanych w ostatnich 30 dniach nie ma teraz na stanie?"
params:
  dni:
    type: int
    description: okno sprzedaży w dniach wstecz od dziś (≥ 1) dla licznika „brak z obrotem"
    required: false
    default: 30
    example: 30
verified: 2026-09-28
---
Definicja: per magazyn — liczba towarów ze stanem ujemnym, z rezerwacją (ZK) przekraczającą stan, z rezerwacjami do pokrycia, towary bez stanu sprzedane w ostatnich `@dni` dniach („brak z obrotem", domyślnie 30) oraz towary poniżej minimum / powyżej maksimum (katalog: M8 „Stockout rate", M9 „Nadstany", M10 „Min/Max", alerty 9).

Formuła: liczniki warunkowe po `tw_Stan` łączonym z kartoteką i sprzedażą z WZ z ostatnich `@dni` dni per magazyn.

Tabele i kolumny: `tw_Stan` (st_Stan, st_StanRez, st_StanMin); `tw__Towar` (tw_StanMin, tw_StanMaks, tw_Rodzaj); `dok_Pozycja` (ob_TowId, ob_IloscMag, ob_DokMagId); `dok__Dokument` (dok_Typ, dok_Status, dok_MagId, dok_DataWyst, dok_DoDokId); `sl_Magazyn`.

Kody dok_Typ: WZ 11 (bez WZ→KFZ 5), `dok_Status = 1`.

```sql
-- stan bieżący (tw_Stan); okno sprzedaży: ostatnie @dni dni do chwili wykonania (od dnia GETDATE() − @dni włącznie)
WITH sold AS (
  SELECT z.ob_TowId AS tw_id, d.dok_MagId AS mag_id, SUM(z.ob_IloscMag) AS qty_sold
  FROM dbo.dok_Pozycja z
  JOIN dbo.dok__Dokument d ON d.dok_Id = z.ob_DokMagId
  LEFT JOIN dbo.dok__Dokument l ON l.dok_Id = d.dok_DoDokId
  WHERE d.dok_Typ = 11 AND d.dok_Status = 1 AND COALESCE(l.dok_Typ, 0) <> 5
    AND d.dok_DataWyst >= DATEADD(day, -@dni, CAST(GETDATE() AS date))
  GROUP BY z.ob_TowId, d.dok_MagId
)
SELECT m.mag_Id, m.mag_Symbol,
       SUM(CASE WHEN s.st_Stan < 0 THEN 1 ELSE 0 END) AS negative_sku,
       SUM(CASE WHEN s.st_Stan < 0 THEN s.st_Stan ELSE 0 END) AS negative_qty,
       SUM(CASE WHEN s.st_StanRez > 0 THEN 1 ELSE 0 END) AS sku_with_reservation,
       SUM(CASE WHEN s.st_StanRez > s.st_Stan THEN 1 ELSE 0 END) AS sku_reserved_over_stock,
       SUM(CASE WHEN s.st_StanRez > s.st_Stan THEN s.st_StanRez - s.st_Stan ELSE 0 END) AS shortage_qty_for_reservations,
       SUM(CASE WHEN s.st_Stan <= 0 AND COALESCE(so.qty_sold, 0) > 0 THEN 1 ELSE 0 END) AS stockout_sku_sold_last_n_days,
       SUM(CASE WHEN s.st_StanMin > 0 AND s.st_Stan < s.st_StanMin THEN 1 ELSE 0 END) AS sku_below_warehouse_min,
       SUM(CASE WHEN COALESCE(t.tw_StanMin, 0) > 0 AND s.st_Stan < t.tw_StanMin THEN 1 ELSE 0 END) AS sku_below_card_min,
       SUM(CASE WHEN COALESCE(t.tw_StanMaks, 0) > 0 AND s.st_Stan > t.tw_StanMaks THEN 1 ELSE 0 END) AS sku_above_card_max
FROM dbo.sl_Magazyn m
JOIN dbo.tw_Stan s ON s.st_MagId = m.mag_Id
JOIN dbo.tw__Towar t ON t.tw_Id = s.st_TowId AND t.tw_Usuniety = 0 AND t.tw_Rodzaj = 1
LEFT JOIN sold so ON so.tw_id = s.st_TowId AND so.mag_id = s.st_MagId
GROUP BY m.mag_Id, m.mag_Symbol
ORDER BY m.mag_Id
```

Pułapki: stan bieżący z definicji — `tw_Stan` nie ma historii, więc szablon nie przyjmuje daty, a okno sprzedaży liczy się wstecz od chwili wykonania; wynik zależy od momentu uruchomienia (stany zmieniają się na żywo); Subiekt GT nie dopuszcza stanów ujemnych bez specjalnego parametru (`dok_Parametr`) — `negative_sku` = 0 jest oczekiwane, a wartość > 0 to sygnał awarii spójności; „brak z obrotem" nie jest tu utraconą sprzedażą: firma sprzedaje głównie z zamówień pod klienta (towar przychodzi i wychodzi tego samego dnia), więc `stockout_sku_sold_last_n_days` mierzy raczej skalę modelu just-in-time niż realne braki; rezerwacje (`st_StanRez`) zależą od parametru „rezerwuj stany przy ZK" — niedobór pod rezerwacje to zamówienia klientów czekające na dostawę; progi min/max nie są prowadzone (0 towarów) — alerty M10/M11 z katalogu wymagają najpierw ich ustawienia albo wyliczenia z historii (KPI „Pokrycie").

Interpretacja (2026-09-14, okno 2026-08-15..2026-09-14): stany ujemne 0 na każdym magazynie; MAG — 742 SKU z rezerwacją, w tym 486 z rezerwacją ponad stan (brakuje 1 056 szt.), 2 013 SKU sprzedanych w 30 dni, a dziś bez stanu; RKR — 34 z rezerwacją, 13 ponad stan, 47 sprzedanych bez stanu; AZZ i EIL bez rezerwacji i bez obrotu. Relacja 2 013 „braków z obrotem" do 4 388 SKU na stanie pokazuje, że około jedna trzecia sprzedawanego asortymentu w ogóle nie jest magazynowana.
