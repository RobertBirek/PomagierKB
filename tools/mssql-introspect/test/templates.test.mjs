import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractParamNames, loadCatalog, localDate, parseTemplate, searchTemplates, setVerified, splitFrontMatter, validateParams,
} from '../src/templates.mjs';

const GOOD = `---
id: sales-net-monthly
title: Przychód netto ze sprzedaży — miesięcznie
area: sprzedaz
order: 10
questions:
  - Ile wyniósł przychód netto we wrześniu 2026?
params:
  od: { type: date, description: początek zakresu (włącznie), example: 2025-01-01 }
  do: { type: date, description: koniec zakresu (wyłącznie), example: 2026-01-01 }
verified: 2026-09-14
---
- Definicja: suma netto FS i PA.

\`\`\`sql
SELECT SUM(d.dok_WartNetto) AS net_sales
FROM dbo.dok__Dokument d
WHERE d.dok_Typ IN (2, 21) AND d.dok_Status = 1
  AND d.dok_DataWyst >= @od AND d.dok_DataWyst < @do
\`\`\`

- Pułapki: brak.
`;

const tmpDirs = [];
function catalog(files) {
  const dir = mkdtempSync(join(tmpdir(), 'tpl-'));
  tmpDirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  }
  return dir;
}
afterEach(() => { while (tmpDirs.length) rmSync(tmpDirs.pop(), { recursive: true, force: true }); });

describe('splitFrontMatter', () => {
  it('toleruje BOM i CRLF', () => {
    const r = splitFrontMatter(`\uFEFF${GOOD.replace(/\n/g, '\r\n')}`);
    expect(r).not.toBeNull();
    expect(r.meta).toContain('id: sales-net-monthly');
    expect(r.body).toContain('```sql');
  });
  it('null bez nagłówka', () => {
    expect(splitFrontMatter('# tylko treść')).toBeNull();
  });
});

describe('extractParamNames', () => {
  it('pomija @@zmienne systemowe, komentarze i literały', () => {
    const sql = "SELECT @@ROWCOUNT, 'a@b' AS x /* @ukryty */ FROM t -- użyj @od\nWHERE a >= @od AND b < @do AND c = @do";
    expect(extractParamNames(sql)).toEqual(['do', 'od']);
  });
  it('nie zmienia wielkości liter — @Od to inna nazwa niż zadeklarowane od', () => {
    expect(extractParamNames('SELECT 1 WHERE a >= @Od AND b < @do')).toEqual(['Od', 'do']);
  });
});

describe('parseTemplate', () => {
  it('poprawny szablon', () => {
    const r = parseTemplate(GOOD, { file: 'sprzedaz/sales-net-monthly.md', area: 'sprzedaz' });
    expect(r.error).toBeUndefined();
    expect(r.template.id).toBe('sales-net-monthly');
    expect(r.template.params.od).toMatchObject({ type: 'date', required: true, example: '2025-01-01' });
    expect(r.template.sql).toMatch(/^SELECT SUM/);
    expect(r.template.verified).toBe('2026-09-14');
  });
  it('odrzuca: param w SQL niezadeklarowany i zadeklarowany nieużyty', () => {
    const bad = GOOD.replace('AND d.dok_DataWyst < @do', 'AND d.dok_DataWyst < @do_x');
    const r = parseTemplate(bad, { file: 'sprzedaz/sales-net-monthly.md', area: 'sprzedaz' });
    expect(r.error).toMatch(/niezadeklarowane.*do_x/);
    expect(r.error).toMatch(/nieużyte.*do/);
  });
  it('odrzuca: area ≠ katalog, id ≠ plik, brak pytań, dwa bloki SQL, SQL zapisujący', () => {
    const f = { file: 'sprzedaz/sales-net-monthly.md', area: 'sprzedaz' };
    expect(parseTemplate(GOOD.replace('area: sprzedaz', 'area: finanse'), f).error).toMatch(/area/);
    expect(parseTemplate(GOOD, { ...f, file: 'sprzedaz/inna-nazwa.md' }).error).toMatch(/nazwa pliku/);
    expect(parseTemplate(GOOD.replace(/questions:\n.*\n/, 'questions: []\n'), f).error).toMatch(/questions/);
    expect(parseTemplate(`${GOOD}\n\`\`\`sql\nSELECT 1\n\`\`\`\n`, f).error).toMatch(/jeden blok/);
    expect(parseTemplate(GOOD.replace('SELECT SUM(d.dok_WartNetto) AS net_sales', 'DELETE'), f).error).toMatch(/SQL/);
  });
  it('odrzuca @Od w SQL przy zadeklarowanym od (dokładna wielkość liter)', () => {
    const r = parseTemplate(GOOD.replace('d.dok_DataWyst >= @od', 'd.dok_DataWyst >= @Od'), { file: 'sprzedaz/sales-net-monthly.md', area: 'sprzedaz' });
    expect(r.error).toMatch(/niezadeklarowane: Od/);
    expect(r.error).toMatch(/nieużyte w SQL: od/);
  });
  it('odrzuca zepsuty YAML z nazwą pliku', () => {
    const r = parseTemplate(GOOD.replace('title: Przychód', 'title: [Przychód'), { file: 'sprzedaz/sales-net-monthly.md', area: 'sprzedaz' });
    expect(r.error).toMatch(/^sprzedaz\/sales-net-monthly\.md: YAML/);
  });
  it('odrzuca example niezgodny z typem', () => {
    const r = parseTemplate(GOOD.replace('example: 2025-01-01', 'example: 2025-02-30'), { file: 'sprzedaz/sales-net-monthly.md', area: 'sprzedaz' });
    expect(r.error).toMatch(/od: example/);
  });
});

describe('loadCatalog', () => {
  it('zbiera zasady, szablony i błędy; zepsuty plik nie blokuje reszty', () => {
    const dir = catalog({
      'sprzedaz/_zasady.md': '## Zasady wspólne\n\nFS+PA.\n',
      'sprzedaz/sales-net-monthly.md': GOOD,
      'sprzedaz/zepsuty.md': '---\nid: zepsuty\n---\nbez SQL\n',
    });
    const c = loadCatalog(dir);
    expect(c.templates.map((t) => t.id)).toEqual(['sales-net-monthly']);
    expect(c.rules.sprzedaz).toContain('Zasady wspólne');
    expect(c.errors).toHaveLength(1);
    expect(c.errors[0]).toMatch(/^sprzedaz\/zepsuty\.md:/);
  });
  it('zasady obszaru: zdejmuje front matter i wiodący nagłówek H1, metadane w rulesMeta', () => {
    const c = loadCatalog(catalog({
      'finanse/_zasady.md': '---\nowner: firma X\nlicense: użytek wewnętrzny\ndate: 2026-09-14\n---\n# Tytuł obszaru\n\nWstęp.\n\n## Model\n\nx\n',
      'sprzedaz/_zasady.md': 'Wstęp bez nagłówka.\n\n## Zasady\n\ny\n',
    }));
    expect(c.rules.finanse).toBe('Wstęp.\n\n## Model\n\nx');
    expect(c.rulesMeta.finanse).toEqual({ owner: 'firma X', license: 'użytek wewnętrzny', date: '2026-09-14' });
    expect(c.rules.sprzedaz).toBe('Wstęp bez nagłówka.\n\n## Zasady\n\ny');
    expect(c.rulesMeta.sprzedaz).toEqual({});
  });
  it('zepsuty front matter zasad = błąd katalogu', () => {
    const c = loadCatalog(catalog({ 'finanse/_zasady.md': '---\nowner: [x\n---\ntreść\n' }));
    expect(c.errors[0]).toMatch(/^finanse\/_zasady\.md: YAML/);
  });
  it('duplikat id w innym obszarze = błąd, pierwszy wygrywa', () => {
    const fin = GOOD.replace('area: sprzedaz', 'area: finanse');
    const c = loadCatalog(catalog({ 'sprzedaz/sales-net-monthly.md': GOOD, 'finanse/sales-net-monthly.md': fin }));
    expect(c.templates).toHaveLength(1);
    expect(c.errors[0]).toMatch(/już użyte/);
  });
});

describe('searchTemplates', () => {
  const t = (id, title, questions, area = 'finanse') => ({ id, title, questions, area, order: 10 });
  const list = [
    t('receivables-aging', 'Aging należności (0–30 / 31–60 / 61–90 / 90+)', ['Ile mamy należności przeterminowanych?']),
    t('brand-top', 'Top marek wg wartości sprzedaży', ['Które marki sprzedają się najlepiej?'], 'sprzedaz'),
  ];
  it('trafia z polskimi znakami i bez (także ł)', () => {
    expect(searchTemplates(list, { query: 'należności przeterminowane' })[0].id).toBe('receivables-aging');
    expect(searchTemplates(list, { query: 'naleznosci' })[0].id).toBe('receivables-aging');
    expect(searchTemplates([t('x', 'Wartość w zł', ['ile zł?'])], { query: 'zl' })).toHaveLength(1);
    expect(searchTemplates(list, { query: 'najlepsze marki' })[0].id).toBe('brand-top');
  });
  it('filtr obszaru i puste zapytanie = cała lista obszaru', () => {
    expect(searchTemplates(list, { area: 'sprzedaz' }).map((x) => x.id)).toEqual(['brand-top']);
    expect(searchTemplates(list, { query: 'kosmos' })).toEqual([]);
  });
  it('pomija tokeny z samych cyfr (rok, liczby z pytania)', () => {
    const withYear = [t('rok', 'Przychód 2025', ['Ile w 2025?']), t('brand-top', 'Top marek', ['Które marki?'], 'sprzedaz')];
    expect(searchTemplates(withYear, { query: 'marki 2025' }).map((x) => x.id)).toEqual(['brand-top']);
    expect(searchTemplates(withYear, { query: '2025' })).toEqual(withYear);
  });
  it('najwyżej 10 wyników, malejąco po liczbie trafień; limit można zmienić', () => {
    const many = Array.from({ length: 15 }, (_, i) => t(`n${i}`, `Należności ${i}`, ['Ile należności?']));
    many.push(t('best', 'Należności przeterminowane', ['Należności przeterminowane?']));
    const r = searchTemplates(many, { query: 'należności przeterminowane' });
    expect(r).toHaveLength(10);
    expect(r[0].id).toBe('best');
    expect(searchTemplates(many, { query: 'należności', limit: Infinity })).toHaveLength(16);
  });
});

describe('validateParams', () => {
  const tpl = {
    params: {
      od: { type: 'date', required: true, description: 'od', example: '2025-01-01' },
      do: { type: 'date', required: true, description: 'do', example: '2026-01-01' },
      n: { type: 'int', required: false, description: 'top N', example: 10, default: 10 },
      udzial: { type: 'number', required: false, description: 'próg', example: 0.5 },
      marka: { type: 'text', required: false, description: 'marka', example: 'Rabalux', maxLength: 5 },
      mag: { type: 'enum', required: false, description: 'magazyn', example: 1, values: [1, 5, 6] },
    },
  };
  it('poprawne wartości, koercja tekstu na liczby, default', () => {
    const r = validateParams(tpl, { od: '2026-09-01', do: '2026-10-01', udzial: '0.25', mag: '5' });
    expect(r).toEqual({ ok: true, values: { od: '2026-09-01', do: '2026-10-01', n: 10, udzial: 0.25, marka: null, mag: 5 } });
  });
  it('odrzuca: brak wymaganego, nieznany klucz, zła data, zły int, za długi tekst, spoza enum', () => {
    expect(validateParams(tpl, { do: '2026-10-01' }).reason).toMatch(/brak wymaganego parametru od/);
    expect(validateParams(tpl, { od: '2026-09-01', do: '2026-10-01', x: 1 }).reason).toMatch(/nieznane parametry: x/);
    expect(validateParams(tpl, { od: '2026-02-30', do: '2026-10-01' }).reason).toMatch(/od/);
    expect(validateParams(tpl, { od: '2026-9-1', do: '2026-10-01' }).reason).toMatch(/od/);
    expect(validateParams(tpl, { od: '2026-09-01T00:00', do: '2026-10-01' }).reason).toMatch(/od/);
    expect(validateParams(tpl, { od: '2026-09-01', do: '2026-10-01', n: '1.5' }).reason).toMatch(/n:/);
    expect(validateParams(tpl, { od: '2026-09-01', do: '2026-10-01', marka: 'Rabalux' }).reason).toMatch(/5 znaków/);
    expect(validateParams(tpl, { od: '2026-09-01', do: '2026-10-01', mag: 2 }).reason).toMatch(/dozwolone: 1, 5, 6/);
    expect(validateParams(tpl, 'od=2026').reason).toMatch(/obiektu/);
  });
  it('odrzuca zakres odwrócony lub pusty (od >= do, także z sufiksem)', () => {
    expect(validateParams(tpl, { od: '2026-10-01', do: '2026-10-01' }).reason).toMatch(/od.*wcześniej.*do/);
    const yoy = { params: { od_prev: tpl.params.od, do_prev: tpl.params.do } };
    expect(validateParams(yoy, { od_prev: '2025-12-01', do_prev: '2025-01-01' }).reason).toMatch(/od_prev.*do_prev/);
  });
});

describe('setVerified', () => {
  it('podmienia tylko linię verified w nagłówku', () => {
    const out = setVerified(GOOD, '2026-09-28');
    expect(out).toContain('verified: 2026-09-28');
    expect(out.replace('verified: 2026-09-28', 'verified: 2026-09-14')).toBe(GOOD);
  });
  it('zachowuje CRLF', () => {
    const crlf = GOOD.replace(/\n/g, '\r\n');
    const out = setVerified(crlf, '2026-09-28');
    expect(out).toContain('verified: 2026-09-28\r\n');
    expect(out.replace('verified: 2026-09-28', 'verified: 2026-09-14')).toBe(crlf);
  });
  it('czytelny błąd bez zamykającego ---', () => {
    expect(() => setVerified('---\nid: x\nverified: 2026-01-01\n', '2026-09-28')).toThrow(/brak zamykającego ---/);
  });
});

describe('localDate', () => {
  it('data kalendarzowa w Europe/Warsaw, nie UTC', () => {
    expect(localDate(new Date('2026-09-27T22:30:00Z'))).toBe('2026-09-28'); // 00:30 CEST
    expect(localDate(new Date('2026-01-31T23:30:00Z'))).toBe('2026-02-01'); // 00:30 CET
    expect(localDate(new Date('2026-09-28T21:59:00Z'))).toBe('2026-09-28');
  });
});
