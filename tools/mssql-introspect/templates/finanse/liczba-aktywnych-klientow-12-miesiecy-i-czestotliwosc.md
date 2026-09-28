---
id: liczba-aktywnych-klientow-12-miesiecy-i-czestotliwosc
title: Liczba aktywnych klientów (12 miesięcy) i częstotliwość zakupów
area: finanse
order: 100
questions:
  - "Jak policzyć: Liczba aktywnych klientów (12 miesięcy) i częstotliwość zakupów?"
params:
  od:
    type: date
    description: początek zakresu (włącznie)
    example: 2025-09-14
  do:
    type: date
    description: koniec zakresu (wyłącznie)
    example: 2026-09-14
verified: 2026-09-14
---
Definicja: liczba różnych kontrahentów (`dok_PlatnikId`), którzy mają co najmniej jeden wykonany dokument sprzedaży FS/PA w ostatnich 12 miesiącach, z rozkładem liczby dokumentów na klienta.

Formuła: aktywni = COUNT(DISTINCT `dok_PlatnikId`) w oknie; segmenty: 1 dokument, 2–3, 4–9, 10+; udział segmentu w sprzedaży brutto.

Tabele i kolumny: `dok__Dokument` (dok_PlatnikId, dok_Typ, dok_Podtyp, dok_Status, dok_DataWyst, dok_WartBrutto).

Kody: `dok_Typ` 2, 21; `dok_Status` 1; bez FS podtyp 1.

```sql
-- KPI 9: liczba aktywnych klientów (kupili w ostatnich 12 miesiącach) i częstotliwość zakupów
-- zakres: [@od, @do) — przedział półotwarty
WITH klient AS (
  SELECT d.dok_PlatnikId, COUNT(*) AS liczba_dok, SUM(d.dok_WartBrutto) AS brutto_pln
  FROM dbo.dok__Dokument d
  WHERE d.dok_Typ IN (2, 21)
    AND d.dok_Status = 1
    AND NOT (d.dok_Typ = 2 AND d.dok_Podtyp = 1)
    AND d.dok_PlatnikId IS NOT NULL
    AND d.dok_DataWyst >= @od AND d.dok_DataWyst < @do
  GROUP BY d.dok_PlatnikId
)
SELECT
  ISNULL(CASE WHEN liczba_dok = 1 THEN 'A 1 dokument'
              WHEN liczba_dok <= 3 THEN 'B 2-3 dokumenty'
              WHEN liczba_dok <= 9 THEN 'C 4-9 dokumentow'
              ELSE 'D 10 i wiecej dokumentow' END, 'Z RAZEM aktywni klienci') AS czestotliwosc_zakupow,
  COUNT(*) AS liczba_klientow,
  SUM(liczba_dok) AS liczba_dok,
  SUM(brutto_pln) AS brutto_pln,
  ROUND(100.0 * SUM(brutto_pln) / (SELECT SUM(brutto_pln) FROM klient), 2) AS udzial_w_sprzedazy_proc,
  ROUND(SUM(brutto_pln) / COUNT(*), 2) AS srednio_na_klienta_pln
FROM klient
GROUP BY ROLLUP(CASE WHEN liczba_dok = 1 THEN 'A 1 dokument'
                     WHEN liczba_dok <= 3 THEN 'B 2-3 dokumenty'
                     WHEN liczba_dok <= 9 THEN 'C 4-9 dokumentow'
                     ELSE 'D 10 i wiecej dokumentow' END)
ORDER BY czestotliwosc_zakupow
```

Pułapki:
- PA anonimowe (bez `dok_PlatnikId`) nie liczą się jako klient — do 02.2026 to była większość sprzedaży detalicznej; okno 12 miesięcy mieszające oba reżimy zaniża liczbę klientów sprzed marca 2026.
- Integrator zakłada nowego kontrahenta niemal per zamówienie — ten sam człowiek może być kilkoma `kh_Id`; deduplikacja po e-mailu/NIP jest poza zakresem strażnika (dane osobowe) i wymaga zgody właściciela.
- Kontrahent jednorazowy (`kh_Jednorazowy`) liczy się jak każdy inny `kh_Id`.
- KFS nie są liczone jako aktywność (klient ze zwrotem bez zakupu nie jest „aktywny"); do wartości segmentu nie wchodzą korekty — dla sprzedaży netto korekt użyj KPI 11.

Interpretacja (12 miesięcy do 2026-09-13): 27 098 aktywnych klientów, z czego 26 070 (96,2%) z jednym dokumentem — dają 80,5% sprzedaży (średnio 291 PLN); 924 klientów z 2–3 dokumentami (10,9%), 91 z 4–9 (3,6%), 13 z 10 i więcej (5,1% sprzedaży, średnio 36,9 tys. PLN na klienta). Baza to jednorazowi kupujący B2C; grupa 10+ to kandydaci na relację hurtową (por. KPI 12).
