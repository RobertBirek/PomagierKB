---
id: srednia-wartosc-faktury-i-paragonu
title: Średnia wartość faktury i paragonu
area: sprzedaz
order: 80
questions:
  - "Jak policzyć: Średnia wartość faktury i paragonu?"
params:
  od:
    type: date
    description: początek zakresu (włącznie)
    example: 2025-01-01
  do:
    type: date
    description: koniec zakresu (wyłącznie)
    example: 2026-01-01
verified: 2026-09-14
---
- Definicja: średnia i mediana wartości netto jednego dokumentu sprzedaży, osobno dla faktur i paragonów, miesięcznie (S13 „Średnia wartość zamówienia — AOV").
- Formuła: `AOV = Σ dok_WartNetto / COUNT(dokumentów)` per typ; mediana przez `PERCENTILE_CONT(0.5)`.
- Tabele i kolumny: `dok__Dokument` (`dok_Typ`, `dok_Podtyp`, `dok_Status`, `dok_DataWyst`, `dok_WartNetto`).
- Kody dok_Typ: 2 = FS (bez podtypu 3 — zaliczkowe), 21 = PA.

```sql
-- zakres: [@od, @do) — przedział półotwarty
WITH docs AS (
  SELECT
    YEAR(d.dok_DataWyst)  AS year_no,
    MONTH(d.dok_DataWyst) AS month_no,
    d.dok_Typ,
    d.dok_WartNetto,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY d.dok_WartNetto)
      OVER (PARTITION BY YEAR(d.dok_DataWyst), MONTH(d.dok_DataWyst), d.dok_Typ) AS median_net
  FROM dbo.dok__Dokument d
  WHERE d.dok_Typ IN (2, 21)
    AND d.dok_Status = 1
    AND NOT (d.dok_Typ = 2 AND d.dok_Podtyp = 3)   -- bez faktur zaliczkowych (końcowa ma netto ok. 0 po rozliczeniu zaliczek)
    AND d.dok_DataWyst >= @od
    AND d.dok_DataWyst <  @do
)
SELECT
  year_no,
  month_no,
  CASE dok_Typ WHEN 2 THEN 'FS' WHEN 21 THEN 'PA' END AS doc_kind,
  COUNT(*)              AS doc_count,
  SUM(dok_WartNetto)    AS net_sales,
  ROUND(AVG(dok_WartNetto), 2) AS avg_net_value,
  MAX(median_net)       AS median_net_value,
  MIN(dok_WartNetto)    AS min_net_value,
  MAX(dok_WartNetto)    AS max_net_value
FROM docs
GROUP BY year_no, month_no, dok_Typ
ORDER BY year_no, month_no, dok_Typ
```

- Pułapki: (1) Średnia jest wrażliwa na pojedyncze duże faktury (B2B, faktury zbiorcze do WZ po kilkadziesiąt tys. zł) — decyzje opieraj na medianie. (2) Faktury zaliczkowe końcowe mają netto ≈ 0 i zaniżają średnią — wykluczone; zaliczkowe pośrednie i tak nie mają statusu 1. (3) `PERCENTILE_CONT` to funkcja okna (nie agregat) — stąd CTE i `MAX(median_net)`. (4) Wartość dokumentu zawiera usługi (koszt wysyłki), które podnoszą średnią paragonu ze sklepu internetowego; do „koszyka towarowego" użyj `dok_WartTwNetto`. (5) Zwroty nie pomniejszają wartości dokumentu pierwotnego. (6) Wynik ma 2 wiersze na miesiąc (FS i PA) — 24 wiersze rocznie.
- Interpretacja: wzrost średniej przy stałej liczbie dokumentów = skuteczny cross-/up-selling lub podwyżki; spadek mediany paragonu przy rosnącej średniej = polaryzacja koszyka. W instancji (2025) średnia faktura ≈ 290–340 zł netto, średni paragon ≈ 190–210 zł netto, mediana wyraźnie niżej.
