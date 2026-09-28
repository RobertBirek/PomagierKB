---
id: klienci-hurtowi-vs-detaliczni-wg-flagi-kh-odbdet
title: Klienci hurtowi vs detaliczni wg flagi kh_OdbDet
area: finanse
order: 130
questions:
  - "Jaka część sprzedaży imiennej w ostatnim roku przypada na klientów firmowych (hurtowych), a jaka na detalicznych?"
  - "Ilu klientów hurtowych kupiło u nas w ostatnich 12 miesiącach i ile średnio wydaje jeden klient?"
params:
  od:
    type: date
    description: początek zakresu (włącznie)
    example: 2025-09-14
  do:
    type: date
    description: koniec zakresu (wyłącznie)
    example: 2026-09-14
verified: 2026-09-28
---
Definicja: podział aktywnych klientów z 12 miesięcy na segment „hurtowy" (`kh_OdbDet = 0`, definicja robocza — DO POTWIERDZENIA) i „detaliczny" (`kh_OdbDet = 1`) z liczbą klientów, dokumentów, wartością, średnią wartością dokumentu i liczbą dokumentów z terminem odroczonym.

Formuła: per `dok_PlatnikId` suma dokumentów i brutto w oknie, potem agregacja po `kh_OdbDet` z kartoteki; klienci_min_3_dok = liczba klientów z ≥ 3 dokumentami.

Tabele i kolumny: `dok__Dokument` (dok_PlatnikId, dok_PlatId, dok_WartBrutto …), `kh__Kontrahent` (kh_Id, kh_OdbDet, kh_Osoba).

Kody: `dok_Typ` 2, 21; `dok_Status` 1; bez FS podtyp 1; `kh_OdbDet` 0/1.

```sql
-- KPI 12: klienci hurtowi vs detaliczni wg flagi kh_OdbDet (hurtowy = kh_OdbDet = 0 — DO POTWIERDZENIA)
-- zakres: [@od, @do) — przedział półotwarty
WITH klient AS (
  SELECT d.dok_PlatnikId,
         COUNT(*) AS liczba_dok,
         SUM(d.dok_WartBrutto) AS brutto_pln,
         SUM(CASE WHEN d.dok_PlatId IS NOT NULL THEN 1 ELSE 0 END) AS dok_odroczone
  FROM dbo.dok__Dokument d
  WHERE d.dok_Typ IN (2, 21)
    AND d.dok_Status = 1
    AND NOT (d.dok_Typ = 2 AND d.dok_Podtyp = 1)
    AND d.dok_PlatnikId IS NOT NULL
    AND d.dok_DataWyst >= @od AND d.dok_DataWyst < @do
  GROUP BY d.dok_PlatnikId
)
SELECT
  CASE WHEN k.kh_OdbDet = 0 THEN 'hurtowy (kh_OdbDet = 0) - DO POTWIERDZENIA' ELSE 'detaliczny (kh_OdbDet = 1)' END AS segment,
  COUNT(*) AS liczba_klientow,
  SUM(CASE WHEN c.liczba_dok >= 3 THEN 1 ELSE 0 END) AS klienci_min_3_dok,
  SUM(CASE WHEN k.kh_Osoba = 1 THEN 1 ELSE 0 END) AS w_tym_osoby_fizyczne,
  SUM(c.liczba_dok) AS liczba_dok,
  SUM(c.brutto_pln) AS brutto_pln,
  ROUND(100.0*SUM(c.brutto_pln) / (SELECT SUM(brutto_pln) FROM klient), 2) AS udzial_w_sprzedazy_proc,
  ROUND(SUM(c.brutto_pln) / SUM(c.liczba_dok), 2) AS srednia_wartosc_dok_pln,
  ROUND(SUM(c.brutto_pln) / COUNT(*), 2) AS srednio_na_klienta_pln,
  SUM(c.dok_odroczone) AS dok_z_terminem_odroczonym
FROM klient c
JOIN dbo.kh__Kontrahent k ON k.kh_Id = c.dok_PlatnikId
GROUP BY CASE WHEN k.kh_OdbDet = 0 THEN 'hurtowy (kh_OdbDet = 0) - DO POTWIERDZENIA' ELSE 'detaliczny (kh_OdbDet = 1)' END
ORDER BY segment
```

Pułapki:
- `kh_OdbDet = 0` oznacza w praktyce „nabywca z NIP / firma" (flagę nadaje integrator osobom), a nie „hurtownik" — większość firm kupuje jednorazowo; do potwierdzenia przez właściciela, alternatywy w sekcji o modelu.
- Poziom cen 2 nazywa się „Hurtowa", ale w tej instancji jest poziomem kanału zamówień, nie segmentu (konwencje instancji).
- Strażnik odrzuca `SELECT *` i mnożenie zapisane jako ` * ` w zapytaniach z `kh__Kontrahent` (wzorzec gwiazdki) — pisz `100.0*SUM(...)` bez spacji przed gwiazdką.
- Kolumna `w_tym_osoby_fizyczne` może zwrócić liczbę < 10 — w raportach publikowanych zapisuj ją jako „<10".

Interpretacja (12 miesięcy do 2026-09-13): detaliczni 21 356 klientów, 62,3% sprzedaży imiennej, średni dokument 271 PLN, tylko 28 klientów z ≥ 3 dokumentami, 0 dokumentów z terminem odroczonym; „hurtowi" (kh_OdbDet = 0) 5 742 klientów (osób fizycznych <10), 37,7% sprzedaży, średni dokument 492 PLN, 219 klientów z ≥ 3 dokumentami i 172 dokumenty z terminem odroczonym. Flaga rozdziela B2C od „B2B z NIP", ale prawdziwy segment hurtowy to raczej te 219 firm z powtarzalnymi zakupami i/lub 170 FS z terminem — wymaga decyzji właściciela.
