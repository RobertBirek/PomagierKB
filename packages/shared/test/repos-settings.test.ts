import { describe, expect, it } from 'vitest';
import { getSetting, maskForApi, maskValue, setSetting } from '../src/db/index.js';
import { testDb } from './helpers.js';

// Stub seal/unseal (DI) — odwracalne kodowanie zamiast prawdziwego AES-GCM.
const seal = (plain: string) => Buffer.from(plain, 'utf8').toString('base64');
const unseal = (sealed: string) => Buffer.from(sealed, 'base64').toString('utf8');

describe('repos/settings', () => {
  it('biała lista kluczy: nieznany klucz → validation_error', () => {
    const db = testDb();
    expect(() => setSetting(db, 'llm.evil', { x: 1 })).toThrowError(/białej listy/);
    expect(() => getSetting(db, 'random.key')).toThrowError(/białej listy/);
    expect(() => maskForApi(db, 'nope')).toThrowError(/białej listy/);
  });

  it('sekret przechowywany jako {sealed} — nigdy plaintext w DB', () => {
    const db = testDb();
    const cfg = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-live-abcdef123456' }; // wartość testowa, gitleaks:allow
    setSetting(db, 'llm.chat', cfg, { isSecret: true, seal, updatedBy: 'admin_1' });

    const stored = db.prepare("SELECT value_json, is_secret FROM settings WHERE key = 'llm.chat'").get() as {
      value_json: string;
      is_secret: number;
    };
    expect(stored.is_secret).toBe(1);
    expect(stored.value_json).not.toContain('sk-live');
    expect(JSON.parse(stored.value_json)).toHaveProperty('sealed');

    // odczyt z unseal odzyskuje wartość
    const setting = getSetting(db, 'llm.chat', { unseal });
    expect(setting?.value).toEqual(cfg);
    expect(setting?.isSecret).toBe(true);

    // zapis sekretu bez seal → błąd
    expect(() => setSetting(db, 'llm.openie', cfg, { isSecret: true })).toThrowError(/seal/);
  });

  it('maskForApi: {configured, preview ab***yz}, nigdy pełny sekret', () => {
    const db = testDb();
    expect(maskForApi(db, 'llm.embeddings')).toEqual({ configured: false });

    setSetting(db, 'llm.embeddings', { apiKey: 'sk-secret-key-98765', model: 'text-embedding-3-small' }, { // gitleaks:allow
      isSecret: true,
      seal,
      updatedBy: 'admin_1',
    });
    const masked = maskForApi(db, 'llm.embeddings', { unseal });
    expect(masked.configured).toBe(true);
    expect(masked.preview).toBe('sk***65');
    expect(masked.updatedBy).toBe('admin_1');
    expect(masked).not.toHaveProperty('value');
    expect(JSON.stringify(masked)).not.toContain('sk-secret-key-98765');

    // ustawienie jawne wraca z pełną wartością
    setSetting(db, 'learning.threshold', 0.45);
    expect(maskForApi(db, 'learning.threshold').value).toBe(0.45);

    expect(maskValue('krótki')).toBe('***');
    expect(maskValue('abcdefgh')).toBe('ab***gh');
  });
});
