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

## 2. Snapshot, tag rollback + build obrazu

```bash
sudo systemctl start kag-backup.service          # świeży snapshot PRZED zmianą
TAG="pre-$(date +%Y%m%d-%H%M)"
docker tag kag-panel:local "kag-panel:${TAG}"    # rollback poprzedniej wersji
echo "${TAG}" | sudo tee /srv/kag-data/kag/last-rollback-tag
git rev-parse --short HEAD                       # zanotuj commit — obraz :local nie ma etykiety revision
docker build -t kag-panel:local -f services/panel/Dockerfile .
```

Dockerfile: `services/panel/Dockerfile` (kontekst = root repo, monorepo workspaces).
Wzorzec tagu `pre-<RRRRMMDD>-<GGMM>` jest wiążący — historyczne tagi na hoście
(`pre-v2`, `pre-brain-20260903`, `pre-mcp2026`) powstały ad hoc, nie powielaj ich.

## 3. Wdrożenie i weryfikacja

```bash
docker compose -f deploy/kag/compose.yaml up -d panel
deploy/scripts/smoke.sh
node tools/ux-audit/e2e.mjs        # 10 checków klikalnych na produkcji (login akadmin)
```

Smoke lub E2E czerwone → rollback:
`docker tag "kag-panel:$(cat /srv/kag-data/kag/last-rollback-tag)" kag-panel:local`
i ponowne `compose up -d panel`; dopiero potem diagnoza.

**Granica rollbacku — migracje SQLite są forward-only** i uruchamia je panel-api przy
starcie. Bezpieczny jest powrót o JEDNĄ wersję (migracje muszą być addytywne
i kompatybilne wstecz o jedno wydanie); głębszy powrót wymaga odtworzenia pliku SQLite
ze snapshotu. Pełny opis zasady: `docs/deployment.md` §12.1.

## 3b. Deploy serwera MCP (osobny obraz — ta sama procedura)

```bash
TAG="pre-$(date +%Y%m%d-%H%M)"
docker tag kag-mcp:local "kag-mcp:${TAG}"
docker build -t kag-mcp:local -f services/mcp/Dockerfile .
docker compose -f deploy/kag/compose.yaml up -d mcp
deploy/scripts/smoke.sh            # sprawdza initialize + tools/list (wymaga SMOKE_MCP_KEY)
```

**Kolejność przy wspólnej zmianie schematu:** migracje uruchamia panel-api, a mcp-server
odmawia startu przy rozjeździe wersji — wdrażaj i restartuj **panel PRZED mcp**.
Rollback MCP analogicznie: `docker tag "kag-mcp:${TAG}" kag-mcp:local && compose up -d mcp`.

## 4. Po wdrożeniu

- `git push origin main` (jeśli nie wypchnięte).
- Opcjonalnie zrzuty kontrolne: `node tools/ux-audit/screenshot.mjs --pages /overview --out /tmp/...`.

## Pułapki

- Zmiany w `deploy/edge/Caddyfile`: bind-mount pojedynczego pliku — po edycji wymagany
  `docker restart edge-caddy` (reload przeładuje starą wersję przez podmieniony inode).
- MCP server to OSOBNY obraz (`services/mcp/Dockerfile`, serwis `mcp` w compose) — panel
  i MCP wdrażaj świadomie osobno.
- Migracje SQLite uruchamia tylko panel-api przy starcie — nie odpalaj ręcznie na produkcji.
