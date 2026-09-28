---
id: korekty-faktur-sprzedazy-kfs
title: Korekty faktur sprzedaży (KFS)
area: sprzedaz
order: 120
questions:
  - "Jak policzyć: Korekty faktur sprzedaży (KFS)?"
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
- Definicja: miesięczna liczba i wartość korekt faktur sprzedaży (KFS), z rozbiciem na składnik ze zwrotu ilości i składnik ze zmiany ceny/rabatu, w relacji do wartości i liczby faktur (część KPI „korekty i zwroty").
- Formuła: `corrections_net = Σ dok_WartNetto (KFS)`; `value_from_returned_qty = −Σ ob_WartNetto` dla pozycji `ob_Znak = −1`; `value_from_price_change = Σ ob_WartNetto` dla pozycji `ob_Znak = 1`; `udział % = −corrections_net / Σ FS × 100`.
- Tabele i kolumny: `dok__Dokument` (`dok_Typ`, `dok_Status`, `dok_DataWyst`, `dok_WartNetto`, `dok_WartMag`), `dok_Pozycja` (`ob_DokHanId`, `ob_Znak`, `ob_WartNetto`, `ob_IloscMag`).
- Kody dok_Typ: 6 = KFS (mianownik: 2 = FS).

```sql
-- zakres: [@od, @do) — przedział półotwarty
WITH kfs_lines AS (
  SELECT
    k.dok_Id,
    YEAR(k.dok_DataWyst)  AS year_no,
    MONTH(k.dok_DataWyst) AS month_no,
    k.dok_WartNetto,
    k.dok_WartMag,
    p.ob_Znak,
    p.ob_WartNetto,
    p.ob_IloscMag
  FROM dbo.dok__Dokument k
  LEFT JOIN dbo.dok_Pozycja p ON p.ob_DokHanId = k.dok_Id
  WHERE k.dok_Typ = 6
    AND k.dok_Status = 1
    AND k.dok_DataWyst >= @od
    AND k.dok_DataWyst <  @do
),
kfs_docs AS (
  SELECT
    dok_Id, year_no, month_no,
    MAX(dok_WartNetto) AS kfs_net,
    MAX(dok_WartMag)   AS kfs_cost,
    SUM(CASE WHEN ob_Znak = -1 THEN ob_IloscMag ELSE 0 END)                 AS returned_qty,
    SUM(CASE WHEN ob_Znak = -1 THEN -ob_WartNetto ELSE 0 END)               AS value_from_returned_qty,
    SUM(CASE WHEN ob_Znak = 1  THEN ob_WartNetto ELSE 0 END)                AS value_from_price_change
  FROM kfs_lines
  GROUP BY dok_Id, year_no, month_no
),
fs_month AS (
  SELECT YEAR(dok_DataWyst) AS year_no, MONTH(dok_DataWyst) AS month_no, SUM(dok_WartNetto) AS invoices_net, COUNT(*) AS invoices_count
  FROM dbo.dok__Dokument
  WHERE dok_Typ = 2 AND dok_Status = 1 AND dok_DataWyst >= @od AND dok_DataWyst < @do
  GROUP BY YEAR(dok_DataWyst), MONTH(dok_DataWyst)
)
SELECT
  f.year_no,
  f.month_no,
  COUNT(k.dok_Id)                         AS corrections_count,
  SUM(k.kfs_net)                          AS corrections_net,           -- ujemne = obniżka przychodu
  SUM(k.kfs_cost)                         AS corrections_cost,          -- ujemne = koszt wraca na magazyn
  SUM(k.returned_qty)                     AS returned_qty,
  SUM(k.value_from_returned_qty)          AS value_from_returned_qty,   -- składnik korekty ze zwrotu ilości (ujemny)
  SUM(k.value_from_price_change)          AS value_from_price_change,   -- składnik korekty z ceny/rabatu (ujemny lub dodatni)
  f.invoices_net,
  ROUND(100.0 * -SUM(k.kfs_net) / NULLIF(f.invoices_net, 0), 2)   AS corrections_to_invoices_pct,
  ROUND(100.0 * COUNT(k.dok_Id) / NULLIF(f.invoices_count, 0), 2) AS corrections_count_to_invoices_pct
FROM fs_month f
LEFT JOIN kfs_docs k ON k.year_no = f.year_no AND k.month_no = f.month_no
GROUP BY f.year_no, f.month_no, f.invoices_net, f.invoices_count
ORDER BY f.year_no, f.month_no
```

- Pułapki: (1) Tylko `dok_Status = 1` — KFS ze statusem 0 (do faktur detalicznych FSd) dublują zwroty ZW. (2) Korekta jest w miesiącu wystawienia korekty, a faktura pierwotna często w poprzednim — wskaźnik miesięczny jest przybliżeniem; dla rzetelnego „return rate" faktur połącz KFS z fakturą przez `dok_DoDokId` i licz w miesiącu faktury. (3) Znak: obniżka = ujemne; korekty in plus (dopłata) występują i zmniejszają moduł sumy. (4) Zwrot ilości vs zmiana ceny odczytuje się z `ob_Znak` pozycji: `−1` = towar wraca (jest koszt), `1` = zmiana wartości bez ruchu towaru (koszt 0). (5) Korekty faktur zakupu (KFZ, typ 5) to zupełnie inny wskaźnik (zakupy). (6) Przyczyna korekty (`ob_PrzyczynaKorektyId` → `sl_PrzyczynaKorekty`) jest dostępna, ale w tej instancji rzadko wypełniana — sprawdź liczności przed użyciem.
- Interpretacja: w instancji korekty to ok. 3–4% wartości faktur i ok. 4–5% ich liczby (2025), niemal w całości ze zwrotów ilości (zmiany ceny to ułamek procenta). Wzrost składnika cenowego = błędy cennika lub rabaty posprzedażowe; wzrost ilościowego = reklamacje/zwroty B2B.
