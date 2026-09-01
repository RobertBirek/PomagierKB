import type { FastifyInstance, FastifyReply } from 'fastify';
import * as oidc from 'openid-client';
import {
  createOidcProvider,
  mapGroupsToRole,
  sealTokens,
  unsealTokens,
  type SessionTokens,
} from './oidc.js';
import {
  deleteSession,
  getSessionWithUser,
  hashSid,
  touchIdle,
  updateSessionAuth,
} from '../services/sessions.js';
import { updateUserRole } from '../services/users.js';

/**
 * Sesja z cookie kag_sid (HttpOnly, Secure w produkcji, SameSite=Lax, Path=/,
 * host-only — bez atrybutu Domain). Wartość cookie to 256-bit base64url;
 * w DB wyłącznie sha256(sid). Hook onRequest:
 * 1. odczyt kag_sid → sha256 → wiersz sessions ⋈ users;
 * 2. TTL: absolutny 12 h i idle 60 min — wygasła/nieznana/konto disabled →
 *    usunięcie wiersza + wyczyszczenie cookie + req.user = null (401 robi rbac);
 * 3. leniwy refresh: access token wygasł → refreshTokenGrant (mutex per sesja
 *    w pamięci), ponowne mapowanie groups→rola (degradacja wg Authentika);
 *    niepowodzenie → sesja usunięta → 401;
 * 4. sliding idle (zapis do DB najwyżej co 60 s) i req.user.
 *
 * Dekoruje też app.oidc (leniwe discovery) — używane przez routes/auth.ts.
 */
export function registerSession(app: FastifyInstance): void {
  // Wspólny dostawca konfiguracji OIDC dla hooka refresh i tras /auth/*.
  app.decorate('oidc', createOidcProvider(app.config));
  app.decorateRequest('user', null);

  const secure = app.config.nodeEnv === 'production';
  /** Mutex refreshu per sesja — równoległe żądania czekają na jedną wymianę. */
  const refreshing = new Map<string, Promise<void>>();

  function clearSidCookie(reply: FastifyReply): void {
    reply.clearCookie('kag_sid', { path: '/', httpOnly: true, secure, sameSite: 'lax' });
  }

  /** Wymiana refresh tokenu + aktualizacja roli; błąd = sesja usunięta (throw). */
  async function doRefresh(idHash: string, tokens: SessionTokens): Promise<void> {
    try {
      if (tokens.refresh_token === undefined) {
        throw new Error('sesja bez refresh_token — nie można odświeżyć');
      }
      const configuration = await app.oidc.getConfiguration();
      const res = await oidc.refreshTokenGrant(configuration, tokens.refresh_token);
      const sess = getSessionWithUser(app.db, idHash);
      if (sess === null) throw new Error('sesja usunięta w trakcie odświeżania');

      // Ponowne mapowanie grup z nowego id_tokenu — odebranie grupy w Authentiku
      // degraduje rolę najpóźniej po wygaśnięciu access tokenu.
      let role = sess.role;
      const claims = res.claims();
      if (claims !== undefined && claims['groups'] !== undefined) {
        const mapped = mapGroupsToRole(claims['groups']);
        if (mapped === null) throw new Error('konto straciło wszystkie grupy kag-*');
        role = mapped;
      }

      const expiresIn = res.expiresIn() ?? 300;
      const next: SessionTokens = {
        refresh_token: res.refresh_token ?? tokens.refresh_token,
        access_token: res.access_token,
        expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      };
      const idToken = res.id_token ?? tokens.id_token;
      if (idToken !== undefined) next.id_token = idToken;
      updateSessionAuth(app.db, idHash, { tokensEnc: sealTokens(next, app.config), role });
      if (role !== sess.role) updateUserRole(app.db, sess.userId, role);
    } catch (err) {
      // Fail-closed: nieudany refresh unieważnia sesję (ponowne logowanie).
      deleteSession(app.db, idHash);
      throw err;
    }
  }

  /** Refresh z mutexem; zwraca false gdy sesja została unieważniona. */
  async function refreshSession(idHash: string, tokens: SessionTokens): Promise<boolean> {
    const inflight = refreshing.get(idHash);
    if (inflight !== undefined) {
      try {
        await inflight;
        return true;
      } catch {
        return false;
      }
    }
    const job = doRefresh(idHash, tokens);
    refreshing.set(idHash, job);
    try {
      await job;
      return true;
    } catch (err) {
      app.log.warn({ err, session: idHash.slice(0, 8) }, 'refresh sesji nie powiódł się — sesja usunięta');
      return false;
    } finally {
      refreshing.delete(idHash);
    }
  }

  app.addHook('onRequest', async (req, reply) => {
    req.user = null;
    if (req.is404) return; // 404/405 obsługuje notFoundHandler — bez sesji

    const sid = req.cookies['kag_sid'];
    if (sid === undefined || sid === '') return;

    const idHash = hashSid(sid);
    let sess = getSessionWithUser(app.db, idHash);
    if (sess === null) {
      clearSidCookie(reply);
      return;
    }

    const nowMs = Date.now();
    const nowIsoStr = new Date(nowMs).toISOString();
    if (
      sess.absoluteExpiresAt <= nowIsoStr ||
      sess.idleExpiresAt <= nowIsoStr ||
      sess.userStatus !== 'active'
    ) {
      deleteSession(app.db, idHash);
      clearSidCookie(reply);
      return;
    }

    // Leniwy refresh dopiero gdy access token wygasł.
    if (sess.tokensEnc !== null) {
      const tokens = unsealTokens(sess.tokensEnc, app.config);
      if (tokens === null) {
        // Nieodczytywalne tokeny (rotacja TOKEN_ENC_KEY / uszkodzenie) — fail-closed.
        deleteSession(app.db, idHash);
        clearSidCookie(reply);
        return;
      }
      if (tokens.expires_at !== undefined && Date.parse(tokens.expires_at) <= nowMs) {
        const ok = await refreshSession(idHash, tokens);
        if (!ok) {
          clearSidCookie(reply);
          return;
        }
        sess = getSessionWithUser(app.db, idHash);
        if (sess === null || sess.userStatus !== 'active') {
          clearSidCookie(reply);
          return;
        }
      }
    }

    touchIdle(app.db, idHash);
    req.user = {
      id: sess.userId,
      email: sess.email,
      displayName: sess.displayName,
      role: sess.role,
      sessionHash: idHash,
    };
  });
}
