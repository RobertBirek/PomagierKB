import { describe, expect, it } from 'vitest';
import { loadConfig, trustProxyOption } from '../src/config.js';

/**
 * D9-04: listener wewnętrzny (/invalidate) musi dać się zejść z 0.0.0.0 na adres
 * sieci kag-control bez zmiany kodu (INTERNAL_HOST). D9-03: req.ip za Caddy musi
 * pochodzić z X-Forwarded-For, ale tylko na tyle przeskoków, ile realnie stoi z przodu.
 */

function cfg(env: Record<string, string>) {
  return loadConfig({ DATA_DIR: '/tmp/x', ...env } as NodeJS.ProcessEnv);
}

describe('config: adres listenera wewnętrznego', () => {
  it('INTERNAL_HOST domyślnie = HOST (zachowanie sprzed zmiany)', () => {
    expect(cfg({}).internalHost).toBe('0.0.0.0');
    expect(cfg({ HOST: '10.0.0.5' }).internalHost).toBe('10.0.0.5');
  });

  it('INTERNAL_HOST rozłącza listener wewnętrzny od publicznego', () => {
    const c = cfg({ HOST: '0.0.0.0', INTERNAL_HOST: '172.30.0.4' });
    expect(c.host).toBe('0.0.0.0');
    expect(c.internalHost).toBe('172.30.0.4');
  });
});

describe('config: TRUST_PROXY', () => {
  it('domyślnie 1 przeskok (Caddy); true/false i liczby akceptowane', () => {
    expect(cfg({}).trustProxyHops).toBe(1);
    expect(cfg({ TRUST_PROXY: 'false' }).trustProxyHops).toBe(0);
    expect(cfg({ TRUST_PROXY: 'true' }).trustProxyHops).toBe(1);
    expect(cfg({ TRUST_PROXY: '2' }).trustProxyHops).toBe(2);
  });

  it('wartość spoza zakresu → wyjątek konfiguracji (fail-closed)', () => {
    expect(() => cfg({ TRUST_PROXY: '-1' })).toThrow(/TRUST_PROXY/);
    expect(() => cfg({ TRUST_PROXY: 'proxy' })).toThrow(/TRUST_PROXY/);
  });

  it('trustProxyOption: 0 → false (X-Forwarded-For ignorowany); n → ufaj n przeskokom', () => {
    expect(trustProxyOption(0)).toBe(false);
    const one = trustProxyOption(1);
    expect(typeof one).toBe('function');
    const trust = one as (address: string, hop: number) => boolean;
    expect(trust('10.0.0.1', 0)).toBe(true); // gniazdo = proxy (Caddy)
    expect(trust('203.0.113.9', 1)).toBe(false); // pierwszy nieufany = klient
  });
});
