---
id: otwarte-zamowienia-zk-starsze-niz-n-dni
title: Otwarte zamówienia od klientów (ZK) starsze niż N dni
area: sprzedaz
order: 150
questions:
  - "Które zamówienia od klientów wiszą niezrealizowane dłużej niż tydzień?"
  - "Pokaż otwarte zamówienia od klientów starsze niż 14 dni."
params:
  dni:
    type: int
    description: minimalny wiek otwartego zamówienia w dniach (≥ 1), liczony od chwili wykonania zapytania
    required: false
    default: 7
    example: 7
verified: 2026-09-28
---
- Definicja: lista otwartych (niezrealizowanych) zamówień od klientów starszych niż N dni — do pracy nad zaległościami, bez danych kontrahenta (po id, dacie, statusie i wartości netto).
- Formuła: `age_days = DATEDIFF(day, dok_DataWyst, GETDATE())`; filtr `dok_Typ = 16`, `dok_Status IN (5, 6, 7)`, `dok_DataWyst < GETDATE() − N dni`; sortowanie od najstarszego.
- Tabele i kolumny: `dok__Dokument` (`dok_Id`, `dok_Typ`, `dok_Status`, `dok_DataWyst`, `dok_WartNetto`).
- Kody: dok_Typ 16 = ZK (podtyp 1 = ZKzal, zamówienie do zaliczek). Statusy ZK w `dok_Status`: 5 = nie zrealizowane, 6 = nie zrealizowane bez rezerwacji, 7 = nie zrealizowane z rezerwacją, 8 = zrealizowane.

```sql
-- otwarte ZK starsze niż @dni dni, liczone od chwili wykonania (GETDATE)
SELECT dok_Id, dok_DataWyst, dok_Status, dok_WartNetto, DATEDIFF(day, dok_DataWyst, GETDATE()) AS age_days
FROM dbo.dok__Dokument
WHERE dok_Typ = 16 AND dok_Status IN (5, 6, 7) AND dok_DataWyst < DATEADD(day, -@dni, GETDATE())
ORDER BY dok_DataWyst
```

- Pułapki: (1) Wynik zależy od chwili wykonania — `dok_Status` zamówienia to stan bieżący, więc lista opisuje „teraz”, a wiek liczony jest od `GETDATE()`; dlatego szablon nie ma parametru daty odniesienia. (2) ZKzal (podtyp 1) realizuje się przez FSzal, a nie FS — jeśli chcesz osobno, filtruj `dok_Podtyp`. (3) Wynik to lista (po jednym wierszu na zamówienie); narzędzie pokazuje najwyżej 200 wierszy (najstarsze pierwsze) — NIE licz zamówień z tej listy; liczbę wszystkich otwartych ZK podaje szablon „Realizacja zamówień od klientów (ZK)” (`orders_by_status`, statusy 6 i 7, dla zakresu dat wystawienia zamówień).
- Interpretacja: instancja realizuje zamówienia praktycznie od ręki — 2025: 7% powyżej tygodnia (max 129 dni); otwartych ZK jest ok. 4,3 tys. (3 647 bez rezerwacji, 638 z rezerwacją), statusu 5 instancja nie używa.
