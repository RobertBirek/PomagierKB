# Runbook: nowa baza wiedzy z importem masowym (narzędzia `tools/kb-import`, `tools/mssql-introspect`)

Pierwsze użycie: **SubiektKB** (2026-09-09) — dokumentacja InsERT GT 1.89 HF1 z publicznego folderu
Google Drive (PDF, CHM, ZIP) + katalog żywej bazy MSSQL. Ten runbook opisuje powtarzalny tor;
decyzja projektowa (host, nie kontener) jest w `docs/design/PLAN.md` § „Zmiany decyzji" (2026-09-09).

## 0. Zasady, które ten tor respektuje

- **Nic nie omija pipeline'u.** Fragmenty trafiają przez `POST /api/v1/content` jako JSON
  `{text,title,sourceUrl}` → clean → analyze → **szkic w Inboxie** → promocja → build. Człowiek
  (operator) zatwierdza masowo po kontroli wyrywkowej; nic nie pisze do grafu bezpośrednio.
- **Konwersja na hoście, nie w panelu.** Panel nie zna `.chm`/`.zip`, ma limit 100 000 znaków po
  czyszczeniu i okno analyze 12 000 znaków. Narzędzie dzieli treść na fragmenty ≤80 000 znaków,
  każdy z nagłówkiem H1, streszczeniem i słowami kluczowymi na górze.
- **`sourceUrl` unikalny per fragment** (`…#dokumentacja/<slug>/<część>`). Reguła precedencji
  eksportu (`exporter.ts:applyPrecedence`) zostawia jeden dokument per `source_ref` — bez tego
  „część 2/7" wycofałaby „część 1/7". Ten sam `sourceUrl` przy re-imporcie = nowa wersja zastępuje
  starą przy najbliższym buildzie.
- **Słowo „dokumentacja" w `sourceUrl`** przełącza profil czyszczenia na `docs`
  (`cleanProfiles.ts:pickProfile`); inne URL-e dostają profil `news`, który kasuje więcej linii.
- **Żywe bazy tylko z hosta.** Kontenery są celowo odcięte od tunelu (`deploy/scripts/wg_guard.sh`,
  `docs/runbooks/wireguard.md`). `tools/mssql-introspect` czyta wyłącznie `sys.*`/`INFORMATION_SCHEMA`
  (test `queries-readonly.test.mjs`). Poświadczenie: `/etc/kag/mssql-optima.env` (0600, poza repo).
- **Konto importu**: `kag-e2e` z `/etc/kag/e2e.env` (grupa kag-admin) — to samo co `tools/ux-audit`.
  Sesja OIDC przez Playwright; żądania z kontekstu strony (CSRF Origin). Limity: 60 mutacji/min
  (narzędzie trzyma 50), intake 2 równolegle, 10 min/dokument.

## 1. Przygotowanie hosta

```bash
apt-get install -y p7zip-full                      # CHM → HTML (7z x)
umask 077; cat > /etc/kag/mssql-optima.env <<'EOF' # tylko gdy jest źródło MSSQL
MSSQL_HOST=10.10.254.87
MSSQL_PORT=49604            # port DYNAMICZNY instancji nazwanej — po restarcie SQL Servera sprawdź
MSSQL_USER=...
MSSQL_PASSWORD=...
MSSQL_DATABASE=master
EOF
DATA_DIR=/srv/kag-data/kag/panel npm run eval      # BASELINE przed importem (nowa KB zmienia negatywy/routing)
```

Podsieć bazy musi być w `AllowedIPs` peera w `/etc/wireguard/wg0.conf` (nie tylko w runtime `wg set`),
inaczej restart `wg-quick` zabija trasę — patrz `wireguard.md` § „Podsieć MSSQL".

## 2. Baza w rejestrze + limity na czas importu

```bash
node tools/kb-import/create-kb.mjs --spec tools/kb-import/specs/subiektkb.json --draft-limits 800
```

Spec: `namespace` (`^[A-Z][A-Za-z0-9]{2,29}$`), `name`, `description`, `documentTypes` (≤20 —
kategorie, które `prepare*.mjs` przypisuje fragmentom), `routingKeywords` (≤20 — bez nich analyze
kieruje treść do bazy domyślnej), `piiPolicy`. `--draft-limits` podnosi `drafts.limits`
(domyślnie 100/dzień, 25/zgłaszającego) — **po imporcie przywróć**:

```bash
node -e "import('/kag/tools/kb-import/lib/client.mjs').then(async ({PanelClient})=>{const c=await new PanelClient().open();console.log((await c.put('/api/v1/settings/drafts.limits',{value:{perDay:100,perSubmitterPerDay:25}})).status);await c.close();})"
```

## 3. Pobranie i konwersja

```bash
E=/srv/kag-data/import/subiektkb
node tools/kb-import/fetch-drive.mjs <folderId> --out $E/raw --exclude '^Pomoc/(gta|infogt|insertgt)/'
node tools/kb-import/prepare.mjs --raw $E/raw --ext $E/ext --out $E/out/docs
# źródło MSSQL (opcjonalnie):
node tools/mssql-introspect/list-dbs.mjs                     # lista baz + odcisk produktu (InsERT GT / Optima)
node tools/mssql-introspect/dump-schema.mjs <baza> --out $E/out/schema-live
node tools/kb-import/prepare-db.mjs --live $E/out/schema-live/catalog.json \
  --docs $E/ext/dbdoc/Dokumentacja_DB.xml --sql $E/ext/sql \
  --changes $E/ext/dbchanges/Dokumentacja_zmian_DB.xml --out $E/out/db
```

`prepare.mjs` klasyfikuje pliki regułami w `lib/sources.mjs` (tytuł, kategoria, produkt, słowa
kluczowe, streszczenie); plik bez reguły jest raportowany jako pominięty — dopisz regułę. CHM:
rozdziały spisu treści (`.hhc`) + strony spoza spisu (≥300 zn.) jako „pozostałe strony". PDF:
pdfjs (tekstowe), podział po nagłówkach; skany są raportowane w `skipped` — wyślij je
`node tools/kb-import/upload-file.mjs --file <pdf> --state out/scans/state.json` (OCR robi pipeline). ZIP z przykładami:
kuracja plików tekstowych (`curateArchiveFile`), binaria/arkusze pominięte.

`prepare-db.mjs` scala: żywy katalog (typy, klucze, indeksy, liczności) + opisy tabel/kolumn z
`Dokumentacja_DB.xml` + definicje widoków/funkcji/procedur ze skryptów producenta (żywe obiekty są
`WITH ENCRYPTION`) → `.md` per moduł (prefiks tabeli), `99-roznice-dokumentacja-vs-baza.md`,
`98-zmiany-bazy-danych.md`. Kolumny renderowane jako listy (chunker rozcina tabele markdown).

Źródło WWW — e-Pomoc techniczna InsERT (~5 900 publicznych artykułów FAQ dla linii GT):

```bash
node tools/kb-import/fetch-epomoc.mjs --out $E/epomoc --programs 1,2,3,4,5,6,7,8 --delay-ms 700   # ~1,5 h, wznawialne
node tools/kb-import/prepare-epomoc.mjs --in $E/epomoc --out $E/out/epomoc                          # grupy program × kategoria
```

Crawler chodzi po listach `?program=<id>&offset=<strona>` (27/strona), 1 żądanie na `--delay-ms`, z User-Agentem
z kontaktem; `robots.txt` serwisu blokuje tylko wyszukiwarkę. Typ dokumentu `FAQ e-Pomoc` musi być w `documentTypes` KB.

Źródło WWW — forum.insert.com.pl (sekcje GT, ~8 600 wątków; treść społeczności):

```bash
node tools/kb-import/fetch-forum.mjs --out $E/forum --delay-ms 600 --max-topic-pages 4   # kilka godzin, wznawialne
node tools/kb-import/prepare-forum.mjs --in $E/forum --out $E/out/forum                  # grupy sekcja × rok
```

Zapisywana jest rola autora (InsERT / użytkownik), nie nazwisko; cytaty usuwane; wątki bez odpowiedzi pomijane;
limity długości wątku w nagłówku `prepare-forum.mjs`. Typ dokumentu `forum użytkowników`.

Słowniki `sl_*` i ograniczenia CHECK z żywej bazy (wartości, bez kolumn osobowych — bramki w
`tools/mssql-introspect/src/queries-data.mjs`):

```bash
node tools/mssql-introspect/dump-dictionaries.mjs <baza> --out $E/out/schema-live
node tools/kb-import/prepare-dicts.mjs --dicts $E/out/schema-live/dictionaries.json --docs $E/ext/dbdoc/Dokumentacja_DB.xml --out $E/out/dicts
```

Sprawdź `out/*/manifest.json` (liczba plików, znaki, `skipped`). Orientacja: 1 000 znaków ≈ 0,6 chunka.

## 4. Upload → kontrola → promocja → build (partiami, 3-4 buildy łącznie)

```bash
node tools/kb-import/upload.mjs --dir $E/out/docs --only '^(?!insertgt-|gta-|infogt-)'   # partia 1
# kontrola wyrywkowa ≥10 % szkiców w /inbox (namespace, kategoria, polskie znaki, sens streszczenia)
node tools/kb-import/promote.mjs --dir $E/out/docs --namespace SubiektKB --dry-run          # raport
node tools/kb-import/promote.mjs --dir $E/out/docs --namespace SubiektKB                    # apply
node tools/kb-import/build.mjs --namespace SubiektKB                                        # build + quality gate
```

`upload.mjs` pisze `state.json` (fragment → intakeId → draftId; wznawialne po sha256-dedup serwera,
NIE po `Idempotency-Key`, który jest mapą w pamięci). `promote.mjs` idzie po draftId ze `state.json`
(nie po namespace — źle zaroutowane szkice by umknęły), poprawia `namespace`/`documentCategory`
PATCH-em, promuje przez `POST /drafts/bulk` (dry-run → apply, ≤50 id) i zapisuje `promoted.json`.
Odrzucone po kontroli: `--exclude plik-z-draftId`. Build to pełny eksport promowanych szkiców
(~700 chunków/min na tym VPS); quality gate ma dać OK/WARN, nigdy FAIL.

## 4b. Odświeżanie źródeł WWW (SubiektKB)

`deploy/scripts/refresh_subiektkb.sh` + `deploy/systemd/kag-subiektkb-refresh.{service,timer}` (3. dzień
miesiąca, 01:30): crawl e-Pomocy i forum (tylko nowe), konwersja, upload (fragment bez zmian = pomijany po
sha z `state.json`; zmieniony = nowy szkic pod tym samym `sourceUrl`), promocja, build gdy `dirty=1`.
Limity draftów podnoszone na czas biegu i przywracane w `trap`. Awaria → `kag-alert@`.

## 5. Po imporcie

1. `tools/eval/goldens/<Namespace>.jsonl` — ≥25 pytań, ≥30 % negatywów, `DOC_`+`mustContain`
   (id chunków zmieniają się przy re-imporcie); `npm run eval` i `EVAL_CHANNELS=full` vs baseline.
2. Przywróć `drafts.limits` (§2). MCP: profile z `namespaces_json=NULL` widzą nową bazę same.
3. `node tools/ux-audit/e2e.mjs`, `deploy/scripts/smoke.sh`.
4. Wpis w `docs/data-governance.md` §1.2 dla nowego źródła; jeśli baza zawiera dane osobowe —
   §5 (DPIA) i decyzja o widoczności per użytkownik (PLAN.md 2026-09-07).

## 6. Pułapki (znalezione przy SubiektKB)

| Objaw | Przyczyna | Co robić |
|---|---|---|
| `Login failed for user` mimo otwartego portu | inna interpretacja poświadczeń (login SQL vs nazwa bazy) | `list-dbs.mjs` z `MSSQL_ENV_FILE`; nigdy nie zgaduj haseł w argv |
| linie `owner:`/`license:` w treści szkicu | front-matter był czytany PO cleanerze, który kasuje `---` | naprawione i wdrożone 2026-09-09 (`intake-worker.ts` czyta i zdejmuje blok PRZED czyszczeniem); `prepare*.mjs` i tak podaje proweniencję zdaniem we wstępie |
| build pada „heap out of memory" w fazie quality | (a) sterta potomka ~256 MB przy `PANEL_MEM_LIMIT` 512m; (b) `parseCsv` sklejał pola znak po znaku (cons-stringi) | `JOB_NODE_MAX_OLD_SPACE_MB=1024`, `PANEL_MEM_LIMIT=1536m`, parser na wycinkach (wdrożone 2026-09-09) |
| quality gate FAIL `no_literal_newlines` na widokach SQL | samotny CR w definicjach ze skryptów producenta | `graphText` spłaszcza też CR (wdrożone); `stripScriptWrapper` normalizuje CR |
| skan PDF: szkic z samych `<image redacted>` albo `extraction_below_quality_threshold` | (a) znaczniki obrazów liczyły się jako tekst → OCR nie startował; (b) ocrmypdf odmawia przy szczątkowej warstwie tekstu; (c) OCR trwał dłużej niż 30 s | wdrożone 2026-09-09: próg mierzony bez znaczników, `ocrType=force-ocr`, osobny timeout OCR 5 min. Skany wysyłaj `upload-file.mjs` (multipart), nie przez `prepare.mjs` |
| `EVAL_CHANNELS=full`: negativeAccuracy < 0.9 | duży korpus podnosi maksimum kosinusa pytań spoza bazy; próg 0.70 celowo bez zmian | pomiar `tools/eval/gate-calibration.mjs`, wynik w `baseline.json → remeasured`; bramka CI to tryb fts |
| ponowny upload zwraca stary (odrzucony) szkic | `Idempotency-Key` z samego `sourceUrl` | klucz = sha256 treści (naprawione w `upload.mjs`) |
| 6 000 plików w folderze Drive | rozpakowane kopie CHM w podfolderach | `--exclude` + `.chm` z `Pomoc/` |
| `.hhc` z „krzakami" | encje HTML nazywają kody Latin-1, które są bajtami cp1250 | `decodeCp1250WithEntities` (encje → bajty → cp1250) |
| strony CHM w UTF-16 | BOM `FF FE` | `decodeHtmlFile` czyta BOM przed `<meta charset>` |
| 2 700 mini-rozdziałów z jednego CHM | plan schodził do liści | `planChapters` grupuje rodzeństwo („Absencja – Gratyfikant") |
| definicje widoków/procedur puste | obiekty `WITH ENCRYPTION` w żywej bazie | definicje ze `Skrypty_SQL_*.zip` (`attachDefinitions`) |
| `payload_too_large` | fragment >100 000 zn. po czyszczeniu | `packSections`/`splitLargeSection` tnie do 80 000 |
