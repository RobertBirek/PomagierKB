---
id: aging-naleznosci-0-30-31-60-61-90-90
title: Aging należności (0–30 / 31–60 / 61–90 / 90+)
area: finanse
order: 40
questions:
  - "Jak policzyć: Aging należności (0–30 / 31–60 / 61–90 / 90+)?"
params: {}
verified: 2026-09-14
---
Definicja: rozkład otwartych należności według liczby dni po terminie płatności na dzień odniesienia, z osobnym przedziałem „przed terminem".

Formuła: dni = DATEDIFF(day, `nzf_TerminPlatnosci`, D); przedziały: < 0 przed terminem; 0–30; 31–60; 61–90; > 90. Udział = saldo przedziału / saldo AR.

Tabele i kolumny: `nz__Finanse` (nzf_TerminPlatnosci, nzf_Wartosc, nzf_IdObiektu), `sl_FormaPlatnosci` (operatorzy).

Kody: `nzf_Typ` 39, `nzf_TypObiektu` 1.

Szablon SQL:

```sql
-- KPI 3: aging należności (przedziały dni po terminie) — stan bieżący
-- zakres: zamień datę odniesienia '2026-09-14' (we wszystkich miejscach)
SELECT
  CASE WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, '2026-09-14') < 0 THEN 'A przed terminem'
       WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, '2026-09-14') <= 30 THEN 'B 0-30 dni po terminie'
       WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, '2026-09-14') <= 60 THEN 'C 31-60 dni'
       WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, '2026-09-14') <= 90 THEN 'D 61-90 dni'
       ELSE 'E ponad 90 dni' END AS przedzial,
  CASE WHEN op.id IS NULL THEN 'kontrahent' ELSE 'operator platnosci' END AS rodzaj_dluznika,
  COUNT(*) AS liczba_rozrachunkow,
  COUNT(DISTINCT f.nzf_IdObiektu) AS liczba_kontrahentow,
  SUM(f.nzf_Wartosc) AS saldo_pln,
  ROUND(100.0 * SUM(f.nzf_Wartosc) / SUM(SUM(f.nzf_Wartosc)) OVER (), 2) AS udzial_proc
FROM dbo.nz__Finanse f
LEFT JOIN (
  SELECT fp_CentId AS id FROM dbo.sl_FormaPlatnosci WHERE fp_CentId IS NOT NULL
  UNION
  SELECT fp_InstKredytId FROM dbo.sl_FormaPlatnosci WHERE fp_InstKredytId IS NOT NULL
) op ON op.id = f.nzf_IdObiektu
WHERE f.nzf_Typ = 39
  AND f.nzf_TypObiektu = 1
  AND f.nzf_Wartosc <> 0
GROUP BY
  CASE WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, '2026-09-14') < 0 THEN 'A przed terminem'
       WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, '2026-09-14') <= 30 THEN 'B 0-30 dni po terminie'
       WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, '2026-09-14') <= 60 THEN 'C 31-60 dni'
       WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, '2026-09-14') <= 90 THEN 'D 61-90 dni'
       ELSE 'E ponad 90 dni' END,
  CASE WHEN op.id IS NULL THEN 'kontrahent' ELSE 'operator platnosci' END
ORDER BY przedzial, rodzaj_dluznika
```

Test: D = 2026-09-14, 8 wierszy, wykonano 2026-09-14.

Pułapki:
- Aging na datę HISTORYCZNĄ nie może użyć `nzf_Wartosc` (to stan dzisiejszy) — trzeba połączyć logikę wariantu historycznego z KPI 1 (saldo na dzień D ze spłat) z przedziałami po `nzf_TerminPlatnosci`.
- Rozliczenia częściowe: rozrachunek trafia do przedziału całym pozostałym saldem, a nie proporcjonalnie.
- Termin płatności należności od operatora = data dokumentu (rozrachunek cesyjny dziedziczy termin dokumentu, DO POTWIERDZENIA), więc operatorzy „przeterminowują się" natychmiast — przedział 0–30 dla operatorów to normalny cykl wypłat, nie zaległość.
- Korekty (`nzf_Korekta = 1`, 32 otwarte) i noty odsetkowe (`nzf_Nota`) wchodzą w przedziały jak zwykłe należności.
- Waluty: saldo w PLN po kursie dokumentu; kontrahent jednorazowy — jak w KPI 1.

Interpretacja (2026-09-14): 77,8% salda AR (664 tys. PLN) leży w przedziale 0–30 dni po terminie i są to niemal wyłącznie operatorzy płatności (2 237 rozrachunków). Należności od kontrahentów: 113,5 tys. przed terminem (19 rozrachunków, 10 kontrahentów), 3,2 tys. w 0–30, 0,9 tys. w 31–60, 1,9 tys. w 61–90 i 10,6 tys. PLN ponad 90 dni (11 rozrachunków, <10 kontrahentów) — realne ryzyko windykacyjne to kilkanaście tysięcy złotych.
