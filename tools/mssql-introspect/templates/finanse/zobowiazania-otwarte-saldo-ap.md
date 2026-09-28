---
id: zobowiazania-otwarte-saldo-ap
title: Zobowiązania otwarte (saldo AP)
area: finanse
order: 30
questions:
  - "Ile jesteśmy winni dostawcom i ile z tego jest już po terminie?"
  - "Jakie były nasze zobowiązania na koniec sierpnia 2026?"
  - "Ile zwrotów pieniędzy klientom czeka na wypłatę?"
params:
  dzien:
    type: date
    description: dzień, na który liczony jest stan (wiek względem tej daty)
    example: 2026-08-31
verified: 2026-09-28
---
Definicja: suma pozostałej do zapłaty wartości nierozliczonych zobowiązań na dany moment, w podziale na zobowiązania wobec dostawców i zwroty należne klientom.

Formuła: AP = Σ `nzf_Wartosc` dla `nzf_Typ = 40` i `nzf_Wartosc <> 0`, z podziałem po typie dokumentu źródłowego. Szablon liczy stan na koniec dnia D = `@dzien` odtworzony z historii spłat jak KPI 1: saldo PLN rozrachunku = ROUND((`nzf_WartoscPierwotnaWaluta` − spłaty z `nzs_Data <= D`) × `nzf_Kurs` / `nzf_LiczbaJednostek`, 2) dla `nzf_Data <= D` — dla dzisiejszej daty to dokładnie `nzf_Wartosc` (sprawdzone 2026-09-28).

Tabele i kolumny: `nz__Finanse` (jak KPI 1, `nzf_Typ = 40`, `nzf_IdDokumentAuto`), `nz_FinanseSplata` (nzs_IdDlugu, nzs_Data, nzs_WartoscWalutaDlugu), `dok__Dokument` (dok_Id, dok_Typ).

Kody: `nzf_Typ` 40; źródłowe `dok_Typ` 1 (FZ), 5 (KFZ zwiększająca), 6 (KFS — zwrot dla klienta), 14 (ZW — zwrot detaliczny); NULL = zobowiązanie ręczne/dekret.

```sql
-- KPI 2: zobowiązania otwarte (saldo AP) — stan na koniec dnia @dzien (odtworzony z historii spłat)
WITH splaty AS (
  SELECT s.nzs_IdDlugu, SUM(s.nzs_WartoscWalutaDlugu) AS splacono_w_walucie_dlugu
  FROM dbo.nz_FinanseSplata s
  WHERE s.nzs_Data <= @dzien
  GROUP BY s.nzs_IdDlugu
), otwarte AS (
  SELECT n.nzf_IdObiektu, n.nzf_IdWaluty, n.nzf_TerminPlatnosci, n.nzf_IdDokumentAuto, n.nzf_WartoscPierwotna,
         ROUND((n.nzf_WartoscPierwotnaWaluta - ISNULL(sp.splacono_w_walucie_dlugu, 0)) * n.nzf_Kurs / n.nzf_LiczbaJednostek, 2) AS saldo_pln
  FROM dbo.nz__Finanse n
  LEFT JOIN splaty sp ON sp.nzs_IdDlugu = n.nzf_Id
  WHERE n.nzf_Typ = 40
    AND n.nzf_TypObiektu = 1
    AND n.nzf_Data <= @dzien
    AND n.nzf_WartoscPierwotnaWaluta - ISNULL(sp.splacono_w_walucie_dlugu, 0) <> 0
)
SELECT
  CASE WHEN d.dok_Typ IN (1, 5) THEN 'dostawca (FZ/KFZ)'
       WHEN d.dok_Typ IN (6, 14) THEN 'klient (KFS/ZW - zwrot do wyplaty)'
       WHEN d.dok_Typ IS NULL THEN 'reczny/inny (bez dokumentu handlowego)'
       ELSE 'inny dokument' END AS rodzaj_zobowiazania,
  d.dok_Typ AS dok_typ_zrodlowy,
  f.nzf_IdWaluty AS waluta,
  COUNT(*) AS liczba_rozrachunkow,
  COUNT(DISTINCT f.nzf_IdObiektu) AS liczba_kontrahentow,
  SUM(f.nzf_WartoscPierwotna) AS wartosc_pierwotna_pln,
  SUM(f.saldo_pln) AS saldo_otwarte_pln,
  SUM(CASE WHEN f.nzf_TerminPlatnosci < @dzien THEN f.saldo_pln ELSE 0 END) AS w_tym_po_terminie_pln,
  MIN(f.nzf_TerminPlatnosci) AS najstarszy_termin
FROM otwarte f
LEFT JOIN dbo.dok__Dokument d ON d.dok_Id = f.nzf_IdDokumentAuto
GROUP BY CASE WHEN d.dok_Typ IN (1, 5) THEN 'dostawca (FZ/KFZ)'
              WHEN d.dok_Typ IN (6, 14) THEN 'klient (KFS/ZW - zwrot do wyplaty)'
              WHEN d.dok_Typ IS NULL THEN 'reczny/inny (bez dokumentu handlowego)'
              ELSE 'inny dokument' END,
         d.dok_Typ, f.nzf_IdWaluty
ORDER BY saldo_otwarte_pln DESC
```

Pułapki:
- Zakupy udokumentowane tylko PZ (bez FZ) nie mają rozrachunku — w 2025 r. 4 094 z 12 467 PZ było bez płatnika; AP nie widzi zobowiązań „w drodze" do czasu wprowadzenia FZ.
- KFS/ZW to zobowiązania wobec KLIENTÓW (zwroty do wypłaty) — w DPO i planie płatności dostawcom trzeba je wyłączyć (szablon je rozdziela).
- Korekty częściowo rozliczone kompensatą (`nzs_Typ = 4`) zmniejszają `nzf_Wartosc` bez przepływu pieniądza.
- Waluty: zobowiązania w walucie obcej w instancji nie występują (wszystkie otwarte w PLN), ale szablon grupuje po `nzf_IdWaluty` na wypadek FZ w EUR/USD.
- Kontrahent jednorazowy: nie dotyczy dostawców (FZ zawsze z kartoteki).
- Stan na przeszły dzień jest odtwarzany z dat spłat (`nzs_Data` = data dokumentu spłaty, np. wyciągu): zapłata zaksięgowana później z datą ≤ D obniża saldo wstecz, więc wynik dla przeszłego dnia może różnić się od salda, które program pokazywał tego dnia; faktury zakupu wprowadzone później z datą ≤ D podnoszą je wstecz.
- Od 03.2026 sprzedaż detaliczna jest dokumentowana fakturą FS zamiast paragonu PA, a zwroty korektą KFS zamiast ZW (potwierdzone przez właściciela 2026-09-28) — w porównaniach przez tę datę detal = PA + FS detaliczne, zwroty = ZW + KFS; spadek PA i ZW po 02.2026 to zmiana dokumentowania, nie sprzedaży. Zwroty do wypłaty klientom to suma wierszy `klient (KFS/ZW - zwrot do wyplaty)` (dok_typ 6 i 14).

Interpretacja (2026-09-14): AP 1,046 mln PLN: 333 rozrachunki FZ od 29 dostawców (1,043 mln; 180,2 tys. po terminie; najstarszy termin 2026-01-29) oraz 15 zwrotów należnych klientom z KFS (3,3 tys. PLN, <10 kontrahentów, 2,9 tys. po terminie). Zwroty klientom są małe kwotowo, ale przeterminowane — to sygnał operacyjny (reklamacje), nie finansowy.
