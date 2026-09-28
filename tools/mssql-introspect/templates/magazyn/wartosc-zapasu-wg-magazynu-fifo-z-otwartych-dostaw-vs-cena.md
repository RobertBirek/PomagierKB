---
id: wartosc-zapasu-wg-magazynu-fifo-z-otwartych-dostaw-vs-cena
title: Wartość zapasu wg magazynu (FIFO z otwartych dostaw vs cena kartotekowa)
area: magazyn
order: 10
questions:
  - "Jak policzyć: Wartość zapasu wg magazynu (FIFO z otwartych dostaw vs cena kartotekowa)?"
params: {}
verified: 2026-09-14
---
Definicja: kapitał zamrożony w towarze na każdym magazynie, wyceniony po rzeczywistym koszcie warstw FIFO oraz — kontrolnie — po cenie kartotekowej zakupu (katalog: M3 „Wartość magazynu", M17 „Zapas wg magazynów").

Formuła: wartość FIFO = Σ(`mr_Pozostalo` × `mr_Cena`) po warstwach z `mr_MagId = magazyn` i `mr_Pozostalo > 0`; wartość kartotekowa = Σ(`st_Stan` × `tc_CenaNetto0`) dla `st_Stan > 0`.

Tabele i kolumny: `sl_Magazyn` (mag_Id, mag_Symbol, mag_Nazwa); `tw_Stan` (st_MagId, st_TowId, st_Stan, st_StanRez); `dok_MagRuch` (mr_MagId, mr_TowId, mr_Pozostalo, mr_Cena); `tw__Towar` (tw_Usuniety, tw_Zablokowany); `tw_Cena` (tc_IdTowar, tc_CenaNetto0).

Kody dok_Typ: brak — KPI liczony ze stanów, nie z dokumentów.

```sql
-- zakres: stan bieżący na chwilę wykonania (tw_Stan i mr_Pozostalo nie mają historii) — historię daje KPI „Rotacja"
WITH fifo AS (
  SELECT r.mr_MagId AS mag_id, r.mr_TowId AS tw_id,
         SUM(r.mr_Pozostalo) AS qty_fifo,
         SUM(r.mr_Pozostalo * r.mr_Cena) AS value_fifo
  FROM dbo.dok_MagRuch r
  WHERE r.mr_MagId IS NOT NULL AND r.mr_Pozostalo > 0
  GROUP BY r.mr_MagId, r.mr_TowId
)
SELECT m.mag_Id, m.mag_Symbol, m.mag_Nazwa,
       SUM(CASE WHEN s.st_Stan > 0 THEN 1 ELSE 0 END) AS sku_in_stock,
       SUM(s.st_Stan) AS qty_tw_stan,
       SUM(COALESCE(f.qty_fifo, 0)) AS qty_fifo,
       SUM(COALESCE(f.value_fifo, 0)) AS value_fifo,
       SUM(CASE WHEN s.st_Stan > 0 THEN s.st_Stan * COALESCE(c.tc_CenaNetto0, 0) ELSE 0 END) AS value_card_price,
       SUM(CASE WHEN s.st_Stan > 0 AND COALESCE(c.tc_CenaNetto0, 0) = 0 THEN 1 ELSE 0 END) AS sku_in_stock_without_card_price,
       SUM(CASE WHEN t.tw_Zablokowany = 1 THEN COALESCE(f.value_fifo, 0) ELSE 0 END) AS value_fifo_blocked,
       SUM(s.st_StanRez) AS qty_reserved
FROM dbo.sl_Magazyn m
JOIN dbo.tw_Stan s ON s.st_MagId = m.mag_Id
JOIN dbo.tw__Towar t ON t.tw_Id = s.st_TowId AND t.tw_Usuniety = 0
LEFT JOIN dbo.tw_Cena c ON c.tc_IdTowar = t.tw_Id
LEFT JOIN fifo f ON f.mag_id = s.st_MagId AND f.tw_id = s.st_TowId
GROUP BY m.mag_Id, m.mag_Symbol, m.mag_Nazwa
ORDER BY value_fifo DESC
```

Pułapki: `qty_tw_stan` i `qty_fifo` muszą być równe — rozjazd oznacza niespójność bazy (np. przerwana operacja) i unieważnia wycenę FIFO; wartość kartotekowa zaniża tam, gdzie `tc_CenaNetto0 = 0` (kolumna `sku_in_stock_without_card_price`); `st_StanRez` to rezerwacje z ZK — zapas dostępny = `st_Stan − st_StanRez`; zapas na magazynie AZZ (skład marki Azzardo) jest wyceniony po cenie wprowadzenia i może być towarem powierzonym — do potwierdzenia u właściciela.

Interpretacja (2026-09-14): MAG 4 388 SKU / 35 702 szt. / 1,264 mln zł (kartotekowo 1,242 mln); AZZ 1 053 SKU / 5 930 szt. / 352 tys.; RKR 510 SKU / 3 281 szt. / 112 tys.; EIL 145 SKU / 263 szt. / 20 tys.; KOS pusty. Razem ok. 1,75 mln zł w 6 096 pozycjach ze stanem. Wartość zablokowanych towarów na stanie = 0 (blokada = wycofanie z oferty, nie zamrożenie). Porównuj z miesięcznym kosztem sprzedaży (~0,7–1,0 mln zł, KPI „Bilans ruchów") — zapas to niecałe 2 miesiące sprzedaży.
