# Analityk ERP — katalog szablonów SQL + `run_template` + skill `erp-analyst` (2026-09-28)

Zatwierdzony projekt (sesja brainstormingu 2026-09-28, kierunek „1” z przeglądu: agenci przez MCP + praca
właściciela z ERP). Decyzja architektoniczna „mssql MCP tylko dla Claude Code na hoście” (`docs/design/PLAN.md`
§ „Zmiany decyzji”, 2026-09-11) **pozostaje bez zmian** — rozszerzamy wyłącznie narzędzia tego serwera.

## Cel

Pytanie biznesowe o firmę (np. „ile sprzedaliśmy we wrześniu vs rok temu”) zadane w sesji Claude Code ma
dostać **poprawną liczbę z jawnymi założeniami i źródłem**, w stałym przepływie: szablon zweryfikowany na
produkcji → parametry → wykonanie przez bramkę tylko-do-odczytu → odpowiedź. Zapytania ad hoc, które się
sprawdziły, stają się nowymi szablonami, więc biblioteka rośnie z użyciem.

Kryterium sukcesu: 8 pytań akceptacyjnych (niżej) daje oczekiwane zachowanie na żywej bazie Magnum_Profi;
eval IloveKB po re-imporcie nie gorszy niż przed.

## Stan zastany (fakty, 2026-09-28)

- 46 szablonów SQL (17 sprzedaż, 15 finanse, 14 magazyn), przetestowanych na produkcji 2026-09-14, leży
  w trzech dokumentach redakcyjnych `kpi-{sprzedaz,finanse,magazyn}.md` (45–56 tys. znaków każdy) oraz
  `konwencje-instancji.md` — **wyłącznie** w `/srv/kag-data/import/ilovekb/out/docs/`, **poza git**.
- Daty w szablonach są wpisane na sztywno (`-- zakres: zamień daty`); agent podmienia je tekstowo.
- Serwer `tools/mssql-introspect/mcp-server.mjs` (stdio, rejestracja w `~/.claude.json`) ma jedno narzędzie
  `execute_sql`; bramka `src/mcp-readonly.mjs` (`checkReadOnly`: jeden SELECT/WITH, słowa zakazane,
  deny-lista kolumn/tabel PII), log treści zapytań `/srv/kag-data/kag/mcp-mssql/queries.jsonl` (0600).
- Żadne narzędzie PomagierKB (panel/MCP w kontenerach) nie sięga do ERP — i tak zostaje.

## Decyzje

| Decyzja | Uzasadnienie |
|---|---|
| Katalog szablonów w repo = źródło prawdy; dokumenty KPI w IloveKB generowane z katalogu | wersjonowanie i przegląd; testy łapią szablon łamiący bramkę; dziś treść istnieje tylko na dysku hosta |
| Jeden szablon = jeden plik Markdown z nagłówkiem YAML | treść redakcyjna (definicja, pułapki, interpretacja) jest równie ważna jak SQL |
| Parametry = natywne `@parametry` T-SQL przez `request.input()` z typem | brak wklejania wartości w tekst → brak wstrzyknięcia SQL; ten sam SQL przechodzi `checkReadOnly` |
| `run_template` nadal woła `checkReadOnly` na SQL szablonu | obrona w głąb; testy CI to pierwsza linia, bramka w runtime druga |
| `execute_sql` zostaje | zapytania ad hoc dla pytań bez szablonu — źródło nowych szablonów |
| Nowy szablon = plik w repo do przeglądu właściciela (diff + commit), NIE szkic w Inboxie | jedno źródło prawdy; recenzja człowieka zachowana (właściciel zatwierdza commit w tej samej sesji) |
| Tytuły i `sourceUrl` dokumentów KPI bez zmian | re-import zastępuje wersje, identyfikatory dokumentów i goldens nie pękają |
| Parser YAML: pakiet `yaml` (już w drzewie zależności) dopisany jawnie do `tools/mssql-introspect/package.json` | bez nowej zależności w monorepo |

## 1. Katalog szablonów

```
tools/mssql-introspect/
  templates/
    sprzedaz/_zasady.md          # „Zasady wspólne” obszaru (dziś nagłówek kpi-sprzedaz.md)
    sprzedaz/<id>.md             # jeden szablon
    finanse/_zasady.md, finanse/<id>.md
    magazyn/_zasady.md, magazyn/<id>.md
  instance/
    konwencje-instancji.md       # przeniesione z out/docs, z potwierdzeniami właściciela
```

Plik szablonu:

````markdown
---
id: sales-net-monthly                 # kebab-case, unikalny w całym katalogu
title: Przychód netto ze sprzedaży — miesięcznie
area: sprzedaz                        # sprzedaz | finanse | magazyn (= katalog)
order: 10                             # kolejność w wygenerowanym dokumencie
questions:                            # 1+ przykładowych pytań (wyszukiwanie + goldens)
  - Ile wyniósł przychód netto we wrześniu 2026?
params:
  od: { type: date, description: początek zakresu (włącznie), example: 2025-01-01 }
  do: { type: date, description: koniec zakresu (wyłącznie), example: 2026-01-01 }
verified: 2026-09-14                  # ostatni udany przebieg run_template na produkcji
---
- Definicja: …
- Formuła: …
- Tabele i kolumny: …

```sql
SELECT … WHERE d.dok_DataWyst >= @od AND d.dok_DataWyst < @do …
```

- Pułapki: …
- Interpretacja: …
````

Reguły (egzekwowane testami):
- wymagane pola: `id`, `title`, `area` (zgodny z katalogiem), `questions` (≥ 1), `verified` (data), dokładnie
  jeden blok ```` ```sql ````;
- zbiór `@nazw` w SQL == zbiór kluczy `params` (każdy parametr użyty, każdy użyty zadeklarowany);
- typy parametrów: `date`, `int`, `number`, `text` (`maxLength`, domyślnie 100), `enum` (`values: [...]`);
  opcjonalnie `required: false` + `default`; każdy parametr ma `description` i `example`;
- SQL przechodzi `checkReadOnly`.

### Migracja istniejących 46 szablonów

1. Jednorazowy skrypt (`tools/mssql-introspect/migrate-kpi-templates.mjs`, usuwany w ostatnim commicie
   migracji — zostaje w historii git) rozcina `kpi-*.md` po nagłówkach `##` na pliki, sekcję
   „Zasady wspólne”/„Model…”/„Wspólne ustalenia” na `_zasady.md`, „Słownik kodów…” dołącza do `_zasady.md`.
2. Ręczny przegląd każdego pliku: literały dat → `@od`/`@do` (szablony z dwoma zakresami, np. YoY,
   dostają `@od`, `@do`, `@od_prev`, `@do_prev` albo liczą poprzedni zakres w SQL — per szablon), inne stałe
   biznesowe (N dni, top N, magazyn) → parametry tam, gdzie pytania tego wymagają.
3. Każdy szablon jeden raz przez `run_template` na produkcji z wartościami `example`; `verified` = data przebiegu.
   Szablon, który nie przechodzi, jest naprawiany przed publikacją dokumentów (brak publikacji z błędnym szablonem).

### Potwierdzenia właściciela (2026-09-28) → `konwencje-instancji.md`

- §5.6: kategoria `Sprzedaż` = sprzedaż stacjonarna; `lampy_24h_sanok` = sklep internetowy (nie punkt fizyczny);
  pozostałe przypisania kanałów bez zmian — zdjąć „DO POTWIERDZENIA”.
- §5.3: od 03.2026 sprzedaż detaliczna jest dokumentowana fakturą FS zamiast paragonu PA, a zwroty korektą KFS
  zamiast ZW — potwierdzone; zdjąć „DO POTWIERDZENIA”.
- Konsekwencja dla szablonów: KPI z rozbiciem PA vs FS (udział paragonów, średnia wartość paragonu) oraz
  zwroty ZW vs korekty KFS dostają w „Pułapkach” regułę porównań przez 03.2026 (detal = PA + FS detal;
  zwroty = ZW + KFS detal); przychód łączny FS+PA nie wymaga zmian.

## 2. Serwer MCP `mssql`: `list_templates` i `run_template`

Czysta logika w `tools/mssql-introspect/src/templates.mjs` (bez MCP i bez `mssql`), testowana:
- `loadCatalog(dir)` → `{ templates, rules, errors }` (parsowanie front-matter i bloku SQL, walidacja reguł z §1);
- `searchTemplates(catalog, { area, query })` — dopasowanie słów zapytania do `title` + `questions` (bez
  diakrytyków, case-insensitive), sortowanie po liczbie trafień;
- `validateParams(template, input)` → `{ ok, values }` | `{ ok: false, reason }` — obecność, typ (`date`
  = `YYYY-MM-DD` i poprawna data kalendarzowa, `int`/`number` skończone, `text` ≤ `maxLength`, `enum` ∈
  `values`), odrzucenie nieznanych kluczy, uzupełnienie `default`.

Narzędzia w `mcp-server.mjs` (katalog czytany przy KAŻDYM wywołaniu — edycja pliku działa bez restartu):
- **`list_templates({ area?, query? })`** → tekst/JSON: `id`, `title`, `area`, parametry (`typ`, `example`),
  `questions`, `verified`; przy `errors` w katalogu — lista błędnych plików (szablony błędne nie są zwracane).
- **`run_template({ id, params })`**:
  1. szablon istnieje i nie ma błędów → inaczej błąd z nazwą;
  2. `validateParams`;
  3. `checkReadOnly(sql)`;
  4. `pool.request()` + `request.input(nazwa, typSql, wartość)` (`date`→`sql.Date`, `int`→`sql.Int`,
     `number`→`sql.Decimal(18,4)`, `text`/`enum`→`sql.NVarChar(len)`), `request.query(sql)`;
  5. log: `{ via: 'template', templateId, params, ok, rows, ms }` (bez treści wyników; SQL identyfikowany id);
  6. odpowiedź jak `execute_sql` (limity 200 wierszy / 60 tys. znaków) + stopka
     `szablon <id> · zweryfikowany <verified>`.
- `execute_sql` bez zmian; `run-select.mjs` bez zmian.
- `serverInfo.version` → `0.2.0`; opis serwera w nagłówku pliku uaktualniony.

## 3. Skill `erp-analyst`

`.claude/skills/erp-analyst/SKILL.md` (po polsku, jak pozostałe skille projektu). Wyzwalacze: pytania o liczby
firmy (sprzedaż, marża, marki, magazyn, należności, klienci, kanały), „ile sprzedaliśmy…”, „policz…”, KPI.

Przepływ:
1. **Doprecyzowanie** — daty względne → zakresy półotwarte `[od, do)` wg dzisiejszej daty; założenia zapisane.
2. **Szablon najpierw** — `list_templates` (query z pytania, potem po obszarze) → `run_template`.
3. **Brak szablonu** — przeczytaj `_zasady.md` obszaru i `konwencje-instancji.md` (repo; w razie potrzeby
   `kb_search` IloveKB/SubiektKB dla schematu), zbuduj zapytanie, wykonaj `execute_sql`; **kontrola krzyżowa**
   z szablonem bazowym (np. suma kanałów = `sales-net-monthly` dla tego samego zakresu, tolerancja 0,01 zł),
   rozbieżność = nie odpowiadaj liczbą, tylko opisz problem.
4. **Odpowiedź** — liczby/tabela + jedno zdanie interpretacji; **Założenia** (zakres, filtry typu „FS+PA,
   status 1, przed korektami”); **Źródło** (`szablon <id>, zweryfikowany <data>` albo „zapytanie ad hoc”);
   użyty SQL (z wartościami parametrów).
5. **Prywatność** — kontrahenci wyłącznie jako rangi/identyfikatory, nigdy nazwy; grupy z liczbą kontrahentów
   < k=10 → „<10” (ta sama reguła co `dump-aggregates`); bramka i tak odrzuci kolumny PII.
6. **Pętla uczenia** — (a) udane zapytanie ad hoc → propozycja pliku szablonu (front-matter + definicja +
   pułapki + SQL z `@parametrami`), weryfikacja przez `run_template`, pokazanie diffu, commit **dopiero po
   zgodzie właściciela**; (b) trafiony szablon, którego `list_templates` nie znalazło po treści pytania →
   dopisz pytanie do jego `questions` (ta sama ścieżka: diff → zgoda → commit).

## 4. Dokumenty w IloveKB

- `tools/kb-import/prepare-kpi.mjs` (czysta funkcja renderująca + cienkie CLI, wzorem `prepare-instance.mjs`):
  katalog → `kpi-sprzedaz.md`, `kpi-finanse.md`, `kpi-magazyn.md` oraz kopia `konwencje-instancji.md`;
  wpisy manifestu scalane (`merge`) z istniejącym `manifest.json`, **z tymi samymi** tytułami i `sourceUrl`:
  - `Magnum_Profi — KPI: sprzedaż i marża (szablony SQL)` — `…/src/magnum-profi#dokumentacja/instancja/kpi-sprzedaz`
  - `Magnum_Profi — KPI: finanse i klienci (szablony SQL)` — `…#dokumentacja/instancja/kpi-finanse`
  - `Magnum_Profi — KPI: magazyn i zakupy (szablony SQL)` — `…#dokumentacja/instancja/kpi-magazyn`
  - `Magnum_Profi — konwencje i semantyka instancji` — `…#dokumentacja/instancja/konwencje`
- Render: `# tytuł` → `_zasady.md` → szablony wg `order`, każdy jako `## title` + treść + blok SQL
  z `@parametrami` + lista „Parametry” (nazwa, typ, opis, przykład) + „Wykonanie: `run_template <id>`” +
  „Zweryfikowano: <verified>”. Wynik deterministyczny (bez znaczników czasu w treści).
- `deploy/scripts/refresh_ilovekb.sh`: krok `prepare-kpi` przed uploadem (miesięczne odświeżenie).
  Pierwsza publikacja ręcznie wg skilla `kb-reimport` (upload → promote → build → purge nagrobków → bramka).

## 5. Testy, akceptacja, dokumentacja

Testy vitest (root, `tools/mssql-introspect/test/`, `tools/kb-import/test/`):
- katalog: każdy plik się parsuje, wymagane pola, unikalne `id`, `area` = katalog, `@param` ↔ `params`,
  `checkReadOnly` OK, dokładnie jeden blok SQL — test iteruje po **prawdziwym** katalogu (nowy szablon łamiący
  zasady zatrzymuje CI);
- `validateParams`: każdy typ (poprawne/niepoprawne), `enum`, brak wymaganego, nieznany klucz, `default`;
- `searchTemplates`: trafienie po pytaniu z diakrytykami i bez, filtr `area`;
- `run_template` na atrapie puli: wartości idą przez `request.input` z właściwym typem, tekst SQL niezmieniony
  (brak interpolacji), log zawiera `templateId` i `params`, błąd walidacji nie otwiera połączenia;
- `prepare-kpi`: render deterministyczny, manifest zachowuje tytuły/`sourceUrl`.

Akceptacja na produkcji (sesja Claude Code ze skillem; wynik wpisany do tej specyfikacji jako „Wynik”):

| # | Pytanie | Oczekiwane zachowanie |
|---|---|---|
| 1 | Przychód netto we wrześniu 2026 vs wrzesień 2025 | szablon (YoY / miesięczny), 2 zakresy, założenia podane |
| 2 | Top 10 marek w ostatnim kwartale i ich marża brutto | szablon top marek (+ marża), zakres kwartału wyliczony z daty |
| 3 | Należności przeterminowane > 60 dni i ich % całości | szablon aging należności |
| 4 | Towary marki X bez sprzedaży > 180 dni i zamrożona wartość | adaptacja dead stock (parametr N dni + marka) |
| 5 | Średnia wartość paragonu i faktury MoM w 2026 | szablon średniej wartości + reguła 03.2026 w założeniach |
| 6 | Dni zapasu dla top 10 marek | połączenie pokrycia zapasu z top marek |
| 7 | E-sklep vs stacjonarnie w 2026 | ad hoc po `dok_KatId` (kanały z §5.6), kontrola krzyżowa z przychodem, propozycja nowego szablonu |
| 8 | Który klient kupuje najwięcej | rangi i kwoty bez nazw; próg k tam, gdzie dotyczy |

Plus: `npm run eval` dla IloveKB po re-imporcie ≥ wynik przed; bramka jakości IloveKB bez `stale`.

Dokumentacja: `docs/data-governance.md` §1.3 (szablony, pola logu `via: template`); `docs/design/PLAN.md`
„Zmiany decyzji” — wpis: decyzja 2026-09-11 bez zmian, serwer mssql zyskuje `list_templates`/`run_template`,
źródło szablonów w repo; `CLAUDE.md` — sekcja Komendy (`prepare-kpi`), wzmianka o skillu.

## Poza zakresem

Dostęp zdalnych agentów do danych ERP (kierunek „3” — wymaga osobnej decyzji w PLAN.md), UI w panelu,
wykresy, workflowy n8n, raporty cykliczne (kierunek „2”).
