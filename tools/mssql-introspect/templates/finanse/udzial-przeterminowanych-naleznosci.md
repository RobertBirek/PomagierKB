---
id: udzial-przeterminowanych-naleznosci
title: Udział przeterminowanych należności
area: finanse
order: 60
questions:
  - "Jaki procent naszych należności jest po terminie?"
  - "Ile należności od klientów (bez operatorów płatności) było przeterminowanych na koniec sierpnia 2026, w tym ponad 30 dni?"
params:
  dzien:
    type: date
    description: dzień, na który liczony jest stan (wiek względem tej daty)
    example: 2026-08-31
verified: 2026-09-28
---
Definicja: część otwartych należności (wartościowo i ilościowo), której termin płatności minął na dzień odniesienia (`@dzien`, saldo na koniec tego dnia odtworzone z historii spłat jak KPI 1); osobno dla kontrahentów i operatorów, plus wiersz RAZEM.

Formuła: % wartościowo = Σ saldo PLN na dzień D (termin < D) / Σ saldo PLN na dzień D × 100, saldo odtworzone z historii spłat jak KPI 1 (`nzf_WartoscPierwotnaWaluta` − spłaty z `nzs_Data <= D`, × `nzf_Kurs` / `nzf_LiczbaJednostek`; dla dzisiejszej daty = `nzf_Wartosc`); % ilościowo = liczba rozrachunków po terminie / liczba otwartych × 100; dodatkowo saldo ponad 30 dni po terminie.

Tabele i kolumny: `nz__Finanse` (nzf_Id, nzf_Typ, nzf_TypObiektu, nzf_Data, nzf_IdObiektu, nzf_TerminPlatnosci, nzf_WartoscPierwotnaWaluta, nzf_Kurs, nzf_LiczbaJednostek), `nz_FinanseSplata` (nzs_IdDlugu, nzs_Data, nzs_WartoscWalutaDlugu — saldo na dzień D jak KPI 1), `sl_FormaPlatnosci` (operatorzy).

Kody: `nzf_Typ` 39, `nzf_TypObiektu` 1.

```sql
-- KPI 5: udział przeterminowanych należności (wartościowo i ilościowo) — stan na koniec dnia @dzien
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
  ISNULL(CASE WHEN op.id IS NULL THEN 'kontrahent' ELSE 'operator platnosci' END, 'RAZEM') AS rodzaj_dluznika,
  COUNT(*) AS liczba_rozrachunkow,
  SUM(f.saldo_pln) AS saldo_pln,
  SUM(CASE WHEN f.nzf_TerminPlatnosci < @dzien THEN f.saldo_pln ELSE 0 END) AS przeterminowane_pln,
  ROUND(100.0 * SUM(CASE WHEN f.nzf_TerminPlatnosci < @dzien THEN f.saldo_pln ELSE 0 END)
        / NULLIF(SUM(f.saldo_pln), 0), 2) AS proc_przeterminowanych_wartosciowo,
  SUM(CASE WHEN f.nzf_TerminPlatnosci < @dzien THEN 1 ELSE 0 END) AS liczba_przeterminowanych,
  ROUND(100.0 * SUM(CASE WHEN f.nzf_TerminPlatnosci < @dzien THEN 1 ELSE 0 END) / COUNT(*), 2) AS proc_przeterminowanych_ilosciowo,
  SUM(CASE WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, @dzien) > 30 THEN f.saldo_pln ELSE 0 END) AS przeterminowane_ponad_30_dni_pln
FROM otwarte f
LEFT JOIN (
  SELECT fp_CentId AS id FROM dbo.sl_FormaPlatnosci WHERE fp_CentId IS NOT NULL
  UNION
  SELECT fp_InstKredytId FROM dbo.sl_FormaPlatnosci WHERE fp_InstKredytId IS NOT NULL
) op ON op.id = f.nzf_IdObiektu
GROUP BY ROLLUP(CASE WHEN op.id IS NULL THEN 'kontrahent' ELSE 'operator platnosci' END)
ORDER BY rodzaj_dluznika
```

Pułapki:
- Bez wyłączenia operatorów wskaźnik jest bezużyteczny (90% „przeterminowanych" to wypłaty marketplace'ów z terminem równym dacie dokumentu).
- 1 dzień po terminie liczy się tak samo jak 100 — dlatego kolumna `przeterminowane_ponad_30_dni_pln`; progi alarmowe ustaw na niej.
- Rozrachunki `nzf_Status = 2` (nieściągalne) w instancji nie występują, ale szablon je włącza — dodaj `AND f.nzf_Status = 1`, gdy pojawią się odpisy.
- Rozliczenia częściowe: reszta liczy się jako przeterminowana w całości.
- Konwencja terminu: rozrachunek z terminem równym `@dzien` NIE jest tu po terminie (`nzf_TerminPlatnosci < @dzien`), tak jak w KPI 1 i Top 20 dłużników; aging należności liczy go już do przedziału „B 0-30 dni po terminie" (DATEDIFF = 0) — suma B–E z agingu może być wyższa o rozrachunki z terminem dokładnie D.
- Szablon liczy stan na KONIEC dnia `@dzien` z dat spłat (`nzs_Data` = data dokumentu spłaty), a nie saldo z chwili, w której patrzono do programu. Przykład 2026-09-14: program ok. 10:20 pokazywał 853,9 tys. PLN należności, szablon z `dzien=2026-09-14` daje 101,8 tys. (kontrahenci 59,6 tys., operatorzy 42,2 tys.) — różnica to głównie spłaty z datą 14.09 wprowadzone tego dnia po pomiarze: m.in. 2 379 rozliczeń wypłat operatorów płatności (ok. 724,3 tys. PLN) i 4 spłaty kontrahentów (ok. 70,8 tys.); reszta (ok. +43 tys., niemal cała po stronie operatorów) to przypuszczalnie należności powstałe 14.09 po pomiarze (niezmierzone). Rozkład w `_zasady.md`.

Interpretacja (2026-09-14, saldo w programie ok. 10:20 tego dnia — szablon z `dzien=2026-09-14` da inną liczbę, patrz Pułapki): RAZEM 78,2% wartościowo / 90,6% ilościowo, ale kontrahenci: 12,5% wartościowo (16,3 tys. PLN z 130,1 tys.), 59,2% ilościowo (29 z 49 rozrachunków), ponad 30 dni po terminie 13,4 tys. PLN. Wskaźnik dla kontrahentów mieści się w strefie „OK" (<15%) z katalogu; operatorzy wymagają osobnego progu opartego na dniach od dokumentu (np. > 21 dni = brak wypłaty).
