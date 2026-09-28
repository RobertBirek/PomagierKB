---
id: marza-brutto-z-pozycji-dokumentow
title: Marża brutto z pozycji dokumentów
area: sprzedaz
order: 60
questions:
  - "Jak policzyć: Marża brutto z pozycji dokumentów?"
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
- Definicja: marża brutto = przychód netto po korektach i zwrotach minus koszt własny sprzedanych towarów (wartość magazynowa z pozycji dokumentów), kwotowo i procentowo, z osobnym wynikiem dla samych towarów (F4 „Gross Profit Margin", F19 „Contribution Margin").
- Formuła: `Marża = Σ znak × ob_WartNetto − Σ znak × ob_WartMag`; `Marża % = Marża / Σ znak × ob_WartNetto × 100`; znak = `ob_Znak` (KFS) × (−1 dla ZW); dla FS zbiorczych (podtyp 2) wartość i koszt z pozycji WZ wskazanej przez `ob_DoId`.
- Tabele i kolumny: `dok__Dokument` (`dok_Typ`, `dok_Podtyp`, `dok_Status`, `dok_DataWyst`), `dok_Pozycja` (`ob_DokHanId`, `ob_DoId`, `ob_Znak`, `ob_WartNetto`, `ob_WartMag`, `ob_TowRodzaj`).
- Kody dok_Typ: 2 = FS, 21 = PA, 6 = KFS, 14 = ZW; `ob_TowRodzaj` 1 towar, 2 usługa, 8 komplet.

```sql
-- zakres: [@od, @do) — przedział półotwarty
WITH sales_lines AS (
  SELECT
    YEAR(d.dok_DataWyst)  AS year_no,
    MONTH(d.dok_DataWyst) AS month_no,
    CASE WHEN d.dok_Typ = 14 THEN -1 ELSE 1 END * p.ob_Znak AS sign_factor,   -- ZW odejmuje; KFS ma znak na pozycji
    CASE WHEN d.dok_Typ = 2 AND d.dok_Podtyp = 2 THEN w.ob_WartNetto ELSE p.ob_WartNetto END AS line_net,   -- FS zbiorcza: wartość na pozycji WZ
    CASE WHEN d.dok_Typ = 2 AND d.dok_Podtyp = 2 THEN w.ob_WartMag   ELSE p.ob_WartMag   END AS line_cost,
    p.ob_TowRodzaj
  FROM dbo.dok__Dokument d
  JOIN dbo.dok_Pozycja p ON p.ob_DokHanId = d.dok_Id
  LEFT JOIN dbo.dok_Pozycja w ON w.ob_Id = p.ob_DoId AND d.dok_Typ = 2 AND d.dok_Podtyp = 2
  WHERE d.dok_Typ IN (2, 21, 6, 14)
    AND d.dok_Status = 1
    AND d.dok_DataWyst >= @od
    AND d.dok_DataWyst <  @do
)
SELECT
  year_no,
  month_no,
  SUM(sign_factor * line_net)                                   AS net_sales,
  SUM(sign_factor * line_cost)                                  AS cogs,
  SUM(sign_factor * (line_net - line_cost))                     AS gross_margin,
  ROUND(100.0 * SUM(sign_factor * (line_net - line_cost)) / NULLIF(SUM(sign_factor * line_net), 0), 2) AS margin_pct,
  SUM(CASE WHEN ob_TowRodzaj IN (1, 8) THEN sign_factor * line_net  ELSE 0 END) AS goods_net,
  SUM(CASE WHEN ob_TowRodzaj IN (1, 8) THEN sign_factor * line_cost ELSE 0 END) AS goods_cogs,
  ROUND(100.0 * SUM(CASE WHEN ob_TowRodzaj IN (1, 8) THEN sign_factor * (line_net - line_cost) ELSE 0 END)
        / NULLIF(SUM(CASE WHEN ob_TowRodzaj IN (1, 8) THEN sign_factor * line_net ELSE 0 END), 0), 2) AS goods_margin_pct,
  SUM(CASE WHEN ob_TowRodzaj = 2 THEN sign_factor * line_net ELSE 0 END)        AS services_net
FROM sales_lines
GROUP BY year_no, month_no
ORDER BY year_no, month_no
```

- Pułapki: (1) Koszt to wartość magazynowa w metodzie wyceny instancji (FIFO/średnia ważona wg ustawień Subiekta) — nie cena kartotekowa ani ostatnia cena zakupu; nieaktualne przyjęcia PZ = fałszywa marża. (2) Usługi (wysyłka) mają koszt 0 i zawyżają marżę łączną — porównuj `goods_margin_pct`. (3) FS zbiorcze (podtyp 2) mają pozycje zerowe — bez `LEFT JOIN w` zgubisz ich wartość i koszt (w 2025: 99 tys. zł). (4) Faktura zaliczkowa końcowa niesie na pozycjach pełną wartość zamówienia, a zaliczkowa pośrednia nie ma pozycji — wynik z pozycji różni się od nagłówków o wartość zaliczek (ok. 0,05%). (5) Pozycje FSd (podtyp 1) mają wartość netto, ale koszt 0 — gdybyś pominął `dok_Status = 1`, zdublujesz przychód paragonów z marżą 100%. (6) Rabaty są już w `ob_WartNetto` (`ob_Rabat` to informacja). (7) Faktury VAT marża (`dok_VatMarza`, `ob_WartNabycia`) w tej instancji nie występują.
- Interpretacja: w instancji marża brutto 2025 ≈ 32–35% łącznie, ≈ 31–34% na towarach. Spadek `goods_margin_pct` przy rosnącej sprzedaży = erozja cen (promocje) lub droższe zakupy; spadek `margin_pct` przy stałej marży towarowej = mniejszy udział opłat za usługi. Wersja kontrolna z nagłówków: `SUM(dok_WartNetto) − SUM(dok_WartMag)` na tych samych filtrach (ZW ze znakiem minus).
