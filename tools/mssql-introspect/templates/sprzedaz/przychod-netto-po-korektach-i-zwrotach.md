---
id: przychod-netto-po-korektach-i-zwrotach
title: Przychód netto po korektach i zwrotach
area: sprzedaz
order: 50
questions:
  - "Ile wyniósł przychód netto po odjęciu zwrotów i korekt w 2025 roku?"
  - "Jaki procent sprzedaży wraca co miesiąc w zwrotach i korektach?"
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
- Definicja: przychód netto miesiąca po odjęciu korekt faktur (KFS) i zwrotów detalicznych (ZW) — najbliższy „Net Sales" z katalogu ERP (F1 z uwzględnieniem korekt).
- Formuła: `Net Sales = Σ FS+PA (dok_WartNetto) + Σ KFS (dok_WartNetto, zwykle ujemne) − Σ ZW (dok_WartNetto, dodatnie)`; `wskaźnik zwrotów i korekt % = (−Σ KFS + Σ ZW) / Σ FS+PA × 100`.
- Tabele i kolumny: `dok__Dokument` (`dok_Typ`, `dok_Status`, `dok_DataWyst`, `dok_WartNetto`).
- Kody dok_Typ: 2 = FS, 21 = PA, 6 = KFS, 14 = ZW.

```sql
-- zakres: [@od, @do) — przedział półotwarty
SELECT
  YEAR(d.dok_DataWyst)  AS year_no,
  MONTH(d.dok_DataWyst) AS month_no,
  SUM(CASE WHEN d.dok_Typ IN (2, 21) THEN d.dok_WartNetto ELSE 0 END) AS gross_net_sales,
  SUM(CASE WHEN d.dok_Typ = 6  THEN d.dok_WartNetto ELSE 0 END)       AS corrections_net,   -- KFS: wartość ujemna przy obniżce
  SUM(CASE WHEN d.dok_Typ = 14 THEN -d.dok_WartNetto ELSE 0 END)      AS returns_net,       -- ZW: wartość dodatnia w bazie, tu ze znakiem minus
  SUM(CASE WHEN d.dok_Typ IN (2, 21) THEN d.dok_WartNetto
           WHEN d.dok_Typ = 6        THEN d.dok_WartNetto
           WHEN d.dok_Typ = 14       THEN -d.dok_WartNetto ELSE 0 END) AS net_sales_after_returns,
  ROUND(100.0 * SUM(CASE WHEN d.dok_Typ = 6 THEN -d.dok_WartNetto WHEN d.dok_Typ = 14 THEN d.dok_WartNetto ELSE 0 END)
        / NULLIF(SUM(CASE WHEN d.dok_Typ IN (2, 21) THEN d.dok_WartNetto ELSE 0 END), 0), 2) AS returns_and_corrections_pct,
  SUM(CASE WHEN d.dok_Typ = 6  THEN 1 ELSE 0 END) AS corrections_count,
  SUM(CASE WHEN d.dok_Typ = 14 THEN 1 ELSE 0 END) AS returns_count
FROM dbo.dok__Dokument d
WHERE d.dok_Typ IN (2, 21, 6, 14)   -- FS, PA, KFS, ZW
  AND d.dok_Status = 1              -- KFS o statusie 0 = korekty do FSd, w 100% zdublowane przez ZW
  AND d.dok_DataWyst >= @od
  AND d.dok_DataWyst <  @do
GROUP BY YEAR(d.dok_DataWyst), MONTH(d.dok_DataWyst)
ORDER BY year_no, month_no
```

- Pułapki: (1) Znaki: KFS ma w bazie wartość ujemną (obniżka) lub dodatnią (podwyżka) — sumuj bez zmiany znaku; ZW ma wartość dodatnią — odejmij. (2) Korekta/zwrot trafia do miesiąca swojego wystawienia, nie do miesiąca pierwotnej sprzedaży (`dok_TypDatyUjeciaKorekty = 2`) — w grudniu wskaźnik jest zaniżony, w styczniu zawyżony. (3) KFS ze statusem 0 (do faktur detalicznych FSd) pomijaj — ten sam zwrot jest już w ZW. (4) Korekty faktur zakupu (KFZ, `dok_Typ = 5`) i zwroty do dostawcy (ZD, 15) nie dotyczą sprzedaży. (5) Ten szablon liczy z nagłówków; wersja z pozycji (KPI marży) daje ten sam wynik z dokładnością do faktur zaliczkowych (ok. 0,05%). (6) Od 03.2026 sprzedaż detaliczna jest dokumentowana fakturą FS zamiast paragonu PA, a zwroty korektą KFS zamiast ZW (potwierdzone przez właściciela 2026-09-28) — w porównaniach przez tę datę detal = PA + FS detaliczne, zwroty = ZW + KFS; spadek PA i ZW po 02.2026 to zmiana dokumentowania, nie sprzedaży.
- Interpretacja: w instancji zwroty+korekty to ok. 8–9% sprzedaży brutto miesięcznie (do 02.2026 dominują zwroty detaliczne ZW ze sklepu internetowego; od 03.2026 te zwroty są dokumentowane korektą KFS, więc podział na ZW i KFS przed i po tej dacie nie jest porównywalny). Rosnący wskaźnik przy stałej sprzedaży = problem jakości opisu produktu, transportu lub polityki zwrotów; to ten przychód (nie brutto) powinien być podstawą marży i prowizji.
