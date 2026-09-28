---
id: saldo-naleznosci-na-dzien-wg-waluty
title: Saldo należności na dzień wg waluty (z historii spłat)
area: finanse
order: 20
questions:
  - "Jakie było saldo należności w euro, koronach i forintach na koniec czerwca 2026?"
params:
  dzien:
    type: date
    description: dzień, na który liczony jest stan (koniec tego dnia)
    example: 2025-12-31
verified: 2026-09-28
---
Definicja: suma pozostałej do zapłaty wartości wszystkich nierozliczonych należności od kontrahentów na koniec wskazanego dnia, w podziale na waluty.

Formuła: saldo na dzień D: Σ (`nzf_WartoscPierwotnaWaluta` − Σ spłat do D) dla rozrachunków z `nzf_Data <= D`; w PLN po kursie rozrachunku (`nzf_Kurs` / `nzf_LiczbaJednostek`).

Tabele i kolumny: `nz__Finanse` (nzf_Id, nzf_Typ, nzf_Data, nzf_WartoscPierwotnaWaluta, nzf_Kurs, nzf_LiczbaJednostek, nzf_IdWaluty, nzf_TypObiektu, nzf_IdObiektu), `nz_FinanseSplata` (nzs_IdDlugu, nzs_Data, nzs_WartoscWalutaDlugu).

Kody: `nzf_Typ` 39; źródłowe `dok_Typ` 2 (FS), 21 (PA), 5 (KFZ — należność od dostawcy). Podział na kontrahentów i operatorów płatności oraz część po terminie na ten sam dzień daje szablon „Należności otwarte (saldo AR)” (`naleznosci-otwarte-saldo-ar`).

```sql
-- KPI 1 (wariant historyczny): saldo należności na koniec dnia D odtworzone z historii spłat
-- stan na koniec dnia @dzien
WITH splaty AS (
  SELECT s.nzs_IdDlugu, SUM(s.nzs_WartoscWalutaDlugu) AS splacono_w_walucie_dlugu
  FROM dbo.nz_FinanseSplata s
  WHERE s.nzs_Data <= @dzien
  GROUP BY s.nzs_IdDlugu
)
SELECT
  f.nzf_IdWaluty AS waluta,
  COUNT(*) AS liczba_rozrachunkow_otwartych,
  COUNT(DISTINCT f.nzf_IdObiektu) AS liczba_kontrahentow,
  SUM(f.nzf_WartoscPierwotnaWaluta - ISNULL(sp.splacono_w_walucie_dlugu, 0)) AS saldo_w_walucie,
  SUM((f.nzf_WartoscPierwotnaWaluta - ISNULL(sp.splacono_w_walucie_dlugu, 0)) * f.nzf_Kurs / f.nzf_LiczbaJednostek) AS saldo_pln_po_kursie_rozrachunku
FROM dbo.nz__Finanse f
LEFT JOIN splaty sp ON sp.nzs_IdDlugu = f.nzf_Id
WHERE f.nzf_Typ = 39
  AND f.nzf_TypObiektu = 1
  AND f.nzf_Data <= @dzien
  AND f.nzf_WartoscPierwotnaWaluta - ISNULL(sp.splacono_w_walucie_dlugu, 0) <> 0
GROUP BY f.nzf_IdWaluty
ORDER BY waluta
```

Pułapki:
- Rozrachunki rozliczone częściowo: do salda liczy się reszta (`nzf_WartoscPierwotnaWaluta` minus spłaty do D), nie wartość pierwotna.
- Korekty: KFZ (`dok_Typ` 5) tworzy należność od DOSTAWCY — w AR „od klientów" trzeba ją odjąć lub pokazać osobno (grupowanie po `dok_Typ` źródłowym jak w KPI 2).
- Paragony bez rozrachunku: PA anonimowe mają rozrachunek „dla nieznanego" (`nzf_TypObiektu = 0`) rozliczony automatycznie — filtr `nzf_TypObiektu = 1` je pomija; nie są należnością.
- Waluty: `saldo_pln_po_kursie_rozrachunku` jest w PLN po kursie rozrachunku; `saldo_w_walucie` pokazuje kwotę w walucie (CZK/EUR/HUF). Wycena bilansowa wymaga kursu na dzień, nie kursu z dokumentu.
- Kontrahent jednorazowy (`kh_Jednorazowy = 1`, 384 w kartotece) nie ma otwartych należności w instancji; gdyby miał, `liczba_kontrahentow` liczy go raz per `kh_Id`.
- Wariant historyczny nie uwzględnia rozrachunków usuniętych i zmian statusu na „nieściągalny" po dniu D.
- Szablon liczy stan na KONIEC dnia `@dzien` z dat spłat (`nzs_Data` = data dokumentu spłaty), a nie saldo z chwili, w której patrzono do programu. Przykład 2026-09-14: program ok. 10:20 pokazywał 853,9 tys. PLN należności, szablon z `dzien=2026-09-14` daje 101,8 tys. (kontrahenci 59,6 tys., operatorzy 42,2 tys.) — różnica to głównie spłaty z datą 14.09 wprowadzone tego dnia po pomiarze: m.in. 2 379 rozliczeń wypłat operatorów płatności (ok. 724,3 tys. PLN) i 4 spłaty kontrahentów (ok. 70,8 tys.); reszta (ok. +43 tys., niemal cała po stronie operatorów) to przypuszczalnie należności powstałe 14.09 po pomiarze (niezmierzone). Rozkład w `_zasady.md`.
- Ten sam zbiór rozrachunków co szablon „Należności otwarte (saldo AR)” (reszta `<> 0`, więc także ujemne reszty, np. nadpłaty) — różnica sum to wyłącznie zaokrąglenie: tu saldo PLN jest sumą niezaokrąglonych przeliczeń, AR zaokrągla każdy rozrachunek do grosza jak program. Na pytanie o saldo ogółem, podział kontrahent/operator albo część po terminie używaj AR; ten szablon — do podziału na waluty.

Interpretacja (stan na 2025-12-31, odtworzony 2026-09-28): 161,0 tys. PLN w 78 rozrachunkach od 24 kontrahentów, wyłącznie w PLN i bez należności od operatorów płatności (operatorzy stali się istotni dopiero od 02–03.2026, gdy sprzedaż z zamówień przeszła na FS z płatnikiem). Porównanie z bieżącym saldem ma sens tylko w części „kontrahent” szablonu „Należności otwarte (saldo AR)”.
