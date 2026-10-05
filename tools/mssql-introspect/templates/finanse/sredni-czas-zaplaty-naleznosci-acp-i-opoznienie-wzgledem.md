---
id: sredni-czas-zaplaty-naleznosci-acp-i-opoznienie-wzgledem
title: Średni czas zapłaty należności (ACP) i opóźnienie względem terminu
area: finanse
order: 140
questions:
  - "Po ilu dniach średnio klienci płacą nam faktury i o ile spóźniają się względem terminu?"
  - "Ile dni czekamy na wypłaty od operatorów płatności (Allegro Finance, PayU, Przelewy24)?"
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
Definicja: średnia liczba dni od daty rozrachunku (= data dokumentu) do daty spłaty dla należności rozliczonych w okresie, z pominięciem rozliczeń automatycznych przy wystawianiu (gotówka, cesja karty); dodatkowo średnie opóźnienie względem terminu i odsetek rozliczeń po terminie; osobno kontrahenci i operatorzy.

Formuła: ACP = AVG(DATEDIFF(day, `nzf_Data`, `nzs_Data`)); wariant ważony wartością: Σ(dni × wartość_PLN) / Σ wartość_PLN, gdzie wartość_PLN = `nzs_WartoscWalutaDlugu` × `nzf_Kurs` / `nzf_LiczbaJednostek`; opóźnienie = AVG(DATEDIFF(day, `nzf_TerminPlatnosci`, `nzs_Data`)).

Tabele i kolumny: `nz_FinanseSplata` (nzs_IdDlugu, nzs_Data, nzs_Auto, nzs_WartoscWalutaDlugu), `nz__Finanse` (nzf_Data, nzf_TerminPlatnosci, nzf_Kurs, nzf_LiczbaJednostek, nzf_IdObiektu), `sl_FormaPlatnosci` (operatorzy).

Kody: `nzf_Typ` 39; `nzs_Auto` 0; okres po `nzs_Data`.

```sql
-- KPI 13: średni czas zapłaty należności (ACP) i średnie opóźnienie względem terminu — z rozliczeń spłat
-- zakres: [@od, @do) — przedział półotwarty
WITH op AS (
  SELECT fp_CentId AS id FROM dbo.sl_FormaPlatnosci WHERE fp_CentId IS NOT NULL
  UNION
  SELECT fp_InstKredytId FROM dbo.sl_FormaPlatnosci WHERE fp_InstKredytId IS NOT NULL
), x AS (
  SELECT
    CASE WHEN op.id IS NULL THEN 'kontrahent' ELSE 'operator platnosci' END AS rodzaj_platnika,
    s.nzs_IdDlugu,
    DATEDIFF(day, d.nzf_Data, s.nzs_Data) AS dni_od_wystawienia,
    DATEDIFF(day, d.nzf_TerminPlatnosci, s.nzs_Data) AS dni_wzgledem_terminu,
    s.nzs_WartoscWalutaDlugu * d.nzf_Kurs / d.nzf_LiczbaJednostek AS wartosc_pln
  FROM dbo.nz_FinanseSplata s
  JOIN dbo.nz__Finanse d ON d.nzf_Id = s.nzs_IdDlugu
  LEFT JOIN op ON op.id = d.nzf_IdObiektu
  WHERE s.nzs_Auto = 0
    AND s.nzs_Data >= @od AND s.nzs_Data < @do
    AND d.nzf_Typ = 39
    AND d.nzf_TypObiektu = 1
)
SELECT
  rodzaj_platnika,
  COUNT(*) AS liczba_rozliczen,
  COUNT(DISTINCT nzs_IdDlugu) AS liczba_rozrachunkow,
  ROUND(SUM(wartosc_pln), 2) AS splacono_pln_po_kursie_rozrachunku,
  ROUND(AVG(CAST(dni_od_wystawienia AS float)), 1) AS sredni_czas_zaplaty_dni,
  ROUND(SUM(dni_od_wystawienia * wartosc_pln) / NULLIF(SUM(wartosc_pln), 0), 1) AS sredni_czas_zaplaty_wazony_dni,
  ROUND(AVG(CAST(dni_wzgledem_terminu AS float)), 1) AS srednie_opoznienie_wzgledem_terminu_dni,
  ROUND(100.0 * SUM(CASE WHEN dni_wzgledem_terminu > 0 THEN 1 ELSE 0 END) / COUNT(*), 2) AS proc_rozliczen_po_terminie,
  MAX(dni_od_wystawienia) AS max_dni
FROM x
GROUP BY rodzaj_platnika
ORDER BY rodzaj_platnika
```

Pułapki:
- Bias przeżycia: należności wciąż niezapłacone nie wchodzą do średniej (katalog N7) — czytaj razem z agingiem (KPI 3).
- Rozliczenia częściowe: jeden rozrachunek daje kilka wierszy spłat (1 382 rozliczeń na 1 370 rozrachunków) — wariant ważony wartością jest odporny, prosta średnia lekko faworyzuje długi płacone ratami.
- Kompensaty (`nzs_Typ = 4`) i korekty (`nzs_Typ = 6`) liczą się jako „zapłata" w dniu skojarzenia; wyklucz je filtrem `nzs_Typ = 1`, jeśli interesuje wyłącznie gotówka.
- Wartości odstające: max 3 030 dni (rozrachunek z 2018 r. rozliczony w oknie) zawyża prostą średnią; mediana wymaga PERCENTILE_CONT.
- Operatorzy „po terminie" w 83% — bo termin = data dokumentu; ich miarą jest `sredni_czas_zaplaty_dni`, nie opóźnienie.
- Waluty: wagi liczone po kursie rozrachunku, nie po kursie dnia spłaty.

Interpretacja (spłaty z 12 miesięcy do 2026-09-13): kontrahenci — 1 382 rozliczeń, 3,89 mln PLN, średni czas zapłaty 23,9 dnia (ważony wartością 14,2 — duże faktury płacone szybciej), średnie opóźnienie względem terminu 6,5 dnia, 59% rozliczeń po terminie; operatorzy — 20 596 rozliczeń, 6,05 mln PLN, średnio 5,9 dnia od dokumentu do wpływu. Cykl wypłat operatorów (ok. 6 dni) jest krótszy niż kredyt kupiecki (14–24 dni), co potwierdza wniosek z KPI 6.
