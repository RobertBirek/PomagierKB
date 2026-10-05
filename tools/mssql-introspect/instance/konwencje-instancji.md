---
owner: ilovelighting (instancja produkcyjna Magnum_Profi)
license: użytek wewnętrzny — semantyka instancji, bez danych osobowych
date: 2026-09-28
---
# Magnum_Profi — konwencje i semantyka instancji

Dokument opisuje, JAK firma ilovelighting używa programu Subiekt GT w swojej produkcyjnej instancji (baza Magnum_Profi): które kody, flagi, pola własne, poziomy cen, typy dokumentów, magazyny i kategorie są naprawdę w użyciu i co w praktyce znaczą. To nie jest dokumentacja programu (ta jest w bazie SubiektKB) — to opis TEJ instancji.

Proweniencja: wszystkie liczby pochodzą z produkcyjnej bazy Subiekt GT ilovelighting (instancja produkcyjna Magnum_Profi), odczytanej 2026-09-11 wyłącznie zapytaniami agregującymi (COUNT/SUM/MIN/MAX, GROUP BY po kodach, flagach i datach) przez strażnika tylko-do-odczytu `tools/mssql-introspect/run-select.mjs` (pojedynczy SELECT, deny-lista kolumn osobowych, log każdego zapytania). Liczności osób/kontrahentów poniżej progu k=10 zapisano jako „<10". Znaczenia kodów pochodzą z dokumentacji producenta i e-Pomocy InsERT (baza SubiektKB). Dokument nie zawiera danych osobowych, nazw kontrahentów ani pojedynczych wierszy dokumentów. Każda reguła WYWNIOSKOWANA z danych (a nie odczytana ze słownika) jest oznaczona „DO POTWIERDZENIA" — potwierdza ją właściciel firmy.

## 1. Profil instancji

Firma i skala:
- Branża: handel oświetleniem (lampy, oprawy, akcesoria) — 93 marki jako grupy towarowe (m.in. GLOBO, Italux, Nova Luce, Nowodvorski, Rabalux, Azzardo, Eglo, Candellux, TK Lighting, Spotline, Zuma Line), cechy towarów typu „Lampy_wewnętrzne", „Wiszące", „Plafony", „Kinkiety".
- Model sprzedaży: wielokanałowa sprzedaż internetowa (kategorie dokumentów = konta sklepów i marketplace'ów, sekcja 5.6) plus sprzedaż stacjonarna (formy płatności „Terminal Sanok", „Terminal Krosno"; magazyn RKR „Krosno" od 08.2025). Zamówienia od klientów (ZK) wchodzą z integratora — w bazie są 27 tabel `sublinker_*` (645 553 wierszy, w tym `sublinker__sendfs` 160 130), które wskazują na integrator Sublinker łączący BaseLinker z Subiektem GT. DO POTWIERDZENIA.
- Kontrahenci: 234 547 w kartotece, z tego jednorazowi (kh_Jednorazowy = 1) 384; zablokowani (kh_Zablokowany) i potencjalni (kh_Potencjalny) — poniżej progu k=10 (flagi praktycznie nieużywane).
- Towary (tw__Towar, tw_Usuniety = 0): 79 673, w tym rodzaj „towar" 79 667 (71 783 aktywne + 7 884 zablokowane), usługi 3, opakowanie 1, komplety 2. Oznaczonych jako usunięte: 0.
- Dokumenty (dok__Dokument): 888 370, daty wystawienia od 2015-08-24 do 2026-09-11, 16 typów w użyciu, 5 magazynów.
- Jednostka miary: wyłącznie „szt." (79 673 towarów). Stawka VAT sprzedaży: wyłącznie 23% (79 673 towarów).
- Waluty na dokumentach (od 2025-01-01): FS — PLN 31 175, CZK 2 363, HUF 1 633, EUR 1 140; ZK — PLN 79 763, CZK 2 396, HUF 1 674, EUR 1 165; FZ — PLN 13 460, HUF 89, CZK 86, EUR 84, USD 14; PZ i PA — wyłącznie PLN. Sprzedaż zagraniczna (Czechy, Węgry, strefa euro) idzie przez ZK i FS w walucie obcej. DO POTWIERDZENIA, że CZK/HUF/EUR odpowiadają marketplace'om zagranicznym.

Wolumen roczny dokumentów (liczba dokumentów wg dok_Typ):
- 2024: WZ 45 714; ZK 45 086; PA 36 981; PZ 10 710; FS 9 020; FZ 6 594; ZW 3 617; KFZ 699; KFS 586; RW 41; PW 39; ZD 24; RS 1.
- 2025: WZ 53 825; ZK 53 432; PA 41 835; PZ 12 467; FS 11 616; FZ 7 786; ZW 4 097; KFZ 1 002; KFS 670; MM 50; RW 34; PW 24; ZD 3; IW 1; RS 1.
- 2026 (do 11.09): WZ 31 780; ZK 31 565; FS 24 694; PZ 7 645; PA 6 395; FZ 5 947; KFS 2 193; ZW 748; KFZ 550; MM 171; RW 69; PW 17; IW 1.
- Sezonowość 2025 (ZK miesięcznie): minimum czerwiec 3 378, maksimum listopad 6 542; grudzień 6 090. Szczyt sprzedaży przypada na IV kwartał.

Moduły i obszary programu W UŻYCIU (wg liczby wierszy w tabelach modułu):
- Dokumenty handlowe i magazynowe (`dok_*`: 4,18 mln wierszy) — rdzeń instancji.
- Rozrachunki (`nz_*`: 970 tys.; nz__Finanse 625 822, nz_FinanseSplata 344 378) — należności i zobowiązania są prowadzone w Subiekcie.
- Kartoteka towarów (`tw_*`: 855 tys.), kontrahentów (`kh_*`: 261 tys.) i adresów (`adr_*`: 1,74 mln).
- Inwentaryzacja (`iw_*`: iw_Pozycja 107 040, iw__Dokument 111) — remanenty robione w programie.
- Urządzenia fiskalne (`uf_*`: uf_Transmisja 16 521, uf_Urzadzenie 2 767) — drukarki fiskalne podłączone do Subiekta.
- KSeF (`ksef_*`: ksef_Faktury 7 080, ksef_NumerKSeF 7 232, ksef_DokumentUPO 759; `logksef_*` 24 781) — KSeF JEST używany: faktury FS ze statusem „zarejestrowana w KSeF" od 2026-03-31 (sekcja 5.4).
- Ślad rewizyjny i log komunikacji (`ins_Slad` 795 716, `kom_KomunikacjaLog` 619 644) — automatycznie zasilane logi programu.
- Synchronizacja (`sy_SyncObjectChange` 7 077) — cel synchronizacji DO POTWIERDZENIA.
- Tabele spoza standardu InsERT: `sublinker_*` (27 tabel, integrator zamówień), `AA_CR_*` (6 tabel, 3 279 wierszy; AA_CR_SMU_UPDATE 3 136 — dodatek DO POTWIERDZENIA), `LEO_Wydruk_Etykiet_2015_*` (wydruk etykiet; drukarki 2, uprawnienia 21), `tb_*` (64 tabele, 200 wierszy — obca aplikacja, DO POTWIERDZENIA), `CERTECH_*` (7 tabel, 0 wierszy), `zzt_*` (4 tabele, 0 wierszy), `tmpKSeFBefore`/`tmpKSeFAfter` (tabele tymczasowe konwersji, 0 wierszy).

Moduły NIEUŻYWANE (0 wierszy albo wyłącznie wiersze definicyjne producenta) — szczegóły w sekcji 7: CRM/Gestor, kadry i płace, Vendero/sklep internetowy InsERT (Feniks), Sello (brak tabel w tej bazie), cenniki i cenniki indywidualne, promocje, księgi handlowe, rejestry VAT, sprzedaż mobilna, e-mail, SMS, windykacja, home banking, środki trwałe.

Tabela `pd_Produkt` zawiera 24 nazwy modułów/produktów InsERT (Sprzedaż, Sprzedaż detaliczna, Zakupy, Magazyn, Kasa i bank, Rozrachunki, Księgi handlowe, Deklaracje i sprawozdania, Środki trwałe, Kadry, Kadry i płace, Sprzedaż mobilna, Sprzedaż internetowa, Zamówienia, Integrator z Dynamics CRM, CRM, Szybka sprzedaż, Wsparcie techniczne, Fabryka obiektów, e-Kontrole podatkowe, Kadry i płace 2, Oddział PLUS, Szybka sprzedaż PLUS, Portal Dokumentów) — to lista definicji, NIE lista aktywnych licencji; o faktycznym użyciu mówią liczby wierszy powyżej.

## 2. Rola kontrahenta — jak odróżnić klienta od dostawcy

Pole kh_Rodzaj (rodzaj kontrahenta: 0 = dostawca/odbiorca, 1 = dostawca, 2 = odbiorca, 3 = żaden) NIE jest pielęgnowane:
- kh_Rodzaj = 0 (domyślne „dostawca/odbiorca"): 234 264 kontrahentów (99,9%).
- kh_Rodzaj = 1 (dostawca): 30. kh_Rodzaj = 2 (odbiorca): 253. kh_Rodzaj = 3: brak.
- Wniosek: rola kontrahenta wynika z DOKUMENTÓW, nie z pola kh_Rodzaj. DO POTWIERDZENIA, że 30 kontrahentów z kh_Rodzaj = 1 to świadomie oznaczeni dostawcy.

Rola po dokumentach (kontrahent = dok_PlatnikId; cała historia):
- Klient = płatnik na dokumencie sprzedaży: FS (dok_Typ 2) — 65 693 dokumentów, 57 586 różnych płatników; PA (dok_Typ 21) — 185 851 dokumentów, ale 185 849 bez płatnika (paragony anonimowe; różnych płatników <10).
- Dostawca = płatnik na dokumencie zakupu: FZ (dok_Typ 1) — 49 761 dokumentów, 387 różnych dostawców; PZ (dok_Typ 10) — 67 487 dokumentów, 4 094 różnych płatników, 15 864 bez płatnika.
- Zamówienia od klientów ZK (dok_Typ 16) — 243 832 dokumentów, 231 809 różnych płatników: prawie każde zamówienie ma WŁASNEGO kontrahenta (klient zakładany przez integrator per zamówienie). Stąd 205 561 kontrahentów-osób z flagą odbiorcy detalicznego. DO POTWIERDZENIA (integrator tworzy kontrahenta dla każdego zamówienia).
- Podsumowanie ról (tylko FS/PA jako sprzedaż i FZ/PZ jako zakup): tylko klient 53 614; tylko dostawca 326; obie role 3 974; jakakolwiek rola 57 914. Pozostałe ~176 tys. kontrahentów ma wyłącznie ZK/WZ (bez faktury imiennej).
- Uwaga: 3 974 kontrahentów „w obu rolach" to w większości firmy, które kupują i którym wystawiono PZ/FZ (np. zwroty, dropshipping, zakup od klienta-firmy) — DO POTWIERDZENIA.

Flagi kartoteki (kh_Osoba = osoba fizyczna, kh_OdbDet = odbiorca detaliczny):
- firma (kh_Osoba = 0), nie-detal (kh_OdbDet = 0): 28 485;
- firma, odbiorca detaliczny: 16;
- osoba fizyczna, nie-detal: 485;
- osoba fizyczna, odbiorca detaliczny: 205 561.
- Znaczenie kh_OdbDet wg e-Pomocy InsERT: „Odbiorca detaliczny" wyłącza kontrolę NIP na sprzedaży, włącza domyślną rejestrację fiskalną i liczenie cen „od brutto". W tej instancji flagę nadaje głównie integrator klientom-osobom.

Kto dostaje jakie dokumenty (od 2025-01-01, płatnik z flagami):
- FS: firmy nie-detal 12 346 dokumentów / 9 654 płatników; osoby detaliczne 23 957 / 23 616 (prawie 1 faktura na osobę — faktury imienne z zamówień internetowych); osoby nie-detal <10.
- ZK: firmy nie-detal 13 071 / 9 625; osoby detaliczne 71 924 / 70 432; osoby nie-detal <10.
- FZ: firmy nie-detal 13 732 / 242 dostawców; osoba detaliczna <10.
- Powtarzalność zakupów na FS (od 2025-01-01): wśród płatników nie-detal (kh_OdbDet = 0): 9 662 płatników, z tego ≥2 faktury 1 484, ≥3 faktury 409, ≥10 faktur 17; wśród detalicznych: 23 617 płatników, ≥2 faktury 285, ≥3 faktury 30, ≥10 faktur <10.

Definicja robocza „klient hurtowy" — DO POTWIERDZENIA przez właściciela:
- Propozycja: klient hurtowy = kontrahent z kh_OdbDet = 0 (nie jest odbiorcą detalicznym). Zbiór: 28 970 kontrahentów (28 485 firm + 485 osób). Zastrzeżenie: większość z nich to firmy kupujące jednorazowo przez internet (9 654 płatników FS, średnio 1,3 faktury), więc flaga oznacza raczej „nabywca z NIP" niż „hurtownik".
- Alternatywne wyróżniki obecne w danych (do wyboru przez właściciela): (a) faktura FS na poziomie cen 2 „Hurtowa" — 3 918 z 36 311 FS od 2025-01-01 (10,8%); (b) kategoria dokumentu „B2B_ilovelighting" — 69 FS od 2025-01-01; (c) cecha kontrahenta „Warunki:Rabat 30" — 16 kontrahentów; (d) ≥3 faktury FS od 2025 — 409 płatników nie-detal.
- Pola, które NIE różnicują klientów w tej instancji: kh_Cena (standardowy poziom cen) — NULL u wszystkich; kh_IdRabat — 0 przypisań; kh_PlatOdroczone = 1 u 234 139 (99,8%, ustawiane masowo); kh_IdOdbiorca — 0; grupy kontrahentów: „Podstawowa" 234 066, „Osoba" 300, „Firma" 12, „Dostawca" <10, „Koszt" <10 — grupy nie klasyfikują klientów. kh_IdFormaP (odroczona forma płatności) ustawione u 95 kontrahentów — jedyna kartotekowa cecha, która może wskazywać stałych klientów z terminem płatności. DO POTWIERDZENIA.

Dostawcy:
- Podstawowy dostawca (tw_IdPodstDostawca) ustawiony u 21 021 z 79 673 towarów; różnych dostawców domyślnych: 21. Producent (tw_IdProducenta) u 205 towarów, 2 różnych — pole nieużywane.
- Koncentracja domyślnych dostawców (bez nazw, wg rangi): dostawca nr 1 — 3 446 towarów (16,4%); top 5 — 67,7% towarów z dostawcą; top 10 — 95,9%.
- Faktury zakupu FZ od 2025-01-01: 243 dostawców; dostawca nr 1 — 2 562 faktur (18,7%); top 3 — 42,8%; top 10 — 72,3%.
- Grupa kontrahentów „Dostawca" ma <10 członków, cecha kontrahenta nie oznacza dostawców — dostawcę rozpoznaje się WYŁĄCZNIE po FZ/PZ lub po tw_IdPodstDostawca. Lista dostawców-osób prawnych z markami: osobny dokument „Marki i domyślni dostawcy".

## 3. Pola własne i poziomy cen

Pola własne towaru (tw_Parametr, etykiety twp_Nazwa1..8; wartości w tw__Towar.tw_Pole1..8):
- Pole 1 „Lokalizacja" — wypełnione u 3 811 towarów (4,8%). Jedyne pole własne z etykietą. DO POTWIERDZENIA, że to lokalizacja magazynowa (regał/półka).
- Pola 2, 5, 6, 7, 8 — bez etykiety, 0 wypełnień.
- Pole 3 — bez etykiety, 3 wypełnienia; pole 4 — bez etykiety, 70 wypełnień. Zawartość nieznana (nie czytana) — DO POTWIERDZENIA, czy to pozostałości migracji.

Pola własne kontrahenta (kh_ParametrG, khp_Nazwa1..8; wartości kh_Pole1..8):
- Wszystkie 8 etykiet puste; 0 wypełnień u 234 547 kontrahentów. Pola własne kontrahentów NIE są używane.

Pola własne rozszerzone (pw_Pole / pw_Dane):
- 2 definicje: pole „e-mail" (typ obiektu −12; 31 650 wpisów w pw_Dane) oraz jedno pole tekstowe dla typu obiektu −9 (20 673 wpisów; etykieta pominięta w tym dokumencie, bo zawiera nazwę własną osoby).
- Wpisy pw_Dane wg typu obiektu: −12 → 31 650; −9 → 20 673; −44 → 696; −42 → 556; −90 → 28; pozostałe <10. Kody typów obiektów to identyfikatory Sfery — DO POTWIERDZENIA, które obiekty (dokument/kontrahent/pozycja) się pod nimi kryją.

Poziomy cen (tw_Parametr twp_NazwaCeny1..10; wartości tw_Cena.tc_CenaNetto1..10; liczba towarów z ceną > 0):
- 1 „Detaliczna" — 73 507 towarów (92%).
- 2 „Hurtowa" — 19 374 (24%).
- 3 „Promocja" — 55 162 (69%).
- 4 „Kartotekowa" — 40 867 (51%).
- 5 „Sugerowana przez producenta" — 22 281 (28%).
- 6 „Ekspozycja" — 34 586 (43%).
- 7–10 — bez nazwy, 0 towarów (nieużywane).
- Cena zakupu (tc_CenaNetto0) — 46 035 towarów (58%).

Domyślny poziom cen wg typu dokumentu (dok_Parametr, dkp_CenyPoziom; dkp_CenyTyp: 1 = netto, 0 = brutto):
- FS „Faktura Vat" → poziom 1, netto; FS podtyp 1 „Faktura VAT Detaliczna" → 1, brutto; FS podtyp 2 → 2, netto; FS zaliczkowe (3, 4, 5) → 1, brutto.
- PA „Paragon" i „Paragon imienny" → 1, brutto. ZW „Zwrot ze sprzedaży detalicznej" → 1, brutto.
- ZK „Zamówienie od klienta" → 2, netto. KFS → 2, netto. WZ → 1, brutto.
- FZ, KFZ, PZ → −1 (cena zakupu z dokumentu).

Poziom cen faktycznie użyty na dokumentach (dok_CenyPoziom, od 2025-01-01):
- ZK: poziom 2 „Hurtowa" 84 988; poziom 1: 10. Zamówienia z integratora wchodzą NA POZIOMIE 2.
- PA: poziom 2 — 47 304; poziom 1 — 926 (paragony dziedziczą poziom z ZK).
- FS: poziom 1 — 32 392; poziom 2 — 3 918; poziom 3 — 1.
- WZ: poziom 2 — 51 328; poziom 1 — 32 956; −1 — 1 321.
- Wniosek: nazwa „Hurtowa" (poziom 2) w tej instancji NIE oznacza sprzedaży hurtowej — to poziom cen kanału internetowego/zamówień, a „Detaliczna" (1) to poziom faktur. DO POTWIERDZENIA — od tego zależy każda analiza marży per kanał.

## 4. Marki (sl_GrupaTw) i cechy towarów (sl_CechaTw)

Marki = grupy towarowe (sl_GrupaTw): 93 zdefiniowane, 93 użyte; 9 towarów bez grupy. Grupa „Podstawowa" (476 towarów) to domyślna grupa programu, „nieaktywna" (224 towarów, 5 aktywnych) to kosz na wycofane pozycje — DO POTWIERDZENIA. Liczby = towary nieusunięte (w nawiasie aktywne, jeśli różni się od liczby towarów):
- Marki z ≥1 000 towarów (22): GLOBO 5 608 (2 217 aktywnych); Italux 5 440 (3 858); Nova Luce 5 404; Nowodvorski 4 818 (4 817); Rabalux 4 284; Azzardo 4 090; Eglo 3 865; Candellux 3 794 (3 767); TK Lighting 3 447 (2 266); Spotline 3 257; Zuma Line 3 186 (3 030); Trio 2 965 (1 673); Markslojd 2 957; Brilliant 2 824; Alfa 2 702; Milagro 2 696; Lucide 2 329; Luminex 1 914; Philips 1 542; SIGMA 1 284; Wojnarowscy 1 178; RL 1 030.
- Marki 100–999 towarów (22): Max Light 905; SKOFF 825; Antigo 799; Sollux 672 (669); SuMa 665 (637); Britop 521; Podstawowa 476 (475); Lutec 361; Ledlumen 357; Hoegert 353; Reality 336; Light Prestige 310; Elem 274; nieaktywna 224 (5); VIP Electro 197 (196); Yaskr 190; Hellux 186; Paul Neuhaus 186; Astra 177; GTV 123; 2BM 114; Kobi 105.
- Marki 10–99 towarów (16): Emos 80; Nordlux 78; ECO LIGHT 65; Shilo 61; SIDER TRADE 46; Auhilon 45; ActiveJet 37; Karlik 35; Norlys 28; Steinel 21; Orlicki 19; NAMAT 17; SPOTLight 17; Kanlux 15; LED-POL 13.
- Marki poniżej 10 towarów (33): Aldex 9; Ospel 9; Profile LED 7; ilove.lighting 7 (5); Szpak 7; LeuchtenDirekt 7; Brilum 6; Dohar 6; Kolorowe Kable 5; LumiLight 5; ALU-LED 5; LEDIN 4; Patron 3; Osram 3; SMD Ledline 3; Step into Design 3; DomenoLED 3; Dalen 2; Lysne 2; BELLIGHT 2; Amplex 2; LEDline 2; Elstead Lighting 2; TOMA Lighting 2; Maytoni 2; NA 1; Kaspa 1; domiluce 1; Argon 1; Ideus Struhm 1; LIGHT BRANDS 1; Moosee 1; AndLight 1; Kontakt-Simon 1.
- Uwaga o duplikatach: „Ledlumen" (357) i „LEDline"/„SMD Ledline" oraz „Zuma Line" (grupa) i „Zuma_Line" (cecha) to prawdopodobnie te same marki zapisane różnie — DO POTWIERDZENIA przed scaleniem w analizach.
- Kanały: tw_SklepInternet = 1 u 26 213 towarów; tw_SerwisAukcyjny = 1 u 5 685; tw_SprzedazMobilna = 1 u 29 505 (mimo że moduł sprzedaży mobilnej jest pusty — flaga używana w innym celu, DO POTWIERDZENIA, np. jako znacznik eksportu do integratora).

Cechy towarów (sl_CechaTw → tw_CechaTw): 53 zdefiniowane, 45 użyte; 13 413 towarów ma ≥1 cechę (17%), 28 278 przypisań. Cechy pełnią TRZY role naraz (DO POTWIERDZENIA):
- Kategoria asortymentowa: Lampy_wewnętrzne 4 645; LAMPY_WEWNETRZNE 2 004; Wiszące 1 999; Plafony 1 122; Kinkiety 1 024; Spoty 908; LAMPY_ZEWNETRZNE 822; Stołowe_Nocne 445; Wpuszczane 417; Podtynkowe 278; Podłogowe 216; Lampy_stojące 215; Kinkiety_zewnętrzne 185; Lampy_zewnętrzne 181; Spoty_zewnętrzne 137; Akcesoria 105; Lampy_najazdowe 74; Plafony_zewnętrzne 57; SZYNOPRZEWODY 54; Lampy_do_zabudowy 48; Reflektory_zewnętrzne 45; Kryształowe 29; Latarnie 8; Reflektorki 7; Oprawy_schodowe 6; Klosze 4; Oprawy_natynkowe 1; lampy_biurkowe 1; Latarnia 1; Stołowe 1.
- Duplikat marki (cecha o nazwie marki): Spotline 3 249; Eglo 2 020; Nowodvorski 1 775; Max_Light 696; CANDELLUX 258; Astra 177; Suma 175; Zuma_Line 159; Italux 41; Light_Prestige 2; Kinkiety_Light_Prestige 2.
- Status handlowy: Pozakatalogowa 2 270; Wyprzedaż 958; ŚWIĄTECZNE 860; Nowość 597.
- Warianty pisowni („Lampy_wewnętrzne" vs „LAMPY_WEWNETRZNE", „Latarnie" vs „Latarnia") wskazują ręczne prowadzenie słownika — w analizach normalizować.

## 5. Dokumenty: typy, podtypy, statusy, magazyny, kategorie, płatności

### 5.1 Typy dokumentów w użyciu (dok_Typ, cała historia)
- 11 WZ (wydanie zewnętrzne) — 250 730; od 2015-09-08. Prawie każda sprzedaż ma WZ (185 579 WZ bez płatnika = WZ do paragonów).
- 16 ZK (zamówienie od klienta) — 243 832; od 2015-10-02.
- 21 PA (paragon) — 185 851; od 2016-02-05.
- 10 PZ (przyjęcie zewnętrzne) — 67 487; od 2015-08-24 (67 481 to podtyp 1 „Automatyczne przyjęcie zewnętrzne" — PZ generowane z FZ).
- 2 FS (faktura sprzedaży) — 65 693; od 2015-09-08.
- 1 FZ (faktura zakupu) — 49 761; od 2015-08-24.
- 14 ZW (zwrot ze sprzedaży detalicznej) — 15 872; od 2016-02-29.
- 6 KFS (korekta faktury sprzedaży) — 4 514; od 2015-12-07.
- 5 KFZ (korekta faktury zakupu) — 3 836; od 2016-07-18.
- 13 RW (rozchód wewnętrzny) — 373; 9 MM (przesunięcie międzymagazynowe) — 225 (od 2018-06-10); 12 PW (przychód wewnętrzny) — 123; 15 ZD (zamówienie do dostawcy) — 66 (ostatnie 2025-03-17 — moduł zamówień do dostawców praktycznie nieużywany); 29 IW (inwentaryzacja) — 2; 4 RS (rachunek sprzedaży) — 2; 3 RZ (rachunek zakupu) — 1.
- NIE występują: ZPZ, ZWZ, TS, FM, KFM, ZM, faktury wewnętrzne (dfw 0 wierszy), noty korygujące (dnk 0).

### 5.2 Podtypy (dok_Podtyp) i statusy
- FS: podtyp 0 „Faktura Vat" 60 763; podtyp 1 „Faktura VAT Detaliczna" (FSd, do paragonu) 4 361 (ostatnia 2026-02-26 — po marcu 2026 nie wystawiane); podtyp 2 (FS z poziomem 2) 168; podtyp 3 „Faktura VAT zaliczkowa" 403.
- PA: podtyp 0 „Paragon" 185 849; podtyp 2 „Paragon imienny" 2. Paragony w tej instancji są ANONIMOWE (bez płatnika).
- ZK: podtyp 0 — 243 832 (1 zamówienie z zaliczką w 2018). Statusy ZK od 2025-01-01: 8 „zrealizowane" 82 975; 6 „niezrealizowane bez rezerwacji" 1 621; 7 „niezrealizowane z rezerwacją" 402.
- KFS: podtyp 0 — 4 474; podtyp 1 — 40. KFZ: 3 830 + 6. WZ: podtyp 1 „Wydanie zewnętrzne" 249 681; podtyp 2 „z VAT" 1 044; podtyp 0 — 7.

### 5.2a Statusy zamówienia od klienta (ZK, dok_Typ 16): wartości dok_Status 5, 6, 7, 8 i brak statusu „anulowane"
- Znaczenie `dok_Status` dla ZK wg dokumentacji producenta (inne niż dla faktur, gdzie 1 = wykonany, 2 = unieważniony): 5 = niezrealizowane; 6 = niezrealizowane bez rezerwacji (otwarte); 7 = niezrealizowane z rezerwacją (otwarte, towar zarezerwowany); 8 = zrealizowane.
- Wartości faktycznie występujące w tej instancji (cała historia, pomiar 2026-10-05): 8 — 243 149; 6 — 3 692 (od 2018); 7 — 673 (od 2022). Status 5 nie występuje ani razu. Innych wartości (0, 1, 2, 3) na ZK nie ma.
- Status 6 NIE oznacza zamówienia anulowanego — to zamówienie otwarte bez rezerwacji towaru. Anulowane zamówienie nie ma osobnego statusu: w `dok_Status` ZK nie istnieje wartość „anulowane" ani „unieważnione" (wartość 2 „unieważniony" dotyczy faktur i nie występuje na ZK). Co się dzieje z zamówieniem wycofanym przez klienta (usunięcie dokumentu, pozostawienie w statusie 6 albo oznaczenie flagą własną/kategorią przez integrator) — DO POTWIERDZENIA; z samego `dok_Status` nie da się odróżnić zamówienia anulowanego od otwartego.
- Stopień realizacji pokazuje `dok_StatusEx` (flagi sumowalne: 1 częściowo, 2 różnicowo, 4 całkowicie, 8 faktura zaliczkowa pośrednia, 16 faktura zaliczkowa końcowa). ZK od 2025-01-01 (pomiar 2026-10-05): status 8 z flagą 4 „całkowicie" — 85 982; status 8 z flagami 8+16 (zaliczki) — 223; status 8 z flagą 1 „częściowo" — 43; status 7 bez flag — 640; status 7 z flagą 8 (wystawiona zaliczka) — 26; status 6 bez flag — 1 712.
- Otwarte zamówienia w zapytaniach: `dok_Typ = 16 AND dok_Status IN (5, 6, 7)`; zrealizowane: `dok_Status = 8` (szablony „Realizacja zamówień od klientów (ZK)" i „Otwarte zamówienia od klientów (ZK) starsze niż N dni").

### 5.3 Zmiana konwencji od marca 2026 (paragony → faktury) — potwierdzone przez właściciela 2026-09-28
Miesięczne liczby PA / FS / KFS / ZW:
- 2025: PA od 2 541 (czerwiec) do 5 212 (grudzień) miesięcznie; FS 725–1 483; KFS 38–91; ZW 217–546.
- 01.2026: PA 3 281, FS 917, KFS 51, ZW 311. 02.2026: PA 2 862, FS 1 015, KFS 66, ZW 307.
- 03.2026: PA 43, FS 4 043, KFS 288, ZW 105. 04–08.2026: PA 29–52 miesięcznie, FS 2 963–3 967, KFS 255–365, ZW 2–8.
- Potwierdzone (właściciel, 2026-09-28): od marca 2026 sprzedaż detaliczna z zamówień jest dokumentowana FAKTURĄ FS (fiskalizowaną: od 03.2026 17 957 FS ma dok_StatusFiskal = 1, 4 345 = 0) zamiast paragonem PA, a zwroty — korektą KFS zamiast ZW. Moment zbiega się z rejestracją faktur w KSeF (pierwsza FS ze statusem KSeF 5 „zarejestrowana" 2026-03-31). W analizach porównujących lata: sprzedaż detaliczna = PA + FS(detal), a nie samo PA.
- Przed marcem 2026 (2025-01..2026-02): PA 47 976 fiskalizowanych (status 1), FS 12 442 niefiskalizowanych (status 0) i 159 fiskalizowanych; FSd 844.

### 5.4 KSeF i fiskalizacja
- dok_StatusKSeF na FS od 2025-01-01: 0 „brak" 33 479; 5 „zarejestrowana w KSeF" 2 808 (od 2026-03-31 do 2026-09-10); 1 „wygenerowana" 24 (bieżący dzień). KFS: status 5 — 199 (od 2026-04-01). Wysyłka do KSeF działa, ale obejmuje mniejszość FS (faktury B2B?) — DO POTWIERDZENIA kryterium wysyłki.
- dok_StatusFiskal na PA od 2025-01-01: 1 „jednokrotnie zarejestrowany" 48 227; 2 „wielokrotnie" 2; 0 — 1. Na FS: 0 — 18 188; 1 — 18 122; 128 „błąd rejestracji" — 1.

### 5.5 Magazyny (sl_Magazyn) — wszystkie ze statusem 1 (aktywny), żaden POS
- MAG „Główny" (mag_Glowny = 1) — 885 981 dokumentów (99,7%), od 2015-08-24. Jedyny magazyn operacyjny sprzedaży internetowej.
- RKR „Krosno" — 892 dokumentów od 2025-08-05: FS 58, KFS 2, MM 17, PZ 15, WZ 354, RW 1, ZW 13, ZK 132, PA 300 — punkt sprzedaży stacjonarnej (forma płatności „Terminal Krosno"). DO POTWIERDZENIA.
- KOS „Koszt" — 1 219 dokumentów od 2026-01-01: wyłącznie FZ 1 209 i KFZ 10 — magazyn techniczny na faktury kosztowe (nie towarowe). Od 2026 koszty księguje się jako FZ na ten magazyn. DO POTWIERDZENIA.
- AZZ „Azzardo" — 276 dokumentów od 2018-10-29 do 2026-06-08 (od 2024: FS 1, PZ 5, IW 1) — magazyn dedykowany jednej marce, praktycznie nieaktywny (depozyt/komis? DO POTWIERDZENIA).
- EIL „Ekspozycja ILOVE.LIGHTING" — 2 dokumenty (06.2024): magazyn ekspozycji, nieużywany.
- Przesunięcia MM: 225 w historii, 171 w 2026 — MM pojawiły się wraz z magazynem Krosno.

### 5.6 Kategorie dokumentów (sl_Kategoria) = kanał sprzedaży — potwierdzone przez właściciela 2026-09-28
- 89 kategorii zdefiniowanych, 76 użytych; 868 615 z 888 370 dokumentów (97,8%) ma kategorię (dok_KatId).
- Nazwy kategorii to konta sklepów i marketplace'ów, więc dok_KatId jest JEDYNYM polem, po którym można policzyć sprzedaż per kanał.
- ZK od 2025-01-01 wg kategorii: ilovelighting 22 333; lampy_24h_sanok 16 180; ilove.lighting 14 378; oficjalny24 3 952; 2bm.pl 3 217; swietliscie 3 051; globolighting 2 293; ilove.lighting_empik 1 787; zumaline.lighting 1 491; sma_zumaline 1 370; Rabalux 1 317; sma_suma 1 004; sma_azzardo 976; tklighting.eu 956; 2bm 683; ilove.lighting_castorama 670; Sprzedaż 516; TKLighting 505; ilove.lighting_mediaexpert 367; sma_candellux 349; Wycena 331; sma_markslojd 319; ilove.lighting_leroymerlin 165; ilove.lighting_brw 157; Base. Connect 151; Base. Merchant 78; erli_2bm 77; ilove.lighting_homeandyou 69; erli_ilovelighting 68; szwedzkalampa.pl 68; lampa24.com 57; ilove.lighting_kaufland 53; Markslojd 28; ilovelighting_ceneo 11; ilove.lighting_inpost 9; Nowodvorski_48h 8; zuma-line.net 6; luminex.lighting 5; 2bm_ceneo 4; Azzardo 4.
- FS od 2025-01-01 wg kategorii (najliczniejsze): ilovelighting 9 033; lampy_24h_sanok 6 612; ilove.lighting 5 427; Sprzedaż 2 140; swietliscie 1 648; oficjalny24 1 339; 2bm.pl 1 086; globolighting 1 049; tklighting.eu 1 005; ilove.lighting_castorama 673; ilove.lighting_empik 583; zumaline.lighting 579; sma_zumaline 547; sma_suma 522; TKLighting 485; Rabalux 428; 2bm 406; ilove.lighting_mediaexpert 359; sma_azzardo 335; Wycena 297; B2B_ilovelighting 69; Marketing 1; Morele 1.
- PA od 2025-01-01 wg kategorii: ilovelighting 11 651; lampy_24h_sanok 7 882; ilove.lighting 6 850; Sprzedaż 6 309; oficjalny24 2 369; 2bm.pl 1 915; swietliscie 1 136.
- Odczyt nazw (potwierdzony przez właściciela 2026-09-28; „Sprzedaż" = sprzedaż stacjonarna, „lampy_24h_sanok" = sklep internetowy, nie punkt fizyczny): konta z sufiksem „_empik", „_castorama", „_mediaexpert", „_leroymerlin", „_brw", „_homeandyou", „_kaufland", „_inpost", „_ceneo", „erli_*" i „Morele" = marketplace'y partnerskie; „ilovelighting", „lampy_24h_sanok", „oficjalny24", „swietliscie", „globolighting", „2bm.pl", „tklighting.eu", „zumaline.lighting", „szwedzkalampa.pl", „lampa24.com", „luminex.lighting", „zuma-line.net" = własne sklepy/konta aukcyjne; „sma_*" = konta sklepów markowych (sma_zumaline, sma_suma, sma_azzardo, sma_candellux, sma_markslojd); „Base. Connect"/„Base. Merchant" = kanały BaseLinker; „Sprzedaż" = sprzedaż bez kanału (stacjonarna); „Wycena" = oferty/wyceny; „B2B_ilovelighting" = kanał hurtowy.

### 5.7 Formy płatności (sl_FormaPlatnosci): 40 zdefiniowanych, wszystkie aktywne
- Odroczone (fp_Typ 0): „Odroczony 3/7/14/21/28/30/40 dni", „Pobrano z wpływów".
- Karta/bramki online (fp_Typ 1): „Płatność kartą", „Terminal Sanok", „Terminal Krosno", „PayU", „PayU Allegro Finance", „Przelewy24", „Przelewy24 Allegro Finance", „Allegro Finance", „Castorama Finance", „Kaufland Finance", „Empik Finance", „Ceneo Finance", „BRW Finance", „HomeAndYou Finance", „Erli Finance", „Morele Finance", „Media Expert Finance", „InPost Finance", „Leroy Merlin Finance" oraz drugi komplet „Pobranie", „Pobranie GLS", „Pobranie InPost", „Pobranie Poczta Polska" jako typ 1.
- Pobranie (fp_Typ 3, termin 14 dni): „Pobranie", „Pobranie DPD", „Pobranie GLS", „Pobranie InPost", „Pobranie Poczta Polska", „Pobranie DHL", „Pobranie FedEx", „Pobranie Allegro Finance", „Płatność Merchant" (30 dni).
- Formy z sufiksem „Finance" odpowiadają wypłatom z marketplace'ów (powiązanie z kategoriami dokumentów z sekcji 5.6). Duplikaty nazw („Pobranie GLS" jako typ 1 i 3) — przy raportowaniu grupować po nazwie. DO POTWIERDZENIA.
- Rabaty (sl_Rabat): 3 definicje („Rabat" 20%, „Do Pozycji" 10%, „Do Dokumentu" 22%), 0 przypisań do kontrahentów i towarów — słownik nieużywany.

## 6. Słownik skrótów tej instancji (tylko to, co używane)
- FS — faktura sprzedaży (dok_Typ 2); FSd — faktura detaliczna do paragonu (podtyp 1); FS zaliczkowa (podtyp 3).
- PA — paragon (dok_Typ 21), w tej instancji anonimowy; PAi — paragon imienny (podtyp 2, marginalny).
- FZ — faktura zakupu (dok_Typ 1); PZ — przyjęcie zewnętrzne (10), tu prawie zawsze automatyczne z FZ (podtyp 1).
- WZ — wydanie zewnętrzne (11); ZW — zwrot ze sprzedaży detalicznej (14); KFS/KFZ — korekty faktur (6/5).
- ZK — zamówienie od klienta (16), źródło: integrator; statusy 6/7 = niezrealizowane (bez/z rezerwacją), 8 = zrealizowane.
- ZD — zamówienie do dostawcy (15, śladowe); MM — przesunięcie międzymagazynowe (9); RW/PW — rozchód/przychód wewnętrzny (13/12); IW — inwentaryzacja (29).
- kh_OdbDet — odbiorca detaliczny (1 = tak); kh_Osoba — osoba fizyczna (1) vs firma (0); kh_Rodzaj — deklarowany rodzaj (niepielęgnowany); dok_PlatnikId — kontrahent dokumentu (klient na FS/PA/ZK, dostawca na FZ/PZ).
- Poziomy cen: 1 Detaliczna (faktury), 2 Hurtowa (zamówienia/paragony z integratora), 3 Promocja, 4 Kartotekowa, 5 Sugerowana przez producenta, 6 Ekspozycja; −1 na dokumentach zakupu = cena z dokumentu.
- Marka = grupa towarowa (sl_GrupaTw, tw_IdGrupa). Cecha = sl_CechaTw (kategoria asortymentu / duplikat marki / status handlowy).
- Kategoria dokumentu (sl_Kategoria, dok_KatId) = kanał sprzedaży (konto sklepu/marketplace'u); „sma_*" = sklepy markowe; „*_Finance" (forma płatności) = wypłata z marketplace'u.
- Magazyny: MAG Główny; RKR Krosno (stacjonarny); KOS Koszt (faktury kosztowe FZ); AZZ Azzardo (nieaktywny); EIL Ekspozycja (nieużywany).
- tw_Rodzaj: 1 towar, 2 usługa, 4 opakowanie, 8 komplet (16 opłata — nie występuje).
- dok_StatusKSeF: 0 brak, 1 wygenerowana, 5 zarejestrowana w KSeF. dok_StatusFiskal: 0 niezarejestrowany, 1 zarejestrowany, 2 wielokrotnie, 128 błąd.
- Sublinker — integrator BaseLinker ↔ Subiekt GT (tabele sublinker_*); BL/„Base." — BaseLinker.

## 7. Czego w tej instancji NIE ma (puste albo tylko definicje producenta)
- CRM/Gestor: crm_Parametr 0 wierszy; zadania zd__Zadanie 3, słowniki sl_Crm* nieużywane. Brak procesu CRM w Subiekcie.
- Kadry i płace (Gratyfikant): pr_* (25 tabel) 0 wierszy; ecp_* (ewidencja czasu pracy) 0; ppr 1; pl_/plb_ zawierają wyłącznie definicje składników (plb_SkladnikAbsencja 1 239, plb_Skladnik 69) — brak umów i wypłat.
- Vendero / sklep internetowy InsERT (Feniks): fnx_* (30 tabel) 0 wierszy. Sello: brak tabel w tej bazie. Sprzedaż internetowa idzie wyłącznie przez integrator zewnętrzny.
- Sprzedaż mobilna: mi_* 1 wiersz (mimo flagi tw_SprzedazMobilna u 29 505 towarów).
- Cenniki: cen_* 0; cenniki indywidualne icen_* — tylko 21 wierszy typów parametrów, 0 cenników; promocje prm_* — 7 wierszy definicji, 0 promocji; rabaty sl_Rabat — 3 definicje, 0 przypisań; kh_IdRabat i tw_IdRabat puste.
- Pola własne kontrahentów: 0 etykiet, 0 wartości. kh_Cena (standardowy poziom cen kontrahenta): NULL u 100%. kh_IdOdbiorca: 0. Cechy kontrahentów: 6 zdefiniowanych, 3 użyte, 16 kontrahentów z cechą (tylko „Warunki:Rabat 30" ≥10).
- Grupy kontrahentów nie klasyfikują (99,8% w „Podstawowa"). Flagi kh_Zablokowany i kh_Potencjalny — poniżej progu k=10.
- Księgowość w tej bazie: księgi handlowe dkr_* 2 wiersze; rejestry VAT vat_* 19; deklaracje dekl_* 545 (DO POTWIERDZENIA czy używane); JPK — jpk_* 125 wierszy definicji, brak wygenerowanych plików; KPiR kpr 1; ryczałt prz 11. Księgowość prowadzona poza tą instancją — DO POTWIERDZENIA.
- Finanse: kasa dks_* 34 wiersze parametrów; home banking hb_Transakcja 4; rachunki bankowe rb_* 114; windykacja zw_* 4 (zdarzenia), ink 0; cesje nz_Cesja 11; kompensaty — nie liczone.
- Środki trwałe st_*: tylko słowniki KST (st_KST 523, st_KST2016 374), brak środków trwałych. Pojazdy poj 1.
- Komunikacja: e-mail em_* 1; SMS sms_* 2 (parametry); noty korygujące dnk 0; faktury wewnętrzne dfw 0; korekty kosztów kor 0; e-Dokumenty dostawy edd 1 (parametr); Intrastat int 1 (parametr); OSS oss 1 (parametr); akcyza ewa 0.
- Dokumenty: brak ZPZ/ZWZ/TS/FM/KFM/ZM; ZD (zamówienia do dostawców) 66 w historii, ostatnie 2025-03-17; RS/RZ śladowe.
- Inne: ctx (kontekst wielofirmowy) 0; oddziały — brak dokumentów poza magazynami z sekcji 5.5; tabele CERTECH_* i zzt_* — 0 wierszy (pozostałości wdrożeń).

Zasada użycia tego dokumentu: liczby są migawką z 2026-09-11 (odświeżane agregatami — dokument „Liczby o instancji"); do pytań „ile dziś", „kto", „które zamówienie" służy zapytanie SQL przez strażnika, nie ta baza wiedzy. Każde „DO POTWIERDZENIA" traktować jako hipotezę do zatwierdzenia przez właściciela, a po zatwierdzeniu — usunąć oznaczenie w kolejnej wersji dokumentu.
