import type { FastifyInstance, FastifyReply } from 'fastify';
import * as oidc from 'openid-client';
import { AppError } from '@pomagierkb/shared/errors';
import { seal, unseal } from '@pomagierkb/shared/crypto';
import {
  OIDC_SCOPE,
  mapGroupsToRole,
  sealTokens,
  unsealTokens,
  type SessionTokens,
} from '../plugins/oidc.js';
import { createSession, deleteSession, getSessionWithUser } from '../services/sessions.js';
import { upsertOidcUser } from '../services/users.js';

/**
 * Trasy /auth/* (BEZ prefiksu /api/v1) — OIDC Authorization Code + PKCE
 * z Authentikiem (openid-client v6, backend-mcp §3.1):
 * - GET  /auth/login    → 302 na authorization_endpoint (PKCE+state+nonce
 *   w sealowanym cookie kag_txn, Max-Age 600);
 * - GET  /auth/callback → wymiana kodu, mapowanie grup kag-* na rolę,
 *   upsert users, sesja + cookie kag_sid, 302 na returnTo;
 *   brak grupy → 403 minimalna strona PL (text/html);
 * - POST /auth/logout   → usunięcie sesji, czyszczenie cookie,
 *   {logoutUrl} = end_session z id_token_hint.
 */

/** Stan transakcji logowania — sealowany AES-GCM w cookie kag_txn. */
interface LoginTxn {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
}

/** returnTo tylko jako ścieżka względna ('/x', nie '//host', bez CR/LF/backslash). */
function sanitizeReturnTo(value: string | undefined): string {
  if (value === undefined) return '/';
  if (!/^\/(?!\/)/.test(value) || /[\r\n\\]/.test(value)) return '/';
  return value;
}

/** Minimalna strona 403 po polsku (celowo poza kopertą JSON — dla przeglądarki). */
function accessDeniedHtml(reason: string): string {
  return (
    '<!doctype html><html lang="pl"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Brak dostępu — PomagierKB</title></head>' +
    '<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem">' +
    '<h1>Brak dostępu</h1>' +
    `<p>${reason}</p>` +
    '<p><a href="/">Wróć na stronę główną</a></p></body></html>'
  );
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  const { config, db } = app;
  const secure = config.nodeEnv === 'production';
  const keyB64 = config.tokenEncKey.toString('base64');
  const redirectUri = `${config.publicUrl}/auth/callback`;

  const txnCookieOpts = {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/auth',
    maxAge: 600,
  };
  const sidCookieOpts = {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    // host-only: celowo BEZ atrybutu domain
  };

  // ── GET /auth/login ───────────────────────────────────────────────────────
  app.get(
    '/auth/login',
    {
      config: { rbac: false, audit: false, csrf: false, rateLimitGroup: 'auth' },
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { returnTo: { type: 'string', maxLength: 2000 } },
        },
      },
    },
    async (req, reply) => {
      const { returnTo } = req.query as { returnTo?: string };
      const configuration = await app.oidc.getConfiguration(); // błąd → 502 upstream_error

      const codeVerifier = oidc.randomPKCECodeVerifier();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();

      const authorizationUrl = oidc.buildAuthorizationUrl(configuration, {
        redirect_uri: redirectUri,
        scope: OIDC_SCOPE,
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });

      const txn: LoginTxn = {
        state,
        nonce,
        codeVerifier,
        returnTo: sanitizeReturnTo(returnTo),
      };
      reply.setCookie('kag_txn', seal(JSON.stringify(txn), keyB64), txnCookieOpts);
      return reply.redirect(authorizationUrl.href);
    },
  );

  // ── GET /auth/callback ────────────────────────────────────────────────────
  app.get(
    '/auth/callback',
    {
      config: { rbac: false, audit: 'auth.login', csrf: false, rateLimitGroup: 'auth' },
      schema: {
        // Parametry buduje IdP (może dodać własne, np. iss/session_state) —
        // tu WYJĄTKOWO additionalProperties:true; pełną walidację odpowiedzi
        // autoryzacyjnej robi openid-client (state/iss/code).
        querystring: {
          type: 'object',
          additionalProperties: true,
          properties: {
            code: { type: 'string' },
            state: { type: 'string' },
            error: { type: 'string' },
            error_description: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const rawTxn = req.cookies['kag_txn'];
      reply.clearCookie('kag_txn', txnCookieOpts);
      if (rawTxn === undefined || rawTxn === '') {
        throw new AppError(
          'validation_error',
          'Brak transakcji logowania — rozpocznij ponownie od /auth/login',
        );
      }
      let txn: LoginTxn;
      try {
        txn = JSON.parse(unseal(rawTxn, keyB64)) as LoginTxn;
      } catch {
        throw new AppError('validation_error', 'Nieprawidłowa transakcja logowania');
      }

      const configuration = await app.oidc.getConfiguration();
      const currentUrl = new URL(req.raw.url ?? req.url, config.publicUrl);

      let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
      try {
        tokens = await oidc.authorizationCodeGrant(configuration, currentUrl, {
          pkceCodeVerifier: txn.codeVerifier,
          expectedState: txn.state,
          expectedNonce: txn.nonce,
          idTokenExpected: true,
        });
      } catch (err) {
        req.log.warn({ err }, 'wymiana kodu OIDC nie powiodła się');
        throw new AppError('unauthorized', 'Logowanie nie powiodło się — spróbuj ponownie');
      }

      const claims = tokens.claims();
      if (claims === undefined) {
        throw new AppError('unauthorized', 'Logowanie nie powiodło się — brak id_tokenu');
      }
      const email = typeof claims['email'] === 'string' ? claims['email'] : null;
      const displayName =
        typeof claims['name'] === 'string' && claims['name'] !== ''
          ? claims['name']
          : (email ?? claims.sub);

      // Mapowanie grup Authentika → rola; brak grupy kag-* = brak dostępu (bez sesji).
      const role = mapGroupsToRole(claims['groups']);
      if (role === null) {
        req.log.warn({ sub: claims.sub }, 'logowanie odrzucone: brak grupy kag-*');
        return reply
          .code(403)
          .type('text/html; charset=utf-8')
          .send(
            accessDeniedHtml(
              'Twoje konto nie należy do żadnej z grup uprawnień PomagierKB ' +
                '(kag-admin, kag-operator, kag-viewer). Poproś administratora ' +
                'o nadanie dostępu w Authentiku.',
            ),
          );
      }

      const user = upsertOidcUser(db, { sub: claims.sub, email, displayName, role });
      if (user.status !== 'active') {
        req.log.warn({ userId: user.id }, 'logowanie odrzucone: konto wyłączone');
        return reply
          .code(403)
          .type('text/html; charset=utf-8')
          .send(accessDeniedHtml('Twoje konto zostało wyłączone przez administratora.'));
      }

      const expiresIn = tokens.expiresIn() ?? 300;
      const sessionTokens: SessionTokens = {
        access_token: tokens.access_token,
        expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      };
      if (tokens.refresh_token !== undefined) sessionTokens.refresh_token = tokens.refresh_token;
      if (tokens.id_token !== undefined) sessionTokens.id_token = tokens.id_token;
      const { sid, sidHash } = createSession(db, {
        userId: user.id,
        role,
        tokensEnc: sealTokens(sessionTokens, config),
        ip: req.ip,
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      });
      reply.setCookie('kag_sid', sid, sidCookieOpts);

      // req.user + auditContext, żeby hook audytu przypisał wpis zalogowanemu.
      req.user = { id: user.id, email, displayName, role, sessionHash: sidHash };
      reply.auditContext = {
        resourceType: 'user',
        resourceId: user.id,
        metadata: { event: 'login', role },
      };
      return reply.redirect(txn.returnTo);
    },
  );

  // ── POST /auth/logout ─────────────────────────────────────────────────────
  app.post(
    '/auth/logout',
    {
      config: { rbac: 'viewer', audit: 'auth.logout', csrf: true, rateLimitGroup: 'auth' },
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['ok', 'data'],
            properties: {
              ok: { const: true },
              data: {
                type: 'object',
                additionalProperties: false,
                required: ['logoutUrl'],
                properties: { logoutUrl: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    async (req, reply: FastifyReply) => {
      if (req.user === null) throw new AppError('unauthorized', 'Wymagane zalogowanie'); // rbac to gwarantuje
      const sess = getSessionWithUser(db, req.user.sessionHash);

      // id_token_hint do end_session (najlepszy wysiłek — brak nie blokuje wylogowania).
      let idToken: string | undefined;
      if (sess !== null && sess.tokensEnc !== null) {
        idToken = unsealTokens(sess.tokensEnc, config)?.id_token;
      }

      deleteSession(db, req.user.sessionHash);
      reply.clearCookie('kag_sid', sidCookieOpts);

      let logoutUrl = `${config.publicUrl}/`;
      try {
        const configuration = await app.oidc.getConfiguration();
        logoutUrl = oidc.buildEndSessionUrl(configuration, {
          post_logout_redirect_uri: `${config.publicUrl}/`,
          ...(idToken !== undefined ? { id_token_hint: idToken } : {}),
        }).href;
      } catch (err) {
        // IdP niedostępny / brak end_session_endpoint → wylogowanie lokalne i tak
        // się dokonało; front przekierowuje na stronę główną panelu.
        req.log.warn({ err }, 'end_session OIDC niedostępny — logoutUrl lokalny');
      }

      reply.auditContext = { resourceType: 'user', resourceId: req.user.id };
      return { ok: true as const, data: { logoutUrl } };
    },
  );
}
