# Stub OpenSPG do developmentu — multi-stage, kontekst budowania = katalog główny repo:
#   docker build -f services/openspg-stub/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo
# tsc instalowany globalnie, żeby nie mieszać devDeps do runtime'owego node_modules
RUN npm install -g typescript@5.7.2
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/openspg-stub/package.json apps/openspg-stub/tsconfig.json ./apps/openspg-stub/
# instaluje tylko zależności workspace'u openspg-stub (fastify — bez natywnych
# buildów); @types/node doinstalowany bez zapisu, bo npm ci -w pomija root devDeps
RUN npm ci -w apps/openspg-stub --ignore-scripts \
 && npm i --no-save --ignore-scripts @types/node@22
COPY apps/openspg-stub/src ./apps/openspg-stub/src
RUN tsc -p apps/openspg-stub/tsconfig.json \
 && rm -rf node_modules/@types node_modules/undici-types

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/openspg-stub/dist ./dist
COPY apps/openspg-stub/package.json ./package.json
# przykładowe dokumenty do ręcznych testów pipeline'u
COPY apps/openspg-stub/src/seed ./seed
# /data: stan stubu + uploady (named volume dziedziczy właściciela z obrazu)
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8887
CMD ["node", "dist/server.js"]
