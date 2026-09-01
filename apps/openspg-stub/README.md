# openspg-stub — stub serwera OpenSPG do developmentu

Lekki serwer Fastify emulujący endpointy OpenSPG 0.8 używane przez
`packages/shared/openspg`. Pozwala rozwijać i testować panel-api / mcp-server
bez pełnego stacka (Java + MySQL + Neo4j + MinIO). Zachowuje kopertę
odpowiedzi `{success: true, result: ...}`.

**Uwaga:** kształty odpowiedzi są best-effort wg `.claude/skills/openspg-api/SKILL.md`
— stub NIE jest źródłem prawdy o prawdziwym serwerze. Integrację weryfikujemy
docelowo na żywym OpenSPG.

## Uruchomienie

```bash
# przez docker compose (z korzenia repo):
docker compose -f compose.dev.yaml up openspg-stub
# → http://127.0.0.1:8887 (publikowany tylko na localhost)

# albo lokalnie bez Dockera:
npm run build -w apps/openspg-stub
node apps/openspg-stub/dist/server.js
```

Zmienne środowiskowe:

| Zmienna | Default | Opis |
|---|---|---|
| `PORT` | `8887` | port nasłuchu |
| `STUB_JOB_MS` | `2000` | czas przejścia builder joba INIT→RUNNING→FINISH (ms) |
| `STUB_STATE_FILE` | (brak) | plik JSON z persystencją stanu (projekty/joby/chunki); brak = tylko pamięć |
| `STUB_UPLOAD_DIR` | katalog w tmp | gdzie lądują wgrane pliki CSV |

## Emulowane endpointy

- `POST /v1/accounts/login` — zwraca `Set-Cookie` (bez weryfikacji hasła)
- `GET /v1/projects/list`, `POST /v1/projects` — kolejne `projectId`, idempotencja po `namespace`
- `POST /v1/schemas?projectId=` — upsert DSL; `GET /v1/schemas/graph/:projectId` —
  `entityTypeDTOList` wyprowadzone z linii `Nazwa(...): EntityType` ostatnio scommitowanego DSL
- `GET /v1/model/list/`, `POST /v1/model` — rejestr modeli (seed: `text-embedding-3-small`);
  `api_key` nigdy nie wraca w odpowiedziach
- `POST /public/v1/reasoner/dialog/uploadFile` — multipart pole `file` → pseudo-URL MinIO
- `POST /public/v1/builder/job/submit`, `GET /public/v1/builder/job/get` — job przechodzi
  INIT→RUNNING→FINISH w `STUB_JOB_MS`; nazwa pliku zawierająca **`fail`** wymusza `ERROR`
- `GET /public/v1/builder/job/list` — **wymaga `start>=1`**; `start=0` zwraca 500
  (emulacja buga SQL prawdziwego serwera — klient ma to obsłużyć poprawnie)
- `POST /public/v1/search/text` — substring match po treści chunków z CSV
  "zbudowanych" jobem, który doszedł do FINISH
- `POST /public/v1/search/vector` — deterministyczny pseudo-losowy ranking
  (hash id chunka + wektora zapytania); ten sam wektor → ten sam wynik
- `GET /healthz` — healthcheck samego stubu (nie istnieje w prawdziwym OpenSPG)

## Użycie w testach integracyjnych

```ts
import { buildServer } from '../src/server.js';

const app = buildServer({ jobMs: 60 }); // szybkie joby w testach
const res = await app.inject({ method: 'POST', url: '/v1/projects', payload: { namespace: 'TestNs' } });
await app.close();
```

Pełny przepływ (login → projekt → schema → upload → build → search) pokrywa
`test/stub.test.ts` — uruchomienie: `npx vitest run apps/openspg-stub/test/stub.test.ts`.

## Przykładowe dokumenty (seed)

W `src/seed/` (w obrazie Dockera: `/app/seed/`) leżą 3 polskie dokumenty
markdown o tematyce oświetleniowej do ręcznych testów pipeline'u ingest:

- `karta-oprawa-led-panel.md` — karta katalogowa panelu LED,
- `poradnik-barwa-swiatla.md` — dobór temperatury barwowej i CRI,
- `notatka-ip-strefy-lazienka.md` — stopnie IP i strefy w łazience.

## Ograniczenia

- Search działa wyłącznie na chunkach z CSV zaimportowanych po `FINISH`
  (bez grafu, bez prawdziwych wektorów).
- Restart bez `STUB_STATE_FILE` czyści stan; nawet z persystencją wgrane
  pliki żyją w `STUB_UPLOAD_DIR` — w compose oba katalogi są na wolumenie
  `dev-data`, więc przeżywają restart kontenera.
- Brak autoryzacji (jak w prawdziwym OpenSPG na :8887) — dlatego publikacja
  portu wyłącznie na `127.0.0.1` i tylko w dev.
