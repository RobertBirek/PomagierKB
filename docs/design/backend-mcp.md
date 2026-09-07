# PODSYSTEM 2: BACKEND PANELU (panel-api) + SERWER MCP (mcp-server)

## 0. Architektura ogólna

Dwa **osobne procesy Node 22 (ESM, TypeScript kompilowany tsc → dist/)** w monorepo npm workspaces, współdzielące pakiet `packages/shared`:

```
Caddy (edge) ──► panel-api :8080   (Fastify; UI panelu + REST /api/v1 + /auth)
           ──► mcp-server :8090   (Fastify shell + @modelcontextprotocol/sdk; /mcp/<profil>)
                     │  │
   współdzielony wolumen: /data/kag.db (SQLite WAL, better-sqlite3)
                          /data/{actions,uploads,exports,reports,mcp-usage}/ (pliki)
                     │
             OpenSPG server :8887 (tylko sieć wewnętrzna kag) + Stirling + LLM API
```

Decyzje przekrojowe:
- **Jedna baza SQLite** (`/data/kag.db`) montowana do obu kontenerów z tego samego lokalnego wolumenu (WAL wymaga wspólnego, lokalnego FS — nie NFS). `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`.
- **Migracje uruchamia wyłącznie panel-api** przy starcie (`BEGIN EXCLUSIVE`); mcp-server przy starcie sprawdza `MAX(id)` w `schema_migrations` i **odmawia startu** przy niezgodności (widoczne w healthchecku).
- Wszystkie odpowiedzi `/api/v1` w kopercie: sukces `{"ok":true,"data":...,"meta":{...}}`, błąd `{"ok":false,"error":{"code":"...","message":"...","details":...,"requestId":"..."}}`. Wyjątki: SSE, download logów/eksportów.
- Pino logger z `redact: ['req.headers.authorization','req.headers.cookie','*.apiKey','*.password','*.secret','*.token']` w obu procesach.
- OpenSPG :8887 nie ma auth (fakt z briefu) — jedynymi klientami są panel-api i mcp-server przez sieć wewnętrzną; port nigdy nie publikowany.

---

## 1. panel-api — struktura modułów

```
apps/panel-api/src/
  app.ts                 # buildApp(): rejestracja pluginów i routes (testowalne bez listen)
  server.ts              # bootstrap: env, migracje, sweep osieroconych akcji, listen
  plugins/
    config.ts            # @fastify/env: walidacja ENV (JSON Schema), warianty *_FILE
    db.ts                # dekorator app.db (better-sqlite3), pragmy, graceful close
    session.ts           # cookie kag_sid + store w SQLite; dekorator req.session/req.user
    oidc.ts              # openid-client v6: discovery Authentika, /auth/* routes
    rbac.ts              # dekorator app.requireRole('viewer'|'operator'|'admin')
    csrf.ts              # weryfikacja Origin/Sec-Fetch-Site na mutacjach (patrz §3.4)
    rate-limit.ts        # @fastify/rate-limit, trustProxy, polityki per grupa tras
    audit.ts             # dekorator app.audit(...) + hook onResponse dla mutacji
    error-handler.ts     # AppError→koperta, mapowanie walidacji, 404/405, requestId
    sse.ts               # helper reply.sse() (nagłówki, heartbeat, cleanup on close)
  routes/                # tylko deklaracje tras + JSON Schema; zero logiki biznesowej
    auth.ts  me.ts  status.ts  kbs.ts  drafts.ts  actions.ts  audit.ts
    learning.ts  mcp-admin.ts  settings.ts  users.ts
  services/              # logika biznesowa; przyjmują db/config przez konstruktor
    kb-registry.ts  drafts.ts  actions-runner.ts  preflight.ts  status.ts
    learning.ts  mcp-keys.ts  mcp-profiles.ts  settings.ts  users.ts
  jobs/                  # entrypointy procesów potomnych akcji (patrz §5)
    run-job.ts           # dispatcher: node dist/jobs/run-job.js --type build_kb --action <id>
    build-kb.ts  analyze-draft.ts  create-kb.ts  export-drafts.ts
packages/shared/src/
  db/{open.ts,migrate.ts,migrations/00XX_*.sql}
  audit/append.ts        # hash-chain append (BEGIN IMMEDIATE), redakcja, verify
  openspg/{client.ts,search.ts,builder.ts,login.ts}   # klient REST OpenSPG + normalizacja
  llm/{openai-client.ts} # chat_llm/openie_llm/embeddings (OpenAI-compatible, timeouty)
  schemas/               # JSON Schema z $id współdzielone (koperta, draft, kb, key...)
  crypto/{keys.ts,seal.ts}  # sk-... generacja/hash; AES-256-GCM seal/unseal sekretów
  errors.ts              # AppError(code, statusCode, message, details)
```

Zasady: route = schema + wywołanie serwisu; serwis = czysta logika na db; pluginy przez `fastify-plugin`. Każda trasa deklaruje `config: { rbac: 'operator', audit: 'draft.promote' | false, csrf: true }` — hooki czytają config zamiast dublować logikę.

---

## 2. Kontrakt REST API v1

### 2.1 Konwencje
- Prefiks `/api/v1`. Paginacja: `?page=1&limit=50` (limit≤200), w `meta: {page, limit, total}`. Filtrowanie przez query params walidowane schematem (`additionalProperties: false` wszędzie).
- Walidacja: JSON Schema Fastify (body/query/params/headers); błąd → 400 `validation_error` z `details: [{path, message}]`. Serializacja odpowiedzi przez response schema na gorących trasach (status, drafts list).
- **405**: plugin error-handler w hooku `onRoute` buduje mapę `ścieżka → Set<metoda>`; `setNotFoundHandler` dopasowuje URL do znanych wzorców (find-my-way lookup per metoda) — jeśli ścieżka istnieje pod inną metodą → `405 method_not_allowed` + nagłówek `Allow`; inaczej 404.
- Kody błędów (`error.code`): `validation_error` 400, `unauthorized` 401, `forbidden` 403, `csrf_rejected` 403, `not_found` 404, `method_not_allowed` 405, `conflict` 409, `action_already_running` 409 (details: `{actionId}`), `payload_too_large` 413, `unsupported_media_type` 415, `preflight_failed` 422 (details: `{checks: [...]}`), `rate_limited` 429 (+`Retry-After`), `internal` 500, `upstream_error` 502 (details: `{service, endpoint, status}`), `not_ready` 503, `upstream_timeout` 504.

### 2.2 Pełna tabela tras

> **Źródło prawdy = deklaracje w `apps/panel-api/src/routes/*.ts`.** Tabela odtworzona
> z kodu 2026-09-06: **64 trasy** w modułach + `GET /openapi.json` z pluginu swagger.
> Kolumny `Rola`/`CSRF`/`Audyt` to dosłowna zawartość `config: { rbac, csrf, audit }`.
> Trasy mutujące należą do grupy limitu `mutation` (60 req/min/sesja), `/auth/*` — do `auth`.
> Przy edycji tras **zaktualizuj tę tabelę w tym samym commicie**; regenerację można
> odtworzyć jednolinijkowcem czytającym deklaracje `app.<metoda>('<ścieżka>', { config: … })`.

**Poza `/api/v1`** (bez prefiksu):
| Metoda | Ścieżka | Rola | Audyt | Odpowiedź |
|---|---|---|---|---|
| GET | `/auth/login?returnTo=` | publiczna | — | 302 → Authentik (PKCE+state+nonce w cookie transakcyjnym) |
| GET | `/auth/callback` | publiczna | `auth.login` | 302 → returnTo (403 gdy brak grupy kag-*) |
| POST | `/auth/logout` | viewer | `auth.logout` | 200 `{ok:true,data:{logoutUrl}}`; CSRF |
| GET | `/healthz` | publiczna (healthcheck Dockera) | — | 200 `{ok:true,data:{status}}` bez dotykania upstreamów |
| GET | `/openapi.json` | **admin** | — | surowy dokument OpenAPI 3.0.3 (bez koperty) |

**Rdzeń — prefiks `/api/v1`** (Rola = minimalna; CSRF ✓ = weryfikacja Origin/Sec-Fetch-Site):

*Tożsamość i stan*
| Metoda | Ścieżka | Rola | CSRF | Audyt | Uwagi |
|---|---|---|---|---|---|
| GET | `/me` | viewer | — | — | `{user:{id,email,displayName,role},session:{expiresAt}}` |
| GET | `/status` | viewer | — | — | health cockpit; cache 10 s, zero spawnSync |
| POST | `/status/breakers/:name/reset` | **admin** | ✓ | `breaker.reset` | ręczne zamknięcie breakera (LLM/OpenSPG/Stirling) — obejście auto-recovery |

*Bazy wiedzy*
| Metoda | Ścieżka | Rola | CSRF | Audyt | Uwagi |
|---|---|---|---|---|---|
| GET | `/kbs` | viewer | — | — | rejestr z `kb_registry` + totals (cache) |
| POST | `/kbs` | admin | ✓ | `kb.create` | z `createProject:true` → 202 akcja `create_kb`; 409 gdy namespace zajęty |
| GET | `/kbs/:namespace` | viewer | — | — | 404 |
| PATCH | `/kbs/:namespace` | admin | ✓ | `kb.update` | tylko name/description/status/config |
| POST | `/kbs/:namespace/preflight` | operator | ✓ | — | 200 `{ok,checks:[…]}` (dry-run buildu) |
| POST | `/kbs/:namespace/build` | operator | ✓ | `kb.build` | 202 `{actionId}`; 409 `action_already_running`; 422 `preflight_failed` |
| GET | `/kbs/:namespace/jobs` | viewer | — | — | proxy `builder/job/list` (**start=1**), normalizacja statusów |
| GET | `/kbs/:namespace/quality` | viewer | — | — | ostatni raport quality gate bazy |
| POST | `/kbs/:namespace/quality` | operator | ✓ | `kb.quality_gate` | przeliczenie quality gate (verdict OK/WARN/FAIL) |
| POST | `/kbs/:namespace/schema-sync` | **admin** | ✓ | `kb.schema_sync` | addytywna synchronizacja schematu DSL ze strażnikiem diffów |

*Intake treści (`/content` — JEDYNA droga dodania treści przez API)*
| Metoda | Ścieżka | Rola | CSRF | Audyt | Uwagi |
|---|---|---|---|---|---|
| POST | `/content` | operator | ✓ | `content.submit` | multipart (`file`, ≤50 MB) **albo** JSON `{text,title?,sourceUrl?}` **albo** `{url}` (fetch przez safe_http); 202 `{intakeId}`, 200 przy dedupie/`Idempotency-Key` |
| GET | `/content` | viewer | — | — | lista intake'ów (status, provider ekstrakcji, błędy) |
| GET | `/content/:intakeId` | viewer | — | — | szczegóły etapów pipeline'u |
| POST | `/content/:intakeId/retry` | operator | ✓ | `content.retry` | ponowienie nieudanego intake'u (max 3 próby) |

*Inbox (drafty)*
| Metoda | Ścieżka | Rola | CSRF | Audyt | Uwagi |
|---|---|---|---|---|---|
| GET | `/drafts?status&namespace&q&page&limit` | viewer | — | — | |
| GET | `/drafts/:id` | viewer | — | — | pełna treść + analysis |
| PATCH | `/drafts/:id` | operator | ✓ | `draft.update` | edycja treści/tytułu/namespace draftu `pending` |
| POST | `/drafts/:id/promote` | operator | ✓ | `draft.promote` | 200; 409 przy złym statusie |
| POST | `/drafts/:id/reject` | operator | ✓ | `draft.reject` | body `{reason?}` |
| POST | `/drafts/:id/withdraw` | operator | ✓ | `draft.withdraw` | odwraca promote przed buildem |
| POST | `/drafts/bulk` | operator | ✓ | `draft.bulk` | `{op,ids,dryRun}`; dryRun → raport per id |
| DELETE | `/drafts/:id` | admin | ✓ | `draft.delete` | tylko status rejected; 409 inaczej |

*Zapytaj (`/ask`)*
| Metoda | Ścieżka | Rola | CSRF | Audyt | Uwagi |
|---|---|---|---|---|---|
| POST | `/ask` | viewer | ✓ | — | pytanie do bazy (ta sama logika co `kb_answer`); strumień SSE |
| POST | `/ask/:answerId/feedback` | viewer | ✓ | `answer.feedback` | 👍/👎 — 👎 tworzy lukę wiedzy |
| GET | `/ask/history` | viewer | — | — | historia pytań użytkownika |
| DELETE | `/ask/history` | viewer | ✓ | `answer.purge_history` | użytkownik kasuje SWOJĄ historię (`answers` + `feedback`); luki wiedzy zostają |

*Akcje i audyt*
| Metoda | Ścieżka | Rola | CSRF | Audyt | Uwagi |
|---|---|---|---|---|---|
| GET | `/actions?status&type&page` | viewer | — | — | |
| GET | `/actions/:id` | viewer | — | — | `{...action, logTail:[…200 linii]}` |
| GET | `/actions/:id/events` | viewer | — | — | **SSE** (patrz §5) |
| GET | `/actions/:id/log` | viewer | — | — | `text/plain` pełny log |
| POST | `/actions/:id/cancel` | operator | ✓ | `action.cancel` | 202; 409 gdy nie running |
| GET | `/audit?from&to&action&actor&outcome&page` | admin | — | — | |
| GET | `/audit/verify?limit=5000` | admin | — | — | `{valid,checked,firstBrokenSeq?}` |

*Luki wiedzy i jakość*
| Metoda | Ścieżka | Rola | CSRF | Audyt | Uwagi |
|---|---|---|---|---|---|
| GET | `/learning/gaps?status&page` | viewer | — | — | |
| POST | `/learning/gaps/:id/ignore` | operator | ✓ | `gap.ignore` | |
| POST | `/learning/gaps/:id/resolve` | operator | ✓ | `gap.resolve` | |
| POST | `/learning/gaps/:id/reopen` | operator | ✓ | `gap.reopen` | cofnięcie ignore/resolve |
| POST | `/learning/gaps/:id/start-draft` | operator | ✓ | `gap.start_draft` | status→in_draft + prefill dla `/add` (**nie** `…/draft`) |
| GET | `/learning/stats` | viewer | — | — | liczniki luk per status |
| GET | `/learning/quality` | viewer | — | — | raport „Jakość odpowiedzi — tydzień" |
| POST | `/learning/quality-report` | operator | ✓ | `learning.quality_report` | przeliczenie raportu jakości (akcja `quality_answers`) |

*MCP (administracja z panelu)*
| Metoda | Ścieżka | Rola | CSRF | Audyt | Uwagi |
|---|---|---|---|---|---|
| GET | `/mcp/profiles` | viewer | — | — | |
| POST | `/mcp/profiles` | admin | ✓ | `mcp.profile.create` | walidacja: tools ⊆ znane, namespaces ⊆ rejestr |
| PATCH | `/mcp/profiles/:id` | admin | ✓ | `mcp.profile.update` | |
| DELETE | `/mcp/profiles/:id` | admin | ✓ | `mcp.profile.delete` | 409 gdy istnieją aktywne klucze profilu |
| GET | `/mcp/keys` | viewer (własne) / admin (wszystkie) | — | — | nigdy raw — `{id,prefix,scopes,profileId,status,expiresAt,lastUsedAt}` |
| POST | `/mcp/keys` | operator | ✓ | `mcp.key.create` | 201 `{key:{…},raw:"sk-…"}` — **raw jeden raz**; limit 5 aktywnych/user; `ttlDays` (default 90, max 365); scope `write` tylko admin |
| POST | `/mcp/keys/:id/rotate` | viewer (właściciel) / admin | ✓ | `mcp.key.rotate` | nowy raw raz; stary hash unieważniony natychmiast |
| POST | `/mcp/keys/:id/revoke` | viewer (właściciel) / admin | ✓ | `mcp.key.revoke` | |
| GET | `/mcp/snippets?profileId` | viewer | — | — | snippety claude-code / cursor / generic JSON |
| GET | `/mcp/health` | viewer | — | — | ping `mcp-server:/healthz` |

*Ustawienia i użytkownicy*
| Metoda | Ścieżka | Rola | CSRF | Audyt | Uwagi |
|---|---|---|---|---|---|
| GET | `/settings` | admin | — | — | sekrety maskowane: `{configured:true,preview:"sk-…4f2a"}` |
| PUT | `/settings/:key` | admin | ✓ | `settings.update` | klucz z białej listy; wartości sekretne sealowane AES-GCM |
| POST | `/settings/test-llm` | admin | ✓ | `settings.test_llm` | `{target:'chat'`\|`'openie'`\|`'embeddings'}`; 502/504 przy błędzie |
| GET | `/backup/state` | admin | — | — | stan publikowany przez host (`backup_state.sh`) + werdykty + konfiguracja; brak pliku = `state:null`, nie błąd |
| PUT | `/backup/config` | admin | ✓ | `backup.config.update` | WYŁĄCZNIE parametry niesekretne (retencja, off-site on/off, cold Neo4j); zapis eksportuje plik dla skryptów hosta |
| POST | `/backup/run` | admin | ✓ | `backup.run.request` | `{kind:'backup'`\|`'verify'}` → plik-znacznik odbierany przez `kag-backup-request.path`; 409 gdy poprzedni nieobsłużony |
| GET | `/users` | admin | — | — | użytkownicy OIDC + serwisowi |
| POST | `/users` | admin | ✓ | `user.create` | tylko `kind:'service'` (tożsamości dla kluczy MCP) |
| PATCH | `/users/:id` | admin | ✓ | `user.update` | enable/disable; disable kaskadowo dezaktywuje klucze |
| POST | `/users/:id/anonymize` | admin | ✓ | `user.anonymize` | **nieodwracalne** wyczyszczenie danych osobowych (e-mail→NULL, `sub`→`anon:<sha256>`, sesje i klucze usunięte, `answers.user_id` odpięte); wymaga `status='disabled'` (409 inaczej). Procedura: `docs/data-governance.md` §3.2 |

**Trasy, których NIE MA** (występowały w starszych wersjach tego dokumentu — nie implementuj
klientów pod nie): `POST /drafts` (intake to `POST /content`), `POST /drafts/:id/analyze`
(analyze jest etapem workera intake, nie endpointem), `POST /learning/gaps/:id/draft`
(faktycznie `…/start-draft`), `/auth/error` (błąd callbacku wraca kodem, nie osobną trasą).

---

## 3. Auth: OIDC z Authentikiem

### 3.1 Przepływ (Authorization Code + PKCE, openid-client v6)
1. Konfiguracja przez **discovery**: `https://auth.ilovelighting.sanok.pl/application/o/kag-panel/.well-known/openid-configuration`. Klient confidential (`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET`), scopes: `openid email profile offline_access` (grupy Authentik dostarcza w claimie `groups` przez domyślny mapping scope `profile`; `offline_access` dla refresh tokenu).
2. `GET /auth/login`: generuje `state`, `nonce`, `code_verifier`; zapisuje je + `returnTo` (walidowany: tylko ścieżka względna) w cookie `kag_txn` (AES-GCM sealed, HttpOnly, Secure, SameSite=Lax, Max-Age=600); 302 na authorization_endpoint.
3. `GET /auth/callback`: wymiana kodu (PKCE), weryfikacja state/nonce przez openid-client; odczyt claims `sub,email,name,groups`; **mapowanie ról**: `kag-admin`→admin, `kag-operator`→operator, `kag-viewer`→viewer (precedencja admin>operator>viewer); brak dopasowanej grupy → 403, sesja nie powstaje. Upsert do `users` (po `sub`), utworzenie wiersza `sessions`, cookie `kag_sid`.
4. Cookie sesyjne: `kag_sid=<256-bit base64url>` — **HttpOnly, Secure, SameSite=Lax, Path=/, host-only** (bez atrybutu Domain). Wartość to losowy identyfikator; w DB trzymamy `sha256(sid)` (kradzież pliku DB nie daje przejęcia sesji).
5. TTL: absolutny 12 h, idle 60 min (sliding — `idle_expires_at` odświeżany przy żądaniu, zapis do DB co ≥60 s, nie przy każdym request).
6. **Refresh**: refresh_token + id_token przechowywane w `sessions.tokens_enc` (AES-256-GCM kluczem `TOKEN_ENC_KEY` z env). Gdy access token wygasł, a sesja żyje — leniwy refresh w preHandlerze (mutex per sesja); przy refreshu ponowne odczytanie `groups` → aktualizacja roli (odebranie grupy w Authentiku skutkuje degradacją roli najpóźniej po wygaśnięciu access tokenu). Niepowodzenie refreshu → sesja usunięta → 401.
7. **Logout**: `POST /auth/logout` usuwa wiersz sesji, czyści cookie, zwraca `logoutUrl` = end_session_endpoint z `id_token_hint` i `post_logout_redirect_uri=https://kag.ilovelighting.sanok.pl/`.
8. Sweep wygasłych sesji co 15 min (setInterval w panel-api, zwykły DELETE).

### 3.2 RBAC
Plugin `rbac.ts`: preHandler czyta `route.config.rbac`; brak sesji → 401; rola poniżej wymaganej → 403 `forbidden`. Hierarchia admin ⊃ operator ⊃ viewer. **Żadnego ALLOW_ANON** (lekcja z optimaKB) — jedyne trasy bez auth to `/healthz` i `/auth/login|callback`.

### 3.3 CSRF — decyzja: **bez tokenów; weryfikacja Origin + Sec-Fetch-Site**
Uzasadnienie: SameSite=Lax blokuje wysyłkę cookie przy cross-site POST/PUT/DELETE, więc klasyczny CSRF na mutacjach jest już zablokowany. Pozostałe ryzyka: (a) **same-site to cała strefa `*.ilovelighting.sanok.pl`** — skompromitowana inna aplikacja na subdomenie (w tym przyszłe za tym samym Caddy) mogłaby forsować żądania mimo Lax; (b) stare/nietypowe klienty. Dlatego defense-in-depth **stateless**: plugin `csrf.ts` dla metod mutujących wymaga, by `Origin` (jeśli obecny) był dokładnie `https://kag.ilovelighting.sanok.pl`, a `Sec-Fetch-Site` (jeśli obecny) ∈ {`same-origin`, `none`}; naruszenie → 403 `csrf_rejected`. Zero stanu per proces — eliminuje bug optimaKB „CSRF per proces, restart = 403". Tokenów synchronizacyjnych nie wprowadzamy (SPA + fetch same-origin; brak formularzy cross-origin).

### 3.4 Rate limiting z zaufanym X-Forwarded-For
Fastify `trustProxy: 1` — panel-api nasłuchuje wyłącznie na sieci wewnętrznej Dockera (port niepublikowany), jedynym możliwym klientem jest Caddy, więc ufamy dokładnie jednemu hopowi XFF; `request.ip` = realny adres klienta. @fastify/rate-limit ze store w pamięci (jeden proces — wystarczy; sprzątanie wbudowane, bez wiecznych RATE_BUCKETS): globalnie 300 req/min/IP; grupa `auth` (`/auth/login`, `/auth/callback`, `/auth/logout`) 10 req/min/IP **liczone PER TRASA, nie łącznie dla `/auth/*`** (każda trasa ma własny licznik — potwierdzone nagłówkami `RateLimit-Remaining` w audycie); grupa `mutation` 60 req/min/sesja (keyGenerator: hash sid). 429 → koperta + `Retry-After`.

---

## 4. Schemat SQLite (better-sqlite3) i podział DB/pliki

### 4.1 DDL (migracja 0001_init.sql — najważniejsze kolumny i indeksy)
```sql
CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);

CREATE TABLE users (
  id TEXT PRIMARY KEY,                -- uuid v7
  sub TEXT UNIQUE,                    -- OIDC sub; NULL dla kind='service'
  email TEXT, display_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('oidc','service')),
  role TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')),  -- dla oidc: cache z grup
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,           -- sha256(sid)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                 -- snapshot roli na moment logowania/refreshu
  tokens_enc BLOB,                    -- AES-256-GCM({refresh_token,id_token,access_token,expires_at})
  ip TEXT, user_agent TEXT,
  created_at TEXT NOT NULL, absolute_expires_at TEXT NOT NULL, idle_expires_at TEXT NOT NULL
);
CREATE INDEX ix_sessions_user ON sessions(user_id);
CREATE INDEX ix_sessions_exp ON sessions(absolute_expires_at);

CREATE TABLE kb_registry (                -- JEDYNE źródło prawdy o KB
  namespace TEXT PRIMARY KEY,             -- np. 'LightingDocs' (ANGIELSKI — bug #753)
  name TEXT NOT NULL,                     -- etykieta PL dla UI
  project_id INTEGER,                     -- id projektu OpenSPG (NULL do czasu utworzenia)
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  description TEXT, embedding_model TEXT, -- NIE zmieniać po utworzeniu projektu
  schema_version INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL DEFAULT '{}', -- szablon schemy, profile czyszczenia itp.
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,                    -- 'draft_<yyyymmdd>_<8 hex>'
  namespace TEXT REFERENCES kb_registry(namespace),
  status TEXT NOT NULL DEFAULT 'inbox'
    CHECK (status IN ('inbox','analyzing','analyzed','promoted','rejected','withdrawn')),
  title TEXT, source_type TEXT NOT NULL CHECK (source_type IN ('url','text','file','mcp','gap')),
  source_ref TEXT,                        -- URL lub ścieżka uploadu
  content_md TEXT,                        -- treść w DB (transakcyjność); oryginalne pliki na dysku
  content_hash TEXT, content_length INTEGER,
  analysis_json TEXT,                     -- wynik analyze (w tym provider: llm|heuristic)
  reject_reason TEXT,
  submitted_by_user TEXT REFERENCES users(id), submitted_by_key TEXT,  -- api_keys.id dla MCP
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, promoted_at TEXT, export_path TEXT
);
CREATE INDEX ix_drafts_status ON drafts(status, created_at DESC);
CREATE INDEX ix_drafts_ns ON drafts(namespace, status);

CREATE TABLE actions (
  id TEXT PRIMARY KEY,                    -- 'act_<yyyymmdd>_<8 hex>'
  type TEXT NOT NULL,                     -- 'build_kb'|'create_kb'|'analyze_draft'|'export_drafts'|...
  resource TEXT NOT NULL,                 -- np. 'kb:LightingDocs', 'draft:draft_...'
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','error','cancelled')),
  params_json TEXT NOT NULL DEFAULT '{}', progress_json TEXT,   -- {phase,current,total,message}
  started_by TEXT REFERENCES users(id), pid INTEGER, exit_code INTEGER,
  log_path TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT
);
CREATE UNIQUE INDEX ux_actions_running ON actions(type, resource) WHERE status = 'running';  -- idempotencja
CREATE INDEX ix_actions_status ON actions(status, started_at DESC);

CREATE TABLE audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE, at TEXT NOT NULL,
  actor TEXT NOT NULL, actor_type TEXT NOT NULL CHECK (actor_type IN ('user','api_key','system')),
  role TEXT, action TEXT NOT NULL, resource_type TEXT, resource_id TEXT,
  outcome TEXT NOT NULL DEFAULT 'success',
  before_json TEXT, after_json TEXT, metadata_json TEXT,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE INDEX ix_audit_at ON audit(at); CREATE INDEX ix_audit_action ON audit(action, at);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  label TEXT NOT NULL, prefix TEXT NOT NULL,               -- 'sk-Ab1' (5 znaków do UI)
  hash TEXT NOT NULL UNIQUE,                               -- sha256 hex całego raw
  scopes_json TEXT NOT NULL DEFAULT '["read"]',            -- read | read,write
  profile_id TEXT NOT NULL REFERENCES mcp_profiles(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  created_at TEXT NOT NULL, created_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,                                -- TTL OBOWIĄZKOWY (lekcja: klucze bez TTL)
  last_used_at TEXT, requests_count INTEGER NOT NULL DEFAULT 0, revoked_at TEXT
);
CREATE INDEX ix_api_keys_user ON api_keys(user_id, status);

CREATE TABLE mcp_profiles (
  id TEXT PRIMARY KEY,                    -- slug: 'default','lighting-read',...
  name TEXT NOT NULL, description TEXT,
  namespaces_json TEXT,                   -- NULL = wszystkie active z kb_registry
  tools_json TEXT NOT NULL,               -- podzbiór ['kb_search','kb_answer','kb_list','kb_submit_draft']
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE learning_gaps (
  id TEXT PRIMARY KEY, question TEXT NOT NULL, namespace TEXT,
  confidence REAL, answer_preview TEXT,
  source TEXT NOT NULL CHECK (source IN ('mcp','panel')), api_key_id TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','ignored','drafted','resolved')),
  draft_id TEXT REFERENCES drafts(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX ix_gaps_status ON learning_gaps(status, created_at DESC);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,                   -- biała lista: 'llm.chat','llm.openie','llm.embeddings','learning.threshold',...
  value_json TEXT NOT NULL,               -- sekrety: {"sealed":"<base64 AES-GCM>"}
  is_secret INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, updated_by TEXT
);

-- Fallback retrievalu + snippety (mirror wypełniany przy export/promote):
CREATE TABLE chunks_mirror (
  id TEXT PRIMARY KEY,                    -- refId 'NS:Chunk:<hash>'
  namespace TEXT NOT NULL, title TEXT, content TEXT NOT NULL, source_ref TEXT, updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE chunks_fts USING fts5(title, content, content=chunks_mirror, content_rowid=rowid);
```

### 4.2 Co zostaje na dysku jako pliki (decyzje)
- **Logi akcji**: `/data/actions/<yyyy>/<mm>/<actionId>.log` — strumieniowe, potencjalnie duże, tail/SSE bez obciążania DB. W DB tylko `log_path`.
- **Oryginalne uploady** (PDF itd.): `/data/uploads/<sha256[:2]>/<sha256>` + oryginalna nazwa w `drafts.source_ref` — binaria nie do DB.
- **Eksporty CSV + _manifest.json**: `/data/exports/<namespace>/...` (kontrakt z builder jobem OpenSPG).
- **Raporty quality gate**: `/data/reports/` (md+json), indeks w `actions`.
- **Usage log MCP**: `/data/mcp-usage/<yyyy-mm-dd>.jsonl` (wolumetria zapytań — poza hash-chainem, patrz §6).
- **W DB (nie w plikach)**: treść draftów (`content_md`), rejestr KB, audyt, sesje, klucze — wszystko co wymaga transakcji i indeksów. To odwraca chorobę optimaKB (stan w JSON-ach, 5+ kopii rejestru).

---

## 5. Actions runner

- **Start**: serwis `actions-runner.ts` w transakcji `BEGIN IMMEDIATE` wstawia wiersz `actions` (unikalny indeks częściowy `ux_actions_running` daje atomiczny guard — złapany `SQLITE_CONSTRAINT` → 409 `action_already_running` z `details.actionId` istniejącej akcji; **idempotencja bez wyścigów**).
- **Preflight**: `preflight.ts` zwraca `{ok, checks:[{id,ok,severity:'error'|'warn',message}]}` — dla buildu: OpenSPG żyje, projekt istnieje, embedding_model zgodny, są wypromowane drafty/eksporty, brak running joba buildera, miejsce na dysku. `POST /build` wykonuje preflight wewnętrznie; błędy severity=error → 422; osobny endpoint `/preflight` dla UI (dwufazowy bulk).
- **Spawn**: `child_process.spawn('node', ['dist/jobs/run-job.js','--type',type,'--action',id], {detached:true, stdio:['ignore', logFd, logFd]})` — log pisany bezpośrednio przez deskryptor pliku (bez pośrednictwa pamięci rodzica); `pid` do DB. Dziecko dostaje config przez env, otwiera własne połączenie SQLite i **samo** aktualizuje `progress_json` (JSON w linii logu z prefiksem `@@progress ` jest równocześnie parsowany do DB przez samo dziecko — rodzic nic nie parsuje).
- **Zakończenie**: dziecko na końcu ustawia status/exit_code/finished_at w DB; rodzic w handlerze `close` robi korektę awaryjną (gdy dziecko padło bez zapisu → status=error, exit_code).
- **Orphan recovery**: przy starcie panel-api sweep: dla `status='running'` sprawdź `process.kill(pid,0)` — martwy → status=error, dopisek do logu.
- **Cancel**: `POST /actions/:id/cancel` → `process.kill(-pid, SIGTERM)`, po 10 s SIGKILL; status=cancelled.
- **SSE — decyzja: TAK, jako kanał podstawowy; polling zostaje jako fallback.** `GET /api/v1/actions/:id/events` (Content-Type `text/event-stream`, heartbeat co 15 s): eventy `log` (nowe linie — fs.watch + odczyt przyrostowy od ostatniego offsetu), `progress` (odpytanie wiersza akcji co 2 s przy aktywnym streamie), `status` (terminalny → zamknięcie strumienia). Uzasadnienie: eliminuje sztywny polling frontu, a implementacja to czysty `reply.raw` bez zależności; `GET /actions/:id` z `logTail` pozostaje źródłem prawdy dla CLI/testów i klientów bez SSE. W Caddy dla tej ścieżki `flush_interval -1`.

---

## 6. Audyt hash-chained w SQLite

- `packages/shared/src/audit/append.ts` — używany przez oba procesy: `BEGIN IMMEDIATE; SELECT hash FROM audit ORDER BY seq DESC LIMIT 1; INSERT ...; COMMIT;` — transakcja IMMEDIATE serializuje append **między procesami** (busy_timeout 5000), bez spin-locka z optimaKB.
- `hash = sha256(JSON.stringify(stableSort({id,at,actor,actor_type,role,action,resource_type,resource_id,outcome,before,after,metadata,prev_hash})))`; pierwszy wpis `prev_hash=''`.
- **Redakcja** przed zapisem: rekurencyjny sanitize — klucze pasujące do `/pass(word)?|secret|token|api[-_]?key|authorization|cookie|refresh/i` → `"[REDACTED]"`; stringi ucinane do 4000 zn., głębokość ≤8, tablice ≤100 elem.
- Hook `audit.ts` w panel-api: `onResponse` dla tras z `config.audit` — zapisuje actor (user id/email), rolę, action z configu, resource z params, outcome (success/2xx, error/4xx-5xx), before/after dostarczane przez serwis przez `reply.auditContext`.
- **Polityka wolumenu**: do łańcucha idą WSZYSTKIE mutacje panelu, logowania/wylogowania, operacje na kluczach, `mcp.submit_draft` i `mcp.auth_failed`. Odczyty MCP (search/answer) NIE trafiają do łańcucha (kontencja przy QPS) — lądują w `/data/mcp-usage/*.jsonl` + inkrement `requests_count`.
- Weryfikacja: `GET /api/v1/audit/verify` przelicza łańcuch od `seq=max-limit`; triggery blokują UPDATE/DELETE. Retencja: bezterminowa (SQLite z indeksem po `at` zniesie lata wpisów); archiwizacja = zadanie backupu z Podsystemu operacyjnego.

---

## 7. mcp-server — osobny proces

### 7.1 Transport i kształt HTTP
- Fastify jako shell HTTP (spójny logging/limity) + `@modelcontextprotocol/sdk`: **StreamableHTTPServerTransport w trybie bezstanowym** (`sessionIdGenerator: undefined`, `enableJsonResponse: true`) — każdy `POST /mcp/:profileId` tworzy parę McpServer+transport, obsługuje żądanie przez `transport.handleRequest(req.raw, reply.raw, req.body)` i zamyka. Uzasadnienie: narzędzia są bezstanowe (brak subskrypcji/resources), tryb JSON eliminuje problemy pseudo-SSE z optimaKB i buforowania proxy; skalowanie i restart bez utraty sesji.
- `GET|DELETE /mcp/:profileId` → 405 (spec dopuszcza brak SSE w trybie stateless). `GET /healthz` (proces żyje), `GET /readyz` (DB otwarta + wersja migracji zgodna + ≥1 profil enabled).
- Multipleks profili **po ścieżce** `/mcp/<profileId>` w jednym procesie (wzorzec optimaKB); Caddy: `kag.ilovelighting.sanok.pl/mcp*` → `kag-mcp:3001` (`deploy/edge/Caddyfile`; **port 3001**, nie 8090 — jak w PLAN.md §Architektura docelowa).
- Rate limit per klucz w pamięci: 60 req/min, `kb_answer` 10/min (koszt LLM) → JSON-RPC error z `retryAfter`.

### 7.2 Auth per-user API keys
- `Authorization: Bearer sk-<base64url 24B>`; format i cykl życia jak w optimaKB (raw raz, w DB tylko sha256+prefix), ale weryfikacja **bez zapisu przy każdym żądaniu**: lookup po indeksie `api_keys.hash` (sha256 prezentowanego tokenu) + `timingSafeEqual` na dopasowanym hashu; sprawdzenie `status='active'`, `expires_at > now`, `users.status='active'`, `profile_id == :profileId` ze ścieżki (niezgodność → 403). `last_used_at` aktualizowany najwyżej raz na 5 min (`UPDATE ... WHERE last_used_at IS NULL OR last_used_at < :cutoff`), `requests_count` batchowany w pamięci i flushowany co 30 s.
- **Cache w pamięci**: LRU (max 500) `hash → {keyRow, userRow, profileRow}` TTL 60 s; negatywny cache 10 s. Revoke z panelu działa więc najpóźniej po 60 s — akceptowalne; dodatkowo panel-api po revoke/rotate robi best-effort `POST mcp-server:/internal/cache/invalidate` (endpoint na osobnym porcie 8091 bind tylko do sieci wewnętrznej, sekret współdzielony `INTERNAL_SHARED_SECRET`).
- Brak nagłówka / zły token → HTTP 401 `{"jsonrpc":"2.0","error":{"code":-32001,"message":"unauthorized"}}` + wpis `mcp.auth_failed` do audytu (z prefiksem tokenu, nigdy całością). **Deny-by-default**: `kb_submit_draft` wymaga scope `write` (jawnie w scopes_json); proces odmawia startu, gdy DB niedostępna — nie ma trybu anonimowego w ogóle.

### 7.3 Profile
Czytane z `mcp_profiles` (cache 60 s + invalidate jak wyżej). Profil determinuje: listę narzędzi rejestrowanych w McpServer (kontrakt: `tools/list` == `tools_json` — test kontraktowy w CI) i dozwolone namespaces (`namespaces_json ∩ kb_registry WHERE status='active'`); parametr `namespaces` w wywołaniu narzędzia jest dodatkowo przycinany do tego zbioru (nadmiarowe → błąd `namespace_not_allowed` w wyniku narzędzia). Seed migracją: profil `default` (wszystkie narzędzia bez write, wszystkie namespaces).

### 7.4 Kontrakt narzędzi MCP (dokładne schematy)

> Źródło prawdy = `apps/mcp-server/src/tools/*.ts` (rejestr i kolejność w `apps/mcp-server/src/tools/index.ts`).
> Katalog odtworzony z kodu 2026-09-06: **11 narzędzi**. Kolejność w tabeli = kolejność
> w `tools/list`; widoczność przycina profil (`tools_json` ∩ rejestr).

Wyniki zwracane podwójnie: `structuredContent` (schematy niżej, zadeklarowane jako `outputSchema`) + `content:[{type:'text', text:<markdown PL>}]`. Wszystkie narzędzia mają `openWorldHint:false`.

**Katalog — co narzędzie ujawnia (to jest decyzja BEZPIECZEŃSTWA przy doborze `tools_json` do profilu):**

| Narzędzie | Scope | readOnly / idempotent | Co ujawnia |
|---|---|---|---|
| `kb_search` | read | ✓ / ✓ | snippety fragmentów + score + `sourceRef` z dozwolonych namespace'ów |
| `kb_answer` | read | ✓ / ✓ | odpowiedź LLM + cytowania ze snippetami; **koszt LLM** (limit 10/min) |
| `kb_list` | read | ✓ / ✓ | metadane baz: namespace, nazwa, status, `projectId`, liczba dokumentów |
| `kb_get_source` | read | ✓ / ✓ | **PEŁNĄ treść** fragmentu lub całego dokumentu (do `maxChars`) |
| `kb_list_documents` | read | ✓ / ✓ | spis dokumentów bazy: `docId`, tytuł, liczba chunków, `sourceRef`, `updatedAt` |
| `kb_draft_status` | read | ✓ / ✓ | losy draftów zgłoszonych **tym kluczem** (cudze → ten sam błąd co nieistniejące) |
| `kb_entity_get` | read | ✓ / ✓ | **pełne `properties` encji** z grafu (po sanitizacji: bez pól wektorowych, bez literalnych cudzysłowów) |
| `kb_graph_neighbors` | read | ✓ / ✓ | strukturę sąsiedztwa (nodes+edges, `in_document`/`about_topic`) do głębokości 3 |
| `kb_claim_verify` | read | ✓ / ✗ | werdykt supported/contradicted/insufficient + cytowania; **koszt LLM** |
| `kb_submit_draft` | **write** | ✗ / ✓ | nic nie czyta — jedyna droga zapisu (do Inboxu, NIGDY do grafu) |
| `kb_feedback` | read (`requiresWriteScope:false`) | ✗ / ✗ | nic nie czyta — zapisuje ocenę odpowiedzi i ewentualną lukę wiedzy |

Zasada doboru profilu: klucz, który ma tylko *odpowiadać*, nie potrzebuje `kb_get_source`
ani `kb_entity_get` — to one wynoszą pełne treści i właściwości encji poza panel.

**Schematy wejścia/wyjścia** (skrót — pola wymagane pogrubione, pełne JSON Schema w kodzie):

| Narzędzie | Wejście | Wyjście (`required`) |
|---|---|---|
| `kb_search` | **query** (2-500), namespaces[≤10], limit 1-20 (=8), mode `hybrid`\|`text`\|`vector` (=hybrid) | `results[]`, `degraded` (+`tookMs`, `degradedReasons[openspg_down\|openspg_no_hits\|snippet_only\|kb_dirty]`, `matchedRouting[]`) |
| `kb_answer` | **question** (5-2000), namespaces[≤10], maxSources 1-10 (=6), language `pl`\|`en` (=pl) | `answer`, `citations[]`, `confidence`, `gapRecorded`, **`answerId`** (+`claims[]`, `model`, `degraded`, `noAnswer`, `warnings[]`) |
| `kb_list` | — (obiekt pusty) | `kbs[]` (namespace, name, status; opc. projectId, description, documentCount) |
| `kb_get_source` | **id** (CHUNK_*/DOC_*), maxChars | `id`, `namespace`, `content`, `truncated` (+`docId`, `title`, `sourceRef`, `nextChunkId`, `prevChunkId`, `chunkCount`) |
| `kb_list_documents` | **namespace**, q(≤200), limit 1-50 (=20), offset (=0) | `documents[]` (docId, chunks; opc. title, sourceRef, updatedAt), `total` |
| `kb_draft_status` | draftId (opcjonalny — bez niego 20 ostatnich) | `drafts[]` (draftId, status `pending`\|`promoted`\|`rejected`\|`withdrawn`, title, …) (+`counts`) |
| `kb_entity_get` | **id**, namespace | `id`, `namespace`, `spgType`, `properties`, `degraded` |
| `kb_graph_neighbors` | **id**, namespace, depth 1-3 (=1), direction `out`\|`in`\|`both` (=both) | `nodes[]` (id, distance; opc. title, kind), `edges[]` (srcId, rel `in_document`\|`about_topic`, dstId) |
| `kb_claim_verify` | **claim** (5-1000), namespaces[≤10] | `status` (`supported`\|`contradicted`\|`insufficient`), `explanation`, `citations[]` (+`degraded`, `gapRecorded`) |
| `kb_submit_draft` | **namespace**, **title** (3-300), **content** (50-100000, markdown), sourceUrl, tags[≤10], **idempotencyKey** (8-128, opcjonalny — retry zwraca ten sam draftId) | `draftId`, `status`, `reviewRequired` (+`duplicate` — identyczna treść już czekała w Inboxie) |
| `kb_feedback` | **answerId**, **verdict** (`up`\|`down`), comment (≤2000) | `ok`, `gapCreated` (+`gapUpdated`) |

Uwaga nazewnicza: `kb_submit_draft` zwraca `status:"inbox"` (etykieta protokołu MCP),
podczas gdy wiersz w tabeli `drafts` ma status `pending` — to świadomy rozjazd
doc/API ↔ DB; `kb_draft_status` raportuje już wartości z DB (`pending`/…).

Pełne, znakowo dokładne JSON Schema pierwszych czterech narzędzi (historyczne, zgodne z kodem):

**kb_search** — wejście:
```json
{ "type":"object", "additionalProperties":false, "required":["query"],
  "properties":{
    "query":{"type":"string","minLength":2,"maxLength":500},
    "namespaces":{"type":"array","items":{"type":"string"},"maxItems":10},
    "limit":{"type":"integer","minimum":1,"maximum":20,"default":8},
    "mode":{"type":"string","enum":["hybrid","text","vector"],"default":"hybrid"} } }
```
wyjście:
```json
{ "type":"object","required":["results","degraded"],
  "properties":{
    "results":{"type":"array","items":{"type":"object",
      "required":["id","namespace","score","snippet","source"],
      "properties":{
        "id":{"type":"string"}, "title":{"type":"string"},
        "snippet":{"type":"string"}, "namespace":{"type":"string"},
        "kbName":{"type":"string"}, "label":{"type":"string"},
        "score":{"type":"number"},
        "source":{"type":"string","enum":["openspg_text","openspg_vector","fallback_fts"]},
        "sourceRef":{"type":"string"} }}},
    "tookMs":{"type":"integer"}, "degraded":{"type":"boolean"},
    "degradedReasons":{"type":"array","items":{"type":"string",
      "enum":["openspg_down","openspg_no_hits","snippet_only","kb_dirty"]}},
    "matchedRouting":{"type":"array","items":{"type":"string"}} } }
```

**kb_answer** — wejście:
```json
{ "type":"object","additionalProperties":false,"required":["question"],
  "properties":{
    "question":{"type":"string","minLength":5,"maxLength":2000},
    "namespaces":{"type":"array","items":{"type":"string"},"maxItems":10},
    "maxSources":{"type":"integer","minimum":1,"maximum":10,"default":6},
    "language":{"type":"string","enum":["pl","en"],"default":"pl"} } }
```
wyjście:
```json
{ "type":"object","required":["answer","citations","confidence","gapRecorded","answerId"],
  "properties":{
    "answer":{"type":"string","description":"Markdown z cytowaniami [1],[2]"},
    "citations":{"type":"array","items":{"type":"object",
      "required":["n","id","namespace"],
      "properties":{"n":{"type":"integer"},"id":{"type":"string"},"title":{"type":"string"},
        "namespace":{"type":"string"},"snippet":{"type":"string"},"sourceRef":{"type":"string"}}}},
    "claims":{"type":"array","items":{"type":"object","required":["claim","evidenceNs"],
      "properties":{"claim":{"type":"string"},
        "evidenceNs":{"type":"array","items":{"type":"integer"}}}}},
    "confidence":{"type":"number","minimum":0,"maximum":1},
    "model":{"type":"string"}, "degraded":{"type":"boolean"}, "gapRecorded":{"type":"boolean"},
    "answerId":{"type":"string"}, "noAnswer":{"type":"boolean"},
    "warnings":{"type":"array","items":{"type":"string"}} } }
```
`answerId` jest **wymagane** — bez niego agent nie ma czym zawołać `kb_feedback`.

**kb_list** — wejście `{"type":"object","additionalProperties":false,"properties":{}}`; wyjście:
```json
{ "type":"object","required":["kbs"],
  "properties":{"kbs":{"type":"array","items":{"type":"object",
    "required":["namespace","name","status"],
    "properties":{"namespace":{"type":"string"},"name":{"type":"string"},
      "projectId":{"type":"integer"},"status":{"type":"string"},
      "description":{"type":"string"},"documentCount":{"type":"integer"}}}}} }
```

**kb_submit_draft** (scope write; jedyna droga zapisu — NIGDY do grafu) — wejście:
```json
{ "type":"object","additionalProperties":false,"required":["namespace","title","content"],
  "properties":{
    "namespace":{"type":"string"},
    "title":{"type":"string","minLength":3,"maxLength":300},
    "content":{"type":"string","minLength":50,"maxLength":100000,"description":"Markdown"},
    "sourceUrl":{"type":"string","format":"uri"},
    "tags":{"type":"array","items":{"type":"string"},"maxItems":10},
    "idempotencyKey":{"type":"string","minLength":8,"maxLength":128,
      "description":"Klucz idempotencji per klucz API — retry zwraca ten sam draftId zamiast duplikatu"} } }
```
wyjście (`required`: `draftId`, `status`, `reviewRequired`):
`{"draftId":"draft_...","status":"inbox","reviewRequired":true,"duplicate":false}`
— `duplicate:true` oznacza, że identyczna treść już czekała w Inboxie. Insert do `drafts`
z `source_type='mcp'`, `submitted_by_key`; audyt do łańcucha.

Błędy narzędzi: zwracane jako wynik z `isError:true` i tekstem PL + `structuredContent:{errorCode}` (`namespace_not_allowed`, `upstream_unavailable`, `rate_limited`, `validation`) — nie jako błędy protokołu (te tylko dla auth/transportu).

### 7.5 Klient search OpenSPG — payloady ZWERYFIKOWANE, klient defensywny na kształt ODPOWIEDZI
`packages/shared/src/openspg/search.ts`:
- **Payloady (zweryfikowane na żywym serwerze 2026-09-02, powtórzone 2026-09-06;
  jedno źródło prawdy razem z `.claude/skills/openspg-api/SKILL.md`)**:
  `POST /public/v1/search/text` body `{"projectId":<int, WYMAGANE>,"queryString":"<q>","labelConstraints":["<Ns>.Chunk","<Ns>.ReferenceDocument"],"page":1,"topk":<k>}`;
  `POST /public/v1/search/vector` body `{"projectId":<int, WYMAGANE>,"label":"<Ns>.Chunk","propertyKey":"descriptionPreview","queryVector":[...],"topk":<k>,"efSearch":200}`
  (wektor liczony przez nasz klient embeddings modelem `kb_registry.embedding_model` — przy braku konfiguracji embeddings tryb hybrid degraduje się do text-only).
- **NIE PRZYWRACAĆ** wariantu `{queryString, labelConstraints, page, size}` bez `projectId`:
  serwer zwraca HTTP 400 („There is no such fulltext schema index: `_default_text_index`").
  Ponieważ `projectId` jest wymagany, zapytania idą **per namespace** (`kb_registry.project_id`)
  i są scalane RRF.
- **Normalizator odpowiedzi (POWÓD defensywności — kształt ODPOWIEDZI, nie żądania)**: akceptuje `{success:true,result:[...]}` | `{data:[...]}` | goły array; element mapowany elastycznie: id z `docId|id|node.id`, score z `score`, pola z `fields|properties|node.properties`; nieznany kształt → log surowej odpowiedzi (poziom warn, obcięty) + traktowanie jako pustego wyniku.
- **Sonda przy starcie i co 10 min**: wywołanie testowe na aktywnym namespace; wynik (`textOk`, `vectorOk`, wykryty wariant) cachowany i raportowany w `/readyz` oraz w cockpicie `/api/v1/status`.
- **Łańcuch fallbacków w kb_search**: hybrid = text + vector równolegle (timeout 5 s każdy), scalanie **RRF** (k=60), dedup po id/hash → gdy oba niedostępne lub 0 wyników przy niepustym mirrorze → **FTS5 po `chunks_fts`** (`bm25`, snippet() do podświetleń) z `source:'fallback_fts'` i `degraded:true`. Fallback jest jawnie oznaczony — to bezpiecznik, nie substytut OpenSPG (lekcja: „retrieval przez grep CSV" jako jedyna droga było błędem optimaKB).

### 7.6 kb_answer — pipeline
1. Retrieval: wewnętrzne `kb_search(mode:'hybrid', limit: maxSources*2)`.
2. Budowa kontekstu: sortowanie po score, budżet ~6000 tokenów (przycinanie per chunk do 1200), numeracja [1..n] ze stabilnym mapowaniem na `citations`.
3. `chat_llm` (OpenAI-compatible `/v1/chat/completions`, non-stream w v1, timeout 60 s, 1 retry na 5xx): system prompt PL — „odpowiadaj WYŁĄCZNIE na podstawie źródeł, cytuj [n], gdy brak podstaw powiedz że nie wiesz"; na końcu wymuszona linia `CONFIDENCE: <0..1>`.
4. `confidence = 0.5*llmSelf + 0.3*normalizowany_top_score + 0.2*coverage` (udział cytowanych źródeł); parsowanie CONFIDENCE defensywne (brak → licz z samego retrievalu).
5. `confidence < settings['learning.threshold']` (default 0.45) → insert `learning_gaps` (`source:'mcp'`, api_key_id, question, answer_preview 500 zn.) → `gapRecorded:true`. Panel: Uczenie → gap → auto-draft → recenzja (human-in-the-loop).
6. Wpis do usage-JSONL: `{at, keyId, tool, namespaces, tookMs, confidence, degraded}` — bez treści pytania w łańcuchu audytu.

### 7.7 Zarządzanie kluczami z panelu
Cały CRUD w panel-api (§2.2 `/mcp/keys*`): tworzenie (raw pokazany raz, kopiowanie w UI), rotate (nowy sekret pod tym samym id, stary hash martwy natychmiast + invalidate cache), revoke, TTL obowiązkowy z widocznym `expires_at`, limit 5 aktywnych/user; klucz `write` tworzy wyłącznie admin i tylko dla świadomie wybranej tożsamości (człowiek lub user serwisowy). `GET /mcp/snippets` generuje bloki konfiguracyjne (claude-code: `claude mcp add --transport http kag https://kag.ilovelighting.sanok.pl/mcp/<profil> --header "Authorization: Bearer <KLUCZ>"`, cursor/generic JSON z `"type":"http"`) — z placeholderem, nigdy z prawdziwym kluczem.

---

## 8. Przykładowe payloady przesądzające kształt

`POST /api/v1/kbs/LightingDocs/build` → `202 {"ok":true,"data":{"actionId":"act_20260901_a1b2c3d4","type":"build_kb","resource":"kb:LightingDocs","logPath":"/data/actions/2026/09/act_20260901_a1b2c3d4.log"}}`

SSE `GET /api/v1/actions/act_.../events`:
```
event: progress
data: {"phase":"upload","current":3,"total":12,"message":"Wysyłanie chunks.csv"}

event: log
data: {"line":"[builder] job 4711 status RUNNING"}

event: status
data: {"status":"success","exitCode":0,"finishedAt":"2026-09-01T12:03:44Z"}
```

`POST /mcp/default` (MCP `tools/call kb_search`) — odpowiedź `structuredContent`:
```json
{"results":[{"id":"LightingDocs:Chunk:9f2c...","title":"Montaż szynoprzewodów",
  "snippet":"…maksymalne obciążenie szyny 3F wynosi…","namespace":"LightingDocs",
  "kbName":"Dokumentacja oświetlenia","label":"LightingDocs.Chunk","score":0.83,
  "source":"openspg_text","sourceRef":"https://…/karta.pdf"}],
 "tookMs":412,"degraded":false}
```

## 9. Kolejność implementacji
1. `packages/shared`: db/open + migracja 0001 + errors + crypto → 2. panel-api: config/db/error-handler/`/healthz` → 3. oidc+session+rbac+csrf (mock Authentika w testach przez lokalny OIDC provider) → 4. audit (append+verify+hook) → 5. rejestr KB + drafts CRUD → 6. actions runner + SSE + preflight → 7. openspg client (login/builder/search+sonda) + settings LLM → 8. mcp-server (auth → profile → kb_list → kb_search → kb_submit_draft → kb_answer) → 9. mcp-admin w panelu (klucze/profile/snippety) → 10. learning gaps. Testy: vitest per serwis + testy kontraktowe (tools/list==profil; koperta REST; 405; łańcuch audytu).

### Critical Files for Implementation
- /kag/packages/shared/src/db/migrations/0001_init.sql
- /kag/apps/panel-api/src/app.ts
- /kag/apps/panel-api/src/plugins/oidc.ts
- /kag/apps/mcp-server/src/tools/kb-search.ts
- /kag/packages/shared/src/openspg/search.ts


## FILE LAYOUT

> **Lista planistyczna, nie stan repo.** Część nazw nigdy nie powstała w tej postaci —
> np. `apps/panel-api/src/services/mcp-keys.ts` (logika kluczy MCP siedzi w
> `apps/panel-api/src/services/mcp-admin.ts`), a `packages/shared` scaliło
> planowane pakiety `db`/`openspg-client`. Aktualny obraz: tabela tras §2.2, katalog
> narzędzi §7.4 oraz sam kod.
- /kag/package.json — root monorepo (npm workspaces: apps/*, packages/*), skrypty test/build/migrate
- /kag/packages/shared/src/db/open.ts — otwarcie better-sqlite3 z pragmami (WAL, FK, busy_timeout), wspólne dla obu procesów
- /kag/packages/shared/src/db/migrate.ts — runner migracji SQL (BEGIN EXCLUSIVE, tabela schema_migrations); tryb check-only dla mcp-server
- /kag/packages/shared/src/db/migrations/0001_init.sql — pełny DDL: users, sessions, kb_registry, drafts, actions, audit(+triggery), api_keys, mcp_profiles, learning_gaps, settings, chunks_mirror/fts + seed profilu default
- /kag/packages/shared/src/audit/append.ts — hash-chained append (BEGIN IMMEDIATE), redakcja rekurencyjna, verifyChain
- /kag/packages/shared/src/crypto/keys.ts — generacja sk-<base64url>, sha256 hash+prefix, timingSafeEqual compare
- /kag/packages/shared/src/crypto/seal.ts — AES-256-GCM seal/unseal (tokeny OIDC, sekrety settings)
- /kag/packages/shared/src/openspg/client.ts — bazowy klient REST OpenSPG (baseUrl, cookie login, timeouty, mapowanie na upstream_error)
- /kag/packages/shared/src/openspg/search.ts — payloady search/text i search/vector, normalizator odpowiedzi, sonda zgodności, scalanie RRF
- /kag/packages/shared/src/openspg/builder.ts — submit/get/list builder jobów (start=1), statusy terminalne
- /kag/packages/shared/src/llm/openai-client.ts — klient OpenAI-compatible: chat, embeddings; retry/timeout; bez logowania kluczy
- /kag/packages/shared/src/schemas/ — współdzielone JSON Schema ($id): koperta, draft, kb, api_key, profile, action
- /kag/packages/shared/src/errors.ts — AppError(code, statusCode) + katalog kodów błędów
- /kag/apps/panel-api/src/app.ts — buildApp(): kolejność pluginów i rejestracja routes (testowalne przez inject)
- /kag/apps/panel-api/src/server.ts — bootstrap: env, migracje, orphan sweep akcji, sweep sesji, listen 8080
- /kag/apps/panel-api/src/plugins/config.ts — walidacja ENV (@fastify/env) z wariantami *_FILE
- /kag/apps/panel-api/src/plugins/session.ts — cookie kag_sid (HttpOnly/Secure/Lax, host-only), store sha256(sid) w SQLite, sliding TTL
- /kag/apps/panel-api/src/plugins/oidc.ts — openid-client v6: discovery Authentika, /auth/login|callback|logout, PKCE+state+nonce, refresh, mapowanie grup na role
- /kag/apps/panel-api/src/plugins/rbac.ts — requireRole z route.config.rbac (admin⊃operator⊃viewer), deny-by-default
- /kag/apps/panel-api/src/plugins/csrf.ts — kontrola Origin/Sec-Fetch-Site na mutacjach (stateless)
- /kag/apps/panel-api/src/plugins/rate-limit.ts — @fastify/rate-limit, trustProxy:1 (jedyny hop = Caddy), polityki per grupa tras
- /kag/apps/panel-api/src/plugins/audit.ts — hook onResponse dla mutacji wg route.config.audit
- /kag/apps/panel-api/src/plugins/error-handler.ts — koperta błędów, mapowanie walidacji, 404/405 z Allow, requestId
- /kag/apps/panel-api/src/plugins/sse.ts — reply.sse(): nagłówki event-stream, heartbeat, cleanup
- /kag/apps/panel-api/src/routes/*.ts — deklaracje tras + schematy: auth, me, status, kbs, drafts, actions, audit, learning, mcp-admin, settings, users
- /kag/apps/panel-api/src/services/actions-runner.ts — insert z guardem ux_actions_running, spawn detached, cancel, orphan recovery, streaming logu do SSE
- /kag/apps/panel-api/src/services/preflight.ts — checks buildu/bulk (OpenSPG, projekt, embedding, eksporty, dysk)
- /kag/apps/panel-api/src/services/mcp-keys.ts — CRUD kluczy: raw raz, rotate/revoke, TTL, limit aktywnych, invalidate cache mcp-server
- /kag/apps/panel-api/src/jobs/run-job.ts — dispatcher procesów potomnych (--type, --action); własne połączenie DB, @@progress
- /kag/apps/panel-api/src/jobs/{build-kb.ts,analyze-draft.ts,create-kb.ts,export-drafts.ts} — implementacje długobieżnych akcji
- /kag/apps/mcp-server/src/server.ts — bootstrap: check wersji migracji, Fastify 8090 + internal 8091 (cache invalidate), graceful shutdown
- /kag/apps/mcp-server/src/mcp.ts — fabryka McpServer per żądanie: StreamableHTTPServerTransport stateless (enableJsonResponse), rejestracja narzędzi wg profilu
- /kag/apps/mcp-server/src/auth.ts — weryfikacja Bearer sk-: lookup po hash, LRU cache 60s, batch last_used/requests_count, 401 JSON-RPC
- /kag/apps/mcp-server/src/profiles.ts — ładowanie mcp_profiles z cache + przycinanie namespaces do rejestru
- /kag/apps/mcp-server/src/tools/kb-search.ts — narzędzie kb_search: hybrid text+vector, RRF, fallback FTS5, degraded flag
- /kag/apps/mcp-server/src/tools/kb-answer.ts — retrieval → kontekst → chat_llm → cytowania → confidence → learning_gap
- /kag/apps/mcp-server/src/tools/kb-list.ts — lista KB z kb_registry przycięta do profilu
- /kag/apps/mcp-server/src/tools/kb-submit-draft.ts — scope write, insert draftu (source_type=mcp), audyt do łańcucha
- /kag/apps/mcp-server/src/usage-log.ts — dzienny JSONL użycia narzędzi (poza hash-chainem)
- /kag/apps/panel-api/test/ oraz /kag/apps/mcp-server/test/ — vitest: testy serwisów, kontraktowe (koperta, 405, tools/list==profil, łańcuch audytu), mock OIDC i OpenSPG

## RISKS
- **[ZAMKNIĘTE 2026-09-02, potwierdzone 2026-09-06]** Kształt PAYLOADÓW `/public/v1/search/text|vector` był niezweryfikowany. Zweryfikowano na żywym serwerze: wymagany `projectId` + limit `topk` (wariant z `size` bez `projectId` → HTTP 400). Klient (`search.ts`) wysyła już poprawne payloady; spec w §7.5 i w SKILL `openspg-api`. Defensywność klienta ZOSTAJE, ale z innego powodu: niestabilny jest kształt ODPOWIEDZI — normalizator (`{success,result}`/`{data}`/goły array), sonda zgodności przy starcie i cyklicznie (wynik w /readyz i cockpicie), log surowej odpowiedzi przy nieznanym kształcie, fallback FTS5 z jawnym `degraded:true`.
- Współdzielenie SQLite między dwoma kontenerami wymaga wspólnego LOKALNEGO wolumenu (WAL nie działa na NFS/sieciowych FS) i dyscypliny krótkich transakcji. Mitigacja: oba procesy montują ten sam named volume, BEGIN IMMEDIATE tylko na krótkie sekcje (audit append, insert akcji), busy_timeout 5s, testy współbieżności dwuprocesowej w CI.
- Kontencja hash-chaina audytu przy ruchu MCP. Mitigacja: do łańcucha trafiają tylko mutacje i auth_failed; odczyty (search/answer) idą do plikowego usage-JSONL i liczników batchowanych w pamięci.
- Refresh tokenów wymaga scope offline_access i odpowiedniej konfiguracji providera w Authentiku; bez tego sesje kończą się z access tokenem. Mitigacja: jawny wymóg w konfiguracji Podsystemu deployment (provider kag-panel: offline_access włączony), a kod degraduje się przewidywalnie — sesja żyje do absolute_expires_at bez odświeżania roli.
- Revoke klucza MCP działa z opóźnieniem do 60 s (cache LRU). Mitigacja: best-effort invalidate z panel-api na wewnętrzny port 8091 (współdzielony sekret); TTL cache krótki; przy incydencie admin może zrestartować mcp-server.
- SSE przez Caddy może być buforowane/ucinane. Mitigacja: flush_interval -1 dla /api/v1/actions/*/events w Caddyfile, heartbeat co 15 s, oraz pełnoprawny fallback pollingowy GET /actions/:id z logTail (źródło prawdy).
- Vector search wymaga liczenia embeddingu zapytania modelem IDENTYCZNYM z vectorizerem projektu (embedding modelu nie wolno zmieniać po utworzeniu projektu — fakt z briefu). Mitigacja: model zapisany w kb_registry.embedding_model, walidowany w preflight; brak konfiguracji embeddings → hybrid degraduje się do text-only zamiast zwracać śmieci.
- OpenSPG :8887 bez żadnej autoryzacji — każdy błąd sieciowy w compose (np. publikacja portu) = pełne przejęcie grafu. Mitigacja: port wyłącznie w sieci wewnętrznej stacku kag (kontrakt dla Podsystemu deployment), panel-api/mcp-server jedynymi klientami, check_security_posture w testach smoke.
- Wyciek sekretów do logów (Authorization, cookies, klucze LLM). Mitigacja: pino redact paths w obu procesach, redakcja rekurencyjna w audycie, sekrety settings sealowane AES-GCM, maskowanie configured+preview w API.
- Bezstanowy tryb MCP (JSON response) nie wspiera server-push (sampling/subskrypcje) — gdyby przyszłe fazy ich wymagały, trzeba przejść na sessionIdGenerator + SSE. Mitigacja: fabryka serwera per żądanie izoluje tę decyzję w jednym pliku (mcp.ts).

## OPEN QUESTIONS
- Klucze MCP ze scope write: proponuję, że tworzy je wyłącznie admin (operator może tworzyć tylko własne klucze read). Potwierdzić, czy operatorzy mają móc samodzielnie wystawiać klucze write dla swoich agentów.
- Sesja panelu: proponuję absolutny TTL 12 h + idle 60 min z cichym odświeżaniem przez refresh token (wymaga offline_access w providerze Authentika). Alternatywa bez offline_access: twarde wylogowanie po wygaśnięciu — którą wersję przyjąć?
- Czy odpowiedzi kb_answer (pytanie+odpowiedź) mają być w całości zapisywane w usage-logu (przydatne do oceny jakości, ale wrażliwe treściowo), czy tylko metadane + preview 500 znaków jak zaproponowano?
## Aneks (2026-09-05): modernizacja wg raportu „Nowoczesny MCP i integracja z OpenSPG/KAG"

**Wdrożone:**
- **Dwie ery protokołu na jednym endpoincie** `POST /mcp/:profileId`: ruch 2025
  (initialize, bez envelope) → dotychczasowa ścieżka SDK v1 — bajtowo bez zmian
  (Claude Code/Cursor); ruch 2026-07-28 (envelope `_meta`) → SDK v2
  (`createModernHandler`: server/discover, resultType, serverInfo w `_meta`,
  walidacja `Mcp-Method`/`Mcp-Name` z -32020, `ttlMs:60000`+`cacheScope:private`
  na tools/list — spójnie z TTL cache profili). Routing user-land przez
  `isLegacyRequest` (wzorzec z dokumentacji SDK). Wspólna logika narzędzi:
  `executeToolCall`/`toolsListPayload` w mcp.ts.
- Narzędzia grafowe (`kb_entity_get`, `kb_graph_neighbors`) na tabeli
  `graph_edges` w SQLite — Neo4j NIE MA krawędzi (relacje *RefId to stringi;
  empirycznie 0 relacji), `query/spgType` jako autorytatywny stan encji
  z sanitizacją (wektory, literalne cudzysłowy).
- `kb_claim_verify` (supported/contradicted/insufficient + cytowania; bramka
  bez-dowodów bez kosztu LLM, insufficient → luka wiedzy), `claims[]`
  w kb_answer (zdanie→[n], zero dodatkowego LLM), `idempotencyKey`
  w kb_submit_draft, prompt `grounded-analysis`.

**Świadomie pominięte (z uzasadnieniem):**
- **Tasks extension** — MCP nie ma operacji długotrwałych (buildy human-only
  przez panel); wrócić, gdyby MCP dostał operacje >30 s.
- **MCP Apps** — panel WWW pełni tę rolę (Evidence Explorer = /kb + kb_get_source).
- **OTel w _meta** — audyt hash-chain + usage-JSONL + quality_answers wystarczają
  na tę skalę; OTel dopiero przy >1 instancji.
- **OAuth/OIDC 2026 (PRM, RFC 8707, Enterprise-Managed Auth)** — klucze `sk-*`
  (sha256, TTL, profile) pozostają naszym modelem enterprise-managed auth;
  SDK nie waliduje tokenów, więc nic tego nie wymusza. Brak token passthrough
  (klient→MCP token nigdy nie idzie do OpenSPG/LLM) — zgodnie ze spec.
- **`reason/run` przez MCP — ZAKAZ** (odpowiedź zawiera hasło Neo4j
  w `graphStoreUrl`); wyłącznie admin-diagnostyka z redakcją.
