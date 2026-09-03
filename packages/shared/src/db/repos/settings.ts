import type { Db } from '../open.js';
import { nowIso } from '../open.js';
import { AppError } from '../../errors.js';

/**
 * Ustawienia z białą listą kluczy. Sekrety przechowywane jako {"sealed":"..."} —
 * seal/unseal wstrzykiwane jako funkcje (DI; ten moduł NIE importuje crypto).
 */

export const SETTINGS_KEYS = [
  'llm.chat',
  'llm.openie',
  'llm.embeddings',
  'learning.threshold',
  'chunking',
  'ingest.limits',
  'drafts.limits',
  'answer.minScore',
  'answer.rerank',
  'answer.rewrite',
  'learning.autoDraft',
] as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[number];

export type SealFn = (plaintext: string) => string;
export type UnsealFn = (sealed: string) => string;

interface SettingRow {
  key: string;
  value_json: string;
  is_secret: number;
  updated_at: string;
  updated_by: string | null;
}

function assertKnownKey(key: string): asserts key is SettingsKey {
  if (!(SETTINGS_KEYS as readonly string[]).includes(key)) {
    throw new AppError('validation_error', `klucz ustawień spoza białej listy: ${key}`, {
      allowed: SETTINGS_KEYS,
    });
  }
}

export interface SettingValue {
  value: unknown;
  isSecret: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

/**
 * Odczyt ustawienia. Dla is_secret wymagany unseal (inaczej zwracana jest wartość
 * z {sealed} bez rozszyfrowania — bezpieczne do introspekcji, bezużyteczne do użycia).
 */
export function getSetting(db: Db, key: string, opts: { unseal?: UnsealFn } = {}): SettingValue | null {
  assertKnownKey(key);
  const row = db.prepare('SELECT * FROM settings WHERE key = ?').get(key) as SettingRow | undefined;
  if (!row) return null;
  let value: unknown = JSON.parse(row.value_json);
  if (row.is_secret === 1 && opts.unseal) {
    const sealed = (value as { sealed?: unknown }).sealed;
    if (typeof sealed !== 'string') {
      throw new AppError('internal', `sekret ${key} nie ma kształtu {sealed}`);
    }
    value = JSON.parse(opts.unseal(sealed));
  }
  return {
    value,
    isSecret: row.is_secret === 1,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export interface SetSettingOpts {
  isSecret?: boolean;
  seal?: SealFn;
  updatedBy?: string | null;
}

/** Upsert ustawienia; sekret jest sealowany PRZED zapisem (nigdy plaintext w DB). */
export function setSetting(db: Db, key: string, value: unknown, opts: SetSettingOpts = {}): void {
  assertKnownKey(key);
  const isSecret = opts.isSecret === true;
  let valueJson: string;
  if (isSecret) {
    if (!opts.seal) throw new AppError('validation_error', 'zapis sekretu wymaga funkcji seal');
    valueJson = JSON.stringify({ sealed: opts.seal(JSON.stringify(value)) });
  } else {
    valueJson = JSON.stringify(value);
  }
  db.prepare(
    `INSERT INTO settings (key, value_json, is_secret, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, is_secret = excluded.is_secret,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(key, valueJson, isSecret ? 1 : 0, nowIso(), opts.updatedBy ?? null);
}

/** Podgląd sekretu bez ujawnienia: 'ab***yz' (za krótkie → '***'). */
export function maskValue(value: string): string {
  if (value.length < 8) return '***';
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

export interface MaskedSetting {
  configured: boolean;
  /** Tylko dla sekretów: zamaskowany podgląd, nigdy pełna wartość. */
  preview?: string;
  /** Tylko dla ustawień jawnych: pełna wartość. */
  value?: unknown;
  updatedAt?: string;
  updatedBy?: string | null;
}

/** Kandydat na preview: string wprost albo pole apiKey/key obiektu konfiguracyjnego. */
function previewSource(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    for (const k of ['apiKey', 'api_key', 'key', 'token']) {
      if (typeof obj[k] === 'string') return obj[k];
    }
  }
  return null;
}

/** Kształt dla GET /settings: sekrety wyłącznie jako {configured, preview}. */
export function maskForApi(db: Db, key: string, opts: { unseal?: UnsealFn } = {}): MaskedSetting {
  assertKnownKey(key);
  const row = db.prepare('SELECT * FROM settings WHERE key = ?').get(key) as SettingRow | undefined;
  if (!row) return { configured: false };
  const base: MaskedSetting = {
    configured: true,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
  if (row.is_secret !== 1) {
    return { ...base, value: JSON.parse(row.value_json) };
  }
  if (!opts.unseal) return base; // skonfigurowany sekret bez możliwości podglądu
  const setting = getSetting(db, key, { unseal: opts.unseal });
  const source = previewSource(setting?.value);
  return source !== null ? { ...base, preview: maskValue(source) } : base;
}
