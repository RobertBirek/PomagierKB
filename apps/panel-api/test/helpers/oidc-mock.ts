import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSign, generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';

/**
 * Mock IdP OIDC do testów auth (lokalny serwer node:http, port efemeryczny):
 * discovery + JWKS (RSA-2048, RS256) + token endpoint (authorization_code
 * i refresh_token) + end_session_endpoint w metadanych. Test steruje treścią
 * id_tokenu przez mutowalny `mock.state` (groups, nonce, expiresIn, failRefresh).
 * openid-client w pełni weryfikuje podpis/iss/aud/exp/nonce — mock podpisuje
 * prawdziwe JWT kluczem, którego część publiczna leży w /jwks.
 */

export interface MockOidcState {
  /** nonce oczekiwany w id_tokenie logowania — test wpisuje go z URL-a autoryzacji. */
  nonce: string;
  sub: string;
  email: string;
  name: string;
  /** Claim groups w id_tokenie logowania. */
  groups: string[];
  /** expires_in access tokenu przy logowaniu (0 = natychmiast wygasły → leniwy refresh). */
  expiresIn: number;
  /** Claim groups w id_tokenie refreshu (domyślnie = groups). */
  refreshGroups: string[] | null;
  /** true → token endpoint odpowiada 400 invalid_grant na refresh. */
  failRefresh: boolean;
  refreshCalls: number;
  tokenCalls: number;
}

export interface MockOidc {
  /** Np. 'http://127.0.0.1:49152/' — wstaw do config.oidc.issuer. */
  issuer: string;
  state: MockOidcState;
  /** Przywraca domyślny stan (między testami). */
  reset(): void;
  close(): Promise<void>;
}

function defaultState(): MockOidcState {
  return {
    nonce: '',
    sub: 'authentik-sub-1',
    email: 'jan@test.pl',
    name: 'Jan Testowy',
    groups: ['kag-viewer'],
    expiresIn: 3600,
    refreshGroups: null,
    failRefresh: false,
    refreshCalls: 0,
    tokenCalls: 0,
  };
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export async function startMockOidc(clientId = 'kag-panel'): Promise<MockOidc> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const state = defaultState();
  let issuer = '';

  const b64u = (s: string): string => Buffer.from(s).toString('base64url');
  function signJwt(payload: Record<string, unknown>): string {
    const data =
      b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-1' })) +
      '.' +
      b64u(JSON.stringify(payload));
    const signature = createSign('RSA-SHA256').update(data).sign(privateKey);
    return `${data}.${signature.toString('base64url')}`;
  }

  /** id_token z podanymi grupami; nonce tylko przy logowaniu (refresh bez nonce). */
  function idTokenFor(groups: string[], nonce?: string): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      iss: issuer,
      sub: state.sub,
      aud: clientId,
      exp: now + 300,
      iat: now,
      email: state.email,
      name: state.name,
      groups,
    };
    if (nonce !== undefined && nonce !== '') payload['nonce'] = nonce;
    return signJwt(payload);
  }

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (req.method === 'GET' && path === '/.well-known/openid-configuration') {
      sendJson(res, {
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}token`,
        jwks_uri: `${issuer}jwks`,
        end_session_endpoint: `${issuer}end-session`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
      });
      return;
    }
    if (req.method === 'GET' && path === '/jwks') {
      sendJson(res, { keys: [{ ...jwk, kid: 'test-1', alg: 'RS256', use: 'sig' }] });
      return;
    }
    if (req.method === 'POST' && path === '/token') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        state.tokenCalls += 1;
        const params = new URLSearchParams(body);
        const grantType = params.get('grant_type');
        if (grantType === 'authorization_code') {
          sendJson(res, {
            access_token: `at-${state.tokenCalls}`,
            token_type: 'bearer',
            expires_in: state.expiresIn,
            refresh_token: 'rt-1',
            id_token: idTokenFor(state.groups, state.nonce),
          });
          return;
        }
        if (grantType === 'refresh_token') {
          state.refreshCalls += 1;
          if (state.failRefresh) {
            sendJson(res, { error: 'invalid_grant' }, 400);
            return;
          }
          sendJson(res, {
            access_token: `at-refreshed-${state.refreshCalls}`,
            token_type: 'bearer',
            expires_in: 3600,
            refresh_token: 'rt-2',
            id_token: idTokenFor(state.refreshGroups ?? state.groups),
          });
          return;
        }
        sendJson(res, { error: 'unsupported_grant_type' }, 400);
      });
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  return {
    issuer,
    state,
    reset() {
      Object.assign(state, defaultState());
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

export interface LoginResult {
  loginRes: LightMyRequestResponse;
  cbRes: LightMyRequestResponse;
  /** URL autoryzacji z 302 logowania (state/nonce/code_challenge w query). */
  authUrl: URL;
  /** Wartość cookie kag_sid ('' gdy logowanie nie utworzyło sesji). */
  sid: string;
}

/**
 * Pełny przebieg login→callback przez app.inject: 302 na IdP, przepisanie
 * nonce do mocka (żeby trafił do id_tokenu), wywołanie callbacku z kodem,
 * cookie kag_txn i state z transakcji.
 */
export async function performLogin(
  app: FastifyInstance,
  mock: MockOidc,
  opts: { returnTo?: string } = {},
): Promise<LoginResult> {
  const loginUrl =
    opts.returnTo !== undefined
      ? `/auth/login?returnTo=${encodeURIComponent(opts.returnTo)}`
      : '/auth/login';
  const loginRes = await app.inject({ method: 'GET', url: loginUrl });
  if (loginRes.statusCode !== 302) {
    throw new Error(`login: oczekiwano 302, jest ${loginRes.statusCode}: ${loginRes.body}`);
  }
  const authUrl = new URL(String(loginRes.headers['location']));
  mock.state.nonce = authUrl.searchParams.get('nonce') ?? '';
  const authState = authUrl.searchParams.get('state') ?? '';
  const txnCookie = loginRes.cookies.find((c) => c.name === 'kag_txn');
  if (txnCookie === undefined) throw new Error('login: brak cookie kag_txn');

  const cbOpts: InjectOptions = {
    method: 'GET',
    url: `/auth/callback?code=test-code&state=${encodeURIComponent(authState)}`,
    cookies: { kag_txn: txnCookie.value },
  };
  const cbRes = await app.inject(cbOpts);
  const sidCookie = cbRes.cookies.find((c) => c.name === 'kag_sid' && c.value !== '');
  return { loginRes, cbRes, authUrl, sid: sidCookie?.value ?? '' };
}
