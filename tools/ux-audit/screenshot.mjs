#!/usr/bin/env node
// Zrzuty ekranu paneli PomagierKB (audyt UX before/after).
// Login: DEDYKOWANE konto testowe (E2E_USER/E2E_PASSWORD albo /etc/kag/e2e.env)
// — nigdy superuser Authentika, nigdy odczyt deploy/edge/.env. Patrz README.md.
// Użycie: node tools/ux-audit/screenshot.mjs [--out docs/design/ux-audit/before] [--pages /ask,/kb]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseUrl, loadCredentials, login } from './lib/session.mjs';

// Ścieżki liczone od pliku, NIE od cwd — narzędzie działa z dowolnego katalogu.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = baseUrl();
const outDir = process.argv.includes('--out')
  ? resolve(process.argv[process.argv.indexOf('--out') + 1])
  : join(REPO_ROOT, 'docs/design/ux-audit/before');
const pagesArg = process.argv.includes('--pages')
  ? process.argv[process.argv.indexOf('--pages') + 1].split(',').map((p) => (p.startsWith('/') ? p : '/' + p))
  : null;

const PAGES = pagesArg ?? ['/overview', '/ask', '/add', '/inbox', '/inbox?tab=gaps', '/kb', '/mcp', '/mcp?tab=profiles', '/mcp?tab=snippets', '/settings', '/settings?tab=system', '/settings?tab=audit', '/settings?tab=health'];
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 375, height: 812 },
];
const THEMES = ['light', 'dark'];

function fileName(path, vp, theme) {
  const slug = path.replaceAll('/', '_').replaceAll('?', '-').replaceAll('=', '-').replace(/^_/, '') || 'root';
  return `${slug}--${vp}--${theme}.png`;
}

// Fail-closed przed uruchomieniem przeglądarki (patrz lib/session.mjs).
let creds;
try {
  creds = loadCredentials();
} catch (err) {
  console.error(`[konfiguracja] ${err.message}`);
  process.exit(2);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: VIEWPORTS[0], deviceScaleFactor: 2, locale: 'pl-PL' });
const page = await ctx.newPage();
try {
  const user = await login(page, BASE, creds);
  console.log(`[login] OK (${user} @ ${BASE})`);
} catch (err) {
  await browser.close();
  console.error(`[login] ${err.message}`);
  process.exit(2);
}
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
