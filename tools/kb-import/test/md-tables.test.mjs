import { describe, expect, it } from 'vitest';
import { convertTablesToRecords, countTables, isWideTable, parseMarkdownTables, splitRow, stripEmphasis, tableToRecordBlocks } from '../lib/md-tables.mjs';

const KPI = `## 3.1 Wskaźniki finansowe

| # | Nazwa KPI | Pytanie biznesowe | Formuła | Źródła |
|---|---|---|---|---|
| F1 | **Przychód (Revenue)** | Ile sprzedaliśmy? | Σ wartość netto pozycji | [Citrin](https://example.com/a) |
| F2 | **Korelacja** | Co zależy od czego? | \\|r\\|>0,7 = silna | — |
| F3 | **Pusta** |  | (Net Sales − COGS) / Net Sales × 100 |  |

Tekst po tabeli.
`;

describe('md-tables: splitRow / stripEmphasis', () => {
  it('dzieli po nieescapowanych | i odtwarza \\|', () => {
    expect(splitRow('| a | \\|r\\|>0,7 | c |')).toEqual(['a', '|r|>0,7', 'c']);
    expect(splitRow('a|b')).toEqual(['a', 'b']);
    expect(splitRow('|  |x|')).toEqual(['', 'x']);
  });
  it('zdejmuje pogrubienie i kursywę z komórki', () => {
    expect(stripEmphasis('**Marża brutto**')).toBe('Marża brutto');
    expect(stripEmphasis('*x*')).toBe('x');
    expect(stripEmphasis('**Wariant 1**: a; **Wariant 2**: b')).toBe('**Wariant 1**: a; **Wariant 2**: b');
  });
});

describe('md-tables: parseMarkdownTables', () => {
  it('rozpoznaje tabelę w sekcji: nagłówek, wiersz wyrównania, wiersze, tekst przed i po', () => {
    const seg = parseMarkdownTables(KPI);
    expect(seg.map((s) => s.type)).toEqual(['text', 'table', 'text']);
    const t = seg[1];
    expect(t.header).toEqual(['#', 'Nazwa KPI', 'Pytanie biznesowe', 'Formuła', 'Źródła']);
    expect(t.rows).toHaveLength(3);
    expect(t.rows[1][3]).toBe('|r|>0,7 = silna');
    expect(t.rows[2][2]).toBe('');
    expect(seg[2].text).toContain('Tekst po tabeli.');
  });
  it('wyrównanie: :--: / --: / :--', () => {
    const [t] = parseMarkdownTables('| a | b | c | d |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |');
    expect(t.align).toEqual(['left', 'center', 'right', null]);
  });
  it('tabela w bloku kodu to tekst; linia z | nad --- (pozioma kreska) to nie tabela', () => {
    const md = '```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n\nx | y\n---\n';
    expect(parseMarkdownTables(md).every((s) => s.type === 'text')).toBe(true);
  });
  it('dopełnia brakujące komórki i obcina nadmiarowe', () => {
    const [t] = parseMarkdownTables('| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |');
    expect(t.rows).toEqual([['1', '', ''], ['1', '2', '3']]);
  });
  it('tabela kończy się na pustej linii lub nagłówku', () => {
    const seg = parseMarkdownTables('| a | b |\n|---|---|\n| 1 | 2 |\n## Dalej | tekst\n| 3 | 4 |');
    expect(seg[0].type).toBe('table');
    expect(seg[0].rows).toEqual([['1', '2']]);
  });
});

describe('md-tables: tableToRecordBlocks', () => {
  const table = parseMarkdownTables(KPI)[1];
  it('jeden wiersz = jeden rekord w osobnym akapicie; kolumna # idzie do nawiasu, nazwa wiodąca bez pogrubienia', () => {
    const out = tableToRecordBlocks(table);
    const recs = out.split('\n\n');
    expect(recs).toHaveLength(3);
    expect(recs[0]).toBe('- **Przychód (Revenue)** (F1) — Pytanie biznesowe: Ile sprzedaliśmy?; Formuła: Σ wartość netto pozycji; Źródła: [Citrin](https://example.com/a)');
    expect(recs[1]).toContain('Formuła: |r|>0,7 = silna');
  });
  it('puste komórki i same kreski są pomijane', () => {
    const out = tableToRecordBlocks(table);
    expect(out).not.toContain('Źródła: —');
    expect(out.split('\n\n')[2]).toBe('- **Pusta** (F3) — Formuła: (Net Sales − COGS) / Net Sales × 100');
  });
  it('Lp. w nagłówku → „(Lp. 1)”; bez kolumny numerującej pierwsza komórka jest wiodąca', () => {
    const [t] = parseMarkdownTables('| Lp. | KPI | Etap |\n|---|---|---|\n| 1 | DSO | 1 |');
    expect(tableToRecordBlocks(t)).toBe('- **DSO** (Lp. 1) — Etap: 1');
    const [u] = parseMarkdownTables('| Tabela | Klucz |\n|---|---|\n| **dim_czas** | data |');
    expect(tableToRecordBlocks(u)).toBe('- **dim_czas** — Klucz: data');
  });
  it('pusta komórka wiodąca → następna niepusta; wiersz całkiem pusty pominięty', () => {
    const [t] = parseMarkdownTables('| a | b | c |\n|---|---|---|\n|  | B | C |\n|  |  |  |');
    expect(tableToRecordBlocks(t)).toBe('- **B** — c: C');
  });
  it('isWideTable: ≥3 kolumny i wiersz > 160 znaków', () => {
    expect(isWideTable(table, { minRowChars: 20 })).toBe(true);
    expect(isWideTable(table, { minRowChars: 10_000 })).toBe(false);
    const [n] = parseMarkdownTables('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(isWideTable(n)).toBe(false);
  });
});

describe('md-tables: convertTablesToRecords', () => {
  it('po konwersji nie zostaje żadna tabela, tekst i nagłówki zachowane, brak potrójnych pustych linii', () => {
    const out = convertTablesToRecords(KPI);
    expect(countTables(out)).toBe(0);
    expect(out).toContain('## 3.1 Wskaźniki finansowe');
    expect(out).toContain('Tekst po tabeli.');
    expect(out).toContain('- **Przychód (Revenue)** (F1)');
    expect(out).not.toMatch(/\n{3,}/);
    expect(out.split('\n').some((l) => /^\s*\|/.test(l))).toBe(false);
  });
  it('kilka tabel w dokumencie i tabela w fence nietknięta', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |\n\ntekst\n\n| c | d |\n|---|---|\n| 3 | 4 |\n\n```\n| k | l |\n|---|---|\n```\n';
    const out = convertTablesToRecords(md);
    expect(out).toContain('- **1** — b: 2');
    expect(out).toContain('- **3** — d: 4');
    expect(out).toContain('```\n| k | l |\n|---|---|\n```');
  });
});
