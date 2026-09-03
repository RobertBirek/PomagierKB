/**
 * Typy odpowiedzi API strony /add (kontrakt: apps/panel-api/src/routes/content.ts,
 * kbs.ts) — współdzielone przez AddPage i komponenty add/*.
 */
import type { IntakeStageApi } from '../../lib/intake';

export interface KbItem {
  namespace: string;
  name: string;
  status: string;
  isDefault: boolean;
}

export interface HumanMessage {
  label: string;
  description?: string;
  action?: string;
}

export interface IntakeDetail {
  id: string;
  sourceKind: string;
  originalName: string | null;
  sourceUrl: string | null;
  status: string;
  statusHuman: HumanMessage;
  draftId: string | null;
  error: string | null;
  errorHuman: HumanMessage | null;
  stages: IntakeStageApi[];
  createdAt: string;
  updatedAt: string;
}

export interface IntakeListItem {
  id: string;
  sourceKind: string;
  originalName: string | null;
  status: string;
  statusHuman: HumanMessage;
  draftId: string | null;
  error: string | null;
  createdAt: string;
}

export interface SubmitResponse {
  intakeId: string;
  status: string;
  deduplicated?: boolean;
}

/** Wariant plakietki statusu intake'u (drafted=ok, failed=fail, w toku=accent). */
export function intakeBadgeVariant(status: string): 'ok' | 'fail' | 'accent' {
  if (status === 'drafted') return 'ok';
  if (status === 'failed') return 'fail';
  return 'accent';
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
