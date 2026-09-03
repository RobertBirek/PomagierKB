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

## Następne kroki

Wg planu przebudowy: Faza 1 fundament (Tailwind v4 + tokeny + mostek + apiFetchWithMeta) →
Faza 2 kit+shell → Faza 3 strony + /overview → Faza 4 E2E + zrzuty „AFTER" (ta sama macierz,
`ux-audit/after/`) → Faza 5 deploy.
