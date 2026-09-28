---
id: aging-zobowiazan
title: Aging zobowiązań
area: finanse
order: 50
questions:
  - "Ile faktur od dostawców mamy nieopłaconych po terminie i jak dawno minął termin?"
  - "Jak wyglądał wiek naszych zobowiązań na koniec sierpnia 2026?"
params:
  dzien:
    type: date
    description: dzień, na który liczony jest stan (wiek względem tej daty)
    example: 2026-08-31
verified: 2026-09-28
---
Definicja: rozkład otwartych zobowiązań według dni po terminie płatności, z podziałem na dostawców i zwroty dla klientów.

Formuła: jak KPI 3 dla `nzf_Typ = 40` (stan na koniec dnia D = `@dzien`, saldo odtworzone z historii spłat).

Tabele i kolumny: `nz__Finanse`, `nz_FinanseSplata` (saldo na dzień D), `dok__Dokument` (dok_Typ źródłowy).

Kody: `nzf_Typ` 40; `dok_Typ` 1/5 = dostawca, 6/14 = klient (zwrot), NULL = ręczny.

```sql
-- KPI 4: aging zobowiązań (przedziały dni po terminie) — stan na koniec dnia @dzien
-- saldo odtworzone z historii spłat do @dzien; dla dzisiejszej daty = nzf_Wartosc co do grosza
WITH splaty AS (
  SELECT s.nzs_IdDlugu, SUM(s.nzs_WartoscWalutaDlugu) AS splacono_w_walucie_dlugu
  FROM dbo.nz_FinanseSplata s
  WHERE s.nzs_Data <= @dzien
  GROUP BY s.nzs_IdDlugu
), otwarte AS (
  SELECT n.nzf_IdObiektu, n.nzf_TerminPlatnosci, n.nzf_IdDokumentAuto,
         ROUND((n.nzf_WartoscPierwotnaWaluta - ISNULL(sp.splacono_w_walucie_dlugu, 0)) * n.nzf_Kurs / n.nzf_LiczbaJednostek, 2) AS saldo_pln
  FROM dbo.nz__Finanse n
  LEFT JOIN splaty sp ON sp.nzs_IdDlugu = n.nzf_Id
  WHERE n.nzf_Typ = 40
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
  CASE WHEN d.dok_Typ IN (1, 5) OR d.dok_Typ IS NULL THEN 'dostawca / reczny'
       WHEN d.dok_Typ IN (6, 14) THEN 'klient (zwrot)'
       ELSE 'inny' END AS rodzaj_wierzyciela,
  COUNT(*) AS liczba_rozrachunkow,
  COUNT(DISTINCT f.nzf_IdObiektu) AS liczba_kontrahentow,
  SUM(f.saldo_pln) AS saldo_pln,
  ROUND(100.0 * SUM(f.saldo_pln) / SUM(SUM(f.saldo_pln)) OVER (), 2) AS udzial_proc
FROM otwarte f
LEFT JOIN dbo.dok__Dokument d ON d.dok_Id = f.nzf_IdDokumentAuto
GROUP BY
  CASE WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, @dzien) < 0 THEN 'A przed terminem'
       WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, @dzien) <= 30 THEN 'B 0-30 dni po terminie'
       WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, @dzien) <= 60 THEN 'C 31-60 dni'
       WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, @dzien) <= 90 THEN 'D 61-90 dni'
       ELSE 'E ponad 90 dni' END,
  CASE WHEN d.dok_Typ IN (1, 5) OR d.dok_Typ IS NULL THEN 'dostawca / reczny'
       WHEN d.dok_Typ IN (6, 14) THEN 'klient (zwrot)'
       ELSE 'inny' END
ORDER BY przedzial, rodzaj_wierzyciela
```

Pułapki:
- Świadome opóźnienie płatności (negocjowany termin) vs. przeterminowanie wbrew umowie są nieodróżnialne w danych — trzeba porównać z `dok_PlatTermin` na FZ i ustaleniami z dostawcą.
- Zobowiązania z KFZ zmniejszającej (należność od dostawcy) nie są tu widoczne — saldo netto z dostawcą = KPI 2 minus KFZ z KPI 1.
- Rozliczenia częściowe i kompensaty jak w KPI 2 i 3.
- Stan na przeszły dzień jest odtwarzany z dat spłat (`nzs_Data` = data dokumentu spłaty, np. wyciągu): spłata zaksięgowana później z datą ≤ D obniża saldo wstecz, więc wynik dla przeszłego dnia może różnić się od salda, które program pokazywał tego dnia (2026-09-14: należności odtworzone ok. 101,8 tys. PLN wobec 853,9 tys. w programie — zaległe wyciągi z wypłatami operatorów). Suma przedziałów = saldo z szablonu „Zobowiązania otwarte (saldo AP)” dla tego samego dnia.
- Od 03.2026 zwroty detaliczne są dokumentowane korektą KFS zamiast ZW (potwierdzone przez właściciela 2026-09-28) — wiersz `klient (zwrot)` obejmuje oba typy, więc nie wymaga korekty.

Interpretacja (2026-09-14): 82,5% zobowiązań (862 tys. PLN, 329 rozrachunków, 27 dostawców) jest przed terminem; po terminie: 76,4 tys. w 0–30 dni i 99,7 tys. w 31–60 dni (po <10 dostawców w każdym przedziale — pojedyncze faktury), 4,1 tys. ponad 90 dni. Zwroty dla klientów: 3,3 tys. PLN, w większości ponad 30 dni po terminie.
