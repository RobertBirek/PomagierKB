import type { Db, KbRow } from '@pomagierkb/shared/db';
import { getKbOrThrow } from '@pomagierkb/shared/db';
import { AppError } from '@pomagierkb/shared/errors';
import { commitSchema, getSchemaGraph } from '@pomagierkb/shared/openspg';
import { renderSchema, schemaDiffGuard } from '../services/schema-template.js';
import { latestSchemaVersion, recordSchemaVersion } from '../services/kb.js';
import type { KbJobContext } from './kb-runner.js';

/**
 * Akcja schema_sync — ADDYTYWNA aktualizacja schematu istniejącego projektu:
 * render nowej wersji szablonu → schemaDiffGuard vs ostatnia wersja
 * z schema_versions (zmiany destrukcyjne BLOKOWANE — lista naruszeń)
 * → commitSchema (upsert) → schema_version++ + zapis schema_versions.
 * Trasa robi ten sam plan PRZED startem akcji (422 preflight_failed z listą).
 */

const TOTAL_STEPS = 3;

export interface SchemaSyncPlan {
  namespace: string;
  projectId: number;
  /** Nowa treść i hash wyrenderowanego szablonu. */
  content: string;
  hash: string;
  /** Wersja, którą dostanie nowy commit (ostatnia + 1). */
  nextVersion: number;
  /** Naruszenia strażnika diffów (niepuste = zmiana destrukcyjna, blokada). */
  violations: string[];
  /** Hash identyczny z ostatnią wersją — commit będzie no-opem rejestru. */
  unchanged: boolean;
}

/**
 * Czysty plan synchronizacji (używany przez trasę jako preflight i przez joba).
 * Naruszenia NIE rzucają tutaj — wołający decyduje (422 w trasie, fail w jobie).
 */
export function planSchemaSync(db: Db, namespace: string): SchemaSyncPlan {
  const kb: KbRow = getKbOrThrow(db, namespace);
  if (kb.status !== 'active' || kb.project_id === null) {
    throw new AppError(
      'conflict',
      `schema_sync wymaga bazy active z projektem OpenSPG (status: ${kb.status}, projectId: ${kb.project_id ?? 'brak'})`,
    );
  }
  const rendered = renderSchema(namespace);
  const last = latestSchemaVersion(db, namespace);
  const violations = last ? schemaDiffGuard(last.content, rendered.content) : [];
  return {
    namespace,
    projectId: kb.project_id,
    content: rendered.content,
    hash: rendered.hash,
    nextVersion: (last?.version ?? kb.schema_version) + 1,
    violations,
    unchanged: last !== null && last.hash === rendered.hash,
  };
}

/** Naruszenia → AppError preflight_failed z checks[] (kontrakt 422 z details.checks). */
export function assertSchemaSyncSafe(plan: SchemaSyncPlan): void {
  if (plan.violations.length > 0) {
    throw new AppError('preflight_failed', 'zmiana schematu jest destrukcyjna — dozwolone są tylko zmiany addytywne', {
      checks: plan.violations.map((message) => ({
        id: 'schema_diff',
        ok: false,
        severity: 'error',
        message,
      })),
    });
  }
}

export async function runSchemaSyncJob(ctx: KbJobContext): Promise<void> {
  const { db, client, namespace } = ctx;
  const step = (n: number, phase: string, message: string): void =>
    ctx.progress({ phase, current: n, total: TOTAL_STEPS, message });

  // 1) Render + strażnik diffów (ponownie w jobie — trasa mogła być ominięta).
  step(1, 'render', 'Render szablonu i diff vs ostatnia wersja');
  const plan = planSchemaSync(db, namespace);
  assertSchemaSyncSafe(plan);
  if (plan.unchanged) {
    ctx.log('schemat identyczny z ostatnią wersją — commit potwierdzający bez podbicia wersji');
  }

  // 2) Commit (upsert po stronie OpenSPG) + weryfikacja grafu.
  step(2, 'commit', 'Commit schematu do OpenSPG');
  await commitSchema(client, plan.projectId, plan.content);
  await getSchemaGraph(client, plan.projectId); // rzuci przy niepoprawnej odpowiedzi grafu
  ctx.log(`schemat scommitowany do projektu #${plan.projectId} (sha256 ${plan.hash.slice(0, 12)}…)`);

  // 3) Rejestr: nowa wersja tylko przy realnej zmianie treści.
  step(3, 'registry', 'Zapis wersji schematu w rejestrze');
  if (!plan.unchanged) {
    recordSchemaVersion(db, namespace, {
      version: plan.nextVersion,
      hash: plan.hash,
      content: plan.content,
      createdBy: ctx.startedBy,
    });
    ctx.log(`schema_version → ${plan.nextVersion}`);
  } else {
    ctx.log('wersja schematu bez zmian');
  }
}
