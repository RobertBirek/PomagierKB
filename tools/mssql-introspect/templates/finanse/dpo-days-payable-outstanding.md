---
id: dpo-days-payable-outstanding
title: DPO (Days Payable Outstanding)
area: finanse
order: 80
questions:
  - "Ile dni średnio płacimy dostawcom (DPO) w ostatnich 12 miesiącach?"
  - "Jakie było DPO za 2025 rok?"
params:
  od:
    type: date
    description: początek okresu zakupów (włącznie)
    example: 2025-09-14
  do:
    type: date
    description: koniec okresu zakupów (wyłącznie); saldo zobowiązań liczone na koniec dnia poprzedzającego
    example: 2026-09-14
verified: 2026-09-28
---
Definicja: liczba dni zakupów finansowanych zobowiązaniami wobec dostawców — saldo AP wobec dostawców na koniec okresu podzielone przez średnie dzienne zakupy brutto z okresu (domyślnie 365 dni).

Formuła: DPO = AP(dostawcy) / zakupy brutto (okres) × liczba dni okresu, okres = [`@od`, `@do`), liczba dni = DATEDIFF(day, `@od`, `@do`); AP = saldo na koniec dnia przed `@do`, odtworzone z historii spłat jak w KPI 2 (gdy `@do` = jutro, AP = bieżące `nzf_Wartosc`); zakupy = Σ `dok_WartBrutto` dla FZ + KFZ, `dok_Status = 1`. Katalog używa COGS w mianowniku — tu zakupy brutto, bo zobowiązania są brutto (spójność miar).

Tabele i kolumny: `nz__Finanse` (nzf_Typ 40), `nz_FinanseSplata` (saldo na koniec okresu), `dok__Dokument` (dok_Typ 1, 5).

Kody: `nzf_Typ` 40; `dok_Typ` 1 (FZ), 5 (KFZ).

```sql
-- KPI 7: DPO — dni zobowiązań w zakupach (saldo AP wobec dostawców na koniec okresu / zakupy brutto okresu x dni okresu)
-- zakres: [@od, @do) — przedział półotwarty; saldo AP na koniec dnia przed @do (odtworzone z historii spłat)
WITH splaty AS (
  SELECT s.nzs_IdDlugu, SUM(s.nzs_WartoscWalutaDlugu) AS splacono_w_walucie_dlugu
  FROM dbo.nz_FinanseSplata s
  WHERE s.nzs_Data < @do
  GROUP BY s.nzs_IdDlugu
), otwarte AS (
  SELECT n.nzf_IdDokumentAuto,
         ROUND((n.nzf_WartoscPierwotnaWaluta - ISNULL(sp.splacono_w_walucie_dlugu, 0)) * n.nzf_Kurs / n.nzf_LiczbaJednostek, 2) AS saldo_pln
  FROM dbo.nz__Finanse n
  LEFT JOIN splaty sp ON sp.nzs_IdDlugu = n.nzf_Id
  WHERE n.nzf_Typ = 40
    AND n.nzf_TypObiektu = 1
    AND n.nzf_Data < @do
    AND n.nzf_WartoscPierwotnaWaluta - ISNULL(sp.splacono_w_walucie_dlugu, 0) <> 0
), ap AS (
  SELECT
    SUM(f.saldo_pln) AS zobowiazania_pln,
    SUM(CASE WHEN d.dok_Typ IN (1, 5) OR d.dok_Typ IS NULL THEN f.saldo_pln ELSE 0 END) AS zobowiazania_wobec_dostawcow_pln
  FROM otwarte f
  LEFT JOIN dbo.dok__Dokument d ON d.dok_Id = f.nzf_IdDokumentAuto
), zak AS (
  SELECT SUM(d.dok_WartBrutto) AS zakupy_brutto_pln, SUM(d.dok_WartNetto) AS zakupy_netto_pln, COUNT(*) AS liczba_dok
  FROM dbo.dok__Dokument d
  WHERE d.dok_Typ IN (1, 5)
    AND d.dok_Status = 1
    AND d.dok_DataWyst >= @od AND d.dok_DataWyst < @do
)
SELECT
  ap.zobowiazania_pln,
  ap.zobowiazania_wobec_dostawcow_pln,
  zak.zakupy_brutto_pln,
  zak.zakupy_netto_pln,
  zak.liczba_dok,
  DATEDIFF(day, @od, @do) AS dni_okresu,
  ROUND(1.0 * DATEDIFF(day, @od, @do) * ap.zobowiazania_wobec_dostawcow_pln / NULLIF(zak.zakupy_brutto_pln, 0), 1) AS dpo_dni,
  ROUND(1.0 * DATEDIFF(day, @od, @do) * ap.zobowiazania_pln / NULLIF(zak.zakupy_brutto_pln, 0), 1) AS dpo_wszystkie_zobowiazania_dni
FROM ap CROSS JOIN zak
```

Pułapki:
- Zakupy tylko na PZ (bez FZ) nie są w mianowniku ani w liczniku — DPO odnosi się do zakupów zafakturowanych.
- KFZ ujemne obniżają mianownik; należność z KFZ nie pomniejsza licznika (patrz KPI 4).
- Zobowiązania ręczne/dekretowe (`nzf_IdDokumentAuto IS NULL`) są liczone jako „dostawca" — w instancji ich nie ma.
- Wydłużanie DPO kosztem relacji z dostawcami to ryzyko, nie sukces (katalog N2).
- Saldo AP na koniec przeszłego okresu jest odtwarzane z dat spłat (`nzs_Data` = data dokumentu zapłaty): zapłaty zaksięgowane później z wcześniejszą datą obniżają je wstecz, a FZ wprowadzone później z wcześniejszą datą podnoszą — DPO za przeszły okres może różnić się od wyliczonego wtedy z salda w programie. Interpretacja niżej pochodzi z salda w programie z 2026-09-14.

Interpretacja (2026-09-14): DPO 33,8 dnia (AP dostawcy 1,043 mln / zakupy 11,26 mln PLN z 9 552 dokumentów). Przy DSO 21,5 (a bez operatorów 3,3) firma finansuje się dostawcami dłużej, niż kredytuje klientów — cykl konwersji gotówki (CCC = DIO + DSO − DPO) zależy więc głównie od rotacji zapasu (DIO, poza tym dokumentem).
