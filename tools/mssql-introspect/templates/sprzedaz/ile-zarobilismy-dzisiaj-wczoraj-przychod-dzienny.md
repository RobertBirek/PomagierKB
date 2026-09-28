---
id: ile-zarobilismy-dzisiaj-wczoraj-przychod-dzienny
title: Ile zarobiliśmy dzisiaj / wczoraj — przychód dzienny
area: sprzedaz
order: 160
questions:
  - "Jak policzyć: Ile zarobiliśmy dzisiaj / wczoraj — przychód dzienny?"
params: {}
verified: 2026-09-23
---
- Definicja: sprzedaż netto i liczba dokumentów sprzedaży (FS + PA, tylko wykonane) na dzień wystawienia; „ile zarobiliśmy" w sensie przychodu, nie zysku — zysk (marża) liczy szablon „Marża brutto z pozycji dokumentów" z tym samym filtrem dat.
- Formuła: `daily_net = Σ dok_WartNetto` dla `dok_Typ IN (2, 21)`, `dok_Status = 1`, grupowanie po `CAST(dok_DataWyst AS date)`.
- Tabele i kolumny: `dok__Dokument` (`dok_Typ`, `dok_Status`, `dok_DataWyst`, `dok_WartNetto`, `dok_WartBrutto`).
- Baza wiedzy NIE zna dzisiejszego wyniku — to fakt na żywo. Ostatnie 14 dni jest w agregacie „Sprzedaż netto dziennie — ostatnie 14 dni" (odświeżany miesięcznie), dokładną wartość na dziś daje wyłącznie to zapytanie na bazie produkcyjnej.

```sql
-- dziś (od północy) i wczoraj; zmień DATEADD na inny zakres
SELECT CAST(dok_DataWyst AS date) AS sale_date,
       COUNT(*)                  AS documents,
       SUM(dok_WartNetto)        AS net_sales,
       SUM(dok_WartBrutto)       AS gross_sales
FROM dbo.dok__Dokument
WHERE dok_Typ IN (2, 21) AND dok_Status = 1
  AND dok_DataWyst >= DATEADD(day, -1, CAST(GETDATE() AS date))
GROUP BY CAST(dok_DataWyst AS date)
ORDER BY sale_date
```

- Pułapki: (1) korekty (KFS, dok_Typ 6) i zwroty (ZW, 14) z tego dnia obniżają realny przychód — dla wyniku „po korektach" użyj szablonu „Przychód netto po korektach i zwrotach" z zakresem jednego dnia. (2) `dok_DataWyst` to data wystawienia, nie sprzedaży (`dok_DataSprz`) — przy fakturach zbiorczych różnica bywa kilkudniowa. (3) Dokumenty odłożone (`dok_Status = 3`) nie liczą się.
- Interpretacja: w instancji typowy dzień roboczy to 140–400 dokumentów sprzedaży i 30–100 tys. PLN netto (próbka 21–23.09.2026: 97,7 / 33,7 / 54,0 tys. PLN).
