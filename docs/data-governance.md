# Governance danych — inwentarz, retencja, procedury

Dokument operacyjny: **gdzie leżą jakie dane, jak długo, i jak je usunąć.**
Powstał, bo system przetwarza dane pracowników (tożsamość z SSO, treść pytań, logi)
oraz treści dokumentów firmy, wysyła fragmenty do dostawcy LLM i trzyma je
w kilku magazynach jednocześnie — a bez tej mapy nie da się ani zrealizować żądania
osoby, ani wykazać rozliczalności.

Powiązane: `docs/runbooks/secret-rotation.md` (sekrety), `docs/deployment.md` §11
(backupy), `docs/runbooks/disaster-recovery.md`, `docs/operator-manual.md` (pętla day-2).

**Zakres:** stan zweryfikowany 2026-09-06 na tym wdrożeniu. Przy zmianach w pipeline,
logowaniu lub eksportach **zaktualizuj ten plik w tym samym commicie** (`CLAUDE.md` odsyła tu wprost).

---

## 1. Inwentarz danych — co gdzie leży

Magazyny: **SQLite panelu** (`/srv/kag-data/kag/panel/db/kag.db`, współdzielony przez
panel-api i mcp-server), **pliki na dysku** (`/srv/kag-data/kag/panel/*`), **OpenSPG**
(MariaDB + Neo4j/DozerDB + MinIO), **Postgres Authentika** (`/srv/kag-data/edge/authentik/postgres`),
**logi kontenerów i Caddy**, **backupy** (`/srv/kag-data/backups/`), **dostawca LLM** (poza EOG).

### 1.1 Dane osób (pracownicy)

| Dane | Gdzie | Skąd | Uwagi |
|---|---|---|---|
| tożsamość: `sub` (UUID z Authentika), e-mail, nazwa wyświetlana, rola | SQLite `users` | OIDC z Authentika | `kind='service'` = konto techniczne, bez `sub`/e-maila |
| sesje: hash sid, **IP, User-Agent**, czasy | SQLite `sessions` | przeglądarka | usuwane przy wylogowaniu, wygaśnięciu (sweep co 15 min) i przy wyłączeniu/anonimizacji konta |
| tokeny OIDC (refresh/id) | SQLite `sessions.tokens_enc` | Authentik | **sealed AES-GCM** kluczem `TOKEN_ENC_KEY` |
| konta, hasła, MFA, grupy | Postgres Authentika | SSO | poza panelem — zarządzane w Authentiku |
| **treść pytań** i podgląd odpowiedzi | SQLite `answers`, `learning_gaps` (`question`, `answer_preview` ≤500 zn.) | `/ask` i `kb_answer` | pytanie bywa danymi osobowymi, jeśli ktoś je w nim zawrze |
| oceny odpowiedzi + komentarz | SQLite `feedback` (`comment`) | 👍/👎 | `answer_id` wiąże z autorem pytania |
| autorstwo operacji | SQLite `drafts.submitted_by_user`/`decided_by`, `intakes.created_by`, `actions` | panel | wskazują `users.id` (pseudonim) |
| **łańcuch audytu** | SQLite `audit` (`actor`, `actor_type`, `role`, `resource`, `before/after`) | każda mutacja | **append-only, triggery blokują UPDATE/DELETE** — patrz §3.4 |
| klucze MCP | SQLite `api_keys` (sha256+prefix, `user_id`) | panel `/mcp` | raw nigdy nie jest przechowywany |
| zużycie LLM | SQLite `llm_usage` (model, tokeny, namespace) | wywołania LLM | **bez treści** |
| użycie MCP | pliki `mcp-usage/<data>.jsonl` | odczyty MCP | metadane (klucz, narzędzie, czas, confidence) — **bez treści pytania** |

### 1.2 Treści (dokumenty firmy i pochodne)

| Dane | Gdzie |
|---|---|
| oryginalne pliki/bloby intake'u | pliki `uploads/` (content-addressed po sha256) |
| tekst po ekstrakcji i czyszczeniu, szkice | SQLite `intakes`, `drafts.content_md` |
| chunki + indeks pełnotekstowy | SQLite `chunks_mirror` + FTS5 |
| eksporty CSV przekazywane builderowi | pliki `exports/` + rejestr `export_runs`/`export_files` |
| kopia CSV w obiektach buildera | MinIO OpenSPG (bucket `builder/upload/...`) |
| encje i właściwości grafu (**w tym pełne treści chunków i wektory**) | Neo4j/DozerDB (projekt per baza) |
| metadane projektów, jobów, harmonogramu | MariaDB OpenSPG |
| logi akcji pipeline'u (mogą zawierać fragmenty treści) | pliki `actions/<rok>/<mies>/<actionId>.log` |
| **metadane katalogu zewnętrznej bazy MSSQL** (SubiektKB, od 2026-09-09): nazwy tabel/kolumn, typy, klucze, indeksy, liczności z `sys.partitions`, sygnatury procedur — **bez danych wierszowych** | pliki robocze `/srv/kag-data/import/<kb>/` (host), potem jak każdy dokument: `drafts`, `chunks_mirror`, Neo4j |

**Źródło zewnętrzne — żywa baza MSSQL (SubiektKB).** Narzędzie `tools/mssql-introspect/`
czyta z hosta VPS (przez WireGuard; kontenery nie mają drogi — `wg_guard.sh`) **wyłącznie katalog
systemowy** (`sys.*`, `INFORMATION_SCHEMA`); zapytania są stałymi w `src/queries.mjs`, a test
`test/queries-readonly.test.mjs` odrzuca każde DML/DDL i każde odwołanie poza `sys`. Liczności
wierszy tabel modułów kadrowo-płacowych są pomijane (`ROWCOUNT_SKIP_PREFIX`). Poświadczenie
żyje w `/etc/kag/mssql-optima.env` (0600 root, poza repo); nazwa użytkownika i hasło nie trafiają
do logów ani do treści dokumentów (`sourceUrl` wskazuje folder dokumentacji producenta).
**Źródła WWW (SubiektKB, 2026-09-09):** e-Pomoc techniczna InsERT (oficjalne FAQ, publiczne) oraz
forum.insert.com.pl (publiczne wątki). Z forum importowana jest treść postów i ROLA autora
(InsERT / użytkownik) — nazwiska i profile są pomijane w `fetch-forum.mjs`; cytaty usuwane. Treść
postów może zawierać dane wpisane przez użytkowników (np. NIP w pytaniu) — obowiązuje polityka PII
bazy (`flag`) na wyjściu do LLM, a usunięcie na żądanie idzie ścieżką §3.1 (dokument = grupa
sekcja × rok, re-import po wykluczeniu wątku).

**Rozszerzenie 2026-09-10 (decyzja właściciela bazy):** oprócz katalogu odczytano WARTOŚCI małych tabel
słownikowych `sl_*` (stawki VAT, typy ewidencji, kody ZUS/akcyzowe, formy płatności — do 150 wierszy)
i ograniczenia CHECK. Bramki w `tools/mssql-introspect/src/queries-data.mjs` + test: blacklista tabel
(użytkownicy, pracownicy, hasła, rejestry publiczne), blacklista kolumn osobowych (nazwisko, PESEL, NIP,
e-mail, telefon, adres, konto, hasło), limit wierszy/kolumn, wyłącznie `SELECT TOP`. Poświadczenie do bazy DEMO (instancja OPTIMA,
`/etc/kag/mssql-optima.env`) zostało usunięte z hosta po zrzucie. **Od 2026-09-11 host ma osobny,
stały dostęp odczytu do bazy PRODUKCYJNEJ Subiekta GT ilovelighting** (`Magnum_Profi` na
`192.168.1.20\\INSERTGT`, LAN za peerem WireGuard `pomagier`) wyłącznie przez serwer MCP dla Claude
Code opisany w §1.3 — ta baza NIE jest źródłem żadnej bazy wiedzy (katalog i słowniki SubiektKB
pochodzą z bazy demo).

Retencja: jak dokumentacja produktowa (§2). Nie uruchamia progu DPIA z §5, dopóki zakres =
metadane i słowniki bez danych osobowych; rozszerzenie o zawartość tabel (nawet słownikowych) wymaga wpisu tutaj i decyzji
właściciela bazy.

**AnalizyERP (od 2026-09-11):** generyczna wiedza analityczna (katalog KPI z formułami, raporty,
dashboardy, model danych BI, checklista jakości danych) z raportów „deep research" udostępnionych
przez właściciela w folderze Google Drive; treść niezależna od producenta ERP, bez danych firmy i bez
danych osobowych. Konwersja `tools/kb-import/prepare-md.mjs` (tabele → rekordy, sekcja samooceny
raportu pomijana). Retencja jak dokumentacja produktowa; brak wyzwalacza DPIA.

**IloveKB (od 2026-09-11, decyzja właściciela delegowana operatorowi):** semantyka PRODUKCYJNEJ
instancji Subiekta GT ilovelighting (baza `Magnum_Profi`) — jedyna baza wiedzy z faktami o tej
instancji. Zakres i bramki (`tools/mssql-introspect/`, testy w `test/`):
- *słowniki* wyłącznie z listy dozwolonych (`dump-dictionaries.mjs --only`, marki `sl_GrupaTw`, cechy,
  grupy kontrahentów, rabaty, magazyny, płatności, VAT, kraje, waluty, jednostki), z blacklistą
  tabel kadrowo-płacowych i kolumn osobowych; NIE „każda tabela `sl_*`";
- *agregaty* ze stałych, bezparametrowych zapytań w `src/queries-aggregates.mjs` (tylko
  COUNT/SUM/AVG/MIN/MAX i GROUP BY po kodach, flagach, id i datach; test odrzuca projekcję nazw,
  adresów, e-maili, NIP), z progiem k=10: liczności osób poniżej 10 tłumione (`dump-aggregates.mjs`);
- *marki → domyślni dostawcy*: jedyne miejsce czytające kolumnę nazwy kontrahenta
  (`dump-suppliers.mjs`), ograniczone do `kh_Osoba = 0` I nazw z formą prawną (sp. z o.o., S.A., GmbH,
  Ltd …); osoby fizyczne i JDG odrzucane w kodzie; lista przechodzi recenzję człowieka w Inboxie;
- *konwencje* i *mapowanie KPI → SQL*: dokumenty redakcyjne; szablony SQL testowane przez
  `run-select.mjs` (ta sama bramka co MCP `mssql`, §1.3 droga 3); reguły wywnioskowane oznaczone
  „DO POTWIERDZENIA".
Adres hosta bazy nie trafia do treści (`sourceUrl` = `https://kag.ilovelighting.sanok.pl/src/magnum-profi#…`).
Żadnych wierszy `kh__Kontrahent`, `dok__Dokument`, `tw__Towar`. Odświeżanie: wyłącznie agregaty
i słowniki (nie katalog schematu). Retencja jak dokumentacja produktowa. Wyzwalacz DPIA §5
(„dane klientów") NIE jest uruchomiony, bo baza nie zawiera danych osób; rozszerzenie zakresu
(nowe tabele/kolumny, wiersze) wymaga wpisu tutaj i decyzji właściciela.

### 1.3 Przepływ do dostawcy LLM (poza EOG)

Do dostawcy OpenAI-compatible wychodzą: **fragmenty treści dokumentów** (czyszczenie,
analiza, embeddingi, budowa kontekstu odpowiedzi) i **treść pytania użytkownika**.
Dwie drogi wyjścia:
1. `panel-api`/`mcp-server` przez `packages/shared/src/llm` (egress przez `edge-net`);
2. `release-openspg-server` przy wektoryzacji w builderze (jedyna usługa w `kag-egress`).

**Warstwa PII na drodze 1 (od 2026-09-07).** `kb_registry.pii_policy` decyduje, co dzieje się
z treścią dokumentu tuż przed wysyłką: `off` (nie skanuj), `flag` (wykrywaj i licz, treść bez
zmian — DOMYŚLNE), `mask` (podmień na placeholdery typu `[PESEL]`). Wykrywane są PESEL, NIP,
REGON, IBAN i numer dowodu — każdy weryfikowany **sumą kontrolną**, nie samą długością — oraz
numer telefonu i data urodzenia, te wyłącznie w kontekście (`tel.`, `ur.`), bo nasze bazy są
pełne dziewięciocyfrowych kodów katalogowych i dat obowiązywania procedur.

Maskowanie działa na **granicy wyjścia** (`wrapUntrusted` w `packages/shared/src/llm`), a nie
przy zapisie: nasz dysk jest wewnątrz perymetru RODO, dostawca nie jest. W bazie wiedzy zostaje
więc treść oryginalna. Przy odpowiedzi łączącej kilka baz obowiązuje polityka **najostrzejsza**
z nich. Droga 2 (wektoryzacja w builderze) tej warstwy NIE ma — OpenSPG wysyła treść sam,
poza naszym kodem; to znane ograniczenie, nie przeoczenie.

Wynik skanu (liczniki i typy, **nigdy wartości**) trafia do metadanych szkicu i jest pokazywany
recenzentowi w Inboxie przed promocją — recenzja człowieka jest jedyną bramką przed wejściem
treści do bazy, więc to właściwe miejsce na tę informację.

Politykę zmienia się przez `PATCH /api/v1/kbs/:namespace` z `{"piiPolicy":"mask"}` (admin);
panel nie ma na to kontrolki, bo pozostałe pola rejestru KB też są ustawiane wyłącznie przez API.

**Droga 3 (od 2026-09-11): serwer MCP `mssql` dla Claude Code na hoście VPS** — decyzja
właściciela (delegowana operatorowi, zapis: PLAN.md „Zmiany decyzji" 2026-09-11).
- *Co:* `tools/mssql-introspect/mcp-server.mjs` (stdio, sterownik tedious) daje sesji Claude Code
  roota na hoście jedno narzędzie `execute_sql` do produkcyjnej bazy Subiekta GT `Magnum_Profi`
  (login `pomagier_test`, rola `db_datareader`; poświadczenie `/etc/kag/mssql-ilovelighting.env`,
  0600, poza repo). Nie widzi go panel Ask ani żaden klucz zdalnego MCP — tylko proces Claude Code
  na hoście.
- *Jakie dane wychodzą:* wyniki zapytań idą do dostawcy modelu Claude Code (Anthropic, poza EOG;
  **inny odbiorca** niż dostawca z dróg 1–2) i zostają w transkryptach sesji
  `/root/.claude/projects/-kag/*.jsonl` na hoście (§2.4).
- *Kontrole (bramka `src/mcp-readonly.mjs`, testy `test/mcp-readonly.test.mjs`):* wyłącznie
  pojedynczy `SELECT`/`WITH`; zakaz DML/DDL/procedur; **deny-lista kolumn osobowych** sprawdzana na
  każdym identyfikatorze (nazwiska, imiona, PESEL, NIP, REGON, e-mail, telefon, adresy, uwagi,
  loginy/hasła, symbole i nazwy kontrahentów, kopie nazw kontrahentów w ewidencjach księgowych);
  zakaz `SELECT *`/`alias.*` na tabelach z danymi osobowymi (`kh__Kontrahent`, `adr__Ewid`,
  `pr_*`, `pd_Uzytkownik`, ewidencje). Dozwolone: agregaty po flagach/id, dane towarów, dokumentów
  (bez uwag), słowników. Treść KAŻDEGO zapytania (przyjęte i odrzucone, bez wyników) trafia do
  `/srv/kag-data/kag/mcp-mssql/queries.jsonl` (0600).
- *Ograniczenie znane:* login ma `db_datareader`, więc gwarancją jest bramka w kodzie, nie
  uprawnienia bazy; docelowo login z prawami tylko do widoków bez PII (decyzja administratora
  Subiekta). Zmiana zakresu (nowe kolumny, tryb inny niż SELECT) wymaga wpisu tutaj.
- *Rejestr §4:* kategoria danych „dane klientów i dostawców w agregatach; dane towarów i
  dokumentów"; podstawa: uzasadniony interes (analityka własnej sprzedaży); odbiorca: dostawca
  modelu Claude Code; retencja: transkrypty sesji (§2.4).

### Zakres widoczności baz wiedzy

**Panel: każdy zalogowany użytkownik przeszukuje wszystkie aktywne bazy** — nie ma ograniczenia
per użytkownik ani per grupa; jedyną kontrolą jest RBAC roli na trasie. **MCP: przeciwnie** —
każdy klucz ma profil ograniczający widoczne namespace'y, egzekwowany na wynikach retrievalu.
Ta różnica jest świadoma (`docs/design/PLAN.md`, sekcja „Zmiany decyzji", 2026-09-07), a nie
przeoczeniem. Warunek ponownego otwarcia decyzji: pierwsza baza z danymi kadrowymi.

**Klucz API dostawcy istnieje w DWÓCH kopiach**: sealowanej w SQLite `settings`
oraz **jawnym tekstem** w MariaDB `openspg.kg_user_model.config` (jasypt w tym buildzie
nic nie szyfruje — zweryfikowane 2026-09-06). Konsekwencja dla governance: **każdy dump
MySQL i każdy snapshot backupu to materiał sekretny**. Rotacja: `secret-rotation.md` §5.

---

## 2. Retencja — wartości i zakres

### 2.1 Pliki aplikacji (worker retencji, klucz `retention` w Ustawieniach)

Domyślne okresy z `apps/panel-api/src/services/retention.ts` (`RETENTION_DEFAULTS`),
nadpisywalne kluczem `retention` w `/settings` (bez restartu); każde usunięcie jest audytowane:

| Klucz | Domyślnie | Co usuwa |
|---|---|---|
| `actionLogsDays` | **90 dni** | pliki logów akcji (`actions/`); wiersze `actions` ZOSTAJĄ |
| `mcpUsageDays` | **180 dni** | dzienniki `mcp-usage/*.jsonl` |
| `exportsDays` | **30 dni** | katalogi eksportów CSV (`exports/`); manifesty w DB ZOSTAJĄ |
| `failedIntakesDays` | **30 dni** | bloby intake'ów ze statusem `failed`; wiersz `intakes` ZOSTAJE |

### 2.2 Backupy (`deploy/scripts/backup.sh`)

- snapshot nocny: **14 dni** (`RETENTION_DAYS=14`);
- pierwszy KOMPLETNY snapshot miesiąca: **~186 dni** (`MONTHLY_KEEP_DAYS=186`);
- zimny snapshot Neo4j: miesięcznie (`kag-backup-cold.timer`).

**Skutek dla usuwania danych:** dane usunięte dziś nadal żyją w snapshotach do ~6 miesięcy.
To jest akceptowany kompromis (odtwarzalność vs. minimalizacja) — ale trzeba go **znać
i komunikować** przy realizacji żądania osoby (§3.3).

### 2.3 Logi

- kontenery Docker: `json-file`, **3 pliki × 10 MB** per kontener (rotacja wielkością, nie czasem);
- Caddy: `access-{kag,auth,status}.log`, **roll_keep 5 × 20 MB**;
- systemd/journal: polityka hosta (`journalctl --vacuum-time=7d` w razie potrzeby).

### 2.4 Bez retencji (świadomie)

- **`audit`** — bezterminowo, append-only (triggery blokują UPDATE/DELETE). Wpisy są
  redagowane przy zapisie (klucze pasujące do `pass|secret|token|api_key|authorization|cookie|refresh`
  → `[REDACTED]`), a `actor` to `users.id`/`api_keys.id` — **pseudonim, nie e-mail**.
  Dlatego anonimizacja konta (§3.2) nie wymaga i **nie może** naruszać łańcucha.
- `answers`, `learning_gaps`, `feedback` — trzymane do czasu ręcznej decyzji operatora
  (luki: Rozwiąż/Ignoruj). **Do rozstrzygnięcia:** czy wprowadzić automatyczny okres.
- `chunks_mirror`, graf w Neo4j, obiekty w MinIO — żyją tak długo, jak treść w bazie wiedzy.
- **Transkrypty sesji Claude Code** (`/root/.claude/projects/-kag/*.jsonl`, host) — poza aplikacją,
  bez retencji; od 2026-09-11 mogą zawierać wyniki zapytań do bazy produkcyjnej (§1.3, droga 3) —
  agregaty i dane towarowo-dokumentowe, bez kolumn osobowych. **Do rozstrzygnięcia:** okres i
  mechanizm czyszczenia (operator ręcznie albo `find -mtime`).

---

## 3. Procedury

### 3.1 Usunięcie dokumentu z bazy wiedzy

Kolejność ma znaczenie — treść żyje w **czterech** miejscach naraz.

1. **Panel → Inbox**: jeżeli treść czeka jako szkic — `Odrzuć` (a po decyzji `Usuń`, admin,
   tylko status `rejected`). Jeżeli była już zatwierdzona — `Wycofaj` (cofa promocję;
   baza dostaje `dirty=1`).
2. **Panel → Bazy wiedzy → Buduj**: build po wycofaniu przebudowuje eksport i mirror —
   dopiero to usuwa treść z `chunks_mirror`/FTS5 i przestaje ją podawać w wyszukiwaniu.
3. **Graf OpenSPG**: builder działa w trybie `UPSERT` — **nie kasuje** encji usuniętych
   ze źródła, a wiersza-nagrobka NIE stosuje (potwierdzone na produkcji 2026-09-06: job
   kończy się sukcesem, węzeł zachowuje treść). Retrieval odsiewa takie id po
   `graph_ids.live = 0`, więc po kroku 2 treść jest **niedostępna** — ale nadal
   **istnieje** w Neo4j. Fizyczne usunięcie:
   `sudo deploy/scripts/purge_graph_nodes.sh --namespace <NS> --apply`
   (lista wyłącznie z rejestru, więc nie da się skasować treści żywej; operacja
   audytowana jako `graph.purge_nodes`). Pełna procedura i weryfikacja:
   `docs/runbooks/purge-document.md`. `reason/run` jest ZAKAZANE jako proxy —
   patrz `backend-mcp.md` Aneks.
4. **MinIO**: CSV przekazane builderowi zostaje w buckecie `builder/upload/…` — usuń obiekt,
   jeśli dokument był wrażliwy.
5. **Pliki**: blob źródłowy w `uploads/` (content-addressed) i katalog eksportu w `exports/`
   — eksporty sprząta retencja (30 dni), blob usuń ręcznie, jeśli nie ma czekać.
6. **Backupy**: kopie pozostaną do ~186 dni (§2.2) — odnotuj to w decyzji.

Każdy krok 1-2 jest audytowany automatycznie; kroki 3-5 **odnotuj ręcznie** (np. w notatce
operacyjnej), bo są wykonywane poza panelem.

### 3.2 Offboarding użytkownika / żądanie usunięcia danych (art. 17)

1. **Authentik**: usuń lub dezaktywuj konto i odbierz grupy `kag-*` (od tej chwili osoba
   nie zaloguje się do panelu).
2. **Panel → Ustawienia → Użytkownicy → Wyłącz** (`PATCH /api/v1/users/:id` ze
   `status:"disabled"`) — kaskadowo unieważnia klucze MCP tej osoby.
3. **Anonimizacja** (`POST /api/v1/users/:id/anonymize`, admin; wymaga wcześniejszego
   wyłączenia — na aktywnym koncie zwraca 409). Nieodwracalnie:
   e-mail → NULL, nazwa → placeholder, `sub` → `anon:<sha256>` (ponowne logowanie tej
   samej osoby utworzy NOWE konto), sesje usunięte, klucze unieważnione,
   `answers.user_id` odpięte. **`users.id` zostaje** jako pseudonim trzymający klucze
   obce audytu, `drafts.submitted_by_user`/`decided_by` i `intakes.created_by` —
   to celowe: łańcuch audytu jest append-only i musi pozostać spójny.
4. **Treść pytań**: `answers.question` i `learning_gaps.question` nie znikają przy
   anonimizacji (są odpięte od osoby, ale zachowują treść). Jeśli żądanie obejmuje
   treść pytań — usuń wskazane wiersze `answers`/`feedback`/`learning_gaps` ręcznie
   i **odnotuj to** (operacja poza panelem).
5. **Backupy**: poinformuj, że kopie zapasowe zawierają dane do ~186 dni i nie są
   modyfikowane wstecz (§2.2).

### 3.3 Żądanie dostępu (art. 15) i sprostowania (art. 16)

- **Dostęp**: dane osoby to wiersz `users`, jej `sessions`, `answers`/`feedback`/`learning_gaps`
  powiązane `user_id`/`answer_id`, `api_keys` (bez sekretów), wpisy `audit` z `actor = users.id`,
  autorstwo w `drafts`/`intakes`/`actions`. Zestawienie przygotuj zapytaniami do
  `/srv/kag-data/kag/panel/db/kag.db` (**przez kontener**: `docker exec kag-panel node -e …`
  z `better-sqlite3` — `sqlite3` nie jest zainstalowany na hoście; patrz `deployment.md` §0).
  Panel udostępnia też `GET /api/v1/audit` (admin) z filtrem po aktorze.
- **Sprostowanie**: tożsamość (e-mail, nazwa) pochodzi z Authentika — popraw **tam**;
  panel zaktualizuje wiersz `users` przy kolejnym logowaniu/odświeżeniu tokenu.
  Treść dokumentów prostuje się przez edycję szkicu w Inboxie + build (§3.1 krok 2).
- **Czego NIE prostujemy**: wpisów `audit` — łańcuch jest append-only z założenia
  (rozliczalność); korektę odnotowuje się nowym zdarzeniem, nie zmianą starego.

### 3.4 Co zrobić, gdy sekret lub dane wyciekły

Patrz `docs/runbooks/secret-rotation.md` §10 („Kompromitacja sekretu — gdzie jeszcze leży
stara wartość"): snapshoty do 186 dni, access log Caddy, `docker logs`, historia powłoki,
oraz jawny klucz LLM w `kg_user_model`.

---

## 4. Wpis do rejestru czynności przetwarzania (art. 30) — szkielet dla operatora

Do uzupełnienia i zatwierdzenia przez administratora danych (to **nie** jest gotowy wpis):

| Pole | Treść startowa |
|---|---|
| Cel przetwarzania | wewnętrzna baza wiedzy firmy: wyszukiwanie i odpowiadanie na pytania pracowników na podstawie dokumentów firmowych |
| Kategorie osób | pracownicy/współpracownicy korzystający z panelu i agentów MCP; osoby wymienione w treści dokumentów firmowych |
| Kategorie danych | identyfikator SSO, e-mail służbowy, nazwa wyświetlana, rola; adres IP i User-Agent sesji; treść zadanych pytań i ocen; treści dokumentów firmowych |
| Odbiorcy | dostawca LLM (API OpenAI-compatible, **poza EOG** — fragmenty treści i pytania); hostingodawca VPS |
| Transfery poza EOG | tak — dostawca LLM; podstawa i zabezpieczenia do uzupełnienia przez administratora |
| Terminy usunięcia | §2 tego dokumentu (logi akcji 90 dni, usage MCP 180 dni, eksporty 30 dni, backupy 14/186 dni; audyt bezterminowo — pseudonimizowany) |
| Środki techniczne | SSO z MFA dla adminów, RBAC deny-by-default, sesje HttpOnly/Secure/host-only, sekrety sealed AES-GCM, audyt hash-chain append-only, sieci `internal:true` bez portów na hoście, backup z weryfikacją |

## 5. Wyzwalacze DPIA (kiedy wrócić do oceny skutków)

Wykonaj/odśwież ocenę skutków, jeżeli:
- do baz wiedzy trafią **dane osobowe jako materiał źródłowy** (akta pracownicze, CV,
  dokumentacja medyczna, dane klientów) — dziś zakładamy dokumentację techniczno-produktową;
- pojawi się **profilowanie lub ocena osób** na podstawie treści/pytań;
- dojdzie **automatyczne pobieranie treści z sieci bez recenzji** (auto-drafty za flagą — roadmapa);
- zmieni się dostawca LLM albo lokalizacja przetwarzania;
- wprowadzimy **monitoring aktywności pracowników** na podstawie logów pytań;
- backup off-site zostanie włączony do lokalizacji poza EOG.
