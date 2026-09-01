import * as oidc from 'openid-client';
import { AppError } from '@pomagierkb/shared/errors';
import { seal, unseal } from '@pomagierkb/shared/crypto';
import type { AppConfig } from '../config.js';
import type { Role } from '../types.js';

/**
 * OIDC (openid-client v6) — wspólna infrastruktura auth:
 * - createOidcProvider(): LENIWE discovery Authentika (memoizowana obietnica;
 *   błąd resetuje cache, więc kolejne żądanie próbuje ponownie) — buildApp nie
 *   dotyka sieci, a testy bez IdP przechodzą dopóki nie użyją /auth/*;
 * - mapGroupsToRole(): mapowanie grup Authentika na role panelu (precedencja
 *   admin > operator > viewer; brak grupy kag-* = brak dostępu);
 * - seal/unseal tokenów sesji (AES-256-GCM kluczem TOKEN_ENC_KEY).
 */

/** Scopes żądane od Authentika (offline_access → refresh token; groups w 'profile'). */
export const OIDC_SCOPE = 'openid email profile offline_access';

/** Precedencja grup: pierwsza dopasowana wygrywa (admin ⊃ operator ⊃ viewer). */
const GROUP_TO_ROLE: ReadonlyArray<readonly [string, Role]> = [
  ['kag-admin', 'admin'],
  ['kag-operator', 'operator'],
  ['kag-viewer', 'viewer'],
];

/** Mapuje claim `groups` (nieznanego kształtu) na rolę; null = brak dostępu. */
export function mapGroupsToRole(groups: unknown): Role | null {
  if (!Array.isArray(groups)) return null;
  const names = new Set(groups.filter((g): g is string => typeof g === 'string'));
  for (const [group, role] of GROUP_TO_ROLE) {
    if (names.has(group)) return role;
  }
  return null;
}

/** Dostawca konfiguracji OIDC — dekorowany jako app.oidc (patrz plugins/session.ts). */
export interface OidcProvider {
  /** Konfiguracja z discovery (memoizowana); błąd → AppError('upstream_error') 502. */
  getConfiguration(): Promise<oidc.Configuration>;
}

export function createOidcProvider(config: AppConfig): OidcProvider {
  let cached: Promise<oidc.Configuration> | null = null;
  return {
    getConfiguration(): Promise<oidc.Configuration> {
      if (cached === null) {
        const issuerUrl = new URL(config.oidc.issuer);
        const options: oidc.DiscoveryRequestOptions = {};
        // http:// wyłącznie poza produkcją (mock IdP w testach/dev); w produkcji
        // discovery na http kończy się błędem openid-client — fail-closed.
        if (issuerUrl.protocol === 'http:' && config.nodeEnv !== 'production') {
          options.execute = [oidc.allowInsecureRequests];
        }
        cached = oidc
          .discovery(issuerUrl, config.oidc.clientId, config.oidc.clientSecret, undefined, options)
          .catch((err: unknown) => {
            cached = null; // następna próba przy kolejnym żądaniu
            throw new AppError('upstream_error', 'Serwer logowania (OIDC) jest niedostępny', {
              service: 'oidc',
              endpoint: config.oidc.issuer,
              cause: err instanceof Error ? err.message : String(err),
            });
          });
      }
      return cached;
    },
  };
}

/** Tokeny IdP trzymane w sessions.tokens_enc (po zsealowaniu). */
export interface SessionTokens {
  refresh_token?: string;
  id_token?: string;
  access_token?: string;
  /** ISO 8601 — moment wygaśnięcia access tokenu; brak pola = nie odświeżamy leniwie. */
  expires_at?: string;
}

/** Sealuje tokeny sesji (AES-256-GCM, TOKEN_ENC_KEY). */
export function sealTokens(tokens: SessionTokens, config: AppConfig): string {
  return seal(JSON.stringify(tokens), config.tokenEncKey.toString('base64'));
}

/**
 * Odczytuje tokeny z sessions.tokens_enc; null przy błędzie (zły klucz po rotacji
 * TOKEN_ENC_KEY albo uszkodzone dane) — decyzję fail-closed podejmuje caller.
 */
export function unsealTokens(sealed: string, config: AppConfig): SessionTokens | null {
  try {
    return JSON.parse(unseal(sealed, config.tokenEncKey.toString('base64'))) as SessionTokens;
  } catch {
    return null;
  }
}
