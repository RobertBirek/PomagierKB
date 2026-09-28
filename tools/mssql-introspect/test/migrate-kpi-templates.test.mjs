import { describe, expect, it } from 'vitest';
import { splitKpiDoc, slugify } from '../migrate-kpi-templates.mjs';
import { parseTemplate } from '../src/templates.mjs';

const DOC = `# Magnum_Profi — KPI: sprzedaż i marża (szablony SQL)

Wstęp partii.

## Zasady wspólne dla wszystkich szablonów

- FS+PA, status 1.

## KPI 1 — Przychód netto ze sprzedaży — miesięcznie

- Definicja: suma netto.

Szablon SQL (T-SQL):

\`\`\`sql
-- zakres: zamień daty (pełny rok 2025; przedział półotwarty [od, do))
SELECT SUM(d.dok_WartNetto) AS net
FROM dbo.dok__Dokument d
WHERE d.dok_DataWyst >= '2025-01-01'
  AND d.dok_DataWyst <  '2026-01-01'
\`\`\`

- Pułapki: brak.
- Test: zakres 2025-01-01 – 2026-01-01, 12 wierszy, wykonano 2026-09-14.

## Realizacja zamówień (ZK)

- Definicja: dwa zapytania.

\`\`\`sql
SELECT COUNT(*) FROM dbo.dok__Dokument WHERE dok_Typ = 16 AND dok_DataWyst >= '2025-01-01' AND dok_DataWyst < '2026-01-01' AND dok_DataWyst <> '2025-06-01'
\`\`\`

Lista otwartych:

\`\`\`sql
SELECT dok_Id FROM dbo.dok__Dokument WHERE dok_Typ = 16 AND dok_DataWyst < DATEADD(day, -7, GETDATE())
\`\`\`

## Słownik kodów użytych w szablonach

- 2 = FS.
`;

describe('slugify', () => {
  it('ascii kebab-case z polskich znaków, bez prefiksu KPI', () => {
    expect(slugify('KPI 3 — Aging należności (0–30 / 31–60)')).toBe('aging-naleznosci-0-30-31-60');
    expect(slugify('Ile zarobiliśmy dzisiaj / wczoraj — przychód dzienny')).toBe('ile-zarobilismy-dzisiaj-wczoraj-przychod-dzienny');
  });
});

describe('splitKpiDoc', () => {
  const r = splitKpiDoc(DOC, { area: 'sprzedaz', fallbackVerified: '2026-09-14' });
  it('wstęp i sekcje wspólne → zasady; słownik kodów na końcu zasad', () => {
    expect(r.rules).toContain('Wstęp partii.');
    expect(r.rules).toContain('## Zasady wspólne dla wszystkich szablonów');
    expect(r.rules.indexOf('## Słownik kodów')).toBeGreaterThan(r.rules.indexOf('## Zasady wspólne'));
    expect(r.rules).not.toContain('# Magnum_Profi');
  });
  it('czysty zakres dat → @od/@do z przykładami; plik przechodzi parseTemplate', () => {
    const t = r.templates[0];
    expect(t.id).toBe('przychod-netto-ze-sprzedazy-miesiecznie');
    expect(t.raw).toContain('>= @od');
    expect(t.raw).toContain('<  @do');
    expect(t.raw).not.toContain('Szablon SQL (T-SQL):');
    expect(t.raw).not.toContain('- Test:');
    const p = parseTemplate(t.raw, { file: `sprzedaz/${t.id}.md`, area: 'sprzedaz' });
    expect(p.error).toBeUndefined();
    expect(p.template.params.od.example).toBe('2025-01-01');
    expect(p.template.verified).toBe('2026-09-14');
    expect(t.flags).toContain('pytania do uzupełnienia');
  });
  it('dwa bloki SQL → dwa szablony (wariant 2), niejednoznaczne daty i GETDATE oflagowane', () => {
    const zk = r.templates.filter((t) => t.id.startsWith('realizacja-zamowien-zk'));
    expect(zk.map((t) => t.id)).toEqual(['realizacja-zamowien-zk', 'realizacja-zamowien-zk-2']);
    expect(zk[0].flags.join(' ')).toMatch(/literały dat: 3/);
    expect(zk[1].flags.join(' ')).toMatch(/GETDATE/);
    expect(zk[1].flags.join(' ')).toMatch(/dwa bloki SQL/);
    for (const t of zk) expect(parseTemplate(t.raw, { file: `sprzedaz/${t.id}.md`, area: 'sprzedaz' }).error).toBeUndefined();
  });
});
