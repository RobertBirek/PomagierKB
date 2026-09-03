---
name: deploy-panel
description: Wdrożenie panelu (panel-api+panel-web) na produkcję — build obrazu, tag rollback, compose up, smoke, E2E. Wywoływane WYŁĄCZNIE na wyraźne żądanie użytkownika.
disable-model-invocation: true
---

# Deploy panelu na produkcję (VPS, stack deploy/kag)

Powtarzalny flow wdrożenia zmian w apps/panel-api / apps/panel-web / packages/shared
na https://kag.ilovelighting.sanok.pl. Zawsze w tej kolejności — nie pomijaj bramek.

## 1. Bramki przed buildem (z ROOTA repo)

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

Wszystko zielone albo STOP. Niezacommitowane zmiany → najpierw commit (gitleaks w pre-commit).

## 2. Tag rollback + build obrazu

```bash
docker tag kag-panel:local kag-panel:pre-$(date +%Y%m%d-%H%M)   # rollback poprzedniej wersji
docker build -t kag-panel:local -f services/panel/Dockerfile .
```

Dockerfile: `services/panel/Dockerfile` (kontekst = root repo, monorepo workspaces).

## 3. Wdrożenie i weryfikacja

```bash
docker compose -f deploy/kag/compose.yaml up -d panel
deploy/scripts/smoke.sh
node tools/ux-audit/e2e.mjs        # 10 checków klikalnych na produkcji (login akadmin)
```

Smoke lub E2E czerwone → rollback: `docker tag kag-panel:pre-<data> kag-panel:local`
i ponowne `compose up -d panel`; dopiero potem diagnoza.

## 4. Po wdrożeniu

- `git push origin main` (jeśli nie wypchnięte).
- Opcjonalnie zrzuty kontrolne: `node tools/ux-audit/screenshot.mjs --pages /overview --out /tmp/...`.

## Pułapki

- Zmiany w `deploy/edge/Caddyfile`: bind-mount pojedynczego pliku — po edycji wymagany
  `docker restart edge-caddy` (reload przeładuje starą wersję przez podmieniony inode).
- MCP server to OSOBNY obraz (`services/mcp/Dockerfile`, serwis `mcp` w compose) — panel
  i MCP wdrażaj świadomie osobno.
- Migracje SQLite uruchamia tylko panel-api przy starcie — nie odpalaj ręcznie na produkcji.
