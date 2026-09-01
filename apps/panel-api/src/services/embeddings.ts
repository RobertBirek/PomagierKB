import type { Db } from '@pomagierkb/shared/db';
import { getSetting } from '@pomagierkb/shared/db';
import { unseal } from '@pomagierkb/shared/crypto';
import type { AppConfig } from '../config.js';

/**
 * Odczyt konfiguracji embeddingów z settings 'llm.embeddings' (sealed AES-GCM).
 * Wydzielone z services/kb.ts, żeby jedna kompozycja preflightu (services/preflight.ts)
 * i serwis KB mogły współdzielić twardy guard niezmienności embeddingu bez cyklu importów.
 */

export interface EmbeddingsSettings {
  model: string;
  baseUrl: string;
  apiKey: string;
}

/**
 * Odczyt konfiguracji embeddings z settings (sekret sealowany kluczem TOKEN_ENC_KEY).
 * Brak/niepełna/nieodszyfrowywalna konfiguracja → null (wołający decyduje o komunikacie).
 */
export function readEmbeddingsSettings(db: Db, config: AppConfig): EmbeddingsSettings | null {
  let value: unknown;
  try {
    const setting = getSetting(db, 'llm.embeddings', {
      unseal: (sealed) => unseal(sealed, config.tokenEncKey.toString('base64')),
    });
    if (!setting) return null;
    value = setting.value;
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const model = o['model'];
  const baseUrl = o['baseUrl'];
  const apiKey = o['apiKey'];
  if (typeof model !== 'string' || model === '') return null;
  if (typeof baseUrl !== 'string' || baseUrl === '') return null;
  if (typeof apiKey !== 'string' || apiKey === '') return null;
  return { model, baseUrl, apiKey };
}

/** Nazwa modelu z modelId '<instanceId>@<model>' (brak '@' → cała wartość). */
export function modelNameOf(vectorModelId: string): string {
  const at = vectorModelId.indexOf('@');
  return at === -1 ? vectorModelId : vectorModelId.slice(at + 1);
}
