/**
 * Czysta logika strony /add: mapowanie etapów intake'u (GET /api/v1/content/:id
 * → intake.stages z polami humanized backendu) na kroki komponentu Stepper oraz
 * walidacja pliku przed uploadem (whitelist rozszerzeń + limit 50 MB — zgodnie
 * z apps/panel-api/src/services/intakes.ts). Testy w test/intake.test.ts.
 */
import type { Step } from '../components/Stepper';

/** Whitelist rozszerzeń uploadu — MUSI odpowiadać ALLOWED_EXTENSIONS backendu. */
export const UPLOAD_EXTENSIONS = [
  'md',
  'txt',
  'pdf',
  'html',
  'docx',
  'xlsx',
  'pptx',
  'csv',
  'json',
  'xml',
  'yaml',
] as const;

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Atrybut accept dla <input type="file"> (".md,.txt,…"). */
export const UPLOAD_ACCEPT = UPLOAD_EXTENSIONS.map((ext) => `.${ext}`).join(',');

export type UploadValidation = { ok: true } | { ok: false; code: 'extension' | 'size' };

/** Walidacja pliku PRZED wysyłką (szybki komunikat zamiast błędu z API). */
export function validateUploadFile(name: string, sizeBytes: number): UploadValidation {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  const ext = m?.[1]?.toLowerCase();
  if (ext === undefined || !(UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
    return { ok: false, code: 'extension' };
  }
  if (sizeBytes > MAX_UPLOAD_BYTES) return { ok: false, code: 'size' };
  return { ok: true };
}

/** Etap z API (intakeToDetail backendu: stage + humanized + reached/current). */
export interface IntakeStageApi {
  stage: string;
  label?: string;
  description?: string;
  action?: string;
  reached: boolean;
  current: boolean;
}

/**
 * Etapy API → kroki Steppera (LUDZKIE etykiety z backendu, nie tłumaczymy tu):
 * - status 'failed' → najdalszy osiągnięty etap oznaczony jako failed;
 * - status 'drafted' (terminalny sukces) → bieżący etap jako done, nie active;
 * - w toku → current=active, reached=done, reszta pending.
 */
export function stagesToSteps(stages: readonly IntakeStageApi[], intakeStatus: string): Step[] {
  const failed = intakeStatus === 'failed';
  const terminalDone = intakeStatus === 'drafted';
  let lastReachedIdx = -1;
  stages.forEach((s, i) => {
    if (s.reached) lastReachedIdx = i;
  });
  return stages.map((s, i) => {
    let status: Step['status'];
    if (failed) {
      status = i === lastReachedIdx ? 'failed' : s.reached ? 'done' : 'pending';
    } else if (s.current) {
      status = terminalDone ? 'done' : 'active';
    } else {
      status = s.reached ? 'done' : 'pending';
    }
    const step: Step = { id: s.stage, label: s.label ?? s.stage, status };
    if (s.description !== undefined) step.description = s.description;
    return step;
  });
}

/** Czy status intake'u jest terminalny (polling co 2 s można zakończyć). */
export function isIntakeTerminal(status: string | undefined): boolean {
  return status === 'drafted' || status === 'failed';
}
