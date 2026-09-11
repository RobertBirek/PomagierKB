import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countTables } from '../lib/md-tables.mjs';
import { categoryFor, mergeManifest, normalizeMarkdown, planFragments, provenanceSentence, runPrepareMd, splitByHeading, stripNumbering } from '../prepare-md.mjs';

const wide = (prefix, n) => {
  const rows = Array.from({ length: n }, (_, i) => `| ${prefix}${i + 1} | **KPI ${prefix}${i + 1}** | Pytanie ${i}? | (A − B) / C × 100 | faktury, korekty | KPI card + linia | Mies. | Interpretacja ${'x'.repeat(60)} | Ryzyko ${'y'.repeat(60)} | [Src](https://example.com/${prefix}${i}) |`);
  return `| # | Nazwa KPI | Pytanie biznesowe | Formuła | Dane ERP | Typ wykresu | Częstotliwość | Interpretacja | Ryzyko | Źródła |\n|---|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}`;
};

const DOC = `# Tytuł raportu

> Plik wiedzy. Data: 2026-06.

---

## 1. Executive summary

Wstęp <b>pogrubiony</b> &amp; encje. Formuła IQR: <Q1−1,5·IQR lub >Q3+1,5·IQR.

| # | KPI | Dlaczego |
|---|-----|-------|
| 1 | **DSO** | Gotówka [Inv](https://example.com/dso) |
| 2 | **CCC** | — |

## 3. Katalog KPI i analiz

> Konwencja: każda pozycja zawiera formułę.

### 3.1 Wskaźniki finansowe (20+)

${wide('F', 12)}

### 3.2 Wskaźniki sprzedażowe (20+)

${wide('S', 12)}

## 7. Minimalny model danych (star schema)

| Tabela | Klucz | Pola |
|---|---|---|
| **dim_czas** | data | rok, miesiac |

12
Pozycja po samotnej liczbie

\`\`\`sql
-- komentarz
## nie nagłówek
SELECT 1;
\`\`\`

## Autokontrola kompletności (samoocena raportu)

| Wymaganie | Status |
|---|---|
| 20 KPI | ✅ |
`;

describe('prepare-md: normalizeMarkdown', () => {
  const out = normalizeMarkdown(DOC);
  it('HTML usunięty, encje zdekodowane, formuła z < i > zachowana, poziome kreski usunięte', () => {
    expect(out).toContain('Wstęp pogrubiony & encje.');
    expect(out).toContain('<Q1−1,5·IQR lub >Q3+1,5·IQR');
    expect(out).not.toMatch(/^---$/m);
    expect(out).not.toMatch(/\n{3,}/);
  });
  it('samotna liczba w linii doklejona do następnej; fence nietknięty', () => {
    expect(out).not.toMatch(/^\s*\d+\s*$/m);
    expect(out).toContain('12. Pozycja po samotnej liczbie');
    expect(out).toContain('```sql\n-- komentarz\n## nie nagłówek\nSELECT 1;\n```');
  });
  it('nagłówki ATX bez ogona, setext → ATX, <br> → nowa linia', () => {
    const n = normalizeMarkdown('## Tytuł ##\n\nAkapit\n---\n\nlinia<br>druga\n');
    expect(n).toContain('## Tytuł\n');
    expect(n).toContain('## Akapit');
    expect(n).toContain('linia\ndruga');
  });
});

describe('prepare-md: splitByHeading / categoryFor / stripNumbering', () => {
  it('dzieli po H2 z preambułą, nagłówek w fence ignorowany, body bez linii nagłówka', () => {
    const { preamble, sections } = splitByHeading(normalizeMarkdown(DOC).replace(/^# .+\n/, ''), 2);
    expect(preamble).toContain('Plik wiedzy');
    expect(sections.map((s) => s.heading)).toEqual(['1. Executive summary', '3. Katalog KPI i analiz', '7. Minimalny model danych (star schema)', 'Autokontrola kompletności (samoocena raportu)']);
    expect(sections[2].body).toContain('## nie nagłówek');
    expect(sections[1].body.startsWith('> Konwencja')).toBe(true);
  });
  it('mapa kategorii: H2 ma pierwszeństwo przed H3, brak reguły → domyślna', () => {
    expect(categoryFor(['3. Katalog KPI i analiz', '3.8 Operacje i jakość danych'], 'x')).toBe('katalog KPI');
    expect(categoryFor(['7. Minimalny model danych dla dashboardu (star schema)'], 'x')).toBe('model danych');
    expect(categoryFor(['6. Dane ERP potrzebne do analiz'], 'x')).toBe('model danych');
    expect(categoryFor(['9. Alerty i monitoring statusowy'], 'x')).toBe('jakość danych i alerty');
    expect(categoryFor(['10. Checklista jakości danych ERP'], 'x')).toBe('jakość danych i alerty');
    expect(categoryFor(['4. Katalog raportów ERP'], 'x')).toBe('katalog raportów');
    expect(categoryFor(['1. Cel raportu'], 'x')).toBe('przewodnik');
    expect(categoryFor(['5. Typy wykresów i kiedy ich używać'], 'x')).toBe('przewodnik');
    expect(categoryFor(['4. Propozycje dashboardów'], 'x')).toBe('dashboard');
    expect(categoryFor(['11. Rekomendacja końcowa', '11.8 Propozycja pierwszego MVP dashboardu (2-4 tygodnie)'], 'x')).toBe('dashboard');
    expect(categoryFor(['11. Rekomendacja końcowa', '11.2 Top 10 raportów dla zarządu'], 'x')).toBe('katalog raportów');
    expect(categoryFor(['11. Rekomendacja końcowa', '11.9 Lista pytań do właściciela firmy'], 'x')).toBe('przewodnik');
    expect(categoryFor(['11. Źródła'], 'domyślna')).toBe('domyślna');
  });
  it('stripNumbering', () => {
    expect(stripNumbering('3.1 Wskaźniki finansowe (20+)')).toBe('Wskaźniki finansowe (20+)');
    expect(stripNumbering('11. Rekomendacja')).toBe('Rekomendacja');
    expect(stripNumbering('Etap 1 — Szybkie zwycięstwa')).toBe('Etap 1 — Szybkie zwycięstwa');
  });
});

describe('prepare-md: planFragments', () => {
  const base = { slug: 'analizy-erp-katalog', category: 'przewodnik', keywords: ['analizy ERP', 'KPI'], fileName: 'ERP.md', fileId: 'FILE1', splitAbove: 2000 };
  it('sekcja H2 = dokument; duża sekcja → dokument per H3 z preambułą H2; drop pomija sekcję', () => {
    const { title, docs, skipped } = planFragments(DOC, { ...base, drop: 'Autokontrola kompletności' });
    expect(title).toBe('Tytuł raportu');
    expect(docs.map((d) => d.slug)).toEqual([
      'analizy-erp-katalog-executive-summary',
      'analizy-erp-katalog-katalog-kpi-i-analiz-wskazniki-finansowe-20',
      'analizy-erp-katalog-katalog-kpi-i-analiz-wskazniki-sprzedazowe-20',
      'analizy-erp-katalog-minimalny-model-danych-star-schema',
    ]);
    expect(docs[1].title).toBe('Tytuł raportu › 3. Katalog KPI i analiz › 3.1 Wskaźniki finansowe (20+)');
    expect(docs[1].sections[0].text.startsWith('> Konwencja: każda pozycja zawiera formułę.\n\n- **KPI F1** (F1) — Pytanie biznesowe: Pytanie 0?; Formuła:')).toBe(true);
    expect(docs[1].category).toBe('katalog KPI');
    expect(docs[3].category).toBe('model danych');
    expect(docs[1].keywords).toEqual(['analizy ERP', 'KPI', 'Katalog KPI i analiz', 'Wskaźniki finansowe (20+)']);
    expect(docs[1].intro).toBe(`Podsekcja „3.1 Wskaźniki finansowe (20+)" sekcji „3. Katalog KPI i analiz" raportu „Tytuł raportu". ${provenanceSentence('ERP.md', 'FILE1')}`);
    expect(skipped.map((s) => s.reason)).toEqual(['tekst przed pierwszą sekcją pominięty (29 zn. < 300)', 'sekcja pominięta (--drop)']);
  });
  it('tytuł z opcji ma pierwszeństwo nad H1; bez drop sekcja Autokontroli zostaje; mała sekcja z H3 nie jest dzielona', () => {
    const { title, docs } = planFragments(DOC, { ...base, title: 'Własny', splitAbove: 100_000 });
    expect(title).toBe('Własny');
    expect(docs.map((d) => d.h3)).toEqual([null, null, null, null]);
    expect(docs[1].sections[0].text).toContain('### 3.1 Wskaźniki finansowe (20+)');
    expect(docs[3].h2).toBe('Autokontrola kompletności (samoocena raportu)');
  });
});

describe('prepare-md: runPrepareMd (end-to-end do katalogu tymczasowego)', () => {
  let dir;
  let inFile1;
  let inFile2;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'prepare-md-'));
    inFile1 = join(dir, 'ERP_Analizy_Katalog_Wiedzy.md');
    inFile2 = join(dir, 'KB_ERP.md');
    writeFileSync(inFile1, DOC);
    writeFileSync(inFile2, DOC.replace('# Tytuł raportu', '# Baza wiedzy'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const common = { category: 'przewodnik', product: 'ERP (ogólne)', keywords: ['analizy ERP'], urlNs: 'analizy-erp', splitAbove: 2000 };

  it('pliki: H1 na starcie, zdanie proweniencji, zero tabel, zero samotnych liczb, ≤ maxChars', () => {
    const out = join(dir, 'out');
    const r = runPrepareMd({ ...common, inPath: inFile1, outDir: out, fileId: 'FILE1', slug: 'analizy-erp-katalog', drop: 'Autokontrola' });
    expect(r.entries.length).toBeGreaterThanOrEqual(4);
    for (const e of r.entries) {
      const text = readFileSync(join(out, e.file), 'utf8');
      expect(text.startsWith('# ')).toBe(true);
      expect(text).toContain('Źródło: raport analityczny „ERP_Analizy_Katalog_Wiedzy.md" z folderu Google Drive (id pliku FILE1), wygenerowany przez asystenta AI; zbiór generycznych definicji dla systemów ERP, nie dokumentacja InsERT.');
      expect(countTables(text)).toBe(0);
      expect(text.split('\n').some((l) => /^\s*\|/.test(l))).toBe(false);
      expect(text.split('\n').some((l) => /^\s*\d+\s*$/.test(l))).toBe(false);
      expect(text.length).toBeLessThanOrEqual(80_000);
      expect(e.chars).toBe(text.length);
    }
  });
  it('manifest: kształt wpisu jak w prepare.mjs, sourceUrl unikalny ze słowem „dokumentacja” i przestrzenią url-ns', () => {
    const m = JSON.parse(readFileSync(join(dir, 'out', 'manifest.json'), 'utf8'));
    expect(Object.keys(m)).toEqual(['source', 'generatedAt', 'entries', 'skipped']);
    expect(m.source).toBe('FILE1');
    for (const e of m.entries) {
      expect(Object.keys(e)).toEqual(['file', 'title', 'sourceUrl', 'category', 'product', 'part', 'parts', 'chars', 'keywords', 'sourceFile']);
      expect(e.sourceUrl.startsWith('https://drive.google.com/file/d/FILE1/view#dokumentacja/analizy-erp/analizy-erp-katalog-')).toBe(true);
      expect(e.product).toBe('ERP (ogólne)');
      expect(e.sourceFile).toBe('ERP_Analizy_Katalog_Wiedzy.md');
    }
    expect(new Set(m.entries.map((e) => e.sourceUrl)).size).toBe(m.entries.length);
    expect(m.skipped.some((s) => s.reason === 'sekcja pominięta (--drop)')).toBe(true);
  });
  it('drugi plik DOPISUJE się do manifestu (wpisy pierwszego zostają, source łączony)', () => {
    const out = join(dir, 'out');
    const before = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).entries.length;
    const r = runPrepareMd({ ...common, inPath: inFile2, outDir: out, fileId: 'FILE2', slug: 'analizy-erp-kb', drop: 'Autokontrola' });
    const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect(m.entries.length).toBe(before + r.entries.length);
    expect(m.source).toBe('FILE1,FILE2');
    expect(m.entries.filter((e) => e.sourceFile === 'ERP_Analizy_Katalog_Wiedzy.md').length).toBe(before);
    expect(new Set(m.entries.map((e) => e.sourceUrl)).size).toBe(m.entries.length);
  });
  it('ponowny przebieg tego samego pliku zastępuje jego wpisy i sprząta stare pliki', () => {
    const out = join(dir, 'out');
    const stale = join(out, 'analizy-erp-kb-minimalny-model-danych-star-schema.md');
    expect(existsSync(stale)).toBe(true);
    // teraz sekcję „model danych" pomijamy → jej plik z poprzedniego przebiegu ma zniknąć
    runPrepareMd({ ...common, inPath: inFile2, outDir: out, fileId: 'FILE2', slug: 'analizy-erp-kb', drop: 'Autokontrola|Minimalny model' });
    const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect(existsSync(stale)).toBe(false);
    expect(m.entries.filter((e) => e.sourceFile === 'KB_ERP.md').some((e) => e.file.includes('model-danych'))).toBe(false);
    expect(m.entries.filter((e) => e.sourceFile === 'ERP_Analizy_Katalog_Wiedzy.md').length).toBeGreaterThan(0);
    expect(m.skipped.filter((s) => s.file.startsWith('KB_ERP.md#')).length).toBe(3);
    expect(readdirSync(out).filter((f) => f.endsWith('.md')).length).toBe(m.entries.length);
  });
  it('mały maxChars → części z sufiksem pliku i /<część> w sourceUrl', () => {
    const out = join(dir, 'out-parts');
    const r = runPrepareMd({ ...common, inPath: inFile1, outDir: out, fileId: 'FILE1', slug: 's', drop: 'Autokontrola', maxChars: 2500 });
    const parts = r.entries.filter((e) => e.parts > 1);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0].file).toMatch(/-1\.md$/);
    expect(parts[0].sourceUrl).toMatch(/\/1$/);
    expect(parts[0].title).toMatch(/\(część 1\/\d+\)$/);
    expect(new Set(r.entries.map((e) => e.sourceUrl)).size).toBe(r.entries.length);
    for (const e of r.entries) expect(e.chars).toBeLessThanOrEqual(2500 + 600); // nagłówek+wstęp części dochodzi do budżetu sekcji
  });
  it('mergeManifest: kolizja sourceUrl z innym plikiem źródłowym = błąd', () => {
    const existing = { source: 'A', entries: [{ file: 'x.md', sourceUrl: 'u#dokumentacja/x', sourceFile: 'a.md' }], skipped: [] };
    expect(() => mergeManifest(existing, { source: 'B', entries: [{ file: 'y.md', sourceUrl: 'u#dokumentacja/x', sourceFile: 'b.md' }], skipped: [], sourceFile: 'b.md' })).toThrow(/już zajęty/);
  });
});
