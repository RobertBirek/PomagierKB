---
id: aging-zobowiazan
title: Aging zobowiązań
area: finanse
order: 50
questions:
  - "Jak policzyć: Aging zobowiązań?"
params: {}
verified: 2026-09-14
---
Definicja: rozkład otwartych zobowiązań według dni po terminie płatności, z podziałem na dostawców i zwroty dla klientów.

Formuła: jak KPI 3 dla `nzf_Typ = 40`.

Tabele i kolumny: `nz__Finanse`, `dok__Dokument` (dok_Typ źródłowy).

Kody: `nzf_Typ` 40; `dok_Typ` 1/5 = dostawca, 6/14 = klient (zwrot), NULL = ręczny.

Szablon SQL:

```sql
-- KPI 4: aging zobowiązań (przedziały dni po terminie) — stan bieżący
-- zakres: zamień datę odniesienia '2026-09-14' (we wszystkich miejscach)
SELECT
  CASE WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, '2026-09-14') < 0 THEN 'A przed terminem'
       WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, '2026-09-14') <= 30 THEN 'B 0-30 dni po terminie'
       WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, '2026-09-14') <= 60 THEN 'C 31-60 dni'
       WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, '2026-09-14') <= 90 THEN 'D 61-90 dni'
       ELSE 'E ponad 90 dni' END AS przedzial,
  CASE WHEN d.dok_Typ IN (1, 5) OR d.dok_Typ IS NULL THEN 'dostawca / reczny'
       WHEN d.dok_Typ IN (6, 14) THEN 'klient (zwrot)'
       ELSE 'inny' END AS rodzaj_wierzyciela,
  COUNT(*) AS liczba_rozrachunkow,
  COUNT(DISTINCT f.nzf_IdObiektu) AS liczba_kontrahentow,
  SUM(f.nzf_Wartosc) AS saldo_pln,
  ROUND(100.0 * SUM(f.nzf_Wartosc) / SUM(SUM(f.nzf_Wartosc)) OVER (), 2) AS udzial_proc
FROM dbo.nz__Finanse f
LEFT JOIN dbo.dok__Dokument d ON d.dok_Id = f.nzf_IdDokumentAuto
WHERE f.nzf_Typ = 40
  AND f.nzf_TypObiektu = 1
  AND f.nzf_Wartosc <> 0
GROUP BY
  CASE WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, '2026-09-14') < 0 THEN 'A przed terminem'
       WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, '2026-09-14') <= 30 THEN 'B 0-30 dni po terminie'
       WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, '2026-09-14') <= 60 THEN 'C 31-60 dni'
       WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, '2026-09-14') <= 90 THEN 'D 61-90 dni'
       ELSE 'E ponad 90 dni' END,
  CASE WHEN d.dok_Typ IN (1, 5) OR d.dok_Typ IS NULL THEN 'dostawca / reczny'
       WHEN d.dok_Typ IN (6, 14) THEN 'klient (zwrot)'
       ELSE 'inny' END
ORDER BY przedzial, rodzaj_wierzyciela
```

Test: D = 2026-09-14, 8 wierszy, wykonano 2026-09-14.

Pułapki:
- Świadome opóźnienie płatności (negocjowany termin) vs. przeterminowanie wbrew umowie są nieodróżnialne w danych — trzeba porównać z `dok_PlatTermin` na FZ i ustaleniami z dostawcą.
- Zobowiązania z KFZ zmniejszającej (należność od dostawcy) nie są tu widoczne — saldo netto z dostawcą = KPI 2 minus KFZ z KPI 1.
- Rozliczenia częściowe i kompensaty jak w KPI 2 i 3.

Interpretacja (2026-09-14): 82,5% zobowiązań (862 tys. PLN, 329 rozrachunków, 27 dostawców) jest przed terminem; po terminie: 76,4 tys. w 0–30 dni i 99,7 tys. w 31–60 dni (po <10 dostawców w każdym przedziale — pojedyncze faktury), 4,1 tys. ponad 90 dni. Zwroty dla klientów: 3,3 tys. PLN, w większości ponad 30 dni po terminie.
