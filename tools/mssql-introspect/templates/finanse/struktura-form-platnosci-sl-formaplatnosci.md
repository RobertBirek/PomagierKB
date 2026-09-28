---
id: struktura-form-platnosci-sl-formaplatnosci
title: Struktura form płatności (sl_FormaPlatnosci)
area: finanse
order: 90
questions:
  - "Jak policzyć: Struktura form płatności (sl_FormaPlatnosci)?"
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
Definicja: podział dokumentów sprzedaży (FS, PA) w okresie według faktycznej formy zapłaty — gotówka, karta/operator, kredyt/pobranie, odroczona, przelew (przedpłata) — z nazwą formy ze słownika.

Formuła: klasyfikacja per dokument w kolejności: `dok_KwGotowka > 0` → gotówka; `dok_KwKarta > 0` → karta/operator (`dok_KartaId` → `fp_Nazwa`); `dok_KwKredyt > 0` → kredyt/pobranie (`dok_KredytId` → `fp_Nazwa`); `dok_PlatId IS NOT NULL` → odroczona (`fp_Nazwa`); `dok_KwPrzelew > 0` → przelew (przedpłata); inaczej „inna/brak". Udział = brutto formy / brutto razem.

Tabele i kolumny: `dok__Dokument` (dok_KwGotowka, dok_KwKarta, dok_KwKredyt, dok_KwPrzelew, dok_KartaId, dok_KredytId, dok_PlatId, dok_WartBrutto), `sl_FormaPlatnosci` (fp_Id, fp_Nazwa, fp_Typ: 0 odroczona, 1 karta przy sprzedaży, 3 kredyt/pobranie; fp_Termin).

Kody: `dok_Typ` 2, 21; `dok_Status` 1; bez FS podtyp 1.

```sql
-- KPI 8: struktura form płatności na dokumentach sprzedaży (FS + PA)
-- zakres: [@od, @do) — przedział półotwarty
SELECT
  CASE WHEN d.dok_KwGotowka > 0 THEN 'gotowka'
       WHEN d.dok_KwKarta > 0 THEN 'karta/operator: ' + fk.fp_Nazwa
       WHEN d.dok_KwKredyt > 0 THEN 'kredyt/pobranie: ' + fr.fp_Nazwa
       WHEN d.dok_PlatId IS NOT NULL THEN 'odroczona: ' + fo.fp_Nazwa
       WHEN d.dok_KwPrzelew > 0 THEN 'przelew (przedplata)'
       ELSE 'inna/brak' END AS forma_platnosci,
  d.dok_Typ AS dok_typ,
  COUNT(*) AS liczba_dok,
  SUM(d.dok_WartBrutto) AS brutto_pln,
  ROUND(100.0 * SUM(d.dok_WartBrutto) / SUM(SUM(d.dok_WartBrutto)) OVER (), 2) AS udzial_proc,
  SUM(CASE WHEN (CASE WHEN d.dok_KwGotowka > 0 THEN 1 ELSE 0 END) + (CASE WHEN d.dok_KwKarta > 0 THEN 1 ELSE 0 END)
              + (CASE WHEN d.dok_KwPrzelew > 0 THEN 1 ELSE 0 END) + (CASE WHEN d.dok_KwKredyt > 0 THEN 1 ELSE 0 END) > 1
           THEN 1 ELSE 0 END) AS dok_z_platnoscia_mieszana
FROM dbo.dok__Dokument d
LEFT JOIN dbo.sl_FormaPlatnosci fk ON fk.fp_Id = d.dok_KartaId
LEFT JOIN dbo.sl_FormaPlatnosci fr ON fr.fp_Id = d.dok_KredytId
LEFT JOIN dbo.sl_FormaPlatnosci fo ON fo.fp_Id = d.dok_PlatId
WHERE d.dok_Typ IN (2, 21)
  AND d.dok_Status = 1
  AND NOT (d.dok_Typ = 2 AND d.dok_Podtyp = 1)
  AND d.dok_DataWyst >= @od AND d.dok_DataWyst < @do
GROUP BY
  CASE WHEN d.dok_KwGotowka > 0 THEN 'gotowka'
       WHEN d.dok_KwKarta > 0 THEN 'karta/operator: ' + fk.fp_Nazwa
       WHEN d.dok_KwKredyt > 0 THEN 'kredyt/pobranie: ' + fr.fp_Nazwa
       WHEN d.dok_PlatId IS NOT NULL THEN 'odroczona: ' + fo.fp_Nazwa
       WHEN d.dok_KwPrzelew > 0 THEN 'przelew (przedplata)'
       ELSE 'inna/brak' END,
  d.dok_Typ
ORDER BY brutto_pln DESC
```

Pułapki:
- `dok_PlatId` NIE jest formą płatności dokumentu — tylko terminem odroczonym; w 2025 r. wypełnione na 1,2% FS. Struktura oparta na samym `dok_PlatId` pokaże „brak" dla 98% dokumentów.
- `dok_KartaId`/`dok_KredytId` mają wartość domyślną na każdym dokumencie („Płatność kartą" na 10 055 FS z 2026 r., które zapłacono przelewem) — czytaj je wyłącznie razem z kwotą.
- Płatność mieszana (gotówka + karta) trafia do pierwszej spełnionej gałęzi CASE; kolumna `dok_z_platnoscia_mieszana` liczy takie przypadki (w teście: 2 PA).
- Alternatywa od strony rozrachunków: `nzf_Podtyp` należności (1/4/5/6/7) — spójna z cesjami, ale bez nazwy operatora dla podtypu 1.
- Słownik ma 40 form, w tym duplikaty nazw („Pobranie GLS" jako fp_Typ 3 i jako fp_Typ 1) — grupuj po `fp_Id`, jeśli potrzebna jest jednoznaczność.
- Zmiana dokumentowania od 03.2026 (FS zamiast PA) przesuwa wolumen między wierszami `dok_typ` 21 i 2 — porównuj formy, nie typy dokumentów.

Interpretacja (12 miesięcy do 2026-09-13): przedpłata przelewem 51% wartości (36,2% na PA z okresu paragonowego + 14,9% na FS), Allegro Finance 20,4%, Przelewy24 12,9%, pobrania kurierskie łącznie ok. 5% (Allegro, GLS, DPD, InPost, Poczta), płatność odroczona 7/14/30 dni 2,8% (170 FS — jedyny kredyt kupiecki), gotówka 0,9%, terminal kartą 0,75%, „inna/brak" 1,3% (441 FS bez kwot płatności — prawdopodobnie faktury do przedpłat/zaliczek, DO POTWIERDZENIA). Firma jest praktycznie bezgotówkowa i bez kredytu kupieckiego — ryzyko płatnicze koncentruje się w operatorach.
