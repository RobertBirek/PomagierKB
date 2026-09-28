import { describe, expect, it } from 'vitest';
import { generateKpiDocs, mergeManifest, paramLine, renderAreaDoc, MAX_DOC_CHARS } from '../prepare-kpi.mjs';

const T = (over = {}) => ({
  id: 'sales-net-monthly', title: 'Przychód netto — miesięcznie', area: 'sprzedaz', order: 10,
  questions: ['Ile wyniósł przychód?'], verified: '2026-09-28', file: 'sprzedaz/sales-net-monthly.md',
  params: { od: { type: 'date', required: true, description: 'początek', example: '2025-01-01' }, n: { type: 'int', required: false, description: 'top N', example: 10, default: 10 } },
  body: '- Definicja: suma.\n\n```sql\nSELECT 1 WHERE x >= @od\n```\n\n- Pułapki: brak.',
  sql: 'SELECT 1 WHERE x >= @od', ...over,
});
const catalog = {
  templates: [T(), T({ id: 'b', title: 'Drugi', order: 5, file: 'sprzedaz/b.md' }), T({ id: 'c', title: 'Finanse C', area: 'finanse', file: 'finanse/c.md' }), T({ id: 'd', title: 'Magazyn D', area: 'magazyn', file: 'magazyn/d.md' })],
  rules: { sprzedaz: '## Zasady wspólne\n\nFS+PA.', finanse: '## Model\n\nx', magazyn: '## Wspólne\n\ny' },
  rulesMeta: { finanse: { owner: 'firma F', license: 'licencja F', date: '2026-09-14' }, sprzedaz: {} },
};
const KONW = '---\nowner: ilovelighting\nlicense: wewnętrzna\ndate: 2026-09-28\n---\n# Magnum_Profi — konwencje i semantyka instancji\n\ntreść';
/** Front matter na samym początku, dokładnie jeden nagłówek `# `, brak drugiego bloku `---`. */
function expectDocShape(text, keys) {
  expect(text.startsWith('---\n')).toBe(true);
  const end = text.indexOf('\n---\n', 4);
  expect(end).toBeGreaterThan(0);
  const head = text.slice(4, end).split('\n').map((l) => l.split(':')[0]);
  expect(head).toEqual(keys);
  expect(text.split('\n').filter((l) => l.startsWith('# '))).toHaveLength(1);
  expect(text.slice(end + 5).split('\n').some((l) => l === '---')).toBe(false);
}
const SB = 'https://kag.ilovelighting.sanok.pl/src/magnum-profi';

describe('renderAreaDoc', () => {
  const text = renderAreaDoc({ area: 'sprzedaz', templates: catalog.templates.filter((t) => t.area === 'sprzedaz'), rules: catalog.rules.sprzedaz });
  it('front matter źródła na początku (domyślne owner/license, date = max verified), jeden H1', () => {
    expectDocShape(text, ['owner', 'license', 'date']);
    expect(text.startsWith('---\nowner: ilovelighting (instancja produkcyjna Magnum_Profi)\nlicense: użytek wewnętrzny — mapowanie KPI na SQL, bez danych osobowych\ndate: 2026-09-28\n---\n# Magnum_Profi — KPI: sprzedaż i marża (szablony SQL)\n')).toBe(true);
  });
  it('metadane z zasad obszaru; date to najpóźniejsza weryfikacja szablonów, nie data zasad', () => {
    const fin = [T({ area: 'finanse', verified: '2026-09-20' }), T({ id: 'x', area: 'finanse', verified: '2026-09-27' })];
    const t = renderAreaDoc({ area: 'finanse', templates: fin, rules: '## Model\n\nx', meta: catalog.rulesMeta.finanse });
    expectDocShape(t, ['owner', 'license', 'date']);
    expect(t).toContain('owner: firma F\nlicense: licencja F\ndate: 2026-09-27\n---\n# Magnum_Profi — KPI: finanse i klienci (szablony SQL)\n\n## Model');
  });
  it('tytuł, zasady, szablony wg order, parametry, wykonanie, weryfikacja', () => {
    expect(text.indexOf('## Zasady wspólne')).toBeLessThan(text.indexOf('## Drugi'));
    expect(text.indexOf('## Drugi')).toBeLessThan(text.indexOf('## Przychód netto — miesięcznie'));
    expect(text).toContain('- `@od` (date) — początek; przykład: 2025-01-01');
    expect(text).toContain('- `@n` (int, opcjonalny, domyślnie 10) — top N; przykład: 10');
    expect(text).toContain('Wykonanie: `run_template sales-net-monthly`');
    expect(text).toContain('Zweryfikowano na produkcji: 2026-09-28');
    expect(text).toContain('Przykładowe pytania: Ile wyniósł przychód?');
  });
  it('deterministyczny', () => {
    expect(renderAreaDoc({ area: 'sprzedaz', templates: catalog.templates.filter((t) => t.area === 'sprzedaz'), rules: catalog.rules.sprzedaz })).toBe(text);
  });
});

describe('paramLine', () => {
  it('enum: dozwolone wartości; text: limit długości', () => {
    expect(paramLine('mag', { type: 'enum', required: false, description: 'magazyn', example: 1, values: [1, 5, 6] }))
      .toBe('- `@mag` (enum, opcjonalny) — magazyn; przykład: 1; dozwolone: 1, 5, 6');
    expect(paramLine('marka', { type: 'text', required: true, description: 'marka', example: 'Rabalux', maxLength: 60 }))
      .toBe('- `@marka` (text) — marka; przykład: Rabalux; maks. 60 znaków');
  });
});

describe('mergeManifest', () => {
  const mine = [{ file: 'kpi-sprzedaz.md', chars: 2 }];
  it('scala z poprzednim: cudze wpisy zostają, własne zastąpione', () => {
    const prev = JSON.stringify({ namespace: 'IloveKB', entries: [{ file: 'dostawcy.md' }, { file: 'kpi-sprzedaz.md', chars: 1 }] });
    expect(mergeManifest(prev, mine, 'T')).toEqual({ namespace: 'IloveKB', generatedAt: 'T', entries: [{ file: 'dostawcy.md' }, ...mine] });
  });
  it('brak poprzedniego (null) = nowy manifest', () => {
    expect(mergeManifest(null, mine, 'T')).toEqual({ generatedAt: 'T', entries: mine });
  });
  it('uszkodzony manifest = błąd (nie nadpisujemy)', () => {
    expect(() => mergeManifest('{"entries": [', mine, 'T')).toThrow(/manifest\.json.*uszkodzony/);
    expect(() => mergeManifest('[]', mine, 'T')).toThrow(/manifest\.json.*uszkodzony/);
  });
});

describe('generateKpiDocs', () => {
  const r = generateKpiDocs({ catalog, konwencje: KONW, sourceBase: SB });
  it('każdy dokument zaczyna się od front mattera i ma jeden H1', () => {
    for (const f of r.files) expectDocShape(f.text, ['owner', 'license', 'date']);
  });
  it('odmawia konwencji bez front mattera na początku', () => {
    expect(() => generateKpiDocs({ catalog, konwencje: '# Magnum_Profi — konwencje\n\ntreść', sourceBase: SB })).toThrow(/konwencje-instancji\.md.*front matter/);
  });
  it('4 pliki z tymi samymi tytułami i sourceUrl co w IloveKB', () => {
    expect(r.files.map((f) => f.file)).toEqual(['kpi-sprzedaz.md', 'kpi-finanse.md', 'kpi-magazyn.md', 'konwencje-instancji.md']);
    const byFile = Object.fromEntries(r.entries.map((e) => [e.file, e]));
    expect(byFile['kpi-sprzedaz.md']).toMatchObject({ title: 'Magnum_Profi — KPI: sprzedaż i marża (szablony SQL)', sourceUrl: `${SB}#dokumentacja/instancja/kpi-sprzedaz`, category: 'mapowanie KPI → SQL', part: 1, parts: 1 });
    expect(byFile['kpi-finanse.md'].sourceUrl).toBe(`${SB}#dokumentacja/instancja/kpi-finanse`);
    expect(byFile['kpi-magazyn.md'].title).toBe('Magnum_Profi — KPI: magazyn i zakupy (szablony SQL)');
    expect(byFile['konwencje-instancji.md']).toMatchObject({ title: 'Magnum_Profi — konwencje i semantyka instancji', sourceUrl: `${SB}#dokumentacja/instancja/konwencje`, category: 'konwencje instancji' });
    expect(byFile['kpi-sprzedaz.md'].keywords).toContain('Przychód netto — miesięcznie');
    expect(byFile['kpi-sprzedaz.md'].chars).toBe(r.files[0].text.length);
  });
  it('odmawia dokumentu ponad limit uploadu', () => {
    const huge = T({ body: `x${'y'.repeat(MAX_DOC_CHARS)}\n\n\`\`\`sql\nSELECT 1 WHERE x >= @od\n\`\`\`` });
    expect(() => generateKpiDocs({ catalog: { ...catalog, templates: [huge] }, konwencje: KONW, sourceBase: SB })).toThrow(/kpi-sprzedaz\.md.*95000/);
  });
  it('odmawia bez sourceBase i przy adresie hosta bazy w treści', () => {
    expect(() => generateKpiDocs({ catalog, konwencje: KONW })).toThrow(/sourceBase/);
    expect(() => generateKpiDocs({ catalog, konwencje: `${KONW}\nserwer 192.168.1.20\\INSERTGT`, sourceBase: SB })).toThrow(/adres hosta/);
  });
});
