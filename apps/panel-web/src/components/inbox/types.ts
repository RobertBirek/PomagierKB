/**
 * Typy odpowiedzi API Inboxu (kontrakt: apps/panel-api/src/routes/{drafts,learning}.ts,
 * services/{drafts,learning}.ts) — współdzielone przez InboxPage i komponenty inbox/*.
 */

export interface DraftListItem {
  id: string;
  namespace: string;
  status: string;
  title: string;
  sourceType: string | null;
  sourceRef: string | null;
  documentCategory: string | null;
  tags: string[];
  contentLength: number | null;
  rejectReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DraftDetail extends DraftListItem {
  contentMd: string | null;
  analysis: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
}

export interface KbItem {
  namespace: string;
  name: string;
  status: string;
}

export interface GapItem {
  id: string;
  question: string;
  source: string;
  namespace: string | null;
  confidence: number;
  evidenceCount: number;
  status: string;
  draftId: string | null;
  createdAt: string;
}

export interface GapStats {
  stats: Record<string, number>;
  total: number;
}

export interface BulkResult {
  id: string;
  ok: boolean;
  reason?: string;
}

export interface BulkReport {
  op: 'promote' | 'reject';
  dryRun: boolean;
  results: BulkResult[];
  applied: number;
}
