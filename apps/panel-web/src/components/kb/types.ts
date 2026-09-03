/**
 * Kształty odpowiedzi API strony /kb — lustro apps/panel-api/src/services/kb.ts
 * (kbToApi) i routes/kbs.ts. Wspólne dla KbPage i komponentów components/kb/*.
 */

export interface DocumentTypeDef {
  name: string;
  description: string;
}

export interface KbEntry {
  namespace: string;
  name: string;
  description: string;
  projectId: number | null;
  status: string;
  dirty: boolean;
  schemaVersion: number | null;
  vectorModelId: string;
  documentTypes: DocumentTypeDef[];
  totals: { documents: number; chunks: number; pendingDrafts: number };
  createdAt: string;
  updatedAt: string;
}

export interface BuildJobItem {
  id: number | null;
  name: string;
  status: string;
  statusLabel: string;
  fileUrl: string | null;
  createdAt: string | null;
}

/** Odpowiedź 202 tras akcji długobieżnych (build/quality/create). */
export interface LaunchedAction {
  actionId: string;
}

/** GET /api/v1/kbs/:ns/quality — ostatni raport quality gate (null gdy brak). */
export interface QualityCheckDto {
  id?: string;
  level?: 'error' | 'warn';
  ok?: boolean;
  details?: string;
}

export interface QualityReport {
  id: number;
  runId: number | null;
  verdict: string;
  verdictLabel: string;
  checks: QualityCheckDto[];
  createdAt: string;
}
