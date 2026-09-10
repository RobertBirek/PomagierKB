// Parser oficjalnej dokumentacji bazy InsERT GT (Dokumentacja_DB.xml z DBDokumentator3)
// i dokumentacji zmian (Dokumentacja_zmian_DB.xml). Oba pliki są w windows-1250 —
// wywołujący podaje już zdekodowany tekst (iconv-lite). Czysta logika, testowana na fixture.

import * as cheerio from 'cheerio';

function text($, el, sel) {
  const node = $(el).children(sel).first();
  return node.length ? node.text().trim() : '';
}

/**
 * @returns {{version, date, generator, tables: Record<string, DocTable>}}
 * DocTable = {name, author, description, ready, fields:[{name, description, type}],
 *             indexes:[{keys}], constraints:[{name, kind, reference, columns}], alerts:[string]}
 */
export function parseDbDocXml(xml) {
  const $ = cheerio.load(xml, { xml: true });
  const root = $('SQLDB').first();
  const out = {
    version: text($, root, 'Version'),
    date: text($, root, 'Date'),
    generator: text($, root, 'Generator'),
    tables: {},
  };
  root.children('Table').each((_, t) => {
    const name = text($, t, 'Name');
    if (!name) return;
    const table = {
      name,
      author: text($, t, 'Author') || null,
      description: text($, t, 'Description') || null,
      ready: $(t).attr('ready') === '1',
      fields: [],
      indexes: [],
      constraints: [],
      alerts: [],
    };
    $(t)
      .children('Field')
      .each((_, f) => {
        table.fields.push({
          name: text($, f, 'Name'),
          description: text($, f, 'Description') || null,
          type: text($, f, 'TypeDescription') || null,
        });
      });
    $(t)
      .children('Index')
      .each((_, i) => table.indexes.push({ keys: text($, i, 'Keys') }));
    $(t)
      .children('Constraint')
      .each((_, c) => {
        const cname = text($, c, 'Name');
        if (!cname) return;
        table.constraints.push({
          name: cname,
          kind: text($, c, 'TypeDescription') || null,
          reference: text($, c, 'Reference') || null,
          columns: text($, c, 'Description') || null,
        });
      });
    $(t)
      .children('Alert')
      .each((_, a) => table.alerts.push($(a).text().trim()));
    out.tables[name] = table;
  });
  return out;
}

/** Dokumentacja zmian między wersjami bazy (DBDiff). */
export function parseDbChangesXml(xml) {
  const $ = cheerio.load(xml, { xml: true });
  const root = $('DBDiff').first();
  const readTables = (sel) => {
    const list = [];
    root
      .children(sel)
      .children('Table')
      .each((_, t) => {
        const fields = [];
        $(t)
          .find('Fields > Field')
          .each((_, f) => {
            fields.push({
              name: text($, f, 'Name'),
              type: text($, f, 'Type') || null,
              description: text($, f, 'Desc') || null,
              state: text($, f, 'State') || null,
              oldType: text($, f, 'OldType') || null,
            });
          });
        list.push({ name: text($, t, 'Name'), author: text($, t, 'Author') || null, description: text($, t, 'Desc') || null, fields });
      });
    return list;
  };
  return {
    oldVersion: text($, root, 'OldVersion'),
    newVersion: text($, root, 'NewVersion'),
    date: text($, root, 'Date'),
    newTables: readTables('NewTabs'),
    deletedTables: readTables('DeletedTabs'),
    changedTables: readTables('ChangedTabs'),
  };
}

/** Render dokumentacji zmian do Markdown (jeden krótki dokument). */
export function renderDbChanges(changes, productLabel = 'InsERT GT', label = null) {
  const lines = [];
  const span = label ? `${label} (numery baz: ${changes.oldVersion} → ${changes.newVersion})` : `${changes.oldVersion} → ${changes.newVersion}`;
  lines.push(`# ${productLabel} — zmiany w bazie danych ${span}`);
  lines.push('');
  lines.push(`Dokumentacja zmian struktury bazy danych ${productLabel} między wersją ${span} (wygenerowana ${changes.date}). Wymienia nowe, usunięte i zmienione tabele oraz kolumny.`);
  lines.push('');
  // Bez nagłówków H2/H3: chunker tnie po nagłówkach i ten krótki dokument rozpadał się na 5 chunków
  // („Zmienione tabele" w innym chunku niż lista kolumn) — retrieval trafiał w nagłówek bez treści.
  const section = (title, list, withState) => {
    if (list.length === 0) {
      lines.push(`**${title}:** brak.`, '');
      return;
    }
    lines.push(`**${title}:**`, '');
    for (const t of list) {
      lines.push(`- Tabela \`${t.name}\`${t.description ? ` (${t.description})` : ''}:`);
      for (const f of t.fields) {
        const st = withState && f.state ? ` [${f.state}${f.oldType ? `, poprzednio ${f.oldType}` : ''}]` : '';
        lines.push(`  - \`${f.name}\` — ${f.type ?? '?'}${f.description ? ` — ${f.description}` : ''}${st}`);
      }
    }
    lines.push('');
  };
  section('Nowe tabele', changes.newTables, false);
  section('Usunięte tabele', changes.deletedTables, false);
  section('Zmienione tabele', changes.changedTables, true);
  return lines.join('\n');
}
