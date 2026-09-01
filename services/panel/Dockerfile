# syntax=docker/dockerfile:1
# Panel PomagierKB (Fastify API + statyki React/Vite w jednym obrazie).
# Kontekst budowania = KORZEŃ repo (monorepo npm workspaces):
#   docker build -f services/panel/Dockerfile -t kag-panel:local .
# (w praktyce buduje compose: deploy/kag/compose.yaml, usługa panel)
#
# Celowo BEZ instrukcji HEALTHCHECK — healthcheck definiuje compose.

# TODO: przypiąć digest przy wdrożeniu
ARG NODE_IMAGE=node:22-alpine

# --- manifests: same manifesty workspace'ów (maksymalne cache'owanie npm ci) ---
FROM ${NODE_IMAGE} AS manifests
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
# npm ci w monorepo wymaga manifestów WSZYSTKICH workspace'ów z lockfile'a
COPY apps/panel-api/package.json apps/panel-api/
COPY apps/panel-web/package.json apps/panel-web/
COPY apps/mcp-server/package.json apps/mcp-server/
COPY packages/shared/package.json packages/shared/

# --- deps: zależności PRODUKCYJNE (trafiają do runtime) ---
FROM manifests AS deps
# toolchain do kompilacji modułów natywnych (better-sqlite3) na musl
RUN apk add --no-cache python3 make g++ \
 && npm ci --omit=dev

# --- build: pełne zależności (dev) + kompilacja TS backendu ---
FROM manifests AS build
RUN apk add --no-cache python3 make g++ \
 && npm ci
COPY packages/shared packages/shared
COPY apps/panel-api apps/panel-api
# kolejność ma znaczenie: shared przed panel-api
RUN npm run build -w @pomagierkb/shared \
 && npm run build -w @pomagierkb/panel-api

# --- build-web: frontend (vite build) ---
FROM build AS build-web
COPY apps/panel-web apps/panel-web
RUN npm run build -w @pomagierkb/panel-web

# --- runtime: minimalny obraz, non-root, tylko dist + prod node_modules ---
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOME=/tmp \
    WEB_DIST=/app/apps/panel-web/dist
WORKDIR /app
# użytkownik nieuprzywilejowany — uid spójny z wolumenem /data (compose: user 10001:10001)
RUN addgroup -g 10001 app && adduser -D -H -u 10001 -G app app
# prod node_modules + package.json-y (symlinki workspace'ów zachowane)
COPY --from=deps /app /app
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/panel-api/dist apps/panel-api/dist
# statyki SPA serwuje Fastify (@fastify/static, fallback SPA) — jeden origin z API
COPY --from=build-web /app/apps/panel-web/dist apps/panel-web/dist
USER 10001:10001
EXPOSE 8080
CMD ["node", "apps/panel-api/dist/server.js"]
