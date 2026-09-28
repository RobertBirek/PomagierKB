---
id: koncentracja-sprzedazy-wg-klientow-top-10-top-50-hhi
title: Koncentracja sprzedaży wg klientów (Top 10 / Top 50, HHI)
area: finanse
order: 120
questions:
  - "Który klient kupuje u nas najwięcej?"
  - "Jaki procent sprzedaży robi naszych 10 największych klientów?"
  - "Czy jesteśmy uzależnieni od kilku dużych klientów?"
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
Definicja: udział największych klientów (po sumie brutto FS + PA − KFS w okresie) w sprzedaży, podany jako rangi z identyfikatorem kontrahenta (`dok_PlatnikId` = `kh_Id`), bez nazw, z udziałem skumulowanym i indeksem Herfindahla–Hirschmana.

Formuła: udział_i = brutto_i / Σ brutto; udział skumulowany do rangi r; HHI = Σ udział_i² (0 = rozproszenie, 1 = monopol; > 0,25 = niebezpieczna koncentracja).

Tabele i kolumny: `dok__Dokument` (dok_PlatnikId, dok_WartBrutto, dok_Typ, dok_Podtyp, dok_Status, dok_DataWyst).

Kody: `dok_Typ` 2, 6, 21; `dok_Status` 1; bez FS podtyp 1; tylko klienci z dodatnią sumą (HAVING > 0).

```sql
-- KPI 11: koncentracja sprzedaży wg klientów — rangi i id kontrahentów, udział Top 10 / Top 50, HHI (bez nazw)
-- zakres: [@od, @do) — przedział półotwarty
WITH s AS (
  SELECT d.dok_PlatnikId, SUM(d.dok_WartBrutto) AS brutto_pln
  FROM dbo.dok__Dokument d
  WHERE d.dok_Typ IN (2, 6, 21)
    AND d.dok_Status = 1
    AND NOT (d.dok_Typ = 2 AND d.dok_Podtyp = 1)
    AND d.dok_PlatnikId IS NOT NULL
    AND d.dok_DataWyst >= @od AND d.dok_DataWyst < @do
  GROUP BY d.dok_PlatnikId
  HAVING SUM(d.dok_WartBrutto) > 0
), r AS (
  SELECT dok_PlatnikId,
         CAST(brutto_pln AS float) AS brutto_pln,
         ROW_NUMBER() OVER (ORDER BY brutto_pln DESC) AS ranga
  FROM s
), t AS (
  SELECT SUM(brutto_pln) AS razem, COUNT(*) AS liczba_klientow, SUM(POWER(brutto_pln, 2)) AS suma_kwadratow
  FROM r
)
SELECT
  r.ranga,
  r.dok_PlatnikId AS kontrahent_id,
  ROUND(r.brutto_pln, 2) AS brutto_pln,
  ROUND(100.0 * r.brutto_pln / t.razem, 3) AS udzial_proc,
  ROUND(100.0 * (SELECT SUM(r2.brutto_pln) FROM r r2 WHERE r2.ranga <= r.ranga) / t.razem, 2) AS udzial_skumulowany_proc,
  t.liczba_klientow,
  ROUND(t.razem, 2) AS sprzedaz_brutto_pln,
  ROUND(t.suma_kwadratow / POWER(t.razem, 2), 5) AS hhi
FROM r CROSS JOIN t
WHERE r.ranga <= 50
ORDER BY r.ranga
```

Pułapki:
- Klienci powiązani (grupa kapitałowa, kilka `kh_Id` tej samej firmy) są liczeni osobno — koncentracja niedoszacowana.
- KFS przypisane do innego `kh_Id` niż FS (np. korekta na kontrahenta zbiorczego) zaburzają sumy; klienci z ujemną sumą są wykluczeni.
- PA anonimowe nie mają klienta — udziały liczone są względem sprzedaży IMIENNEJ (8,77 mln PLN), nie całej (14,5 mln).
- Na pytanie „który klient" odpowiedzią jest ranga i `kontrahent_id` (`kh_Id`, do odszukania w programie) — nazwy pozostają poza strażnikiem i nie trafiają do odpowiedzi. Udział Top 10 = `udzial_skumulowany_proc` w wierszu rangi 10; HHI jest taki sam w każdym wierszu.

Interpretacja (12 miesięcy do 2026-09-13): 25 235 klientów z dodatnią sprzedażą imienną 8,77 mln PLN; największy ma 2,4% (209 tys.), Top 10 — 6,85%, Top 30 — 9,2%, HHI 0,001. Koncentracja praktycznie zerowa — brak ryzyka zależności od klienta; odwrotna strona: brak dużych kont, które można obsługiwać relacyjnie.
