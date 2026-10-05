---
id: sprzedaz-wg-kanalow-sprzedazy
title: Sprzedaż netto wg kanałów sprzedaży (e-sklepy, marketplace'y, stacjonarnie)
area: sprzedaz
order: 180
questions:
  - "Jaka jest sprzedaż w e-sklepie w porównaniu ze sprzedażą stacjonarną w 2026?"
  - "Ile sprzedajemy przez marketplace'y (Empik, Castorama, Media Expert…) w porównaniu z własnymi sklepami internetowymi?"
  - "Jaki procent przychodu robi sklep stacjonarny?"
params:
  od:
    type: date
    description: początek zakresu (włącznie)
    example: 2026-01-01
  do:
    type: date
    description: koniec zakresu (wyłącznie)
    example: 2026-09-30
verified: 2026-09-29
---
- Definicja: przychód netto (FS + PA, status 1 — jak w „Przychód netto ze sprzedaży — miesięcznie”) w podziale na grupy kanałów sprzedaży. Kanał = kategoria dokumentu `dok_KatId` → `sl_Kategoria.kat_Nazwa` (konwencje instancji §5.6, potwierdzone przez właściciela 2026-09-28).
- Grupy kanałów: `Sprzedaż` = stacjonarnie; sufiksy `_empik`, `_castorama`, `_mediaexpert`, `_leroymerlin`, `_brw`, `_homeandyou`, `_kaufland`, `_inpost`, `_ceneo`, prefiks `erli_` i `Morele` = marketplace partnerski; `sma_*` = sklepy markowe; `Base.*` = BaseLinker; `B2B*` = hurt B2B; `Wycena` osobno; brak kategorii osobno; wszystkie pozostałe kategorie (m.in. `ilovelighting`, `lampy_24h_sanok`, `ilove.lighting`, `oficjalny24`, `swietliscie`, `globolighting`, `2bm.pl`, `tklighting.eu`, `zumaline.lighting`) = własne sklepy internetowe i konta aukcyjne.
- Tabele i kolumny: `dok__Dokument` (`dok_Typ`, `dok_Status`, `dok_DataWyst`, `dok_WartNetto`, `dok_KatId`), `sl_Kategoria` (`kat_Id`, `kat_Nazwa`).

```sql
-- zakres: [@od, @do) — przedział półotwarty; grupy kanałów wg konwencji instancji §5.6
WITH s AS (
  SELECT d.dok_WartNetto,
    CASE
      WHEN k.kat_Nazwa IS NULL THEN 'brak kategorii'
      WHEN k.kat_Nazwa = 'Sprzedaż' THEN 'stacjonarnie'
      WHEN k.kat_Nazwa = 'Wycena' THEN 'wycena'
      WHEN k.kat_Nazwa LIKE 'B2B%' THEN 'hurt B2B'
      WHEN k.kat_Nazwa LIKE '%[_]empik' OR k.kat_Nazwa LIKE '%[_]castorama' OR k.kat_Nazwa LIKE '%[_]mediaexpert'
        OR k.kat_Nazwa LIKE '%[_]leroymerlin' OR k.kat_Nazwa LIKE '%[_]brw' OR k.kat_Nazwa LIKE '%[_]homeandyou'
        OR k.kat_Nazwa LIKE '%[_]kaufland' OR k.kat_Nazwa LIKE '%[_]inpost' OR k.kat_Nazwa LIKE '%[_]ceneo'
        OR k.kat_Nazwa LIKE 'erli[_]%' OR k.kat_Nazwa = 'Morele' THEN 'internet: marketplace partnerski'
      WHEN k.kat_Nazwa LIKE 'sma[_]%' THEN 'internet: sklepy markowe'
      WHEN k.kat_Nazwa LIKE 'Base.%' THEN 'internet: BaseLinker'
      ELSE 'internet: własne sklepy i konta'
    END AS kanal
  FROM dbo.dok__Dokument d
  LEFT JOIN dbo.sl_Kategoria k ON k.kat_Id = d.dok_KatId
  WHERE d.dok_Typ IN (2, 21)        -- 2 = FS, 21 = PA
    AND d.dok_Status = 1            -- wykonane; wyklucza FSd (dubel paragonu)
    AND d.dok_DataWyst >= @od
    AND d.dok_DataWyst <  @do
)
SELECT kanal,
  COUNT(*)                                                                   AS doc_count,
  SUM(dok_WartNetto)                                                         AS net_sales,
  CAST(100.0 * SUM(dok_WartNetto) / SUM(SUM(dok_WartNetto)) OVER () AS decimal(5,1)) AS share_pct,
  SUM(SUM(dok_WartNetto)) OVER ()                                            AS total_net
FROM s
GROUP BY kanal
ORDER BY net_sales DESC
```

- Pułapki: (1) Suma `net_sales` wszystkich kanałów = przychód z szablonu „Przychód netto ze sprzedaży — miesięcznie” dla tego samego zakresu (uzgodnione co do grosza 2026-09-29: 8 276 422,53 zł za [2026-01-01, 2026-09-30)) — jeśli się nie zgadza, któraś kategoria wypadła z mapowania. (2) Kategoria `Wycena` na FS/PA ze statusem 1 to REALNA sprzedaż (w 2026: 315 dokumentów, ok. 269 tys. zł), choć konwencje opisują „Wycena” jako oferty — prawdopodobnie sprzedaż z oferty/wyceny; kanał nieustalony, NIE doliczaj jej ani do internetu, ani do stacjonarnej bez potwierdzenia właściciela. (3) Nowa kategoria dodana w programie trafi do „internet: własne sklepy i konta” (gałąź ELSE) — przy nowym marketplace dopisz jego sufiks. (4) Od 03.2026 detal jest na FS zamiast PA (potwierdzone przez właściciela 2026-09-28) — szablon liczy FS+PA łącznie, więc podział na kanały nie zależy od tej zmiany. (5) Kwoty netto w PLN, przed korektami (KFS) i zwrotami (ZW).
- Interpretacja: w 2026 (do 29.09) internet daje ok. 87,5% przychodu netto (własne sklepy 74,6%, marketplace'y 7,5%, sklepy markowe 4,9%, BaseLinker 0,5%), sprzedaż stacjonarna 5,7% (471,6 tys. zł), hurt B2B 1,7%, wycena 3,3%, brak kategorii 1,9%.
