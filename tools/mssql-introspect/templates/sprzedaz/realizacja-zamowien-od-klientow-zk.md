---
id: realizacja-zamowien-od-klientow-zk
title: Realizacja zamówień od klientów (ZK)
area: sprzedaz
order: 140
questions:
  - "Ile zamówień od klientów zrealizowaliśmy w 2025 roku i jak szybko?"
  - "Ile dni mija od zamówienia do wystawienia faktury lub paragonu?"
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
- Definicja: stan i tempo realizacji zamówień od klientów — ile ZK jest otwartych (bez rezerwacji / z rezerwacją), ile zrealizowano, ile dni mija od ZK do pierwszego dokumentu sprzedaży i jak rozkłada się czas realizacji (0–1, 2–7, 8+ dni).
- Formuła: `open_orders = COUNT(ZK: dok_Status IN (6,7))`, `realized_orders = COUNT(ZK: dok_Status = 8)`; `lead_time_days = DATEDIFF(day, ZK.dok_DataWyst, MIN(FS/PA.dok_DataWyst))` po dokumentach sprzedaży, które wskazują ZK przez `dok_DoDokId`.
- Tabele i kolumny: `dok__Dokument` (`dok_Typ`, `dok_Podtyp`, `dok_Status`, `dok_DataWyst`, `dok_DoDokId`, `dok_WartNetto`), `dok_Pozycja` (`ob_DokHanId`, `ob_TowId`, `ob_Ilosc`, `ob_IloscMag`) tylko do zawartości zamówień.
- Kody: dok_Typ 16 = ZK (podtyp 1 = ZKzal, zamówienie do zaliczek); realizujące: 2 = FS, 21 = PA. Statusy ZK w `dok_Status`: 5 = nie zrealizowane, 6 = nie zrealizowane bez rezerwacji, 7 = nie zrealizowane z rezerwacją, 8 = zrealizowane.
- Jak realizacja jest zapisana W TEJ INSTANCJI (sprawdzone 2026-09-23): dokument sprzedaży powstały z ZK ma `dok_DoDokId` = `dok_Id` zamówienia (240 557 FS/PA wskazuje ZK); powiązanie pozycji `ob_DoId` NIE jest używane dla ZK (0 pozycji), a WZ nigdy nie wskazuje ZK. Praktycznie 1 ZK = 1 dokument sprzedaży (2025: 52 014 ZK z jednym FS/PA, 3 z dwoma, 415 zrealizowanych bez powiązanego FS/PA — zrealizowane ręcznie albo dokument usunięto).

```sql
-- zakres: [@od, @do) — przedział półotwarty
WITH zk AS (
  SELECT dok_Id, dok_DataWyst, dok_Status, dok_WartNetto
  FROM dbo.dok__Dokument
  WHERE dok_Typ = 16
    AND dok_DataWyst >= @od
    AND dok_DataWyst <  @do
),
realized AS (
  SELECT z.dok_Id, DATEDIFF(day, z.dok_DataWyst, MIN(f.dok_DataWyst)) AS lead_days
  FROM zk z
  JOIN dbo.dok__Dokument f ON f.dok_DoDokId = z.dok_Id AND f.dok_Typ IN (2, 21)
  GROUP BY z.dok_Id, z.dok_DataWyst
)
SELECT 'orders_by_status' AS metric, CAST(dok_Status AS varchar(2)) AS dim, COUNT(*) AS value, SUM(dok_WartNetto) AS net_value
FROM zk GROUP BY dok_Status
UNION ALL
SELECT 'lead_time_bucket', CASE WHEN lead_days <= 1 THEN '0-1 dni' WHEN lead_days <= 7 THEN '2-7 dni' ELSE '8+ dni' END, COUNT(*), NULL
FROM realized GROUP BY CASE WHEN lead_days <= 1 THEN '0-1 dni' WHEN lead_days <= 7 THEN '2-7 dni' ELSE '8+ dni' END
UNION ALL
SELECT 'lead_time_avg_days', 'realized_with_sales_doc', COUNT(*), AVG(CAST(lead_days AS decimal(10,2)))
FROM realized
ORDER BY metric, dim
```

- Pułapki: (1) Status 8 może nie mieć dokumentu sprzedaży (zrealizowano ręcznie / usunięto FS) — licz realizację po `dok_Status`, a czas realizacji po `dok_DoDokId`. (2) ZKzal (podtyp 1) realizuje się przez FSzal, a nie FS — jeśli chcesz osobno, filtruj `dok_Podtyp`. (3) `dok_DoDokId` na samym ZK (1 088 rekordów) wskazuje w drugą stronę na inne typy — nie używaj go do liczenia realizacji. (4) Nie łącz przez `dok_Pozycja.ob_DoId` — w tej instancji jest puste dla zamówień.
- Interpretacja: instancja realizuje zamówienia praktycznie od ręki — 2025: średnio 2 dni, 53% w ciągu doby, 40% w 2–7 dni, 7% powyżej tygodnia (max 129 dni); otwartych ZK jest ok. 4,3 tys. (3 647 bez rezerwacji, 638 z rezerwacją), statusu 5 instancja nie używa.
