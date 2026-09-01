import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateApiKey, hashToken, timingSafeEqualStr } from '../src/crypto/keys.js';
import { seal, unseal } from '../src/crypto/seal.js';

describe('generateApiKey', () => {
  it('zwraca raw sk-<base64url 24B>, sha256 hex i prefix 6 znaków', () => {
    const key = generateApiKey();
    expect(key.raw).toMatch(/^sk-[A-Za-z0-9_-]{32}$/); // 24 B base64url = 32 znaki
    expect(key.prefix).toBe(key.raw.slice(0, 6));
    expect(key.prefix).toHaveLength(6);
    expect(key.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(key.hash).toBe(createHash('sha256').update(key.raw).digest('hex'));
  });

  it('generuje unikalne klucze', () => {
    const raws = new Set(Array.from({ length: 200 }, () => generateApiKey().raw));
    expect(raws.size).toBe(200);
  });
});

describe('hashToken', () => {
  it('jest deterministyczny i zgodny z generateApiKey', () => {
    const key = generateApiKey();
    expect(hashToken(key.raw)).toBe(key.hash);
    expect(hashToken('sk-abc')).toBe(hashToken('sk-abc'));
    expect(hashToken('sk-abc')).not.toBe(hashToken('sk-abd'));
  });
});

describe('timingSafeEqualStr', () => {
  it('true dla identycznych stringów (w tym pustych)', () => {
    expect(timingSafeEqualStr('sk-abc123', 'sk-abc123')).toBe(true);
    expect(timingSafeEqualStr('', '')).toBe(true);
  });

  it('false dla różnych stringów tej samej długości', () => {
    expect(timingSafeEqualStr('sk-abc123', 'sk-abc124')).toBe(false);
  });

  it('false dla różnych długości (bez wyjątku)', () => {
    expect(timingSafeEqualStr('sk-abc', 'sk-abc123')).toBe(false);
    expect(timingSafeEqualStr('sk-abc123', '')).toBe(false);
    expect(timingSafeEqualStr('', 'x')).toBe(false);
  });
});

describe('seal/unseal (AES-256-GCM)', () => {
  const key = randomBytes(32).toString('base64');

  it('roundtrip zachowuje treść (w tym unicode i pusty string)', () => {
    for (const pt of ['sekret LLM sk-xyz', '', 'zażółć gęślą jaźń 🔑', 'a'.repeat(10_000)]) {
      const sealed = seal(pt, key);
      if (pt.length >= 8) expect(sealed).not.toContain(pt.slice(0, 8)); // ciphertext ≠ plaintext
      expect(unseal(sealed, key)).toBe(pt);
    }
  });

  it('każdy seal daje inny wynik (losowy IV)', () => {
    expect(seal('to samo', key)).not.toBe(seal('to samo', key));
  });

  it('zły klucz → deterministyczny błąd uwierzytelnienia', () => {
    const sealed = seal('tajne', key);
    const otherKey = randomBytes(32).toString('base64');
    expect(() => unseal(sealed, otherKey)).toThrowError(/authentication failed/);
  });

  it('uszkodzony ciphertext/tag → błąd uwierzytelnienia', () => {
    const sealed = seal('tajne dane', key);
    const buf = Buffer.from(sealed, 'base64');
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff; // psujemy ostatni bajt ciphertextu
    expect(() => unseal(buf.toString('base64'), key)).toThrowError(/authentication failed/);
    buf[12] = buf[12]! ^ 0xff; // psujemy tag
    expect(() => unseal(buf.toString('base64'), key)).toThrowError(/authentication failed/);
  });

  it('za krótki payload → deterministyczny błąd formatu', () => {
    expect(() => unseal(Buffer.alloc(10).toString('base64'), key)).toThrowError(/malformed/);
  });

  it('walidacja klucza: zła długość i nie-base64 → błąd', () => {
    expect(() => seal('x', randomBytes(16).toString('base64'))).toThrowError(/32 bytes/);
    expect(() => unseal(seal('x', key), randomBytes(31).toString('base64'))).toThrowError(/32 bytes/);
    expect(() => seal('x', '')).toThrowError(/base64/);
    expect(() => seal('x', '!!!nie-base64!!!')).toThrowError(/base64/);
  });
});
