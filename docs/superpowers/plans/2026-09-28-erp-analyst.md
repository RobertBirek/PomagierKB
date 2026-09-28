# Analityk ERP — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pytania biznesowe o firmę w sesji Claude Code dostają poprawną liczbę z założeniami i źródłem — przez katalog szablonów SQL w repo, narzędzia `list_templates`/`run_template` serwera MCP `mssql` i skill `erp-analyst`.

**Architecture:** Szablony (Markdown + nagłówek YAML + jeden blok T-SQL z `@parametrami`) leżą w `tools/mssql-introspect/templates/<obszar>/`. Czysta logika katalogu (`src/templates.mjs`) parsuje i waliduje; `src/mcp-tools.mjs` wykonuje szablony z parametrami przez `request.input()` (wstrzykiwana pula — testowalne atrapą); `mcp-server.mjs` to cienka warstwa protokołu. Dokumenty KPI w IloveKB są generowane z katalogu (`tools/kb-import/prepare-kpi.mjs`) z tymi samymi tytułami i `sourceUrl`.

**Tech Stack:** Node 22 ESM (`.mjs`), `mssql` 11 (tedious), `yaml` 2, vitest z roota, bash (skrypt odświeżania), skill Claude Code (Markdown).

**Spec:** `docs/superpowers/specs/2026-09-28-erp-analyst-design.md`

## Global Constraints

- Język: komentarze, komunikaty CLI/błędów i treść dokumentów po polsku; identyfikatory, nazwy plików i commity po angielsku (conventional: feat/fix/docs/test/chore).
- Każdy commit kończy się linią `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; hook gitleaks (`core.hooksPath=.githooks`) musi przejść — nigdy `--no-verify`.
- Testy: JEDEN proces vitest z roota (`npx vitest run <plik>`); pliki testów `tools/*/test/*.test.mjs`; workspace'y nie mają skryptu `test`.
- Jedyna nowa zależność: `yaml` (^2.9.0) w `tools/mssql-introspect/package.json`. Żadnych innych.
- Parser YAML: `import { parse, stringify } from 'yaml'` (YAML 1.2 core — daty zostają stringami; mimo to normalizuj `Date` → `RRRR-MM-DD`).
- Każde zapytanie do produkcji przechodzi `checkReadOnly` (`tools/mssql-introspect/src/mcp-readonly.mjs`) i jest logowane przez `auditQuery(via, entry)` z `src/query-log.mjs` (bez wyników).
- Parametry NIGDY nie są wklejane w tekst SQL — wyłącznie `request.input(nazwa, typ, wartość)`.
- Typy parametrów: `date`, `int`, `number`, `text` (`maxLength`, domyślnie 100), `enum` (`values`). Doprecyzowanie względem spec §2: `enum` o wartościach całkowitych (np. magazyny 1/5/6) wiąże się jako `sql.Int`, żeby nie porównywać `int` z `nvarchar`. Mapowanie na sterownik: `date`→`sql.Date` (wartość `new Date(Date.UTC(r, m-1, d))`), `int`→`sql.Int`, `number`→`sql.Decimal(18, 4)`, `text`→`sql.NVarChar(maxLength)`, `enum`→`sql.Int` gdy wartość jest liczbą całkowitą, inaczej `sql.NVarChar(najdłuższa wartość)`.
- Obszary: `sprzedaz`, `finanse`, `magazyn` (= nazwy katalogów).
- Tytuły i `sourceUrl` dokumentów IloveKB bez zmian: `Magnum_Profi — KPI: sprzedaż i marża (szablony SQL)` / `…#dokumentacja/instancja/kpi-sprzedaz`; `Magnum_Profi — KPI: finanse i klienci (szablony SQL)` / `…/kpi-finanse`; `Magnum_Profi — KPI: magazyn i zakupy (szablony SQL)` / `…/kpi-magazyn`; `Magnum_Profi — konwencje i semantyka instancji` / `…/konwencje`; baza `https://kag.ilovelighting.sanok.pl/src/magnum-profi`.
- Limit uploadu: dokument ≤ 100 000 znaków (`tools/kb-import/upload.mjs`) — render odmawia powyżej 95 000.
- Prywatność: kontrahenci tylko jako rangi/identyfikatory, nigdy nazwy; próg k=10 dla liczebności kontrahentów.
- Zapytania do produkcji z hosta mogą zostać zablokowane przez klasyfikator uprawnień sesji. Wtedy podaj właścicielowi komendę do uruchomienia z prefiksem `!` i przeczytaj wynik — nie obchodź blokady.

## Review Focus

1. **Polskie znaki w wyszukiwaniu, w tym `ł`** — „należności”, „naleznosci”, „zł”/„zl”, „marż” muszą trafiać tak samo (NFD nie składa `ł` → jawna zamiana `ł→l`). Test w Task 1.
2. **Data graniczna bez przesunięcia strefy** — `od: 2026-09-01` musi dojść do sterownika jako `2026-09-01T00:00:00.000Z` (tedious `useUTC` domyślnie `true`), a nie 31.08 22:00. Test w Task 2.
3. **Zakres odwrócony lub pusty** — `od >= do` (także `od_prev`/`do_prev`) ma dać czytelny błąd walidacji zamiast cichego zera wierszy. Test w Task 1.
4. **Jeden zepsuty plik nie psuje katalogu** — błędny YAML/brak SQL w jednym szablonie: `list_templates` zwraca pozostałe + listę błędów, `run_template` tego szablonu mówi, co jest nie tak, a nie „nieznany szablon”. Testy w Task 1 i Task 2.
5. **`@` poza parametrami** — `@@ROWCOUNT`, `@` w komentarzu `-- użyj @od` i w literale `'a@b'` nie są parametrami; plik z CRLF/BOM (edycja z Windows) parsuje się poprawnie. Test w Task 1.

---

### Task 1: Rdzeń katalogu szablonów (`src/templates.mjs`)

**Files:**
- Create: `tools/mssql-introspect/src/templates.mjs`
- Modify: `tools/mssql-introspect/package.json` (dependency `yaml`)
- Test: `tools/mssql-introspect/test/templates.test.mjs`

**Interfaces:**
- Consumes: `checkReadOnly(sql) → {ok:true}|{ok:false,reason}` z `src/mcp-readonly.mjs`.
- Produces (używane przez Task 2, 3, 7):
  - `AREAS: string[]` = `['sprzedaz','finanse','magazyn']`
  - `splitFrontMatter(raw: string) → {meta: string, body: string} | null`
  - `extractParamNames(sql: string) → string[]` (posortowane, małe litery)
  - `parseTemplate(raw: string, {file: string, area: string}) → {template: Template} | {error: string}`
  - `loadCatalog(dir: string) → {templates: Template[], rules: Record<area,string>, errors: string[]}`
  - `searchTemplates(templates: Template[], {area?: string, query?: string}) → Template[]`
  - `validateParams(template: Template, input: object) → {ok:true, values: Record<string, any>} | {ok:false, reason: string}`
  - `setVerified(raw: string, date: string) → string`
  - `Template = {id, title, area, order, questions: string[], params: Record<name, ParamDef>, verified: 'RRRR-MM-DD', sql, body, file}` (`file` względny, np. `sprzedaz/sales-net-monthly.md`)
  - `ParamDef = {type, description, required: boolean, example, maxLength?, values?, default?}`

- [ ] **Step 1: Dodaj zależność `yaml`**

W `tools/mssql-introspect/package.json` zamień sekcję `dependencies` na:

```json
  "dependencies": {
    "mssql": "^11.0.1",
    "yaml": "^2.9.0"
  }
```

Run: `cd /kag/tools/mssql-introspect && npm install --no-audit --no-fund && cd /kag`
Expected: `node_modules/yaml` istnieje w `tools/mssql-introspect/node_modules` (albo hoisted), `package-lock.json` zaktualizowany.

- [ ] **Step 2: Napisz testy (failing)**

Create `tools/mssql-introspect/test/templates.test.mjs`:

```js
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractParamNames, loadCatalog, parseTemplate, searchTemplates, setVerified, splitFrontMatter, validateParams,
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
    const sql = "SELECT @@ROWCOUNT, 'a@b' AS x /* @ukryty */ FROM t -- użyj @od\nWHERE a >= @Od AND b < @do AND c = @do";
    expect(extractParamNames(sql)).toEqual(['do', 'od']);
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
});
```

- [ ] **Step 3: Uruchom testy — mają paść**

Run: `npx vitest run tools/mssql-introspect/test/templates.test.mjs`
Expected: FAIL — `Failed to load url ../src/templates.mjs` (plik nie istnieje).

- [ ] **Step 4: Zaimplementuj `src/templates.mjs`**

Create `tools/mssql-introspect/src/templates.mjs`:

```js
// Katalog szablonów SQL (tools/mssql-introspect/templates/<obszar>/<id>.md) — czysta logika bez MCP
// i bez sterownika: parsowanie nagłówka YAML i bloku T-SQL, walidacja reguł katalogu, wyszukiwanie
// po tytule i pytaniach, walidacja parametrów. Spec: docs/superpowers/specs/2026-09-28-erp-analyst-design.md

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { checkReadOnly } from './mcp-readonly.mjs';

export const AREAS = ['sprzedaz', 'finanse', 'magazyn'];
export const PARAM_TYPES = ['date', 'int', 'number', 'text', 'enum'];
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PARAM_NAME_RE = /^[a-z][a-z0-9_]*$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DEFAULT_TEXT_MAX = 100;
const RULES_FILE = '_zasady.md';
// Słowa pytające i spójniki — bez znaczenia dla dopasowania szablonu.
const STOP_WORDS = new Set(['ile', 'jak', 'jaki', 'jaka', 'jakie', 'czy', 'ktore', 'ktory', 'ktora', 'dla', 'nas', 'mamy', 'sie', 'oraz', 'jest', 'byl', 'tym', 'ten', 'ta', 'to', 'po', 'na', 'do', 'od', 'w', 'we', 'z', 'ze', 'i', 'a', 'o']);

const fail = (reason) => ({ ok: false, reason });
const ok = (value) => ({ ok: true, value });

/** Normalizacja do porównań: małe litery, bez diakrytyków; `ł` nie rozkłada się w NFD, więc jawnie. */
export function normalizeText(s) {
  return String(s).toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function tokenize(s) {
  return normalizeText(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

/** Rdzeń słowa do dopasowania odmian („należności”/„należność”, „marki”/„marek”). */
function stem(w) {
  return w.length <= 4 ? w : w.slice(0, Math.max(4, w.length - 3));
}

function isCalendarDate(s) {
  const m = typeof s === 'string' ? s.match(DATE_RE) : null;
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** YAML może oddać datę jako Date (inne schematy) — sprowadzamy do RRRR-MM-DD. */
function asDateString(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return typeof v === 'string' ? v.trim() : v;
}

/** Nagłówek YAML + treść; toleruje BOM i CRLF. */
export function splitFrontMatter(raw) {
  const text = String(raw).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return m ? { meta: m[1], body: m[2] } : null;
}

/** Nazwy parametrów `@x` w SQL (bez `@@zmiennych`, komentarzy, literałów i identyfikatorów w cudzysłowach). */
export function extractParamNames(sql) {
  const cleaned = String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/N?'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
    .replace(/\[(?:\]\]|[^\]])*\]/g, '[]');
  const names = new Set();
  for (const m of cleaned.matchAll(/(^|[^@\w])@([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[2].toLowerCase());
  return [...names].sort();
}

/** Koercja jednej wartości do typu parametru (wejście z MCP/CLI bywa tekstem). */
export function coerceValue(def, v) {
  switch (def.type) {
    case 'date': {
      const s = asDateString(v);
      return isCalendarDate(s) ? ok(s) : fail('oczekiwano daty RRRR-MM-DD');
    }
    case 'int': {
      const n = typeof v === 'string' && /^\s*-?\d+\s*$/.test(v) ? Number(v) : v;
      return Number.isSafeInteger(n) ? ok(n) : fail('oczekiwano liczby całkowitej');
    }
    case 'number': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      return typeof n === 'number' && Number.isFinite(n) ? ok(n) : fail('oczekiwano liczby');
    }
    case 'text': {
      if (typeof v !== 'string' || v.trim() === '') return fail('oczekiwano niepustego tekstu');
      return v.length <= def.maxLength ? ok(v) : fail(`tekst dłuższy niż ${def.maxLength} znaków`);
    }
    case 'enum': {
      const hit = def.values.find((x) => String(x) === String(v));
      return hit === undefined ? fail(`dozwolone: ${def.values.join(', ')}`) : ok(hit);
    }
    default:
      return fail(`nieznany typ ${def.type}`);
  }
}

function normalizeParamDef(name, def) {
  const err = (msg) => ({ error: `parametr ${name}: ${msg}` });
  if (!PARAM_NAME_RE.test(name)) return err('nazwa musi pasować do [a-z][a-z0-9_]*');
  if (!def || typeof def !== 'object' || Array.isArray(def)) return err('definicja musi być mapą');
  if (!PARAM_TYPES.includes(def.type)) return err(`type ∈ ${PARAM_TYPES.join('|')}`);
  if (typeof def.description !== 'string' || def.description.trim() === '') return err('description wymagany');
  const out = { type: def.type, description: def.description.trim(), required: def.required !== false };
  if (def.type === 'text') {
    out.maxLength = def.maxLength ?? DEFAULT_TEXT_MAX;
    if (!Number.isInteger(out.maxLength) || out.maxLength < 1 || out.maxLength > 4000) return err('maxLength 1–4000');
  }
  if (def.type === 'enum') {
    if (!Array.isArray(def.values) || def.values.length === 0) return err('enum wymaga niepustego values');
    out.values = def.values;
  }
  const ex = coerceValue(out, def.example);
  if (!ex.ok) return err(`example — ${ex.reason}`);
  out.example = ex.value;
  if (def.default !== undefined) {
    if (out.required) return err('default tylko z required: false');
    const d = coerceValue(out, def.default);
    if (!d.ok) return err(`default — ${d.reason}`);
    out.default = d.value;
  }
  return { def: out };
}

/** Jeden plik szablonu → {template} albo {error} z nazwą pliku i listą problemów. */
export function parseTemplate(raw, { file, area }) {
  const fm = splitFrontMatter(raw);
  if (!fm) return { error: `${file}: brak nagłówka YAML (--- … ---)` };
  let meta;
  try {
    meta = parseYaml(fm.meta) ?? {};
  } catch (e) {
    return { error: `${file}: YAML: ${e.message.split('\n')[0]}` };
  }
  if (typeof meta !== 'object' || Array.isArray(meta)) return { error: `${file}: YAML: nagłówek musi być mapą` };
  const problems = [];
  const { id } = meta;
  if (typeof id !== 'string' || !ID_RE.test(id)) problems.push('id: wymagany kebab-case');
  else if (basename(file, '.md') !== id) problems.push(`id "${id}" ≠ nazwa pliku`);
  if (typeof meta.title !== 'string' || meta.title.trim() === '') problems.push('title: wymagany');
  if (meta.area !== area) problems.push(`area: "${meta.area}" ≠ katalog "${area}"`);
  const questions = Array.isArray(meta.questions) ? meta.questions.filter((q) => typeof q === 'string' && q.trim() !== '').map((q) => q.trim()) : [];
  if (questions.length === 0) problems.push('questions: co najmniej jedno pytanie');
  const verified = asDateString(meta.verified);
  if (!isCalendarDate(verified)) problems.push('verified: data RRRR-MM-DD');
  const order = meta.order ?? 1000;
  if (!Number.isInteger(order)) problems.push('order: liczba całkowita');
  const blocks = [...fm.body.matchAll(/```sql\n([\s\S]*?)```/g)];
  if (blocks.length !== 1) problems.push(`dokładnie jeden blok \`\`\`sql (jest ${blocks.length})`);
  const sql = blocks[0]?.[1].trim() ?? '';
  const rawParams = meta.params ?? {};
  const params = {};
  if (typeof rawParams !== 'object' || Array.isArray(rawParams)) {
    problems.push('params: mapa nazwa → definicja');
  } else {
    for (const [name, def] of Object.entries(rawParams)) {
      const p = normalizeParamDef(name, def);
      if (p.error) problems.push(p.error);
      else params[name] = p.def;
    }
  }
  if (sql !== '') {
    const used = extractParamNames(sql);
    const declared = typeof rawParams === 'object' && !Array.isArray(rawParams) ? Object.keys(rawParams) : [];
    const undeclared = used.filter((n) => !declared.includes(n));
    const unused = declared.filter((n) => !used.includes(n));
    if (undeclared.length) problems.push(`parametry w SQL niezadeklarowane: ${undeclared.join(', ')}`);
    if (unused.length) problems.push(`parametry zadeklarowane, nieużyte w SQL: ${unused.join(', ')}`);
    const gate = checkReadOnly(sql);
    if (!gate.ok) problems.push(`SQL: ${gate.reason}`);
  }
  if (problems.length) return { error: `${file}: ${problems.join('; ')}` };
  return { template: { id, title: meta.title.trim(), area, order, questions, params, verified, sql, body: fm.body.trim(), file } };
}

/** Cały katalog: szablony (posortowane obszar → order → id), zasady obszarów, błędy plików. */
export function loadCatalog(dir) {
  const templates = [];
  const errors = [];
  const rules = {};
  const seen = new Map();
  for (const area of AREAS) {
    let files;
    try {
      files = readdirSync(join(dir, area)).filter((f) => f.endsWith('.md')).sort();
    } catch {
      continue; // brak katalogu obszaru = brak szablonów
    }
    for (const f of files) {
      const rel = `${area}/${f}`;
      const raw = readFileSync(join(dir, area, f), 'utf8');
      if (f === RULES_FILE) {
        rules[area] = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
        continue;
      }
      const r = parseTemplate(raw, { file: rel, area });
      if (r.error) {
        errors.push(r.error);
      } else if (seen.has(r.template.id)) {
        errors.push(`${rel}: id "${r.template.id}" już użyte w ${seen.get(r.template.id)}`);
      } else {
        seen.set(r.template.id, rel);
        templates.push(r.template);
      }
    }
  }
  templates.sort((a, b) => AREAS.indexOf(a.area) - AREAS.indexOf(b.area) || a.order - b.order || a.id.localeCompare(b.id));
  return { templates, rules, errors };
}

/** Dopasowanie słów zapytania do id/tytułu/pytań; wynik malejąco po liczbie trafionych słów. */
export function searchTemplates(templates, { area, query } = {}) {
  const pool = area ? templates.filter((t) => t.area === area) : templates;
  const words = tokenize(query ?? '');
  if (words.length === 0) return pool;
  const scored = pool.map((t) => {
    const hay = tokenize([t.id.replace(/-/g, ' '), t.title, ...t.questions].join(' '));
    const hits = words.filter((w) => hay.some((h) => h.startsWith(stem(w)) || w.startsWith(stem(h)))).length;
    return { t, hits };
  });
  return scored.filter((s) => s.hits > 0).sort((a, b) => b.hits - a.hits).map((s) => s.t);
}

/** Walidacja wejścia run_template: typy, wymagane, nieznane klucze, default, zakresy od*<do*. */
export function validateParams(template, input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail('params: oczekiwano obiektu {nazwa: wartość}');
  const names = Object.keys(template.params);
  const unknown = Object.keys(input).filter((k) => !names.includes(k));
  if (unknown.length) return fail(`nieznane parametry: ${unknown.join(', ')} (dozwolone: ${names.join(', ') || 'brak'})`);
  const values = {};
  for (const [name, def] of Object.entries(template.params)) {
    const v = input[name];
    if (v === undefined || v === null || v === '') {
      if (def.required) return fail(`brak wymaganego parametru ${name} (${def.type}, np. ${def.example})`);
      values[name] = def.default ?? null;
      continue;
    }
    const c = coerceValue(def, v);
    if (!c.ok) return fail(`${name}: ${c.reason}`);
    values[name] = c.value;
  }
  // Konwencja zakresów półotwartych: od<sufiks> musi być wcześniej niż do<sufiks>.
  for (const [name, def] of Object.entries(template.params)) {
    if (def.type !== 'date' || !name.startsWith('od')) continue;
    const pair = `do${name.slice(2)}`;
    if (template.params[pair]?.type === 'date' && values[name] && values[pair] && values[name] >= values[pair]) {
      return fail(`${name} (${values[name]}) musi być wcześniej niż ${pair} (${values[pair]}) — zakres [${name}, ${pair}) jest pusty`);
    }
  }
  return { ok: true, values };
}

/** Podmienia datę `verified:` w nagłówku (reszta pliku bajt w bajt bez zmian). */
export function setVerified(raw, date) {
  if (!isCalendarDate(date)) throw new Error(`setVerified: zła data ${date}`);
  const end = raw.indexOf('\n---', 3);
  const head = raw.slice(0, end);
  if (!/^verified:.*$/m.test(head)) throw new Error('setVerified: brak linii verified w nagłówku');
  return head.replace(/^verified:.*$/m, `verified: ${date}`) + raw.slice(end);
}
```

- [ ] **Step 5: Uruchom testy — mają przejść**

Run: `npx vitest run tools/mssql-introspect/test/templates.test.mjs`
Expected: PASS (wszystkie `describe`). Jeśli `searchTemplates` nie trafia „najlepsze marki” → „marki”, sprawdź `stem`: `najlepsze` nie może trafiać przypadkowo; `marki`→rdzeń `mark`, `marek`→`mark`.

- [ ] **Step 6: Lint + commit**

Run: `npm run lint`
Expected: brak błędów (root ESLint 9, konfiguracja flat — obejmuje `tools/**`).

```bash
git add tools/mssql-introspect/package.json tools/mssql-introspect/package-lock.json tools/mssql-introspect/src/templates.mjs tools/mssql-introspect/test/templates.test.mjs
git commit -m "feat(mssql): SQL template catalog core — front-matter parsing, param validation, search

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Narzędzia `list_templates` / `run_template` + CLI

**Files:**
- Create: `tools/mssql-introspect/src/mcp-tools.mjs`
- Create: `tools/mssql-introspect/run-template.mjs`
- Create: `tools/mssql-introspect/verify-templates.mjs`
- Modify: `tools/mssql-introspect/mcp-server.mjs` (całość: protokół zostaje, logika narzędzi → `mcp-tools.mjs`)
- Test: `tools/mssql-introspect/test/mcp-tools.test.mjs`

**Interfaces:**
- Consumes (Task 1): `loadCatalog`, `searchTemplates`, `validateParams`, `setVerified`, `Template`, `ParamDef`; `checkReadOnly`; `auditQuery(via, entry)` z `src/query-log.mjs`; `configFromEnv(env, file)`, `parseEnvFile(text)` z `src/env.mjs`.
- Produces:
  - `MAX_ROWS = 200`, `MAX_CHARS = 60_000`
  - `TOOL_DEFS: Array<{name, description, inputSchema}>` — `execute_sql`, `list_templates`, `run_template`
  - `sqlTypeFor(def: ParamDef, value, sql) → typ sterownika`
  - `toDriverValue(def: ParamDef, value) → any` (data → `Date` UTC północ)
  - `createTools({getPool: () => Promise<Pool>, sql, catalogDir: string, audit: (via, entry) => void}) → {executeSql(text) → Promise<string>, listTemplates({area?, query?}) → string, executeTemplate(id, params) → Promise<{template, rows, ms}>, runTemplate({id, params}) → Promise<string>}`
  - `DEFAULT_CATALOG_DIR` (= `tools/mssql-introspect/templates`, nadpisywalny `MSSQL_TEMPLATES_DIR`)

- [ ] **Step 1: Napisz testy (failing)**

Create `tools/mssql-introspect/test/mcp-tools.test.mjs`:

```js
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
```

- [ ] **Step 2: Uruchom testy — mają paść**

Run: `npx vitest run tools/mssql-introspect/test/mcp-tools.test.mjs`
Expected: FAIL — brak `../src/mcp-tools.mjs`.

- [ ] **Step 3: Zaimplementuj `src/mcp-tools.mjs`**

Create `tools/mssql-introspect/src/mcp-tools.mjs`:

```js
// Narzędzia serwera MCP mssql (execute_sql, list_templates, run_template) bez protokołu i bez
// własnego połączenia: pula, typy sterownika, katalog szablonów i log są wstrzykiwane (testy podają
// atrapy). Parametry szablonów idą WYŁĄCZNIE przez request.input — nigdy przez tekst SQL.

import { fileURLToPath } from 'node:url';
import { checkReadOnly } from './mcp-readonly.mjs';
import { loadCatalog, searchTemplates, validateParams } from './templates.mjs';

export const MAX_ROWS = 200;
export const MAX_CHARS = 60_000;
export const DEFAULT_CATALOG_DIR = process.env.MSSQL_TEMPLATES_DIR ?? fileURLToPath(new URL('../templates/', import.meta.url));

export const TOOL_DEFS = [
  {
    name: 'execute_sql',
    description:
      'Wykonuje JEDNO zapytanie SELECT (tylko odczyt) na produkcyjnej bazie Subiekt GT ilovelighting ' +
      '(Magnum_Profi). Zapis, DDL, procedury i wiele zapytań są odrzucane. Zwraca wiersze jako JSON ' +
      `(do ${MAX_ROWS} wierszy). Najpierw sprawdź list_templates — szablon ma zweryfikowane reguły instancji.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: { query: { type: 'string', description: 'Zapytanie SELECT (jedno, bez ";")' } },
    },
  },
  {
    name: 'list_templates',
    description:
      'Lista zweryfikowanych szablonów SQL (KPI sprzedaży, finansów, magazynu) dla instancji Magnum_Profi: ' +
      'id, tytuł, parametry z przykładami, przykładowe pytania, data weryfikacji. Filtr po obszarze i słowach pytania.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        area: { type: 'string', enum: ['sprzedaz', 'finanse', 'magazyn'] },
        query: { type: 'string', description: 'Słowa z pytania, np. "należności przeterminowane"' },
      },
    },
  },
  {
    name: 'run_template',
    description:
      'Wykonuje szablon SQL o danym id z parametrami (typowane, przekazywane do sterownika — nie wklejane w SQL). ' +
      'Ta sama bramka tylko-do-odczytu i limity co execute_sql; w stopce id szablonu i data weryfikacji.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'id z list_templates' },
        params: { type: 'object', description: 'Parametry, np. {"od":"2026-09-01","do":"2026-10-01"}' },
      },
    },
  },
];

export function sqlTypeFor(def, value, sql) {
  switch (def.type) {
    case 'date': return sql.Date;
    case 'int': return sql.Int;
    case 'number': return sql.Decimal(18, 4);
    case 'text': return sql.NVarChar(def.maxLength);
    case 'enum':
      return Number.isInteger(value) ? sql.Int : sql.NVarChar(Math.max(...def.values.map((v) => String(v).length)));
    default: throw new Error(`nieznany typ parametru: ${def.type}`);
  }
}

/** Data → północ UTC (tedious ma domyślnie useUTC=true, więc granica dnia się nie przesuwa). */
export function toDriverValue(def, value) {
  if (value === null || value === undefined) return null;
  if (def.type === 'date') {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  return value;
}

function formatRows(rows, footer) {
  const capped = rows.slice(0, MAX_ROWS);
  let body = JSON.stringify(capped, null, 1);
  let note = `${rows.length} wierszy`;
  if (rows.length > MAX_ROWS) note += `, pokazano pierwsze ${MAX_ROWS}`;
  if (body.length > MAX_CHARS) {
    body = body.slice(0, MAX_CHARS);
    note += `, wynik przycięty do ${MAX_CHARS} znaków`;
  }
  return `${note}\n${body}${footer ? `\n— ${footer}` : ''}`;
}

const errText = (err) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

export function createTools({ getPool, sql, catalogDir = DEFAULT_CATALOG_DIR, audit }) {
  async function executeSql(text) {
    const query = String(text ?? '');
    const gate = checkReadOnly(query);
    if (!gate.ok) {
      audit('mcp', { ok: false, reason: gate.reason, query });
      throw new Error(`odrzucone (tryb tylko-do-odczytu): ${gate.reason}`);
    }
    const started = Date.now();
    let res;
    try {
      res = await (await getPool()).request().query(query);
    } catch (err) {
      audit('mcp', { ok: false, reason: `błąd wykonania: ${errText(err)}`, query });
      throw err;
    }
    const rows = res.recordset ?? [];
    audit('mcp', { ok: true, rows: rows.length, ms: Date.now() - started, query });
    return formatRows(rows);
  }

  function listTemplates({ area, query } = {}) {
    const { templates, errors } = loadCatalog(catalogDir);
    const found = searchTemplates(templates, { area, query });
    const out = found.map((t) => ({
      id: t.id,
      title: t.title,
      area: t.area,
      params: Object.fromEntries(Object.entries(t.params).map(([n, d]) => [n, `${d.type}${d.required ? '' : '?'} — ${d.description} (np. ${d.example})`])),
      questions: t.questions,
      verified: t.verified,
    }));
    let text = `${out.length} szablon(ów)${query ? ` dla „${query}”` : ''}${area ? ` w obszarze ${area}` : ''}\n${JSON.stringify(out, null, 1)}`;
    if (errors.length) text += `\nBłędne pliki katalogu (pominięte):\n- ${errors.join('\n- ')}`;
    return text;
  }

  async function executeTemplate(id, params) {
    const { templates, errors } = loadCatalog(catalogDir);
    const template = templates.find((t) => t.id === id);
    if (!template) {
      const bad = errors.find((e) => e.includes(`/${id}.md:`));
      throw new Error(bad ? `szablon ${id} jest błędny: ${bad}` : `nieznany szablon: ${id} (użyj list_templates)`);
    }
    const v = validateParams(template, params ?? {});
    if (!v.ok) {
      audit('template', { templateId: id, ok: false, reason: v.reason, params: params ?? {} });
      throw new Error(`parametry: ${v.reason}`);
    }
    const gate = checkReadOnly(template.sql);
    if (!gate.ok) {
      audit('template', { templateId: id, ok: false, reason: gate.reason, params: v.values });
      throw new Error(`odrzucone (tryb tylko-do-odczytu): ${gate.reason}`);
    }
    const started = Date.now();
    let res;
    try {
      const req = (await getPool()).request();
      for (const [name, def] of Object.entries(template.params)) {
        req.input(name, sqlTypeFor(def, v.values[name], sql), toDriverValue(def, v.values[name]));
      }
      res = await req.query(template.sql);
    } catch (err) {
      audit('template', { templateId: id, ok: false, reason: `błąd wykonania: ${errText(err)}`, params: v.values });
      throw err;
    }
    const rows = res.recordset ?? [];
    const ms = Date.now() - started;
    audit('template', { templateId: id, ok: true, rows: rows.length, ms, params: v.values });
    return { template, rows, ms };
  }

  async function runTemplate({ id, params } = {}) {
    const { template, rows } = await executeTemplate(String(id ?? ''), params);
    return formatRows(rows, `szablon ${template.id} · zweryfikowany ${template.verified}`);
  }

  return { executeSql, listTemplates, executeTemplate, runTemplate };
}
```

- [ ] **Step 4: Uruchom testy — mają przejść**

Run: `npx vitest run tools/mssql-introspect/test/mcp-tools.test.mjs tools/mssql-introspect/test/templates.test.mjs`
Expected: PASS.

- [ ] **Step 5: Przepnij `mcp-server.mjs` na `createTools`**

Zastąp w `tools/mssql-introspect/mcp-server.mjs`:
- nagłówek (linie 1–8): `Jedyne narzędzie: execute_sql (SELECT).` → `Narzędzia: execute_sql (SELECT), list_templates i run_template (szablony z templates/, parametry przez request.input). Logika narzędzi: src/mcp-tools.mjs.`
- usuń: importy `appendFileSync, mkdirSync`, `dirname`, `checkReadOnly`, stałe `QUERY_LOG`, `MAX_ROWS`, `MAX_CHARS`, funkcje `auditQuery` i `runQuery`, tablicę `TOOLS`;
- dodaj importy i instancję narzędzi pod `getPool()`:

```js
import { auditQuery } from './src/query-log.mjs';
import { createTools, TOOL_DEFS } from './src/mcp-tools.mjs';
```

```js
const tools = createTools({ getPool, sql, audit: auditQuery });
```

- w `handle`: `serverInfo: { name: 'mssql-ilovelighting', version: '0.2.0' }`, `tools/list` → `{ tools: TOOL_DEFS }`, a `tools/call`:

```js
  if (method === 'tools/call') {
    const args = params?.arguments ?? {};
    const run = {
      execute_sql: () => tools.executeSql(String(args.query ?? '')),
      list_templates: async () => tools.listTemplates({ area: args.area, query: args.query }),
      run_template: () => tools.runTemplate({ id: args.id, params: args.params }),
    }[params?.name];
    if (!run) throw { code: -32601, message: `nieznane narzędzie: ${params?.name}` };
    try {
      return { content: [{ type: 'text', text: await run() }] };
    } catch (err) {
      return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  }
```

`loadConfig`, `getPool`, pętla readline i `rl.on('close')` bez zmian.

- [ ] **Step 6: Smoke protokołu bez bazy**

Run:
```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_templates","arguments":{}}}' | MSSQL_ENV_FILE=/nonexistent node tools/mssql-introspect/mcp-server.mjs 2>/dev/null
```
Expected: trzy linie JSON; `id:2` zawiera `execute_sql`, `list_templates`, `run_template`; `id:3` zwraca tekst zaczynający się od `0 szablon(ów)` (katalog `templates/` jeszcze nie istnieje — to poprawne, połączenie z bazą nie jest otwierane).

- [ ] **Step 7: CLI `run-template.mjs`**

Create `tools/mssql-introspect/run-template.mjs`:

```js
#!/usr/bin/env node
// Runner hostowy: JEDEN szablon z katalogu templates/ przez te same narzędzia co serwer MCP
// (src/mcp-tools.mjs: walidacja parametrów, bramka, request.input, log via=template). Dla sesji,
// w których proces MCP ma jeszcze stary kod (nowe narzędzia ładują się dopiero po restarcie).
// Użycie: node tools/mssql-introspect/run-template.mjs <id> [nazwa=wartość ...] [--env plik] [--max-rows 50]
// Wynik: JSON {template, verified, count, ms, rows} na stdout; błąd walidacji/bramki = kod 2.

import { readFileSync } from 'node:fs';
import sql from 'mssql';
import { configFromEnv, parseEnvFile } from './src/env.mjs';
import { createTools } from './src/mcp-tools.mjs';
import { auditQuery } from './src/query-log.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const envFile = opt('--env', '/etc/kag/mssql-ilovelighting.env');
const maxRows = Number(opt('--max-rows', '200'));
const KNOWN = new Set(['--env', '--max-rows']);
const positional = args.filter((a, i) => !KNOWN.has(a) && !KNOWN.has(args[i - 1] ?? ''));
const [id, ...pairs] = positional;
if (!id) {
  console.error('użycie: run-template.mjs <id> [nazwa=wartość ...] [--env plik] [--max-rows N]');
  process.exit(2);
}
const params = Object.fromEntries(pairs.map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));

let pool;
const getPool = async () => (pool ??= await new sql.ConnectionPool(configFromEnv(parseEnvFile(readFileSync(envFile, 'utf8')), envFile)).connect());
const tools = createTools({ getPool, sql, audit: auditQuery });
try {
  const { template, rows, ms } = await tools.executeTemplate(id, params);
  console.log(JSON.stringify({ template: template.id, verified: template.verified, count: rows.length, ms, rows: rows.slice(0, maxRows) }, null, 1));
} catch (err) {
  console.error(`błąd: ${err.message}`);
  process.exitCode = /^(parametry|nieznany szablon|szablon .* jest błędny|odrzucone)/.test(err.message) ? 2 : 1;
} finally {
  await pool?.close();
}
```

- [ ] **Step 8: CLI `verify-templates.mjs`**

Create `tools/mssql-introspect/verify-templates.mjs`:

```js
#!/usr/bin/env node
// Weryfikacja katalogu na produkcji: każdy szablon (albo obszar / jeden id) wykonany raz z wartościami
// `example` przez te same narzędzia co MCP. --write ustawia `verified` na dzisiejszą datę w plikach,
// które przeszły. Błąd któregokolwiek szablonu = kod wyjścia 1 (nie publikujemy dokumentów z błędem).
// Użycie: node tools/mssql-introspect/verify-templates.mjs [--area sprzedaz] [--id x] [--write] [--env plik]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sql from 'mssql';
import { configFromEnv, parseEnvFile } from './src/env.mjs';
import { createTools, DEFAULT_CATALOG_DIR } from './src/mcp-tools.mjs';
import { auditQuery } from './src/query-log.mjs';
import { loadCatalog, setVerified } from './src/templates.mjs';

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const envFile = opt('--env', '/etc/kag/mssql-ilovelighting.env');
const area = opt('--area');
const onlyId = opt('--id');
const write = args.includes('--write');
const today = new Date().toISOString().slice(0, 10);

const { templates, errors } = loadCatalog(DEFAULT_CATALOG_DIR);
for (const e of errors) console.log(`BŁĄD PLIKU  ${e}`);
const todo = templates.filter((t) => (!area || t.area === area) && (!onlyId || t.id === onlyId));
let pool;
const getPool = async () => (pool ??= await new sql.ConnectionPool(configFromEnv(parseEnvFile(readFileSync(envFile, 'utf8')), envFile)).connect());
const tools = createTools({ getPool, sql, audit: auditQuery });
let failed = errors.length;
try {
  for (const t of todo) {
    const example = Object.fromEntries(Object.entries(t.params).map(([n, d]) => [n, d.example]));
    try {
      const { rows, ms } = await tools.executeTemplate(t.id, example);
      console.log(`OK    ${t.id.padEnd(48)} ${String(rows.length).padStart(5)} wierszy ${String(ms).padStart(6)} ms`);
      if (write) {
        const path = join(DEFAULT_CATALOG_DIR, t.file);
        writeFileSync(path, setVerified(readFileSync(path, 'utf8'), today));
      }
    } catch (err) {
      failed += 1;
      console.log(`FAIL  ${t.id.padEnd(48)} ${err.message.split('\n')[0].slice(0, 200)}`);
    }
  }
} finally {
  await pool?.close();
}
console.log(`\nsprawdzono ${todo.length}, błędów ${failed}${write ? `, verified=${today} zapisane dla udanych` : ''}`);
process.exitCode = failed > 0 ? 1 : 0;
```

- [ ] **Step 9: Pełne testy narzędzia + lint + commit**

Run: `npx vitest run tools/mssql-introspect && npm run lint`
Expected: wszystkie testy PASS (w tym dotychczasowe `mcp-readonly`, `queries-*`), lint czysty.

```bash
git add tools/mssql-introspect/src/mcp-tools.mjs tools/mssql-introspect/mcp-server.mjs tools/mssql-introspect/run-template.mjs tools/mssql-introspect/verify-templates.mjs tools/mssql-introspect/test/mcp-tools.test.mjs
git commit -m "feat(mssql): list_templates and run_template MCP tools with typed parameters; run/verify CLIs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Migracja 46 szablonów i konwencji do repo

**Files:**
- Create: skrypt migracji migrate-kpi-templates w tools/mssql-introspect (jednorazowy — usunięty w Task 8, jest w historii git)
- Create: test skryptu migracji w tools/mssql-introspect/test (usunięty razem ze skryptem w Task 8, jest w historii git)
- Create: `tools/mssql-introspect/templates/{sprzedaz,finanse,magazyn}/*.md` (wynik skryptu)
- Create: `tools/mssql-introspect/instance/konwencje-instancji.md` (kopia + potwierdzenia właściciela)
- Test: `tools/mssql-introspect/test/templates-catalog.test.mjs` (stały — pilnuje prawdziwego katalogu)

**Interfaces:**
- Consumes (Task 1): `parseTemplate`, `loadCatalog`, `AREAS`; `stringify` z `yaml`.
- Produces: katalog `templates/` przechodzący `loadCatalog` bez błędów; `splitKpiDoc(markdown, {area, fallbackVerified}) → {rules: string, templates: Array<{id, raw, flags: string[]}>}` (tylko na potrzeby migracji).

- [ ] **Step 1: Test funkcji rozcinającej (failing)**

Create test skryptu migracji (migrate-kpi-templates.test w tools/mssql-introspect/test — usunięty w Task 8, jest w historii git):

```js
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
```

- [ ] **Step 2: Uruchom — ma paść**

Run: `npx vitest run` na teście skryptu migracji (migrate-kpi-templates.test w tools/mssql-introspect/test — usunięty w Task 8, jest w historii git)
Expected: FAIL — brak `../migrate-kpi-templates.mjs`.

- [ ] **Step 3: Zaimplementuj skrypt migracji**

Create skrypt migracji migrate-kpi-templates w tools/mssql-introspect (usunięty w Task 8, jest w historii git):

```js
#!/usr/bin/env node
// JEDNORAZOWA migracja (2026-09-28): dokumenty redakcyjne kpi-*.md z /srv/kag-data/import/ilovekb/out/docs
// → katalog templates/<obszar>/<id>.md + _zasady.md. Czysty zakres dat (jedno `>= 'X'`, jedno `< 'Y'`)
// zamieniany na @od/@do; reszta oflagowana do ręcznego przeglądu. Usuwany po migracji (Task 8 planu).
// Użycie: node tools/mssql-introspect/migrate-kpi-templates.mjs --src <out/docs> --out tools/mssql-introspect/templates

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify } from 'yaml';
import { normalizeText } from './src/templates.mjs';

const FILES = { sprzedaz: 'kpi-sprzedaz.md', finanse: 'kpi-finanse.md', magazyn: 'kpi-magazyn.md' };
const RULE_HEADINGS = /^(Zasady wspólne|Wspólne ustalenia|Model rozrachunków)/;
const CODES_HEADING = /^Słownik kodów/;

/** ascii kebab-case bez prefiksu „KPI N — ”; dłuższe niż 60 znaków cięte na granicy słowa. */
export function slugify(title) {
  const s = normalizeText(title.replace(/^KPI\s+\d+\s+—\s+/, '')).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length <= 60) return s;
  const cut = s.slice(0, 61);
  return cut.slice(0, cut.lastIndexOf('-')).replace(/-+$/, '');
}

function parametrize(sql) {
  const flags = [];
  const lits = [...sql.matchAll(/'(\d{4}-\d{2}-\d{2})'/g)].map((m) => m[1]);
  const ge = [...new Set([...sql.matchAll(/>=\s*'(\d{4}-\d{2}-\d{2})'/g)].map((m) => m[1]))];
  const lt = [...new Set([...sql.matchAll(/<\s*'(\d{4}-\d{2}-\d{2})'/g)].map((m) => m[1]))];
  let out = sql;
  let params = {};
  const distinct = new Set(lits);
  if (ge.length === 1 && lt.length === 1 && distinct.size === 2 && ge[0] < lt[0]) {
    out = out.replaceAll(`'${ge[0]}'`, '@od').replaceAll(`'${lt[0]}'`, '@do')
      .replace(/^--\s*zakres:.*$/m, '-- zakres: [@od, @do) — przedział półotwarty');
    params = {
      od: { type: 'date', description: 'początek zakresu (włącznie)', example: ge[0] },
      do: { type: 'date', description: 'koniec zakresu (wyłącznie)', example: lt[0] },
    };
  } else if (lits.length > 0) {
    flags.push(`literały dat: ${lits.length} — parametryzuj ręcznie`);
  }
  if (/GETDATE\s*\(/i.test(sql)) flags.push('GETDATE — rozważ parametr daty odniesienia');
  return { sql: out, params, flags };
}

function renderTemplate({ id, title, area, order, params, verified, body, sql }) {
  const meta = stringify({ id, title, area, order, questions: [`Jak policzyć: ${title}?`], params, verified }, { lineWidth: 0 }).trimEnd();
  // funkcja zastępująca: `$` w SQL nie może być interpretowany jako wzorzec podstawienia
  return `---\n${meta}\n---\n${body.replace('@@SQL@@', () => `\`\`\`sql\n${sql.trim()}\n\`\`\``).trim()}\n`;
}

export function splitKpiDoc(markdown, { area, fallbackVerified }) {
  const text = markdown.replace(/\r\n/g, '\n');
  const parts = text.split(/^## /m);
  const intro = parts[0].replace(/^# .*\n/, '').trim();
  const rules = [intro];
  const codes = [];
  const templates = [];
  let order = 0;
  for (const part of parts.slice(1)) {
    const nl = part.indexOf('\n');
    const heading = part.slice(0, nl).trim();
    const content = part.slice(nl + 1);
    if (RULE_HEADINGS.test(heading)) { rules.push(`## ${heading}\n${content.trim()}`); continue; }
    if (CODES_HEADING.test(heading)) { codes.push(`## ${heading}\n${content.trim()}`); continue; }
    const verified = content.match(/wykona(?:no|ne)\s+(\d{4}-\d{2}-\d{2})/)?.[1] ?? fallbackVerified;
    const cleaned = content.replace(/^Szablon SQL \(T-SQL\):\s*\n/m, '').replace(/^- Test:.*\n?/m, '');
    const blocks = [...cleaned.matchAll(/```sql\n([\s\S]*?)```/g)];
    const title = heading.replace(/^KPI\s+\d+\s+—\s+/, '');
    const baseId = slugify(heading);
    blocks.forEach((b, i) => {
      order += 10;
      let body = cleaned;
      blocks.forEach((other, j) => { body = body.replace(other[0], j === i ? '@@SQL@@' : ''); });
      const p = parametrize(b[1]);
      const flags = ['pytania do uzupełnienia', ...p.flags];
      if (blocks.length > 1) flags.push('dwa bloki SQL — rozdzielono, przejrzyj opis');
      const id = i === 0 ? baseId : `${baseId}-${i + 1}`;
      templates.push({ id, flags, raw: renderTemplate({ id, title: i === 0 ? title : `${title} (wariant ${i + 1})`, area, order, params: p.params, verified, body, sql: p.sql }) });
    });
  }
  return { rules: `${[...rules, ...codes].filter(Boolean).join('\n\n')}\n`, templates };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const src = opt('--src');
  const out = opt('--out');
  if (!src || !out) { console.error('użycie: migrate-kpi-templates.mjs --src <out/docs> --out <templates>'); process.exit(2); }
  for (const [area, file] of Object.entries(FILES)) {
    const r = splitKpiDoc(readFileSync(join(src, file), 'utf8'), { area, fallbackVerified: '2026-09-14' });
    mkdirSync(join(out, area), { recursive: true });
    writeFileSync(join(out, area, '_zasady.md'), r.rules);
    for (const t of r.templates) {
      writeFileSync(join(out, area, `${t.id}.md`), t.raw);
      console.log(`${area}/${t.id}.md${t.flags.length ? `  [${t.flags.join('; ')}]` : ''}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

- [ ] **Step 4: Uruchom test — ma przejść**

Run: `npx vitest run` na teście skryptu migracji (migrate-kpi-templates.test w tools/mssql-introspect/test — usunięty w Task 8, jest w historii git)
Expected: PASS. Jeśli `slugify` zostawia końcowy myślnik lub ucina w pół słowa, popraw wyrażenie tak, by test `aging-naleznosci-0-30-31-60` przechodził (cięcie do 60 znaków na granicy słowa).

- [ ] **Step 5: Uruchom migrację na prawdziwych dokumentach**

Run:
```bash
node tools/mssql-introspect/migrate-kpi-templates.mjs --src /srv/kag-data/import/ilovekb/out/docs --out tools/mssql-introspect/templates | tee /tmp/claude-0/-kag/523fd27c-bad0-41df-8491-3eb34e7ba95b/scratchpad/migration-flags.txt
ls tools/mssql-introspect/templates/*/ | head -80
```
Expected: 3 pliki `_zasady.md` + 48 szablonów (46 sekcji + 2 warianty z sekcji o dwóch blokach: „KPI 1 — Należności otwarte” i „Realizacja zamówień od klientów”). Lista flag zapisana w scratchpadzie — to lista pracy dla Task 4–6.

- [ ] **Step 6: Konwencje instancji do repo z potwierdzeniami właściciela**

```bash
mkdir -p tools/mssql-introspect/instance
cp /srv/kag-data/import/ilovekb/out/docs/konwencje-instancji.md tools/mssql-introspect/instance/konwencje-instancji.md
```

Edycje w `tools/mssql-introspect/instance/konwencje-instancji.md`:
- nagłówek `### 5.3 Zmiana konwencji od marca 2026 (paragony → faktury) — DO POTWIERDZENIA` → `### 5.3 Zmiana konwencji od marca 2026 (paragony → faktury) — potwierdzone przez właściciela 2026-09-28`;
- w §5.3 linię zaczynającą się od `- Interpretacja:` zamień początek `- Interpretacja: od marca 2026` na `- Potwierdzone (właściciel, 2026-09-28): od marca 2026`;
- nagłówek `### 5.6 Kategorie dokumentów (sl_Kategoria) = kanał sprzedaży — DO POTWIERDZENIA` → `### 5.6 Kategorie dokumentów (sl_Kategoria) = kanał sprzedaży — potwierdzone przez właściciela 2026-09-28`;
- w §5.6 linię `- Odczyt nazw (DO POTWIERDZENIA):` → `- Odczyt nazw (potwierdzony przez właściciela 2026-09-28; „Sprzedaż" = sprzedaż stacjonarna, „lampy_24h_sanok" = sklep internetowy, nie punkt fizyczny):`.

Run: `grep -n "DO POTWIERDZENIA" tools/mssql-introspect/instance/konwencje-instancji.md`
Expected: brak trafień w §5.3 i §5.6 (inne sekcje, jeśli mają ten znacznik, zostają — nie były potwierdzane).

- [ ] **Step 7: Stały test prawdziwego katalogu**

Create `tools/mssql-introspect/test/templates-catalog.test.mjs`:

```js
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AREAS, loadCatalog } from '../src/templates.mjs';

const DIR = fileURLToPath(new URL('../templates/', import.meta.url));

describe('katalog szablonów w repo (templates/)', () => {
  const c = loadCatalog(DIR);
  it('zero błędnych plików', () => {
    expect(c.errors).toEqual([]);
  });
  it('każdy obszar ma zasady i szablony; co najmniej 46 szablonów', () => {
    for (const area of AREAS) {
      expect(c.rules[area], area).toBeTruthy();
      expect(c.templates.some((t) => t.area === area), area).toBe(true);
    }
    expect(c.templates.length).toBeGreaterThanOrEqual(46);
  });
});
```

Run: `npx vitest run tools/mssql-introspect/test/templates-catalog.test.mjs`
Expected: PASS. Jeśli padają pojedyncze pliki (np. `checkReadOnly` na szablonie, który dotąd przechodził tylko po ręcznej podmianie), popraw plik ręcznie i uruchom ponownie.

- [ ] **Step 8: Commit**

```bash
git add tools/mssql-introspect/migrate-kpi-templates.mjs tools/mssql-introspect/test/migrate-kpi-templates.test.mjs tools/mssql-introspect/test/templates-catalog.test.mjs tools/mssql-introspect/templates tools/mssql-introspect/instance
git commit -m "feat(mssql): migrate 46 IloveKB KPI templates and instance conventions into the repo catalog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Obszar `sprzedaz` — parametry, pytania, reguła 03.2026, weryfikacja

**Files:**
- Modify: `tools/mssql-introspect/templates/sprzedaz/*.md` (wszystkie szablony obszaru)
- Modify: `tools/mssql-introspect/templates/sprzedaz/_zasady.md`

**Interfaces:**
- Consumes: katalog z Task 3, `verify-templates.mjs` i `run-template.mjs` z Task 2, lista flag w scratchpadzie `migration-flags.txt`.
- Produces: szablony sprzedaży bez flag, z realnymi pytaniami, `verified` = data przebiegu; ID używane przez skill i akceptację (nazwy wynikowe po migracji — zanotuj je w raporcie z tego zadania).

Reguły przeglądu każdego pliku (dotyczą też Task 5 i 6):
1. **Pytania:** zastąp `Jak policzyć: …?` 1–3 naturalnymi pytaniami właściciela (tak, jak by je zadał po polsku). Pytania akceptacyjne z tego obszaru wpisz dosłownie do właściwych szablonów: „Ile wyniósł przychód netto we wrześniu 2026 i jak wypada względem września 2025?” (szablon YoY miesięczny), „Jakie 10 marek sprzedało się najlepiej w ostatnim kwartale i jaką miały marżę brutto?” (top marek), „Jak zmienia się średnia wartość paragonu i faktury miesiąc do miesiąca w tym roku?” (średnia wartość faktury i paragonu).
2. **Daty:** każdy literał daty zakresu → `@od`/`@do`; zakres porównawczy (YoY) → `@od_prev`/`@do_prev` z własnymi `example`; daty w komentarzu `-- zakres:` zaktualizuj opisowo.
3. **`GETDATE()`**: w szablonach „dziś/wczoraj/ostatnie N dni” zostaw `GETDATE()` tylko, gdy szablon z definicji liczy względem dziś — wtedy dopisz w „Pułapkach”, że wynik zależy od chwili wykonania; w pozostałych dodaj `@dzien: {type: date}` zamiast `GETDATE()`.
4. **Stałe biznesowe:** `TOP 10`/`TOP 20` → `TOP (@n)` z `n: {type: int, required: false, default: 10}` tam, gdzie pytania o „top N” są naturalne; magazyn → `mag: {type: enum, values: [1, 5, 6], required: false}` z `(@mag IS NULL OR d.dok_MagId = @mag)` tylko jeśli pytanie o magazyn ma sens.
5. **Wariant 2** (z sekcji z dwoma blokami): popraw tytuł na treściowy (np. „Otwarte zamówienia starsze niż N dni”), usuń z opisu zdania dotyczące drugiego zapytania; w pierwszym szablonie usuń zdania o wariancie.
6. **Reguła 03.2026** (spec §1 „Potwierdzenia”): w szablonach „Udział paragonów vs faktur”, „Średnia wartość faktury i paragonu”, „Zwroty detaliczne (ZW)”, „Korekty faktur sprzedaży (KFS)” dopisz w „Pułapkach” punkt: `Od 03.2026 sprzedaż detaliczna jest dokumentowana fakturą FS zamiast paragonu PA, a zwroty korektą KFS zamiast ZW (potwierdzone przez właściciela 2026-09-28) — w porównaniach przez tę datę detal = PA + FS detaliczne, zwroty = ZW + KFS; spadek PA i ZW po 02.2026 to zmiana dokumentowania, nie sprzedaży.` Tę samą regułę dopisz raz w `_zasady.md` jako ostatni punkt listy.
7. Nic poza tym — nie przepisuj definicji, formuł ani interpretacji, które są zweryfikowane.

- [ ] **Step 1: Lista pracy obszaru**

Run: `grep '^sprzedaz/' /tmp/claude-0/-kag/523fd27c-bad0-41df-8491-3eb34e7ba95b/scratchpad/migration-flags.txt`
Expected: lista plików z flagami (każdy ma co najmniej „pytania do uzupełnienia”).

- [ ] **Step 2: Przegląd i edycja plików wg reguł 1–7**

Edytuj każdy plik z listy. Po każdych kilku plikach:
Run: `npx vitest run tools/mssql-introspect/test/templates-catalog.test.mjs`
Expected: PASS (błąd wskazuje plik i problem — np. `parametry w SQL niezadeklarowane: od_prev`).

- [ ] **Step 3: Weryfikacja na produkcji**

Run: `node tools/mssql-introspect/verify-templates.mjs --area sprzedaz --write`
Expected: same `OK`, `błędów 0`, `verified=<dziś> zapisane dla udanych`. Jeśli klasyfikator uprawnień zablokuje uruchomienie, poproś właściciela o `! node tools/mssql-introspect/verify-templates.mjs --area sprzedaz --write` i przeczytaj wynik. `FAIL` = napraw szablon (typowe: `@od_prev` porównany z kolumną innego typu, brak `CAST`) i powtórz.

- [ ] **Step 4: Kontrola sensu liczb (przychód 2025)**

Run: `node tools/mssql-introspect/run-template.mjs przychod-netto-ze-sprzedazy-miesiecznie od=2025-01-01 do=2026-01-01`
Expected: 12 wierszy; suma `net_sales` ≈ 12,81 mln zł (wartość z `_zasady.md`, stan 2026-09-14; dopuszczalna różnica < 0,5% — korekty po fakcie). Większa rozbieżność = błąd parametryzacji, wróć do Step 2.

- [ ] **Step 5: Commit**

```bash
git add tools/mssql-introspect/templates/sprzedaz
git commit -m "feat(mssql): sales templates parametrized, owner questions, 03.2026 receipt-to-invoice rule; verified on production

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Obszar `finanse` — parametry, pytania, weryfikacja

**Files:**
- Modify: `tools/mssql-introspect/templates/finanse/*.md`, `tools/mssql-introspect/templates/finanse/_zasady.md` (tylko jeśli potrzebne)

**Interfaces:**
- Consumes: jak Task 4.
- Produces: szablony finansów bez flag, `verified` = data przebiegu.

Reguły przeglądu: **identyczne z regułami 1–5 i 7 z Task 4** (pytania, daty → `@od`/`@do`/`@od_prev`/`@do_prev`, `GETDATE()` → `@dzien` gdy wynik ma dotyczyć wskazanego dnia, `TOP (@n)`, wariant 2 z „KPI 1 — Należności otwarte”). Dodatkowo:
- Pytania akceptacyjne: „Ile mamy należności przeterminowanych o ponad 60 dni i jaki to procent wszystkich należności?” → szablon aging należności; „Który klient kupuje u nas najwięcej?” → szablon koncentracji sprzedaży wg klientów (Top 10 / Top 50, HHI) — sprawdź, że zwraca rangi/identyfikatory, a nie nazwy.
- Stany na dzień (należności/zobowiązania otwarte, aging) dostają `dzien: {type: date, description: dzień, na który liczony jest stan (wiek względem tej daty)}` zamiast `GETDATE()`, żeby dało się odpowiedzieć „stan na koniec sierpnia”.
- Szablony z listą kontrahentów (Top 20 dłużników): upewnij się, że projekcja to wyłącznie ranga/`kh_Id`/kwoty — bramka i tak odrzuci nazwy, ale test `templates-catalog` musi przechodzić.

- [ ] **Step 1: Lista pracy obszaru**

Run: `grep '^finanse/' /tmp/claude-0/-kag/523fd27c-bad0-41df-8491-3eb34e7ba95b/scratchpad/migration-flags.txt`
Expected: lista plików z flagami.

- [ ] **Step 2: Przegląd i edycja plików wg reguł**

Po każdych kilku plikach:
Run: `npx vitest run tools/mssql-introspect/test/templates-catalog.test.mjs`
Expected: PASS.

- [ ] **Step 3: Weryfikacja na produkcji**

Run: `node tools/mssql-introspect/verify-templates.mjs --area finanse --write`
Expected: same `OK`, `błędów 0` (przy blokadzie klasyfikatora — komenda z `!` dla właściciela).

- [ ] **Step 4: Kontrola sensu liczb (należności)**

Run: `node tools/mssql-introspect/run-template.mjs <id-aging-należności> dzien=<dzisiejsza data>` (id z katalogu — `grep -l "Aging należności" tools/mssql-introspect/templates/finanse/*.md`)
Expected: kubełki 0–30/31–60/61–90/90+ z sumą równą saldu z szablonu „Należności otwarte” dla tego samego dnia (`run-template.mjs <id-należności-otwarte> dzien=<ta sama data>`), różnica 0,00 zł.

- [ ] **Step 5: Commit**

```bash
git add tools/mssql-introspect/templates/finanse
git commit -m "feat(mssql): finance templates parametrized (as-of date, ranges), owner questions; verified on production

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Obszar `magazyn` — parametry, pytania, weryfikacja

**Files:**
- Modify: `tools/mssql-introspect/templates/magazyn/*.md`, `tools/mssql-introspect/templates/magazyn/_zasady.md` (tylko jeśli potrzebne)

**Interfaces:**
- Consumes: jak Task 4.
- Produces: szablony magazynu bez flag, `verified` = data przebiegu.

Reguły przeglądu: **identyczne z regułami 1–5 i 7 z Task 4**. Dodatkowo:
- Pytania akceptacyjne: „Które towary marki X leżą w magazynie ponad 180 dni bez sprzedaży i ile jest w nich zamrożonej gotówki?” → szablon „Towary bez ruchu N dni (dead stock)”, parametry `dni: {type: int, example: 180}` i `marka: {type: text, required: false, maxLength: 100}` z warunkiem `(@marka IS NULL OR g.grt_Nazwa = @marka)`; „Ile dni zapasu mamy dla 10 najlepiej sprzedających się marek?” → szablon „Pokrycie zapasu w dniach (days of cover) wg marki” z `TOP (@n)`.
- Stany magazynowe „na dziś” (wartość zapasu, wiek zapasu, stany ujemne) mogą zostać bez daty — stan bieżący z definicji; dopisz to w „Pułapkach” jednym zdaniem, jeśli jeszcze nie ma.

- [ ] **Step 1: Lista pracy obszaru**

Run: `grep '^magazyn/' /tmp/claude-0/-kag/523fd27c-bad0-41df-8491-3eb34e7ba95b/scratchpad/migration-flags.txt`
Expected: lista plików z flagami.

- [ ] **Step 2: Przegląd i edycja plików wg reguł**

Po każdych kilku plikach:
Run: `npx vitest run tools/mssql-introspect/test/templates-catalog.test.mjs`
Expected: PASS.

- [ ] **Step 3: Weryfikacja na produkcji**

Run: `node tools/mssql-introspect/verify-templates.mjs --area magazyn --write`
Expected: same `OK`, `błędów 0`.

- [ ] **Step 4: Kontrola parametru tekstowego**

Run: `node tools/mssql-introspect/run-template.mjs <id-dead-stock> dni=180 marka=Rabalux` oraz to samo z `marka="Nieistniejąca marka"`
Expected: pierwsze — wiersze tylko marki Rabalux (albo 0, jeśli brak martwego zapasu); drugie — 0 wierszy bez błędu.

- [ ] **Step 5: Pełna weryfikacja katalogu + commit**

Run: `node tools/mssql-introspect/verify-templates.mjs && npx vitest run tools/mssql-introspect`
Expected: `błędów 0` dla całego katalogu; testy PASS.

```bash
git add tools/mssql-introspect/templates/magazyn
git commit -m "feat(mssql): inventory templates parametrized (days, brand, top N), owner questions; verified on production

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Generowanie dokumentów IloveKB z katalogu (`prepare-kpi.mjs`)

**Files:**
- Create: `tools/kb-import/prepare-kpi.mjs`
- Modify: `deploy/scripts/refresh_ilovekb.sh` (krok `prepare-kpi` + komentarz nagłówka)
- Test: `tools/kb-import/test/prepare-kpi.test.mjs`

**Interfaces:**
- Consumes (Task 1): `loadCatalog(dir)`, `AREAS`, `Template`; katalog `tools/mssql-introspect/templates`, plik `tools/mssql-introspect/instance/konwencje-instancji.md`.
- Produces:
  - `renderAreaDoc({area, templates, rules}) → string`
  - `generateKpiDocs({catalog: {templates, rules}, konwencje: string, sourceBase: string}) → {files: Array<{file, text}>, entries: ManifestEntry[]}`
  - `ManifestEntry = {file, title, sourceUrl, category, product, part: 1, parts: 1, chars, keywords: string[], sourceFile}` (kształt jak w `prepare-instance.mjs`)
  - `MAX_DOC_CHARS = 95_000`

- [ ] **Step 1: Testy (failing)**

Create `tools/kb-import/test/prepare-kpi.test.mjs`:

```js
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
```

- [ ] **Step 2: Uruchom — ma paść**

Run: `npx vitest run tools/kb-import/test/prepare-kpi.test.mjs`
Expected: FAIL — brak `../prepare-kpi.mjs`.

- [ ] **Step 3: Implementacja**

Create `tools/kb-import/prepare-kpi.mjs`:

```js
#!/usr/bin/env node
// Katalog szablonów SQL (tools/mssql-introspect/templates) + konwencje instancji → dokumenty IloveKB:
// kpi-sprzedaz.md, kpi-finanse.md, kpi-magazyn.md, konwencje-instancji.md — z TYMI SAMYMI tytułami
// i sourceUrl co przy imporcie 2026-09-14 (re-import zastępuje wersje; goldens po sourceRef).
// Manifest SCALANY z istniejącym (wpisy agregatów, dostawców, słowników zostają).
// Użycie: node tools/kb-import/prepare-kpi.mjs --out <out/docs> --source-base <url> [--templates <dir>] [--konwencje <plik>]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AREAS, loadCatalog } from '../mssql-introspect/src/templates.mjs';

export const MAX_DOC_CHARS = 95_000;
const PRODUCT = 'Subiekt GT (Magnum_Profi)';
const INSTANCE = 'Magnum_Profi';
const DOCS = {
  sprzedaz: { file: 'kpi-sprzedaz.md', slug: 'kpi-sprzedaz', title: 'Magnum_Profi — KPI: sprzedaż i marża (szablony SQL)', keywords: ['KPI sprzedaży', 'szablon SQL', 'dok__Dokument', 'dok_Pozycja', 'sl_GrupaTw'] },
  finanse: { file: 'kpi-finanse.md', slug: 'kpi-finanse', title: 'Magnum_Profi — KPI: finanse i klienci (szablony SQL)', keywords: ['KPI', 'SQL', 'rozrachunki', 'nz__Finanse', 'sl_FormaPlatnosci', 'kh_OdbDet'] },
  magazyn: { file: 'kpi-magazyn.md', slug: 'kpi-magazyn', title: 'Magnum_Profi — KPI: magazyn i zakupy (szablony SQL)', keywords: ['KPI', 'magazyn', 'zakupy', 'dok_MagRuch', 'FIFO', 'tw_SklepInternet'] },
};
const KONWENCJE = {
  file: 'konwencje-instancji.md', slug: 'konwencje', title: 'Magnum_Profi — konwencje i semantyka instancji', category: 'konwencje instancji',
  keywords: ['Magnum_Profi', 'konwencje', 'rola kontrahenta', 'klient hurtowy', 'pola własne', 'poziomy cen', 'marki', 'typy dokumentów', 'kanały sprzedaży'],
};
const HOST_RE = /192\.168\.|INSERTGT|DESKTOP-/;

function paramLine(name, d) {
  const flags = [d.type, ...(d.required ? [] : ['opcjonalny']), ...(d.default !== undefined ? [`domyślnie ${d.default}`] : [])];
  const extra = d.type === 'enum' ? `; dozwolone: ${d.values.join(', ')}` : d.type === 'text' ? `; maks. ${d.maxLength} znaków` : '';
  return `- \`@${name}\` (${flags.join(', ')}) — ${d.description}; przykład: ${d.example}${extra}`;
}

export function renderAreaDoc({ area, templates, rules }) {
  const L = [`# ${DOCS[area].title}`, '', rules.trim(), ''];
  for (const t of [...templates].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
    L.push(`## ${t.title}`, '', t.body.trim(), '');
    const params = Object.entries(t.params);
    L.push(params.length ? `Parametry:\n${params.map(([n, d]) => paramLine(n, d)).join('\n')}` : 'Parametry: brak.', '');
    L.push(`Przykładowe pytania: ${t.questions.join(' · ')}`, '');
    L.push(`Wykonanie: \`run_template ${t.id}\` (serwer MCP mssql) albo \`node tools/mssql-introspect/run-template.mjs ${t.id}\`. Zweryfikowano na produkcji: ${t.verified}.`, '');
  }
  return `${L.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function entry({ file, slug, title, category, keywords, text, sourceBase, sourceFile }) {
  return { file, title, sourceUrl: `${sourceBase}#dokumentacja/instancja/${slug}`, category, product: PRODUCT, part: 1, parts: 1, chars: text.length, keywords, sourceFile };
}

function guard(file, text) {
  if (HOST_RE.test(text)) throw new Error(`${file}: adres hosta bazy w treści — przerywam`);
  if (text.length > MAX_DOC_CHARS) throw new Error(`${file}: ${text.length} znaków > ${MAX_DOC_CHARS} (limit uploadu 100000) — podziel obszar`);
}

export function generateKpiDocs({ catalog, konwencje, sourceBase }) {
  if (!sourceBase) throw new Error('brak sourceBase (--source-base)');
  const files = [];
  const entries = [];
  for (const area of AREAS) {
    const templates = catalog.templates.filter((t) => t.area === area);
    if (templates.length === 0) continue;
    const d = DOCS[area];
    const text = renderAreaDoc({ area, templates, rules: catalog.rules[area] ?? '' });
    guard(d.file, text);
    files.push({ file: d.file, text });
    entries.push(entry({ ...d, category: 'mapowanie KPI → SQL', keywords: [PRODUCT, INSTANCE, ...d.keywords, ...templates.map((t) => t.title)], text, sourceBase, sourceFile: `templates/${area}` }));
  }
  const k = `${konwencje.trim()}\n`;
  guard(KONWENCJE.file, k);
  files.push({ file: KONWENCJE.file, text: k });
  entries.push(entry({ ...KONWENCJE, text: k, sourceBase, sourceFile: 'instance/konwencje-instancji.md' }));
  return { files, entries };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const out = opt('--out');
  const sourceBase = opt('--source-base');
  const tplDir = opt('--templates', fileURLToPath(new URL('../mssql-introspect/templates/', import.meta.url)));
  const konwFile = opt('--konwencje', fileURLToPath(new URL('../mssql-introspect/instance/konwencje-instancji.md', import.meta.url)));
  if (!out || !sourceBase) {
    console.error('użycie: prepare-kpi.mjs --out <out/docs> --source-base <url> [--templates <dir>] [--konwencje <plik>]');
    process.exit(2);
  }
  const catalog = loadCatalog(tplDir);
  if (catalog.errors.length) {
    console.error(`błędne szablony — dokumenty NIE zostały wygenerowane:\n- ${catalog.errors.join('\n- ')}`);
    process.exit(3);
  }
  let result;
  try {
    result = generateKpiDocs({ catalog, konwencje: readFileSync(konwFile, 'utf8'), sourceBase });
  } catch (err) {
    console.error(`błąd: ${err.message}`);
    process.exit(3);
  }
  mkdirSync(out, { recursive: true });
  for (const f of result.files) writeFileSync(join(out, f.file), f.text);
  const manifestPath = join(out, 'manifest.json');
  let previous = { entries: [] };
  try { previous = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { /* pierwszy przebieg */ }
  const mine = new Set(result.entries.map((e) => e.file));
  const kept = (previous.entries ?? []).filter((e) => !mine.has(e.file));
  writeFileSync(manifestPath, JSON.stringify({ ...previous, generatedAt: new Date().toISOString(), entries: [...kept, ...result.entries] }, null, 2));
  console.log(`szablonów: ${catalog.templates.length}, plików: ${result.files.length}, znaków: ${result.entries.reduce((a, e) => a + e.chars, 0)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

- [ ] **Step 4: Testy — mają przejść**

Run: `npx vitest run tools/kb-import/test/prepare-kpi.test.mjs`
Expected: PASS.

- [ ] **Step 5: Próba na prawdziwym katalogu (do scratchpada, bez uploadu)**

Run:
```bash
S=/tmp/claude-0/-kag/523fd27c-bad0-41df-8491-3eb34e7ba95b/scratchpad/kpi-preview
mkdir -p $S && node tools/kb-import/prepare-kpi.mjs --out $S --source-base https://kag.ilovelighting.sanok.pl/src/magnum-profi
wc -c $S/*.md; grep -c '^## ' $S/kpi-*.md
```
Expected: 4 pliki, każdy < 95 000 znaków; liczba nagłówków `##` = szablony obszaru + sekcje zasad. Przejrzyj `kpi-sprzedaz.md` wzrokowo (pierwsze 80 linii).

- [ ] **Step 6: Krok w `refresh_ilovekb.sh`**

W `deploy/scripts/refresh_ilovekb.sh`:
- w komentarzu nagłówka zdanie `Katalog schematu, konwencje i szablony KPI NIE są regenerowane (dokumenty redakcyjne; ich wpisy w manifeście zostają — prepare-instance scala manifest).` zamień na `Szablony KPI i konwencje są renderowane z repo (tools/mssql-introspect/templates, instance/) przez prepare-kpi; katalog schematu NIE jest regenerowany. Oba prepare-* scalają manifest.`;
- po linii z `prepare-instance.mjs … --k 10` dodaj:

```bash
node tools/kb-import/prepare-kpi.mjs --out "$E/out/docs" --source-base "$SB"
```

Run: `bash -n deploy/scripts/refresh_ilovekb.sh && echo ok`
Expected: `ok`.

- [ ] **Step 7: Commit**

```bash
git add tools/kb-import/prepare-kpi.mjs tools/kb-import/test/prepare-kpi.test.mjs deploy/scripts/refresh_ilovekb.sh
git commit -m "feat(kb-import): render IloveKB KPI and conventions documents from the repo template catalog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Skill `erp-analyst`, dokumentacja, sprzątanie migracji

**Files:**
- Create: `.claude/skills/erp-analyst/SKILL.md`
- Modify: `docs/data-governance.md` (§1.3 droga 3 — punkt o szablonach)
- Modify: `docs/design/PLAN.md` (wiersz w „Zmiany decyzji po zatwierdzeniu”, na końcu tabeli)
- Modify: `CLAUDE.md` (sekcja Komendy)
- Modify: `tools/mssql-introspect/mcp-server.mjs` (tylko komentarz rejestracji — bez zmian kodu, jeśli już zrobione w Task 2)
- Delete: skrypt migracji migrate-kpi-templates i jego test (usunięte po migracji, są w historii git)

**Interfaces:**
- Consumes: narzędzia MCP `list_templates`, `run_template`, `execute_sql`; CLI `run-template.mjs`; katalog i konwencje w repo.
- Produces: skill wyzwalany pytaniami o liczby firmy.

- [ ] **Step 1: Skill**

Create `.claude/skills/erp-analyst/SKILL.md`:

````markdown
---
name: erp-analyst
description: Odpowiedzi na pytania o liczby firmy ilovelighting z produkcyjnej bazy Subiekta GT (Magnum_Profi) — sprzedaż, przychód, marża, marki, kanały (e-sklepy, marketplace'y, stacjonarnie), magazyn i zapas, należności, zobowiązania, klienci, dostawcy, KPI. Najpierw zweryfikowany szablon SQL (list_templates → run_template), potem zapytanie ad hoc z kontrolą krzyżową; odpowiedź zawsze z założeniami i źródłem, klienci bez nazw; udane zapytanie ad hoc → propozycja nowego szablonu. Używaj ZAWSZE, gdy pada „ile sprzedaliśmy…", „policz…", „jaki przychód/marża/zapas/należności…", „top marek/towarów/klientów", „porównaj z zeszłym rokiem", albo pytanie o dowolny wskaźnik firmy.
---

# Analityk ERP (Magnum_Profi)

Cel: poprawna liczba z jawnymi założeniami i źródłem. Wiarygodnie wyglądająca, ale zła liczba jest
gorsza niż brak odpowiedzi — przy wątpliwości mów, czego nie wiesz.

Narzędzia: serwer MCP `mssql` (`list_templates`, `run_template`, `execute_sql`) — tylko sesja Claude Code
na hoście. Jeśli `list_templates` nie jest dostępne (proces MCP ze starym kodem), użyj
`node tools/mssql-introspect/run-template.mjs <id> nazwa=wartość …` i czytaj katalog
`tools/mssql-introspect/templates/` bezpośrednio.

## Przepływ

1. **Doprecyzuj pytanie.** Daty względne zamień na zakresy półotwarte `[od, do)` wg dzisiejszej daty
   („wrzesień 2026” → `od=2026-09-01`, `do=2026-10-01`; „ostatni kwartał” = ostatni pełny kwartał
   kalendarzowy; „ten rok” = od 1 stycznia do jutra). Zapisz to jako założenie. Pytaj właściciela
   tylko, gdy od interpretacji zależy wynik, a kontekst jej nie rozstrzyga (np. „marża” na towarach
   czy z usługami).
2. **Szablon najpierw.** `list_templates` z `query` = kluczowe słowa pytania; bez trafienia — z samym
   `area`. Przeczytaj opis i „Pułapki” wybranego szablonu (plik w `templates/<obszar>/<id>.md`)
   i `_zasady.md` obszaru. Wykonaj `run_template` z parametrami.
3. **Brak szablonu → zapytanie ad hoc.** Przeczytaj `templates/<obszar>/_zasady.md` i
   `tools/mssql-introspect/instance/konwencje-instancji.md` (kanały sprzedaży §5.6, zmiana 03.2026 §5.3,
   typy/statusy dokumentów §5). Schemat tabel: `kb_search` w SubiektKB/IloveKB. Zbuduj zapytanie na
   wzór najbliższego szablonu (te same filtry bazowe), wykonaj `execute_sql`.
   **Kontrola krzyżowa:** wynik ad hoc, który da się uzgodnić z szablonem bazowym (np. suma po kanałach
   = przychód z szablonu miesięcznego dla tego samego zakresu), uzgodnij — rozbieżność > 0,01 zł =
   nie podawaj liczby, opisz rozbieżność i jej prawdopodobną przyczynę.
4. **Odpowiedź** (po polsku, zwięźle):
   - wynik: liczby albo mała tabela (kwoty w zł netto z separatorem tysięcy, procenty z 1 miejscem);
   - jedno zdanie interpretacji (kontekst z „Interpretacji” szablonu, np. sezonowość);
   - **Założenia:** zakres dat, filtry („FS+PA, status 1, przed korektami i zwrotami”), reguły instancji;
   - **Źródło:** `szablon <id>, zweryfikowany <data>` albo „zapytanie ad hoc (bez szablonu)”;
   - użyte zapytanie (id + parametry albo SQL ad hoc) w bloku kodu.
5. **Prywatność.** Kontrahenci wyłącznie jako rangi i identyfikatory (`kh_Id`), nigdy nazwy ani dane
   kontaktowe — nawet gdy właściciel prosi o „nazwę klienta”: odpowiedz rangą i wyjaśnij, że nazwy
   są poza zakresem odczytu (docs/data-governance.md §1.3). Liczebności kontrahentów w grupie < 10 →
   „<10”. Bramka odrzuci kolumny osobowe — nie próbuj jej obchodzić.
6. **Pętla uczenia.**
   - Udane zapytanie ad hoc, które odpowiada na pytanie prawdopodobnie powtarzalne → zaproponuj nowy
     plik `templates/<obszar>/<id>.md` (format: istniejący szablon; `questions` z pytaniem właściciela;
     SQL z `@parametrami` zamiast wartości). Sprawdź: `npx vitest run tools/mssql-introspect/test/templates-catalog.test.mjs`
     i `node tools/mssql-introspect/verify-templates.mjs --id <id> --write`. Pokaż diff i zapytaj
     o zgodę; commit (`feat(mssql): template <id>`) dopiero po „tak”.
   - Szablon pasował, ale `list_templates` go nie znalazło po słowach pytania → zaproponuj dopisanie
     pytania do jego `questions` (ta sama ścieżka: diff → zgoda → commit).
   - Zmiana w szablonach dociera do IloveKB przy miesięcznym odświeżeniu (5. dnia) albo ręcznie wg
     skilla `kb-reimport` (`prepare-kpi` → upload → promote → build).

## Reguły instancji, o których łatwo zapomnieć

- Przychód = FS (2) + PA (21) ze statusem 1; WZ (11) i ZK (16) to nie sprzedaż.
- Od 03.2026 detal jest na FS zamiast PA, a zwroty na KFS zamiast ZW (potwierdzone 2026-09-28) —
  porównania rok do roku rozbić na PA/FS tylko z tą adnotacją.
- Kanał sprzedaży = kategoria dokumentu `dok_KatId` (§5.6): `Sprzedaż` = stacjonarnie,
  `lampy_24h_sanok` = sklep internetowy, `Wycena` = nie sprzedaż.
- Kwoty są w PLN także dla faktur walutowych.
````

- [ ] **Step 2: Governance, PLAN, CLAUDE.md**

W `docs/data-governance.md` w §1.3 „Droga 3”, po punkcie `- *Kontrole (bramka …)*` dodaj punkt:

```markdown
- *Szablony (od 2026-09-28):* narzędzia `list_templates`/`run_template` wykonują zweryfikowane
  szablony z `tools/mssql-introspect/templates/` (repo, przegląd w git); parametry są typowane
  i przekazywane do sterownika (`request.input`), SQL szablonu przechodzi tę samą bramkę. Log:
  wpis `via: "template"` z `templateId` i wartościami parametrów (bez wyników). Parametry tekstowe
  (np. nazwa marki) nie są danymi osobowymi; kolumn osobowych nie da się użyć w szablonie, bo
  bramka odrzuci go już w testach katalogu.
```

W `docs/design/PLAN.md` dopisz na końcu tabeli „Zmiany decyzji po zatwierdzeniu” wiersz:

```markdown
| 2026-09-28 | Serwer MCP `mssql` (decyzja 2026-09-11) z jednym narzędziem `execute_sql` | **Decyzja 2026-09-11 bez zmian** (tylko Claude Code roota na hoście, bramka, log); serwer zyskuje `list_templates`/`run_template` nad katalogiem zweryfikowanych szablonów w repo (`tools/mssql-introspect/templates/`), a dokumenty KPI i konwencje w IloveKB są z niego generowane (`prepare-kpi.mjs`). Spec: `docs/superpowers/specs/2026-09-28-erp-analyst-design.md`. Dostęp zdalnych agentów do danych ERP nadal wymaga osobnej decyzji. |
```

W `CLAUDE.md`, w bloku Komendy po linii z `run-select.mjs`, dodaj:

```bash
node tools/mssql-introspect/run-template.mjs <id> od=2026-09-01 do=2026-10-01   # szablon SQL z katalogu templates/ (to samo co MCP run_template)
node tools/mssql-introspect/verify-templates.mjs [--area sprzedaz] [--write]      # katalog szablonów na produkcji; --write ustawia verified
node tools/kb-import/prepare-kpi.mjs --out <out/docs> --source-base <url>          # dokumenty KPI+konwencje IloveKB z katalogu szablonów
```

- [ ] **Step 3: Usuń jednorazową migrację**

```bash
git rm tools/mssql-introspect/migrate-kpi-templates.mjs tools/mssql-introspect/test/migrate-kpi-templates.test.mjs
```

- [ ] **Step 4: Pełne testy, lint, typecheck, ścieżki w dokumentacji**

Run: `npm test && npm run lint && docs/check-doc-paths.sh`
Expected: wszystkie testy PASS (liczba ≥ dotychczasowej minus 2 usunięte pliki testów migracji plus nowe), lint czysty, `check-doc-paths` bez brakujących ścieżek.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/erp-analyst/SKILL.md docs/data-governance.md docs/design/PLAN.md CLAUDE.md
git commit -m "feat(skills): erp-analyst skill; governance, decision log and commands for the SQL template catalog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Publikacja w IloveKB, przeładowanie MCP i akceptacja

**Files:**
- Modify: `tools/eval/goldens/IloveKB.jsonl` (3 goldens)
- Modify: `docs/superpowers/specs/2026-09-28-erp-analyst-design.md` (sekcja „Wynik”)

**Interfaces:**
- Consumes: wszystko z Task 1–8; skill `kb-reimport` (procedura upload → promote → build → purge → bramka).
- Produces: IloveKB z dokumentami z katalogu; zaakceptowane 8 pytań; wypchnięty `main`.

- [ ] **Step 1: Baseline eval IloveKB (przed)**

Run: `DATA_DIR=/srv/kag-data/kag/panel node tools/eval/run-eval.mjs tools/eval/goldens/IloveKB.jsonl | tee /tmp/claude-0/-kag/523fd27c-bad0-41df-8491-3eb34e7ba95b/scratchpad/eval-before.txt | tail -5`
Expected: wiersz z hit@k/MRR — zapisany jako punkt odniesienia.

- [ ] **Step 2: Goldens dla nowych pytań**

Dopisz do `tools/eval/goldens/IloveKB.jsonl` trzy linie:

```json
{"question": "ile wyniósł przychód netto we wrześniu 2026 i jak wypada względem września 2025", "namespaces": ["IloveKB"], "expectedNamespace": "IloveKB", "kind": "keyword", "expectedSourceRefs": ["#dokumentacja/instancja/kpi-sprzedaz"]}
{"question": "ile mamy należności przeterminowanych o ponad 60 dni i jaki to procent wszystkich należności", "namespaces": ["IloveKB"], "expectedNamespace": "IloveKB", "kind": "keyword", "expectedSourceRefs": ["#dokumentacja/instancja/kpi-finanse"]}
{"question": "które towary leżą w magazynie ponad 180 dni bez sprzedaży i ile jest w nich zamrożonej gotówki", "namespaces": ["IloveKB"], "expectedNamespace": "IloveKB", "kind": "keyword", "expectedSourceRefs": ["#dokumentacja/instancja/kpi-magazyn"]}
```

- [ ] **Step 3: Publikacja (wg skilla `kb-reimport`)**

```bash
E=/srv/kag-data/import/ilovekb
node tools/kb-import/prepare-kpi.mjs --out "$E/out/docs" --source-base https://kag.ilovelighting.sanok.pl/src/magnum-profi
grep -rlE '192\.168\.|INSERTGT|DESKTOP-' "$E/out/docs" && echo "STOP: adres hosta" || echo "bramka hosta OK"
node tools/kb-import/set-limits.mjs 1500 1500
node tools/kb-import/upload.mjs --dir "$E/out/docs" --only '^(kpi-|konwencje)'
node tools/kb-import/promote.mjs --dir "$E/out/docs" --namespace IloveKB
node tools/kb-import/build.mjs --namespace IloveKB
node tools/kb-import/set-limits.mjs 100 25
sudo deploy/scripts/purge_graph_nodes.sh --namespace IloveKB --limit 4000 --apply
node tools/kb-import/quality-gate.mjs IloveKB
```
Expected: `bramka hosta OK`; upload wysyła 4 pliki (zmieniony sha); build kończy się sukcesem; bramka jakości `graph_stale_nodes: OK` (`superseded_documents: WARN` jest informacyjne). `set-limits 100 25` MUSI zostać wykonane także przy błędzie wcześniejszego kroku.

- [ ] **Step 4: Eval po**

Run: `DATA_DIR=/srv/kag-data/kag/panel node tools/eval/run-eval.mjs tools/eval/goldens/IloveKB.jsonl | tee /tmp/claude-0/-kag/523fd27c-bad0-41df-8491-3eb34e7ba95b/scratchpad/eval-after.txt | tail -5`
Expected: hit@k i MRR dla starych goldens ≥ wartości z `eval-before.txt`; 3 nowe goldens trafione. Spadek = porównaj `sourceRef` chybionych pytań i popraw pytania/`questions` szablonów, potem ponów Step 3.

- [ ] **Step 5: Przeładowanie serwera MCP (właściciel)**

Poproś właściciela: „Wpisz `/mcp`, wybierz `mssql` → Reconnect (albo zrestartuj Claude Code)”. Po powrocie sprawdź, że narzędzia `mcp__mssql__list_templates` i `mcp__mssql__run_template` są dostępne (ToolSearch `select:mcp__mssql__list_templates,mcp__mssql__run_template`).

- [ ] **Step 6: Akceptacja — 8 pytań ze skillem**

Dla każdego pytania z tabeli akceptacji w specyfikacji (§5) wywołaj skill `erp-analyst` i zanotuj: użyte narzędzie (`run_template <id>` / `execute_sql`), parametry, wynik (liczba/wiersze), czy odpowiedź zawiera Założenia i Źródło, czy spełnia „Oczekiwane zachowanie”. Pytanie 7 musi zakończyć się propozycją pliku nowego szablonu (diff) — zatwierdzenie commitem tylko po zgodzie właściciela. Pytanie 8 — brak nazw kontrahentów w odpowiedzi.

- [ ] **Step 7: Wynik w specyfikacji**

Dopisz na końcu `docs/superpowers/specs/2026-09-28-erp-analyst-design.md`:

```markdown
## Wynik (<data>)

| # | Narzędzie / szablon | Wynik (skrót) | Zachowanie zgodne |
|---|---|---|---|
| 1 | … | … | tak/nie — uwagi |
…

Eval IloveKB: przed <hit@k/MRR>, po <hit@k/MRR>. Bramka jakości: <werdykt>.
```

(wypełnione faktycznymi wartościami z Step 1, 4 i 6 — bez pozostawionych `…`).

- [ ] **Step 8: Commit i push**

```bash
git add tools/eval/goldens/IloveKB.jsonl docs/superpowers/specs/2026-09-28-erp-analyst-design.md
git commit -m "docs(spec): ERP analyst acceptance results; IloveKB goldens for KPI template questions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push origin main
```
Expected: push przechodzi (hook gitleaks OK), `git status -sb` → `## main...origin/main`.
