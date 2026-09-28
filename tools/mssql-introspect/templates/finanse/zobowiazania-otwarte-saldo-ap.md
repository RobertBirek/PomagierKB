---
id: zobowiazania-otwarte-saldo-ap
title: Zobowiązania otwarte (saldo AP)
area: finanse
order: 30
questions:
  - "Jak policzyć: Zobowiązania otwarte (saldo AP)?"
params: {}
verified: 2026-09-14
---
Definicja: suma pozostałej do zapłaty wartości nierozliczonych zobowiązań na dany moment, w podziale na zobowiązania wobec dostawców i zwroty należne klientom.

Formuła: AP = Σ `nzf_Wartosc` dla `nzf_Typ = 40` i `nzf_Wartosc <> 0`, z podziałem po typie dokumentu źródłowego.

Tabele i kolumny: `nz__Finanse` (jak KPI 1, `nzf_Typ = 40`, `nzf_IdDokumentAuto`), `dok__Dokument` (dok_Id, dok_Typ).

Kody: `nzf_Typ` 40; źródłowe `dok_Typ` 1 (FZ), 5 (KFZ zwiększająca), 6 (KFS — zwrot dla klienta), 14 (ZW — zwrot detaliczny); NULL = zobowiązanie ręczne/dekret.

```sql
-- KPI 2: zobowiązania otwarte (saldo AP) — stan bieżący rozrachunków
-- zakres: zamień datę odniesienia '2026-09-14'
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
  SUM(f.nzf_Wartosc) AS saldo_otwarte_pln,
  SUM(CASE WHEN f.nzf_TerminPlatnosci < '2026-09-14' THEN f.nzf_Wartosc ELSE 0 END) AS w_tym_po_terminie_pln,
  MIN(f.nzf_TerminPlatnosci) AS najstarszy_termin
FROM dbo.nz__Finanse f
LEFT JOIN dbo.dok__Dokument d ON d.dok_Id = f.nzf_IdDokumentAuto
WHERE f.nzf_Typ = 40
  AND f.nzf_TypObiektu = 1
  AND f.nzf_Wartosc <> 0
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

Interpretacja (2026-09-14): AP 1,046 mln PLN: 333 rozrachunki FZ od 29 dostawców (1,043 mln; 180,2 tys. po terminie; najstarszy termin 2026-01-29) oraz 15 zwrotów należnych klientom z KFS (3,3 tys. PLN, <10 kontrahentów, 2,9 tys. po terminie). Zwroty klientom są małe kwotowo, ale przeterminowane — to sygnał operacyjny (reklamacje), nie finansowy.
