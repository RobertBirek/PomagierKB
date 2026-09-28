---
id: koncentracja-zakupow-fz-kfz-wg-dostawcy-rangi-bez-nazw
title: Koncentracja zakupów (FZ + KFZ) wg dostawcy — rangi bez nazw
area: magazyn
order: 130
questions:
  - "Jak policzyć: Koncentracja zakupów (FZ + KFZ) wg dostawcy — rangi bez nazw?"
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
Definicja: udział największych dostawców w wartości netto zakupów (FZ pomniejszone o korekty KFZ) w okresie, skumulowany udział Top 1/3/5/10 i indeks HHI; dostawcy występują wyłącznie jako rangi (katalog: Z1 „Zakupy wg dostawców", Z8 „Koncentracja Top5/HHI", raport 11.6.1).

Formuła: wartość dostawcy = Σ `dok_WartNetto` (FZ dodatnie, KFZ ujemne) po `dok_PlatnikId`; udział = wartość / Σ wszystkich; HHI = Σ(udział²) × 10 000 (poniżej 1 500 — niska koncentracja, 1 500–2 500 umiarkowana, powyżej 2 500 wysoka).

Tabele i kolumny: `dok__Dokument` (dok_Typ, dok_Status, dok_DataWyst, dok_PlatnikId, dok_WartNetto, dok_WartMagP). Bez złączenia z `kh__Kontrahent` — identyfikator dostawcy służy tylko do grupowania i nie jest projektowany.

Kody dok_Typ: FZ 1, KFZ 5; `dok_Status = 1`.

```sql
-- zakres: [@od, @do) — przedział półotwarty
WITH sp AS (
  SELECT d.dok_PlatnikId AS supplier_id,
         SUM(d.dok_WartNetto) AS net_value,
         SUM(CASE WHEN d.dok_Typ = 1 THEN 1 ELSE 0 END) AS fz_cnt,
         SUM(CASE WHEN d.dok_Typ = 5 THEN 1 ELSE 0 END) AS kfz_cnt,
         SUM(CASE WHEN d.dok_Typ = 1 THEN d.dok_WartMagP ELSE 0 END) AS goods_value
  FROM dbo.dok__Dokument d
  WHERE d.dok_Typ IN (1, 5) AND d.dok_Status = 1
    AND d.dok_DataWyst >= @od AND d.dok_DataWyst < @do
  GROUP BY d.dok_PlatnikId
),
r1 AS (
  SELECT supplier_id, net_value, fz_cnt, kfz_cnt, goods_value,
         RANK() OVER (ORDER BY net_value DESC) AS rnk,
         SUM(net_value) OVER () AS total_value
  FROM sp
),
r2 AS (
  SELECT rnk, net_value, fz_cnt, kfz_cnt, goods_value, total_value,
         SUM(POWER(net_value / NULLIF(total_value, 0), 2)) OVER () * 10000 AS hhi,
         CASE WHEN rnk <= 10 THEN RIGHT('00' + CAST(rnk AS varchar(3)), 2) ELSE '11+ pozostali' END AS supplier_rank
  FROM r1
)
SELECT supplier_rank,
       COUNT(*) AS supplier_cnt,
       SUM(fz_cnt) AS fz_cnt,
       SUM(kfz_cnt) AS kfz_cnt,
       SUM(net_value) AS net_value,
       SUM(goods_value) AS goods_value_pz,
       CAST(100.0 * SUM(net_value) / NULLIF(MAX(total_value), 0) AS decimal(6,2)) AS share_pct,
       CAST(100.0 * SUM(SUM(net_value)) OVER (ORDER BY MIN(rnk) ROWS UNBOUNDED PRECEDING) / NULLIF(MAX(total_value), 0) AS decimal(6,2)) AS cumulative_share_pct,
       CAST(MAX(hhi) AS decimal(10,0)) AS hhi_index
FROM r2
GROUP BY supplier_rank
ORDER BY MIN(rnk)
```

Pułapki: `dok_WartNetto` obejmuje FZ usługowe (marketplace, transport, koszty) — kolumna `goods_value_pz` (Σ `dok_WartMagP` FZ) pokazuje część towarową; rozjazd `goods_value_pz` ≫ `net_value` oznacza dużo KFZ (zwrotów do dostawcy) — ranga 4 w 2025: towar 2,47 mln, netto po KFZ 0,94 mln; FZ walutowe są w PLN po kursie z dokumentu; HHI liczony po `dok_PlatnikId` — ten sam dostawca pod dwoma kartotekami zaniża koncentrację; okno OVER liczone przed grupowaniem po randze, więc `hhi_index` jest stały w każdym wierszu; dostawcy w rangach są anonimowi — dla rozmowy z właścicielem potrzebne jest osobne, autoryzowane zapytanie z nazwą.

Interpretacja (2025): 68 dostawców; Top 1 16,5%, Top 3 44,8%, Top 5 66,1%, Top 10 85,8%, pozostałych 58 dostawców 14,2%; HHI 1 012 — niska/umiarkowana koncentracja, bez zależności od jednego dostawcy (próg ryzyka katalogu: Top 1 powyżej 40%). Ranga 5 ma 301 KFZ na 247 FZ, ranga 2 — 180 KFZ na 683 FZ: to dostawcy z rozliczeniem zwrotów niesprzedanego towaru.
