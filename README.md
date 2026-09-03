# PomagierKB

Samodzielnie hostowana platforma baz wiedzy („globalny mózg" dla ludzi i agentów AI)
zbudowana na grafie wiedzy **OpenSPG**: panel WWW z recenzją human-in-the-loop,
serwer **MCP** dla agentów (Claude Code, Cursor, …) i pipeline ingest dokumentów
(PDF/OCR/URL/tekst) z hybrydowym wyszukiwaniem (FTS5 + wektory + graf, fuzja RRF).

- Panel: https://kag.ilovelighting.sanok.pl (SSO Authentik)
- MCP dla agentów: `POST https://kag.ilovelighting.sanok.pl/mcp/<profil>` (Bearer `sk-…`)

## Architektura (skrót)

```
edge (Caddy + Authentik) ──► kag-panel (Fastify + React SPA) ──┐
                        └──► kag-mcp  (MCP Streamable HTTP)  ──┼── JEDEN SQLite (WAL)
                                                               └── OpenSPG (MySQL+Neo4j+MinIO)
pipeline: intake → ekstrakcja (Stirling/OCR/Tika) → czyszczenie → analyze (LLM)
        → szkic w Inboxie → RECENZJA CZŁOWIEKA → eksport CSV → builder OpenSPG
```

Pełny obraz decyzji: `docs/design/PLAN.md`; podsystemy: `docs/design/{infra,backend-mcp,pipeline-frontend}.md`.

## Szybki start (dev)

```bash
npm install && npm run build      # monorepo workspaces (apps/*, packages/*)
npm test                          # vitest (z ROOTA repo)
docker compose -f compose.dev.yaml up   # stub OpenSPG + zależności dev
npm run dev -w apps/panel-api     # API :8080
npm run dev -w apps/panel-web     # SPA :5173 (proxy na API)
```

Runbook dev/testów/diagnostyki: `.claude/skills/kag-runbook/SKILL.md`.

## Deployment

Dwa stacki compose na VPS: `deploy/edge` (Caddy+Authentik+Kuma) i `deploy/kag`
(panel, MCP, OpenSPG, Tika, Stirling). Procedura krok po kroku: `docs/deployment.md`;
smoke po wdrożeniu: `deploy/scripts/smoke.sh`. Backup nocny + weryfikacja + zimny
snapshot miesięczny: `deploy/systemd/` (alerty przez `/etc/kag/alerts.env`).

## Dokumentacja

| Dokument | Co zawiera |
|---|---|
| `docs/operator-manual.md` | pętla day-2: dodawanie treści, recenzja Inboxu, luki, klucze MCP, goldens |
| `docs/lessons-convention.md` | lekcje z sesji agentów → `kb_submit_draft` |
| `docs/runbooks/` | awarie: DR, break-glass SSO, backup, rotacja sekretów, restore 1 KB |
| `docs/authentik-setup.md` | konfiguracja SSO i forward-auth |
| `CLAUDE.md` | zasady pracy dla agentów AI w tym repo |

## Ewaluacja jakości

`npm run eval` (goldens per KB w `tools/eval/goldens/`), fixture-eval w vitest jako
bramka CI, tygodniowy raport z produkcyjnego korpusu (akcja `quality_answers`,
karta na /overview), budżetowany LLM-judge: `tools/eval/judge.mjs`.

## Licencja

Projekt prywatny (self-hosted).
