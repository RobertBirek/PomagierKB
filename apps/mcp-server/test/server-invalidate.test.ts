import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKey, rotateKey } from '@pomagierkb/shared/db';
import {
  INTERNAL_TOKEN,
  makeHarness,
  makeUser,
  mcpRequest,
  testConfig,
  toolsListBody,
  type TestHarness,
} from './helpers.js';
import { buildServer } from '../src/server.js';

/**
 * Cache auth 60 s: po rotate stary klucz działa z cache (≤ TTL), po POST /invalidate
 * na porcie wewnętrznym przestaje działać NATYCHMIAST.
 */

describe('shell MCP: internal /invalidate', () => {
  let h: TestHarness;
  let keyId: string;
  let rawKey: string;

  beforeEach(() => {
    h = makeHarness();
    const userId = makeUser(h.db);
    const created = createKey(h.db, userId, 'test', ['read'], 'default', 30);
    keyId = created.row.id;
    rawKey = created.raw;
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('rotate → stary klucz żyje z cache; invalidate → 401 od razu; nowy klucz działa', async () => {
    // 1) wypełnij cache poprawnym żądaniem
    const first = await mcpRequest(h.bundle.app, 'default', rawKey, toolsListBody());
    expect(first.statusCode).toBe(200);

    // 2) rotate w DB — stary hash martwy, ale cache auth wciąż go zna
    const rotated = rotateKey(h.db, keyId);
    const cached = await mcpRequest(h.bundle.app, 'default', rawKey, toolsListBody());
    expect(cached.statusCode).toBe(200); // świadomie: TTL 60 s

    // 3) invalidate przez port wewnętrzny
    const inv = await h.bundle.internal.inject({
      method: 'POST',
      url: '/invalidate',
      headers: { 'x-internal-token': INTERNAL_TOKEN },
    });
    expect(inv.statusCode).toBe(200);
    expect((inv.json() as { ok: boolean }).ok).toBe(true);

    // 4) stary klucz odrzucony natychmiast, nowy działa
    const afterInv = await mcpRequest(h.bundle.app, 'default', rawKey, toolsListBody());
    expect(afterInv.statusCode).toBe(401);
    const fresh = await mcpRequest(h.bundle.app, 'default', rotated.raw, toolsListBody());
    expect(fresh.statusCode).toBe(200);
  });

  it('zły lub brakujący X-Internal-Token → 401, cache nietknięty', async () => {
    const first = await mcpRequest(h.bundle.app, 'default', rawKey, toolsListBody());
    expect(first.statusCode).toBe(200);
    rotateKey(h.db, keyId);

    const bad = await h.bundle.internal.inject({
      method: 'POST',
      url: '/invalidate',
      headers: { 'x-internal-token': 'zly-token' },
    });
    expect(bad.statusCode).toBe(401);
    const missing = await h.bundle.internal.inject({ method: 'POST', url: '/invalidate' });
    expect(missing.statusCode).toBe(401);

    // cache przetrwał — stary klucz nadal działa (do TTL)
    const stillCached = await mcpRequest(h.bundle.app, 'default', rawKey, toolsListBody());
    expect(stillCached.statusCode).toBe(200);
  });

  it('bez skonfigurowanego INTERNAL_TOKEN endpoint odmawia (503, fail-closed)', async () => {
    const config = { ...testConfig(h.dir), internalToken: null };
    const bundle = buildServer({ db: h.db, config, openspg: null, llmProvider: () => null, tools: [] });
    try {
      const res = await bundle.internal.inject({
        method: 'POST',
        url: '/invalidate',
        headers: { 'x-internal-token': INTERNAL_TOKEN },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await bundle.close();
    }
  });
});
