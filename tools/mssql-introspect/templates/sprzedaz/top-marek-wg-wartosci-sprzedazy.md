---
id: top-marek-wg-wartosci-sprzedazy
title: Top marek wg wartości sprzedaży
area: sprzedaz
order: 100
questions:
  - "Jak policzyć: Top marek wg wartości sprzedaży?"
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
- Definicja: ranking marek (grupa towarowa `sl_GrupaTw`) według przychodu netto z towarów po korektach i zwrotach, z kosztem, marżą, udziałem i sprzedaną ilością (S4 „Sprzedaż wg grup towarowych", S12 „ABC produktów", S21 „Marża per produkt").
- Formuła: per marka: `net_sales = Σ znak × ob_WartNetto`, `cogs = Σ znak × ob_WartMag`, `marża % = (net_sales − cogs) / net_sales × 100`, `udział % = net_sales / Σ wszystkich marek × 100`.
- Tabele i kolumny: `dok__Dokument` (`dok_Typ`, `dok_Podtyp`, `dok_Status`, `dok_DataWyst`), `dok_Pozycja` (`ob_DokHanId`, `ob_DoId`, `ob_TowId`, `ob_TowRodzaj`, `ob_Znak`, `ob_WartNetto`, `ob_WartMag`, `ob_IloscMag`), `tw__Towar` (`tw_Id`, `tw_IdGrupa`), `sl_GrupaTw` (`grt_Id`, `grt_Nazwa`).
- Kody dok_Typ: 2 = FS, 21 = PA, 6 = KFS, 14 = ZW; `ob_TowRodzaj` 1 towar, 8 komplet.

```sql
-- zakres: [@od, @do) — przedział półotwarty
WITH brand_lines AS (
  SELECT
    t.tw_IdGrupa AS brand_id,
    CASE WHEN d.dok_Typ = 14 THEN -1 ELSE 1 END * p.ob_Znak AS sign_factor,
    CASE WHEN d.dok_Typ = 2 AND d.dok_Podtyp = 2 THEN w.ob_WartNetto ELSE p.ob_WartNetto END AS line_net,
    CASE WHEN d.dok_Typ = 2 AND d.dok_Podtyp = 2 THEN w.ob_WartMag   ELSE p.ob_WartMag   END AS line_cost,
    CASE WHEN d.dok_Typ = 2 AND d.dok_Podtyp = 2 THEN w.ob_IloscMag  ELSE p.ob_IloscMag  END AS line_qty
  FROM dbo.dok__Dokument d
  JOIN dbo.dok_Pozycja p ON p.ob_DokHanId = d.dok_Id
  LEFT JOIN dbo.dok_Pozycja w ON w.ob_Id = p.ob_DoId AND d.dok_Typ = 2 AND d.dok_Podtyp = 2
  LEFT JOIN dbo.tw__Towar t ON t.tw_Id = p.ob_TowId
  WHERE d.dok_Typ IN (2, 21, 6, 14)
    AND d.dok_Status = 1
    AND p.ob_TowRodzaj IN (1, 8)       -- tylko towary i komplety (usługi nie mają marki ani kosztu)
    AND d.dok_DataWyst >= @od
    AND d.dok_DataWyst <  @do
),
by_brand AS (
  SELECT
    brand_id,
    SUM(sign_factor * line_net)  AS net_sales,
    SUM(sign_factor * line_cost) AS cogs,
    SUM(sign_factor * line_qty)  AS qty_sold,
    COUNT(*)                     AS line_count
  FROM brand_lines
  GROUP BY brand_id
)
SELECT TOP (20)
  b.brand_id,
  COALESCE(g.grt_Nazwa, '(brak grupy)') AS brand_name,
  b.net_sales,
  b.cogs,
  b.net_sales - b.cogs AS gross_margin,
  ROUND(100.0 * (b.net_sales - b.cogs) / NULLIF(b.net_sales, 0), 2) AS margin_pct,
  ROUND(100.0 * b.net_sales / NULLIF(SUM(b.net_sales) OVER (), 0), 2) AS sales_share_pct,
  b.qty_sold,
  b.line_count
FROM by_brand b
LEFT JOIN dbo.sl_GrupaTw g ON g.grt_Id = b.brand_id
ORDER BY b.net_sales DESC
```

- Pułapki: (1) Marka = bieżąca grupa towaru w kartotece; przeniesienie towaru między grupami zmienia historię wstecz (brak wersjonowania). (2) Grupy „Podstawowa", „nieaktywna" i „(brak grupy)" nie są markami — pokaż je, ale nie porównuj z markami. (3) Towary zablokowane (`tw_Zablokowany = 1`) i wycofane marki mają historię sprzedaży — nie filtruj po blokadzie; jeśli chcesz tylko aktywne portfolio, dodaj warunek w `JOIN tw__Towar`. (4) Udział liczy się do sumy wszystkich marek (mianownik `SUM() OVER ()` obejmuje także te poza TOP 20). (5) `ob_IloscMag` to ilość w jednostce podstawowej; zestawy (`ob_TowRodzaj = 8`) liczą się jako 1 sztuka kompletu. (6) Nazwa marki (`grt_Nazwa`) jest słownikiem towarowym — nie jest daną osobową; nigdy nie dokładaj tu nazw kontrahentów. (7) Sortowanie po wartości, nie po nazwie.
- Interpretacja: w instancji lider ma ok. 17% sprzedaży towarów (2025), a TOP 20 marek pokrywa większość obrotu — klasyczne Pareto. Marka o wysokim udziale i marży poniżej średniej (ok. 33%) to kandydat do renegocjacji cen zakupu; marka o niskim udziale i wysokiej marży — do promowania. Wynik zawiera już zwroty i korekty, więc marki o wysokim odsetku zwrotów mają niższą wartość niż na paragonach.
