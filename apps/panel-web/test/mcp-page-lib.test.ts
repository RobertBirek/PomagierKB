import { describe, expect, it } from 'vitest';
import {
  countActiveKeys,
  filterKeys,
  latencyVariant,
  sortKeys,
  validateCreateKeyForm,
  type CreateKeyFormInput,
} from '../src/components/mcp/mcp-page-lib';

function key(
  id: string,
  label: string,
  userId: string,
  profileId = 'standard',
  status = 'active',
  expiresAt = '2026-12-01T00:00:00Z',
) {
  return { id, userId, label, prefix: `sk-${id}`, profileId, status, expiresAt };
}

const OWNERS: Record<string, string> = { u1: 'Robert', u2: 'n8n-produkcja' };
const ownerName = (userId: string): string => OWNERS[userId] ?? userId;

const KEYS = [
  key('a', 'Claude Code — laptop', 'u1'),
  key('b', 'Automatyzacja n8n', 'u2', 'zawezone'),
  key('c', 'Stary klucz', 'u1', 'standard', 'revoked'),
];

describe('filterKeys()', () => {
  it('pusta fraza zwraca kopię wszystkich', () => {
    const out = filterKeys(KEYS, '  ', ownerName);
    expect(out).toHaveLength(3);
    expect(out).not.toBe(KEYS);
  });

  it('filtruje po etykiecie (case-insensitive)', () => {
    expect(filterKeys(KEYS, 'claude', ownerName).map((k) => k.id)).toEqual(['a']);
  });

  it('filtruje po nazwie właściciela i profilu', () => {
    expect(filterKeys(KEYS, 'robert', ownerName).map((k) => k.id)).toEqual(['a', 'c']);
    expect(filterKeys(KEYS, 'zawezone', ownerName).map((k) => k.id)).toEqual(['b']);
  });

  it('filtruje po prefiksie klucza', () => {
    expect(filterKeys(KEYS, 'sk-b', ownerName).map((k) => k.id)).toEqual(['b']);
  });
});

describe('sortKeys()', () => {
  it('sort po właścicielu asc (resolver nazw)', () => {
    const out = sortKeys(KEYS, { key: 'owner', dir: 'asc' }, ownerName);
    expect(out.map((k) => k.userId)).toEqual(['u2', 'u1', 'u1']);
  });

  it('sort po etykiecie desc', () => {
    const out = sortKeys(KEYS, { key: 'label', dir: 'desc' }, ownerName);
    expect(out[0]?.id).toBe('c');
  });

  it('bez sortu zachowuje kolejność wejścia', () => {
    expect(sortKeys(KEYS, undefined, ownerName).map((k) => k.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('countActiveKeys()', () => {
  it('liczy tylko klucze active danego konta', () => {
    expect(countActiveKeys(KEYS, 'u1')).toBe(1); // 'c' jest revoked
    expect(countActiveKeys(KEYS, 'u2')).toBe(1);
    expect(countActiveKeys(KEYS, 'nieznany')).toBe(0);
    expect(countActiveKeys([], 'u1')).toBe(0);
  });
});

describe('latencyVariant()', () => {
  it('progi ok<500 / warn<2000 / fail', () => {
    expect(latencyVariant(0)).toBe('ok');
    expect(latencyVariant(499)).toBe('ok');
    expect(latencyVariant(500)).toBe('warn');
    expect(latencyVariant(1999)).toBe('warn');
    expect(latencyVariant(2000)).toBe('fail');
  });
});

describe('validateCreateKeyForm()', () => {
  const base: CreateKeyFormInput = {
    label: 'Klucz',
    profileId: 'standard',
    identity: 'me',
    serviceId: '',
    newServiceName: '',
    ttlDays: 90,
  };

  it('poprawny formularz przechodzi', () => {
    expect(validateCreateKeyForm(base)).toEqual({ ok: true, errors: [] });
  });

  it('błędy per pole: etykieta, profil, TTL', () => {
    const result = validateCreateKeyForm({ ...base, label: '  ', profileId: '', ttlDays: 0 });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['label', 'profile', 'ttl']);
  });

  it('TTL: tylko liczby całkowite 1–365', () => {
    expect(validateCreateKeyForm({ ...base, ttlDays: 366 }).errors).toEqual(['ttl']);
    expect(validateCreateKeyForm({ ...base, ttlDays: 1.5 }).errors).toEqual(['ttl']);
    expect(validateCreateKeyForm({ ...base, ttlDays: Number.NaN }).errors).toEqual(['ttl']);
    expect(validateCreateKeyForm({ ...base, ttlDays: 1 }).ok).toBe(true);
    expect(validateCreateKeyForm({ ...base, ttlDays: 365 }).ok).toBe(true);
  });

  it('tożsamość service wymaga wybranego konta', () => {
    expect(validateCreateKeyForm({ ...base, identity: 'service' }).errors).toEqual(['service']);
    expect(validateCreateKeyForm({ ...base, identity: 'service', serviceId: 'u2' }).ok).toBe(true);
  });

  it('tożsamość new wymaga nazwy konta', () => {
    expect(validateCreateKeyForm({ ...base, identity: 'new', newServiceName: ' ' }).errors).toEqual([
      'serviceName',
    ]);
    expect(validateCreateKeyForm({ ...base, identity: 'new', newServiceName: 'bot' }).ok).toBe(true);
  });
});
