---
id: top-n-towarow-wg-wartosci-sprzedazy
title: Top N towarów wg wartości sprzedaży
area: sprzedaz
order: 170
questions:
  - "Jakie 10 produktów sprzedało się najlepiej w ostatnich 12 miesiącach?"
  - "Które towary przyniosły największą sprzedaż netto w 2025 roku?"
params:
  od:
    type: date
    description: początek zakresu (włącznie)
    example: 2025-01-01
  do:
    type: date
    description: koniec zakresu (wyłącznie)
    example: 2026-01-01
  n:
    type: int
    description: liczba towarów w rankingu (TOP N, ≥ 1)
    required: false
    default: 10
    example: 10
verified: 2026-09-28
---
- Definicja: ranking towarów (nie marek) według sprzedaży netto z pozycji dokumentów sprzedaży po korektach i zwrotach, z ilością i liczbą dokumentów; odpowiada na „jakie są top 10 produktów w sprzedaży".
- Formuła: per towar `net_sales = Σ (−1 dla ZW, inaczej 1) × ob_Znak × ob_WartNetto` dla FS, PA, KFS, ZW; `quantity = Σ … × ob_IloscMag`.
- Tabele i kolumny: `dok_Pozycja` (`ob_DokHanId`, `ob_TowId`, `ob_TowRodzaj`, `ob_Znak`, `ob_WartNetto`, `ob_IloscMag`), `dok__Dokument` (`dok_Typ`, `dok_Status`, `dok_DataWyst`), `tw__Towar` (`tw_Symbol`, `tw_Nazwa`, `tw_IdGrupa`).
- Kody dok_Typ: 2 = FS, 21 = PA, 6 = KFS, 14 = ZW; `ob_TowRodzaj` 1 towar, 8 komplet (usługi i opłaty pominięte).
- Gotowa lista Top 20 za ostatnie 12 miesięcy jest w dokumencie agregatów („Top 20 towarów wg wartości sprzedaży netto — ostatnie 12 miesięcy"), odświeżanym co miesiąc; dla innego okresu lub innej liczby pozycji użyj szablonu.

```sql
-- zakres: [@od, @do) — przedział półotwarty (np. ostatnie 12 miesięcy: od = dziś − 12 mies., do = jutro); @n = liczba towarów
SELECT TOP (@n)
       t.tw_Symbol,
       LEFT(t.tw_Nazwa, 80) AS product_name,
       g.grt_Nazwa          AS brand,
       SUM(CASE WHEN d.dok_Typ = 14 THEN -1 ELSE 1 END * p.ob_Znak * p.ob_WartNetto) AS net_sales,
       SUM(CASE WHEN d.dok_Typ = 14 THEN -1 ELSE 1 END * p.ob_Znak * p.ob_IloscMag) AS quantity,
       COUNT(DISTINCT d.dok_Id) AS documents
FROM dbo.dok_Pozycja p
JOIN dbo.dok__Dokument d ON d.dok_Id = p.ob_DokHanId
JOIN dbo.tw__Towar t     ON t.tw_Id = p.ob_TowId
LEFT JOIN dbo.sl_GrupaTw g ON g.grt_Id = t.tw_IdGrupa
WHERE d.dok_Typ IN (2, 21, 6, 14) AND d.dok_Status = 1
  AND d.dok_DataWyst >= @od
  AND d.dok_DataWyst <  @do
  AND p.ob_TowRodzaj IN (1, 8)
GROUP BY t.tw_Id, t.tw_Symbol, LEFT(t.tw_Nazwa, 80), g.grt_Nazwa
ORDER BY net_sales DESC
```

- Pułapki: (1) Faktury zbiorcze (FS podtyp 2) mają wartości na pozycjach WZ, nie FS — szablon „Top marek" pokazuje, jak dociągnąć pozycje WZ przez `p.ob_DoId`; tu dla prostoty liczone są pozycje FS/PA bezpośrednio (różnica dotyczy hurtu). (2) Ranking po ilości wygląda inaczej niż po wartości — sortuj po `quantity`, gdy pytanie jest o „najczęściej sprzedawane". (3) Komplety (rodzaj 8) liczone jako całość, nie składniki.
- Interpretacja: top 3 towary z 12 miesięcy (na 2026-09-23) to lampy z segmentu 30–36 tys. PLN netto każdy; lista jest płaska — pierwsza dwudziestka to kilka procent sprzedaży, marki mają większe znaczenie niż pojedyncze indeksy.
