---
id: rotacja-zapasu-inventory-turnover-i-dni-zapasu
title: Rotacja zapasu (inventory turnover) i dni zapasu
area: magazyn
order: 40
questions:
  - "Jak policzyć: Rotacja zapasu (inventory turnover) i dni zapasu?"
params: {}
verified: 2026-09-14
---
Definicja: ile razy w okresie firma „obróciła" zapas: koszt własny sprzedanych towarów netto (po zwrotach klientów) podzielony przez średni zapas z początku i końca okresu, oraz odwrotność w dniach (katalog: M1 „Inventory Turnover", M2 „Days on Hand / DIO").

Formuła: rotacja = COGS_netto / ((zapas_start + zapas_koniec) / 2); DIO = 365 × średni zapas / COGS_netto; zapas na datę D = Σ dostaw pierwotnych do D − Σ rozchodów do D + Σ zwrotów od klientów do D (wartości `mr_Ilosc × mr_Cena`); COGS_netto = Σ rozchodów z WZ niepowiązanych z KFZ w okresie − Σ zwrotów od klientów w okresie.

Tabele i kolumny: `dok_MagRuch` (mr_Data, mr_Ilosc, mr_Cena, mr_MagId, mr_DoId, mr_PozId); `dok_Pozycja` (ob_Id, ob_DokMagId, ob_DokHanId); `dok__Dokument` (dok_Id, dok_Typ, dok_DoDokId).

Kody dok_Typ: WZ 11 (wydanie), z wykluczeniem WZ, których `dok_DoDokId` wskazuje KFZ 5; RW 13 raportowane osobno; zwroty = warstwy z rodzicem-rozchodem (PZ 10 do ZW 14 / KFS 6).

```sql
-- zakres: zamień daty — okres 2025-01-01 (początek) .. 2026-01-01 (koniec, wyłącznie)
WITH mv AS (
  SELECT c.mr_Data, c.mr_Ilosc * c.mr_Cena AS val,
         CASE WHEN c.mr_MagId IS NULL THEN 'issue'
              WHEN p.mr_Id IS NULL THEN 'delivery'
              WHEN p.mr_MagId IS NULL THEN 'return_in'
              ELSE 'transfer_in' END AS kind,
         d.dok_Typ AS doc_type, l.dok_Typ AS linked_doc_type
  FROM dbo.dok_MagRuch c
  LEFT JOIN dbo.dok_MagRuch p ON p.mr_Id = c.mr_DoId
  JOIN dbo.dok_Pozycja z ON z.ob_Id = c.mr_PozId
  JOIN dbo.dok__Dokument d ON d.dok_Id = COALESCE(z.ob_DokMagId, z.ob_DokHanId)
  LEFT JOIN dbo.dok__Dokument l ON l.dok_Id = d.dok_DoDokId
),
agg AS (
  SELECT
    SUM(CASE WHEN mr_Data < '2025-01-01' THEN CASE kind WHEN 'delivery' THEN val WHEN 'return_in' THEN val WHEN 'issue' THEN -val ELSE 0 END ELSE 0 END) AS stock_value_start,
    SUM(CASE WHEN mr_Data < '2026-01-01' THEN CASE kind WHEN 'delivery' THEN val WHEN 'return_in' THEN val WHEN 'issue' THEN -val ELSE 0 END ELSE 0 END) AS stock_value_end,
    SUM(CASE WHEN kind = 'issue' AND doc_type = 11 AND COALESCE(linked_doc_type, 0) <> 5 AND mr_Data >= '2025-01-01' AND mr_Data < '2026-01-01' THEN val ELSE 0 END) AS cogs_issued,
    SUM(CASE WHEN kind = 'return_in' AND mr_Data >= '2025-01-01' AND mr_Data < '2026-01-01' THEN val ELSE 0 END) AS cogs_returned,
    SUM(CASE WHEN kind = 'issue' AND doc_type = 11 AND linked_doc_type = 5 AND mr_Data >= '2025-01-01' AND mr_Data < '2026-01-01' THEN val ELSE 0 END) AS returned_to_supplier,
    SUM(CASE WHEN kind = 'issue' AND doc_type = 13 AND mr_Data >= '2025-01-01' AND mr_Data < '2026-01-01' THEN val ELSE 0 END) AS rw_issued
  FROM mv
)
SELECT stock_value_start, stock_value_end,
       (stock_value_start + stock_value_end) / 2.0 AS avg_stock_value,
       cogs_issued, cogs_returned, cogs_issued - cogs_returned AS cogs_net,
       returned_to_supplier, rw_issued,
       CAST((cogs_issued - cogs_returned) / NULLIF((stock_value_start + stock_value_end) / 2.0, 0) AS decimal(10,2)) AS inventory_turnover,
       CAST(365.0 * ((stock_value_start + stock_value_end) / 2.0) / NULLIF(cogs_issued - cogs_returned, 0) AS decimal(10,1)) AS days_inventory_outstanding
FROM agg
```

Pułapki: rekonstrukcja opiera się na `mr_Cena` warstwy, a KFZ zmieniające cenę serii zapisują się w `dok_MagWart` — zapas na datę odbiega od bieżącej wyceny FIFO o ok. 4% (koniec 2025: 1,597 mln wg rekonstrukcji vs 1,748 mln FIFO w 09.2026 to także realny wzrost zapasu); średnia z dwóch punktów zaniża przy sezonowym szczycie w IV kwartale — dla dokładności policz zapas na koniec każdego miesiąca (ten sam CASE z 12 datami); zapytanie czyta całą `dok_MagRuch` (0,57 mln wierszy, ~4 s) — nie uruchamiaj w pętli; wynik globalny — wersja per magazyn wymaga przypisania rozchodu do magazynu rodzica (`p.mr_MagId`) i odjęcia przesunięć MM od magazynu źródłowego.

Interpretacja (rok 2025): zapas 1,168 mln → 1,597 mln zł (średnio 1,383 mln); rozchody sprzedażowe 8,504 mln, zwroty klientów 0,674 mln, COGS netto 7,831 mln; rotacja 5,66 obrotu/rok, DIO 64 dni — w widełkach katalogu dla handlu (4–8). Osobno: zwroty do dostawcy 2,098 mln zł (27% COGS!) i RW 52 tys. zł. Wysoki wolumen zwrotów do dostawcy sugeruje model „zamawiaj pod klienta, oddawaj niesprzedane" — potwierdza to KPI „Stany ujemne i braki".
