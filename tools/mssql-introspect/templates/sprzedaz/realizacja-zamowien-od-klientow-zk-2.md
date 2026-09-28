---
id: realizacja-zamowien-od-klientow-zk-2
title: Realizacja zamówień od klientów (ZK) (wariant 2)
area: sprzedaz
order: 150
questions:
  - "Jak policzyć: Realizacja zamówień od klientów (ZK) (wariant 2)?"
params: {}
verified: 2026-09-23
---
- Definicja: stan i tempo realizacji zamówień od klientów — ile ZK jest otwartych (bez rezerwacji / z rezerwacją), ile zrealizowano, ile dni mija od ZK do pierwszego dokumentu sprzedaży i ile zamówień „wisi” dłużej niż tydzień.
- Formuła: `open_orders = COUNT(ZK: dok_Status IN (6,7))`, `realized_orders = COUNT(ZK: dok_Status = 8)`; `lead_time_days = DATEDIFF(day, ZK.dok_DataWyst, MIN(FS/PA.dok_DataWyst))` po dokumentach sprzedaży, które wskazują ZK przez `dok_DoDokId`.
- Tabele i kolumny: `dok__Dokument` (`dok_Typ`, `dok_Podtyp`, `dok_Status`, `dok_DataWyst`, `dok_DoDokId`, `dok_WartNetto`), `dok_Pozycja` (`ob_DokHanId`, `ob_TowId`, `ob_Ilosc`, `ob_IloscMag`) tylko do zawartości zamówień.
- Kody: dok_Typ 16 = ZK (podtyp 1 = ZKzal, zamówienie do zaliczek); realizujące: 2 = FS, 21 = PA. Statusy ZK w `dok_Status`: 5 = nie zrealizowane, 6 = nie zrealizowane bez rezerwacji, 7 = nie zrealizowane z rezerwacją, 8 = zrealizowane.
- Jak realizacja jest zapisana W TEJ INSTANCJI (sprawdzone 2026-09-23): dokument sprzedaży powstały z ZK ma `dok_DoDokId` = `dok_Id` zamówienia (240 557 FS/PA wskazuje ZK); powiązanie pozycji `ob_DoId` NIE jest używane dla ZK (0 pozycji), a WZ nigdy nie wskazuje ZK. Praktycznie 1 ZK = 1 dokument sprzedaży (2025: 52 014 ZK z jednym FS/PA, 3 z dwoma, 415 zrealizowanych bez powiązanego FS/PA — zrealizowane ręcznie albo dokument usunięto).



Otwarte zamówienia starsze niż 7 dni (lista do pracy, bez danych kontrahenta — po id i wartości):

```sql
SELECT dok_Id, dok_DataWyst, dok_Status, dok_WartNetto, DATEDIFF(day, dok_DataWyst, GETDATE()) AS age_days
FROM dbo.dok__Dokument
WHERE dok_Typ = 16 AND dok_Status IN (5, 6, 7) AND dok_DataWyst < DATEADD(day, -7, GETDATE())
ORDER BY dok_DataWyst
```

- Pułapki: (1) Status 8 może nie mieć dokumentu sprzedaży (zrealizowano ręcznie / usunięto FS) — licz realizację po `dok_Status`, a czas realizacji po `dok_DoDokId`. (2) ZKzal (podtyp 1) realizuje się przez FSzal, a nie FS — jeśli chcesz osobno, filtruj `dok_Podtyp`. (3) `dok_DoDokId` na samym ZK (1 088 rekordów) wskazuje w drugą stronę na inne typy — nie używaj go do liczenia realizacji. (4) Nie łącz przez `dok_Pozycja.ob_DoId` — w tej instancji jest puste dla zamówień.
- Interpretacja: instancja realizuje zamówienia praktycznie od ręki — 2025: średnio 2 dni, 53% w ciągu doby, 40% w 2–7 dni, 7% powyżej tygodnia (max 129 dni); otwartych ZK jest ok. 4,3 tys. (3 647 bez rezerwacji, 638 z rezerwacją), statusu 5 instancja nie używa.
