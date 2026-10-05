---
id: liczba-dokumentow-sprzedazy
title: Liczba dokumentów sprzedaży
area: sprzedaz
order: 70
questions:
  - "Ile faktur i paragonów wystawiamy miesięcznie?"
  - "Ile dokumentów sprzedaży przypada średnio na jeden dzień?"
params:
  od:
    type: date
    description: początek zakresu (włącznie)
    example: 2025-01-01
  do:
    type: date
    description: koniec zakresu (wyłącznie)
    example: 2026-01-01
verified: 2026-09-28
---
- Definicja: miesięczna liczba faktur (FS), paragonów (PA), korekt (KFS) i zwrotów (ZW) plus liczba dni sprzedaży i dokumentów na dzień (S14 „Liczba transakcji"); osobno liczone FSd i zaliczkowe pośrednie, które przychodu nie tworzą.
- Formuła: `COUNT` per typ i status; `sales_docs_per_day = liczba FS+PA / liczba dni z co najmniej jednym dokumentem`.
- Tabele i kolumny: `dok__Dokument` (`dok_Typ`, `dok_Podtyp`, `dok_Status`, `dok_DataWyst`).
- Kody dok_Typ: 2 = FS (podtyp 1 = FSd, 3 = zaliczkowa), 21 = PA, 6 = KFS, 14 = ZW.

```sql
-- zakres: [@od, @do) — przedział półotwarty
SELECT
  YEAR(d.dok_DataWyst)  AS year_no,
  MONTH(d.dok_DataWyst) AS month_no,
  SUM(CASE WHEN d.dok_Typ = 2  AND d.dok_Status = 1 THEN 1 ELSE 0 END) AS invoices_fs,
  SUM(CASE WHEN d.dok_Typ = 21 AND d.dok_Status = 1 THEN 1 ELSE 0 END) AS receipts_pa,
  SUM(CASE WHEN d.dok_Typ = 6  AND d.dok_Status = 1 THEN 1 ELSE 0 END) AS corrections_kfs,
  SUM(CASE WHEN d.dok_Typ = 14 AND d.dok_Status = 1 THEN 1 ELSE 0 END) AS returns_zw,
  SUM(CASE WHEN d.dok_Typ = 2  AND d.dok_Podtyp = 1 THEN 1 ELSE 0 END) AS retail_invoices_fsd,   -- FSd do paragonu: poza przychodem
  SUM(CASE WHEN d.dok_Typ = 2  AND d.dok_Podtyp = 3 AND d.dok_Status = 0 THEN 1 ELSE 0 END) AS advance_invoices,   -- FSzal pośrednie: poza przychodem
  SUM(CASE WHEN d.dok_Typ IN (2, 21) AND d.dok_Status = 1 THEN 1 ELSE 0 END) AS sales_docs_total,
  COUNT(DISTINCT CASE WHEN d.dok_Typ IN (2, 21) AND d.dok_Status = 1 THEN CONVERT(date, d.dok_DataWyst) END) AS selling_days,
  SUM(CASE WHEN d.dok_Typ IN (2, 21) AND d.dok_Status = 1 THEN 1 ELSE 0 END) * 1.0
    / NULLIF(COUNT(DISTINCT CASE WHEN d.dok_Typ IN (2, 21) AND d.dok_Status = 1 THEN CONVERT(date, d.dok_DataWyst) END), 0) AS sales_docs_per_day
FROM dbo.dok__Dokument d
WHERE d.dok_Typ IN (2, 21, 6, 14)
  AND d.dok_DataWyst >= @od
  AND d.dok_DataWyst <  @do
GROUP BY YEAR(d.dok_DataWyst), MONTH(d.dok_DataWyst)
ORDER BY year_no, month_no
```

- Pułapki: (1) Paragon + FSd do niego to jedna transakcja — `sales_docs_total` liczy tylko paragon. (2) Faktury zbiorcze (podtyp 2) łączą wiele wydań WZ w jeden dokument — liczba FS nie równa się liczbie transakcji B2B; liczbę zamówień policz z ZK (`dok_Typ = 16`) lub WZ (11). (3) `selling_days` to dni z jakąkolwiek sprzedażą (sklep internetowy sprzedaje w weekendy), nie dni robocze. (4) Zamówienia (ZK) w tej instancji są liczne (244 tys.) i NIE są sprzedażą. (5) Wielokrotne paragony jednego klienta w ciągu dnia to oddzielne dokumenty. (6) Od 03.2026 sprzedaż detaliczna jest dokumentowana fakturą FS zamiast paragonu PA, a zwroty korektą KFS zamiast ZW (potwierdzone przez właściciela 2026-09-28) — w porównaniach przez tę datę detal = PA + FS detaliczne, zwroty = ZW + KFS; spadek PA i ZW po 02.2026 to zmiana dokumentowania, nie sprzedaży.
- Interpretacja: razem ze średnią wartością dokumentu daje pełny obraz: przychód = liczba × średnia. W instancji ok. 3 700–6 600 dokumentów sprzedaży miesięcznie (2025), z czego ~80% to paragony; szczyt w listopadzie–grudniu.
