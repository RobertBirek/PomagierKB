---
id: klienci-nowi-vs-powracajacy-po-id-kontrahenta
title: Klienci nowi vs powracający (po id kontrahenta)
area: finanse
order: 110
questions:
  - "Jak policzyć: Klienci nowi vs powracający (po id kontrahenta)?"
params:
  od:
    type: date
    description: początek zakresu (włącznie)
    example: 2025-09-01
  do:
    type: date
    description: koniec zakresu (wyłącznie)
    example: 2026-09-01
verified: 2026-09-14
---
Definicja: w każdym miesiącu okresu — liczba klientów, których pierwszy w historii dokument sprzedaży przypada w tym miesiącu (nowi), oraz tych, którzy kupowali już wcześniej (powracający), wraz z wartością brutto obu grup.

Formuła: pierwszy_zakup = MIN(`dok_DataWyst`) per `dok_PlatnikId` z całej historii; nowy w miesiącu M ⇔ pierwszy_zakup ≥ początek M; % powracających = powracający / (nowi + powracający).

Tabele i kolumny: `dok__Dokument` (dok_PlatnikId, dok_DataWyst, dok_Typ, dok_Podtyp, dok_Status, dok_WartBrutto).

Kody: `dok_Typ` 2, 21; `dok_Status` 1; bez FS podtyp 1.

```sql
-- KPI 10: klienci nowi vs powracający (po id kontrahenta dok_PlatnikId), miesięcznie
-- zakres: [@od, @do) — przedział półotwarty
WITH pierwszy AS (
  SELECT d.dok_PlatnikId, MIN(d.dok_DataWyst) AS pierwszy_zakup
  FROM dbo.dok__Dokument d
  WHERE d.dok_Typ IN (2, 21)
    AND d.dok_Status = 1
    AND NOT (d.dok_Typ = 2 AND d.dok_Podtyp = 1)
    AND d.dok_PlatnikId IS NOT NULL
  GROUP BY d.dok_PlatnikId
), okres AS (
  SELECT DATEADD(month, DATEDIFF(month, 0, d.dok_DataWyst), 0) AS miesiac,
         d.dok_PlatnikId,
         SUM(d.dok_WartBrutto) AS brutto_pln
  FROM dbo.dok__Dokument d
  WHERE d.dok_Typ IN (2, 21)
    AND d.dok_Status = 1
    AND NOT (d.dok_Typ = 2 AND d.dok_Podtyp = 1)
    AND d.dok_PlatnikId IS NOT NULL
    AND d.dok_DataWyst >= @od AND d.dok_DataWyst < @do
  GROUP BY DATEADD(month, DATEDIFF(month, 0, d.dok_DataWyst), 0), d.dok_PlatnikId
)
SELECT
  o.miesiac,
  SUM(CASE WHEN p.pierwszy_zakup >= o.miesiac THEN 1 ELSE 0 END) AS klienci_nowi,
  SUM(CASE WHEN p.pierwszy_zakup < o.miesiac THEN 1 ELSE 0 END) AS klienci_powracajacy,
  ROUND(100.0 * SUM(CASE WHEN p.pierwszy_zakup < o.miesiac THEN 1 ELSE 0 END) / COUNT(*), 2) AS proc_powracajacych,
  SUM(CASE WHEN p.pierwszy_zakup >= o.miesiac THEN o.brutto_pln ELSE 0 END) AS brutto_nowi_pln,
  SUM(CASE WHEN p.pierwszy_zakup < o.miesiac THEN o.brutto_pln ELSE 0 END) AS brutto_powracajacy_pln
FROM okres o
JOIN pierwszy p ON p.dok_PlatnikId = o.dok_PlatnikId
GROUP BY o.miesiac
ORDER BY o.miesiac
```

Pułapki:
- Skok „nowych" od 03.2026 (z ok. 750–1 150 do 2 770–3 700 miesięcznie) to efekt dokumentowania sprzedaży FS z płatnikiem zamiast anonimowego PA, nie wzrostu pozyskania — porównuj miesiące w obrębie jednego reżimu.
- Powracający po `kh_Id` są niedoszacowani (integrator tworzy kontrahenta per zamówienie, DO POTWIERDZENIA); realny wskaźnik retencji wymaga deduplikacji poza strażnikiem.
- Klient z pierwszym zakupem w miesiącu M i drugim w tym samym miesiącu liczy się raz jako nowy.
- Kontrahenci jednorazowi zawsze wyglądają na nowych.

Interpretacja: do 02.2026 udział powracających 10,8–13,8% miesięcznie (np. 12.2025: 151 powracających, 248 tys. PLN — ok. 43% wartości miesiąca), od 03.2026 3,8–4,7% przy 3–3,7 tys. nowych `kh_Id` miesięcznie. Liczba powracających (109–151 miesięcznie) jest stabilna w obu reżimach — to ona jest wiarygodnym szeregiem; procent nie.
