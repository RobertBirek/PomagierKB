// Scalanie: żywy katalog (typy/klucze/indeksy) + opisy z Dokumentacja_DB.xml + raport różnic.
// Wynik: katalog wzbogacony o description tabel/kolumn i lista rozbieżności dokumentacja ↔ baza.

import { tableKey } from './catalog-md.mjs';

/**
 * Nakłada opisy z dokumentacji na katalog (in place) i liczy różnice.
 * @returns diff = {docsOnlyTables, liveOnlyTables, docsOnlyColumns, liveOnlyColumns, typeMismatch, alerts, describedTables, describedColumns}
 */
export function mergeDocsIntoCatalog(catalog, docs, { schema = 'dbo' } = {}) {
  const diff = {
    docsVersion: docs.version,
    docsDate: docs.date,
    docsOnlyTables: [],
    liveOnlyTables: [],
    docsOnlyColumns: [],
    liveOnlyColumns: [],
    typeMismatch: [],
    alerts: [],
    describedTables: 0,
    describedColumns: 0,
  };
  const liveByName = new Map();
  for (const t of Object.values(catalog.tables)) liveByName.set(t.name.toLowerCase(), t);

  for (const doc of Object.values(docs.tables)) {
    const live = liveByName.get(doc.name.toLowerCase());
    for (const a of doc.alerts) diff.alerts.push({ table: doc.name, alert: a });
    if (!live) {
      if (doc.fields.length > 0) diff.docsOnlyTables.push(doc.name);
      continue;
    }
    if (doc.description) {
      live.description = doc.description;
      diff.describedTables += 1;
    }
    if (doc.author) live.author = doc.author;
    const liveCols = new Map(live.columns.map((c) => [c.name.toLowerCase(), c]));
    const docCols = new Map(doc.fields.map((f) => [f.name.toLowerCase(), f]));
    for (const f of doc.fields) {
      const c = liveCols.get(f.name.toLowerCase());
      if (!c) {
        diff.docsOnlyColumns.push({ table: doc.name, column: f.name, type: f.type });
        continue;
      }
      if (f.description) {
        c.description = f.description;
        diff.describedColumns += 1;
      }
      if (f.type && !typesCompatible(c.type, f.type)) {
        diff.typeMismatch.push({ table: doc.name, column: f.name, live: c.type, docs: f.type });
      }
    }
    for (const c of live.columns) {
      if (!docCols.has(c.name.toLowerCase())) diff.liveOnlyColumns.push({ table: live.name, column: c.name, type: c.type });
    }
  }
  const docNames = new Set(Object.keys(docs.tables).map((n) => n.toLowerCase()));
  for (const t of Object.values(catalog.tables)) {
    if (t.schema === schema && !docNames.has(t.name.toLowerCase())) diff.liveOnlyTables.push(tableKey(t.schema, t.name));
  }
  diff.docsOnlyTables.sort();
  diff.liveOnlyTables.sort();
  return diff;
}

/** `varchar (255)` (docs) vs `varchar(255)` / `TNazwa (varchar(50))` (live) — porównanie po normalizacji. */
export function typesCompatible(liveType, docType) {
  const squash = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '');
  const l = squash(liveType);
  const d = squash(docType);
  if (l === d) return true;
  // live z aliasem: "tnazwa(varchar(50))" → alias "tnazwa" i typ bazowy "varchar(50)"
  const m = /^([a-z_][a-z0-9_]*)\((.+)\)$/.exec(l);
  if (m && (m[1] === d || m[2] === d)) return true;
  // docs bez długości dla typów o stałej długości / z (max)
  if (d === l.replace(/\(max\)$/, '') || l === d.replace(/\(max\)$/, '') || d.replace('(-1)', '(max)') === l) return true;
  // docs dopisuje długość do typów bez parametru długości (ntext (1073741823), int (4)...)
  if (!l.includes('(') && d.replace(/\(\d+\)$/, '') === l) return true;
  return false;
}

/** Raport różnic do Markdown. */
export function renderDiff(diff, { productLabel = 'InsERT GT', database = '', sourceName = '' } = {}) {
  const L = [];
  L.push(`# ${productLabel} — różnice: dokumentacja bazy ${diff.docsVersion} a żywa baza ${database}`);
  L.push('');
  L.push(`Porównanie oficjalnej dokumentacji bazy danych ${productLabel} (wersja ${diff.docsVersion}, z ${diff.docsDate}) z katalogiem żywej bazy ${database} (${sourceName}). Pokazuje tabele i kolumny obecne tylko w jednym źródle, różnice typów oraz ostrzeżenia generatora dokumentacji. Opisy tabel przeniesiono do dokumentów modułów.`);
  L.push('');
  L.push(`Opisanych tabel: ${diff.describedTables}. Opisanych kolumn: ${diff.describedColumns}.`);
  L.push('');
  const list = (title, items, fmt) => {
    L.push(`## ${title}`, '');
    if (items.length === 0) {
      L.push('Brak.', '');
      return;
    }
    for (const i of items) L.push(`- ${fmt(i)}`);
    L.push('');
  };
  list('Tabele tylko w dokumentacji (brak w żywej bazie)', diff.docsOnlyTables, (n) => `\`${n}\``);
  list('Tabele tylko w żywej bazie (brak w dokumentacji — obiekty firmowe, integracje, InsSearch)', diff.liveOnlyTables, (n) => `\`${n}\``);
  list('Kolumny tylko w dokumentacji', diff.docsOnlyColumns, (c) => `\`${c.table}.${c.column}\` (${c.type ?? '?'})`);
  list('Kolumny tylko w żywej bazie', diff.liveOnlyColumns, (c) => `\`${c.table}.${c.column}\` (${c.type})`);
  list('Różnice typów', diff.typeMismatch, (c) => `\`${c.table}.${c.column}\`: baza ${c.live}, dokumentacja ${c.docs}`);
  L.push('## Ostrzeżenia generatora dokumentacji (DBDokumentator)', '');
  if (diff.alerts.length === 0) L.push('Brak.', '');
  else {
    const grouped = new Map();
    for (const a of diff.alerts) {
      const key = a.alert.replace(/\[[^\]]*\]/g, '[…]');
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(a);
    }
    for (const [key, items] of grouped) {
      L.push(`- ${key} — ${items.length} wystąpień, np. ${items.slice(0, 5).map((i) => `${i.table}${/\[/.test(i.alert) ? ' ' + i.alert.match(/\[[^\]]*\]/)[0] : ''}`).join(', ')}`);
    }
    L.push('');
  }
  return L.join('\n');
}
