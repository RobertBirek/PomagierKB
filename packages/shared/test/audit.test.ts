import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { appendAudit, computeAuditHash, sanitizeForAudit } from '../src/audit/append.js';
import { verifyChain } from '../src/audit/verify.js';
import { openDb, runMigrations, type Db } from '../src/db/index.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

function freshDb(): Db {
  const db = openDb(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}

function appendN(db: Db, n: number): void {
  for (let i = 0; i < n; i++) {
    appendAudit(db, {
      actor: `user-${i % 3}`,
      actorType: 'user',
      role: 'operator',
      action: 'draft.promote',
      resourceType: 'draft',
      resourceId: `draft_${i}`,
      after: { status: 'promoted', i },
    });
  }
}

/** Kopia wpisów audytu do świeżej bazy BEZ triggerów — do symulacji manipulacji. */
function copyWithoutTriggers(src: Db): Db {
  const copy = openDb(':memory:');
  copy.exec(`CREATE TABLE audit (
    seq INTEGER PRIMARY KEY, id TEXT, at TEXT, actor TEXT, actor_type TEXT, role TEXT,
    action TEXT, resource_type TEXT, resource_id TEXT, outcome TEXT,
    before_json TEXT, after_json TEXT, metadata_json TEXT, prev_hash TEXT, hash TEXT)`);
  const rows = src.prepare('SELECT * FROM audit ORDER BY seq').all() as Record<string, unknown>[];
  const ins = copy.prepare(`INSERT INTO audit VALUES
    (@seq, @id, @at, @actor, @actor_type, @role, @action, @resource_type, @resource_id,
     @outcome, @before_json, @after_json, @metadata_json, @prev_hash, @hash)`);
  for (const r of rows) ins.run(r);
  return copy;
}

describe('appendAudit + verifyChain', () => {
  it('łańcuch po N appendach jest weryfikowalny; pierwszy wpis ma prev_hash=""', () => {
    const db = freshDb();
    appendN(db, 12);
    const first = db.prepare('SELECT prev_hash, hash FROM audit WHERE seq = 1').get() as {
      prev_hash: string;
      hash: string;
    };
    expect(first.prev_hash).toBe('');
    const second = db.prepare('SELECT prev_hash FROM audit WHERE seq = 2').get() as {
      prev_hash: string;
    };
    expect(second.prev_hash).toBe(first.hash);

    const res = verifyChain(db, 5000);
    expect(res).toMatchObject({ valid: true, checked: 12, problems: [] });
    expect(res.firstBrokenSeq).toBeUndefined();
  });

  it('pusta tabela → valid, checked=0', () => {
    const db = freshDb();
    expect(verifyChain(db, 100)).toMatchObject({ valid: true, checked: 0, problems: [] });
  });

  it('limit mniejszy niż liczba wpisów → okno ucięte, origin pomijany', () => {
    const db = freshDb();
    appendN(db, 10);
    const res = verifyChain(db, 4);
    expect(res.valid).toBe(true);
    expect(res.checked).toBe(4);
  });

  it('appendAudit zwraca id aud_<uuid>, seq i hash', () => {
    const db = freshDb();
    const r = appendAudit(db, { actor: 'system', actorType: 'system', action: 'startup' });
    expect(r.id).toMatch(/^aud_[0-9a-f-]{36}$/);
    expect(r.seq).toBe(1);
    expect(r.prevHash).toBe('');
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('UPDATE/DELETE na audit rzuca (append-only triggery)', () => {
    const db = freshDb();
    appendN(db, 2);
    expect(() => db.prepare("UPDATE audit SET actor = 'intruz' WHERE seq = 1").run()).toThrowError(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM audit WHERE seq = 1').run()).toThrowError(/append-only/);
  });

  it('manipulacja treści wpisu (kopia bez triggerów) → hash_mismatch', () => {
    const db = freshDb();
    appendN(db, 8);
    const copy = copyWithoutTriggers(db);
    copy.prepare("UPDATE audit SET actor = 'intruz' WHERE seq = 3").run();

    const res = verifyChain(copy, 5000);
    expect(res.valid).toBe(false);
    expect(res.checked).toBe(8);
    expect(res.firstBrokenSeq).toBe(3);
    expect(res.problems).toContainEqual({ seq: 3, kind: 'hash_mismatch' });
  });

  it('manipulacja hasha wpisu → hash_mismatch + zerwanie łańcucha w następnym', () => {
    const db = freshDb();
    appendN(db, 6);
    const copy = copyWithoutTriggers(db);
    copy.prepare("UPDATE audit SET hash = 'deadbeef' WHERE seq = 4").run();

    const res = verifyChain(copy, 5000);
    expect(res.valid).toBe(false);
    expect(res.firstBrokenSeq).toBe(4);
    expect(res.problems).toContainEqual({ seq: 4, kind: 'hash_mismatch' });
    expect(res.problems).toContainEqual({ seq: 5, kind: 'chain_mismatch' });
  });

  it('usunięcie wpisu ze środka (kopia) → chain_mismatch', () => {
    const db = freshDb();
    appendN(db, 6);
    const copy = copyWithoutTriggers(db);
    copy.prepare('DELETE FROM audit WHERE seq = 3').run();

    const res = verifyChain(copy, 5000);
    expect(res.valid).toBe(false);
    expect(res.problems).toContainEqual({ seq: 4, kind: 'chain_mismatch' });
  });
});

describe('redakcja (sanitize)', () => {
  it('sekretne klucze redagowane rekurencyjnie, Bearer w stringach redagowany', () => {
    const db = freshDb();
    appendAudit(db, {
      actor: 'admin',
      actorType: 'user',
      action: 'settings.update',
      after: {
        password: 'super-tajne',
        config: {
          apiKey: 'sk-raw-key',
          api_key: 'sk-raw-2',
          nested: { refreshToken: 'r-123', deep: { Authorization: 'Bearer abc' } },
        },
        note: 'nagłówek: Bearer sk-abc123.def oraz reszta opisu',
        safe: 'jawna wartość',
      },
    });
    const row = db.prepare('SELECT after_json FROM audit WHERE seq = 1').get() as {
      after_json: string;
    };
    const after = JSON.parse(row.after_json) as Record<string, unknown>;
    expect(after['password']).toBe('[REDACTED]');
    const config = after['config'] as Record<string, unknown>;
    expect(config['apiKey']).toBe('[REDACTED]');
    expect(config['api_key']).toBe('[REDACTED]');
    const nested = config['nested'] as Record<string, unknown>;
    expect(nested['refreshToken']).toBe('[REDACTED]');
    expect((nested['deep'] as Record<string, unknown>)['Authorization']).toBe('[REDACTED]');
    expect(after['note']).toBe('nagłówek: Bearer [REDACTED] oraz reszta opisu');
    expect(after['safe']).toBe('jawna wartość');
    expect(row.after_json).not.toContain('super-tajne');
    expect(row.after_json).not.toContain('sk-raw');
    expect(row.after_json).not.toContain('sk-abc123');

    // hash liczony z danych PO redakcji — łańcuch weryfikowalny
    expect(verifyChain(db, 100).valid).toBe(true);
  });

  it('limity: stringi ≤4000, tablice ≤100, obiekty ≤200 pól, głębokość ≤8', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 300; i++) wide[`f${i}`] = i;
    let deep: unknown = 'dno';
    for (let i = 0; i < 15; i++) deep = { d: deep };

    const out = sanitizeForAudit({
      long: 'x'.repeat(5000),
      arr: Array.from({ length: 150 }, (_, i) => i),
      wide,
      deep,
    }) as Record<string, unknown>;

    expect((out['long'] as string).length).toBe(4000);
    expect((out['arr'] as unknown[]).length).toBe(100);
    expect(Object.keys(out['wide'] as object).length).toBe(200);
    expect(JSON.stringify(out['deep'])).toContain('[MAX_DEPTH]');
    expect(JSON.stringify(out['deep'])).not.toContain('dno');
  });

  it('stableSort: hash niezależny od kolejności kluczy w before/after', () => {
    const a = computeAuditHash({
      id: 'aud_x', at: 't', actor: 'a', actor_type: 'user', role: null, action: 'x',
      resource_type: null, resource_id: null, outcome: 'success',
      before: { b: 1, a: { z: 1, y: 2 } }, after: null, metadata: null, prev_hash: '',
    });
    const b = computeAuditHash({
      id: 'aud_x', at: 't', actor: 'a', actor_type: 'user', role: null, action: 'x',
      resource_type: null, resource_id: null, outcome: 'success',
      before: { a: { y: 2, z: 1 }, b: 1 }, after: null, metadata: null, prev_hash: '',
    });
    expect(a).toBe(b);
  });
});

describe('dwa równoległe połączenia do jednego pliku db', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('appendy z dwóch połączeń nie gubią wpisów, łańcuch spójny', () => {
    dir = mkdtempSync(join(tmpdir(), 'kag-audit-'));
    const path = join(dir, 'audit.db');
    const a = openDb(path);
    runMigrations(a, MIGRATIONS_DIR);
    const b = openDb(path);

    // naprzemienne i pseudolosowe przeploty appendów z obu połączeń
    const total = 60;
    for (let i = 0; i < total; i++) {
      const db = (i * 7 + 3) % 3 === 0 ? a : b;
      appendAudit(db, {
        actor: db === a ? 'panel-api' : 'mcp-server',
        actorType: 'system',
        action: 'test.append',
        metadata: { i },
      });
    }

    const c = openDb(path); // weryfikacja świeżym, trzecim połączeniem
    const count = (c.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n;
    expect(count).toBe(total);
    const res = verifyChain(c, 10_000);
    expect(res.valid).toBe(true);
    expect(res.checked).toBe(total);

    // każdy prev_hash wskazuje dokładnie na hash poprzednika — zero rozwidleń
    const rows = c.prepare('SELECT prev_hash, hash FROM audit ORDER BY seq').all() as {
      prev_hash: string;
      hash: string;
    }[];
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.prev_hash).toBe(rows[i - 1]!.hash);
    }
    a.close();
    b.close();
    c.close();
  });
});
