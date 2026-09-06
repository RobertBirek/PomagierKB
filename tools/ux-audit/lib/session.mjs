// Wspólne poświadczenia i logowanie dla narzędzi UX (e2e.mjs, screenshot.mjs).
//
// ZASADA (ustalenie audytu D4-02): narzędzia testowe NIGDY nie używają konta
// superusera Authentika ani nie czytają deploy/edge/.env. Poświadczenia pochodzą
// z DEDYKOWANEGO konta E2E o możliwie najmniejszych uprawnieniach, podanego
// jawnie przez zmienne środowiskowe albo plik wskazany operatorowi.
//
// Kolejność źródeł hasła (pierwsze trafienie wygrywa):
//   1. E2E_PASSWORD              — zmienna środowiskowa,
//   2. E2E_PASSWORD_FILE         — plik z samym hasłem (0600),
//   3. E2E_ENV_FILE lub /etc/kag/e2e.env — plik KLUCZ=WARTOŚĆ (0600) z
//      E2E_USER / E2E_PASSWORD (konwencja *_FILE z apps/panel-api/src/config.ts).
// Brak hasła = twardy błąd (fail-closed). Żadnego fallbacku na akadmin.

import { readFileSync } from 'node:fs';

/** Domyślny plik poświadczeń — poza repozytorium, własność root, tryb 0600. */
export const DEFAULT_ENV_FILE = '/etc/kag/e2e.env';

/** Domyślny login konta testowego (nadpisywalny E2E_USER). */
const DEFAULT_USER = 'kag-e2e';

const SETUP_HINT = [
  'Skonfiguruj dedykowane konto E2E (NIE superusera Authentika):',
  '  1. w Authentiku załóż użytkownika (np. kag-e2e) w grupie kag-admin,',
  '     poza grupą administratorów Authentika i poza polityką MFA,',
  `  2. zapisz poświadczenia w ${DEFAULT_ENV_FILE} (chmod 600, właściciel root):`,
  '       E2E_USER=kag-e2e',
  '       E2E_PASSWORD=<hasło>',
  '  3. albo przekaż je w środowisku: E2E_USER=... E2E_PASSWORD=... node tools/ux-audit/e2e.mjs',
].join('\n');

/** Parsuje plik KLUCZ=WARTOŚĆ (bez interpolacji, komentarze '#'). */
function parseEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Blokada zbierania artefaktów Playwrighta przy realnym haśle: trace/video oraz
 * DEBUG=pw:api utrwalają wpisywane znaki, a hasło jest wpisywane po znaku
 * (pressSequentially). Fail-closed — lepiej nie uruchomić testu niż wyciec hasło.
 */
function assertNoSecretCapture() {
  const debug = process.env.DEBUG ?? '';
  const risky = [];
  if (debug.includes('pw:')) risky.push(`DEBUG=${debug}`);
  if (process.env.PWDEBUG) risky.push('PWDEBUG');
  if (process.env.PLAYWRIGHT_TRACE) risky.push('PLAYWRIGHT_TRACE');
  if (risky.length > 0) {
    throw new Error(
      `odmowa startu: ${risky.join(', ')} utrwaliłoby hasło w artefakcie Playwrighta.\n` +
        'Diagnozuj na koncie testowym z hasłem jednorazowym albo wyłącz te zmienne.',
    );
  }
}

/** Poświadczenia konta E2E; brak hasła → wyjątek z instrukcją dla operatora. */
export function loadCredentials() {
  assertNoSecretCapture();
  let user = process.env.E2E_USER ?? '';
  let pass = process.env.E2E_PASSWORD ?? '';

  const passFile = process.env.E2E_PASSWORD_FILE ?? '';
  if (pass === '' && passFile !== '') {
    try {
      pass = readFileSync(passFile, 'utf8').trim();
    } catch (err) {
      throw new Error(`nie mogę odczytać E2E_PASSWORD_FILE=${passFile}: ${err.message}\n\n${SETUP_HINT}`);
    }
  }

  const envFile = process.env.E2E_ENV_FILE ?? DEFAULT_ENV_FILE;
  if (pass === '') {
    let parsed;
    try {
      parsed = parseEnvFile(envFile);
    } catch (err) {
      throw new Error(`brak poświadczeń konta E2E (${err.code === 'ENOENT' ? 'nie ma pliku' : err.message}: ${envFile}).\n\n${SETUP_HINT}`);
    }
    user = user === '' ? (parsed.E2E_USER ?? '') : user;
    pass = parsed.E2E_PASSWORD ?? '';
  }

  if (pass === '') throw new Error(`brak hasła konta E2E.\n\n${SETUP_HINT}`);
  if (user === '') user = DEFAULT_USER;
  if (user === 'akadmin') {
    // Superuser Authentika administruje TOŻSAMOŚCIAMI (konta, flow, MFA) —
    // narzędzie testowe nie ma powodu działać z takimi uprawnieniami.
    throw new Error(
      'odmowa startu: konto akadmin to superuser Authentika, nie konto testowe.\n\n' + SETUP_HINT,
    );
  }
  return { user, pass };
}

/** Adres panelu: E2E_BASE_URL / UX_BASE_URL, domyślnie produkcja. */
export function baseUrl() {
  return (process.env.E2E_BASE_URL ?? process.env.UX_BASE_URL ?? 'https://kag.ilovelighting.sanok.pl').replace(
    /\/+$/,
    '',
  );
}

/**
 * Logowanie przez Authentika (web-componenty → locator przebija shadow DOM).
 * Po zalogowaniu potwierdza sesję zapytaniem GET /api/v1/me.
 */
export async function login(page, base, creds = loadCredentials()) {
  // /auth/login startuje OIDC server-side (SPA jest publiczne — bez redirectu HTTP).
  await page.goto(`${base}/auth/login`, { waitUntil: 'domcontentloaded' });
  // Czekamy aż opuścimy /auth/login: albo IdP (formularz), albo panel (sesja już jest).
  await page.waitForURL((url) => !url.href.includes('/auth/login'), { timeout: 20000 });
  if (!page.url().startsWith(base)) {
    const uid = page.locator('input[name="uidField"]');
    await uid.waitFor({ timeout: 20000 });
    await uid.fill(creds.user);
    await page.locator('button[type="submit"]').first().click();
    const pw = page.locator('input[name="password"]:visible').first();
    await pw.waitFor({ timeout: 20000 });
    await page.waitForTimeout(400); // hydratacja web-componentu Authentika
    await pw.click();
    await pw.pressSequentially(creds.pass, { delay: 15 });
    await pw.press('Enter');
    await page.waitForURL(`${base}/**`, { timeout: 30000 });
  }
  const me = await page.evaluate(async () => {
    const r = await fetch('/api/v1/me', { credentials: 'include' });
    return r.status;
  });
  if (me !== 200) throw new Error(`login nieudany — /api/v1/me => ${me}; url=${page.url()}`);
  return creds.user;
}
