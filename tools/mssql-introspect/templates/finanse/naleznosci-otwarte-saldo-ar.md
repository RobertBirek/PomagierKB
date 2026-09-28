---
id: naleznosci-otwarte-saldo-ar
title: Należności otwarte (saldo AR)
area: finanse
order: 10
questions:
  - "Jak policzyć: Należności otwarte (saldo AR)?"
params: {}
verified: 2026-09-14
---
Definicja: suma pozostałej do zapłaty wartości wszystkich nierozliczonych należności od kontrahentów na dany moment, w podziale na dłużników „zwykłych" i operatorów płatności.

Formuła: AR = Σ `nzf_Wartosc` dla `nzf_Typ = 39` i `nzf_Wartosc <> 0` (stan bieżący); wariant historyczny na dzień D: Σ (`nzf_WartoscPierwotnaWaluta` − Σ spłat do D) dla rozrachunków z `nzf_Data <= D`.

Tabele i kolumny: `nz__Finanse` (nzf_Typ, nzf_Wartosc, nzf_WartoscPierwotna, nzf_WartoscWaluta, nzf_IdWaluty, nzf_Podtyp, nzf_Status, nzf_TerminPlatnosci, nzf_TypObiektu, nzf_IdObiektu), `sl_FormaPlatnosci` (fp_CentId, fp_InstKredytId — identyfikacja operatorów), wariant historyczny: `nz_FinanseSplata` (nzs_IdDlugu, nzs_Data, nzs_WartoscWalutaDlugu).

Kody: `nzf_Typ` 39; źródłowe `dok_Typ` 2 (FS), 21 (PA), 5 (KFZ — należność od dostawcy); operator: `nzf_Podtyp` 4 (karta/operator) i 5 (pobranie).

Szablon SQL (stan bieżący):

```sql
-- KPI 1: należności otwarte (saldo AR) — stan bieżący rozrachunków
-- zakres: zamień datę odniesienia '2026-09-14' (służy tylko do oznaczenia części po terminie)
SELECT
  CASE WHEN op.id IS NULL THEN 'kontrahent' ELSE 'operator platnosci' END AS rodzaj_dluznika,
  f.nzf_Podtyp AS podtyp_rozrachunku,
  f.nzf_Status AS status_rozrachunku,
  f.nzf_IdWaluty AS waluta,
  COUNT(*) AS liczba_rozrachunkow,
  COUNT(DISTINCT f.nzf_IdObiektu) AS liczba_kontrahentow,
  SUM(f.nzf_WartoscPierwotna) AS wartosc_pierwotna_pln,
  SUM(f.nzf_Wartosc) AS saldo_otwarte_pln,
  SUM(f.nzf_WartoscWaluta) AS saldo_otwarte_w_walucie,
  SUM(CASE WHEN f.nzf_TerminPlatnosci < '2026-09-14' THEN f.nzf_Wartosc ELSE 0 END) AS w_tym_po_terminie_pln
FROM dbo.nz__Finanse f
LEFT JOIN (
  SELECT fp_CentId AS id FROM dbo.sl_FormaPlatnosci WHERE fp_CentId IS NOT NULL
  UNION
  SELECT fp_InstKredytId FROM dbo.sl_FormaPlatnosci WHERE fp_InstKredytId IS NOT NULL
) op ON op.id = f.nzf_IdObiektu
WHERE f.nzf_Typ = 39
  AND f.nzf_TypObiektu = 1
  AND f.nzf_Wartosc <> 0
GROUP BY CASE WHEN op.id IS NULL THEN 'kontrahent' ELSE 'operator platnosci' END,
         f.nzf_Podtyp, f.nzf_Status, f.nzf_IdWaluty
ORDER BY rodzaj_dluznika, podtyp_rozrachunku, waluta
```

Test: stan na 2026-09-14, 8 wierszy, wykonano 2026-09-14.

Szablon SQL (wariant historyczny — saldo na koniec dnia D):



Test: D = 2025-12-31, 1 wiersz, wykonano 2026-09-14. Walidacja: ten sam szablon z D = 2026-09-14 odtworzył saldo bieżące co do grosza (PLN 848 271,97; CZK, EUR, HUF również zgodne) — rekonstrukcja ze spłat jest wiarygodna.

Pułapki:
- Rozrachunki rozliczone częściowo: `nzf_Wartosc` to reszta, `nzf_WartoscPierwotna` to całość — do salda bierz `nzf_Wartosc`, do „ile wystawiono" `nzf_WartoscPierwotna`.
- Korekty: KFZ (`dok_Typ` 5) tworzy należność od DOSTAWCY — w AR „od klientów" trzeba ją odjąć lub pokazać osobno (grupowanie po `dok_Typ` źródłowym jak w KPI 2).
- Paragony bez rozrachunku: PA anonimowe mają rozrachunek „dla nieznanego" (`nzf_TypObiektu = 0`) rozliczony automatycznie — filtr `nzf_TypObiektu = 1` je pomija; nie są należnością.
- Waluty: `nzf_Wartosc` jest już w PLN po kursie rozrachunku; `saldo_otwarte_w_walucie` pokazuje kwotę w walucie (CZK/EUR/HUF). Wycena bilansowa wymaga kursu na dzień, nie kursu z dokumentu.
- Kontrahent jednorazowy (`kh_Jednorazowy = 1`, 384 w kartotece) nie ma otwartych należności w instancji; gdyby miał, `liczba_kontrahentow` liczy go raz per `kh_Id`.
- Wariant historyczny nie uwzględnia rozrachunków usuniętych i zmian statusu na „nieściągalny" po dniu D.

Interpretacja (2026-09-14): saldo AR 853,9 tys. PLN, z czego 723,8 tys. (85%) to środki w drodze od operatorów płatności (podtyp 4: 2 208 rozrachunków, 5 operatorów; podtyp 5 pobrania: 167 rozrachunków, 1 instytucja), a tylko 130,1 tys. PLN to należności od 25 kontrahentów (49 rozrachunków). Należności walutowe są marginalne (CZK/EUR/HUF łącznie ok. 5,6 tys. PLN). Wniosek: w tej instancji „należności" to przede wszystkim cykl wypłat marketplace'ów, a nie kredyt kupiecki — KPI trzeba zawsze czytać z podziałem na te dwie grupy.
