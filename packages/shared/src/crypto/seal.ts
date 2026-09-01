import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Sealowanie sekretów (tokeny OIDC w sessions.tokens_enc, klucze LLM w settings):
 * AES-256-GCM, wynik base64(iv|tag|ciphertext). Klucz: 32 bajty base64 z env.
 * Błędy są deterministyczne (stałe komunikaty) — zły klucz i uszkodzone dane
 * kończą się tym samym wyjątkiem, bez przecieków wewnętrznych błędów OpenSSL.
 */

const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

const B64_RE = /^[A-Za-z0-9+/=_-]+$/;

/** Dekoduje i waliduje klucz z env (base64/base64url, dokładnie 32 bajty). */
function decodeKey(keyB64: string): Buffer {
  if (typeof keyB64 !== 'string' || keyB64.length === 0 || !B64_RE.test(keyB64)) {
    throw new Error('seal: key must be base64-encoded');
  }
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== KEY_LEN) {
    throw new Error(`seal: key must decode to ${KEY_LEN} bytes, got ${key.length}`);
  }
  return key;
}

export function seal(plaintext: string, keyB64: string): string {
  const key = decodeKey(keyB64);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function unseal(sealedB64: string, keyB64: string): string {
  const key = decodeKey(keyB64);
  const buf = Buffer.from(sealedB64, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error('unseal: sealed payload malformed');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // GCM nie rozróżnia złego klucza od uszkodzenia — i my też nie.
    throw new Error('unseal: authentication failed (wrong key or corrupted data)');
  }
}
