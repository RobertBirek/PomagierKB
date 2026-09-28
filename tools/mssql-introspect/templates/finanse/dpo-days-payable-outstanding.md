---
id: dpo-days-payable-outstanding
title: DPO (Days Payable Outstanding)
area: finanse
order: 80
questions:
  - "Jak policzyć: DPO (Days Payable Outstanding)?"
params:
  od:
    type: date
    description: początek zakresu (włącznie)
    example: 2025-09-14
  do:
    type: date
    description: koniec zakresu (wyłącznie)
    example: 2026-09-14
verified: 2026-09-14
---
Definicja: liczba dni zakupów finansowanych zobowiązaniami wobec dostawców — saldo AP wobec dostawców podzielone przez średnie dzienne zakupy brutto z 365 dni.

Formuła: DPO = AP(dostawcy) / zakupy brutto (365 dni) × 365; zakupy = Σ `dok_WartBrutto` dla FZ + KFZ, `dok_Status = 1`. Katalog używa COGS w mianowniku — tu zakupy brutto, bo zobowiązania są brutto (spójność miar).

Tabele i kolumny: `nz__Finanse` (nzf_Typ 40), `dok__Dokument` (dok_Typ 1, 5).

Kody: `nzf_Typ` 40; `dok_Typ` 1 (FZ), 5 (KFZ).

Szablon SQL:

```sql
-- KPI 7: DPO — dni zobowiązań w zakupach (saldo AP wobec dostawców / zakupy brutto 365 dni x 365)
-- zakres: [@od, @do) — przedział półotwarty
WITH ap AS (
  SELECT
    SUM(f.nzf_Wartosc) AS zobowiazania_pln,
    SUM(CASE WHEN d.dok_Typ IN (1, 5) OR d.dok_Typ IS NULL THEN f.nzf_Wartosc ELSE 0 END) AS zobowiazania_wobec_dostawcow_pln
  FROM dbo.nz__Finanse f
  LEFT JOIN dbo.dok__Dokument d ON d.dok_Id = f.nzf_IdDokumentAuto
  WHERE f.nzf_Typ = 40 AND f.nzf_TypObiektu = 1 AND f.nzf_Wartosc <> 0
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
  365 AS dni_okresu,
  ROUND(365.0 * ap.zobowiazania_wobec_dostawcow_pln / NULLIF(zak.zakupy_brutto_pln, 0), 1) AS dpo_dni,
  ROUND(365.0 * ap.zobowiazania_pln / NULLIF(zak.zakupy_brutto_pln, 0), 1) AS dpo_wszystkie_zobowiazania_dni
FROM ap CROSS JOIN zak
```

Test: zakupy 2025-09-14 … 2026-09-13, AP na 2026-09-14, 1 wiersz, wykonano 2026-09-14.

Pułapki:
- Zakupy tylko na PZ (bez FZ) nie są w mianowniku ani w liczniku — DPO odnosi się do zakupów zafakturowanych.
- KFZ ujemne obniżają mianownik; należność z KFZ nie pomniejsza licznika (patrz KPI 4).
- Zobowiązania ręczne/dekretowe (`nzf_IdDokumentAuto IS NULL`) są liczone jako „dostawca" — w instancji ich nie ma.
- Wydłużanie DPO kosztem relacji z dostawcami to ryzyko, nie sukces (katalog N2).

Interpretacja (2026-09-14): DPO 33,8 dnia (AP dostawcy 1,043 mln / zakupy 11,26 mln PLN z 9 552 dokumentów). Przy DSO 21,5 (a bez operatorów 3,3) firma finansuje się dostawcami dłużej, niż kredytuje klientów — cykl konwersji gotówki (CCC = DIO + DSO − DPO) zależy więc głównie od rotacji zapasu (DIO, poza tym dokumentem).
