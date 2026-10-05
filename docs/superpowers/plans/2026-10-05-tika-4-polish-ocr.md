# Tika 3.3.1 → 4.1.0 z polskim OCR — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 5 zmienia produkcję (`compose up`) — wymaga zgody właściciela.

**Goal:** Ekstrakcja dokumentów działa na Apache Tika 4.1.0 (bez krytycznego `CVE-2026-49875` w `cxf-core`), a Tika rozpoznaje polski tekst w obrazach i skanach (Tesseract `pol+eng`).

**Architecture:** Tika przestaje być gołym obrazem producenta: budujemy własny, cienki obraz `kag-tika:local` = minimalny `apache/tika:4.1.0` + Tesseract z pakietem `pol` + wbudowany `tika-config.json`. Kod pipeline'u rozpoznaje format odpowiedzi po `content-type`, więc działa i z Tiką 3 (XHTML), i z Tiką 4 (Markdown) — wdrożenie i powrót nie wymagają synchronizacji z deployem panelu.

**Tech Stack:** Apache Tika Server 4.1.0 (Java 25, parsowanie w procesach potomnych tika-pipes), Tesseract 5.5 (`tesseract-ocr-pol`), docker compose (`deploy/kag/compose.yaml`), TypeScript (`apps/panel-api/src/pipeline/extract.ts`), vitest z roota.

**Spec:** brak osobnego dokumentu — źródła: `https://tika.apache.org/docs/4.1.x/migration-to-4x/migrating-tika-server-4x.html`, `…/configuration/parsers/tesseract-ocr-parser.html`, `…/using-tika/docker.html`, `CHANGES.txt` (sekcje 4.0.0 i 4.1.0) oraz pomiary z laboratorium poniżej.

## Założenie co do „dodaj język polski"

Rozumiem to jako **polski OCR w Tice** (pakiet językowy Tesseracta). Interfejs panelu i OCR skanów PDF w Stirlingu (`languages: 'pol'`) są po polsku już dziś. Detekcja języka w Tice 4 (CharSoup) nie wymaga konfiguracji i nie jest używana przez pipeline.

Uczciwie o zasięgu: dziś panel nie przyjmuje samodzielnych obrazów (`UPLOAD_EXTENSIONS` nie zawiera `png/jpg/tiff`), więc polski OCR w Tice zadziała w dwóch miejscach: (1) obrazy osadzone w `docx/pptx/html`, (2) skan PDF, gdy zawiedzie kaskada Stirlinga (Tika jest ostatnim krokiem). Przyjmowanie samych zdjęć/skanów jako plików to osobna decyzja — patrz „Decyzje dla właściciela".

## Wyniki laboratorium (2026-10-05, sieć `--internal`, ograniczenia kontenera jak na produkcji)

Trzy kontenery obok siebie: obecny `apache/tika@sha256:90b7fa1d…` (3.3.1), minimalny `apache/tika@sha256:06bcdbd0…` (4.1.0, tag `4.1.0-1`) i obraz laboratoryjny (4.1.0 + `tesseract-ocr`, `-pol`, `-eng` + config). Te same pliki: `docx` i `html` z polskimi znakami, nagłówkami i tabelą, PDF z warstwą tekstu, skan PDF bez warstwy tekstu, PNG.

| Sprawdzenie | 3.3.1 | 4.1.0 minimalny | 4.1.0 + pol |
|---|---|---|---|
| `GET /tika` (sonda statusu panelu) | 200 | 200 | 200 |
| healthcheck `bash … /dev/tcp/127.0.0.1/9998` | działa | działa | działa |
| `PUT /tika` — `content-type` odpowiedzi | `text/xml` (XHTML) | `text/plain` (Markdown) | `text/plain` (Markdown) |
| `docx`: nagłówki i tabela | giną w `stripXhtml` (sam tekst, dużo pustych linii, śmieć `&#0;`) | `# …`, `## …`, tabela `\|Kod\|Znaczenie\|` | jak obok |
| skan PNG | pusto | pusto | pełny tekst z `ą ę ł ó ś ż ź` bez błędów, 0,9 s |
| skan PDF | tylko „Page 1" | 11 B | pełny tekst, 1,6 s (jedna litera z małej zamiast wielkiej) |
| PDF z tekstem | tekst | tekst, 0,4 s | tekst, 0,4 s (OCR się NIE włącza) |
| pamięć po rozgrzaniu / PID-y | 204 MB / 41 | 406 MB / 39 | 431 MB / 40 |
| pierwsze żądanie po starcie | 0,6 s | 4,5 s (rozruch procesu potomnego) | 4,4 s |
| Trivy CRITICAL / HIGH | 1 / 38 | — | **0 / 0** |
| rozmiar obrazu | 585 MB | 636 MB | 787 MB (wariant `-full`: 2,02 GB) |

Trzy wnioski, które kształtują plan:

1. **Bez zmiany kodu podbicie cicho gubi treść.** Tika 4 zwraca Markdown, w którym `<` to `\<`. Obecny `stripXhtml` potraktował `\<strefa zwrotów\>` jak znacznik i wyciął — w wyniku zostało `ZW-01 \ .`. Do tego Markdown ucieka podkreślenia: `dok_Status` wyszłoby jako `dok\_Status` i przestało trafiać w wyszukiwanie po dokładnym tokenie.
2. **Konfiguracja wymaga elementu `server`** — bez niego serwer nie startuje (`TikaConfigException: Couldn't find 'server' element`). Nagłówki `X-Tika-OCR*` z 3.x są w 4.x ignorowane; język OCR ustawia się wyłącznie w `tika-config.json`.
3. **Wariant `-full` jest zbędny**: nie zawiera polskiego, a dokłada GDAL, ffmpeg i ImageMagick do kontenera parsującego niezaufane pliki. Minimalny obraz + trzy pakiety apt daje to samo przy 0 CRITICAL / 0 HIGH.

## Global Constraints

- Obraz bazowy przypięty digestem: `apache/tika@sha256:06bcdbd09aca073293e5a171ad161418cc93c91d58d9e4e205064eade84889d4` (tagi `4.1.0` i `4.1.0-1` wskazują ten sam digest).
- Kontener Tiki zachowuje obecne bezpieczniki: `cap_drop: ALL`, `no-new-privileges`, `pids_limit: 512`, `cpus: 2`, `mem_limit` 1536m, tylko sieć `kag-internal`, użytkownik 35002.
- Zmienna `TIKA_IMAGE` w `.env` zostaje pod tą samą nazwą i znaczy odtąd „obraz BAZOWY" — dzięki temu `update_check.sh`, Renovate i `supply-chain-scan.yml` działają bez zmian. `deploy/kag/.env` edytuje właściciel (agentowi edycja jest blokowana).
- `kag-tika:local` NIE trafia do `OWN_IMAGE_RE` w `cve_scan.sh`: to obraz producenta plus pakiety systemowe, twarda bramka „0 nowych" dotyczy tylko naszego kodu (`kag-panel`, `kag-mcp`).
- Czysta logika (normalizacja Markdownu) w pliku bez frameworka, z testami vitest; testy uruchamiane z roota: `npx vitest run apps/panel-api/test/pipeline-ingest-extract.test.ts`.
- Teksty UI wyłącznie przez `apps/panel-web/src/i18n/pl.ts` (ten plan nie zmienia UI).
- Commity po angielsku (conventional), zakończone `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; gitleaks musi przejść.

## Review Focus

1. **Identyfikator z podkreśleniem w dokumencie Office** (`dok_Status`, `tw_Pole1`) → po ekstrakcji ma być dosłownie `dok_Status`, bez `\`. Test w Task 1.
2. **Tekst w nawiasach ostrych** (`<strefa zwrotów>`, `<NIP>`) → ma przetrwać w całości. Test w Task 1.
3. **Tabela z pionową kreską w komórce** → `\|` w komórce ma zostać ucieczką, inaczej tabela Markdown się rozpada. Test w Task 1.
4. **Powrót na Tikę 3 po wdrożeniu kodu** → odpowiedź `text/xml` nadal przechodzi przez `stripXhtml`. Test w Task 2.
5. **Duży skan PDF w kroku awaryjnym** → OCR w Tice trwa dłużej niż 30 s limitu wywołania; oczekiwane: `null` i uczciwy błąd `extraction_below_quality_threshold`, nie zawieszenie kolejki. Test w Task 2 (timeout) + limit `totalTaskTimeoutMillis` w konfiguracji (Task 3).

---

### Task 1: Normalizacja Markdownu z Tiki 4 (czysta funkcja)

**Files:**
- Modify: `apps/panel-api/src/pipeline/extract.ts` (nowa funkcja pod `stripXhtml`, ok. linii 125)
- Test: `apps/panel-api/test/pipeline-ingest-extract.test.ts`

**Interfaces:**
- Produces: `export function normalizeTikaMarkdown(md: string): string` — zdejmuje ucieczki Markdownu z interpunkcji ASCII (poza `\|`), usuwa `\u0000`, zwija nadmiarowe spacje i puste linie.

- [ ] **Step 1: Napisz testy, które nie przechodzą**

Dopisz `normalizeTikaMarkdown` do importu z `'../src/pipeline/extract.js'` i dodaj na końcu pliku:

```ts
describe('normalizeTikaMarkdown (wyjście Tiki 4)', () => {
  it('zdejmuje ucieczki z identyfikatorów i nawiasów ostrych', () => {
    const md = 'Pole dok\\_Status i tw\\_Pole1; półka ZW-01 \\<strefa zwrotów\\>. Koszt: 5 \\< 10 oraz a\\*b\\*c \\& d.';
    expect(normalizeTikaMarkdown(md)).toBe(
      'Pole dok_Status i tw_Pole1; półka ZW-01 <strefa zwrotów>. Koszt: 5 < 10 oraz a*b*c & d.',
    );
  });

  it('zachowuje nagłówki i tabele, a ucieczkę kreski w komórce zostawia', () => {
    const md = '# Procedura\n\n## Statusy\n\n|Kod|Znaczenie|\n|---|---|\n|6|otwarte \\| bez rezerwacji|\n';
    expect(normalizeTikaMarkdown(md)).toBe(
      '# Procedura\n\n## Statusy\n\n|Kod|Znaczenie|\n|---|---|\n|6|otwarte \\| bez rezerwacji|',
    );
  });

  it('nie rusza odwrotnego ukośnika przed literą ani cyfrą (ścieżki Windows)', () => {
    expect(normalizeTikaMarkdown('C:\\Program Files\\InsERT\\2026')).toBe('C:\\Program Files\\InsERT\\2026');
  });

  it('usuwa bajty zerowe i zwija puste linie oraz końcowe spacje', () => {
    expect(normalizeTikaMarkdown('Instrukcja  \n\n\n\n# Montaż\u0000 żyrandola   \n')).toBe('Instrukcja\n\n# Montaż żyrandola');
  });
});
```

- [ ] **Step 2: Uruchom — ma nie przejść**

Run: `npx vitest run apps/panel-api/test/pipeline-ingest-extract.test.ts`
Expected: FAIL — `normalizeTikaMarkdown is not a function` (albo błąd importu).

- [ ] **Step 3: Implementacja**

W `apps/panel-api/src/pipeline/extract.ts`, bezpośrednio pod funkcją `stripXhtml`:

```ts
/**
 * Tika 4 zwraca Markdown z ucieczkami interpunkcji (`dok\_Status`, `\<tekst\>`, `a\*b`).
 * Do bazy wiedzy idzie tekst DOSŁOWNY — inaczej identyfikatory z podkreśleniem przestają
 * trafiać w wyszukiwanie po tokenie. Zostaje wyłącznie `\|` (kreska w komórce tabeli):
 * bez ucieczki tabela Markdown się rozpada. Odwrotny ukośnik przed literą/cyfrą nie jest
 * ucieczką Markdownu (ścieżki Windows) i zostaje nietknięty.
 */
export function normalizeTikaMarkdown(md: string): string {
  return md
    .replace(/\u0000/g, '')
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{}~])/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
```

- [ ] **Step 4: Uruchom — ma przejść**

Run: `npx vitest run apps/panel-api/test/pipeline-ingest-extract.test.ts`
Expected: PASS, wszystkie testy pliku zielone.

- [ ] **Step 5: Commit**

```bash
git add apps/panel-api/src/pipeline/extract.ts apps/panel-api/test/pipeline-ingest-extract.test.ts
git commit -m "feat(pipeline): normalize Tika 4 markdown output (literal identifiers, tables kept)"
```

---

### Task 2: `tikaExtract` rozpoznaje format odpowiedzi po `content-type`

**Files:**
- Modify: `apps/panel-api/src/pipeline/extract.ts` (funkcja `tikaExtract`, ok. linii 232–248; komentarz nagłówkowy pliku, linie 3–6)
- Test: `apps/panel-api/test/pipeline-ingest-extract.test.ts`

**Interfaces:**
- Consumes: `normalizeTikaMarkdown(md: string): string` z Task 1, istniejące `stripXhtml(xhtml: string): string`.
- Produces: bez zmiany sygnatury — `tikaExtract(deps, buffer, mime): Promise<string | null>`; XHTML (`text/xml`, `application/xhtml+xml`, `text/html`) → `stripXhtml`, wszystko inne → `normalizeTikaMarkdown`.

- [ ] **Step 1: Napisz testy, które nie przechodzą**

```ts
describe('Tika — format odpowiedzi zależny od wersji serwera', () => {
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const BODY_MD =
    '# Procedura zwrotu towaru\n\nKlient zgłasza zwrot w ciągu 14 dni; pole dok\\_Status przyjmuje wartość 8, ' +
    'a magazyn odkłada lampę na półkę ZW-01 \\<strefa zwrotów\\>. Zażółć gęślą jaźń.\n\n|Kod|Znaczenie|\n|---|---|\n|8|zrealizowane|\n';
  const BODY_XHTML =
    '<html><body><h1>Procedura zwrotu towaru</h1><p>Klient zgłasza zwrot w ciągu 14 dni; pole dok_Status przyjmuje ' +
    'wartość 8, a magazyn odkłada lampę na półkę ZW-01 &lt;strefa zwrotów&gt;. Zażółć gęślą jaźń.</p></body></html>';

  it('Tika 4 (text/plain, Markdown): identyfikatory dosłowne, nagłówek i tabela zachowane', async () => {
    const fetchImpl = (async () =>
      new Response(BODY_MD, { status: 200, headers: { 'content-type': 'text/plain;charset=utf-8' } })) as typeof fetch;
    const res = await extractContent({ buffer: Buffer.from('x'), mime: DOCX }, deps(fetchImpl));
    expect(res.provider).toBe('tika');
    expect(res.text).toContain('dok_Status');
    expect(res.text).toContain('<strefa zwrotów>');
    expect(res.text).toContain('# Procedura zwrotu towaru');
    expect(res.text).toContain('|8|zrealizowane|');
    expect(res.text).not.toContain('\\_');
  });

  it('Tika 3 (text/xml, XHTML): dotychczasowa ścieżka stripXhtml bez zmian', async () => {
    const fetchImpl = (async () =>
      new Response(BODY_XHTML, { status: 200, headers: { 'content-type': 'text/xml' } })) as typeof fetch;
    const res = await extractContent({ buffer: Buffer.from('x'), mime: DOCX }, deps(fetchImpl));
    expect(res.text).toContain('dok_Status');
    expect(res.text).toContain('<strefa zwrotów>');
    expect(res.text).not.toContain('<h1>');
  });

  it('503 z Tiki 4 (padł proces potomny) jest ponawiane, a przekroczony limit czasu daje uczciwy błąd', async () => {
    let calls = 0;
    const flaky = (async () => {
      calls++;
      return calls === 1
        ? new Response('{"status":"OOM","message":"worker restarted"}', { status: 503 })
        : new Response(BODY_MD, { status: 200, headers: { 'content-type': 'text/plain;charset=utf-8' } });
    }) as typeof fetch;
    const ok = await extractContent({ buffer: Buffer.from('x'), mime: DOCX }, deps(flaky));
    expect(calls).toBe(2);
    expect(ok.text).toContain('dok_Status');

    const hanging = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;
    await expect(
      extractContent({ buffer: Buffer.from('x'), mime: DOCX }, deps(hanging, { timeoutMs: 20 })),
    ).rejects.toBeInstanceOf(ExtractError);
  });
});
```

Uwaga dla wykonawcy: `timeoutMs` to istniejące pole `ExtractDeps`. `withRetry` robi domyślnie 3 próby z bazą 500 ms, więc ten test trwa ok. 2 s (ponowienie po 503 i trzy przekroczenia limitu) — to oczekiwane, nie zawieszenie.

- [ ] **Step 2: Uruchom — ma nie przejść**

Run: `npx vitest run apps/panel-api/test/pipeline-ingest-extract.test.ts`
Expected: FAIL w teście „Tika 4": wynik zawiera `dok\_Status`, a `<strefa zwrotów>` jest wycięte.

- [ ] **Step 3: Implementacja**

W `tikaExtract` zamień linię `return stripXhtml(await res.text());` na:

```ts
      // Tika 3 odpowiada XHTML (text/xml), Tika 4 — Markdownem (text/plain). Rozpoznanie po
      // content-type sprawia, że ten sam kod działa przed podbiciem, po nim i po powrocie.
      const body = await res.text();
      const type = (res.headers.get('content-type') ?? '').toLowerCase();
      return /xml|html/.test(type) ? stripXhtml(body) : normalizeTikaMarkdown(body);
```

W komentarzu nagłówkowym pliku zamień `html/docx/xlsx/pptx — Tika (strip XHTML).` na `html/docx/xlsx/pptx — Tika (4.x: Markdown po normalizacji; 3.x: strip XHTML).`

- [ ] **Step 4: Uruchom — ma przejść, potem całość**

Run: `npx vitest run apps/panel-api/test/pipeline-ingest-extract.test.ts && npm run typecheck && npm run lint && npm test`
Expected: PASS; lint 0 błędów; pełny zestaw zielony.

- [ ] **Step 5: Commit**

```bash
git add apps/panel-api/src/pipeline/extract.ts apps/panel-api/test/pipeline-ingest-extract.test.ts
git commit -m "feat(pipeline): Tika response handled by content type (XHTML from 3.x, markdown from 4.x)"
```

---

### Task 3: Własny obraz `kag-tika` — Tika 4.1.0 + Tesseract `pol`

**Files:**
- Create: `services/tika/Dockerfile`
- Create: `services/tika/tika-config.json`
- Modify: `deploy/kag/compose.yaml` (usługa `tika`, ok. linii 255–274)
- Modify: `deploy/kag/.env.example` (linie 29–33)
- Modify: `.github/workflows/ci.yml` (macierz `image-build`, linie 119–124)
- Modify: `renovate.json` (drugi `customManager` — opis i wzorzec)

**Interfaces:**
- Consumes: zmienna `TIKA_IMAGE` z `.env` (odtąd obraz bazowy z digestem).
- Produces: obraz `kag-tika:local` nasłuchujący na 9998, z konfiguracją pod `/etc/tika/tika-config.json`; endpointy `tika`, `rmeta`, `status`.

- [ ] **Step 1: Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# Tika PomagierKB = minimalny obraz producenta + Tesseract z językiem polskim + nasza konfiguracja.
# Celowo NIE wariant `-full` (2 GB: GDAL, ffmpeg, ImageMagick; bez polskiego) — ten kontener
# parsuje NIEZAUFANE uploady, więc dokładamy tylko to, czego używamy.
# Kontekst budowania = KORZEŃ repo (jak panel i mcp — tak buduje compose i job image-build w CI):
#   docker build -f services/tika/Dockerfile -t kag-tika:local .
# Obraz bazowy podaje compose z TIKA_IMAGE (.env, pin digestem); wartość domyślna = ten sam pin.
ARG TIKA_BASE_IMAGE=apache/tika@sha256:06bcdbd09aca073293e5a171ad161418cc93c91d58d9e4e205064eade84889d4
# ^ 4.1.0 (tag 4.1.0-1), pin 2026-10-05
FROM ${TIKA_BASE_IMAGE}
ARG TIKA_BASE_IMAGE
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-pol tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/*
COPY --chmod=0444 services/tika/tika-config.json /etc/tika/tika-config.json
# Tożsamość wydania (D12-14) — te same etykiety co kag-panel/kag-mcp; CI sprawdza revision i pin bazy.
ARG GIT_SHA=unknown
ARG BUILT_AT=unknown
ARG SOURCE_URL=https://github.com/RobertBirek/PomagierKB
LABEL org.opencontainers.image.title="kag-tika" \
      org.opencontainers.image.description="PomagierKB — Apache Tika 4 + Tesseract (pol, eng)" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILT_AT}" \
      org.opencontainers.image.base.name="${TIKA_BASE_IMAGE}"
USER 35002:35002
CMD ["-c", "/etc/tika/tika-config.json"]
```

- [ ] **Step 2: Konfiguracja**

`services/tika/tika-config.json`:

```json
{
  "server": {
    "port": 9998,
    "endpoints": ["tika", "rmeta", "status"]
  },
  "engines": {
    "tesseract": {
      "tesseract-ocr-parser": {
        "language": "pol+eng",
        "timeoutMillis": 120000
      }
    }
  },
  "text-recognizers": [{ "engine": "tesseract" }],
  "pipes": { "numClients": 2 },
  "parse-context": {
    "timeout-limits": {
      "totalTaskTimeoutMillis": 300000,
      "progressTimeoutMillis": 60000
    }
  }
}
```

Uzasadnienie wartości: `numClients: 2` = tyle, ile `MAX_PARALLEL_OCR` w pipeline i `cpus: 2` kontenera; `totalTaskTimeoutMillis` 5 min = domyślne zachowanie 3.x (4.x ma domyślnie godzinę); endpointy `/pipes` i `/async` oraz konfiguracja per żądanie pozostają wyłączone (brak `allowPipes`, `allowPerRequestConfig`).

- [ ] **Step 3: Compose**

W `deploy/kag/compose.yaml` w usłudze `tika` zamień linię `    image: ${TIKA_IMAGE:?TIKA_IMAGE is required}` na:

```yaml
    image: kag-tika:local
    build:
      context: ../..
      dockerfile: services/tika/Dockerfile
      args:
        # obraz BAZOWY producenta (pin digestem w .env); nasz obraz dokłada Tesseract `pol` i config
        TIKA_BASE_IMAGE: ${TIKA_IMAGE:?TIKA_IMAGE is required}
        GIT_SHA: ${GIT_SHA:-unknown}
        BUILT_AT: ${BUILT_AT:-unknown}
```

i zamień komentarz healthchecka `# obraz nie ma curl/wget — test TCP przez basha` na `# obraz nie ma curl/wget — test TCP przez basha (sprawdzone także dla 4.1.0)`.

- [ ] **Step 4: `.env.example`, CI, Renovate**

`deploy/kag/.env.example` — zamień linie 29–33 na:

```bash
# Obraz BAZOWY Tiki (minimalny, bez -full). Nasz obraz kag-tika:local buduje się z niego
# (services/tika/Dockerfile: + Tesseract pol/eng + tika-config.json). Po zmianie digestu:
#   docker compose -f deploy/kag/compose.yaml build tika && docker compose ... up -d tika
TIKA_IMAGE=apache/tika@sha256:06bcdbd09aca073293e5a171ad161418cc93c91d58d9e4e205064eade84889d4   # 4.1.0 (tag 4.1.0-1), pin 2026-10-05
# apache/tika NIE publikuje tagu linii (są tylko dokładne wersje + `latest`) — jako CHECK_TAG
# podajemy dokładny tag pinu: update_check pilnuje, że tag nie został podmieniony pod tym
# samym numerem. Zmiana linii (4.1 → 4.2) = plan jak docs/superpowers/plans/2026-10-05-tika-4-polish-ocr.md.
TIKA_IMAGE_CHECK_TAG=4.1.0-1
```

`.github/workflows/ci.yml` — w macierzy joba `image-build` (kontekst budowania to korzeń repo, a krok „Weryfikacja etykiet OCI" wymaga etykiet `revision` i `base.name` z digestem — Dockerfile z Step 1 je ustawia) dopisz po wpisie `mcp`:

```yaml
          - name: tika
            dockerfile: services/tika/Dockerfile
```

`renovate.json` — w drugim `customManager` dopisz do `matchStrings` wzorzec dla dyrektywy `syntax` (już jest) i nic więcej: pin obrazu bazowego Tiki Renovate widzi przez pierwszy manager (`deploy/*/.env.example`, zmienna `TIKA_IMAGE` + `TIKA_IMAGE_CHECK_TAG`). Zmień tylko `description` drugiego managera: po słowach `w services/*/Dockerfile` dopisz ` (services/tika/Dockerfile bierze obraz bazowy z TIKA_IMAGE — śledzi go manager .env.example)`.

- [ ] **Step 5: Zbuduj i sprawdź obraz lokalnie (bez dotykania produkcji)**

```bash
cd /kag && docker build -q -f services/tika/Dockerfile -t kag-tika:candidate .
docker run --rm --entrypoint sh kag-tika:candidate -c 'tesseract --list-langs; id -u; ls -l /etc/tika/tika-config.json'
docker network create --internal tika-check
docker run -d --name tika-check --network tika-check --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 512 --memory 1536m --cpus 2 kag-tika:candidate
for i in $(seq 1 30); do docker exec tika-check bash -c 'exec 3<>/dev/tcp/127.0.0.1/9998' 2>/dev/null && break; sleep 3; done
printf '<html><body><h1>Test</h1><p>pole dok_Status &lt;strefa&gt; Zażółć gęślą jaźń</p></body></html>' > /tmp/tika-check.html
docker run --rm --network tika-check -v /tmp/tika-check.html:/t.html:ro --entrypoint sh curlimages/curl:latest -c \
  'curl -s -o /dev/null -w "GET %{http_code}\n" http://tika-check:9998/tika; curl -s -w "\nPUT %{http_code} %{content_type}\n" -X PUT -H "content-type: text/html" --data-binary @/t.html http://tika-check:9998/tika; curl -s http://tika-check:9998/status'
docker logs tika-check 2>&1 | grep -ciE "exception|can.t start"
docker rm -f tika-check && docker network rm tika-check && rm /tmp/tika-check.html
```
Expected: języki `eng`, `osd`, `pol`; uid `35002`; `GET 200`; `PUT 200 text/plain;charset=utf-8` z treścią `# Test` i `dok\_Status \<strefa\>`; `/status` z `"status" : "OPERATING"`; licznik wyjątków `0`.

- [ ] **Step 6: Skan obrazu — założenie o CVE sprawdzone PRZED wdrożeniem**

```bash
sudo /kag/deploy/scripts/cve_scan.sh --image kag-tika:candidate | grep razem
sudo /kag/deploy/scripts/cve_scan.sh | grep razem     # odtwarza pełne summary.json po skanie pojedynczego obrazu
```
Expected: pierwsza linia `CRITICAL=0, HIGH=0` (pomiar laboratoryjny z 2026-10-05; jeśli wyjdzie więcej — wypisz pozycje i zdecyduj z właścicielem, czy wdrażać). Druga: `nowych względem baseline: 0`.

- [ ] **Step 7: Walidacja compose i commit**

Run: `docker compose -f deploy/kag/compose.yaml config -q && npm run lint`
Expected: kod 0 (compose czyta jeszcze starą wartość `TIKA_IMAGE` z `.env` — to poprawne do Task 5).

```bash
git add services/tika deploy/kag/compose.yaml deploy/kag/.env.example .github/workflows/ci.yml renovate.json
git commit -m "feat(tika): own image on Tika 4.1.0 with Polish Tesseract OCR and JSON config"
```

---

### Task 4: Test ekstrakcji na prawdziwych plikach przeciw kandydatowi

**Files:**
- Create: `tools/eval/tika-extract-check.mjs`
- Create: `tools/eval/fixtures/tika/sample.docx`, `sample.html`, `skan.png`, `skan.pdf` (pliki z laboratorium — treść syntetyczna, bez danych firmy)

**Interfaces:**
- Consumes: adres Tiki w argumencie (`--url http://host:9998`), funkcje `stripXhtml` i `normalizeTikaMarkdown` z `apps/panel-api/dist/pipeline/extract.js` (po `npm run build`).
- Produces: tabela per plik (status, `content-type`, długość, czy zawiera oczekiwane frazy); kod wyjścia 0 tylko gdy wszystkie frazy trafione.

- [ ] **Step 1: Odtwórz pliki testowe**

Pliki powstały 2026-10-05 w katalogu roboczym sesji i nie są w repo. Odtwórz je tą samą metodą: `sample.docx` i `sample.html` skryptem Pythona z `zipfile` (nagłówek „Procedura zwrotu towaru — oświetlenie", akapit z `dok_Status` i `<strefa zwrotów>`, tabela Kod/Znaczenie), a skany offline z obrazu Stirlinga:

```bash
F=/kag/tools/eval/fixtures/tika && mkdir -p $F && cd $F
printf 'PROTOKÓŁ REKLAMACJI\n\nZażółć gęślą jaźń. Żyrandol sześcioramienny został uszkodzony\nw transporcie. Klient żąda wymiany na nowy egzemplarz.\nŁączna wartość zamówienia: 1 249,00 zł. Źródło: zgłoszenie nr 4471.\n' > scan.txt
chmod a+rwx . && docker run --rm --network none --entrypoint sh -v $F:/w "$(docker inspect -f '{{.Config.Image}}' kag-stirling)" -c \
  'cd /w && soffice --headless --convert-to pdf scan.txt >/dev/null 2>&1 && pdftoppm -r 200 -png scan.pdf p && mv p-1.png skan.png && soffice --headless --convert-to pdf skan.png >/dev/null 2>&1 && rm scan.txt scan.pdf && chmod a+r *'
ls -la $F
```
Expected: `skan.png` (kilkadziesiąt kB) i `skan.pdf` (bez warstwy tekstu) obok `sample.docx` i `sample.html`.

- [ ] **Step 2: Skrypt sprawdzający**

```js
#!/usr/bin/env node
// tika-extract-check.mjs — wysyła pliki testowe do wskazanej Tiki i sprawdza, czy po
// obróbce pipeline'u (stripXhtml / normalizeTikaMarkdown) zostają oczekiwane frazy.
// Użycie: node tools/eval/tika-extract-check.mjs --url http://<ip-kontenera>:9998
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripXhtml, normalizeTikaMarkdown } from '../../apps/panel-api/dist/pipeline/extract.js';

const i = process.argv.indexOf('--url');
const url = i >= 0 ? process.argv[i + 1] : null;
if (!url) { console.error('użycie: tika-extract-check.mjs --url http://host:9998'); process.exit(2); }
const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tika');
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const CASES = [
  { file: 'sample.docx', mime: DOCX, must: ['Procedura zwrotu towaru', 'dok_Status', '<strefa zwrotów>', 'zrealizowane'] },
  { file: 'sample.html', mime: 'text/html', must: ['Montaż żyrandola', 'Zażółć gęślą jaźń', 'E27'] },
  { file: 'skan.png', mime: 'image/png', must: ['PROTOKÓŁ REKLAMACJI', 'sześcioramienny', 'zgłoszenie nr 4471'], ocr: true },
  { file: 'skan.pdf', mime: 'application/pdf', must: ['PROTOKÓŁ REKLAMACJI', 'Żyrandol', '1 249,00 zł'], ocr: true },
];
let failed = 0;
for (const c of CASES) {
  const t0 = Date.now();
  const res = await fetch(`${url.replace(/\/+$/, '')}/tika`, { method: 'PUT', headers: { 'content-type': c.mime }, body: readFileSync(join(dir, c.file)) });
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  const body = await res.text();
  const text = /xml|html/.test(type) ? stripXhtml(body) : normalizeTikaMarkdown(body);
  const missing = c.must.filter((m) => !text.includes(m));
  if (res.status !== 200 || missing.length > 0) failed++;
  console.log(`${missing.length === 0 && res.status === 200 ? 'OK  ' : 'FAIL'} ${c.file.padEnd(12)} HTTP ${res.status} ${type.padEnd(26)} ${String(text.length).padStart(5)} zn ${Date.now() - t0} ms${c.ocr ? ' (OCR)' : ''}${missing.length ? '  brak: ' + missing.join(' | ') : ''}`);
}
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 3: Uruchom przeciw kandydatowi, a dla kontrastu przeciw obecnej produkcji**

```bash
cd /kag && npm run build -w packages/shared && npm run build -w apps/panel-api
docker network create tika-check && docker run -d --name tika-check --network tika-check --cap-drop ALL --security-opt no-new-privileges:true --memory 1536m --cpus 2 kag-tika:candidate
sleep 15; node tools/eval/tika-extract-check.mjs --url "http://$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' tika-check):9998"; echo "kandydat exit=$?"
docker rm -f tika-check && docker network rm tika-check
node tools/eval/tika-extract-check.mjs --url "http://$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' kag-tika):9998"; echo "produkcja 3.3.1 exit=$?"
```
Expected: kandydat — cztery linie `OK`, `exit=0`. Produkcja 3.3.1 — `OK` dla `docx` i `html`, `FAIL` dla obu skanów (brak OCR), `exit=1`: to dowód, że test odróżnia stan przed i po. (Sieć testowa nie jest tu `--internal`, bo skrypt łączy się z hosta; kontener nie publikuje żadnego portu.)

- [ ] **Step 4: Commit**

```bash
git add tools/eval/tika-extract-check.mjs tools/eval/fixtures/tika
git commit -m "test(eval): Tika extraction check on real files (docx, html, scanned png/pdf)"
```

---

### Task 5: Wdrożenie na produkcji

**Files:**
- Modify: `deploy/kag/.env` (poza git — dwie linie, wykonuje właściciel)

Kolejność jest bezpieczna w obie strony, bo kod z Task 2 obsługuje oba formaty: najpierw panel (nowy kod, stara Tika), potem Tika.

- [ ] **Step 1: Stan wyjściowy i backup**

```bash
cd /kag && bash .claude/skills/kag-daily-ops/scripts/status.sh | sed -n '/failed/p;/## kontenery/,/## backup/p' | cut -c1-120
deploy/scripts/smoke.sh | tail -2 && node tools/ux-audit/e2e.mjs | tail -1
```
Expected: `failed: 0`, `wszystkie healthy`, smoke `FAIL=0`, E2E `10/10 PASS`. Tika jest bezstanowa — osobny backup nie jest potrzebny; wystarczy dzisiejszy nocny.

- [ ] **Step 2: Panel z nowym kodem**

```bash
cd /kag/deploy/kag && GIT_SHA=$(git -C /kag rev-parse --short HEAD) BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) docker compose build panel && docker compose up -d panel
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' kag-panel)" = healthy ] && break; sleep 5; done; /kag/deploy/scripts/smoke.sh | tail -2
```
Expected: `healthy`, smoke `FAIL=0`. Ekstrakcja nadal idzie przez Tikę 3 (ścieżka XHTML).

- [ ] **Step 3: Pin obrazu bazowego w `.env`** (właściciel)

```bash
sudo sed -i -E 's|^TIKA_IMAGE=.*|TIKA_IMAGE=apache/tika@sha256:06bcdbd09aca073293e5a171ad161418cc93c91d58d9e4e205064eade84889d4   # 4.1.0 (tag 4.1.0-1), pin '"$(date +%F)"'|; s|^TIKA_IMAGE_CHECK_TAG=.*|TIKA_IMAGE_CHECK_TAG=4.1.0-1|' /kag/deploy/kag/.env
docker compose -f /kag/deploy/kag/compose.yaml config | grep -c '06bcdbd09aca'
```
Expected: `1` (argument budowania usługi `tika`).

- [ ] **Step 4: Budowa i podmiana Tiki**

```bash
cd /kag/deploy/kag && GIT_SHA=$(git -C /kag rev-parse --short HEAD) BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) docker compose build tika && docker compose up -d tika
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' kag-tika)" = healthy ] && break; sleep 5; done
docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep kag-tika; docker logs kag-tika 2>&1 | grep -ciE "exception|can.t start"
```
Expected: `kag-tika kag-tika:local Up … (healthy)`, licznik `0`.

- [ ] **Step 5: Weryfikacja**

```bash
cd /kag && node tools/eval/tika-extract-check.mjs --url "http://$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' kag-tika):9998"; echo "exit=$?"
deploy/scripts/smoke.sh | tail -2 && node tools/ux-audit/e2e.mjs | tail -1
docker stats --no-stream --format '{{.Name}} {{.MemUsage}} pids={{.PIDs}}' kag-tika
```
Expected: cztery `OK`, `exit=0`; smoke `FAIL=0`; E2E `10/10 PASS`; pamięć < 800 MiB z limitu 1,5 GiB. W panelu → Ustawienia → Stan: „Apache Tika (ekstrakcja)" zielona.

- [ ] **Step 6: Próba końcowa przez panel** (właściciel albo agent z kontem operatora)

Wgraj `tools/eval/fixtures/tika/sample.docx` w panelu (Dodaj → plik) do bazy `StagingSmoke`. Oczekiwane w szkicu w Inboxie: nagłówek `# Procedura zwrotu towaru — oświetlenie`, tabela statusów, dosłowne `dok_Status` i `<strefa zwrotów>`. Po obejrzeniu szkic ODRZUĆ (nie promuj — to treść testowa).

**Powrót:** `git -C /kag checkout <commit sprzed Task 3> -- deploy/kag/compose.yaml`, w `.env` przywróć `TIKA_IMAGE=apache/tika@sha256:90b7fa1dc018434075fce9e1d9b88b1e3d0ea6979d0cf86e116c79a8073ae973` i `TIKA_IMAGE_CHECK_TAG=3.3.1.0`, `docker compose -f /kag/deploy/kag/compose.yaml up -d tika`. Kodu panelu nie trzeba cofać. Obraz 3.3.1 jest w archiwum `save_images.sh`.

---

### Task 6: Domknięcie — CVE, dokumentacja, backup obrazów

**Files:**
- Modify: `docs/design/infra.md` (linie z `TIKA_IMAGE=apache/tika@sha256:90b7…`, tabela usług — wiersz `tika`, lista plików `deploy/kag/compose.yaml`)
- Modify: `docs/design/pipeline-frontend.md` (opis Etapu 2 — rola Tiki)
- Modify: `docs/runbooks/typowe-awarie.md:218` (wiersz `kag-tika`)
- Modify: `docs/deployment.md` (sekcja aktualizacji obrazów — akapit o Tice)
- Modify: `docs/design/PLAN.md` (sekcja „Zmiany decyzji po zatwierdzeniu" — APPEND)
- Modify: `docs/ops/cve-baseline-log.md` (nowy wiersz)
- Modify: `CLAUDE.md` (sekcja Komendy — jedna linia)

- [ ] **Step 1: Pełny skan i baza odniesienia**

```bash
sudo /kag/deploy/scripts/cve_scan.sh | grep -E "razem|BŁĄD"
python3 -c "import json;s=json.load(open('/srv/kag-data/security/cve/summary.json'));print(s['scanErrors'],[(k.split('@')[0][-24:],v['count'],v.get('critical')) for k,v in s['new']['newByImage'].items()],[(v['name'],v['critical'],v['high']) for v in s['perImage'].values() if 'tika' in v['name']])"
```
Expected: `scanErrors 0`; `kag-tika:local` jako nowy obraz z `critical: []`; obraz `apache/tika@sha256:90b7…` zniknął ze skanu. Dopisz wiersz do `docs/ops/cve-baseline-log.md` (data, raport, „Tika 3.3.1.0 → własny `kag-tika:local` na 4.1.0: 1 CRITICAL / 38 HIGH → <zmierzone>; `CVE-2026-49875` usunięty — zweryfikowane skanem kandydata PRZED wdrożeniem"), potem:

```bash
sudo /kag/deploy/scripts/cve_scan.sh --update-baseline | grep baseline && sudo /kag/deploy/scripts/cve_scan.sh | grep razem
```
Expected: `nowych względem baseline: 0`.

- [ ] **Step 2: Archiwum obrazów offline**

Run: `sudo /kag/deploy/scripts/save_images.sh | tail -3`
Expected: `gotowe`; w `/srv/kag-data/backups/images` jest plik dla `kag-tika` (odtworzenie po awarii nie może wymagać `apt-get` z internetu).

- [ ] **Step 3: Dokumentacja**

- `docs/design/infra.md`: przykład `.env` → `TIKA_IMAGE=apache/tika@sha256:06bcdbd0…   # 4.1.0, obraz BAZOWY`; w tabeli usług wiersz `tika` → obraz `kag-tika:local` (build `services/tika`), healthcheck bez zmian; w liście plików dopisz `services/tika/{Dockerfile,tika-config.json}`.
- `docs/design/pipeline-frontend.md`, Etap 2: dopisz zdanie „Tika 4.1.0 zwraca Markdown (nagłówki i tabele dokumentów Office zachowane; `normalizeTikaMarkdown` zdejmuje ucieczki) i rozpoznaje polski tekst w obrazach osadzonych oraz skanach (Tesseract `pol+eng`); kod rozróżnia Tikę 3/4 po `content-type`."
- `docs/runbooks/typowe-awarie.md:218`: „kag-tika | mem_limit 1.5g (pomiar 4.1.0: ~430 MiB po rozgrzaniu; parsowanie w procesach potomnych — pad jednego pliku kończy się 503 i restartem procesu potomnego, nie kontenera); pierwsze żądanie po starcie trwa ~5 s; powtarzalne 503 = podejrzany pojedynczy plik — odrzuć go z Inboxa".
- `docs/deployment.md`: w procedurze aktualizacji dopisz „Tika: `TIKA_IMAGE` to obraz bazowy — po zmianie digestu `docker compose build tika && docker compose up -d tika`, potem `node tools/eval/tika-extract-check.mjs --url …` (cztery `OK`)."
- `docs/design/PLAN.md`, na końcu tabeli zmian decyzji: „| <data> | Tika jako obraz producenta (`apache/tika:3.x`, wyjście XHTML) | **Własny obraz `kag-tika:local`: Tika 4.1.0 + Tesseract `pol+eng` + `tika-config.json`**; wyjście Markdown | 3.3.1 miał krytyczny `CVE-2026-49875`; 4.x zmienia domyślny format i przenosi konfigurację OCR do JSON; wariant `-full` (2 GB, bez polskiego) odrzucony | `services/tika/`, `apps/panel-api/src/pipeline/extract.ts` (`normalizeTikaMarkdown`), `tools/eval/tika-extract-check.mjs`, `docs/ops/cve-baseline-log.md` |".
- `CLAUDE.md`, sekcja Komendy: `node tools/eval/tika-extract-check.mjs --url http://<ip kag-tika>:9998   # ekstrakcja docx/html/skan PNG/PDF przez żywą Tikę (po każdej zmianie obrazu Tiki)`.

Run: `grep -rn "3\.3\.1\|90b7fa1dc018" deploy docs/design/infra.md docs/deployment.md docs/runbooks | grep -v cve-baseline-log`
Expected: brak wyników.

- [ ] **Step 4: Commit, PR, merge**

```bash
git add docs CLAUDE.md
git commit -m "docs(tika): Tika 4.1.0 with Polish OCR — design, runbooks, decision log, CVE baseline entry"
git push -u origin feat/tika-4-polish-ocr
gh pr create --base main --title "feat: Tika 4.1.0 with Polish OCR (own kag-tika image, markdown output)" --body "Plan: docs/superpowers/plans/2026-10-05-tika-4-polish-ocr.md"
```
Po zielonym CI (w tym nowy job `image-build (tika…)`) — merge do `main`, usunięcie gałęzi.

---

## Decyzje dla właściciela

1. **Zakres „języka polskiego".** Plan dostarcza polski OCR w Tice. Jeśli chodziło o coś innego (np. przyjmowanie zdjęć i skanów `png/jpg/tiff` jako plików w panelu) — to osobne, małe zadanie: lista rozszerzeń w `apps/panel-api/src/services/intakes.ts` i `apps/panel-web/src/lib/intake.ts`, teksty w `pl.ts`, test kaskady dla `image/*`. Rekomendacja: zrobić je zaraz po tym planie, bo dopiero wtedy polski OCR w Tice będzie widoczny dla użytkowników na co dzień.
2. **Ponowna ekstrakcja istniejących dokumentów Office.** Nowe wgrania `docx/xlsx/pptx` zyskają nagłówki i tabele; dokumenty już w bazach zostają w starej, płaskiej postaci. Re-import nie jest częścią planu — do decyzji po obejrzeniu pierwszych szkiców.
3. **Kto wykonuje Task 5 Step 3** — dwie linie w `deploy/kag/.env` (agent nie ma tam zapisu).

## Dziennik wykonania

(uzupełniany w trakcie: data, wyniki `tika-extract-check`, liczby ze skanu, odstępstwa od planu)
