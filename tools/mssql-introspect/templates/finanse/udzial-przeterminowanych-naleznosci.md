---
id: udzial-przeterminowanych-naleznosci
title: Udział przeterminowanych należności
area: finanse
order: 60
questions:
  - "Jak policzyć: Udział przeterminowanych należności?"
params: {}
verified: 2026-09-14
---
Definicja: część otwartych należności (wartościowo i ilościowo), której termin płatności minął na dzień odniesienia; osobno dla kontrahentów i operatorów, plus wiersz RAZEM.

Formuła: % wartościowo = Σ `nzf_Wartosc` (termin < D) / Σ `nzf_Wartosc` × 100; % ilościowo = liczba rozrachunków po terminie / liczba otwartych × 100; dodatkowo saldo ponad 30 dni po terminie.

Tabele i kolumny: `nz__Finanse` (nzf_TerminPlatnosci, nzf_Wartosc), `sl_FormaPlatnosci` (operatorzy).

Kody: `nzf_Typ` 39, `nzf_TypObiektu` 1.

Szablon SQL:

```sql
-- KPI 5: udział przeterminowanych należności (wartościowo i ilościowo)
-- zakres: zamień datę odniesienia '2026-09-14' (we wszystkich miejscach)
SELECT
  ISNULL(CASE WHEN op.id IS NULL THEN 'kontrahent' ELSE 'operator platnosci' END, 'RAZEM') AS rodzaj_dluznika,
  COUNT(*) AS liczba_rozrachunkow,
  SUM(f.nzf_Wartosc) AS saldo_pln,
  SUM(CASE WHEN f.nzf_TerminPlatnosci < '2026-09-14' THEN f.nzf_Wartosc ELSE 0 END) AS przeterminowane_pln,
  ROUND(100.0 * SUM(CASE WHEN f.nzf_TerminPlatnosci < '2026-09-14' THEN f.nzf_Wartosc ELSE 0 END)
        / NULLIF(SUM(f.nzf_Wartosc), 0), 2) AS proc_przeterminowanych_wartosciowo,
  SUM(CASE WHEN f.nzf_TerminPlatnosci < '2026-09-14' THEN 1 ELSE 0 END) AS liczba_przeterminowanych,
  ROUND(100.0 * SUM(CASE WHEN f.nzf_TerminPlatnosci < '2026-09-14' THEN 1 ELSE 0 END) / COUNT(*), 2) AS proc_przeterminowanych_ilosciowo,
  SUM(CASE WHEN DATEDIFF(day, f.nzf_TerminPlatnosci, '2026-09-14') > 30 THEN f.nzf_Wartosc ELSE 0 END) AS przeterminowane_ponad_30_dni_pln
FROM dbo.nz__Finanse f
LEFT JOIN (
  SELECT fp_CentId AS id FROM dbo.sl_FormaPlatnosci WHERE fp_CentId IS NOT NULL
  UNION
  SELECT fp_InstKredytId FROM dbo.sl_FormaPlatnosci WHERE fp_InstKredytId IS NOT NULL
) op ON op.id = f.nzf_IdObiektu
WHERE f.nzf_Typ = 39
  AND f.nzf_TypObiektu = 1
  AND f.nzf_Wartosc <> 0
GROUP BY ROLLUP(CASE WHEN op.id IS NULL THEN 'kontrahent' ELSE 'operator platnosci' END)
ORDER BY rodzaj_dluznika
```

Test: D = 2026-09-14, 3 wiersze, wykonano 2026-09-14.

Pułapki:
- Bez wyłączenia operatorów wskaźnik jest bezużyteczny (90% „przeterminowanych" to wypłaty marketplace'ów z terminem równym dacie dokumentu).
- 1 dzień po terminie liczy się tak samo jak 100 — dlatego kolumna `przeterminowane_ponad_30_dni_pln`; progi alarmowe ustaw na niej.
- Rozrachunki `nzf_Status = 2` (nieściągalne) w instancji nie występują, ale szablon je włącza — dodaj `AND f.nzf_Status = 1`, gdy pojawią się odpisy.
- Rozliczenia częściowe: reszta liczy się jako przeterminowana w całości.

Interpretacja (2026-09-14): RAZEM 78,2% wartościowo / 90,6% ilościowo, ale kontrahenci: 12,5% wartościowo (16,3 tys. PLN z 130,1 tys.), 59,2% ilościowo (29 z 49 rozrachunków), ponad 30 dni po terminie 13,4 tys. PLN. Wskaźnik dla kontrahentów mieści się w strefie „OK" (<15%) z katalogu; operatorzy wymagają osobnego progu opartego na dniach od dokumentu (np. > 21 dni = brak wypłaty).
