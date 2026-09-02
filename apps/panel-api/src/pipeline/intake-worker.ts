import { readFileSync } from 'node:fs';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@pomagierkb/shared/db';
import { createDraft, getSetting, listKbs, type DraftSourceType } from '@pomagierkb/shared/db';
import { unseal } from '@pomagierkb/shared/crypto';
import { AppError } from '@pomagierkb/shared/errors';
import { createLlmClient, type LlmClient } from '@pomagierkb/shared/llm';
import type { AppConfig } from '../config.js';
import {
  nextReceivedIntake,
  updateIntake,
  type IntakeRow,
} from '../services/intakes.js';
import { extractContent, ExtractError } from './extract.js';
import { cleanWithOptionalAi } from './clean.js';
import { pickProfile } from './cleanProfiles.js';
import { analyzeContent } from './analyze.js';

/**
 * WORKER INTAKE (in-process, pojedynczy) — pipeline-frontend §c: kolejka w tabeli
 * intakes, pętla co 2 s, statusy received→extracted→cleaned→analyzed→drafted|failed.
 * Po analyzed tworzy draft w Inboxie (repo shared drafts, metadata.intakeId).
 * Błędy → status failed z kodem (humanize w services/messages.ts).
 * Bez spawnowania procesów na intake — spawn tylko dla buildów (jobs/).
 */

export interface IntakeWorkerDeps {
  /** Wstrzykiwany w testach zamiast globalnego fetch (Stirling/Tika). */
  fetchImpl?: typeof globalThis.fetch;
  /** Klient chat_llm do analyze; undefined = zbuduj z settings; null = brak (heurystyka). */
  chatLlm?: LlmClient | null;
  /** Klient openie do czyszczenia AI; undefined = z settings (gdy aiClean), null = wyłączony. */
  openieLlm?: LlmClient | null;
  /** Przebieg LLM czyszczenia (default: env CONTENT_AI_CLEAN === '1'). */
  aiClean?: boolean;
}

interface LlmSettingsShape {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Klient LLM z ustawień (sealed AES-GCM) — null gdy brak/uszkodzona konfiguracja. */
export function llmFromSettings(
  db: Db,
  config: AppConfig,
  key: 'llm.chat' | 'llm.openie',
): LlmClient | null {
  try {
    const keyB64 = config.tokenEncKey.toString('base64');
    const value = getSetting(db, key, { unseal: (sealed) => unseal(sealed, keyB64) })?.value;
    if (typeof value !== 'object' || value === null) return null;
    const o = value as Record<string, unknown>;
    const cfg: LlmSettingsShape = {
      baseUrl: typeof o['baseUrl'] === 'string' ? o['baseUrl'] : '',
      apiKey: typeof o['apiKey'] === 'string' ? o['apiKey'] : '',
      model: typeof o['model'] === 'string' ? o['model'] : '',
    };
    if (cfg.baseUrl === '' || cfg.apiKey === '' || cfg.model === '') return null;
    return createLlmClient(cfg);
  } catch {
    return null; // brak konfiguracji LLM nigdy nie zatrzymuje pipeline'u (fallbacki)
  }
}

const SOURCE_KIND_TO_DRAFT: Record<IntakeRow['source_kind'], DraftSourceType> = {
  upload: 'upload',
  text: 'text',
  api: 'api',
};

/** Kod błędu do kolumny intakes.error (ExtractError/AppError → kod, reszta → 'internal'). */
function errorCode(err: unknown): string {
  if (err instanceof ExtractError) return err.code;
  if (err instanceof AppError) return err.code;
  return 'internal';
}

/**
 * Przetwarza JEDEN intake przez wszystkie etapy. Każde przejście statusu
 * zapisywane od razu (widoczny postęp w GET /content/:id). Rzuty łapane
 * przez wołającego (tick) → status failed.
 */
export async function processIntake(
  db: Db,
  config: AppConfig,
  row: IntakeRow,
  deps: IntakeWorkerDeps = {},
): Promise<IntakeRow> {
  // ── Etap 2: ekstrakcja (kaskada Stirling → OCR → Tika z progiem jakości) ──
  if (row.blob_path === null) {
    throw new AppError('internal', `intake ${row.id} bez blob_path`);
  }
  const buffer = readFileSync(row.blob_path);
  const extracted = await extractContent(
    { buffer, mime: row.mime ?? 'text/plain', filename: row.original_name ?? 'input' },
    {
      stirlingUrl: config.stirlingUrl,
      tikaUrl: config.tikaUrl,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    },
  );
  updateIntake(db, row.id, {
    status: 'extracted',
    extract_provider: extracted.provider,
    extract_quality: extracted.quality,
  });

  // ── Etap 3: czyszczenie (regex + opcjonalny LLM openie z guardem) ─────────
  const aiClean = deps.aiClean ?? process.env['CONTENT_AI_CLEAN'] === '1';
  const openieLlm =
    deps.openieLlm !== undefined
      ? deps.openieLlm
      : aiClean
        ? llmFromSettings(db, config, 'llm.openie')
        : null;
  const profile = pickProfile({ mime: row.mime, sourceUrl: row.source_url });
  const cleaned = await cleanWithOptionalAi(extracted.text, profile, {
    llm: aiClean ? openieLlm : null,
  });
  updateIntake(db, row.id, {
    status: 'cleaned',
    clean_profile: cleaned.profile,
    cleaned_chars: cleaned.text.length,
    removed_ratio: cleaned.removedRatio,
  });

  // ── Etap 4: analyze (chat_llm + fallback heurystyczny) ────────────────────
  const chatLlm =
    deps.chatLlm !== undefined ? deps.chatLlm : llmFromSettings(db, config, 'llm.chat');
  const analysis = await analyzeContent(
    {
      content: cleaned.text,
      sourceUrl: row.source_url,
      // titleHint tylko dla wpisów tekstowych (tytuł od użytkownika) — nazwa
      // pliku uploadu to zły tytuł, H1/pierwsze zdanie z treści są lepsze.
      titleHint: row.source_kind === 'text' ? row.original_name : null,
      registry: listKbs(db),
    },
    { llm: chatLlm },
  );
  const analysisRecord = { ...analysis, aiCleanUsed: cleaned.aiUsed };
  updateIntake(db, row.id, {
    status: 'analyzed',
    analysis_json: JSON.stringify(analysisRecord),
  });

  // ── Etap 5: draft w Inboxie (human-in-the-loop — recenzja przed grafem) ───
  const draft = createDraft(db, {
    title: analysis.title,
    content: cleaned.text,
    sourceType: SOURCE_KIND_TO_DRAFT[row.source_kind],
    namespace: analysis.kbNamespace,
    sourceRef: row.source_url ?? row.original_name ?? null,
    documentCategory: analysis.documentCategory,
    tags: analysis.tags,
    metadata: {
      intakeId: row.id,
      analyzeProvider: analysis.provider,
      language: analysis.language,
      extractProvider: extracted.provider,
      cleanProfile: cleaned.profile,
      createdBy: row.created_by,
    },
    analysis: analysisRecord,
    // FK na users(id): intake może przyjść z CLI/integracji z createdBy spoza tabeli
    // users — wtedy NULL (tożsamość źródła zostaje w metadata.createdBy).
    submittedByUser: userExists(db, row.created_by) ? row.created_by : null,
  });
  return updateIntake(db, row.id, { status: 'drafted', draft_id: draft.id });
}

/**
 * Jeden przebieg workera: przetwarza WSZYSTKIE oczekujące intake'i po kolei
 * (najstarszy pierwszy). Błąd jednego intake'u → failed z kodem, pętla idzie
 * dalej. Zwraca liczbę przetworzonych (drafted+failed).
 */
export async function tickIntakeWorker(
  db: Db,
  config: AppConfig,
  deps: IntakeWorkerDeps = {},
  log?: FastifyBaseLogger,
): Promise<number> {
  let processed = 0;
  for (;;) {
    const row = nextReceivedIntake(db);
    if (row === null) return processed;
    try {
      await processIntake(db, config, row, deps);
      log?.info({ intakeId: row.id }, 'intake przetworzony do szkicu');
    } catch (err) {
      updateIntake(db, row.id, { status: 'failed', error: errorCode(err) });
      log?.warn({ intakeId: row.id, err }, 'intake zakończony błędem');
    }
    processed++;
  }
}

export interface IntakeWorkerHandle {
  stop(): void;
}

export interface StartIntakeWorkerOpts {
  db: Db;
  config: AppConfig;
  logger?: FastifyBaseLogger;
  /** Odstęp pętli (default 2000 ms — pipeline-frontend §c). */
  intervalMs?: number;
  deps?: IntakeWorkerDeps;
}

/**
 * Startuje pętlę workera co 2 s (timer unref — nie blokuje zamknięcia procesu).
 * Guard reentrancy: nowy tick nie startuje, póki poprzedni się nie skończy.
 */
export function startIntakeWorker(opts: StartIntakeWorkerOpts): IntakeWorkerHandle {
  const intervalMs = opts.intervalMs ?? 2_000;
  let busy = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (busy || stopped) return;
    busy = true;
    void tickIntakeWorker(opts.db, opts.config, opts.deps ?? {}, opts.logger)
      .catch((err) => opts.logger?.error({ err }, 'tick workera intake nie powiódł się'))
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  timer.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function userExists(db: Db, id: string | null): boolean {
  if (id === null || id === '') return false;
  return db.prepare('SELECT 1 FROM users WHERE id = ?').get(id) !== undefined;
}
