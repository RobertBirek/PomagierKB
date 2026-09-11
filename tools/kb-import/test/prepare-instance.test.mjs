import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CATEGORY_AGGREGATES, CATEGORY_SUPPLIERS, PRODUCT, aggregateKeys, assertNoHost, generate, interpretation, isSuppressed, plural, renderAggregate, renderSuppliersDoc, resolveK } from '../prepare-instance.mjs';

const SOURCE_BASE = 'https://drive.google.com/drive/folders/FOLDER/baza-danych/Magnum_Profi';

/** Fixture zrzutu agregatów — pole `target` jest ŚLADEM HOSTA i nie może trafić do dokumentu. */
function aggregatesFixture() {
  return {
    database: 'Magnum_Profi',
    target: '192.168.1.20\\INSERTGT',
    generatedAt: '2026-09-11T08:00:00.000Z',
    k: 10,
    aggregates: [
      {
        id: 'kontrahenci-wg-wojewodztwa',
        title: 'Kontrahenci wg województwa i typu',
        description: 'Liczba aktywnych kontrahentów w podziale po województwie i typie (odbiorca/dostawca).',
        dimensions: ['wojewodztwo', 'typ'],
        metrics: ['count'],
        labels: { wojewodztwo: 'województwo' },
        kAnonymity: true,
        rows: [
          { wojewodztwo: 'podkarpackie', typ: 'odbiorca', count: 412 },
          { wojewodztwo: 'małopolskie', typ: 'odbiorca', count: 57 },
          { wojewodztwo: 'lubuskie', typ: 'odbiorca', count: null, suppressed: true },
          { wojewodztwo: 'opolskie', typ: 'dostawca', count: 3 },
        ],
        suppressed: 2,
      },
      {
        id: 'dokumenty-wg-typu-roku',
        title: 'Dokumenty wg typu i roku',
        rows: [
          { typ: 'FS', rok: 2024, count: 15234, sum_netto: 4321987.5 },
          { typ: 'FS', rok: 2025, count: 17001, sum_netto: 5100000 },
          { typ: 'ZK', rok: 2025, count: 8, sum_netto: 1200.25 },
        ],
        query: 'SELECT dok_Typ, YEAR(dok_DataWyst) AS rok, COUNT(*) AS count FROM dok__Dokument GROUP BY dok_Typ, YEAR(dok_DataWyst)',
      },
      {
        id: 'towary-razem',
        title: 'Liczba towarów w kartotece',
        rows: [{ count: 9876 }],
      },
    ],
  };
}

function suppliersFixture() {
  return {
    database: 'Magnum_Profi',
    target: 'DESKTOP-AB12CD\\INSERTGT',
    generatedAt: '2026-09-11T08:05:00.000Z',
    suppliers: [
      { name: 'Zeta Lighting Sp. z o.o.', brands: ['Zeta', { name: 'Zetalux', products: 40 }], products: 120, legalForm: 'sp. z o.o.' },
      { name: 'Alfa Oświetlenie S.A.', brands: ['Alfa'], productCount: 300 },
      { name: '3M Poland Sp. z o.o.', brands: [], products: 5 },
    ],
    excluded: { soleTraders: 17, noBrand: 4 },
  };
}

function run() {
  return generate({ aggregates: aggregatesFixture(), suppliers: suppliersFixture(), sourceBase: SOURCE_BASE, date: '2026-09-11' });
}

describe('prepare-instance: agregaty', () => {
  it('tłumione komórki renderują się jako „<10", a nie jako liczba ani puste pole', () => {
    const { files } = run();
    const md = files.find((f) => f.file === 'agregaty-instancji.md').text;
    expect(md).toContain('# Magnum_Profi — liczby o instancji (agregaty)');
    expect(md).toContain('wygenerowane z produkcyjnej bazy Subiekt GT ilovelighting narzędziem tools/mssql-introspect/dump-aggregates.mjs, tylko agregaty, komórki poniżej k=10 osób tłumione; brak danych osobowych');
    expect(md).toContain('stan na 2026-09-11');
    expect(md).toContain('- województwo: lubuskie, typ: odbiorca — liczba: <10');
    // kAnonymity: liczba 3 < k w agregacie o osobach → „<10"
    expect(md).toContain('- województwo: opolskie, typ: dostawca — liczba: <10');
    expect(md).not.toMatch(/opolskie, typ: dostawca — liczba: 3\b/);
    expect(md).toContain('- województwo: podkarpackie, typ: odbiorca — liczba: 412');
    // agregat bez kAnonymity: mała liczba dokumentów NIE jest tłumiona i nie ma zdania o „<10"
    expect(md).toContain('- typ: ZK, rok: 2025 — liczba: 8; sum netto: 1200.25');
    expect(md.split('## Dokumenty wg typu i roku')[1].split('## ')[0]).not.toContain('oznaczają komórkę stłumioną');
    expect(md.split('## Kontrahenci wg województwa i typu')[1].split('## ')[0]).toContain('Wartości „<10" oznaczają komórkę stłumioną (mniej niż 10 osób).');
    expect(md).toContain('- liczba: 9876');
  });
  it('sekcje to listy — żadnych tabel markdown (w szczególności >3 kolumn)', () => {
    const { files } = run();
    for (const f of files) {
      const lines = f.text.split('\n');
      expect(lines.some((l) => /^\s*\|/.test(l))).toBe(false);
      expect(lines.some((l) => (l.match(/\|/g) ?? []).length >= 4)).toBe(false);
    }
  });
  it('każdy agregat ma nagłówek H2, opis, listę i linię interpretacji; zapytanie w bloku sql', () => {
    const { files } = run();
    const md = files.find((f) => f.file === 'agregaty-instancji.md').text;
    expect(md).toContain('## Kontrahenci wg województwa i typu');
    expect(md).toContain('Liczba aktywnych kontrahentów w podziale po województwie');
    expect(md).toContain('Interpretacja: najwyższa wartość „liczba" przypada na województwo: podkarpackie, typ: odbiorca (412). Wierszy: 6, w tym stłumionych progiem k=10: 4.');
    expect(md).toContain('Interpretacja: liczba = 9876. Wierszy: 1.');
    expect(md).toContain('```sql\nSELECT dok_Typ');
    expect(md).toContain('Zawartość tej części: Kontrahenci wg województwa i typu, Dokumenty wg typu i roku, Liczba towarów w kartotece.');
  });
  it('miary i wymiary są wnioskowane z kluczy, gdy zrzut ich nie podaje', () => {
    const agg = aggregatesFixture().aggregates[1];
    expect(aggregateKeys(agg)).toEqual({ dimensions: ['typ', 'rok'], metrics: ['count', 'sum_netto'] });
    expect(isSuppressed(agg, agg.rows[2], 'count', 10)).toBe(false);
    expect(isSuppressed({ kAnonymity: true }, { count: 9 }, 'count', 10)).toBe(true);
    expect(isSuppressed({}, { count: '<10' }, 'count', 10)).toBe(true);
  });
  it('agregat bez wierszy i własna interpretacja', () => {
    const s = renderAggregate({ id: 'x', title: 'Pusty', rows: [], interpretation: 'nic tu nie ma' }, 10);
    expect(s.text).toContain('Brak wierszy');
    expect(s.text).toContain('Interpretacja: nic tu nie ma.');
    expect(interpretation({ kAnonymity: true, rows: [{ a: 'x', count: 2 }] }, { dimensions: ['a'], metrics: ['count'] }, 10)).toContain('wszystkie komórki poniżej progu k=10');
  });
});

describe('prepare-instance: marki i dostawcy', () => {
  it('H1, zakres (osoby prawne, JDG pominięte, recenzja w Inboxie), pozycja per dostawca i indeks marek', () => {
    const { files } = run();
    const md = files.find((f) => f.file === 'marki-dostawcy.md').text;
    expect(md.startsWith('# Marki i domyślni dostawcy (osoby prawne)\n')).toBe(true);
    expect(md).toContain('WYŁĄCZNIE dostawcy będący osobami prawnymi');
    expect(md).toContain('jednoosobowe działalności gospodarcze pominięte: 17');
    expect(md).toContain('Listę recenzuje właściciel w Inboxie');
    expect(md).toContain('- Dostawca: Zeta Lighting Sp. z o.o. (sp. z o.o.) — marki: Zeta, Zetalux (40 tow.); liczba towarów z tym domyślnym dostawcą: 120.');
    expect(md).toContain('- Dostawca: Alfa Oświetlenie S.A. — marki: Alfa; liczba towarów z tym domyślnym dostawcą: 300.');
    expect(md).toContain('- Dostawca: 3M Poland Sp. z o.o. — marki: brak przypisanych marek; liczba towarów z tym domyślnym dostawcą: 5.');
    expect(md).toContain('## Dostawcy na literę 0-9');
    expect(md).toContain('- Marka Zetalux — dostawca: Zeta Lighting Sp. z o.o.');
    expect(md).toContain('3 dostawców, 3 marki, 425 towarów');
    // nazwa kończąca się kropką (S.A., Sp. z o.o.) nie dostaje drugiej kropki
    expect(md).not.toContain('..');
  });
  it('liczebniki po polsku', () => {
    expect(plural(1, 'agregat', 'agregaty', 'agregatów')).toBe('1 agregat');
    expect(plural(3, 'agregat', 'agregaty', 'agregatów')).toBe('3 agregaty');
    expect(plural(12, 'agregat', 'agregaty', 'agregatów')).toBe('12 agregatów');
    expect(plural(22, 'agregat', 'agregaty', 'agregatów')).toBe('22 agregaty');
    expect(plural(0, 'marka', 'marki', 'marek')).toBe('0 marek');
  });
  it('pusty zrzut nie daje dokumentu — trafia do skipped manifestu', () => {
    expect(renderSuppliersDoc({ suppliers: [] }, { date: '2026-09-11' })).toEqual([]);
    const r = generate({ aggregates: { k: 10, aggregates: [] }, suppliers: { suppliers: [] }, sourceBase: SOURCE_BASE });
    expect(r.entries).toEqual([]);
    expect(r.skipped).toEqual([
      { file: 'aggregates.json', reason: 'pusty zrzut — dokument pominięty' },
      { file: 'suppliers.json', reason: 'pusty zrzut — dokument pominięty' },
    ]);
  });
});

describe('prepare-instance: manifest i ochrona hosta', () => {
  it('wpisy manifestu mają kształt emit() z prepare.mjs (upload.mjs/promote.mjs)', () => {
    const { entries, files } = run();
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(Object.keys(e).sort()).toEqual(['category', 'chars', 'file', 'keywords', 'part', 'parts', 'product', 'sourceFile', 'sourceUrl', 'title'].sort());
      expect(e.product).toBe(PRODUCT);
      expect(e.part).toBe(1);
      expect(e.parts).toBe(1);
      expect(e.chars).toBe(files.find((f) => f.file === e.file).text.length);
      expect(e.sourceUrl).toMatch(/#dokumentacja\/instancja\//);
    }
    const [agg, sup] = entries;
    expect(agg).toMatchObject({ file: 'agregaty-instancji.md', title: 'Magnum_Profi — liczby o instancji (agregaty)', sourceUrl: `${SOURCE_BASE}#dokumentacja/instancja/agregaty-instancji`, category: CATEGORY_AGGREGATES, sourceFile: 'aggregates.json' });
    expect(sup).toMatchObject({ file: 'marki-dostawcy.md', title: 'Marki i domyślni dostawcy (osoby prawne)', sourceUrl: `${SOURCE_BASE}#dokumentacja/instancja/marki-dostawcy`, category: CATEGORY_SUPPLIERS, sourceFile: 'suppliers.json' });
  });
  it('pole target zrzutu nigdy nie trafia do treści; ślad hosta w wartości wymiaru = błąd', () => {
    const { files } = run();
    for (const f of files) {
      expect(f.text).not.toContain('192.168');
      expect(f.text).not.toContain('INSERTGT');
      expect(f.text).not.toContain('DESKTOP-');
    }
    expect(() => assertNoHost('serwer 10.0.0.7 odpowiada')).toThrow(/hosta/);
    expect(() => assertNoHost('instancja SERWER\\INSERTGT')).toThrow(/hosta/);
    expect(() => assertNoHost('instancja produkcyjna Magnum_Profi, wersja 1.89 HF1')).not.toThrow();
    const bad = aggregatesFixture();
    bad.aggregates[1].rows.push({ typ: 'stanowisko 192.168.1.20', rok: 2025, count: 100, sum_netto: 1 });
    expect(() => generate({ aggregates: bad, sourceBase: SOURCE_BASE })).toThrow(/hosta/);
  });
  it('próg k: zrzut ma pierwszeństwo, sprzeczny --k to błąd, brak k w zrzucie → --k albo 10', () => {
    expect(resolveK({ k: 10 }, null)).toBe(10);
    expect(resolveK({ k: 10 }, '10')).toBe(10);
    expect(() => resolveK({ k: 10 }, '5')).toThrow(/różni się/);
    expect(resolveK({}, '7')).toBe(7);
    expect(resolveK({}, null)).toBe(10);
    expect(() => resolveK({}, '0')).toThrow(/dodatnią/);
    const md = generate({ aggregates: { ...aggregatesFixture(), k: undefined }, sourceBase: SOURCE_BASE, k: '5' }).files[0].text;
    expect(md).toContain('komórki poniżej k=5 osób tłumione');
    expect(md).toContain('lubuskie, typ: odbiorca — liczba: <5');
  });
  it('CLI: pisze pliki .md i manifest.json do katalogu wyjściowego', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prepare-instance-'));
    writeFileSync(join(dir, 'aggregates.json'), JSON.stringify(aggregatesFixture()));
    writeFileSync(join(dir, 'suppliers.json'), JSON.stringify(suppliersFixture()));
    const script = fileURLToPath(new URL('../prepare-instance.mjs', import.meta.url));
    const out = execFileSync(process.execPath, [script, '--aggregates', join(dir, 'aggregates.json'), '--suppliers', join(dir, 'suppliers.json'), '--out', join(dir, 'out'), '--source-base', SOURCE_BASE], { encoding: 'utf8' });
    expect(out).toContain('agregatów: 3, dostawców: 3, k=10, plików: 2');
    const manifest = JSON.parse(readFileSync(join(dir, 'out', 'manifest.json'), 'utf8'));
    expect(manifest.k).toBe(10);
    expect(manifest.entries.map((e) => e.file)).toEqual(['agregaty-instancji.md', 'marki-dostawcy.md']);
    expect(readFileSync(join(dir, 'out', 'agregaty-instancji.md'), 'utf8')).toContain('liczba: <10');
    expect(() => execFileSync(process.execPath, [script, '--aggregates', join(dir, 'aggregates.json'), '--out', join(dir, 'out2'), '--source-base', SOURCE_BASE, '--k', '3'], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
  });
});
