#!/usr/bin/env node
// JEDNORAZOWA migracja (2026-09-28): dokumenty redakcyjne kpi-*.md z /srv/kag-data/import/ilovekb/out/docs
// → katalog templates/<obszar>/<id>.md + _zasady.md. Czysty zakres dat (jedno `>= 'X'`, jedno `< 'Y'`)
// zamieniany na @od/@do; reszta oflagowana do ręcznego przeglądu. Usuwany po migracji (Task 8 planu).
// Użycie: node tools/mssql-introspect/migrate-kpi-templates.mjs --src <out/docs> --out tools/mssql-introspect/templates

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify } from 'yaml';
import { normalizeText } from './src/templates.mjs';

const FILES = { sprzedaz: 'kpi-sprzedaz.md', finanse: 'kpi-finanse.md', magazyn: 'kpi-magazyn.md' };
const RULE_HEADINGS = /^(Zasady wspólne|Wspólne ustalenia|Model rozrachunków)/;
const CODES_HEADING = /^Słownik kodów/;

/** ascii kebab-case bez prefiksu „KPI N — ”; dłuższe niż 60 znaków cięte na granicy słowa. */
export function slugify(title) {
  const s = normalizeText(title.replace(/^KPI\s+\d+\s+—\s+/, '')).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length <= 60) return s;
  const cut = s.slice(0, 61);
  return cut.slice(0, cut.lastIndexOf('-')).replace(/-+$/, '');
}

function parametrize(sql) {
  const flags = [];
  const lits = [...sql.matchAll(/'(\d{4}-\d{2}-\d{2})'/g)].map((m) => m[1]);
  const ge = [...new Set([...sql.matchAll(/>=\s*'(\d{4}-\d{2}-\d{2})'/g)].map((m) => m[1]))];
  const lt = [...new Set([...sql.matchAll(/<\s*'(\d{4}-\d{2}-\d{2})'/g)].map((m) => m[1]))];
  let out = sql;
  let params = {};
  const distinct = new Set(lits);
  if (ge.length === 1 && lt.length === 1 && distinct.size === 2 && ge[0] < lt[0]) {
    out = out.replaceAll(`'${ge[0]}'`, '@od').replaceAll(`'${lt[0]}'`, '@do')
      .replace(/^--\s*zakres:.*$/m, '-- zakres: [@od, @do) — przedział półotwarty');
    params = {
      od: { type: 'date', description: 'początek zakresu (włącznie)', example: ge[0] },
      do: { type: 'date', description: 'koniec zakresu (wyłącznie)', example: lt[0] },
    };
  } else if (lits.length > 0) {
    flags.push(`literały dat: ${lits.length} — parametryzuj ręcznie`);
  }
  if (/GETDATE\s*\(/i.test(sql)) flags.push('GETDATE — rozważ parametr daty odniesienia');
  return { sql: out, params, flags };
}

function renderTemplate({ id, title, area, order, params, verified, body, sql }) {
  const meta = stringify({ id, title, area, order, questions: [`Jak policzyć: ${title}?`], params, verified }, { lineWidth: 0 }).trimEnd();
  // funkcja zastępująca: `$` w SQL nie może być interpretowany jako wzorzec podstawienia
  return `---\n${meta}\n---\n${body.replace('@@SQL@@', () => `\`\`\`sql\n${sql.trim()}\n\`\`\``).trim()}\n`;
}

export function splitKpiDoc(markdown, { area, fallbackVerified }) {
  const text = markdown.replace(/\r\n/g, '\n');
  const parts = text.split(/^## /m);
  const intro = parts[0].replace(/^# .*\n/, '').trim();
  const rules = [intro];
  const codes = [];
  const templates = [];
  let order = 0;
  for (const part of parts.slice(1)) {
    const nl = part.indexOf('\n');
    const heading = part.slice(0, nl).trim();
    const content = part.slice(nl + 1);
    if (RULE_HEADINGS.test(heading)) { rules.push(`## ${heading}\n${content.trim()}`); continue; }
    if (CODES_HEADING.test(heading)) { codes.push(`## ${heading}\n${content.trim()}`); continue; }
    const verified = content.match(/wykona(?:no|ne)\s+(\d{4}-\d{2}-\d{2})/)?.[1] ?? fallbackVerified;
    const cleaned = content.replace(/^Szablon SQL \(T-SQL\):\s*\n/m, '').replace(/^- Test:.*\n?/m, '');
    const blocks = [...cleaned.matchAll(/```sql\n([\s\S]*?)```/g)];
    const title = heading.replace(/^KPI\s+\d+\s+—\s+/, '');
    const baseId = slugify(heading);
    blocks.forEach((b, i) => {
      order += 10;
      let body = cleaned;
      blocks.forEach((other, j) => { body = body.replace(other[0], j === i ? '@@SQL@@' : ''); });
      const p = parametrize(b[1]);
      const flags = ['pytania do uzupełnienia', ...p.flags];
      if (blocks.length > 1) flags.push('dwa bloki SQL — rozdzielono, przejrzyj opis');
      const id = i === 0 ? baseId : `${baseId}-${i + 1}`;
      templates.push({ id, flags, raw: renderTemplate({ id, title: i === 0 ? title : `${title} (wariant ${i + 1})`, area, order, params: p.params, verified, body, sql: p.sql }) });
    });
  }
  return { rules: `${[...rules, ...codes].filter(Boolean).join('\n\n')}\n`, templates };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const src = opt('--src');
  const out = opt('--out');
  if (!src || !out) { console.error('użycie: migrate-kpi-templates.mjs --src <out/docs> --out <templates>'); process.exit(2); }
  for (const [area, file] of Object.entries(FILES)) {
    const r = splitKpiDoc(readFileSync(join(src, file), 'utf8'), { area, fallbackVerified: '2026-09-14' });
    mkdirSync(join(out, area), { recursive: true });
    writeFileSync(join(out, area, '_zasady.md'), r.rules);
    for (const t of r.templates) {
      writeFileSync(join(out, area, `${t.id}.md`), t.raw);
      console.log(`${area}/${t.id}.md${t.flags.length ? `  [${t.flags.join('; ')}]` : ''}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
