import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import {
  createKey,
  createProfile,
  deleteProfile,
  expireSweep,
  listAllKeys,
  listKeysForUser,
  revokeKey,
  rotateKey,
  touchUsage,
  verifyKey,
} from '../src/db/index.js';
import { testDb, seedUser } from './helpers.js';

describe('repos/apiKeys + mcpProfiles', () => {
  it('createKey: raw sk-... raz, verify bez zapisu, ttl 1..365', () => {
    const db = testDb();
    const uid = seedUser(db);
    const { row, raw } = createKey(db, uid, 'agent testowy', ['read'], 'default', 90);
    expect(raw).toMatch(/^sk-[A-Za-z0-9_-]{32}$/);
    expect(row.prefix).toBe(raw.slice(0, 6));
    expect(row).not.toHaveProperty('hash');

    const verified = verifyKey(db, raw);
    expect(verified?.id).toBe(row.id);
    expect(verified?.requests_count).toBe(0); // verify niczego nie zapisuje
    expect(verifyKey(db, 'sk-zupelnie-zly-token-000000000')).toBeNull();

    expect(() => createKey(db, uid, 'x', ['read'], 'default', 0)).toThrowError(/ttlDays/);
    expect(() => createKey(db, uid, 'x', ['read'], 'default', 366)).toThrowError(/ttlDays/);
  });

  it('rotate: nowy raw działa, stary unieważniony natychmiast, jedna transakcja', () => {
    const db = testDb();
    const uid = seedUser(db);
    const { row: oldRow, raw: oldRaw } = createKey(db, uid, 'do rotacji', ['read'], 'default', 30);
    const { row: newRow, raw: newRaw } = rotateKey(db, oldRow.id);

    expect(verifyKey(db, oldRaw)).toBeNull(); // stary raw martwy
    expect(verifyKey(db, newRaw)?.id).toBe(newRow.id);
    expect(newRow.id).not.toBe(oldRow.id);
    expect(newRow.expires_at).toBe(oldRow.expires_at); // rotacja nie przedłuża TTL

    const all = listKeysForUser(db, uid);
    expect(all.find((k) => k.id === oldRow.id)?.status).toBe('revoked');
    // rotate klucza nieaktywnego → conflict
    expect(() => rotateKey(db, oldRow.id)).toThrowError(/active/);
  });

  it('revoke, touchUsage batch, expireSweep, brak hasha na listach', () => {
    const db = testDb();
    const uid = seedUser(db);
    const a = createKey(db, uid, 'a', ['read'], 'default', 10);
    const b = createKey(db, uid, 'b', ['read', 'write'], 'default', 10);

    touchUsage(db, [a.row.id, a.row.id, b.row.id]);
    const rows = listAllKeys(db);
    expect(rows.find((k) => k.id === a.row.id)?.requests_count).toBe(2);
    expect(rows.find((k) => k.id === b.row.id)?.requests_count).toBe(1);
    expect(rows.every((k) => !('hash' in k))).toBe(true);

    revokeKey(db, a.row.id);
    expect(verifyKey(db, a.raw)).toBeNull();
    expect(() => revokeKey(db, a.row.id)).toThrowError(/active/);

    // sztucznie przeterminuj b → sweep oznacza expired i verify odmawia
    db.prepare("UPDATE api_keys SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(b.row.id);
    expect(verifyKey(db, b.raw)).toBeNull();
    expect(expireSweep(db)).toBe(1);
    expect(listAllKeys(db).find((k) => k.id === b.row.id)?.status).toBe('expired');
  });

  it('profile: walidacja tools/namespaces, delete blokowany przez aktywne klucze', () => {
    const db = testDb();
    const uid = seedUser(db);
    expect(() =>
      createProfile(db, { id: 'zly', name: 'Zły', tools: ['kb_search', 'kb_hack'] }),
    ).toThrowError(/nieznane narzędzia/);
    expect(() =>
      createProfile(db, { id: 'zly2', name: 'Zły2', tools: ['kb_search'], namespaces: ['NieMa'] }),
    ).toThrowError(/spoza rejestru/);

    createProfile(db, { id: 'czytelnik', name: 'Czytelnik', tools: ['kb_search', 'kb_list'] });
    const key = createKey(db, uid, 'k', ['read'], 'czytelnik', 5);
    try {
      deleteProfile(db, 'czytelnik');
      expect.unreachable('powinno rzucić');
    } catch (err) {
      expect((err as AppError).code).toBe('conflict');
      expect((err as AppError).message).toContain('aktywnych kluczy');
    }
    // po revoke nadal conflict — FK historycznych kluczy (profil do wyłączenia, nie usunięcia)
    revokeKey(db, key.row.id);
    expect(() => deleteProfile(db, 'czytelnik')).toThrowError(/historyczne/);
    // profil bez żadnych kluczy usuwa się bez przeszkód
    createProfile(db, { id: 'pusty', name: 'Pusty', tools: ['kb_list'] });
    deleteProfile(db, 'pusty');
  });
});
