import { describe, expect, it } from 'vitest';
import { decodeHtml, parseConfirmForm, parseFolderListing, safeName } from '../lib/drive.mjs';

const LISTING = `
<div class="flip-entry" id="entry-1N61E5Ox"><a href="https://drive.google.com/drive/folders/1N61E5Ox" target="_blank"><div class="flip-entry-title">Pomoc</div></a></div>
<div class="flip-entry" id="entry-1vOO6X7i"><a href="https://drive.google.com/file/d/1vOO6X7i/view?usp=drive_web" target="_blank"><div class="flip-entry-title">Biuro_GT.pdf</div></a></div>
<div class="flip-entry" id="entry-1HwwsnG5"><a href="https://drive.google.com/file/d/1HwwsnG5/view?usp=drive_web"><div class="flip-entry-title">Komunikacja_EDI++_1_12.pdf</div></a></div>`;

describe('drive: parseFolderListing', () => {
  it('rozpoznaje foldery i pliki z id i nazwą w kolejności', () => {
    const e = parseFolderListing(LISTING);
    expect(e).toEqual([
      { id: '1N61E5Ox', name: 'Pomoc', kind: 'folder' },
      { id: '1vOO6X7i', name: 'Biuro_GT.pdf', kind: 'file' },
      { id: '1HwwsnG5', name: 'Komunikacja_EDI++_1_12.pdf', kind: 'file' },
    ]);
  });
  it('pusty HTML → pusta lista', () => {
    expect(parseFolderListing('<html></html>')).toEqual([]);
  });
});

describe('drive: parseConfirmForm', () => {
  it('składa URL pobrania z action i pól hidden (strona „virus scan")', () => {
    const html = `<form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
      <input type="hidden" name="id" value="1abc"><input type="hidden" name="export" value="download">
      <input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u-1"></form>`;
    const url = new URL(parseConfirmForm(html));
    expect(url.origin + url.pathname).toBe('https://drive.usercontent.google.com/download');
    expect(url.searchParams.get('confirm')).toBe('t');
    expect(url.searchParams.get('id')).toBe('1abc');
  });
  it('brak formularza → null', () => {
    expect(parseConfirmForm('<html>nic</html>')).toBeNull();
  });
});

describe('drive: safeName / decodeHtml', () => {
  it('usuwa separatory, spacje i wiodące kropki', () => {
    expect(safeName('../a b/c:d?.pdf')).toBe('_a_b_c_d_.pdf');
    expect(safeName('')).toBe('bez-nazwy');
  });
  it('dekoduje podstawowe encje', () => {
    expect(decodeHtml('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;')).toBe('a & b <c> "d" \'e\'');
  });
});
