import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Usage-log JSONL: DATA_DIR/mcp-usage/<yyyy-mm-dd>.jsonl — odczyty (search/answer)
 * idą tu, POZA łańcuchem audytu (lekcja: kontencja hash-chaina przy ruchu MCP).
 * Rotacja rozmiaru: plik > 5 MB → rename na <plik>.<epoch>, nowy zaczyna się czysty.
 * Zapis best-effort — błąd dysku nie może wywrócić odpowiedzi narzędzia.
 */

export interface UsageEntry {
  at: string;
  keyId: string;
  tool: string;
  namespaces: string[];
  tookMs: number;
  confidence?: number;
  degraded?: boolean;
}

export interface UsageLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export class UsageLog {
  constructor(
    private readonly dir: string,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
    private readonly log?: UsageLogger,
  ) {}

  append(entry: UsageEntry): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = join(this.dir, `${entry.at.slice(0, 10)}.jsonl`);
      try {
        if (statSync(file).size >= this.maxBytes) renameSync(file, `${file}.${Date.now()}`);
      } catch {
        // plik jeszcze nie istnieje — pierwszy wpis dnia
      }
      appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      this.log?.warn({ err: err instanceof Error ? err.message : String(err) }, 'usage-log: zapis nieudany');
    }
  }
}
