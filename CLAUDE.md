# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Język

Odpowiadaj po polsku — wszystkie odpowiedzi, wyjaśnienia, podsumowania i pytania do użytkownika
pisz w języku polskim. Kod, identyfikatory, nazwy plików i komunikaty commitów — po angielsku.
Teksty UI panelu — po polsku, wyłącznie przez słownik `apps/panel-web/src/i18n/pl.ts`.

## Projekt

**PomagierKB** — samodzielnie hostowana platforma baz wiedzy na OpenSPG Knowledge Graph:
panel WWW (React, OIDC/Authentik), serwer MCP dla agentów, pipeline ingest dokumentów.
Domeny: kag.ilovelighting.sanok.pl (panel+MCP), auth.ilovelighting.sanok.pl (Authentik).
Deployment: 2 stacki docker compose na tym VPS (deploy/edge + deploy/kag).

**Zanim zaczniesz pracę nad nowym obszarem, przeczytaj:**
- `docs/design/PLAN.md` — zatwierdzony plan (decyzje są ROZSTRZYGNIĘTE — nie otwieraj ich ponownie)
- `docs/design/{infra,backend-mcp,pipeline-frontend}.md` — szczegółowe projekty podsystemów
- `.claude/skills/openspg-api/SKILL.md` — API i pułapki OpenSPG (obowiązkowe przy pracy z OpenSPG)

## Komendy

```bash
npm install               # root monorepo (workspaces: apps/*, packages/*)
npm test                  # vitest we wszystkich workspace'ach
npm run test -w apps/panel-api -- run test/chunker.test.ts   # pojedynczy plik testów
npm run lint              # eslint
npm run typecheck         # tsc --noEmit we wszystkich workspace'ach
npm run build             # build wszystkich pakietów/aplikacji
docker compose -f deploy/edge/compose.yaml config -q   # walidacja compose (wymaga .env)
docker compose -f deploy/kag/compose.yaml config -q
docker compose -f compose.dev.yaml up    # dev: panel+mcp+SQLite+stub OpenSPG (bez pełnego stacka)
deploy/scripts/smoke.sh   # smoke test po deployu
npm run eval              # hit@k/MRR retrievalu na goldens.jsonl (DATA_DIR wskazuje bazę)
node tools/ux-audit/e2e.mjs         # E2E klikalne na produkcji (10 checków, login akadmin)
node tools/ux-audit/screenshot.mjs  # zrzuty produkcji (--pages /kb,... --out katalog)
```

## Architektura (skrót — pełny obraz w docs/design/PLAN.md)

- **apps/panel-api** — Fastify (Node 22, TS). Trasy = deklaracja + JSON Schema (additionalProperties:false);
  logika w services/; pipeline wiedzy w pipeline/; długobieżne akcje w jobs/ (spawn + 202+actionId + SSE).
  Auth: OIDC (openid-client), sesje w SQLite, role z grup Authentika. CSRF: Origin/Sec-Fetch-Site.
- **apps/mcp-server** — @modelcontextprotocol/sdk, Streamable HTTP stateless, profile po ścieżce
  /mcp/<profil>; auth Bearer sk-... (sha256 w SQLite). Narzędzia: kb_search/kb_answer/kb_list/
  kb_submit_draft/kb_feedback.
- **apps/panel-web** — React 19 + Vite + TanStack Router/Query. Strony: overview, ask
  (mobile-first), add, inbox(+luki), kb, mcp, settings. Design system v2 (Linear-like):
  tokeny Tailwind v4 w src/styles/app.css, kit komponentów w src/ui/, shell (sidebar/
  topbar/⌘K) w components/shell/ — nowe UI buduj Z KITU, nie gołym HTML/CSS ani .btn.
- **packages/shared** — db (better-sqlite3 WAL, migracje SQL), audit (hash-chain), crypto,
  openspg (client/search/builder/login/models), llm (openai-compatible), schemas, errors.
- **Stan**: JEDEN plik SQLite współdzielony panel-api+mcp-server (WAL, busy_timeout 5000,
  krótkie BEGIN IMMEDIATE). Migracje uruchamia tylko panel-api. Pliki na dysku: logi akcji,
  uploady, eksporty CSV, usage-JSONL.
- **Cykl wiedzy**: intake → ekstrakcja (Stirling→OCR pol→Tika, próg jakości) → czyszczenie →
  analyze (LLM+fallback heurystyczny) → draft w Inboxie → recenzja CZŁOWIEKA → eksport CSV
  (+mirror FTS5) → builder job OpenSPG → quality gate. MCP/LLM NIGDY nie pisze do grafu —
  tylko draft do inboxu.

## Twarde zasady (z audytów systemu wzorcowego — nie łamać)

- Fail-closed: brak konfiguracji auth = 503; bramki `x !== true`; zero trybów anonimowych.
- Sekrety: nigdy w git/logach/odpowiedziach API/argv; klucze API = sha256+prefix, raw raz;
  LLM klucze w settings (sealed AES-GCM), NIE w .env.
- LLM zawsze bezpośrednio przez packages/shared/llm (openai-compatible SDK) — NIGDY przez
  /v1/chat/completions OpenSPG.
- OpenSPG: schema po ANGIELSKU; relacje tylko jako właściwości *RefId; TextAndVector tylko
  na polach krótkich; builder/job/list ze start=1; port 8887 nigdy na host; embedding
  projektu niezmienialny (vector_model_id w rejestrze + preflight).
- Rejestr KB w SQLite = JEDYNE źródło prawdy o bazach (zero duplikatów list w kodzie).
- Każda mutacja audytowana; każda pauza/breaker ma ścieżkę auto-recovery.
- Odpowiedzi API w kopercie {ok,data}/{ok:false,error:{code,...}}; kody błędów z katalogu
  packages/shared/src/errors.ts.
- Czysta logika (chunker, health, permissions, słownik komunikatów) w plikach bez frameworka,
  z testami vitest.
- deploy/edge/Caddyfile to bind-mount POJEDYNCZEGO pliku: edycja podmienia inode, więc
  `caddy reload` przeładuje starą wersję — po edycji zawsze `docker restart edge-caddy`.

## Git

- Commity po angielsku (conventional: feat/fix/chore/docs...); push na origin main po każdej
  ukończonej fazie planu. Pre-commit gitleaks jest obowiązkowy (core.hooksPath=.githooks).
- Remote: git@github.com:RobertBirek/PomagierKB.git (klucz SSH id_ed25519_github_robertbirek).
- `gh` CLI zalogowany (konto RobertBirek) — PR-y/issues/CI przez gh. Klony https://github.com/
  są globalnie przepisywane na SSH (insteadOf) — omija limity anonimowych pobrań.
