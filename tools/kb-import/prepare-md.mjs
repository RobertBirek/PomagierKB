#!/usr/bin/env node
// GENERYCZNY konwerter Markdown → fragmenty KB (JSON {text,title,sourceUrl} przez upload.mjs).
// Użycie: node tools/kb-import/prepare-md.mjs --in <plik.md> --file-id <driveId> --slug <slug> --title "<tytuł>"
//         --category "<kategoria domyślna>" --product "<produkt>" --keywords "a,b,c" --out <katalog>
//         [--drop "<regex tytułów sekcji do pominięcia>"] [--url-ns <segment URL, np. analizy-erp>]
//         [--file-name "<nazwa w zdaniu proweniencji>"] [--split-above 12000] [--max-chars 80000]
// Zasady (docs/runbooks/new-kb-bulk-import.md): jedna sekcja H2 = jeden dokument (sekcja > 12 000 zn. →
// osobny dokument per H3), każda tabela → blok rekordów (lib/md-tables.mjs), fragment ≤ 80 000 zn. z H1,
// wstępem (tytuł sekcji + zdanie proweniencji) i słowami kluczowymi (packSections), sourceUrl unikalny per
// fragment ze słowem „dokumentacja" (profil czyszczenia docs). Manifest w <out>/manifest.json jest
// DOPISYWANY: wpisy innych plików źródłowych zostają, wpisy tego samego pliku są zastępowane.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packSections } from './lib/catalog-md.mjs';
import { convertTablesToRecords } from './lib/md-tables.mjs';
import { slugify } from './lib/sources.mjs';

export const MAX_CHARS = 80_000;
export const SPLIT_BY_H3_ABOVE = 12_000;
/** Preambuła H2 (tekst przed pierwszym H3) do tej długości jest POWTARZANA w każdym dokumencie H3. */
const H2_PREAMBLE_INLINE_MAX = 1000;
/** Tekst przed pierwszym H2 (po zdjęciu H1) krótszy niż to → pominięty (metadane raportu, nie wiedza). */
const DOC_PREAMBLE_MIN = 300;

/** Kategoria per sekcja: pierwsza reguła pasująca do nagłówka H2, potem H3; brak → kategoria domyślna. */
export const DEFAULT_CATEGORY_RULES = [
  [/star schema|model(u|em)? danych/i, 'model danych'],
  [/jako[śs][ćc] danych|jako[śs]ci danych|alert|data audit|checklist/i, 'jakość danych i alerty'],
  [/dane (erp|potrzebne)|danych erp/i, 'model danych'],
  [/\bkpi\b|wska[źz]nik/i, 'katalog KPI'],
  // „typy wykresów i kiedy ich używać" to wg specu KB (specs/analizyerp.json) przewodnik, nie dashboard
  [/mapa obszar|executive|\bcel\b|priorytet|pyta[nń]|wykres|wizualizac/i, 'przewodnik'],
  [/dashboard/i, 'dashboard'],
  [/raport/i, 'katalog raportów'],
];

export function provenanceSentence(fileName, fileId) {
  return `Źródło: raport analityczny „${fileName}" z folderu Google Drive (id pliku ${fileId}), wygenerowany przez asystenta AI; zbiór generycznych definicji dla systemów ERP, nie dokumentacja InsERT.`;
}

/** Nagłówek bez numeracji „3.1 ” / „11. ” / „IV. ” — do slugów i słów kluczowych. */
export function stripNumbering(heading) {
  return heading.replace(/^\s*(\d+(\.\d+)*\.?|[IVXLC]+\.)\s+/, '').trim();
}

const FENCE_RE = /^\s*```/;
/** Znacznik HTML z nazwą i atrybutami — `<Q1−1,5·IQR lub >` (formuła) NIE pasuje. */
const HTML_TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9-]*(\s+[a-zA-Z_:][\w:.-]*(\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/g;
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };

/**
 * Normalizacja: CRLF→LF, HTML (komentarze, <br> → nowa linia, znaczniki) usunięte, encje zdekodowane,
 * poziome kreski (---/***) usunięte, nagłówki ATX bez ogona `##`, setext → ATX, samotne liczby
 * doklejone do następnej linii, ≤ 1 pusta linia z rzędu. Wnętrze ``` nietknięte.
 */
export function normalizeMarkdown(md) {
  let text = md.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const lines = text.split('\n');
  const out = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      out.push(line.trimEnd());
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    line = line.replace(/<br\s*\/?>/gi, '\n').replace(HTML_TAG_RE, '').replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m]).trimEnd();
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      // setext H2 (`tekst\n---`) → ATX; pozioma kreska → usunięta (profil docs i tak ją kasuje)
      const prev = out[out.length - 1];
      if (/^-+$/.test(line.trim()) && prev && prev.trim() !== '' && !/^\s*[#>|-]/.test(prev) && !/^\s*\d+\.\s/.test(prev)) out[out.length - 1] = `## ${prev.trim()}`;
      continue;
    }
    if (/^=+\s*$/.test(line)) {
      const prev = out[out.length - 1];
      if (prev && prev.trim() !== '' && !/^\s*#/.test(prev)) out[out.length - 1] = `# ${prev.trim()}`;
      continue;
    }
    const h = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) line = `${h[1]} ${h[2].replace(/\s+/g, ' ')}`;
    if (/^\s*\d+\s*$/.test(line)) {
      // samotna liczba w linii: sklejamy z następną niepustą linią („12” + „Nazwa” → „12. Nazwa”)
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j += 1;
      if (j < lines.length && !FENCE_RE.test(lines[j]) && !/^\s*[#|>-]/.test(lines[j])) lines[j] = `${line.trim()}. ${lines[j].trim()}`;
      continue;
    }
    out.push(line);
  }
  return out.join('\n').split('\n').filter((l, idx, arr) => !(l.trim() === '' && (arr[idx - 1] ?? '').trim() === '')).join('\n').trim() + '\n';
}

/**
 * Dzieli markdown po nagłówkach danego poziomu (świadomość fence'ów). Zwraca
 * { preamble, sections: [{ heading, body }] } — body BEZ linii nagłówka.
 */
export function splitByHeading(md, level) {
  const re = new RegExp(`^#{${level}}\\s+(.+)$`);
  const sections = [];
  let current = null;
  const preamble = [];
  let inFence = false;
  for (const line of md.split('\n')) {
    if (FENCE_RE.test(line)) inFence = !inFence;
    const m = inFence ? null : re.exec(line);
    if (m) {
      current = { heading: m[1].trim(), body: [] };
      sections.push(current);
      continue;
    }
    (current ? current.body : preamble).push(line);
  }
  return { preamble: preamble.join('\n').trim(), sections: sections.map((s) => ({ heading: s.heading, body: s.body.join('\n').trim() })) };
}

export function categoryFor(headings, fallback, rules = DEFAULT_CATEGORY_RULES) {
  for (const h of headings) {
    for (const [re, cat] of rules) if (re.test(h)) return cat;
  }
  return fallback;
}

/**
 * Plan dokumentów z jednego pliku markdown (czysta funkcja). Zwraca { title, docs, skipped }:
 * docs[i] = { slug, title, intro, sections:[{name,text}], category, keywords, h2, h3 }.
 */
export function planFragments(md, opts) {
  const { slug, category, keywords = [], drop = null, fileName, fileId, splitAbove = SPLIT_BY_H3_ABOVE, categoryRules = DEFAULT_CATEGORY_RULES } = opts;
  const text = convertTablesToRecords(normalizeMarkdown(md));
  const h1 = /^# (.+)$/m.exec(text);
  const title = opts.title ?? (h1 ? h1[1].trim() : fileName);
  const withoutH1 = h1 ? text.replace(/^# .+\n?/m, '') : text;
  const dropRe = drop ? new RegExp(drop, 'i') : null;
  const provenance = provenanceSentence(fileName, fileId);
  const docs = [];
  const skipped = [];
  const usedSlugs = new Set();
  const uniqueSlug = (s) => {
    let candidate = s.slice(0, 120).replace(/-+$/, '');
    let n = 2;
    while (usedSlugs.has(candidate)) candidate = `${s.slice(0, 116)}-${n++}`;
    usedSlugs.add(candidate);
    return candidate;
  };
  const push = ({ h2, h3, body, preamble }) => {
    const names = [h2, ...(h3 ? [h3] : [])];
    const kw = [...keywords, ...names.map(stripNumbering)].filter((k, i, a) => k && a.indexOf(k) === i);
    const where = h3 ? `Podsekcja „${h3}" sekcji „${h2}" raportu „${title}".` : `Sekcja „${h2}" raportu „${title}".`;
    const content = [preamble, body].filter((s) => s && s.trim() !== '').join('\n\n').trim();
    docs.push({
      slug: uniqueSlug([slug, slugify(stripNumbering(h2)), ...(h3 ? [slugify(stripNumbering(h3))] : [])].join('-')),
      title: `${title} › ${names.join(' › ')}`,
      intro: `${where} ${provenance}`,
      sections: [{ name: h3 ?? h2, text: `${content}\n\n` }],
      category: categoryFor(names, category, categoryRules),
      keywords: kw,
      h2,
      h3: h3 ?? null,
    });
  };

  const { preamble: docPreamble, sections } = splitByHeading(withoutH1, 2);
  if (docPreamble.length >= DOC_PREAMBLE_MIN) push({ h2: 'Wprowadzenie', h3: null, body: docPreamble });
  else if (docPreamble !== '') skipped.push({ file: `${fileName}#preambuła`, reason: `tekst przed pierwszą sekcją pominięty (${docPreamble.length} zn. < ${DOC_PREAMBLE_MIN})` });

  for (const sec of sections) {
    if (dropRe && dropRe.test(sec.heading)) {
      skipped.push({ file: `${fileName}#${sec.heading}`, reason: 'sekcja pominięta (--drop)' });
      continue;
    }
    if (sec.body === '') {
      skipped.push({ file: `${fileName}#${sec.heading}`, reason: 'pusta sekcja' });
      continue;
    }
    const sub = splitByHeading(sec.body, 3);
    if (sec.body.length <= splitAbove || sub.sections.length === 0) {
      push({ h2: sec.heading, h3: null, body: sec.body });
      continue;
    }
    // Duża sekcja → dokument per H3; preambuła H2 krótka = kontekst w każdym dokumencie, długa = własny dokument.
    let inlinePreamble = '';
    if (sub.preamble.length > H2_PREAMBLE_INLINE_MAX) push({ h2: sec.heading, h3: 'wprowadzenie', body: sub.preamble });
    else inlinePreamble = sub.preamble;
    for (const s of sub.sections) {
      if (dropRe && dropRe.test(s.heading)) {
        skipped.push({ file: `${fileName}#${sec.heading}#${s.heading}`, reason: 'podsekcja pominięta (--drop)' });
        continue;
      }
      if (s.body === '') continue;
      push({ h2: sec.heading, h3: s.heading, body: s.body, preamble: inlinePreamble });
    }
  }
  return { title, docs, skipped };
}

/** Zapis dokumentów (packSections ≤ maxChars) + wpisy manifestu w kształcie prepare.mjs/upload.mjs. */
export function emitFragments(docs, { outDir, fileId, urlNs, product, sourceFile, maxChars = MAX_CHARS }) {
  const entries = [];
  const base = `https://drive.google.com/file/d/${fileId}/view#dokumentacja/${urlNs ? `${urlNs}/` : ''}`;
  for (const d of docs) {
    const packed = packSections(d.sections, { title: d.title, intro: d.intro, maxChars, keywords: d.keywords });
    for (const p of packed) {
      const file = packed.length > 1 ? `${d.slug}-${p.part}.md` : `${d.slug}.md`;
      writeFileSync(join(outDir, file), p.text);
      entries.push({
        file,
        title: p.title,
        sourceUrl: `${base}${d.slug}${packed.length > 1 ? `/${p.part}` : ''}`,
        category: d.category,
        product,
        part: p.part,
        parts: p.parts,
        chars: p.text.length,
        keywords: d.keywords,
        sourceFile,
      });
    }
  }
  return entries;
}

/** Scala nowe wpisy z istniejącym manifestem: wpisy innych plików źródłowych zostają, tego samego — zastąpione. */
export function mergeManifest(existing, { source, entries, skipped, sourceFile }) {
  const prev = existing ?? { source: null, entries: [], skipped: [] };
  const keptEntries = (prev.entries ?? []).filter((e) => e.sourceFile !== sourceFile);
  const keptSkipped = (prev.skipped ?? []).filter((s) => !String(s.file).startsWith(`${sourceFile}#`));
  const urls = new Set(keptEntries.map((e) => e.sourceUrl));
  for (const e of entries) {
    if (urls.has(e.sourceUrl)) throw new Error(`sourceUrl już zajęty przez inny plik źródłowy: ${e.sourceUrl}`);
    urls.add(e.sourceUrl);
  }
  const sources = new Set(String(prev.source ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  sources.add(source);
  return {
    source: [...sources].join(','),
    generatedAt: new Date().toISOString(),
    entries: [...keptEntries, ...entries],
    skipped: [...keptSkipped, ...skipped],
    replaced: (prev.entries ?? []).filter((e) => e.sourceFile === sourceFile).map((e) => e.file),
  };
}

export function runPrepareMd(opts) {
  const { inPath, outDir, fileId, slug, product, urlNs = null, maxChars = MAX_CHARS } = opts;
  const sourceFile = basename(inPath);
  const fileName = opts.fileName ?? sourceFile;
  mkdirSync(outDir, { recursive: true });
  const md = readFileSync(inPath, 'utf8');
  const { title, docs, skipped } = planFragments(md, { ...opts, fileName, fileId, slug });
  const entries = emitFragments(docs, { outDir, fileId, urlNs, product, sourceFile, maxChars });
  const manifestPath = join(outDir, 'manifest.json');
  const existing = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const merged = mergeManifest(existing, { source: fileId, entries, skipped, sourceFile });
  const { replaced, ...manifest } = merged;
  // pliki z poprzedniego przebiegu tego samego źródła, których już nie ma w planie — sprzątamy
  const current = new Set(entries.map((e) => e.file));
  for (const f of replaced) if (!current.has(f) && existsSync(join(outDir, f))) unlinkSync(join(outDir, f));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { title, entries, skipped, manifestPath, docs };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, def = null) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : def;
  };
  const inPath = opt('--in');
  const outDir = opt('--out');
  const fileId = opt('--file-id');
  const slug = opt('--slug');
  if (!inPath || !outDir || !fileId || !slug) {
    console.error('użycie: prepare-md.mjs --in <plik.md> --file-id <driveId> --slug <slug> --out <dir> [--title T] [--category C] [--product P] [--keywords a,b] [--drop regex] [--url-ns ns] [--file-name N] [--split-above N] [--max-chars N]');
    process.exit(2);
  }
  const r = runPrepareMd({
    inPath,
    outDir,
    fileId,
    slug,
    title: opt('--title') ?? undefined,
    category: opt('--category', 'przewodnik'),
    product: opt('--product', 'ERP (ogólne)'),
    keywords: (opt('--keywords', '') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    drop: opt('--drop'),
    urlNs: opt('--url-ns'),
    fileName: opt('--file-name') ?? undefined,
    splitAbove: Number(opt('--split-above', String(SPLIT_BY_H3_ABOVE))),
    maxChars: Number(opt('--max-chars', String(MAX_CHARS))),
  });
  for (const e of r.entries) console.log(`+ ${e.file}  ${String(e.chars).padStart(6)} zn.  [${e.category}]  ${e.title}`);
  const total = r.entries.reduce((a, e) => a + e.chars, 0);
  const over = r.entries.filter((e) => e.chars > MAX_CHARS).length;
  console.log(`razem: ${r.entries.length} fragmentów, ${total} znaków, max ${Math.max(0, ...r.entries.map((e) => e.chars))} zn.${over ? ` UWAGA: ${over} > ${MAX_CHARS}` : ''}; pominięte: ${r.skipped.length}; manifest: ${r.manifestPath}`);
  for (const s of r.skipped) console.log(`  - ${s.file}: ${s.reason}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
