# tools/ux-audit — E2E i zrzuty ekranu panelu

Dwa narzędzia Playwrighta działające przeciw **działającej instancji** panelu:

| plik | co robi |
|---|---|
| `e2e.mjs` | 10 klikalnych checków kluczowych ścieżek UI (exit 1 przy błędzie) |
| `screenshot.mjs` | zrzuty stron w 2 motywach × 2 viewportach (audyt UX before/after) |

Oba logują się przez Authentika modułem `lib/session.mjs`.

## Konto testowe (wymagane, fail-closed)

Narzędzia **nie czytają** `deploy/edge/.env` i **nie logują się kontem `akadmin`**
(superuser Authentika administruje tożsamościami — konto testowe nie ma powodu mieć
takich uprawnień; próba użycia `akadmin` kończy się odmową startu).

Konfiguracja po stronie operatora (jednorazowo):

1. W Authentiku załóż użytkownika `kag-e2e`:
   - grupa **`kag-admin`** (checki dotykają Ustawień i progów, które widzi tylko
     rola `admin` — mapowanie grup w `apps/panel-api/src/plugins/oidc.ts`),
   - **poza** grupą administratorów Authentika (`authentik Admins`),
   - **poza** polityką MFA (osobna grupa wyłączona ze stage'a MFA) — inaczej
     logowanie hasłem nie przejdzie.
2. Zapisz poświadczenia poza repozytorium:

   ```bash
   install -d -m 700 /etc/kag
   printf 'E2E_USER=kag-e2e\nE2E_PASSWORD=%s\n' "$(openssl rand -base64 24)" > /etc/kag/e2e.env
   chmod 600 /etc/kag/e2e.env
   ```

   i ustaw to samo hasło użytkownikowi `kag-e2e` w Authentiku.

Alternatywnie (CI, jednorazowy bieg): `E2E_USER=... E2E_PASSWORD=... node tools/ux-audit/e2e.mjs`
albo `E2E_PASSWORD_FILE=/ścieżka/do/pliku`. Kolejność źródeł: `E2E_PASSWORD` →
`E2E_PASSWORD_FILE` → `E2E_ENV_FILE` (domyślnie `/etc/kag/e2e.env`).
Brak hasła = błąd z instrukcją, **nigdy** cichy fallback na innego użytkownika.

## Uruchamianie

```bash
node tools/ux-audit/e2e.mjs                              # domyślnie produkcja
E2E_BASE_URL=https://staging.example node tools/ux-audit/e2e.mjs
node tools/ux-audit/screenshot.mjs --out docs/design/ux-audit/after --pages /kb,/mcp
```

Ścieżki `--out` liczone są od korzenia repo (nie od bieżącego katalogu).

## Zakaz zbierania artefaktów przy realnym haśle

Hasło jest wpisywane znak po znaku (`pressSequentially`), więc `DEBUG=pw:api`,
`PWDEBUG` i trace/wideo Playwrighta utrwaliłyby je w artefakcie. `lib/session.mjs`
**odmawia startu**, gdy któraś z tych zmiennych jest ustawiona. Jeśli musisz
diagnozować flaky check — użyj hasła jednorazowego i zmień je po diagnozie.

## Zakres checków a mutacje

Checki dotykają wyłącznie ścieżek odczytu i walidacji formularzy (dialog klucza MCP
jest wysyłany PUSTY, żeby zobaczyć błąd walidacji; menu wiersza KB jest tylko
otwierane). Dodając nowy check pamiętaj: narzędzie biegnie przeciw produkcji —
żadnych operacji tworzących ani archiwizujących dane.
