#!/usr/bin/env node
// Konwersja pobranego folderu (raw/) do fragmentów Markdown gotowych na POST /content (JSON {text,title,sourceUrl}).
// Użycie: node tools/kb-import/prepare.mjs --raw <raw/> --ext <katalog roboczy> --out <out/docs> [--product "InsERT GT"]
// Obsługa: PDF (pdfjs, podział po nagłówkach), CHM (7z x → rozdziały spisu), ZIP z przykładami (kuracja plików
// tekstowych), HTML w ZIP. Pliki .doc/.xls są pomijane (brak konwertera na hoście) — raportowane w manifeście.
// Wynik: out/<slug>.md + out/manifest.json (title, sourceUrl unikalny per fragment, category, product).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import AdmZip from 'adm-zip';
import { packSections } from './lib/catalog-md.mjs';
import { extractPdfLines, linesToMarkdown, splitMarkdownSections } from './lib/pdf-md.mjs';
import { decodeHtmlFile, htmlToMarkdown, loadChm, planChapters } from './lib/chm-md.mjs';
import { CATEGORIES, classifySource, curateArchiveFile, slugify } from './lib/sources.mjs';

const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const rawDir = opt('--raw');
const extDir = opt('--ext');
const outDir = opt('--out');
const productLabel = opt('--product', 'InsERT GT');
const only = opt('--only'); // regex nazw plików raw (debug)
if (!rawDir || !extDir || !outDir) {
  console.error('użycie: prepare.mjs --raw raw/ --ext ext/ --out out/docs [--only regex]');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
mkdirSync(extDir, { recursive: true });

const rawManifest = JSON.parse(readFileSync(join(rawDir, 'manifest.json'), 'utf8'));
const byPath = new Map(Object.values(rawManifest.files).map((f) => [f.path, f]));
const MAX = 80_000;
const date = new Date().toISOString().slice(0, 10);
// Front-matter celowo pominięty: do czasu wdrożenia poprawki GAP-03 (intake-worker czyta go po cleanerze)
// linie owner/license zostawały w treści. Proweniencja idzie zdaniem we wstępie.
const fm = '';
const PROVENANCE = 'Właściciel treści: InsERT S.A.; licencja: dokumentacja producenta (użytek wewnętrzny).';
const entries = [];
const skipped = [];
const seenSha = new Set();

/** H1 stron pomocy → H2 (H1 dokumentu jest jeden, nadaje go packSections). */
function demoteHeadings(md) {
  return md.replace(/^#(#{0,4}) /gm, '##$1 ');
}

function driveUrl(file) {
  return `https://drive.google.com/file/d/${file.id}/view`;
}

/** Zapis spakowanych części + wpisy manifestu. */
function emit({ slug, title, intro, sections, sourceBase, category, product, keywords, sourceFile }) {
  const packed = packSections(sections, { title, intro: `${intro} ${PROVENANCE}`, maxChars: MAX, keywords });
  for (const p of packed) {
    const file = packed.length > 1 ? `${slug}-${p.part}.md` : `${slug}.md`;
    const text = fm + p.text;
    writeFileSync(join(outDir, file), text);
    entries.push({
      file,
      title: p.title,
      sourceUrl: `${sourceBase}#dokumentacja/${slug}${packed.length > 1 ? `/${p.part}` : ''}`,
      category,
      product,
      part: p.part,
      parts: p.parts,
      chars: text.length,
      keywords,
      sourceFile,
    });
  }
  return packed.length;
}

async function handlePdf(buffer, meta, sourceBase, sourceFile) {
  const { pages, numPages, textChars } = await extractPdfLines(buffer);
  if (textChars < 200 * Math.max(1, numPages / 4)) {
    skipped.push({ file: sourceFile, reason: `PDF bez warstwy tekstowej (${textChars} zn. na ${numPages} str.) — wymaga OCR` });
    return 0;
  }
  const md = linesToMarkdown(pages).replace(/^[^\n]*\.{5,}\s*\d+\s*$/gm, '').replace(/\n{3,}/g, '\n\n');
  const sections = splitMarkdownSections(md).filter((s) => s.text.trim() !== '' && !/^## Spis treści/i.test(s.text));
  const intro = `${meta.summary} Źródło: plik ${basename(sourceFile)} (${numPages} stron) z dokumentacji ${productLabel}. Wersja programu: 1.89 HF1.`;
  return emit({ slug: meta.slug, title: meta.title, intro, sections, sourceBase, category: meta.category, product: meta.product, keywords: meta.keywords, sourceFile });
}

function handleChm(chmPath, meta, sourceBase, sourceFile) {
  const dir = join(extDir, 'chm', slugify(sourceFile.replace(/\.chm$/i, '')));
  if (!existsSync(join(dir, 'extracted.ok'))) {
    mkdirSync(dir, { recursive: true });
    execFileSync('7z', ['x', '-y', `-o${dir}`, chmPath], { stdio: 'ignore' });
    writeFileSync(join(dir, 'extracted.ok'), date);
  }
  const chm = loadChm(dir);
  const cache = new Map();
  const mdOf = (local) => {
    if (cache.has(local)) return cache.get(local);
    const page = chm.getPage(local);
    const r = page ? htmlToMarkdown(page.html) : null;
    cache.set(local, r);
    return r;
  };
  const sizeOf = (local) => mdOf(local)?.markdown.length ?? 0;
  const plan = planChapters(chm.tree, sizeOf, MAX);
  let files = 0;
  const usedPages = new Set();
  for (const chapter of plan) {
    const sections = [];
    for (const p of chapter.pages) {
      if (meta.skipPages && meta.skipPages.test(p.local)) {
        usedPages.add(p.local.toLowerCase());
        continue;
      }
      if (meta.splitByHeading && meta.splitByHeading.pages.test(p.local)) {
        usedPages.add(p.local.toLowerCase());
        const r0 = mdOf(p.local);
        if (r0) files += emitByHeading(r0.markdown, meta, sourceBase, sourceFile, p.name);
        continue;
      }
      const r = mdOf(p.local);
      if (!r || r.markdown.trim() === '') continue;
      const page = chm.getPage(p.local);
      if (seenSha.has(page.sha256)) continue; // ta sama strona w drugim CHM/rozdziale
      seenSha.add(page.sha256);
      usedPages.add(p.local.toLowerCase());
      const body = demoteHeadings(r.markdown);
      const heading = body.startsWith('#') ? '' : `### ${p.name}\n\n`;
      sections.push({ name: p.name, text: `${heading}${body}\n\n` });
    }
    if (sections.length === 0) continue;
    const slug = `${meta.slug}-${slugify(chapter.pathTitles.join('-'))}`.slice(0, 120);
    const title = `${meta.title} › ${chapter.title}`;
    const intro = `${meta.summary} Rozdział „${chapter.title}" pomocy ${basename(sourceFile)} (${sections.length} stron). Wersja programu: 1.89 HF1.`;
    files += emit({ slug, title, intro, sections, sourceBase, category: meta.category, product: meta.product, keywords: [...meta.keywords, ...chapter.pathTitles], sourceFile });
  }
  // Strony poza spisem treści (podstrony/okna) — jako dodatek, tylko z sensowną treścią.
  const extra = [];
  const walk = (d, rel) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      const r = rel ? `${rel}/${f}` : f;
      if (statSync(p).isDirectory()) walk(p, r);
      else if (/\.html?$/i.test(f) && !usedPages.has(r.toLowerCase())) extra.push(r);
    }
  };
  walk(chm.base, '');
  const extraSections = [];
  for (const local of extra.sort()) {
    if (meta.skipPages && meta.skipPages.test(local)) continue;
    const page = chm.getPage(local);
    if (!page || seenSha.has(page.sha256)) continue;
    const r = htmlToMarkdown(page.html);
    if (r.markdown.length < 300) continue;
    seenSha.add(page.sha256);
    const name = r.title || local;
    const body = demoteHeadings(r.markdown);
    extraSections.push({ name, text: `${body.startsWith('#') ? '' : `### ${name}\n\n`}${body}\n\n` });
  }
  if (extraSections.length > 0) {
    files += emit({ slug: `${meta.slug}-pozostale-strony`, title: `${meta.title} › pozostałe strony pomocy`, intro: `${meta.summary} Strony pomocy ${basename(sourceFile)} spoza spisu treści (okna, podstrony, opisy pól). Wersja programu: 1.89 HF1.`, sections: extraSections, sourceBase, category: meta.category, product: meta.product, keywords: meta.keywords, sourceFile });
  }
  return files;
}

/** Strona z nagłówkami H2 per wersja/temat → osobny dokument per nagłówek (własny slug i sourceUrl). */
function emitByHeading(markdown, meta, sourceBase, sourceFile, pageName) {
  const parts = markdown.split(/\n(?=## )/);
  const cfg = meta.splitByHeading;
  let files = 0;
  for (const part of parts) {
    const m = /^## (.+)$/m.exec(part);
    if (!m) continue;
    const heading = m[1].replace(/[_*]/g, '').replace(/\s+/g, ' ').trim();
    // Nagłówek sekcji (po demote: ###) usunięty z treści — tytuł jest w H1, a chunker tnie po KAŻDYM nagłówku.
    const body = demoteHeadings(part).replace(/^#{2,4} .*\n/, '').trim();
    if (body.length < 80) continue;
    // Wersja z sufiksami (1.22 SP3 HF1, 1.12 Hotfix Win98) — cały ogon po numerze, żeby slugi nie kolidowały.
    const version = heading.match(/\d+\.\d+(?:\s+(?:SP|HF|Hotfix)\s*[\w.]+)*/i)?.[0]?.trim() ?? heading;
    const title = `${cfg.titlePrefix} ${version}`.trim();
    const slug = `${meta.slug}-${slugify(cfg.titlePrefix)}-${slugify(version)}`;
    // Numer wersji powtórzony w kilku formach: retrieval mylił 1.84 SP1 z 1.48 SP1 (podobne tokeny).
    const spelled = version.replace(/\s*SP\s*(\d+)/i, ' Service Pack $1').replace(/\s*HF\s*(\d+)/i, ' Hotfix $1');
    const intro = `${meta.summary} Fragment strony „${pageName}" pomocy ${basename(sourceFile)}: ${heading}. Dotyczy wersji ${version} (InsERT GT ${spelled}, wersja ${version.replace(/\s+/g, '')}). Wersja bieżąca programu: 1.89 HF1.`;
    // Bez nagłówka H2 w treści: chunker tnie po nagłówkach i pierwszy chunk (H1+wstęp) nie miał ani jednej
    // pozycji listy — retrieval trafiał w „pusty" chunk. Wstęp i pierwsze pozycje mają być w jednym chunku.
    files += emit({ slug, title, intro, sections: [{ name: heading, text: `${body}\n\n` }], sourceBase, category: CATEGORIES[cfg.category] ?? meta.category, product: meta.product, keywords: [...meta.keywords, 'lista zmian', version], sourceFile });
  }
  return files;
}

async function handleZip(buffer, meta, sourceBase, sourceFile) {
  const zip = new AdmZip(buffer);
  const sections = [];
  let files = 0;
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const name = e.entryName;
    const ext = extname(name).toLowerCase();
    if (ext === '.pdf') {
      const sub = { ...meta, slug: `${meta.slug}-${slugify(basename(name, ext))}`, title: `${meta.title} › ${basename(name)}` };
      files += await handlePdf(e.getData(), sub, sourceBase, `${sourceFile}:${name}`);
      continue;
    }
    if (ext === '.htm' || ext === '.html') {
      const r = htmlToMarkdown(decodeHtmlFile(e.getData()));
      if (r.markdown.length > 100) sections.push({ name: r.title || name, text: `## ${r.title || name}\n\n${r.markdown}\n\n` });
      continue;
    }
    const cur = curateArchiveFile(name, e.header.size);
    if (!cur.include) {
      if (cur.reason) skipped.push({ file: `${sourceFile}:${name}`, reason: cur.reason });
      continue;
    }
    const text = decodeHtmlFile(e.getData()).replace(/\r\n/g, '\n').trim();
    if (text === '') continue;
    const lang = cur.lang;
    sections.push({ name, text: `### Plik ${name}\n\n${cur.describe}\n\n\`\`\`${lang}\n${text.slice(0, 20_000)}\n\`\`\`${text.length > 20_000 ? '\n(plik przycięty do 20 000 znaków)' : ''}\n\n` });
  }
  if (sections.length > 0) {
    files += emit({ slug: meta.slug, title: meta.title, intro: `${meta.summary} Zawartość archiwum ${basename(sourceFile)} (${sections.length} plików tekstowych; pliki binarne, projekty i arkusze pominięte). Wersja programu: 1.89 HF1.`, sections, sourceBase, category: meta.category, product: meta.product, keywords: meta.keywords, sourceFile });
  }
  return files;
}

const rawFiles = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
for (const f of rawFiles) {
  if (only && !new RegExp(only).test(f.path)) continue;
  const meta = classifySource(f.path, productLabel);
  if (meta === null) continue; // świadomie pominięte (obsługiwane gdzie indziej albo duplikat CHM)
  if (meta === undefined) {
    skipped.push({ file: f.path, reason: 'brak reguły klasyfikacji (pominięty)' });
    continue;
  }
  if (seenSha.has(f.sha256)) {
    skipped.push({ file: f.path, reason: 'duplikat (ten sam sha256 co inny plik)' });
    continue;
  }
  seenSha.add(f.sha256);
  const path = join(rawDir, f.path);
  const ext = extname(f.path).toLowerCase();
  const sourceBase = driveUrl(f);
  let n = 0;
  try {
    if (ext === '.pdf') n = await handlePdf(readFileSync(path), meta, sourceBase, f.path);
    else if (ext === '.chm') n = handleChm(path, meta, sourceBase, f.path);
    else if (ext === '.zip') n = await handleZip(readFileSync(path), meta, sourceBase, f.path);
    else skipped.push({ file: f.path, reason: `nieobsługiwane rozszerzenie ${ext}` });
  } catch (err) {
    skipped.push({ file: f.path, reason: `błąd konwersji: ${err.message}` });
  }
  console.log(`${f.path}: ${n} plików .md`);
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ source: rawManifest.folderId, generatedAt: new Date().toISOString(), entries, skipped }, null, 2));
const total = entries.reduce((a, e) => a + e.chars, 0);
console.log(`razem: ${entries.length} plików .md, ${total} znaków; pominięte: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.file}: ${s.reason}`);
