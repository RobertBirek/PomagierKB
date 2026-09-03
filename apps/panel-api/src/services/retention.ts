import { readdirSync, statSync, unlinkSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@pomagierkb/shared/db';
import { appendAudit } from '@pomagierkb/shared/audit';

/**
 * Retencja plików aplikacji (program rozbudowy F11.4) — katalogi rosły BEZ
 * ŻADNEGO sprzątania: logi akcji, usage MCP, eksporty CSV, bloby nieudanych
 * intake'ów. Worker dzienny (wzorzec intake-worker: interval + unref + guard);
 * KAŻDE usunięcie audytowane zbiorczo (zasada: mutacje audytowane).
 * Czysta logika wyboru celów (selectExpired*) — vitest bez dotykania dysku.
 * Domyślne okresy nadpisywalne kluczem 'retention' w settings.
 */

export interface RetentionPolicy {
  /** Pliki logów akcji starsze niż X dni (wiersze actions zostają). */
  actionLogsDays: number;
  /** Dzienniki usage MCP starsze niż X dni. */
  mcpUsageDays: number;
  /** Katalogi eksportów CSV starsze niż X dni (manifesty w DB zostają). */
  exportsDays: number;
  /** Bloby intake'ów failed starszych niż X dni (wiersz intake zostaje z adnotacją). */
  failedIntakesDays: number;
}

export const RETENTION_DEFAULTS: RetentionPolicy = {
  actionLogsDays: 90,
  mcpUsageDays: 180,
  exportsDays: 30,
  failedIntakesDays: 30,
};

export function readRetentionPolicy(db: Db): RetentionPolicy {
  try {
    const row = db.prepare("SELECT value_json FROM settings WHERE key = 'retention'").get() as
      | { value_json: string }
      | undefined;
    if (!row) return RETENTION_DEFAULTS;
    const o = JSON.parse(row.value_json) as Record<string, unknown>;
    const num = (v: unknown, d: number): number =>
      typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : d;
    return {
      actionLogsDays: num(o['actionLogsDays'], RETENTION_DEFAULTS.actionLogsDays),
      mcpUsageDays: num(o['mcpUsageDays'], RETENTION_DEFAULTS.mcpUsageDays),
      exportsDays: num(o['exportsDays'], RETENTION_DEFAULTS.exportsDays),
      failedIntakesDays: num(o['failedIntakesDays'], RETENTION_DEFAULTS.failedIntakesDays),
    };
  } catch {
    return RETENTION_DEFAULTS;
  }
}

export interface FileCandidate {
  path: string;
  mtimeMs: number;
}

/** CZYSTA selekcja: pliki starsze niż cutoff (now - days). */
export function selectExpired(files: FileCandidate[], days: number, now: number): string[] {
  const cutoff = now - days * 86_400_000;
  return files.filter((f) => f.mtimeMs < cutoff).map((f) => f.path);
}

function walkFiles(dir: string, depth = 3): FileCandidate[] {
  if (!existsSync(dir)) return [];
  const out: FileCandidate[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (depth > 0) out.push(...walkFiles(p, depth - 1));
    } else {
      out.push({ path: p, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

export interface RetentionRunResult {
  actionLogs: number;
  mcpUsage: number;
  exportDirs: number;
  failedIntakeBlobs: number;
}

export function runRetention(db: Db, dataDir: string, now = Date.now()): RetentionRunResult {
  const policy = readRetentionPolicy(db);
  const result: RetentionRunResult = { actionLogs: 0, mcpUsage: 0, exportDirs: 0, failedIntakeBlobs: 0 };

  for (const path of selectExpired(walkFiles(join(dataDir, 'actions')), policy.actionLogsDays, now)) {
    try {
      unlinkSync(path);
      result.actionLogs++;
    } catch {
      /* best-effort */
    }
  }
  for (const path of selectExpired(walkFiles(join(dataDir, 'mcp-usage'), 0), policy.mcpUsageDays, now)) {
    try {
      unlinkSync(path);
      result.mcpUsage++;
    } catch {
      /* best-effort */
    }
  }

  // Eksporty: całe katalogi <dataDir>/exports/<ns>/<runId> starsze niż polityka.
  const exportsRoot = join(dataDir, 'exports');
  if (existsSync(exportsRoot)) {
    const cutoff = now - policy.exportsDays * 86_400_000;
    for (const ns of readdirSync(exportsRoot)) {
      const nsDir = join(exportsRoot, ns);
      let entries: string[] = [];
      try {
        entries = readdirSync(nsDir);
      } catch {
        continue;
      }
      for (const runId of entries) {
        const dir = join(nsDir, runId);
        try {
          if (statSync(dir).mtimeMs < cutoff) {
            rmSync(dir, { recursive: true, force: true });
            result.exportDirs++;
          }
        } catch {
          /* best-effort */
        }
      }
    }
  }

  // Bloby failed intake'ów: tylko gdy blob nie jest współdzielony z innym intakiem.
  const cutoffIso = new Date(now - policy.failedIntakesDays * 86_400_000).toISOString();
  const failed = db
    .prepare(
      `SELECT id, blob_path FROM intakes WHERE status = 'failed' AND blob_path IS NOT NULL AND updated_at < ?`,
    )
    .all(cutoffIso) as { id: string; blob_path: string }[];
  for (const row of failed) {
    const shared = (
      db.prepare('SELECT COUNT(*) AS n FROM intakes WHERE blob_path = ? AND id != ?').get(row.blob_path, row.id) as { n: number }
    ).n;
    if (shared > 0) continue;
    try {
      if (existsSync(row.blob_path)) unlinkSync(row.blob_path);
      db.prepare('UPDATE intakes SET blob_path = NULL WHERE id = ?').run(row.id);
      result.failedIntakeBlobs++;
    } catch {
      /* best-effort */
    }
  }

  const total = result.actionLogs + result.mcpUsage + result.exportDirs + result.failedIntakeBlobs;
  if (total > 0) {
    appendAudit(db, {
      actor: 'system',
      actorType: 'system',
      action: 'retention.purge',
      resourceType: 'files',
      resourceId: 'retention',
      metadata: { ...result, policy: { ...policy } },
    });
  }
  return result;
}

export interface RetentionWorkerHandle {
  stop(): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Worker dzienny (pierwszy bieg po 5 min od startu — nie opóźnia bootu). */
export function startRetentionWorker(opts: {
  db: Db;
  dataDir: string;
  logger?: FastifyBaseLogger;
  intervalMs?: number;
  initialDelayMs?: number;
}): RetentionWorkerHandle {
  const intervalMs = opts.intervalMs ?? DAY_MS;
  const run = (): void => {
    try {
      const result = runRetention(opts.db, opts.dataDir);
      opts.logger?.info({ result }, 'retencja plików wykonana');
    } catch (err) {
      opts.logger?.warn({ err }, 'retencja plików nie powiodła się');
    }
  };
  const first = setTimeout(run, opts.initialDelayMs ?? 5 * 60_000);
  first.unref();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return {
    stop() {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
