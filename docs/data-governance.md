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

### 1.3 Przepływ do dostawcy LLM (poza EOG)

Do dostawcy OpenAI-compatible wychodzą: **fragmenty treści dokumentów** (czyszczenie,
analiza, embeddingi, budowa kontekstu odpowiedzi) i **treść pytania użytkownika**.
Dwie drogi wyjścia:
1. `panel-api`/`mcp-server` przez `packages/shared/src/llm` (egress przez `edge-net`);
2. `release-openspg-server` przy wektoryzacji w builderze (jedyna usługa w `kag-egress`).

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
