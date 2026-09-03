import type { Db } from '@pomagierkb/shared/db';

/**
 * Typowane odczyty ustawień pipeline'u z DB ('chunking', 'ingest.limits' — klucze
 * były na białej liście SETTINGS_KEYS, ale NIC ich nie czytało; limity siedziały
 * na sztywno w kodzie). Defensywnie: brak wiersza/zły kształt → twarde domyślne.
 * Surowy SELECT (klucze nie są sekretami; bez DI seal/unseal).
 */

export const CHUNKING_DEFAULTS = { maxLen: 1800, previewLen: 800 } as const;
export const INGEST_LIMITS_DEFAULTS = { maxUploadBytes: 50 * 1024 * 1024, maxTextChars: 100_000 } as const;

function readJsonSetting(db: Db, key: string): Record<string, unknown> | null {
  try {
    const row = db.prepare('SELECT value_json, is_secret FROM settings WHERE key = ?').get(key) as
      | { value_json: string; is_secret: number }
      | undefined;
    if (!row || row.is_secret === 1) return null;
    const parsed: unknown = JSON.parse(row.value_json);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function posInt(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(Math.max(Math.floor(v), min), max);
}

export function readChunkingSettings(db: Db): { maxLen: number; previewLen: number } {
  const o = readJsonSetting(db, 'chunking');
  return {
    maxLen: posInt(o?.['maxLen'], CHUNKING_DEFAULTS.maxLen, 200, 8000),
    previewLen: posInt(o?.['previewLen'], CHUNKING_DEFAULTS.previewLen, 100, 2000),
  };
}

export function readIngestLimits(db: Db): { maxUploadBytes: number; maxTextChars: number } {
  const o = readJsonSetting(db, 'ingest.limits');
  return {
    // multipart fileSize (50 MB) rejestrowany przy starcie pozostaje TWARDYM sufitem;
    // ten limit może być tylko niższy i jest egzekwowany w handlerze.
    maxUploadBytes: posInt(
      o?.['maxUploadBytes'],
      INGEST_LIMITS_DEFAULTS.maxUploadBytes,
      1024,
      INGEST_LIMITS_DEFAULTS.maxUploadBytes,
    ),
    maxTextChars: posInt(o?.['maxTextChars'], INGEST_LIMITS_DEFAULTS.maxTextChars, 1000, 1_000_000),
  };
}
