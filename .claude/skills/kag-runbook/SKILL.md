---
name: kag-runbook
description: Jak uruchomić, przetestować i zdebugować PomagierKB — dev (stub), pełne stacki edge+kag, testy, typowe problemy. Używaj przy pracy nad uruchomieniem aplikacji, smoke testach i diagnostyce.
---

# PomagierKB — runbook deweloperski

## Dev bez pełnego OpenSPG (zalecane do pracy nad kodem)
```bash
npm install && npm run build          # build shared → apps (kolejność wymuszona w root package.json)
npm test                              # cała suita vitest (z ROOTA repo!)
docker compose -f compose.dev.yaml up # stub OpenSPG (+ odkomentuj panel/mcp gdy potrzebne)
```
Stub emuluje: login/projects/schemas/builder(FINISH po ~2s; nazwa pliku z 'fail' → ERROR)/search;
`start=0` w job/list zwraca 500 jak prawdziwy serwer. Seed: apps/openspg-stub/src/seed/.

## Pełny deployment (produkcja na tym VPS)
Kolejność: docs/deployment.md (DNS → bootstrap.sh → edge → Authentik wg docs/authentik-setup.md
→ kag → klucz LLM w Ustawieniach → pierwsza baza). Smoke po każdym deployu:
`deploy/scripts/smoke.sh` (env: SMOKE_MCP_KEY, SMOKE_STAGING_NS; SMOKE_INSECURE=1 przy staging CA).

## Testy punktowe
```bash
npx vitest run apps/panel-api/test/e2e-smoke.test.ts   # E2E panelu (OIDC mock, spawn joba, SSE)
npx vitest run apps/mcp-server/test/                   # MCP (kontrakt tools/list==profil)
npm run typecheck && npm run lint
```

## Diagnostyka (OpenSPG nie ma portów na hoście!)
```bash
docker compose -f deploy/kag/compose.yaml ps           # healthchecki
docker exec release-openspg-server curl -s http://127.0.0.1:8887/ -o /dev/null -w '%{http_code}\n'
docker run --rm --network kag_kag-internal curlimages/curl -s http://release-openspg-server:8887/
docker logs kag-panel --since 10m | grep -v healthz
deploy/scripts/drift_check.sh                          # compose vs runtime
```
Logi akcji pipeline: /srv/kag-data/kag/panel/actions/<rok>/<mies>/<actionId>.log
(albo GET /api/v1/actions/:id z logTail). Audyt: GET /api/v1/audit (admin).

## Typowe problemy
- Panel 503 auth_not_configured → brak env OIDC (fail-closed, celowe): sprawdź deploy/kag/.env.
- Authentik leży = nikt się nie zaloguje → docs/runbooks/break-glass-authentik.md.
- Builder job wisi w RUNNING → docs/runbooks/typowe-awarie.md (reuse-active pomija po 45 min).
- Testy z katalogu workspace nie znajdują plików → uruchamiaj vitest Z ROOTA repo.
- Po zmianie packages/shared: `npm run build -w packages/shared` (apps importują z dist!).
- gitleaks blokuje commit na zmyślonym sekrecie testowym → dopisz `// gitleaks:allow` w linii.
- Pułapki OpenSPG (start=1, refId, cookie login) → skill openspg-api.

## Eval retrievalu (goldens)
```bash
DATA_DIR=/srv/kag-data/kag/panel npm run eval             # goldens.jsonl w katalogu bieżącym
npm run eval -- tools/eval/goldens.example.jsonl          # wskazany plik
EVAL_MIN_HIT5=0.8 npm run eval                            # bramka progowa (exit 1 poniżej)
```
Buduj goldens przyrostowo przy ingestach (w tym pytania NEGATYWNE spoza bazy).

## Weryfikacja UI na produkcji (tools/ux-audit)
```bash
node tools/ux-audit/e2e.mjs                                # 10 checków E2E (login akadmin z deploy/edge/.env)
node tools/ux-audit/screenshot.mjs --pages /kb,/overview --out /tmp/shots   # zrzuty: 2 viewporty × light/dark
```
Ścieżki w --pages Z wiodącym ukośnikiem (skrypt normalizuje, ale nie polegaj na tym).
Zrzuty referencyjne przebudowy: docs/design/ux-audit/{before,after}/ + raport ux-audit.md.

## Pułapka: deploy/edge/Caddyfile (bind-mount pojedynczego pliku)
Edycja pliku podmienia inode, a mount w kontenerze trzyma stary → `docker exec edge-caddy
caddy reload` przeładuje STARĄ wersję. Po każdej edycji Caddyfile: `docker restart edge-caddy`
(sekundy przerwy na wszystkich vhostach), potem `curl -s -o /dev/null -w '%{http_code}'
https://kag.ilovelighting.sanok.pl/mcp` (oczekiwane 200 = SPA, nie 405 JSON-RPC).
