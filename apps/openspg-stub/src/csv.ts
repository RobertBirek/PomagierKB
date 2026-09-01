/** Prosty parser CSV zgodny z RFC 4180 (cudzysłowy, podwajanie "", \r\n, \n). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== '' || row.length > 0) pushRow();
  // odfiltruj całkiem puste wiersze (np. końcowy newline)
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Pierwszy wiersz jako nagłówek → tablica rekordów kolumna→wartość. */
export function csvToObjects(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) return [];
  return rows.slice(1).map((cells) => {
    const rec: Record<string, string> = {};
    header.forEach((col, idx) => {
      rec[col] = cells[idx] ?? '';
    });
    return rec;
  });
}
