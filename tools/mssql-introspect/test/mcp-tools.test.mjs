import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTools, sqlTypeFor, toDriverValue, TOOL_DEFS } from '../src/mcp-tools.mjs';

const TPL = `---
id: brand-top
title: Top marek wg wartości sprzedaży
area: sprzedaz
questions: [Które marki sprzedają się najlepiej?]
params:
  od: { type: date, description: od, example: 2025-01-01 }
  do: { type: date, description: do, example: 2026-01-01 }
  n: { type: int, description: top N, example: 10, required: false, default: 10 }
  marka: { type: text, description: marka, example: Rabalux, required: false, maxLength: 60 }
verified: 2026-09-14
---
\`\`\`sql
SELECT TOP (@n) g.grt_Nazwa, SUM(d.dok_WartNetto) AS net
FROM dbo.dok__Dokument d JOIN dbo.sl_GrupaTw g ON 1 = 1
WHERE d.dok_DataWyst >= @od AND d.dok_DataWyst < @do AND (@marka IS NULL OR g.grt_Nazwa = @marka)
GROUP BY g.grt_Nazwa
\`\`\`
`;

const fakeSql = { Date: { t: 'Date' }, Int: { t: 'Int' }, Decimal: (p, s) => ({ t: 'Decimal', p, s }), NVarChar: (n) => ({ t: 'NVarChar', n }) };

function fakePool(rows = [{ grt_Nazwa: 'Rabalux', net: 1 }]) {
  const calls = { inputs: [], queries: [], connects: 0 };
  const pool = {
    request() {
      return {
        input(n, t, v) { calls.inputs.push({ n, t, v }); return this; },
        async query(q) { calls.queries.push(q); return { recordset: rows }; },
      };
    },
  };
  return { calls, getPool: async () => { calls.connects += 1; return pool; } };
}

const dirs = [];
function setup(files = { 'sprzedaz/brand-top.md': TPL }) {
  const dir = mkdtempSync(join(tmpdir(), 'tools-'));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  const log = [];
  const fp = fakePool();
  const tools = createTools({ getPool: fp.getPool, sql: fakeSql, catalogDir: dir, audit: (via, e) => log.push({ via, ...e }) });
  return { tools, log, calls: fp.calls };
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

describe('TOOL_DEFS', () => {
  it('trzy narzędzia ze schematami bez dodatkowych pól', () => {
    expect(TOOL_DEFS.map((t) => t.name)).toEqual(['execute_sql', 'list_templates', 'run_template']);
    for (const t of TOOL_DEFS) expect(t.inputSchema.additionalProperties).toBe(false);
  });
});

describe('sqlTypeFor / toDriverValue', () => {
  it('mapuje typy i datę na północ UTC', () => {
    expect(sqlTypeFor({ type: 'date' }, '2026-09-01', fakeSql)).toBe(fakeSql.Date);
    expect(sqlTypeFor({ type: 'int' }, 5, fakeSql)).toBe(fakeSql.Int);
    expect(sqlTypeFor({ type: 'number' }, 0.5, fakeSql)).toEqual({ t: 'Decimal', p: 18, s: 4 });
    expect(sqlTypeFor({ type: 'text', maxLength: 60 }, 'x', fakeSql)).toEqual({ t: 'NVarChar', n: 60 });
    expect(sqlTypeFor({ type: 'enum', values: [1, 5, 6] }, 5, fakeSql)).toBe(fakeSql.Int);
    expect(sqlTypeFor({ type: 'enum', values: ['FS', 'PA'] }, 'PA', fakeSql)).toEqual({ t: 'NVarChar', n: 2 });
    expect(toDriverValue({ type: 'date' }, '2026-09-01').toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(toDriverValue({ type: 'text' }, null)).toBeNull();
  });
});

describe('run_template', () => {
  it('parametry idą przez request.input, tekst SQL bez interpolacji, log z templateId', async () => {
    const { tools, log, calls } = setup();
    const out = await tools.runTemplate({ id: 'brand-top', params: { od: '2026-07-01', do: '2026-10-01', marka: "x' OR 1=1 --" } });
    expect(calls.queries).toHaveLength(1);
    expect(calls.queries[0]).toContain('@marka');
    expect(calls.queries[0]).not.toContain('OR 1=1');
    const byName = Object.fromEntries(calls.inputs.map((i) => [i.n, i]));
    expect(byName.od.v.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(byName.n).toMatchObject({ t: fakeSql.Int, v: 10 });
    expect(byName.marka).toMatchObject({ t: { t: 'NVarChar', n: 60 }, v: "x' OR 1=1 --" });
    expect(out).toMatch(/^1 wierszy/);
    expect(out).toContain('szablon brand-top · zweryfikowany 2026-09-14');
    expect(log.at(-1)).toMatchObject({ via: 'template', templateId: 'brand-top', ok: true, rows: 1 });
  });
  it('błąd walidacji nie otwiera połączenia i jest logowany', async () => {
    const { tools, log, calls } = setup();
    await expect(tools.runTemplate({ id: 'brand-top', params: { od: '2026-10-01', do: '2026-07-01' } })).rejects.toThrow(/parametry: od/);
    expect(calls.connects).toBe(0);
    expect(log.at(-1)).toMatchObject({ via: 'template', ok: false, templateId: 'brand-top' });
  });
  it('odrzucone parametry w logu przycięte do 1000 znaków', async () => {
    const { tools, log } = setup();
    await expect(tools.runTemplate({ id: 'brand-top', params: { od: '2026-07-01', do: '2026-10-01', zly: 'x'.repeat(5000) } })).rejects.toThrow(/nieznane parametry/);
    const entry = log.at(-1);
    expect(typeof entry.params).toBe('string');
    expect(entry.params.length).toBeLessThan(1100);
    expect(entry.params).toMatch(/przycięto/);
    await expect(tools.runTemplate({ id: 'brand-top', params: { od: '2026-10-01', do: '2026-07-01' } })).rejects.toThrow();
    expect(log.at(-1).params).toEqual({ od: '2026-10-01', do: '2026-07-01' });
  });
  it('nieznany szablon vs szablon z błędem', async () => {
    const { tools } = setup({ 'sprzedaz/brand-top.md': TPL, 'sprzedaz/zepsuty.md': '---\nid: zepsuty\n---\n' });
    await expect(tools.runTemplate({ id: 'nie-ma', params: {} })).rejects.toThrow(/nieznany szablon: nie-ma/);
    await expect(tools.runTemplate({ id: 'zepsuty', params: {} })).rejects.toThrow(/szablon zepsuty jest błędny: sprzedaz\/zepsuty\.md/);
  });
});

describe('list_templates', () => {
  it('lista z parametrami i błędnymi plikami', () => {
    const { tools } = setup({ 'sprzedaz/brand-top.md': TPL, 'sprzedaz/zepsuty.md': '---\nid: zepsuty\n---\n' });
    const out = tools.listTemplates({ query: 'najlepsze marki' });
    expect(out).toMatch(/^1 szablon/);
    expect(out).toContain('"id": "brand-top"');
    expect(out).toContain('date — od (np. 2025-01-01)');
    expect(out).toContain('int? — top N (np. 10)');
    expect(out).toMatch(/Błędne pliki katalogu[\s\S]*sprzedaz\/zepsuty\.md/);
  });  it('najwyżej 10 wyników dla zapytania, z notą o przycięciu', () => {
    const files = {};
    for (let i = 0; i < 12; i += 1) files[`sprzedaz/brand-top-${i}.md`] = TPL.replace('id: brand-top', `id: brand-top-${i}`);
    const { tools } = setup(files);
    const out = tools.listTemplates({ query: 'najlepsze marki' });
    expect(out).toMatch(/^10 szablon/);
    expect(out).toMatch(/pokazano 10 najlepiej dopasowanych z 12/);
    expect(tools.listTemplates({ area: 'sprzedaz' })).toMatch(/^12 szablon/);
  });
});

describe('execute_sql', () => {
  it('bramka odrzuca zapis i loguje via mcp', async () => {
    const { tools, log, calls } = setup();
    await expect(tools.executeSql('DELETE FROM t')).rejects.toThrow(/odrzucone/);
    expect(calls.connects).toBe(0);
    expect(log.at(-1)).toMatchObject({ via: 'mcp', ok: false });
  });
});
