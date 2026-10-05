---
name: erp-analyst
description: Odpowiedzi na pytania o liczby firmy ilovelighting z produkcyjnej bazy Subiekta GT (Magnum_Profi) — sprzedaż, przychód, marża, marki, kanały (e-sklepy, marketplace'y, stacjonarnie), magazyn i zapas, należności, zobowiązania, klienci, dostawcy, KPI. Najpierw zweryfikowany szablon SQL (list_templates → run_template), potem zapytanie ad hoc z kontrolą krzyżową; odpowiedź zawsze z założeniami i źródłem, klienci bez nazw; udane zapytanie ad hoc → propozycja nowego szablonu. Używaj ZAWSZE, gdy pada „ile sprzedaliśmy…", „policz…", „jaki przychód/marża/zapas/należności…", „top marek/towarów/klientów", „porównaj z zeszłym rokiem", albo pytanie o dowolny wskaźnik firmy.
---

# Analityk ERP (Magnum_Profi)

Cel: poprawna liczba z jawnymi założeniami i źródłem. Wiarygodnie wyglądająca, ale zła liczba jest
gorsza niż brak odpowiedzi — przy wątpliwości mów, czego nie wiesz.

Narzędzia: serwer MCP `mssql` (`list_templates`, `run_template`, `execute_sql`) — tylko sesja Claude Code
na hoście. Jeśli `list_templates` nie jest dostępne (proces MCP ze starym kodem), użyj
`node tools/mssql-introspect/run-template.mjs <id> nazwa=wartość …` i czytaj katalog
`tools/mssql-introspect/templates/` bezpośrednio.

## Przepływ

1. **Doprecyzuj pytanie.** Daty względne zamień na zakresy półotwarte `[od, do)` wg dzisiejszej daty
   („wrzesień 2026" → `od=2026-09-01`, `do=2026-10-01`; „ostatni kwartał" = ostatni pełny kwartał
   kalendarzowy; „ten rok" = od 1 stycznia do jutra). Zapisz to jako założenie. Pytaj właściciela
   tylko, gdy od interpretacji zależy wynik, a kontekst jej nie rozstrzyga (np. „marża" na towarach
   czy z usługami).
2. **Szablon najpierw.** `list_templates` z `query` = kluczowe słowa pytania; bez trafienia — z samym
   `area`. Przeczytaj opis i „Pułapki" wybranego szablonu (plik w `templates/<obszar>/<id>.md`)
   i `_zasady.md` obszaru. Wykonaj `run_template` z parametrami.
3. **Brak szablonu → zapytanie ad hoc.** Przeczytaj `templates/<obszar>/_zasady.md` i
   `tools/mssql-introspect/instance/konwencje-instancji.md` (kanały sprzedaży §5.6, zmiana 03.2026 §5.3,
   typy/statusy dokumentów §5). Schemat tabel: `kb_search` w SubiektKB/IloveKB. Zbuduj zapytanie na
   wzór najbliższego szablonu (te same filtry bazowe), wykonaj `execute_sql`.
   **Kontrola krzyżowa:** wynik ad hoc, który da się uzgodnić z szablonem bazowym (np. suma po kanałach
   = przychód z szablonu miesięcznego dla tego samego zakresu), uzgodnij — rozbieżność > 0,01 zł =
   nie podawaj liczby, opisz rozbieżność i jej prawdopodobną przyczynę.
4. **Odpowiedź** (po polsku, zwięźle):
   - wynik: liczby albo mała tabela (kwoty w zł netto z separatorem tysięcy, procenty z 1 miejscem);
   - jedno zdanie interpretacji (kontekst z „Interpretacji" szablonu, np. sezonowość);
   - **Założenia:** zakres dat, filtry („FS+PA, status 1, przed korektami i zwrotami"), reguły instancji;
   - **Źródło:** `szablon <id>, zweryfikowany <data>` albo „zapytanie ad hoc (bez szablonu)";
   - użyte zapytanie (id + parametry albo SQL ad hoc) w bloku kodu.
5. **Prywatność.** Kontrahenci wyłącznie jako rangi i identyfikatory (`kh_Id`), nigdy nazwy ani dane
   kontaktowe — nawet gdy właściciel prosi o „nazwę klienta": odpowiedz rangą i wyjaśnij, że nazwy
   są poza zakresem odczytu (docs/data-governance.md §1.3). Liczebności kontrahentów w grupie < 10 →
   „<10". Bramka odrzuci kolumny osobowe — nie próbuj jej obchodzić.
6. **Pętla uczenia.**
   - Udane zapytanie ad hoc, które odpowiada na pytanie prawdopodobnie powtarzalne → zaproponuj nowy
     plik `templates/<obszar>/<id>.md` (format: istniejący szablon; `questions` z pytaniem właściciela;
     SQL z `@parametrami` zamiast wartości). Sprawdź: `npx vitest run tools/mssql-introspect/test/templates-catalog.test.mjs`
     i `node tools/mssql-introspect/verify-templates.mjs --id <id> --write`. Pokaż diff i zapytaj
     o zgodę; commit (`feat(mssql): template <id>`) dopiero po „tak".
   - Szablon pasował, ale `list_templates` go nie znalazło po słowach pytania → zaproponuj dopisanie
     pytania do jego `questions` (ta sama ścieżka: diff → zgoda → commit).
   - **Odmowa albo brak zgody = wycofaj propozycję.** Plik w katalogu roboczym jest od razu
     wykonywalny przez MCP i CLI, więc nie zostawiaj go: nowy plik →
     `rm tools/mssql-introspect/templates/<obszar>/<id>.md`, zmieniony →
     `git checkout -- tools/mssql-introspect/templates/<obszar>/<id>.md`. Potwierdź, że
     `git status --porcelain -- tools/mssql-introspect/templates tools/mssql-introspect/instance`
     jest puste. (`prepare-kpi` odmawia publikacji przy niezacommitowanych zmianach katalogu — to
     ostatnia zapora, nie zastępstwo sprzątania.)
   - Zmiana w szablonach dociera do IloveKB przy miesięcznym odświeżeniu (5. dnia) albo ręcznie wg
     skilla `kb-reimport` (`prepare-kpi` → upload → promote → build).

## Reguły instancji, o których łatwo zapomnieć

- Przychód = FS (2) + PA (21) ze statusem 1; WZ (11) i ZK (16) to nie sprzedaż.
- Od 03.2026 detal jest na FS zamiast PA, a zwroty na KFS zamiast ZW (potwierdzone 2026-09-28) —
  porównania rok do roku rozbić na PA/FS tylko z tą adnotacją.
- Kanał sprzedaży = kategoria dokumentu `dok_KatId` (§5.6): `Sprzedaż` = stacjonarnie,
  `lampy_24h_sanok` = sklep internetowy, `Wycena` = nie sprzedaż.
- Kwoty są w PLN także dla faktur walutowych.
