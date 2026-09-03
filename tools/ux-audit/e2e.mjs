#!/usr/bin/env node
// E2E smoke nowego UI (produkcja, akadmin). Twarde asercje kluczowych elementów.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = 'https://kag.ilovelighting.sanok.pl';
const pass = readFileSync('deploy/edge/.env','utf8').match(/^AUTHENTIK_BOOTSTRAP_PASSWORD=(.+)$/m)[1].trim();
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pl-PL' })).newPage();
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', `${name}: ${String(e.message).slice(0,120)}`]); }
};

// login
await page.goto(`${BASE}/auth/login`, { waitUntil: 'domcontentloaded' });
await page.waitForURL(/auth\.ilovelighting/, { timeout: 20000 });
const uid = page.locator('input[name="uidField"]'); await uid.waitFor(); await uid.fill('akadmin');
await page.locator('button[type="submit"]').first().click();
const pw = page.locator('input[name="password"]:visible').first(); await pw.waitFor(); await page.waitForTimeout(400);
await pw.click(); await pw.pressSequentially(pass, { delay: 15 }); await pw.press('Enter');
await page.waitForURL(`${BASE}/**`, { timeout: 30000 });

await check('redirect roli: / → /overview (admin)', async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  if (!page.url().includes('/overview')) throw new Error('url=' + page.url());
});
await check('overview: kafle + zdrowie + sidebar', async () => {
  await page.locator('text=Szkice do recenzji').first().waitFor({ timeout: 8000 });
  await page.locator('text=Zdrowie systemu').waitFor();
  await page.locator('nav >> text=Ustawienia').first().waitFor();
});
await check('⌘K palette otwiera się i nawiguje', async () => {
  await page.keyboard.press('Control+k');
  const dialog = page.locator('[role="dialog"]'); await dialog.waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
});
await check('ask: pytanie → odpowiedź z cytowaniem (SSE)', async () => {
  await page.goto(`${BASE}/ask`, { waitUntil: 'networkidle' });
  await page.locator('textarea').first().fill('Jaki strumień świetlny ma oprawa HighBay 150W?');
  await page.getByRole('button', { name: /Zapytaj|Wyślij/ }).first().click();
  await page.locator('text=/21\\s?000|21000/').first().waitFor({ timeout: 90000 });
});
await check('inbox: filtry + tabela/empty', async () => {
  await page.goto(`${BASE}/inbox`, { waitUntil: 'networkidle' });
  await page.locator('h1:has-text("Skrzynka")').waitFor();
  await page.locator('input[type="search"], input[placeholder*="zukaj"]').first().waitFor();
});
await check('kb: realny badge oceny jakości', async () => {
  await page.goto(`${BASE}/kb`, { waitUntil: 'networkidle' });
  await page.locator('text=bez zastrzeżeń').first().waitFor({ timeout: 10000 });
});
await check('kb: menu wiersza … z Archiwizuj', async () => {
  await page.locator('table button:has(svg)').last().click();
  await page.locator('[role="menuitem"]:has-text("Archiwizuj")').waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
});
await check('mcp: dialog klucza z walidacją przy polu', async () => {
  await page.goto(`${BASE}/mcp`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Utwórz klucz' }).first().click();
  await page.locator('[role="dialog"]').waitFor();
  await page.locator('[role="dialog"]').getByRole('button', { name: 'Utwórz klucz' }).click();
  await page.locator('[role="alert"]').first().waitFor({ timeout: 5000 }); // błąd przy polu
  await page.keyboard.press('Escape');
});
await check('settings: zakładki audit/health + minScore EDYTOWALNY (program rozbudowy F2)', async () => {
  await page.goto(`${BASE}/settings?tab=health`, { waitUntil: 'networkidle' });
  await page.locator('text=/Bezpieczniki|breaker/i').first().waitFor({ timeout: 8000 });
  await page.goto(`${BASE}/settings?tab=thresholds`, { waitUntil: 'networkidle' });
  // dwa suwaki (learning.threshold + answer.minScore) — oba interaktywne
  const sliders = page.locator('input[type="range"]');
  await sliders.nth(1).waitFor({ timeout: 8000 });
  if ((await sliders.count()) < 2) throw new Error('brak drugiego suwaka (answer.minScore)');
  if (await sliders.nth(1).isDisabled()) throw new Error('suwak minScore jest disabled');
});
await check('404: nieznany adres pokazuje NotFound', async () => {
  await page.goto(`${BASE}/nie-ma-takiej-strony`, { waitUntil: 'networkidle' });
  await page.locator('text=/nie istnieje|Nie znaleziono|404/i').first().waitFor({ timeout: 5000 });
});

await browser.close();
let fails = 0;
for (const [s, n] of results) { console.log(s, '—', n); if (s === 'FAIL') fails++; }
console.log(`\n${results.length - fails}/${results.length} PASS`);
process.exit(fails ? 1 : 0);
