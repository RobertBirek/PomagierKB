import { describe, expect, it } from 'vitest';
import { generateKpiDocs, renderAreaDoc, MAX_DOC_CHARS } from '../prepare-kpi.mjs';

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
};
const SB = 'https://kag.ilovelighting.sanok.pl/src/magnum-profi';

describe('renderAreaDoc', () => {
  const text = renderAreaDoc({ area: 'sprzedaz', templates: catalog.templates.filter((t) => t.area === 'sprzedaz'), rules: catalog.rules.sprzedaz });
  it('tytuł, zasady, szablony wg order, parametry, wykonanie, weryfikacja', () => {
    expect(text.startsWith('# Magnum_Profi — KPI: sprzedaż i marża (szablony SQL)\n')).toBe(true);
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

describe('generateKpiDocs', () => {
  const r = generateKpiDocs({ catalog, konwencje: '# Magnum_Profi — konwencje i semantyka instancji\n\ntreść', sourceBase: SB });
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
    expect(() => generateKpiDocs({ catalog: { ...catalog, templates: [huge] }, konwencje: 'k', sourceBase: SB })).toThrow(/kpi-sprzedaz\.md.*95000/);
  });
  it('odmawia bez sourceBase i przy adresie hosta bazy w treści', () => {
    expect(() => generateKpiDocs({ catalog, konwencje: 'k' })).toThrow(/sourceBase/);
    expect(() => generateKpiDocs({ catalog, konwencje: 'serwer 192.168.1.20\\INSERTGT', sourceBase: SB })).toThrow(/adres hosta/);
  });
});
