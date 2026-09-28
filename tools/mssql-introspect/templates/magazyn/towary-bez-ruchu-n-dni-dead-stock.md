---
id: towary-bez-ruchu-n-dni-dead-stock
title: Towary bez ruchu N dni (dead stock)
area: magazyn
order: 30
questions:
  - "Które towary marki X leżą w magazynie ponad 180 dni bez sprzedaży i ile jest w nich zamrożonej gotówki?"
  - "Ile wartości zapasu to towar, który nie ruszył się od ponad roku?"
params:
  dni:
    type: int
    description: próg w dniach (≥ 1) — towar na stanie bez żadnego rozchodu od ponad tylu dni (liczone od dziś)
    example: 180
  marka:
    type: text
    description: nazwa marki dokładnie jak w słowniku grup towarowych sl_GrupaTw (np. Rabalux); brak = wszystkie marki
    required: false
    maxLength: 100
    example: Rabalux
verified: 2026-09-28
---
Definicja: lista towarów ze stanem, których ostatni rozchód (WZ lub RW) był dawniej niż `@dni` dni temu albo nigdy nie nastąpił (wtedy liczy się od pierwszego przyjęcia towaru), z wartością zapasu każdego towaru (całą i tylko z warstw starszych niż `@dni` dni) i sumami dla całej listy, opcjonalnie dla jednej marki; na pytanie „ile gotówki jest zamrożone w towarze leżącym ponad N dni" odpowiada `aged_value_total` (wartość warstw starszych niż N dni), a `dead_value_total` to cała wartość zapasu tych towarów łącznie ze świeżymi warstwami (katalog: M5 „Slow movers", M6 „Dead stock").

Formuła: dla towaru ze stanem: ostatni ruch = MAX(`mr_Data`) po rozchodach (`mr_MagId IS NULL`); dni bez rozchodu = DATEDIFF(day, COALESCE(ostatni ruch, pierwsze przyjęcie), dziś); towar na liście, gdy dni bez rozchodu > `@dni`; zamrożona gotówka > N dni = Σ(`mr_Pozostalo` × `mr_Cena`) otwartych warstw towarów z listy, dla których DATEDIFF(day, `mr_Data`, dziś) > `@dni` (`aged_value`, suma `aged_value_total`, udział `aged_value_share_pct`) — ta sama granica co dla „bez rozchodu"; pełna wartość zapasu towarów z listy = `dead_value_total` (udział `dead_value_share_pct`); udziały liczone od wartości całego zapasu w zakresie (marka albo firma).

Tabele i kolumny: `dok_MagRuch` (mr_TowId, mr_MagId, mr_Data, mr_Pozostalo, mr_Cena); `tw__Towar` (tw_Symbol, tw_Nazwa, tw_IdGrupa, tw_Zablokowany); `sl_GrupaTw` (grt_Id, grt_Nazwa).

Kody dok_Typ: rozchód = każdy wiersz `mr_MagId IS NULL` (WZ 11 i RW 13); MM nie jest ruchem.

```sql
-- stan bieżący (GETDATE): towary na stanie bez rozchodu od ponad @dni dni; @marka = nazwa marki z sl_GrupaTw albo NULL (wszystkie marki)
WITH stock AS (
  SELECT mr_TowId AS tw_id, SUM(mr_Pozostalo) AS qty, SUM(mr_Pozostalo * mr_Cena) AS value_fifo, MAX(mr_Data) AS newest_layer_date,
         SUM(CASE WHEN DATEDIFF(day, mr_Data, GETDATE()) > @dni THEN mr_Pozostalo * mr_Cena ELSE 0 END) AS aged_value
  FROM dbo.dok_MagRuch
  WHERE mr_MagId IS NOT NULL AND mr_Pozostalo > 0
  GROUP BY mr_TowId
),
last_issue AS (
  SELECT mr_TowId AS tw_id, MAX(mr_Data) AS last_issue_date
  FROM dbo.dok_MagRuch
  WHERE mr_MagId IS NULL
  GROUP BY mr_TowId
),
first_receipt AS (
  SELECT mr_TowId AS tw_id, MIN(mr_Data) AS first_receipt_date
  FROM dbo.dok_MagRuch
  WHERE mr_MagId IS NOT NULL
  GROUP BY mr_TowId
),
b AS (
  SELECT s.tw_id, t.tw_Symbol, LEFT(t.tw_Nazwa, 80) AS tw_name, g.grt_Nazwa AS brand,
         s.qty, s.value_fifo, s.aged_value, t.tw_Zablokowany,
         li.last_issue_date, fr.first_receipt_date, s.newest_layer_date,
         DATEDIFF(day, COALESCE(li.last_issue_date, fr.first_receipt_date), GETDATE()) AS days_without_issue,
         SUM(s.value_fifo) OVER () AS scope_stock_value
  FROM stock s
  JOIN dbo.tw__Towar t ON t.tw_Id = s.tw_id
  LEFT JOIN dbo.sl_GrupaTw g ON g.grt_Id = t.tw_IdGrupa
  LEFT JOIN last_issue li ON li.tw_id = s.tw_id
  LEFT JOIN first_receipt fr ON fr.tw_id = s.tw_id
  WHERE (@marka IS NULL OR g.grt_Nazwa = @marka)
),
dead AS (
  SELECT b.*, COUNT(*) OVER () AS dead_sku_total, SUM(b.value_fifo) OVER () AS dead_value_total,
         SUM(b.aged_value) OVER () AS aged_value_total
  FROM b
  WHERE b.days_without_issue > @dni
)
SELECT tw_id, tw_Symbol, tw_name, brand, qty, value_fifo, aged_value,
       last_issue_date, first_receipt_date, newest_layer_date, days_without_issue,
       CASE WHEN last_issue_date IS NULL THEN 1 ELSE 0 END AS never_issued,
       tw_Zablokowany AS blocked,
       dead_sku_total, dead_value_total, aged_value_total,
       CAST(100.0 * dead_value_total / NULLIF(scope_stock_value, 0) AS decimal(6,2)) AS dead_value_share_pct,
       CAST(100.0 * aged_value_total / NULLIF(scope_stock_value, 0) AS decimal(6,2)) AS aged_value_share_pct
FROM dead
ORDER BY value_fifo DESC
```

Pułapki: stan bieżący — zapas (`mr_Pozostalo`) nie ma historii, więc szablon liczy zawsze na chwilę wykonania (`GETDATE()`), a wynik zmienia się z dnia na dzień; „ruch" obejmuje też RW (likwidacje, wydania wewnętrzne) i zwroty do dostawcy (WZ→KFZ) — towar, który tylko wracał do dostawcy, wygląda na ruchomy, więc lista „bez sprzedaży" jest oszacowaniem z dołu; towar nigdy nie wydany liczy się od pierwszego przyjęcia (`first_receipt_date`) — bez tego na liście lądowałyby świeże dostawy (2026-09-28 przy `dni=180`: 375 SKU, ok. 100 tys. zł nigdy nie wydanych, ale przyjętych w ciągu 180 dni — poza listą); ostatni rozchód nie uwzględnia późniejszych dostaw — 2026-09-28 przy `dni=180` 412 SKU (ok. 126 tys. zł) ma ostatni rozchód ponad 180 dni temu, ale warstwę przyjętą w ciągu 180 dni (dostawa, MM albo zwrot klienta) — kolumna `newest_layer_date` pokazuje, jak długo leży najmłodsza część zapasu, a `aged_value` / `aged_value_total` wyłączają takie świeże warstwy z „zamrożonej gotówki"; ostatni ruch liczony jest globalnie (nie per magazyn) — towar sprzedawany z MAG, a leżący na AZZ, nie trafi na listę; sezonowość oświetlenia (szczyt IV kwartał) sprawia, że próg 180 dni wiosną łapie towar sezonowy — porównuj rok do roku; `@marka` musi być dokładną nazwą grupy z `sl_GrupaTw` (nazwy marek zwraca szablon „Struktura asortymentu i zapasu wg marek") — nieznana nazwa daje 0 wierszy bez błędu, a nie „brak martwego zapasu"; wynik narzędzia jest obcięty do 200 wierszy (najdroższe pierwsze), ale `dead_sku_total`, `dead_value_total`, `aged_value_total` i udziały w każdym wierszu liczą całą listę; udział liczony od wartości zapasu w zakresie (marka albo cała firma); nazwy i symbole towarów nie są danymi osobowymi.

Interpretacja (2026-09-28): `dni=180` — 2 275 SKU bez rozchodu; zamrożone w warstwach starszych niż 180 dni 405,9 tys. zł (`aged_value_total`, 23,2% wartości zapasu), a cała wartość zapasu tych towarów łącznie ze świeżymi warstwami 527,3 tys. zł (30,1%); `dni=365` — 1 278 SKU, 212,0 tys. zł w warstwach starszych niż rok (12,1%), cała wartość 276,7 tys. zł (15,8%) (benchmark katalogu: dead stock poniżej 5%); Rabalux przy `dni=180` — 49 SKU, 6,6 tys. zł w warstwach starszych niż 180 dni (3,0% zapasu marki), cała wartość 11,8 tys. zł (5,3%). Poprzednia wersja koszykowa (2026-09-14, wszystkie nigdy niewydane towary bez względu na wiek, pełna wartość) dawała dead stock (>365 dni + nigdy) 20,8% wartości (ok. 363 tys. zł) — liczby nie są porównywalne wprost. Żaden towar na stanie nie jest zablokowany — blokada nie jest używana do oznaczania towaru do likwidacji.
