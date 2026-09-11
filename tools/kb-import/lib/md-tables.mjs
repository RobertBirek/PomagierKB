// Tabele markdown → bloki rekordów. Czysta logika (zero IO) — testy w test/md-tables.test.mjs.
//
// Dlaczego: chunker panelu (apps/panel-api/src/pipeline/chunker.ts) tnie po każdym nagłówku i pakuje
// AKAPITY (rozdzielone pustą linią) do ~1800 znaków. Szeroka tabela (40 wierszy po 300–500 zn.)
// traci nagłówek już po pierwszym chunku — kolejne chunki to anonimowe komórki bez nazw kolumn.
// Rekord „**Nazwa** — Kolumna: wartość; Kolumna: wartość" w osobnym akapicie jest samoopisujący,
// więc każdy chunk retrievalu niesie pełen kontekst wiersza.

/** Wiersz separatora GFM: `|---|:--:|---|` (dwukropki wyrównania, spacje, opcjonalne skrajne kreski). */
const ALIGN_ROW_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const FENCE_RE = /^\s*```/;
/** Nagłówek kolumny numerującej (# / Lp. / Nr / L.p. / Poz.) — wartość idzie do nawiasu za nazwą. */
const NUMBERING_HEADER_RE = /^(#|lp\.?|l\.p\.|nr\.?|no\.?|poz\.?|id)$/i;
/** Komórki bez treści: pusta, sama kreska/półpauza/pauza. */
const EMPTY_CELL_RE = /^[\s\-–—]*$/;

/** Dzieli linię tabeli na komórki: pomija skrajne `|`, honoruje `\|` (escape), trimuje. */
export function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i += 1;
    } else if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

/** Czy linia wygląda na wiersz tabeli (ma nieescapowany `|`). */
function looksLikeRow(line) {
  return /(^|[^\\])\|/.test(line) && line.trim() !== '';
}

/**
 * Parsuje markdown na segmenty: {type:'text', text} | {type:'table', header, align, rows, raw}.
 * Świadomość code-fence'ów (tabela w ```...``` to tekst). Tabela GFM = wiersz nagłówka + wiersz
 * wyrównania (+ wiersze do pustej linii / linii bez `|` / nagłówka markdown).
 */
export function parseMarkdownTables(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const segments = [];
  let text = [];
  let inFence = false;
  const flushText = () => {
    if (text.length > 0) segments.push({ type: 'text', text: text.join('\n') });
    text = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      text.push(line);
      continue;
    }
    const next = lines[i + 1];
    // GFM: liczba komórek wiersza wyrównania musi równać się liczbie komórek nagłówka —
    // inaczej `tekst | tekst` nad linią `---` (pozioma kreska) udawałby tabelę.
    if (!inFence && looksLikeRow(line) && next !== undefined && ALIGN_ROW_RE.test(next) && splitRow(next).length === splitRow(line).length) {
      const header = splitRow(line);
      const align = splitRow(next).map((a) => (/^:-+:$/.test(a) ? 'center' : /-+:$/.test(a) ? 'right' : /^:-+$/.test(a) ? 'left' : null));
      const rows = [];
      const raw = [line, next];
      let j = i + 2;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (!looksLikeRow(l) || /^\s*#{1,6}\s/.test(l) || FENCE_RE.test(l)) break;
        raw.push(l);
        const cells = splitRow(l);
        // GFM: za mało komórek → dopełnienie pustymi, za dużo → obcięcie do nagłówka
        while (cells.length < header.length) cells.push('');
        rows.push(cells.slice(0, header.length));
      }
      flushText();
      segments.push({ type: 'table', header, align, rows, raw: raw.join('\n') });
      i = j - 1;
      continue;
    }
    text.push(line);
  }
  flushText();
  return segments;
}

/** Zdejmuje otaczające pogrubienie/kursywę z komórki (`**x**`, `__x__`, `*x*`), reszta bez zmian. */
export function stripEmphasis(cell) {
  let s = cell.trim();
  for (;;) {
    const m = /^(\*\*|__|\*|_)(.+)\1$/s.exec(s);
    if (!m) return s;
    s = m[2].trim();
  }
}

/** Czy tabela jest „szeroka”: ≥ minCols kolumn i choć jeden wiersz dłuższy niż minRowChars. */
export function isWideTable(table, { minCols = 3, minRowChars = 160 } = {}) {
  if (table.header.length < minCols) return false;
  return table.rows.some((r) => r.join(' | ').length > minRowChars);
}

/**
 * Tabela → lista rekordów, jeden wiersz = jeden punkt w OSOBNYM akapicie (pusta linia między
 * rekordami — chunker pakuje całe akapity, więc rekord nie jest cięty w środku):
 *   - **<komórka wiodąca>** (<kod z kolumny numerującej>) — Kolumna2: wartość; Kolumna3: wartość
 * Komórka wiodąca = pierwsza kolumna, chyba że to kolumna numerująca (#/Lp./Nr) — wtedy druga,
 * a numer trafia do nawiasu. Puste komórki i same kreski są pomijane.
 */
export function tableToRecordBlocks(table, { caption = null } = {}) {
  const header = table.header.map((h) => stripEmphasis(h));
  const numbering = header.length >= 2 && NUMBERING_HEADER_RE.test(header[0]);
  const leadIdx = numbering ? 1 : 0;
  const out = [];
  if (caption) out.push(caption);
  for (const row of table.rows) {
    if (row.every((c) => EMPTY_CELL_RE.test(c))) continue;
    let lead = stripEmphasis(row[leadIdx] ?? '');
    let leadIdxUsed = leadIdx;
    if (EMPTY_CELL_RE.test(lead)) {
      leadIdxUsed = row.findIndex((c, i) => i !== (numbering ? 0 : -1) && !EMPTY_CELL_RE.test(c));
      if (leadIdxUsed < 0) continue;
      lead = stripEmphasis(row[leadIdxUsed]);
    }
    const code = numbering && !EMPTY_CELL_RE.test(row[0]) ? stripEmphasis(row[0]) : null;
    const pairs = [];
    for (let i = 0; i < header.length; i++) {
      if (i === leadIdxUsed || (numbering && i === 0)) continue;
      const v = (row[i] ?? '').trim();
      if (EMPTY_CELL_RE.test(v)) continue;
      pairs.push(header[i] ? `${header[i]}: ${v}` : v);
    }
    let codeLabel = '';
    if (code !== null) codeLabel = header[0] === '#' ? ` (${code})` : ` (${header[0]} ${code})`;
    out.push(`- **${lead}**${codeLabel}${pairs.length ? ` — ${pairs.join('; ')}` : ''}`);
  }
  return out.join('\n\n');
}

/**
 * Zamienia KAŻDĄ tabelę markdown na blok rekordów (wąskie tabele też — lista jest bezpieczna
 * dla chunkera, tabela nie). Zwraca markdown; wokół bloku pusta linia.
 */
export function convertTablesToRecords(md, opts = {}) {
  const segments = parseMarkdownTables(md);
  const parts = segments.map((s) => (s.type === 'table' ? `\n${tableToRecordBlocks(s, opts)}\n` : s.text));
  return parts.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Liczba tabel markdown pozostałych w tekście (po konwersji powinna być 0). */
export function countTables(md, { minCols = 1 } = {}) {
  return parseMarkdownTables(md).filter((s) => s.type === 'table' && s.header.length >= minCols).length;
}
