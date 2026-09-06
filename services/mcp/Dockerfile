# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# Serwer MCP PomagierKB (Streamable HTTP, stateless).
# Kontekst budowania = KORZEŃ repo (monorepo npm workspaces):
#   docker build -f services/mcp/Dockerfile -t kag-mcp:local .
# (w praktyce buduje compose: deploy/kag/compose.yaml, usługa mcp)
#
# Celowo BEZ instrukcji HEALTHCHECK — healthcheck definiuje compose.
#
# ODTWARZALNOŚĆ (D1-06/D11-05): frontend BuildKit ORAZ obraz bazowy są przypięte digestem.
# Digesty zweryfikowane 2026-09-06 przez:
#   skopeo inspect --raw docker://docker.io/library/node:22-alpine | sha256sum
#   skopeo inspect --raw docker://docker.io/docker/dockerfile:1    | sha256sum
# (alternatywnie: docker buildx imagetools inspect <ref> — pole Digest indeksu).
# AKTUALIZACJA: podnieś digest w OBU plikach services/*/Dockerfile jednocześnie,
# przebuduj obrazy i uruchom deploy/scripts/smoke.sh. Renovate podnosi to automatycznie
# (customManager "docker: obraz bazowy Node w services/*/Dockerfile" w renovate.json).
ARG NODE_IMAGE=node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
# ^ node 22.23.2 / Alpine 3.24.1, pin 2026-09-06

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
# + redukcja powierzchni ataku: runtime uruchamia WYŁĄCZNIE `node` (CMD), a globalne
#   npm/npx/corepack wnoszą własne zależności z CVE (tar, pacote, sigstore, brace-expansion
#   — 11 z 13 podatności HIGH/CRITICAL obrazu pochodziło z /usr/local/lib/node_modules/npm).
RUN addgroup -g 10001 app && adduser -D -H -u 10001 -G app app \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg
# prod node_modules + package.json-y (symlinki workspace'ów zachowane)
COPY --from=deps /app /app
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/mcp-server/dist apps/mcp-server/dist

# --- tożsamość wydania (D12-14) ---
# Świadomie NA KOŃCU stage'u: zmiana GIT_SHA unieważnia tylko te dwie warstwy, nie cały build.
# Wartości wstrzykuje builder: compose (build.args) albo CI (--build-arg). Brak argumentu =
# "unknown" — to sygnał, że obraz zbudowano poza zdefiniowaną procedurą.
ARG NODE_IMAGE
ARG GIT_SHA=unknown
ARG BUILT_AT=unknown
ARG SOURCE_URL=https://github.com/RobertBirek/PomagierKB
LABEL org.opencontainers.image.title="kag-mcp" \
      org.opencontainers.image.description="PomagierKB — serwer MCP (Streamable HTTP, stateless)" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILT_AT}" \
      org.opencontainers.image.base.name="${NODE_IMAGE}"
# te same dane odczytywalne z żywego procesu (GET /healthz → blok release)
ENV APP_GIT_SHA=${GIT_SHA} \
    APP_BUILT_AT=${BUILT_AT}

USER 10001:10001
EXPOSE 3001
CMD ["node", "apps/mcp-server/dist/server.js"]
