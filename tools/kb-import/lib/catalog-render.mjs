// Render całego katalogu do plików .md + wpisy manifestu (jeden format dla żywej bazy i DDL).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { groupByModule, packSections, renderModule, renderTable } from './catalog-md.mjs';

/** Nazwy modułów InsERT GT po prefiksie tabeli (znane z dokumentacji; reszta = „moduł <prefiks>"). */
export const INSERT_GT_MODULES = {
  tw: 'towary i usługi (kartoteka asortymentu)',
  dok: 'dokumenty handlowe i magazynowe',
  ob: 'pozycje dokumentów (obroty)',
  kh: 'kontrahenci',
  adr: 'adresy',
  sl: 'słowniki',
  pd: 'parametry i dane podmiotu',
  nz: 'należności i zobowiązania (rozrachunki)',
  rk: 'rachunki bankowe i kasa',
  vat: 'rejestry VAT',
  st: 'stany magazynowe',
  mg: 'magazyny',
  pr: 'pracownicy (Gratyfikant)',
  gr: 'Gratyfikant (kadry i płace)',
  ks: 'księgowość (Rewizor)',
  dk: 'dekrety księgowe (Rewizor)',
  kp: 'księga przychodów i rozchodów (Rachmistrz)',
  ew: 'ewidencje (Rachmistrz)',
  ge: 'Gestor (CRM)',
  wd: 'wydruki i wzorce',
  us: 'użytkownicy i uprawnienia',
  zad: 'zadania i działania (Gestor)',
  cd: 'cechy i definicje',
  ce: 'ceny',
  pa: 'parametry',
  ck: 'cenniki',
  gt: 'InsERT GT — wspólne',
  vw: 'widoki pomocnicze',
  in: 'InsERT — wewnętrzne',
  inne: 'pozostałe tabele',
};

function moduleLabel(prefix, labels) {
  const l = labels[prefix];
  return l ? `moduł ${prefix} — ${l}` : `moduł ${prefix}`;
}

/**
 * @param catalog model z catalog-md
 * @param opts {outDir, productLabel, sourceName ('mssql://host/db' | 'Skrypty_SQL_1_89_HF1'), sourceUrlBase,
 *              owner, license, date, category, maxChars, labels, keywordsBase, includeModules}
 * @returns wpisy manifestu [{file, title, sourceUrl, category, product, part, parts, chars}]
 */
export function renderCatalogToFiles(catalog, opts) {
  const {
    outDir,
    productLabel,
    sourceName,
    sourceUrlBase,
    owner = 'InsERT S.A.',
    license = 'dokumentacja producenta (użytek wewnętrzny)',
    date,
    category = 'opis tabeli bazy danych',
    maxChars = 80_000,
    labels = INSERT_GT_MODULES,
    keywordsBase = [],
    includeModules = true,
    definitionCaps = {},
  } = opts;
  mkdirSync(outDir, { recursive: true });
  const entries = [];
  const fm = ''; // front-matter wyłączony do czasu wdrożenia poprawki GAP-03 (patrz prepare.mjs)
  const provenance = `Właściciel treści: ${owner}; licencja: ${license}; data zrzutu: ${date}.`;
  const write = (slug, packed, extraKeywords) => {
    for (const p of packed) {
      const file = packed.length > 1 ? `${slug}-${p.part}.md` : `${slug}.md`;
      const text = fm + p.text;
      writeFileSync(join(outDir, file), text);
      entries.push({
        file,
        title: p.title,
        sourceUrl: `${sourceUrlBase}#dokumentacja/${slug}${packed.length > 1 ? `/${p.part}` : ''}`,
        category,
        product: productLabel,
        part: p.part,
        parts: p.parts,
        chars: text.length,
        keywords: extraKeywords,
      });
    }
  };

  // Przegląd: lista modułów i tabel (mały, jeden plik).
  const groups = groupByModule(catalog);
  const overview = [];
  overview.push(`# ${productLabel} — baza danych: przegląd modułów i tabel`);
  overview.push('');
  overview.push(`Źródło: ${sourceName}. Zawiera wyłącznie metadane katalogu (nazwy tabel, kolumn, typy, klucze, indeksy, definicje widoków i procedur) — bez danych wierszowych. ${provenance}`);
  if (catalog.meta?.server) {
    const s = catalog.meta.server;
    overview.push('');
    overview.push(`Serwer: ${String(s.version ?? '').split('\n')[0]}. Edycja: ${s.edition ?? '?'}. Instancja: ${s.instanceName ?? '(domyślna)'}. Collation: ${s.collation ?? '?'}.`);
  }
  if (catalog.meta?.database) overview.push(`Baza danych: ${catalog.meta.database}. Tabel: ${Object.keys(catalog.tables).length}. Modułów SQL (widoki/procedury/funkcje/triggery): ${catalog.modules.length}.`);
  if (catalog.aliasTypes && Object.keys(catalog.aliasTypes).length > 0) {
    overview.push('');
    overview.push('Typy aliasowe zdefiniowane w bazie (nazwa → typ bazowy):');
    for (const [n, base] of Object.entries(catalog.aliasTypes)) overview.push(`- \`${n}\` = ${base}`);
  }
  overview.push('');
  overview.push('Moduły (prefiks nazwy tabeli → zawartość):');
  for (const [prefix, tables] of groups) {
    overview.push(`- ${moduleLabel(prefix, labels)}: ${tables.length} tabel — ${tables.map((t) => t.name).join(', ')}`);
  }
  overview.push('');
  write('00-przeglad', [{ title: `${productLabel} — baza danych: przegląd modułów i tabel`, part: 1, parts: 1, text: overview.join('\n') }], ['schemat bazy', 'lista tabel']);

  // Moduły: jeden plik (lub części) per prefiks.
  for (const [prefix, tables] of groups) {
    const sections = tables.map((t) => ({ name: t.name, text: renderTable(t) }));
    const title = `${productLabel} — baza danych: ${moduleLabel(prefix, labels)}`;
    const intro = `Opis tabel modułu \`${prefix}\` w bazie ${productLabel} (${sourceName}): kolumny z typami SQL Server, klucze główne i obce, indeksy, tabele powiązane. Metadane katalogu, bez danych. ${provenance}`;
    const keywords = [...keywordsBase, `tabele ${prefix}_`, ...tables.slice(0, 12).map((t) => t.name)];
    write(`modul-${prefix}`, packSections(sections, { title, intro, maxChars, keywords }), keywords);
  }

  if (includeModules && catalog.modules.length > 0) {
    const byType = new Map();
    for (const m of catalog.modules) {
      if (!byType.has(m.type)) byType.set(m.type, []);
      byType.get(m.type).push(m);
    }
    const typeSlug = { VIEW: 'widoki', SQL_STORED_PROCEDURE: 'procedury', SQL_SCALAR_FUNCTION: 'funkcje-skalarne', SQL_INLINE_TABLE_VALUED_FUNCTION: 'funkcje-tabelaryczne-inline', SQL_TABLE_VALUED_FUNCTION: 'funkcje-tabelaryczne', SQL_TRIGGER: 'triggery' };
    for (const [type, list] of byType) {
      list.sort((a, b) => a.name.localeCompare(b.name));
      const slug = typeSlug[type] ?? type.toLowerCase();
      const sections = list.map((m) => ({ name: m.name, text: renderModule(m, definitionCaps[type] ?? 6000) }));
      const title = `${productLabel} — baza danych: ${slug.replaceAll('-', ' ')}`;
      const intro = `Definicje obiektów SQL typu ${slug.replaceAll('-', ' ')} w bazie ${productLabel} (${sourceName}): sygnatury z katalogu, treść ze skryptów producenta (żywe obiekty są zaszyfrowane). Bez danych. ${provenance}`;
      const keywords = [...keywordsBase, slug, ...list.slice(0, 12).map((m) => m.name)];
      write(`sql-${slug}`, packSections(sections, { title, intro, maxChars, keywords }), keywords);
    }
  }
  return entries;
}
