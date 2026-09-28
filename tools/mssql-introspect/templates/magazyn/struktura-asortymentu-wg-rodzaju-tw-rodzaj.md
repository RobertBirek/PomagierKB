---
id: struktura-asortymentu-wg-rodzaju-tw-rodzaj
title: Struktura asortymentu wg rodzaju (tw_Rodzaj)
area: magazyn
order: 100
questions:
  - "Ile mamy w kartotece towarów, usług, kompletów i opakowań?"
  - "Ile towarów ma przypisanego dostawcę domyślnego, a ile jest oznaczonych do e-sklepu?"
params: {}
verified: 2026-09-28
---
Definicja: liczność kartoteki, towarów aktywnych, zablokowanych, w e-sklepie, z dostawcą domyślnym, na stanie i wartość zapasu w podziale na rodzaje pozycji (towar, usługa, opakowanie, komplet, opłata) (katalog: 6.7 „Towary/Usługi", checklista jakości).

Formuła: liczniki warunkowe po `tw__Towar` z dołączonym zapasem FIFO.

Tabele i kolumny: `tw__Towar` (tw_Rodzaj, tw_Zablokowany, tw_SklepInternet, tw_IdPodstDostawca, tw_Usuniety); `dok_MagRuch`.

Kody dok_Typ: brak. Kody tw_Rodzaj: 1 towar, 2 usługa, 4 opakowanie, 8 komplet, 16 opłata.

```sql
-- zakres: stan bieżący (bez dat)
WITH stock AS (
  SELECT mr_TowId AS tw_id, SUM(mr_Pozostalo) AS qty, SUM(mr_Pozostalo * mr_Cena) AS value_fifo
  FROM dbo.dok_MagRuch
  WHERE mr_MagId IS NOT NULL AND mr_Pozostalo > 0
  GROUP BY mr_TowId
)
SELECT t.tw_Rodzaj,
       CASE t.tw_Rodzaj WHEN 1 THEN 'towar' WHEN 2 THEN 'usluga' WHEN 4 THEN 'opakowanie' WHEN 8 THEN 'komplet' WHEN 16 THEN 'oplata' ELSE 'inny' END AS kind_label,
       COUNT(*) AS sku_cnt,
       SUM(CASE WHEN t.tw_Zablokowany = 0 THEN 1 ELSE 0 END) AS sku_active,
       SUM(CASE WHEN t.tw_Zablokowany = 1 THEN 1 ELSE 0 END) AS sku_blocked,
       SUM(CASE WHEN t.tw_SklepInternet = 1 THEN 1 ELSE 0 END) AS sku_eshop,
       SUM(CASE WHEN t.tw_IdPodstDostawca IS NOT NULL THEN 1 ELSE 0 END) AS sku_with_default_supplier,
       SUM(CASE WHEN s.qty > 0 THEN 1 ELSE 0 END) AS sku_in_stock,
       SUM(COALESCE(s.qty, 0)) AS qty_stock,
       SUM(COALESCE(s.value_fifo, 0)) AS value_fifo
FROM dbo.tw__Towar t
LEFT JOIN stock s ON s.tw_id = t.tw_Id
WHERE t.tw_Usuniety = 0
GROUP BY t.tw_Rodzaj
ORDER BY t.tw_Rodzaj
```

Pułapki: stan bieżący — kartoteka i zapas nie mają historii, wynik dotyczy chwili wykonania; rodzaj jest kopiowany na pozycje (`ob_TowRodzaj`) w chwili wystawienia — zmiana rodzaju w kartotece nie zmienia historii; komplet (8) ma stan tylko po PW kompletu, składniki liczą się osobno — nie sumować kompletu i składników; `tw_IdPodstDostawca` wskazuje `kh__Kontrahent` (dane osobowe — nigdy nie dołączać nazw, tylko liczyć).

Interpretacja (2026-09-14): towary 79 685 (71 802 aktywne, 7 883 zablokowane, 26 208 z flagą e-sklepu, 21 021 z dostawcą domyślnym, 5 682 na stanie, 1,748 mln zł); usługi 3 (wszystkie w e-sklepie — usługi transportu/montażu sprzedawane online); opakowanie 1; komplety 2 (1 na stanie, 77 zł); opłat 0. Kartoteka to w 99,99% towary — analizy rodzajowe z katalogu (usługi vs towary) nie mają tu zastosowania; dostawca domyślny jest wypełniony tylko u 26% towarów, więc analizy „per dostawca" trzeba prowadzić po FZ, nie po kartotece.
