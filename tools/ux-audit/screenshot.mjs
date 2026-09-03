#!/usr/bin/env node
// Zrzuty ekranu paneli PomagierKB (audyt UX before/after).
// Login: akadmin przez Authentika (hasło z deploy/edge/.env — nigdy w repo/argv).
// Użycie: node tools/ux-audit/screenshot.mjs [--out docs/design/ux-audit/before] [--pages /ask,/kb]
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.UX_BASE_URL ?? 'https://kag.ilovelighting.sanok.pl';
const outDir = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : 'docs/design/ux-audit/before';
const pagesArg = process.argv.includes('--pages')
  ? process.argv[process.argv.indexOf('--pages') + 1].split(',').map((p) => (p.startsWith('/') ? p : '/' + p))
  : null;

const PAGES = pagesArg ?? ['/overview', '/ask', '/add', '/inbox', '/inbox?tab=gaps', '/kb', '/mcp', '/mcp?tab=profiles', '/mcp?tab=snippets', '/settings', '/settings?tab=system', '/settings?tab=audit', '/settings?tab=health'];
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 375, height: 812 },
];
const THEMES = ['light', 'dark'];

function credentials() {
  const env = readFileSync('deploy/edge/.env', 'utf8');
  const m = env.match(/^AUTHENTIK_BOOTSTRAP_PASSWORD=(.+)$/m);
  if (!m) throw new Error('brak AUTHENTIK_BOOTSTRAP_PASSWORD w deploy/edge/.env');
  return { user: 'akadmin', pass: m[1].trim() };
}

async function login(page) {
  const { user, pass } = credentials();
  // /auth/login startuje OIDC server-side (SPA jest publiczne — nie robi redirectu HTTP).
  await page.goto(`${BASE}/auth/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/auth\.ilovelighting\.sanok\.pl|\/ask/, { timeout: 20000 });
  if (page.url().includes('auth.ilovelighting.sanok.pl')) {
    // Authentik renderuje web-componenty; czekamy na pole loginu (shadow DOM piercing przez locator).
    const uid = page.locator('input[name="uidField"]');
    await uid.waitFor({ timeout: 20000 });
    await uid.fill(user);
    await page.locator('button[type="submit"]').first().click();
    const pw = page.locator('input[name="password"]:visible').first();
    await pw.waitFor({ timeout: 20000 });
    await page.waitForTimeout(400);        // hydratacja web-componentu Authentika
    await pw.click();
    await pw.pressSequentially(pass, { delay: 15 });
    await pw.press('Enter');
    try {
      await page.waitForURL(`${BASE}/**`, { timeout: 30000 });
    } catch (err) {
      await page.screenshot({ path: '/tmp/claude-0/-kag/f4ed8b2b-28a2-4090-98d4-1eb1b4e15be8/scratchpad/login-stuck.png', fullPage: true });
      console.error('[debug] po haśle utknęło na:', page.url());
      throw err;
    }
  }
  // potwierdź sesję
  const me = await page.evaluate(async () => {
    const r = await fetch('/api/v1/me', { credentials: 'include' });
    return r.status;
  });
  if (me !== 200) {
    await page.screenshot({ path: '/tmp/claude-0/-kag/f4ed8b2b-28a2-4090-98d4-1eb1b4e15be8/scratchpad/login-fail.png', fullPage: true });
    throw new Error(`login nieudany — /api/v1/me => ${me}; url=${page.url()}`);
  }
  console.log('[login] OK (akadmin)');
}

function fileName(path, vp, theme) {
  const slug = path.replaceAll('/', '_').replaceAll('?', '-').replaceAll('=', '-').replace(/^_/, '') || 'root';
  return `${slug}--${vp}--${theme}.png`;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: VIEWPORTS[0], deviceScaleFactor: 2, locale: 'pl-PL' });
const page = await ctx.newPage();
await login(page);
mkdirSync(outDir, { recursive: true });

let count = 0;
for (const theme of THEMES) {
  // Wróć na origin panelu — po błędnej nawigacji dokument bywa opaque (localStorage rzuca).
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.evaluate((t) => {
    localStorage.setItem('pomagierkb.theme', t);
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const p of PAGES) {
      await page.goto(`${BASE}${p}`, { waitUntil: 'networkidle' }).catch(() => {});
      await page.waitForTimeout(700); // dociągnięcie queries/skeletonów
      const f = join(outDir, fileName(p, vp.name, theme));
      await page.screenshot({ path: f, fullPage: true });
      count++;
      console.log(`[shot] ${f}`);
    }
  }
}
await browser.close();
console.log(`[done] ${count} zrzutów w ${outDir}`);
