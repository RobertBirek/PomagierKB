// Wspólny model katalogu bazy (tabele/kolumny/klucze/indeksy/moduły) i renderer do Markdown.
// Używany przez tools/mssql-introspect (żywa baza) i przez parser DDL ze skryptów SQL, żeby
// oba źródła dawały identyczny format — wtedy diff i retrieval działają na tym samym kształcie.
//
// Zasady renderu (z recenzji projektu): kolumny jako LISTY, nie tabele markdown (chunker 1800 zn.
// rozcina tabele bez nagłówka); żadnych samotnych liczb w osobnych liniach (profil czyszczenia
// kasuje „numery stron"); nagłówek H1 + streszczenie na górze (analyze widzi 12k zn.).

/** Prefiks modułu z nazwy tabeli InsERT GT: `tw__Towar` → `tw`, `sl_Uzytkownik` → `sl`. */
export function modulePrefix(tableName) {
  const m = /^([A-Za-z]+?)_+/.exec(tableName);
  return m ? m[1].toLowerCase() : 'inne';
}

/** Czytelny typ SQL Server z metadanych sys.columns. */
export function formatSqlType(typeName, maxLength, precision, scale) {
  const t = String(typeName).toLowerCase();
  if (['nvarchar', 'nchar'].includes(t)) return maxLength === -1 ? `${t}(max)` : `${t}(${maxLength / 2})`;
  if (['varchar', 'char', 'binary', 'varbinary'].includes(t)) return maxLength === -1 ? `${t}(max)` : `${t}(${maxLength})`;
  if (['decimal', 'numeric'].includes(t)) return `${t}(${precision},${scale})`;
  if (['datetime2', 'time', 'datetimeoffset'].includes(t) && scale !== undefined && scale !== null && scale !== 7) return `${t}(${scale})`;
  return t;
}

export function tableKey(schema, name) {
  return `${schema}.${name}`;
}

/** Pusty katalog. */
export function emptyCatalog(meta = {}) {
  return { meta, tables: {}, modules: [] };
}

export function ensureTable(catalog, schema, name) {
  const key = tableKey(schema, name);
  if (!catalog.tables[key]) {
    catalog.tables[key] = {
      schema,
      name,
      description: null,
      columns: [],
      pk: [],
      uniques: [],
      fks: [],
      referencedBy: [],
      indexes: [],
      rows: null,
    };
  }
  return catalog.tables[key];
}

/** Grupuje tabele po prefiksie modułu → Map(prefix → [table...]) posortowane. */
export function groupByModule(catalog) {
  const groups = new Map();
  for (const t of Object.values(catalog.tables)) {
    const p = modulePrefix(t.name);
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(t);
  }
  for (const list of groups.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return new Map([...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function colLine(c, pkSet) {
  const flags = [];
  flags.push(c.nullable ? 'NULL' : 'NOT NULL');
  if (c.identity) flags.push('identity');
  if (pkSet.has(c.name)) flags.push('PK');
  if (c.computed) flags.push(`obliczana: ${c.computed}`);
  if (c.default) flags.push(`domyślnie ${c.default}`);
  const desc = c.description ? ` — ${c.description}` : '';
  return `- \`${c.name}\` — ${c.type}, ${flags.join(', ')}${desc}`;
}

/** Render jednej tabeli jako sekcja H3 (lista kolumn, klucze, indeksy, odwołania). */
export function renderTable(t, opts = {}) {
  const pkSet = new Set(t.pk);
  const lines = [];
  lines.push(`### ${t.schema}.${t.name}`);
  lines.push('');
  if (t.description) lines.push(`Opis: ${t.description}`, '');
  lines.push(`Kolumny tabeli ${t.name} (${t.columns.length}):`);
  for (const c of t.columns) lines.push(colLine(c, pkSet));
  lines.push('');
  if (t.pk.length > 0) lines.push(`Klucz główny: ${t.pk.map((c) => `\`${c}\``).join(', ')}.`);
  for (const u of t.uniques) lines.push(`Unikalność ${u.name}: ${u.cols.map((c) => `\`${c}\``).join(', ')}.`);
  for (const fk of t.fks) {
    const act = [fk.onDelete && fk.onDelete !== 'NO_ACTION' ? `ON DELETE ${fk.onDelete}` : null, fk.onUpdate && fk.onUpdate !== 'NO_ACTION' ? `ON UPDATE ${fk.onUpdate}` : null].filter(Boolean);
    lines.push(`Klucz obcy ${fk.name}: ${fk.cols.map((c) => `\`${c}\``).join(', ')} → ${fk.refTable}(${fk.refCols.join(', ')})${act.length ? ' ' + act.join(' ') : ''}.`);
  }
  if (t.referencedBy.length > 0) {
    lines.push(`Tabele odwołujące się do ${t.name}: ${t.referencedBy.map((r) => `${r.fromTable}(${r.cols.join(', ')})`).join('; ')}.`);
  }
  const idx = t.indexes.filter((i) => !i.primaryKey);
  if (idx.length > 0) {
    lines.push('Indeksy:');
    for (const i of idx) {
      const inc = i.includes?.length ? ` INCLUDE (${i.includes.join(', ')})` : '';
      const filt = i.filter ? ` WHERE ${i.filter}` : '';
      lines.push(`- ${i.name} (${i.type.toLowerCase()}${i.unique ? ', unikalny' : ''}): ${i.cols.join(', ')}${inc}${filt}`);
    }
  }
  if (t.rows !== null && t.rows !== undefined && opts.rows !== false) lines.push(`Liczba wierszy (z metadanych partycji): ${t.rows}.`);
  lines.push('');
  return lines.join('\n');
}

/** Render definicji modułu (widok/procedura/funkcja/trigger) z przycięciem. */
export function renderModule(m, maxDefChars = 6000) {
  const lines = [];
  const kind = { VIEW: 'Widok', SQL_STORED_PROCEDURE: 'Procedura składowana', SQL_SCALAR_FUNCTION: 'Funkcja skalarna', SQL_INLINE_TABLE_VALUED_FUNCTION: 'Funkcja tabelaryczna (inline)', SQL_TABLE_VALUED_FUNCTION: 'Funkcja tabelaryczna', SQL_TRIGGER: 'Trigger' }[m.type] ?? m.type;
  lines.push(`### ${kind} ${m.schema}.${m.name}`);
  lines.push('');
  if (m.parentTable) lines.push(`Tabela: ${m.parentTable}.`);
  if (m.params?.length) {
    lines.push('Parametry:');
    for (const p of m.params) lines.push(`- \`${p.name || '(zwracana wartość)'}\` — ${p.type}${p.output ? ', OUTPUT' : ''}`);
  }
  if (m.definition) {
    let def = m.definition.replace(/\r\n/g, '\n').trim();
    let note = '';
    if (def.length > maxDefChars) {
      def = def.slice(0, maxDefChars);
      note = `\n(definicja przycięta do ${maxDefChars} znaków z ${m.definition.length})`;
    }
    lines.push('', '```sql', def, '```' + note);
  } else {
    lines.push('Definicja niedostępna w katalogu (obiekt utworzony WITH ENCRYPTION albo brak uprawnienia VIEW DEFINITION) — znana jest tylko sygnatura.');
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Dzieli listę sekcji na części ≤ maxChars (każda część dostaje nagłówek i streszczenie).
 * Zwraca [{title, text, part, parts, tables:[nazwy]}].
 */
export function packSections(sections, { title, intro, maxChars = 80_000, keywords = [] }) {
  sections = sections.flatMap((s) => (s.text.length > maxChars ? splitLargeSection(s, maxChars) : [s]));
  const chunks = [];
  let current = [];
  let currentLen = 0;
  const flush = () => {
    if (current.length > 0) chunks.push(current);
    current = [];
    currentLen = 0;
  };
  for (const s of sections) {
    if (currentLen + s.text.length > maxChars && current.length > 0) flush();
    current.push(s);
    currentLen += s.text.length;
  }
  flush();
  const parts = chunks.length;
  return chunks.map((list, i) => {
    const part = i + 1;
    const suffix = parts > 1 ? ` (część ${part}/${parts})` : '';
    const names = list.map((s) => s.name);
    const head = [
      `# ${title}${suffix}`,
      '',
      intro,
      '',
      `Zawartość tej części: ${names.join(', ')}.`,
      keywords.length ? `Słowa kluczowe: ${keywords.join(', ')}.` : '',
      '',
    ].filter((l, idx, arr) => !(l === '' && arr[idx - 1] === ''));
    return { title: `${title}${suffix}`, part, parts, names, text: head.join('\n') + '\n' + list.map((s) => s.text).join('\n') };
  });
}

/** Sekcja większa niż limit → kawałki po nagłówkach (##/###), a gdy nadal za duże — po pustych liniach. */
export function splitLargeSection(section, maxChars) {
  const byHeading = section.text.split(/\n(?=#{2,4} )/);
  const pieces = [];
  for (const piece of byHeading) {
    if (piece.length <= maxChars) {
      pieces.push(piece);
      continue;
    }
    let buf = '';
    for (const para of piece.split(/\n\n+/)) {
      if (buf.length + para.length + 2 > maxChars && buf !== '') {
        pieces.push(buf);
        buf = '';
      }
      buf += (buf === '' ? '' : '\n\n') + para;
    }
    if (buf !== '') pieces.push(buf);
  }
  // scalanie małych kawałków do limitu, żeby nie mnożyć sekcji
  const merged = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.length + p.length + 1 <= maxChars) merged[merged.length - 1] = last + '\n' + p;
    else merged.push(p);
  }
  return merged.map((text, i) => ({ name: `${section.name}${merged.length > 1 ? ` (${i + 1})` : ''}`, text: text.endsWith('\n') ? text : text + '\n' }));
}

/** Front-matter honorowany przez apps/panel-api/src/pipeline/frontmatter.ts (owner/license/date). */
export function frontMatter({ owner, license, date }) {
  const lines = ['---'];
  if (owner) lines.push(`owner: ${owner}`);
  if (license) lines.push(`license: ${license}`);
  if (date) lines.push(`date: ${date}`);
  lines.push('---', '');
  return lines.join('\n');
}
