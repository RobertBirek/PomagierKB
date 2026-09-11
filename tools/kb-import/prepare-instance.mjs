#!/usr/bin/env node
// Dokumenty „o instancji" produkcyjnej Subiekta GT (Magnum_Profi) dla bazy wiedzy — z agregatów
// (tools/mssql-introspect/dump-aggregates.mjs → aggregates.json) i listy dostawców-osób prawnych
// (suppliers.json). Render do Markdown gotowego na upload.mjs (manifest.json jak w prepare.mjs).
// Użycie: node tools/kb-import/prepare-instance.mjs --aggregates <aggregates.json> --suppliers <suppliers.json>
//         --out <katalog> --source-base <url> [--k 10] [--product "Subiekt GT (Magnum_Profi)"]
//
// Zasady (docs/data-governance.md §1.3 droga 3, PLAN.md „Zmiany decyzji" 2026-09-11):
// - wyłącznie agregaty (COUNT/SUM/AVG/MIN/MAX po kodach/flagach/datach) — żadnych wierszy osobowych;
// - komórki poniżej progu k osób są tłumione już w zrzucie; tu renderowane jako „<k" (nigdy 0 ani puste);
// - żaden adres/nazwa hosta bazy nie trafia do dokumentu — instancja nazywana jest wyłącznie
//   „instancja produkcyjna Magnum_Profi"; render KOŃCZY SIĘ BŁĘDEM, gdy w tekście pojawi się adres IP,
//   nazwa instancji SQL albo nazwa komputera (assertNoHost) — pola `target`/`host` wejścia są ignorowane;
// - agregaty jako LISTY, nie tabele (chunker 1800 zn. rozcina tabele bez nagłówka);
// - dostawcy: tylko osoby prawne (jednoosobowe działalności odfiltrowane w zrzucie); listę recenzuje
//   właściciel w Inboxie przed promocją.
//
// Kształt aggregates.json (tolerancyjny): { database, generatedAt, k, aggregates: [ { id, title, description?,
//   query?, dimensions?: [klucz], metrics?: [klucz], labels?: {klucz: etykieta}, unit?, kAnonymity?: bool,
//   interpretation?, suppressed?: liczba wierszy USUNIĘTYCH w całości ze zrzutu,
//   rows: [ { <wymiar>: kod, <miara>: liczba|null, suppressed?: bool } ] } ] }.
// Komórka stłumiona = row.suppressed===true, wartość miary null, tekst zaczynający się od „<", albo
// (kAnonymity===true i miara licznikowa < k).
// Kształt suppliers.json: { database, generatedAt, suppliers: [ { name, brands: [nazwa | {name, products?}],
//   products|productCount, legalForm? } ], excluded?: { soleTraders?: liczba, noBrand?: liczba } }.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packSections } from './lib/catalog-md.mjs';
import { slugify } from './lib/sources.mjs';

export const INSTANCE = 'Magnum_Profi';
export const PRODUCT = 'Subiekt GT (Magnum_Profi)';
export const CATEGORY_AGGREGATES = 'agregaty instancji';
export const CATEGORY_SUPPLIERS = 'marki i dostawcy';
export const SLUG_AGGREGATES = 'agregaty-instancji';
export const SLUG_SUPPLIERS = 'marki-dostawcy';
export const DEFAULT_K = 10;
export const MAX_CHARS = 80_000;
/** Ślady hosta bazy, których NIGDY nie wolno wyrenderować: IPv4, nazwa instancji SQL, nazwa komputera, ścieżka UNC. */
export const HOST_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b|\bINSERTGT\b|\bDESKTOP-[A-Z0-9]+\b|\\\\[A-Z0-9][A-Z0-9-]*\\/i;
/** Miary licznikowe (podlegają progowi k, gdy agregat liczy osoby). */
const COUNT_KEY_RE = /^(count|cnt|n|liczba|ile)(_|$)|_(count|cnt)$/i;
const METRIC_KEY_RE = /^(count|cnt|n|liczba|ile|sum|suma|avg|srednia|średnia|min|max|total|razem|pct|procent|share|udzial|udział)(_|$)|_(count|cnt|sum|avg|min|max|total|pct)$/i;
const METRIC_LABELS = { count: 'liczba', cnt: 'liczba', n: 'liczba', sum: 'suma', avg: 'średnia', min: 'minimum', max: 'maksimum', total: 'razem', pct: 'udział %', share: 'udział %' };
const MAX_QUERY_CHARS = 2000;

/** Polska liczba mnoga: plural(3, 'agregat', 'agregaty', 'agregatów') → „3 agregaty". */
export function plural(n, one, few, many) {
  const abs = Math.abs(n);
  const last = abs % 10;
  const teen = abs % 100 >= 12 && abs % 100 <= 14;
  const word = abs === 1 ? one : last >= 2 && last <= 4 && !teen ? few : many;
  return `${n} ${word}`;
}

/** Kropka na końcu zdania, chyba że tekst już się nią kończy („S.A.", „Sp. z o.o."). */
const endSentence = (s) => (s.endsWith('.') ? s : `${s}.`);

/** Rzuca, gdy tekst zawiera ślad hosta — zdanie błędu NIE cytuje dopasowania (nie wolno go nigdzie wypisać). */
export function assertNoHost(text, where = 'dokument') {
  if (HOST_RE.test(text)) throw new Error(`${where}: wykryto adres/nazwę hosta bazy w treści — popraw wejście (pola target/host są ignorowane, sprawdź wartości wymiarów i zapytania)`);
  return text;
}

/** Zdanie proweniencji dokumentu agregatów (stała treść wymagana przez runbook). */
export function provenanceSentence(k) {
  return `Dane wygenerowane z produkcyjnej bazy Subiekt GT ilovelighting narzędziem tools/mssql-introspect/dump-aggregates.mjs, tylko agregaty, komórki poniżej k=${k} osób tłumione; brak danych osobowych.`;
}

export function formatNumber(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
  if (typeof v === 'boolean') return v ? 'tak' : 'nie';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).replace(/\s+/g, ' ').trim();
}

/** Klucze miar i wymiarów agregatu: jawne (metrics/dimensions) albo z nazw kluczy pierwszego wiersza. */
export function aggregateKeys(agg) {
  const rows = Array.isArray(agg.rows) ? agg.rows : [];
  const all = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => k !== 'suppressed');
  let metrics = Array.isArray(agg.metrics) && agg.metrics.length > 0 ? agg.metrics : all.filter((k) => METRIC_KEY_RE.test(k));
  let dimensions = Array.isArray(agg.dimensions) ? agg.dimensions : all.filter((k) => !metrics.includes(k));
  if (metrics.length === 0 && !Array.isArray(agg.metrics)) {
    // brak nazw miar → miary to kolumny, w których występują liczby (poza wymiarami jawnymi)
    metrics = all.filter((k) => !dimensions.includes(k) && rows.some((r) => typeof r[k] === 'number' || r[k] === null));
    dimensions = dimensions.filter((k) => !metrics.includes(k));
  }
  return { dimensions, metrics };
}

export function labelOf(agg, key) {
  return agg.labels?.[key] ?? METRIC_LABELS[key.toLowerCase()] ?? key.replace(/_/g, ' ');
}

/** Czy komórka miary jest stłumiona progiem k. */
export function isSuppressed(agg, row, key, k) {
  const v = row[key];
  if (row.suppressed === true) return true;
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && v.trim().startsWith('<')) return true;
  return agg.kAnonymity === true && COUNT_KEY_RE.test(key) && typeof v === 'number' && v < k;
}

function cell(agg, row, key, k) {
  return isSuppressed(agg, row, key, k) ? `<${k}` : formatNumber(row[key]);
}

/** Jedna pozycja listy: `wymiar: kod, wymiar: kod — miara: wartość; miara: wartość`. */
export function renderRow(agg, row, { dimensions, metrics }, k) {
  const dims = dimensions.filter((d) => row[d] !== undefined && row[d] !== null && row[d] !== '').map((d) => `${labelOf(agg, d)}: ${formatNumber(row[d])}`);
  const vals = metrics.map((m) => `${labelOf(agg, m)}: ${cell(agg, row, m, k)}`);
  if (dims.length === 0) return `- ${vals.join('; ')}`;
  return `- ${dims.join(', ')}${vals.length ? ` — ${vals.join('; ')}` : ''}`;
}

/** Krótka interpretacja: najwyższa wartość pierwszej miary + liczność wierszy i stłumień. */
export function interpretation(agg, keys, k) {
  if (agg.interpretation) return `Interpretacja: ${String(agg.interpretation).trim().replace(/\.?$/, '.')}`;
  const rows = Array.isArray(agg.rows) ? agg.rows : [];
  const m = keys.metrics[0];
  const suppressedRows = m ? rows.filter((r) => isSuppressed(agg, r, m, k)).length : 0;
  const extra = Number.isInteger(agg.suppressed) ? agg.suppressed : 0;
  const hidden = suppressedRows + extra;
  const tail = `Wierszy: ${rows.length + extra}${hidden > 0 ? `, w tym stłumionych progiem k=${k}: ${hidden}` : ''}.`;
  if (!m || rows.length === 0) return `Interpretacja: brak wartości liczbowych do pokazania. ${tail}`;
  const visible = rows.filter((r) => !isSuppressed(agg, r, m, k) && typeof r[m] === 'number');
  if (visible.length === 0) return `Interpretacja: wszystkie komórki poniżej progu k=${k} — żadna wartość nie jest pokazywana. ${tail}`;
  const top = visible.reduce((a, b) => (b[m] > a[m] ? b : a));
  const dims = keys.dimensions.filter((d) => top[d] !== undefined && top[d] !== null).map((d) => `${labelOf(agg, d)}: ${formatNumber(top[d])}`).join(', ');
  if (keys.dimensions.length === 0 || dims === '') return `Interpretacja: ${labelOf(agg, m)} = ${formatNumber(top[m])}. ${tail}`;
  return `Interpretacja: najwyższa wartość „${labelOf(agg, m)}" przypada na ${dims} (${formatNumber(top[m])}). ${tail}`;
}

/** Sekcja H2 jednego agregatu: opis, wymiary/miary, lista wierszy, interpretacja, opcjonalnie zapytanie. */
export function renderAggregate(agg, k) {
  const title = String(agg.title ?? agg.id ?? 'agregat').trim();
  const keys = aggregateKeys(agg);
  const rows = Array.isArray(agg.rows) ? agg.rows : [];
  const L = [`## ${title}`, ''];
  if (agg.description) L.push(String(agg.description).trim(), '');
  const meta = [];
  if (keys.dimensions.length) meta.push(`wymiary: ${keys.dimensions.map((d) => labelOf(agg, d)).join(', ')}`);
  if (keys.metrics.length) meta.push(`miary: ${keys.metrics.map((m) => labelOf(agg, m)).join(', ')}`);
  if (agg.unit) meta.push(`jednostka: ${agg.unit}`);
  const anySuppressed = agg.kAnonymity === true || (Number.isInteger(agg.suppressed) && agg.suppressed > 0) || rows.some((r) => keys.metrics.some((m) => isSuppressed(agg, r, m, k)));
  L.push(`Agregat „${title}" (instancja produkcyjna ${INSTANCE})${meta.length ? ` — ${meta.join('; ')}` : ''}.${anySuppressed ? ` Wartości „<${k}" oznaczają komórkę stłumioną (mniej niż ${k} osób).` : ''}`, '');
  if (rows.length === 0) L.push('Brak wierszy (zapytanie nie zwróciło danych albo wszystkie zostały stłumione w zrzucie).', '');
  else {
    L.push(`Wartości (${rows.length}):`);
    for (const r of rows) L.push(renderRow(agg, r, keys, k));
    L.push('');
  }
  L.push(interpretation(agg, keys, k), '');
  if (agg.query) {
    const q = String(agg.query).replace(/\r\n?/g, '\n').trim();
    L.push('Zapytanie użyte do wyliczenia:', '', '```sql', q.length > MAX_QUERY_CHARS ? `${q.slice(0, MAX_QUERY_CHARS)}\n-- (zapytanie przycięte do ${MAX_QUERY_CHARS} znaków)` : q, '```', '');
  }
  return { name: title, text: L.join('\n') };
}

function dateOf(dump, fallback) {
  const s = typeof dump?.generatedAt === 'string' ? dump.generatedAt.slice(0, 10) : null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s ?? '') ? s : fallback;
}

/** Dokument 1: agregaty instancji → części z packSections. */
export function renderAggregatesDoc(dump, { k, date = new Date().toISOString().slice(0, 10), maxChars = MAX_CHARS } = {}) {
  const aggregates = Array.isArray(dump?.aggregates) ? dump.aggregates : [];
  const generated = dateOf(dump, date);
  const sections = aggregates.map((a) => renderAggregate(a, k));
  const intro = `Liczby opisujące instancję produkcyjną ${INSTANCE} programu Subiekt GT (firma ilovelighting): liczności dokumentów, towarów, kontrahentów i innych obiektów w podziale po kodach, flagach i okresach — ${plural(aggregates.length, 'agregat', 'agregaty', 'agregatów')}, stan na ${generated}. ${provenanceSentence(k)} Każdy agregat: opis, lista wierszy „wymiar: kod — miara: wartość", krótka interpretacja. To są liczby o TEJ instancji, nie dokumentacja programu.`;
  const keywords = [PRODUCT, INSTANCE, 'ilovelighting', 'agregaty instancji', 'statystyki', 'liczby', 'ile', ...aggregates.slice(0, 12).map((a) => String(a.title ?? a.id ?? '')).filter(Boolean)];
  return packSections(sections, { title: `${INSTANCE} — liczby o instancji (agregaty)`, intro, maxChars, keywords });
}

/** Normalizacja wpisu dostawcy: nazwa, marki (nazwy), liczba towarów, forma prawna. */
export function normalizeSupplier(s) {
  const brands = (Array.isArray(s.brands) ? s.brands : []).map((b) => (typeof b === 'string' ? { name: b, products: null } : { name: String(b?.name ?? '').trim(), products: Number.isFinite(b?.products) ? b.products : null })).filter((b) => b.name !== '');
  const products = Number.isFinite(s.products) ? s.products : Number.isFinite(s.productCount) ? s.productCount : null;
  return { name: String(s.name ?? '').replace(/\s+/g, ' ').trim(), brands, products, legalForm: s.legalForm ? String(s.legalForm).trim() : null };
}

function groupLetter(name) {
  const c = slugify(name.slice(0, 1)).toUpperCase();
  return /^[A-Z]$/.test(c) ? c : /^[0-9]$/.test(c) ? '0-9' : 'inne';
}

/** Dokument 2: marki i domyślni dostawcy (osoby prawne) → części z packSections. */
export function renderSuppliersDoc(dump, { date = new Date().toISOString().slice(0, 10), maxChars = MAX_CHARS } = {}) {
  const generated = dateOf(dump, date);
  const suppliers = (Array.isArray(dump?.suppliers) ? dump.suppliers : []).map(normalizeSupplier).filter((s) => s.name !== '').sort((a, b) => a.name.localeCompare(b.name, 'pl'));
  const excluded = dump?.excluded ?? {};
  const groups = new Map();
  for (const s of suppliers) {
    const g = groupLetter(s.name);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  const sections = [...groups.entries()].map(([letter, list]) => {
    const L = [`## Dostawcy na literę ${letter}`, '', `Dostawcy (osoby prawne) o nazwie na literę ${letter} (${list.length}):`];
    for (const s of list) {
      const brands = s.brands.length ? s.brands.map((b) => (b.products !== null ? `${b.name} (${b.products} tow.)` : b.name)).join(', ') : 'brak przypisanych marek';
      const products = s.products !== null ? `${s.products}` : 'nieznana';
      L.push(`- Dostawca: ${s.name}${s.legalForm ? ` (${s.legalForm})` : ''} — marki: ${brands}; liczba towarów z tym domyślnym dostawcą: ${products}.`);
    }
    L.push('');
    return { name: `litera ${letter}`, text: L.join('\n') };
  });
  // Indeks odwrotny marka → dostawca (pytania „kto dostarcza markę X").
  const byBrand = new Map();
  for (const s of suppliers) for (const b of s.brands) {
    const key = b.name.toLowerCase();
    if (!byBrand.has(key)) byBrand.set(key, { name: b.name, suppliers: [] });
    byBrand.get(key).suppliers.push(s.name);
  }
  if (byBrand.size > 0) {
    const L = ['## Indeks marek', '', `Marka → domyślny dostawca (${plural(byBrand.size, 'marka', 'marki', 'marek')}):`];
    for (const b of [...byBrand.values()].sort((a, c) => a.name.localeCompare(c.name, 'pl'))) L.push(endSentence(`- Marka ${b.name} — dostawca: ${b.suppliers.join('; ')}`));
    L.push('');
    sections.push({ name: 'indeks marek', text: L.join('\n') });
  }
  const totalProducts = suppliers.reduce((a, s) => a + (s.products ?? 0), 0);
  const exclusions = [Number.isInteger(excluded.soleTraders) ? `jednoosobowe działalności gospodarcze pominięte: ${excluded.soleTraders}` : 'jednoosobowe działalności gospodarcze pominięte', Number.isInteger(excluded.noBrand) ? `dostawcy bez marek pominięci: ${excluded.noBrand}` : null].filter(Boolean).join('; ');
  const intro = `Lista marek towarów i ich domyślnych dostawców w instancji produkcyjnej ${INSTANCE} programu Subiekt GT (firma ilovelighting): ${plural(suppliers.length, 'dostawca', 'dostawców', 'dostawców')}, ${plural(byBrand.size, 'marka', 'marki', 'marek')}, ${plural(totalProducts, 'towar', 'towary', 'towarów')} z przypisanym domyślnym dostawcą, stan na ${generated}. Zakres: WYŁĄCZNIE dostawcy będący osobami prawnymi (spółki, firmy) — ${exclusions}; osoby fizyczne nie występują, bo nazwa jednoosobowej działalności to dane osobowe. Bez adresów, numerów NIP, kontaktów i uwag. Listę recenzuje właściciel w Inboxie przed promocją do bazy wiedzy. Źródło: pole „domyślny dostawca" kartoteki towarów (tw__Towar) i kartoteka kontrahentów (kh__Kontrahent), tylko nazwa i liczności.`;
  const keywords = [PRODUCT, INSTANCE, 'ilovelighting', 'marki', 'dostawcy', 'domyślny dostawca', 'producent', 'kto dostarcza', ...[...byBrand.values()].slice(0, 15).map((b) => b.name)];
  return packSections(sections, { title: 'Marki i domyślni dostawcy (osoby prawne)', intro, maxChars, keywords });
}

/** Pliki + wpisy manifestu (kształt jak emit() w prepare.mjs, zgodny z upload.mjs/promote.mjs). */
export function buildEntries({ slug, packed, sourceBase, category, product, keywords, sourceFile }) {
  const files = [];
  const entries = [];
  for (const p of packed) {
    const file = packed.length > 1 ? `${slug}-${p.part}.md` : `${slug}.md`;
    assertNoHost(p.text, file);
    files.push({ file, text: p.text });
    entries.push({
      file,
      title: p.title,
      sourceUrl: `${sourceBase}#dokumentacja/instancja/${slug}${packed.length > 1 ? `/${p.part}` : ''}`,
      category,
      product,
      part: p.part,
      parts: p.parts,
      chars: p.text.length,
      keywords,
      sourceFile,
    });
  }
  return { files, entries };
}

/** Próg k: zrzut ma pierwszeństwo (tłumienie już się odbyło); jawny --k inny niż w zrzucie = błąd. */
export function resolveK(dump, cliK) {
  const fromDump = Number.isInteger(dump?.k) && dump.k > 0 ? dump.k : null;
  const fromCli = cliK === null || cliK === undefined ? null : Number(cliK);
  if (fromCli !== null && (!Number.isInteger(fromCli) || fromCli < 1)) throw new Error(`--k musi być dodatnią liczbą całkowitą (podano ${cliK})`);
  if (fromDump !== null && fromCli !== null && fromDump !== fromCli) throw new Error(`--k ${fromCli} różni się od progu w zrzucie (k=${fromDump}) — dokument opisywałby inny próg niż zastosowany`);
  return fromDump ?? fromCli ?? DEFAULT_K;
}

/**
 * Cała generacja bez zapisu na dysk (testowalna): { files:[{file,text}], entries, skipped, k }.
 * Pusty zrzut (0 agregatów / 0 dostawców) NIE daje dokumentu (packSections bez sekcji = brak części) — trafia do `skipped`.
 */
export function generate({ aggregates, suppliers, k: cliK = null, sourceBase, product = PRODUCT, aggregatesFile = 'aggregates.json', suppliersFile = 'suppliers.json', date } = {}) {
  if (!sourceBase) throw new Error('brak --source-base');
  const k = resolveK(aggregates, cliK);
  const files = [];
  const entries = [];
  const skipped = [];
  const add = (sourceFile, slug, packed, category, keywords) => {
    if (packed.length === 0) {
      skipped.push({ file: sourceFile, reason: 'pusty zrzut — dokument pominięty' });
      return;
    }
    const r = buildEntries({ slug, packed, sourceBase, category, product, keywords, sourceFile });
    files.push(...r.files);
    entries.push(...r.entries);
  };
  if (aggregates) add(aggregatesFile, SLUG_AGGREGATES, renderAggregatesDoc(aggregates, { k, date }), CATEGORY_AGGREGATES, [PRODUCT, INSTANCE, 'agregaty instancji']);
  if (suppliers) add(suppliersFile, SLUG_SUPPLIERS, renderSuppliersDoc(suppliers, { date }), CATEGORY_SUPPLIERS, [PRODUCT, INSTANCE, 'marki', 'dostawcy']);
  return { files, entries, skipped, k };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, def = null) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : def;
  };
  const aggregatesPath = opt('--aggregates');
  const suppliersPath = opt('--suppliers');
  const outDir = opt('--out');
  const sourceBase = opt('--source-base');
  if ((!aggregatesPath && !suppliersPath) || !outDir || !sourceBase) {
    console.error('użycie: prepare-instance.mjs --aggregates <aggregates.json> --suppliers <suppliers.json> --out <dir> --source-base <url> [--k 10] [--product "Subiekt GT (Magnum_Profi)"]');
    process.exit(2);
  }
  const aggregates = aggregatesPath ? JSON.parse(readFileSync(aggregatesPath, 'utf8')) : null;
  const suppliers = suppliersPath ? JSON.parse(readFileSync(suppliersPath, 'utf8')) : null;
  let result;
  try {
    result = generate({ aggregates, suppliers, k: opt('--k'), sourceBase, product: opt('--product', PRODUCT), aggregatesFile: aggregatesPath ? basename(aggregatesPath) : undefined, suppliersFile: suppliersPath ? basename(suppliersPath) : undefined });
  } catch (err) {
    console.error(`błąd: ${err.message}`);
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });
  for (const f of result.files) writeFileSync(join(outDir, f.file), f.text);
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ source: `instancja ${INSTANCE}`, generatedAt: new Date().toISOString(), k: result.k, entries: result.entries, skipped: result.skipped }, null, 2));
  const total = result.entries.reduce((a, e) => a + e.chars, 0);
  console.log(`agregatów: ${aggregates?.aggregates?.length ?? 0}, dostawców: ${suppliers?.suppliers?.length ?? 0}, k=${result.k}, plików: ${result.entries.length}, znaków: ${total}, pominięte: ${result.skipped.length}`);
  for (const s of result.skipped) console.log(`  - ${s.file}: ${s.reason}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
