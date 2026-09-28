---
id: bilans-ruchow-magazynowych-miesiecznie-przyjecia-wydania
title: Bilans ruchów magazynowych miesięcznie (przyjęcia, wydania, zwroty, przesunięcia)
area: magazyn
order: 70
questions:
  - "Jak policzyć: Bilans ruchów magazynowych miesięcznie (przyjęcia, wydania, zwroty, przesunięcia)?"
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
Definicja: wartość magazynowa przyjęć (PZ z zakupu, PZ ze zwrotów klientów, PW), wydań (WZ sprzedażowe, WZ zwrotów do dostawcy, RW) i przesunięć MM w każdym miesiącu oraz wynikowa zmiana zapasu (katalog: M18 „Analiza wydań i przyjęć WZ/PZ", raport 11.5.9 „Ruchy WZ/PZ/MM/RW/PW w czasie").

Formuła: klasy ruchu po `dok_Typ` i typie dokumentu powiązanego; zmiana zapasu = Σ `dok_WartMagP` (PZ, PW) − Σ `dok_WartMagR` (WZ, RW); MM raportowane osobno (nie wchodzi do zmiany zapasu firmy).

Tabele i kolumny: `dok__Dokument` (dok_Typ, dok_Status, dok_DataWyst, dok_DoDokId, dok_WartMagP, dok_WartMagR) — samozłączenie do dokumentu powiązanego.

Kody dok_Typ: PZ 10 (→ FZ 1 zakup; → ZW 14 / KFS 6 zwrot klienta), WZ 11 (→ FS 2 / PA 21 sprzedaż; → KFZ 5 zwrot do dostawcy), PW 12, RW 13, MM 9; `dok_Status = 1`.

Szablon SQL:

```sql
-- zakres: [@od, @do) — przedział półotwarty
SELECT YEAR(d.dok_DataWyst) AS y, MONTH(d.dok_DataWyst) AS m,
       SUM(CASE WHEN d.dok_Typ = 10 AND COALESCE(l.dok_Typ, 0) NOT IN (6, 14) THEN d.dok_WartMagP ELSE 0 END) AS pz_purchases,
       SUM(CASE WHEN d.dok_Typ = 10 AND l.dok_Typ IN (6, 14) THEN d.dok_WartMagP ELSE 0 END) AS pz_customer_ret,
       SUM(CASE WHEN d.dok_Typ = 12 THEN d.dok_WartMagP ELSE 0 END) AS pw_receipts,
       SUM(CASE WHEN d.dok_Typ = 11 AND COALESCE(l.dok_Typ, 0) <> 5 THEN d.dok_WartMagR ELSE 0 END) AS wz_sales_cost,
       SUM(CASE WHEN d.dok_Typ = 11 AND l.dok_Typ = 5 THEN d.dok_WartMagR ELSE 0 END) AS wz_supplier_ret,
       SUM(CASE WHEN d.dok_Typ = 13 THEN d.dok_WartMagR ELSE 0 END) AS rw_issues,
       SUM(CASE WHEN d.dok_Typ = 9 THEN d.dok_WartMagR ELSE 0 END) AS mm_transfers,
       SUM(CASE WHEN d.dok_Typ IN (10, 12) THEN d.dok_WartMagP ELSE 0 END) - SUM(CASE WHEN d.dok_Typ IN (11, 13) THEN d.dok_WartMagR ELSE 0 END) AS net_stock_change,
       COUNT(*) AS doc_cnt
FROM dbo.dok__Dokument d
LEFT JOIN dbo.dok__Dokument l ON l.dok_Id = d.dok_DoDokId
WHERE d.dok_Typ IN (9, 10, 11, 12, 13) AND d.dok_Status = 1
  AND d.dok_DataWyst >= @od AND d.dok_DataWyst < @do
GROUP BY YEAR(d.dok_DataWyst), MONTH(d.dok_DataWyst)
ORDER BY 1, 2
```

Pułapki: `dok_DataWyst` dokumentu magazynowego może różnić się od `dok_DataMag` (data operacji) — przy zamknięciach miesiąca użyj `dok_DataMag`; PZ podtyp 2 („PZv", 2 dok. w 2025, 132 tys. zł) to przyjęcia bez FZ — wchodzą do `pz_purchases`; IW (inwentaryzacja, typ 29) generuje techniczne PW/RW z `dok_DokumentTechniczny` — różnice inwentaryzacyjne zobaczysz w `pw_receipts` / `rw_issues` w miesiącu remanentu; wartości w cenach magazynowych (koszt), nie w cenach sprzedaży; suma `net_stock_change` za okres ≈ różnica zapasów z KPI „Rotacja" (2025: ok. +0,43 mln).

Interpretacja (2025): zakupy 0,51–1,09 mln zł miesięcznie (szczyt marzec i październik), koszt sprzedaży 0,55–0,99 mln (szczyt grudzień), zwroty do dostawcy 4–278 tys. miesięcznie (razem ~2,1 mln), zwroty klientów 40–88 tys. (razem ~0,67 mln). Zapas rósł od marca (+271 tys.) i topniał w grudniu (−116 tys.) — typowa sezonowość oświetlenia.

Test: 2025-01-01..2026-01-01, 12 wierszy, wykonano 2026-09-14.
