# syntax=docker/dockerfile:1
# Serwer MCP PomagierKB (Streamable HTTP, stateless).
# Kontekst budowania = KORZEŃ repo (monorepo npm workspaces):
#   docker build -f services/mcp/Dockerfile -t kag-mcp:local .
# (w praktyce buduje compose: deploy/kag/compose.yaml, usługa mcp)
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

# --- build: pełne zależności (dev) + kompilacja TS ---
FROM manifests AS build
RUN apk add --no-cache python3 make g++ \
 && npm ci
COPY packages/shared packages/shared
COPY apps/mcp-server apps/mcp-server
# kolejność ma znaczenie: shared przed mcp-server
RUN npm run build -w @pomagierkb/shared \
 && npm run build -w @pomagierkb/mcp-server

# --- runtime: minimalny obraz, non-root, tylko dist + prod node_modules ---
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOME=/tmp
WORKDIR /app
# użytkownik nieuprzywilejowany — uid spójny z wolumenem /data (compose: user 10001:10001)
RUN addgroup -g 10001 app && adduser -D -H -u 10001 -G app app
# prod node_modules + package.json-y (symlinki workspace'ów zachowane)
COPY --from=deps /app /app
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/mcp-server/dist apps/mcp-server/dist
USER 10001:10001
EXPOSE 3001
CMD ["node", "apps/mcp-server/dist/server.js"]
