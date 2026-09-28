---
id: wiek-zapasu-struktura-wiekowa-otwartych-dostaw
title: Wiek zapasu (struktura wiekowa otwartych dostaw)
area: magazyn
order: 20
questions:
  - "Jak policzyć: Wiek zapasu (struktura wiekowa otwartych dostaw)?"
params: {}
verified: 2026-09-14
---
Definicja: ile wartości zapasu leży w warstwach przyjętych 0–30, 31–90, 91–180, 181–365, 366–730 i ponad 730 dni temu (katalog: M14 „Inventory Aging").

Formuła: dla każdej otwartej warstwy (`mr_Pozostalo > 0`) wiek = DATEDIFF(day, `mr_Data`, data odniesienia); agregacja wartości `mr_Pozostalo × mr_Cena` do przedziałów i udział procentowy.

Tabele i kolumny: `dok_MagRuch` (mr_Data, mr_Pozostalo, mr_Cena, mr_TowId, mr_MagId, mr_DoId).

Kody dok_Typ: brak (warstwy powstają z PZ 10, PW 12, MM 9 i zwrotów).

```sql
-- zakres: zamień daty — data odniesienia '2026-09-14'
WITH b AS (
  SELECT r.mr_TowId, r.mr_Pozostalo, r.mr_Cena, r.mr_DoId,
         CASE WHEN DATEDIFF(day, r.mr_Data, '2026-09-14') <= 30 THEN '1: 0-30 dni'
              WHEN DATEDIFF(day, r.mr_Data, '2026-09-14') <= 90 THEN '2: 31-90 dni'
              WHEN DATEDIFF(day, r.mr_Data, '2026-09-14') <= 180 THEN '3: 91-180 dni'
              WHEN DATEDIFF(day, r.mr_Data, '2026-09-14') <= 365 THEN '4: 181-365 dni'
              WHEN DATEDIFF(day, r.mr_Data, '2026-09-14') <= 730 THEN '5: 366-730 dni'
              ELSE '6: >730 dni' END AS age_bucket
  FROM dbo.dok_MagRuch r
  WHERE r.mr_MagId IS NOT NULL AND r.mr_Pozostalo > 0 AND r.mr_Data <= '2026-09-14'
)
SELECT age_bucket,
       COUNT(*) AS delivery_layers,
       COUNT(DISTINCT mr_TowId) AS sku_cnt,
       SUM(mr_Pozostalo) AS qty,
       SUM(mr_Pozostalo * mr_Cena) AS value_fifo,
       CAST(100.0 * SUM(mr_Pozostalo * mr_Cena) / NULLIF(SUM(SUM(mr_Pozostalo * mr_Cena)) OVER (), 0) AS decimal(6,2)) AS value_share_pct,
       SUM(CASE WHEN mr_DoId IS NULL THEN 0 ELSE 1 END) AS layers_from_transfer_or_return
FROM b
GROUP BY age_bucket
ORDER BY age_bucket
```

Pułapki: warstwy pochodne (`mr_DoId` wypełnione — z MM lub ze zwrotu) mają datę przesunięcia/zwrotu, nie pierwotnego zakupu, więc odmładzają zapas (na instancji to 3 084 z 7 692 warstw); ten sam towar może mieć warstwy w kilku przedziałach; przy `mr_Pozostalo` ułamkowym (5 013,7 szt. w przedziale 31–90) w bazie są rozbicia po korektach — to nie błąd; wiek w dniach kalendarzowych, nie roboczych.

Interpretacja (2026-09-14): 0–30 dni 23,0% wartości, 31–90 dni 10,3%, 91–180 dni 21,5%, 181–365 dni 17,5%, 366–730 dni 19,1%, powyżej 730 dni 8,7%. Ponad rok leży 27,8% wartości zapasu (ok. 485 tys. zł) — kandydaci do wyprzedaży (cecha „Wyprzedaże" w `sl_CechaTw`) albo zwrotu do dostawcy. Benchmark katalogu dla handlu: powyżej 180 dni nie więcej niż 20–25%.
