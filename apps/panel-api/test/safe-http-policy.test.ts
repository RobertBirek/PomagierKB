import { describe, expect, it } from 'vitest';
import {
  allAddressesPublic,
  contentTypeAllowed,
  isPublicAddress,
  validateFetchUrl,
} from '../src/services/safe-http-policy.js';

/** Macierz SSRF polityki safe_http — fail-closed na wszystkim, co nie jest jawnie publiczne. */

describe('validateFetchUrl', () => {
  it('akceptuje publiczne http(s) na 80/443 (i bez portu)', () => {
    for (const u of ['https://example.com/docs', 'http://example.com:80/a', 'https://example.com:443/']) {
      expect(validateFetchUrl(u).ok, u).toBe(true);
    }
  });
  it('odrzuca: inne protokoły, porty, credentiale, śmieci', () => {
    for (const u of [
      'ftp://example.com/x',
      'file:///etc/passwd',
      'gopher://example.com',
      'https://example.com:8887/kb', // port OpenSPG!
      'http://example.com:8080/',
      'https://user:pass@example.com/',
      'nie-url',
      'javascript:alert(1)',
    ]) {
      expect(validateFetchUrl(u).ok, u).toBe(false);
    }
  });
});

describe('isPublicAddress — macierz IP', () => {
  const PRIVATE = [
    '127.0.0.1', '127.8.8.8', '0.0.0.0',
    '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', // cloud metadata!
    '100.64.1.1', // CGNAT
    '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.0.10',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:192.168.0.5',
    'fe80::1%eth0',
    '', 'not-an-ip', '999.1.1.1',
  ];
  const PUBLIC = ['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:4700::1111', '::ffff:8.8.8.8', '172.32.0.1', '172.15.0.1'];

  it('prywatne/zarezerwowane/nieparsowalne → false', () => {
    for (const ip of PRIVATE) expect(isPublicAddress(ip), ip).toBe(false);
  });
  it('publiczne → true', () => {
    for (const ip of PUBLIC) expect(isPublicAddress(ip), ip).toBe(true);
  });
  it('allAddressesPublic: JEDEN prywatny w zestawie DNS ubija całość; pusty zestaw też', () => {
    expect(allAddressesPublic(['8.8.8.8', '1.1.1.1'])).toBe(true);
    expect(allAddressesPublic(['8.8.8.8', '10.0.0.1'])).toBe(false);
    expect(allAddressesPublic([])).toBe(false);
  });
});

describe('contentTypeAllowed', () => {
  it('allowlist z normalizacją parametrów; reszta odrzucana', () => {
    expect(contentTypeAllowed('text/html; charset=utf-8')).toEqual({ ok: true, type: 'text/html' });
    expect(contentTypeAllowed('application/PDF')).toEqual({ ok: true, type: 'application/pdf' });
    expect(contentTypeAllowed('application/octet-stream').ok).toBe(false);
    expect(contentTypeAllowed('image/png').ok).toBe(false);
    expect(contentTypeAllowed(null).ok).toBe(false);
  });
});
