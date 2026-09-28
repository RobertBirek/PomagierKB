---
id: liczba-aktywnych-dostawcow-miesiecznie-fz-i-nowi-dostawcy
title: Liczba aktywnych dostawców miesięcznie (FZ) i nowi dostawcy
area: magazyn
order: 140
questions:
  - "Od ilu dostawców kupowaliśmy w każdym miesiącu 2025 roku i ilu z nich było nowych?"
  - "Ile średnio kupujemy miesięcznie od jednego dostawcy?"
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
Definicja: ilu różnych dostawców wystawiło FZ w miesiącu, ilu z nich dostarczyło towar (FZ z wartością magazynową), ilu pojawiło się po raz pierwszy w historii bazy, plus liczba FZ, wartość netto, wartość towarowa i średnia wartość na dostawcę (katalog: Z1 uzupełnienie, raport 11.6.10 „dual sourcing").

Formuła: aktywni = COUNT(DISTINCT `dok_PlatnikId`) FZ w miesiącu; nowi = dostawcy, których MIN(`dok_DataWyst`) po wszystkich FZ przypada w tym miesiącu.

Tabele i kolumny: `dok__Dokument` (dok_Typ, dok_Status, dok_DataWyst, dok_PlatnikId, dok_WartNetto, dok_WartMagP).

Kody dok_Typ: FZ 1, `dok_Status = 1`.

```sql
-- zakres: [@od, @do) — przedział półotwarty
WITH first_fz AS (
  SELECT d.dok_PlatnikId AS supplier_id, MIN(d.dok_DataWyst) AS first_fz_date
  FROM dbo.dok__Dokument d
  WHERE d.dok_Typ = 1 AND d.dok_Status = 1
  GROUP BY d.dok_PlatnikId
)
SELECT YEAR(d.dok_DataWyst) AS y, MONTH(d.dok_DataWyst) AS m,
       COUNT(DISTINCT d.dok_PlatnikId) AS active_suppliers,
       COUNT(DISTINCT CASE WHEN d.dok_WartMagP > 0 THEN d.dok_PlatnikId END) AS active_goods_suppliers,
       COUNT(DISTINCT CASE WHEN YEAR(f.first_fz_date) = YEAR(d.dok_DataWyst) AND MONTH(f.first_fz_date) = MONTH(d.dok_DataWyst) THEN d.dok_PlatnikId END) AS new_suppliers,
       COUNT(*) AS fz_cnt,
       SUM(d.dok_WartNetto) AS net_value,
       SUM(d.dok_WartMagP) AS goods_value_pz,
       CAST(SUM(d.dok_WartNetto) / NULLIF(COUNT(DISTINCT d.dok_PlatnikId), 0) AS decimal(14,2)) AS avg_value_per_supplier
FROM dbo.dok__Dokument d
JOIN first_fz f ON f.supplier_id = d.dok_PlatnikId
WHERE d.dok_Typ = 1 AND d.dok_Status = 1
  AND d.dok_DataWyst >= @od AND d.dok_DataWyst < @do
GROUP BY YEAR(d.dok_DataWyst), MONTH(d.dok_DataWyst)
ORDER BY 1, 2
```

Pułapki: historia FZ zaczyna się 2015-08 — „nowy" w pierwszych miesiącach bazy to każdy; FZ kosztowe (marketplace, paliwo, usługi) podnoszą liczbę aktywnych — `active_goods_suppliers` filtruje po wartości magazynowej; w 2026 liczba dostawców skoczyła do 222 rocznie, bo FZ w walutach (prowizje marketplace) i magazyn KOS „Koszt" zaczęły być księgowane jako FZ — porównania rok do roku wymagają rozdzielenia dostawców towaru od kosztowych; ten sam dostawca pod kilkoma kartotekami liczy się wielokrotnie.

Interpretacja (2025): 28–41 aktywnych dostawców miesięcznie (minimum maj 28, maksimum grudzień 41), praktycznie wszyscy towarowi; 0–4 nowych miesięcznie (17 w roku); 540–812 FZ miesięcznie; średnia wartość zakupów na dostawcę 15,5–34,1 tys. zł/mies. Stabilna, wąska baza ok. 30 dostawców towaru — spójne z HHI ~1 000 i z listą 21 dostawców domyślnych w kartotece.
