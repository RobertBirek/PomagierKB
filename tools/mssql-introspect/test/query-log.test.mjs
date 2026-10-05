import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditQuery } from '../src/query-log.mjs';

const dirs = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qlog-')); dirs.push(d); return d; };

describe('auditQuery', () => {
  it('dopisuje wpis JSONL z przyciętą treścią zapytania', () => {
    const file = join(tmp(), 'sub', 'queries.jsonl');
    auditQuery('mcp', { ok: true, query: `SELECT ${'x'.repeat(5000)}` }, file);
    const rec = JSON.parse(readFileSync(file, 'utf8').trim());
    expect(rec).toMatchObject({ via: 'mcp', ok: true });
    expect(rec.query).toHaveLength(4000);
  });
  it('nieudany zapis: jedno ostrzeżenie na stderr bez treści zapytania i parametrów, bez wyjątku', () => {
    const blocker = join(tmp(), 'plik');
    writeFileSync(blocker, '');
    const file = join(blocker, 'queries.jsonl'); // katalog nadrzędny jest plikiem → ENOTDIR
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => auditQuery('template', { ok: false, query: 'SELECT tajne', params: { marka: 'sekret' } }, file)).not.toThrow();
    auditQuery('template', { ok: false, query: 'SELECT tajne' }, file);
    expect(err).toHaveBeenCalledTimes(1);
    const msg = String(err.mock.calls[0][0]);
    expect(msg).toMatch(/log zapytań/);
    expect(msg).not.toMatch(/tajne|sekret/);
  });
});
