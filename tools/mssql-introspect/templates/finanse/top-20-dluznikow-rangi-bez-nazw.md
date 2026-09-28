---
id: top-20-dluznikow-rangi-bez-nazw
title: Top N dłużników (rangi, bez nazw)
area: finanse
order: 150
questions:
  - "Kto najwięcej nam zalega z płatnościami?"
  - "Ile zalega nasz największy dłużnik i od ilu dni jest po terminie?"
  - "Pokaż 10 największych dłużników na koniec sierpnia 2026."
params:
  dzien:
    type: date
    description: dzień, na który liczony jest stan (wiek względem tej daty)
    example: 2026-08-31
  n:
    type: int
    description: liczba dłużników w rankingu (TOP N, ≥ 1)
    required: false
    default: 20
    example: 20
verified: 2026-09-28
---
Definicja: N (domyślnie 20) kontrahentów z największym otwartym saldem należności na dzień odniesienia (`@dzien`, saldo na koniec tego dnia odtworzone z historii spłat jak KPI 1), z kwotą po terminie, maksymalnym opóźnieniem i identyfikatorem kontrahenta (bez nazwy).

Formuła: per `nzf_IdObiektu`: Σ `nzf_Wartosc`, Σ po terminie, MAX dni po terminie, MIN terminu; ranga po saldzie malejąco.

Tabele i kolumny: `nz__Finanse` (nzf_IdObiektu, nzf_Wartosc, nzf_TerminPlatnosci), `nz_FinanseSplata` (saldo na dzień D), `sl_FormaPlatnosci` (operatorzy). Nazwa kontrahenta jest w `adr__Ewid`/`kh__Kontrahent` — poza strażnikiem; identyfikator wystarcza do odszukania w programie.

Kody: `nzf_Typ` 39; `nzf_TypObiektu` 1.

```sql
-- KPI 14: Top N dłużników (rangi i identyfikatory kontrahentów, bez nazw) — stan na koniec dnia @dzien
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
SELECT TOP (@n)
  ROW_NUMBER() OVER (ORDER BY SUM(f.saldo_pln) DESC) AS ranga,
  f.nzf_IdObiektu AS kontrahent_id,
  CASE WHEN op.id IS NULL THEN 'kontrahent' ELSE 'operator platnosci' END AS rodzaj_dluznika,
  COUNT(*) AS liczba_rozrachunkow,
  SUM(f.saldo_pln) AS saldo_pln,
  SUM(CASE WHEN f.nzf_TerminPlatnosci < @dzien THEN f.saldo_pln ELSE 0 END) AS po_terminie_pln,
  MAX(CASE WHEN f.nzf_TerminPlatnosci < @dzien THEN DATEDIFF(day, f.nzf_TerminPlatnosci, @dzien) ELSE 0 END) AS max_dni_po_terminie,
  MIN(f.nzf_TerminPlatnosci) AS najstarszy_termin
FROM otwarte f
LEFT JOIN (
  SELECT fp_CentId AS id FROM dbo.sl_FormaPlatnosci WHERE fp_CentId IS NOT NULL
  UNION
  SELECT fp_InstKredytId FROM dbo.sl_FormaPlatnosci WHERE fp_InstKredytId IS NOT NULL
) op ON op.id = f.nzf_IdObiektu
GROUP BY f.nzf_IdObiektu, CASE WHEN op.id IS NULL THEN 'kontrahent' ELSE 'operator platnosci' END
ORDER BY saldo_pln DESC
```

Pułapki:
- Operatorzy płatności zajmują czołowe rangi — lista windykacyjna wymaga filtra `WHERE op.id IS NULL` (lub osobnego raportu „wypłaty operatorów do uzgodnienia").
- Saldo netto z kontrahentem (należności minus zobowiązania, katalog N11) wymaga dołączenia typu 40 — dłużnik z KFS do wypłaty ma w rzeczywistości mniejsze saldo.
- Klienci powiązani (kilka `kh_Id`) rozmywają ranking.
- Na pytanie „kto" odpowiedzią jest ranga, rodzaj dłużnika i `kontrahent_id` (do odszukania w programie) — nigdy nazwa.
- Rozliczenia częściowe: `saldo_pln` to reszta, `liczba_rozrachunkow` — liczba otwartych pozycji, nie faktur wystawionych.
- Lista zawiera identyfikatory kontrahentów; nie łącz jej z nazwami w dokumentach publikowanych w bazie wiedzy.
- Stan na przeszły dzień jest odtwarzany z dat spłat (`nzs_Data` = data dokumentu spłaty, np. wyciągu): spłata zaksięgowana później z datą ≤ D obniża saldo wstecz, więc wynik dla przeszłego dnia może różnić się od salda, które program pokazywał tego dnia (2026-09-14: należności odtworzone ok. 101,8 tys. PLN wobec 853,9 tys. w programie — zaległe wyciągi z wypłatami operatorów).

Interpretacja (2026-09-14): rangi 1, 2, 4, 5 i 10 to operatorzy płatności i instytucja pobraniowa (łącznie ok. 422 tys. PLN, maksymalnie 18–34 dni od terminu — bieżące cykle wypłat). Największy dłużnik-kontrahent ma 72,6 tys. PLN w całości przed terminem; najstarsze przeterminowanie wśród Top 20 to 321 dni (8,9 tys. PLN, 3 rozrachunki) — jedyna pozycja kwalifikująca się do windykacji twardej.
