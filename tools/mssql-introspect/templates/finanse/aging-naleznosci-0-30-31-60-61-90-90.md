---
id: aging-naleznosci-0-30-31-60-61-90-90
title: Aging należności (0–30 / 31–60 / 61–90 / 90+)
area: finanse
order: 40
questions:
  - "Ile mamy należności przeterminowanych o ponad 60 dni i jaki to procent wszystkich należności?"
  - "Jak wyglądał wiek należności na koniec sierpnia 2026 — ile było przed terminem, a ile 30, 60 i ponad 90 dni po terminie?"
params:
  dzien:
    type: date
    description: dzień, na który liczony jest stan (wiek względem tej daty)
    example: 2026-08-31
verified: 2026-09-28
---
Definicja: rozkład otwartych należności według liczby dni po terminie płatności na dzień odniesienia, z osobnym przedziałem „przed terminem".

Formuła: dni = DATEDIFF(day, `nzf_TerminPlatnosci`, D), D = `@dzien`; przedziały: < 0 przed terminem; 0–30; 31–60; 61–90; > 90. Udział = saldo przedziału / saldo AR.

Tabele i kolumny: `nz__Finanse` (nzf_TerminPlatnosci, nzf_Wartosc, nzf_IdObiektu), `nz_FinanseSplata` (saldo na dzień D jak KPI 1), `sl_FormaPlatnosci` (operatorzy).

Kody: `nzf_Typ` 39, `nzf_TypObiektu` 1.

```sql
-- KPI 3: aging należności (przedziały dni po terminie) — stan na koniec dnia @dzien
-- saldo odtworzone z historii spłat do @dzien; dla dzisiejszej daty = nzf_Wartosc co do grosza
WITH splaty AS (
  SELECT s.nzs_IdDlugu, SUM(s.nzs_WartoscWalutaDlugu) AS splacono_w_walucie_dlugu
  FROM dbo.nz_FinanseSplata s
  WHERE s.nzs_Data <= @dzien
  GROUP BY s.nzs_IdDlugu
), otwarte AS (
  SELECT n.nzf_IdObiektu, n.nzf_TerminPlatnosci,
         ROUND((n.nzf_WartoscPierwotnaWaluta - ISNULL(sp.splacono_w_walucie_dlugu, 0)) * n.nzf_Kurs / n.nzf_LiczbaJednostek, 2) AS saldo_pln
  FROM dbo.nz__Finanse n
  LEFT JOIN splaty sp ON sp.nzs_IdDlugu = n.nzf_Id
  WHERE n.nzf_Typ = 39
    AND n.nzf_TypObiektu = 1
    AND n.nzf_Data <= @dzien
    AND n.nzf_WartoscPierwotnaWaluta - ISNULL(sp.splacono_w_walucie_dlugu, 0) <> 0
)
SELECT
  CASE WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, @dzien) < 0 THEN 'A przed terminem'
       WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, @dzien) <= 30 THEN 'B 0-30 dni po terminie'
       WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, @dzien) <= 60 THEN 'C 31-60 dni'
       WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, @dzien) <= 90 THEN 'D 61-90 dni'
       ELSE 'E ponad 90 dni' END AS przedzial,
  CASE WHEN op.id IS NULL THEN 'kontrahent' ELSE 'operator platnosci' END AS rodzaj_dluznika,
  COUNT(*) AS liczba_rozrachunkow,
  COUNT(DISTINCT f.nzf_IdObiektu) AS liczba_kontrahentow,
  SUM(f.saldo_pln) AS saldo_pln,
  ROUND(100.0 * SUM(f.saldo_pln) / SUM(SUM(f.saldo_pln)) OVER (), 2) AS udzial_proc
FROM otwarte f
LEFT JOIN (
  SELECT fp_CentId AS id FROM dbo.sl_FormaPlatnosci WHERE fp_CentId IS NOT NULL
  UNION
  SELECT fp_InstKredytId FROM dbo.sl_FormaPlatnosci WHERE fp_InstKredytId IS NOT NULL
) op ON op.id = f.nzf_IdObiektu
GROUP BY
  CASE WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, @dzien) < 0 THEN 'A przed terminem'
       WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, @dzien) <= 30 THEN 'B 0-30 dni po terminie'
       WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, @dzien) <= 60 THEN 'C 31-60 dni'
       WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, @dzien) <= 90 THEN 'D 61-90 dni'
       ELSE 'E ponad 90 dni' END,
  CASE WHEN op.id IS NULL THEN 'kontrahent' ELSE 'operator platnosci' END
ORDER BY przedzial, rodzaj_dluznika
```

Pułapki:
- Aging na datę HISTORYCZNĄ nie może użyć `nzf_Wartosc` (to stan dzisiejszy) — szablon łączy logikę wariantu historycznego z KPI 1 (saldo na dzień D ze spłat) z przedziałami po `nzf_TerminPlatnosci`.
- Stan na przeszły dzień jest odtwarzany z dat spłat (`nzs_Data` = data dokumentu spłaty, np. wyciągu): spłata zaksięgowana później z datą ≤ D obniża saldo wstecz, więc wynik dla przeszłego dnia bywa niższy niż saldo, które program pokazywał tego dnia (2026-09-14: należności odtworzone ok. 101,8 tys. PLN wobec 853,9 tys. w programie — zaległe wyciągi z wypłatami operatorów). Suma przedziałów = saldo z szablonu „Należności otwarte (saldo AR)” dla tego samego dnia.
- „Ponad 60 dni po terminie" = suma przedziałów `D 61-90 dni` i `E ponad 90 dni`; procent = suma ich `udzial_proc` (udział liczony od całego salda, łącznie z operatorami — dla samych kontrahentów podziel przez sumę `saldo_pln` wierszy `kontrahent`).
- Rozliczenia częściowe: rozrachunek trafia do przedziału całym pozostałym saldem, a nie proporcjonalnie.
- Termin płatności należności od operatora = data dokumentu (rozrachunek cesyjny dziedziczy termin dokumentu, DO POTWIERDZENIA), więc operatorzy „przeterminowują się" natychmiast — przedział 0–30 dla operatorów to normalny cykl wypłat, nie zaległość.
- Korekty (`nzf_Korekta = 1`, 32 otwarte) i noty odsetkowe (`nzf_Nota`) wchodzą w przedziały jak zwykłe należności.
- Waluty: saldo w PLN po kursie dokumentu; kontrahent jednorazowy — jak w KPI 1.

Interpretacja (2026-09-14): 77,8% salda AR (664 tys. PLN) leży w przedziale 0–30 dni po terminie i są to niemal wyłącznie operatorzy płatności (2 237 rozrachunków). Należności od kontrahentów: 113,5 tys. przed terminem (19 rozrachunków, 10 kontrahentów), 3,2 tys. w 0–30, 0,9 tys. w 31–60, 1,9 tys. w 61–90 i 10,6 tys. PLN ponad 90 dni (11 rozrachunków, <10 kontrahentów) — realne ryzyko windykacyjne to kilkanaście tysięcy złotych.
