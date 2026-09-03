# Audyt UX/UI panelu PomagierKB — „BEFORE" (2026-09-03)

Metodologia: (1) pełny audyt kodu `apps/panel-web` (agent Explore — 34 pliki, 8,5k linii),
(2) sesja fotograficzna produkcji przez Playwright (login akadmin przez Authentika;
`tools/ux-audit/screenshot.mjs`): **40 zrzutów** w `ux-audit/before/` — 10 widoków ×
{1440px, 375px} × {light, dark}. Plan przebudowy: docs/design (plan sesji) — styl Linear-like,
Tailwind v4 + Radix + lucide, sidebar.

## Werdykt

Logika aplikacji: **bardzo dobra** (143 testy czystych funkcji, SSE z fallbackiem, i18n 508
kluczy, brak alert()/confirm(), poprawne focus-trapy w dialogach). Warstwa prezentacji:
**prototyp developerski** — funkcjonalna, ale bez systemu designu i wzorców profesjonalnego
SaaS. Potwierdzone wizualnie na zrzutach.

## Ustalenia krytyczne (P1 — łamią odbiór produktu)

| # | Ustalenie | Dowód |
|---|---|---|
| 1 | Brak sidebara; pozioma nav nie skaluje się, mobile bottom-nav tylko częściowo | `RootLayout.tsx`; `*--desktop--*.png` |
| 2 | Zero ikon SVG — emoji (🌙👤📭…) renderowane różnie per OS, nieskalowalne | wszystkie zrzuty |
| 3 | Brak H1 na /inbox i /ask; niespójna hierarchia nagłówków | `inbox--desktop--light.png` |
| 4 | Tabele: brak sortowania (mechanika istnieje, nieużyta), paginacja bez liczników (apiFetch wyrzuca meta), 7-9 kolumn bez wariantu mobile | `mcp--mobile--*.png` |
| 5 | Destrukcja bez właściwych potwierdzeń: dwuklik (revoke/rotate/withdraw/disable-kaskada) albo nic (resolve/ignore luk, build, nadpisanie sekretu LLM, reset breakera); zero undo | audyt kodu §17-19 |
| 6 | 4 kontrolki-atrapy: kolumna „Ocena jakości" /kb (endpoint istnieje, niepodłączony!), suwak answer.minScore, select KB na /add (tekst), martwy sort | `KbPage.tsx:210`, `SettingsPage.tsx:369`, `AddPage.tsx:228` |
| 7 | Surowy JSON jako UI admina (audyt before/after, progress akcji, metadata szkicu) | `settings-tab-system--*.png` |
| 8 | 13 tokenów CSS bez skal; 48 inline style; konflikt `.tabs` (2 definicje → /mcp i /settings bez overflow-x zakładek) | `base.css:278` vs `:309` |

## Ustalenia ważne (P2)

- Formularze: błędy zbiorczo na dole modala, bez aria-invalid (McpPage); 4 wzorce label+pole.
- /ask: wątek znika po odświeżeniu; brak stop-generowania (abortRef nieużyty); błąd historii
  połykany (`return null`); brak kopiowania odpowiedzi.
- /inbox: pułapka bulk („Zaznacz stronę" niedostępne przed 1. checkboxem), szukajka na submit,
  brak chipów filtrów, reject bez wymaganego powodu.
- A11y: brak globalnego :focus-visible, prefers-reduced-motion, skip-linka; taby bez
  tabpanel/strzałek; aria-sort na button zamiast th; UserMenu bez Esc/klik-poza.
- Brak: /overview (kokpit), 404, error boundary, document.title, breadcrumbs, ⌘K.
- PWA zadeklarowana bez service workera; ikona = tekst „KB".

Pełna lista 48 ustaleń z plikami/liniami: raport agenta w planie sesji przebudowy.

## Rzeczy dobre (zachowujemy)

Human-in-the-loop z preflightem builda (dry-run + checki), EmptyState z CTA wszędzie,
maskowanie sekretów (`configured+preview`, raw klucza raz), SafeExternalLink, deep-linki
filtrów inboxu w URL, ludzki słownik statusów, dwufazowy bulk z raportem, stany
loading/empty/error na każdej stronie, dark mode bez FOUC.

## Nota operacyjna z sesji zrzutów

Wskaźnik zdrowia pokazywał „Działa z ostrzeżeniami" — zweryfikowano: to poprawny sygnał
„otwarte luki wiedzy" (1 luka z testowego feedbacku 👎 w E2E), wszystkie komponenty 200,
breakery puste. Nie jest to defekt.

## Wynik przebudowy (AFTER — 2026-09-03)

Przebudowa ukończona i wdrożona na produkcję (obraz `kag-panel:local`, rollback:
`kag-panel:pre-v2`). Zrzuty AFTER: `ux-audit/after/` (52 szt. — ta sama macierz co BEFORE
+ `/overview`, `/settings?tab=audit`, `/settings?tab=health`).

Zamknięcie ustaleń krytycznych:

| # | Ustalenie BEFORE | Status AFTER |
|---|---|---|
| 1 | Pozioma nawigacja bez hierarchii | ✅ Sidebar 240/56px (sekcje Praca/Zasoby/System, badge pending, skrót `[`), topbar z ⌘K, mobile bottom-nav |
| 2 | Emoji zamiast ikon | ✅ lucide-react w całej aplikacji; 0 emoji-ikon |
| 3 | Brak H1/hierarchii | ✅ PageHeader na każdej stronie + `head()` document.title |
| 4 | Tabele bez sortu/liczników/mobile | ✅ DataTable v2: aria-sort, pager „x–y z N" z meta.total, mobileCard |
| 5 | Destrukcja bez potwierdzeń | ✅ Macierz: 9× AlertDialog z nazwą obiektu i konsekwencjami, reject z wymaganym powodem, toast+Undo (nowy wątek, threshold) |
| 6 | 4 kontrolki-atrapy | ✅ quality podłączone do GET /kbs/:ns/quality; minScore jawnie read-only z powodem; select KB usunięty; sort działa |
| 7 | Surowy JSON jako UI | ✅ details-list + diff audytu + CodeBlock zwijany |
| 8 | 13 tokenów bez skal, 48 inline style, konflikt .tabs | ✅ Tailwind v4 @theme (Linear-like), 0 `.btn`, base/theme.css skasowane |

Weryfikacja: 739 testów zielonych, typecheck/lint/build czyste, bundle ~212 kB gz JS
+ 9,4 kB CSS (cel <220), E2E Playwright (`tools/ux-audit/e2e.mjs`) na produkcji.

### Defekt odkryty przez E2E: `/mcp` przesłonięty przez reverse-proxy

Zrzut `after/mcp--desktop--light.png` pokazuje surowy JSON-RPC `method not allowed` —
Caddy kierował `handle /mcp*` do kag-mcp:3001, więc strona SPA `/mcp` **nigdy nie była
osiągalna na produkcji** (defekt sprzed przebudowy). Serwer MCP obsługuje wyłącznie
`POST /mcp/:profileId` (goły `/mcp` to łapacz 405) → matcher zawężony do `handle /mcp/*`
(deploy/edge/Caddyfile). **Rozwiązane**: po restarcie edge-caddy (uwaga: `caddy reload`
nie wystarczył — bind-mount pojedynczego pliku trzymał stary inode po edycji) `/mcp`
serwuje SPA, `/mcp/<profil>` nadal trafia do kag-mcp (401 bez tokenu). E2E **10/10 PASS**,
zrzuty `/mcp` w `after/` powtórzone.

### Backlog backendu (poza zakresem przebudowy)

- endpoint reopen luki (dziś ignore = nieodwracalne),
- `answer.minScore` w białej liście SETTINGS_KEYS (suwak dziś read-only),
- sort/limit jako query-params list (dziś sort kliencki per-strona),
- meta.total dla /content.
