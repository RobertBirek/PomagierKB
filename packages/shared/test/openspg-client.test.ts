import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OpenSpgClient } from '../src/openspg/client.js';
import { UpstreamError } from '../src/errors.js';
import { fixture, headerOf, jsonResponse, loginResponse, makeMockFetch } from './helpers/openspg-mock.js';

function makeClient(impl: typeof fetch): OpenSpgClient {
  return new OpenSpgClient({
    baseUrl: 'http://release-openspg-server:8887',
    account: 'openspg',
    password: 'openspg@kag',
    fetchImpl: impl,
  });
}

describe('OpenSpgClient', () => {
  it('loguje się lazy, hashuje hasło sha256(password+OPENSPG) i skleja WSZYSTKIE Set-Cookie', async () => {
    const { impl, calls } = makeMockFetch((path) => {
      if (path === '/v1/accounts/login') return loginResponse();
      return jsonResponse(fixture('model-list.json'));
    });
    const client = makeClient(impl);
    const body = await client.request('/v1/model/list/');

    expect(calls.map((c) => c.path)).toEqual(['/v1/accounts/login', '/v1/model/list/']);
    // hasło wysłane jako sha256(password + 'OPENSPG'), nigdy plaintext
    const loginBody = JSON.parse(String(calls[0]!.init?.body)) as { account: string; password: string };
    expect(loginBody.account).toBe('openspg');
    expect(loginBody.password).toBe(createHash('sha256').update('openspg@kag' + 'OPENSPG').digest('hex'));
    // cookie sklejone w 'a=b; c=d' (bez atrybutów Path/HttpOnly)
    expect(headerOf(calls[1]!, 'cookie')).toBe('JSESSIONID=abc123; OPENSPG_TOKEN=tok456');
    expect((body as { success: boolean }).success).toBe(true);
  });

  it('ponawia DOKŁADNIE RAZ po 401: re-login i powtórka żądania', async () => {
    let apiHits = 0;
    const { impl, calls } = makeMockFetch((path) => {
      if (path === '/v1/accounts/login') return loginResponse();
      apiHits += 1;
      if (apiHits === 1) return jsonResponse({ message: 'unauthorized' }, { status: 401 });
      return jsonResponse(fixture('model-list.json'));
    });
    const client = makeClient(impl);
    const result = await client.requestResult('/v1/model/list/');

    expect(calls.map((c) => c.path)).toEqual([
      '/v1/accounts/login', '/v1/model/list/', '/v1/accounts/login', '/v1/model/list/',
    ]);
    expect(Array.isArray(result)).toBe(true);
  });

  it('ponawia po {success:false} z komunikatem sesyjnym; drugi błąd NIE wywołuje kolejnej pętli', async () => {
    const { impl, calls } = makeMockFetch((path) => {
      if (path === '/v1/accounts/login') return loginResponse();
      return jsonResponse({ success: false, resultMsg: 'please login first' });
    });
    const client = makeClient(impl);
    await expect(client.requestResult('/v1/model/list/')).rejects.toBeInstanceOf(UpstreamError);
    // login, żądanie, re-login, powtórka — i koniec (jedno ponowienie)
    expect(calls.map((c) => c.path)).toEqual([
      '/v1/accounts/login', '/v1/model/list/', '/v1/accounts/login', '/v1/model/list/',
    ]);
  });

  it('NIE ponawia {success:false} bez komunikatu sesyjnego — rzuca UpstreamError z komunikatem', async () => {
    const { impl, calls } = makeMockFetch((path) => {
      if (path === '/v1/accounts/login') return loginResponse();
      return jsonResponse({ success: false, resultMsg: 'namespace already exists' });
    });
    const client = makeClient(impl);
    await expect(client.requestResult('/v1/projects', { method: 'POST' }))
      .rejects.toThrow('namespace already exists');
    expect(calls.map((c) => c.path)).toEqual(['/v1/accounts/login', '/v1/projects']);
  });

  it('HTTP 500 → UpstreamError z details {service, endpoint, status}', async () => {
    const { impl } = makeMockFetch((path) => {
      if (path === '/v1/accounts/login') return loginResponse();
      return jsonResponse({ message: 'boom' }, { status: 500 });
    });
    const client = makeClient(impl);
    const err = await client.request('/v1/model/list/').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).details).toEqual({
      service: 'openspg', endpoint: '/v1/model/list/', status: 500,
    });
  });

  it('login bez Set-Cookie → UpstreamError', async () => {
    const { impl } = makeMockFetch(() => jsonResponse(fixture('login-ok.json')));
    const client = makeClient(impl);
    await expect(client.login()).rejects.toThrow(/Set-Cookie/);
  });
  it('EPIPE (zapis w martwe gniazdo keep-alive) → jedna ponowna próba, także dla POST', async () => {
    let apiHits = 0;
    const { impl, calls } = makeMockFetch((path) => {
      if (path === '/v1/accounts/login') return loginResponse();
      apiHits += 1;
      if (apiHits === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) });
      return jsonResponse({ success: true, result: 'http://minio/x.csv' });
    });
    const client = makeClient(impl);
    const result = await client.requestResult('/public/v1/reasoner/dialog/uploadFile', { method: 'POST', body: 'x' });
    expect(result).toBe('http://minio/x.csv');
    expect(calls.map((c) => c.path)).toEqual([
      '/v1/accounts/login', '/public/v1/reasoner/dialog/uploadFile', '/public/v1/reasoner/dialog/uploadFile',
    ]);
  });

  it('inny błąd transportu → bez ponowienia, kod przyczyny w komunikacie', async () => {
    let apiHits = 0;
    const { impl } = makeMockFetch((path) => {
      if (path === '/v1/accounts/login') return loginResponse();
      apiHits += 1;
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    });
    const client = makeClient(impl);
    await expect(client.requestResult('/v1/model/list/')).rejects.toThrow(/fetch failed \(ECONNREFUSED\)/);
    expect(apiHits).toBe(1);
  });
});
