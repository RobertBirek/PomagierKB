---
id: naleznosci-otwarte-saldo-ar
title: Należności otwarte (saldo AR)
area: finanse
order: 10
questions:
  - "Ile mamy należności do ściągnięcia i ile z tego to pieniądze w drodze od operatorów płatności?"
  - "Jakie było saldo należności na koniec sierpnia 2026 i ile z tego było po terminie?"
  - "Ile nam są winni klienci, nie licząc Allegro Finance, PayU i innych operatorów?"
params:
  dzien:
    type: date
    description: dzień, na który liczony jest stan (wiek względem tej daty)
    example: 2026-08-31
verified: 2026-09-28
---
Definicja: suma pozostałej do zapłaty wartości wszystkich nierozliczonych należności od kontrahentów na dany moment, w podziale na dłużników „zwykłych" i operatorów płatności.

Formuła: AR = Σ `nzf_Wartosc` dla `nzf_Typ = 39` i `nzf_Wartosc <> 0` (stan bieżący); wariant historyczny na dzień D: Σ (`nzf_WartoscPierwotnaWaluta` − Σ spłat do D) dla rozrachunków z `nzf_Data <= D`. Szablon liczy stan na koniec dnia D = `@dzien`: saldo PLN rozrachunku = ROUND(reszta w walucie × `nzf_Kurs` / `nzf_LiczbaJednostek`, 2) — dla dzisiejszej daty to dokładnie `nzf_Wartosc` (sprawdzone 2026-09-28: te same rozrachunki, zgodność co do grosza w każdym wierszu).

Tabele i kolumny: `nz__Finanse` (nzf_Typ, nzf_Wartosc, nzf_WartoscPierwotna, nzf_WartoscWaluta, nzf_IdWaluty, nzf_Podtyp, nzf_Status, nzf_TerminPlatnosci, nzf_TypObiektu, nzf_IdObiektu), `sl_FormaPlatnosci` (fp_CentId, fp_InstKredytId — identyfikacja operatorów), wariant historyczny: `nz_FinanseSplata` (nzs_IdDlugu, nzs_Data, nzs_WartoscWalutaDlugu).

Kody: `nzf_Typ` 39; źródłowe `dok_Typ` 2 (FS), 21 (PA), 5 (KFZ — należność od dostawcy); operator: `nzf_Podtyp` 4 (karta/operator) i 5 (pobranie).

```sql
-- KPI 1: należności otwarte (saldo AR) — stan na koniec dnia @dzien
-- saldo odtworzone z historii spłat (nz_FinanseSplata do @dzien); dla dzisiejszej daty = nzf_Wartosc co do grosza
WITH splaty AS (
  SELECT s.nzs_IdDlugu, SUM(s.nzs_WartoscWalutaDlugu) AS splacono_w_walucie_dlugu
  FROM dbo.nz_FinanseSplata s
  WHERE s.nzs_Data <= @dzien
  GROUP BY s.nzs_IdDlugu
), otwarte AS (
  SELECT n.nzf_IdObiektu, n.nzf_Podtyp, n.nzf_Status, n.nzf_IdWaluty, n.nzf_TerminPlatnosci, n.nzf_WartoscPierwotna,
         n.nzf_WartoscPierwotnaWaluta - ISNULL(sp.splacono_w_walucie_dlugu, 0) AS saldo_w_walucie,
         ROUND((n.nzf_WartoscPierwotnaWaluta - ISNULL(sp.splacono_w_walucie_dlugu, 0)) * n.nzf_Kurs / n.nzf_LiczbaJednostek, 2) AS saldo_pln
  FROM dbo.nz__Finanse n
  LEFT JOIN splaty sp ON sp.nzs_IdDlugu = n.nzf_Id
  WHERE n.nzf_Typ = 39
    AND n.nzf_TypObiektu = 1
    AND n.nzf_Data <= @dzien
    AND n.nzf_WartoscPierwotnaWaluta - ISNULL(sp.splacono_w_walucie_dlugu, 0) <> 0
)
SELECT
  CASE WHEN op.id IS NULL THEN 'kontrahent' ELSE 'operator platnosci' END AS rodzaj_dluznika,
  f.nzf_Podtyp AS podtyp_rozrachunku,
  f.nzf_Status AS status_rozrachunku,
  f.nzf_IdWaluty AS waluta,
  COUNT(*) AS liczba_rozrachunkow,
  COUNT(DISTINCT f.nzf_IdObiektu) AS liczba_kontrahentow,
  SUM(f.nzf_WartoscPierwotna) AS wartosc_pierwotna_pln,
  SUM(f.saldo_pln) AS saldo_otwarte_pln,
  SUM(f.saldo_w_walucie) AS saldo_otwarte_w_walucie,
  SUM(CASE WHEN f.nzf_TerminPlatnosci < @dzien THEN f.saldo_pln ELSE 0 END) AS w_tym_po_terminie_pln
FROM otwarte f
LEFT JOIN (
  SELECT fp_CentId AS id FROM dbo.sl_FormaPlatnosci WHERE fp_CentId IS NOT NULL
  UNION
  SELECT fp_InstKredytId FROM dbo.sl_FormaPlatnosci WHERE fp_InstKredytId IS NOT NULL
) op ON op.id = f.nzf_IdObiektu
GROUP BY CASE WHEN op.id IS NULL THEN 'kontrahent' ELSE 'operator platnosci' END,
         f.nzf_Podtyp, f.nzf_Status, f.nzf_IdWaluty
ORDER BY rodzaj_dluznika, podtyp_rozrachunku, waluta
```

Pułapki:
- Rozrachunki rozliczone częściowo: `nzf_Wartosc` to reszta, `nzf_WartoscPierwotna` to całość — do salda bierz `nzf_Wartosc`, do „ile wystawiono" `nzf_WartoscPierwotna`.
- Korekty: KFZ (`dok_Typ` 5) tworzy należność od DOSTAWCY — w AR „od klientów" trzeba ją odjąć lub pokazać osobno (grupowanie po `dok_Typ` źródłowym jak w KPI 2).
- Paragony bez rozrachunku: PA anonimowe mają rozrachunek „dla nieznanego" (`nzf_TypObiektu = 0`) rozliczony automatycznie — filtr `nzf_TypObiektu = 1` je pomija; nie są należnością.
- Waluty: `nzf_Wartosc` jest już w PLN po kursie rozrachunku; `saldo_otwarte_w_walucie` pokazuje kwotę w walucie (CZK/EUR/HUF). Wycena bilansowa wymaga kursu na dzień, nie kursu z dokumentu.
- Kontrahent jednorazowy (`kh_Jednorazowy = 1`, 384 w kartotece) nie ma otwartych należności w instancji; gdyby miał, `liczba_kontrahentow` liczy go raz per `kh_Id`.
- Wariant historyczny nie uwzględnia rozrachunków usuniętych i zmian statusu na „nieściągalny" po dniu D.
- Stan na przeszły dzień jest odtwarzany z dat spłat (`nzs_Data` = data dokumentu spłaty, np. wyciągu bankowego): spłata zaksięgowana później z datą ≤ D obniża saldo wstecz, więc wynik dla przeszłego dnia bywa znacznie niższy niż saldo, które program pokazywał tego dnia. Przykład: dla 2026-09-14 odtworzenie daje ok. 101,8 tys. PLN (kontrahenci 59,6 tys., operatorzy 42,2 tys.), a program pokazywał wtedy 853,9 tys. (Interpretacja niżej) — różnica to wypłaty operatorów z wyciągów wprowadzonych po 14.09 z wcześniejszą datą. Odtworzenie odpowiada temu, kiedy pieniądze faktycznie wpłynęły; saldo „jakie było w programie" nie jest odtwarzalne. Z tego samego powodu dzisiejsze saldo operatorów jest zawyżone, dopóki nie wprowadzono bieżących wyciągów.

Interpretacja (2026-09-14): saldo AR 853,9 tys. PLN, z czego 723,8 tys. (85%) to środki w drodze od operatorów płatności (podtyp 4: 2 208 rozrachunków, 5 operatorów; podtyp 5 pobrania: 167 rozrachunków, 1 instytucja), a tylko 130,1 tys. PLN to należności od 25 kontrahentów (49 rozrachunków). Należności walutowe są marginalne (CZK/EUR/HUF łącznie ok. 5,6 tys. PLN). Wniosek: w tej instancji „należności" to przede wszystkim cykl wypłat marketplace'ów, a nie kredyt kupiecki — KPI trzeba zawsze czytać z podziałem na te dwie grupy.
