// PDF → Markdown na hoście (pdfjs-dist): linie po współrzędnej y, nagłówki po wysokości fontu,
// łączenie linii w akapity z usuwaniem dzielenia wyrazów, punktory z glifów prywatnych.
// Czysta logika (pageItemsToLines, linesToMarkdown) jest testowalna bez PDF.

// Punktory PDF: glify z fontów symbolicznych trafiają jako znaki sterujące (\u0001-\u001f) albo •·▪►▶◦§.
// eslint-disable-next-line no-control-regex
const BULLET_RE = /^[\u0001-\u001f\u2022\u00b7\u25aa\u25ba\u25b6\u25e6\u00a7]\s*$/;

/** Elementy pdfjs jednej strony → linie [{y, height, text, font}] od góry strony. */
export function pageItemsToLines(items) {
  const lines = [];
  for (const it of items) {
    const str = it.str ?? '';
    if (str === '') continue;
    const y = Math.round(it.transform[5]);
    const height = Math.round(it.height ?? 0);
    let line = lines.find((l) => Math.abs(l.y - y) <= 2);
    if (!line) {
      line = { y, height: 0, parts: [] };
      lines.push(line);
    }
    line.parts.push({ str, height, x: it.transform[4] });
    if (height > line.height) line.height = height;
  }
  lines.sort((a, b) => b.y - a.y);
  return lines.map((l) => {
    l.parts.sort((a, b) => a.x - b.x);
    let text = '';
    for (const p of l.parts) {
      const s = BULLET_RE.test(p.str) ? '- ' : p.str;
      if (text === '' || text.endsWith(' ') || s.startsWith(' ') || /^[,.;:)\]]/.test(s)) text += s;
      else text += ' ' + s;
    }
    return { y: l.y, height: l.height, text: text.replace(/\s+/g, ' ').trim() };
  }).filter((l) => l.text !== '');
}

/** Mediana wysokości linii tekstu ciągłego (do progu nagłówka). */
export function bodyHeight(allLines) {
  const hs = allLines.map((l) => l.height).filter((h) => h > 0).sort((a, b) => a - b);
  return hs.length ? hs[Math.floor(hs.length / 2)] : 9;
}

/**
 * Linie wszystkich stron → Markdown. Reguły: nagłówek gdy height ≥ body+3 (## ) lub ≥ body+1.5 i krótka linia (### );
 * numer strony (sama liczba, mała) pomijany; linie łączone w akapity; „wyraz-" + kontynuacja → sklejone.
 */
export function linesToMarkdown(pages, { body = null } = {}) {
  const all = pages.flat();
  const bh = body ?? bodyHeight(all);
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length === 0) return;
    let text = '';
    for (const l of para) {
      if (text === '') text = l;
      else if (/[A-Za-zĄ-ż]-$/.test(text) && /^[a-ząćęłńóśźż]/.test(l)) text = text.slice(0, -1) + l;
      else text += ' ' + l;
    }
    out.push(text, '');
    para = [];
  };
  for (const page of pages) {
    for (const l of page) {
      if (/^\d{1,4}$/.test(l.text) && l.height <= bh) continue; // numer strony
      if (l.height >= bh + 3 && l.text.length <= 120) {
        flush();
        out.push(`## ${l.text}`, '');
        continue;
      }
      if (l.height >= bh + 1.5 && l.text.length <= 80 && !/[.,;:]$/.test(l.text)) {
        flush();
        out.push(`### ${l.text}`, '');
        continue;
      }
      if (l.text.startsWith('- ')) {
        flush();
        para.push(l.text);
        continue;
      }
      if (para.length > 0 && para[0].startsWith('- ') && !l.text.startsWith('- ')) {
        para.push(l.text);
        continue;
      }
      para.push(l.text);
    }
    flush();
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Odczyt PDF przez pdfjs → {pages: [[lines]], numPages, textChars}. */
export async function extractPdfLines(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, disableFontFace: true }).promise;
  const pages = [];
  let textChars = 0;
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const lines = pageItemsToLines(tc.items);
    textChars += lines.reduce((a, l) => a + l.text.length, 0);
    pages.push(lines);
  }
  return { pages, numPages: doc.numPages, textChars };
}

/** Dzieli Markdown na sekcje po nagłówkach `## ` → [{name, text}] (wstęp = pierwsza). */
export function splitMarkdownSections(md) {
  const parts = md.split(/\n(?=## )/);
  return parts.map((t, i) => ({ name: i === 0 ? 'wstęp' : t.split('\n')[0].replace(/^## /, '').trim(), text: t.trim() + '\n\n' }));
}
