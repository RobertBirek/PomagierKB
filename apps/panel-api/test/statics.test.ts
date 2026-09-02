import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb, runMigrations } from '@pomagierkb/shared/db';
import { buildApp } from '../src/app.js';
import { makeTestConfig } from '../src/config.js';
import { sharedMigrationsDir } from '../src/lib/migrations.js';
import { registerStatics } from '../src/statics.js';

describe('statyki SPA', () => {
  it('serwuje index.html, assety i fallback SPA BEZ sesji (regresja: 401 na /assets/*)', async () => {
    const webDist = mkdtempSync(join(tmpdir(), 'webdist-'));
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><div id="root"></div>');
    mkdirSync(join(webDist, 'assets'));
    writeFileSync(join(webDist, 'assets', 'app.js'), 'console.log(1)');

    const db = openDb(':memory:');
    runMigrations(db, sharedMigrationsDir());
    const app = await buildApp({ config: makeTestConfig({ webDist }), db });
    await registerStatics(app);
    await app.ready();

    expect((await app.inject({ url: '/' })).statusCode).toBe(200);
    const asset = await app.inject({ url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain('console.log');
    // fallback SPA dla tras frontu
    expect((await app.inject({ url: '/inbox' })).statusCode).toBe(200);
    // API nadal chronione i z kopertą
    expect((await app.inject({ url: '/api/v1/me' })).statusCode).toBe(401);
    await app.close();
  });
});
