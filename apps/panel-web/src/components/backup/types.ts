/**
 * DTO strony /backup — lustro odpowiedzi `GET /api/v1/backup/state`
 * (kontrakt: `apps/panel-api/src/services/backup-state.ts`).
 *
 * Wszystko jest `| null`, bo źródłem jest plik pisany przez HOST, a host może nie
 * raportować, raportować częściowo albo być starszy niż panel. Strona ma wtedy
 * powiedzieć „nie wiem", a nie pokazać zero jako fakt.
 */

export type BackupVerdict = 'ok' | 'warn' | 'down' | 'unknown';

export interface BackupOffsiteView {
  target: string | null;
  status: string | null;
  encryption: string | null;
  artifact: string | null;
}

export interface BackupRunView {
  stamp: string | null;
  createdAt: string | null;
  ok: boolean | null;
  sizeBytes: number | null;
  coreArtifacts: number | null;
  missingRequired: string[];
  warnings: string[];
  neo4jMode: string | null;
  offsite: BackupOffsiteView;
}

export interface BackupVerifyCheckView {
  name: string;
  ok: boolean;
  detail: string | null;
}

export interface BackupVerifyView {
  stamp: string | null;
  checkedAt: string | null;
  ok: boolean | null;
  snapshotStamp: string | null;
  checks: BackupVerifyCheckView[];
  failed: string[];
}

export interface BackupSnapshotView {
  stamp: string;
  sizeBytes: number | null;
  ok: boolean | null;
  neo4jMode: string | null;
  monthly: boolean;
}

export interface BackupTimerView {
  unit: string;
  enabled: boolean | null;
  next: string | null;
  last: string | null;
}

export interface BackupHostConfigView {
  offsiteTarget: string | null;
  encryption: string | null;
  pingBackupConfigured: boolean | null;
  pingVerifyConfigured: boolean | null;
  rcloneRemotes: string[];
  retentionDays: number | null;
  monthlyRetentionMonths: number | null;
}

export interface BackupStateView {
  generatedAt: string | null;
  stateAgeSeconds: number | null;
  last: BackupRunView | null;
  verify: BackupVerifyView | null;
  snapshots: BackupSnapshotView[];
  timers: BackupTimerView[];
  config: BackupHostConfigView;
  disk: { freeBytes: number | null; usedPercent: number | null };
  triggerSupported: boolean;
}

/** Parametry edytowalne z panelu — wyłącznie niesekretne. */
export interface BackupConfigView {
  retentionDays: number;
  monthlyRetentionMonths: number;
  offsiteEnabled: boolean;
  coldNeo4jEnabled: boolean;
}

export interface BackupVerdictView {
  verdict: BackupVerdict;
  detail: string;
}

export interface BackupStateResponse {
  state: BackupStateView | null;
  stale: boolean;
  verdicts: {
    backup: BackupVerdictView;
    verify: BackupVerdictView;
    offsite: BackupVerdictView;
  };
  config: BackupConfigView;
  requestPending: boolean;
}
