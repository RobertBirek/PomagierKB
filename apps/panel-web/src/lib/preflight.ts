/**
 * Mapowanie checków preflight buildu KB (POST /api/v1/kbs/:ns/preflight →
 * {ok, checks:[{id,ok,severity,message}]}) na grupy wyświetlane w modalu —
 * CZYSTA logika bez React/DOM. Komunikaty PL przychodzą z backendu
 * (services/kb.ts preflightBuild); tu tylko grupowanie i etykiety checków.
 * Testy: test/preflight.test.ts.
 */
import type { PlKey } from '../i18n/pl';

export interface PreflightCheck {
  id: string;
  ok: boolean;
  severity: 'error' | 'warn';
  message: string;
}

export interface PreflightGroups {
  /** Nieprzeszłe checki severity=error — blokują build. */
  blockers: PreflightCheck[];
  /** Nieprzeszłe checki severity=warn — build możliwy „mimo ostrzeżeń". */
  warnings: PreflightCheck[];
  /** Checki zaliczone. */
  passed: PreflightCheck[];
}

export function groupPreflightChecks(checks: readonly PreflightCheck[]): PreflightGroups {
  const groups: PreflightGroups = { blockers: [], warnings: [], passed: [] };
  for (const check of checks) {
    if (check.ok) groups.passed.push(check);
    else if (check.severity === 'error') groups.blockers.push(check);
    else groups.warnings.push(check);
  }
  return groups;
}

/** Build dozwolony, gdy nie ma blokerów (warny nie blokują — przycisk „Buduj mimo ostrzeżeń"). */
export function canBuild(checks: readonly PreflightCheck[]): boolean {
  return groupPreflightChecks(checks).blockers.length === 0;
}

/**
 * Ludzka etykieta checka (klucz słownika PL). Nieznany check NIE wycieka
 * surowym id — dostaje etykietę ogólną 'kb.preflight.check.generic'.
 */
const CHECK_LABEL_KEYS: Record<string, PlKey> = {
  kb_active: 'kb.preflight.check.kbActive',
  embedding_model: 'kb.preflight.check.embeddingModel',
  openspg_reachable: 'kb.preflight.check.openspgReachable',
  promoted_drafts: 'kb.preflight.check.promotedDrafts',
  no_running_build: 'kb.preflight.check.noRunningBuild',
};

export function preflightCheckLabelKey(id: string): PlKey {
  return CHECK_LABEL_KEYS[id] ?? 'kb.preflight.check.generic';
}
