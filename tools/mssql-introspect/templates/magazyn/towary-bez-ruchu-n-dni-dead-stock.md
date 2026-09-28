---
id: towary-bez-ruchu-n-dni-dead-stock
title: Towary bez ruchu N dni (dead stock)
area: magazyn
order: 30
questions:
  - "Jak policzyć: Towary bez ruchu N dni (dead stock)?"
params: {}
verified: 2026-09-14
---
Definicja: towary ze stanem, których ostatni rozchód (WZ lub RW) był dawniej niż 90 / 180 / 365 dni temu albo nigdy nie nastąpił, wraz z wartością zapasu w tych koszykach (katalog: M5 „Slow movers", M6 „Dead stock").

Formuła: dla towaru ze stanem: ostatni ruch = MAX(`mr_Data`) po rozchodach (`mr_MagId IS NULL`); koszyk wg DATEDIFF(day, ostatni ruch, data odniesienia); udział = wartość koszyka / wartość zapasu.

Tabele i kolumny: `dok_MagRuch` (mr_TowId, mr_MagId, mr_Data, mr_Pozostalo, mr_Cena); `tw__Towar` (tw_Zablokowany).

Kody dok_Typ: rozchód = każdy wiersz `mr_MagId IS NULL` (WZ 11 i RW 13); MM nie jest ruchem.

Szablon SQL:

```sql
-- zakres: zamień daty — data odniesienia '2026-09-14' (progi 90/180/365 dni w CASE)
WITH stock AS (
  SELECT mr_TowId AS tw_id, SUM(mr_Pozostalo) AS qty, SUM(mr_Pozostalo * mr_Cena) AS value_fifo
  FROM dbo.dok_MagRuch
  WHERE mr_MagId IS NOT NULL AND mr_Pozostalo > 0
  GROUP BY mr_TowId
),
last_issue AS (
  SELECT mr_TowId AS tw_id, MAX(mr_Data) AS last_issue_date
  FROM dbo.dok_MagRuch
  WHERE mr_MagId IS NULL AND mr_Data <= '2026-09-14'
  GROUP BY mr_TowId
),
b AS (
  SELECT s.tw_id, s.qty, s.value_fifo, t.tw_Zablokowany,
         CASE WHEN li.last_issue_date IS NULL THEN '5: nigdy nie wydany'
              WHEN DATEDIFF(day, li.last_issue_date, '2026-09-14') > 365 THEN '4: bez ruchu >365 dni'
              WHEN DATEDIFF(day, li.last_issue_date, '2026-09-14') > 180 THEN '3: bez ruchu 181-365 dni'
              WHEN DATEDIFF(day, li.last_issue_date, '2026-09-14') > 90 THEN '2: bez ruchu 91-180 dni'
              ELSE '1: ruch w ostatnich 90 dniach' END AS no_move_bucket
  FROM stock s
  JOIN dbo.tw__Towar t ON t.tw_Id = s.tw_id
  LEFT JOIN last_issue li ON li.tw_id = s.tw_id
)
SELECT no_move_bucket,
       COUNT(*) AS sku_cnt,
       SUM(qty) AS qty,
       SUM(value_fifo) AS value_fifo,
       CAST(100.0 * SUM(value_fifo) / NULLIF(SUM(SUM(value_fifo)) OVER (), 0) AS decimal(6,2)) AS value_share_pct,
       SUM(CASE WHEN tw_Zablokowany = 1 THEN 1 ELSE 0 END) AS sku_blocked
FROM b
GROUP BY no_move_bucket
ORDER BY no_move_bucket
```

Pułapki: „ruch" obejmuje też RW (likwidacje, wydania wewnętrzne) i zwroty do dostawcy (WZ→KFZ) — towar, który tylko wracał do dostawcy, wygląda na ruchomy; ostatni ruch liczony jest globalnie (nie per magazyn) — towar sprzedawany z MAG, a leżący na AZZ, nie wpadnie do koszyka; sezonowość oświetlenia (szczyt IV kwartał) sprawia, że próg 180 dni wiosną łapie towar sezonowy — porównuj rok do roku; lista konkretnych towarów wymaga wersji per `tw_id` (dopuszczalna: nazwy towarów nie są danymi osobowymi).

Interpretacja (2026-09-14): ruch w ostatnich 90 dniach — 2 667 SKU, 59,7% wartości; 91–180 dni — 561 SKU, 8,3%; 181–365 dni — 823 SKU, 11,3%; ponad 365 dni — 1 038 SKU, 220 tys. zł, 12,6%; nigdy nie wydane — 594 SKU, 143 tys. zł, 8,2%. Dead stock (>365 dni + nigdy) = 20,8% wartości (ok. 363 tys. zł) wobec benchmarku „poniżej 5%". Żaden z tych towarów nie jest zablokowany — blokada nie jest używana do oznaczania towaru do likwidacji.

Test: data odniesienia 2026-09-14, 5 wierszy, wykonano 2026-09-14.
