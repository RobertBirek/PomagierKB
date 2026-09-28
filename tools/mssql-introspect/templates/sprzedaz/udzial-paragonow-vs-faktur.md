---
id: udzial-paragonow-vs-faktur
title: Udział paragonów vs faktur
area: sprzedaz
order: 90
questions:
  - "Jaki procent sprzedaży idzie na paragonach, a jaki na fakturach?"
  - "Ile sprzedajemy miesięcznie na faktury walutowe (EUR, CZK, HUF)?"
params:
  od:
    type: date
    description: początek zakresu (włącznie)
    example: 2025-01-01
  do:
    type: date
    description: koniec zakresu (wyłącznie)
    example: 2026-01-01
verified: 2026-09-28
---
- Definicja: udział paragonów (sprzedaż detaliczna) w liczbie i wartości netto dokumentów sprzedaży miesiąca; dodatkowo wartość faktur walutowych (eksport/sprzedaż UE) w PLN.
- Formuła: `udział wartościowy % = Σ PA / Σ (FS+PA) × 100`; `udział ilościowy % = COUNT(PA) / COUNT(FS+PA) × 100`.
- Tabele i kolumny: `dok__Dokument` (`dok_Typ`, `dok_Status`, `dok_DataWyst`, `dok_WartNetto`, `dok_Waluta`).
- Kody dok_Typ: 2 = FS, 21 = PA.

```sql
-- zakres: [@od, @do) — przedział półotwarty
SELECT
  YEAR(d.dok_DataWyst)  AS year_no,
  MONTH(d.dok_DataWyst) AS month_no,
  SUM(CASE WHEN d.dok_Typ = 21 THEN 1 ELSE 0 END)               AS receipts_count,
  SUM(CASE WHEN d.dok_Typ = 2  THEN 1 ELSE 0 END)               AS invoices_count,
  SUM(CASE WHEN d.dok_Typ = 21 THEN d.dok_WartNetto ELSE 0 END) AS receipts_net,
  SUM(CASE WHEN d.dok_Typ = 2  THEN d.dok_WartNetto ELSE 0 END) AS invoices_net,
  ROUND(100.0 * SUM(CASE WHEN d.dok_Typ = 21 THEN d.dok_WartNetto ELSE 0 END) / NULLIF(SUM(d.dok_WartNetto), 0), 2) AS receipts_value_share_pct,
  ROUND(100.0 * SUM(CASE WHEN d.dok_Typ = 21 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 2)                        AS receipts_count_share_pct,
  SUM(CASE WHEN d.dok_Typ = 2 AND d.dok_Waluta <> 'PLN' THEN d.dok_WartNetto ELSE 0 END) AS invoices_foreign_currency_net_pln
FROM dbo.dok__Dokument d
WHERE d.dok_Typ IN (2, 21)
  AND d.dok_Status = 1
  AND d.dok_DataWyst >= @od
  AND d.dok_DataWyst <  @do
GROUP BY YEAR(d.dok_DataWyst), MONTH(d.dok_DataWyst)
ORDER BY year_no, month_no
```

- Pułapki: (1) Paragon, do którego wystawiono FSd, pozostaje paragonem — FSd (status 0) nie wchodzi do faktur; gdybyś liczył FSd, część detalu „przeszłaby" do faktur. (2) Faktura ≠ B2B: faktury na osoby fizyczne (sklep internetowy) też są FS; podział B2B/B2C wymaga `kh_Osoba`/`kh_OdbDet` na kontrahencie (dozwolone tylko jako liczniki, bez nazw). (3) Faktury walutowe są już w PLN (`dok_WartNetto`), `dok_Waluta` mówi tylko, w jakiej walucie wystawiono. (4) Zwroty ZW dotyczą wyłącznie paragonów, korekty KFS wyłącznie faktur — udział „po zwrotach" będzie inny niż brutto (paragony mają ~10% zwrotów, faktury ~3–4% korekt). (5) Od 03.2026 sprzedaż detaliczna jest dokumentowana fakturą FS zamiast paragonu PA, a zwroty korektą KFS zamiast ZW (potwierdzone przez właściciela 2026-09-28) — w porównaniach przez tę datę detal = PA + FS detaliczne, zwroty = ZW + KFS; spadek PA i ZW po 02.2026 to zmiana dokumentowania, nie sprzedaży.
- Interpretacja: w instancji paragony to ok. 68–74% wartości i ok. 79–80% liczby dokumentów (2025); faktury w EUR/CZK/HUF to kilkadziesiąt tys. zł netto miesięcznie. Zmiana udziału zwykle odzwierciedla mix kanałów (sklep internetowy vs hurt), a nie zmianę rynku.
