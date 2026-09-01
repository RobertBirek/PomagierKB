import type { ActionProgress, Db } from '@pomagierkb/shared/db';

/**
 * Kontrakt implementacji jobów (procesy potomne akcji). Osobny plik, żeby
 * joby (noop.ts, build-kb.ts, ...) nie importowały entrypointu run-job.ts.
 */

/** Kontekst przekazywany implementacji joba przez dispatcher run-job.ts. */
export interface JobContext {
  /** WŁASNE połączenie SQLite procesu potomnego (DATA_DIR/db/kag.db). */
  db: Db;
  actionId: string;
  dataDir: string;
  /** Sparsowane actions.params_json. */
  params: Record<string, unknown>;
  /**
   * Raport postępu: pisze linię '@@progress {...}' do logu (stdout → plik logu)
   * ORAZ aktualizuje actions.progress_json w DB (robi to dziecko, nie rodzic).
   */
  progress(p: ActionProgress): void;
  /** Linia logu z timestampem (stdout → plik logu akcji). */
  log(msg: string): void;
}

/** Implementacja joba — default export modułu jobs/<type>.ts. */
export type JobFn = (ctx: JobContext) => Promise<void>;

/** Kontrolowana porażka joba z własnym exit code (trafia do actions.exit_code). */
export class JobFailure extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'JobFailure';
    this.exitCode = exitCode;
  }
}
