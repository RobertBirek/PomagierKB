---
id: udzial-towarow-zablokowanych
title: Udział towarów zablokowanych
area: magazyn
order: 90
questions:
  - "Jak policzyć: Udział towarów zablokowanych?"
params: {}
verified: 2026-09-14
---
Definicja: jaka część kartoteki i jaka część wartości zapasu przypada na towary z flagą `tw_Zablokowany = 1` (katalog: checklista jakości danych 10, alert „towary zablokowane ze stanem").

Formuła: udział SKU = liczba zablokowanych / liczba wszystkich nieusuniętych; udział wartości = FIFO zablokowanych / FIFO ogółem.

Tabele i kolumny: `tw__Towar` (tw_Zablokowany, tw_Usuniety, tw_SklepInternet); `dok_MagRuch` (mr_TowId, mr_Pozostalo, mr_Cena).

Kody dok_Typ: brak.

Szablon SQL:

```sql
-- zakres: stan bieżący (bez dat)
WITH stock AS (
  SELECT mr_TowId AS tw_id, SUM(mr_Pozostalo) AS qty, SUM(mr_Pozostalo * mr_Cena) AS value_fifo
  FROM dbo.dok_MagRuch
  WHERE mr_MagId IS NOT NULL AND mr_Pozostalo > 0
  GROUP BY mr_TowId
)
SELECT t.tw_Zablokowany,
       COUNT(*) AS sku_cnt,
       CAST(100.0 * COUNT(*) / SUM(COUNT(*)) OVER () AS decimal(6,2)) AS sku_share_pct,
       SUM(CASE WHEN s.qty > 0 THEN 1 ELSE 0 END) AS sku_in_stock,
       SUM(COALESCE(s.qty, 0)) AS qty_stock,
       SUM(COALESCE(s.value_fifo, 0)) AS value_fifo,
       CAST(100.0 * SUM(COALESCE(s.value_fifo, 0)) / NULLIF(SUM(SUM(COALESCE(s.value_fifo, 0))) OVER (), 0) AS decimal(6,2)) AS value_share_pct,
       SUM(CASE WHEN t.tw_SklepInternet = 1 THEN 1 ELSE 0 END) AS sku_eshop_flag
FROM dbo.tw__Towar t
LEFT JOIN stock s ON s.tw_id = t.tw_Id
WHERE t.tw_Usuniety = 0
GROUP BY t.tw_Zablokowany
ORDER BY t.tw_Zablokowany
```

Pułapki: blokada w Subiekcie GT blokuje wystawianie dokumentów na towar, ale nie zeruje stanu — wartość > 0 u zablokowanych to zapas nie do sprzedania bez odblokowania; blokada nie jest tożsama z wycofaniem z e-sklepu (4 357 zablokowanych ma nadal flagę `tw_SklepInternet`); `tw_Usuniety` na instancji jest zawsze 0 — kartoteka nigdy nie jest czyszczona, więc 79 691 SKU zawiera historyczne pozycje.

Interpretacja (2026-09-14): zablokowane 7 883 SKU (9,9% kartoteki), żaden ze stanem, wartość 0 — blokada jest używana konsekwentnie jako „koniec życia produktu" po wyprzedaniu. Aktywne 71 808 SKU, z czego tylko 5 683 (7,9%) ma stan. Sygnał do sprawdzenia: 4 357 zablokowanych z flagą e-sklepu — czy integrator (tabele `sublinker_*`) filtruje po blokadzie, czy po fladze?

Test: stan bieżący (bez dat), 2 wiersze, wykonano 2026-09-14.
