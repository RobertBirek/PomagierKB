import type { Db } from '@pomagierkb/shared/db';
import { ALL_NAMESPACES, latestQualityReport } from '@pomagierkb/shared/db';
import { startAction } from '../services/actions-runner.js';

/**
 * HARMONOGRAM JOBÓW CYKLICZNYCH panelu (ustalenie D10-04).
 *
 * Job `quality_answers` („tygodniowy raport jakości odpowiedzi") miał tylko
 * ręczny trigger (POST /learning/quality-report) i nie uruchomił się w produkcji
 * ANI RAZU — metryki noAnswerRate/downRate/p50/p95/degradedRate nie powstawały,
 * a karta na /overview jest renderowana dopiero gdy raport istnieje, więc luka
 * była niewidoczna.
 *
 * Mechanizm: NIE dokładamy timera systemd (raport potrzebuje bazy i katalogu
 * danych panelu, a te ma proces panel-api). Tykamy z workera konserwacyjnego
 * (services/retention.ts, interwał dzienny) i sprawdzamy WIEK ostatniego raportu
 * — dzięki temu restart panelu nie gubi ani nie dubluje biegu, a job odpala się
 * najwyżej raz na `everyDays`. Akcja startuje jako `system` (startedBy = null).
 */

/** Domyślny odstęp między raportami jakości odpowiedzi (dni). */
export const QUALITY_ANSWERS_EVERY_DAYS = 6;

/**
 * CZYSTA decyzja: czy raport jest przeterminowany? Brak raportu → tak.
 * Data nieparsowalna → tak (lepiej policzyć raz za dużo niż nigdy).
 */
export function isReportDue(lastReportAt: string | null, now: number, everyDays: number): boolean {
  if (lastReportAt === null) return true;
  const at = Date.parse(lastReportAt);
  if (!Number.isFinite(at)) return true;
  return now - at >= everyDays * 86_400_000;
}

export interface SchedulerDeps {
  db: Db;
  dataDir: string;
  now?: number;
  everyDays?: number;
  /** Wstrzykiwane w testach zamiast realnego spawnu procesu potomnego. */
  startActionImpl?: typeof startAction;
  log?: (msg: string) => void;
}

/**
 * Uruchamia joby, których termin minął. Zwraca listę wystartowanych typów akcji
 * (pusta = nic nie było potrzebne). Nigdy nie rzuca — 409 (akcja tego typu już
 * biegnie) i błędy spawnu są tylko logowane, żeby nie wywrócić workera.
 */
export function runDueJobs(deps: SchedulerDeps): string[] {
  const now = deps.now ?? Date.now();
  const everyDays = deps.everyDays ?? QUALITY_ANSWERS_EVERY_DAYS;
  const started: string[] = [];

  const last = latestQualityReport(deps.db, ALL_NAMESPACES, 'answers');
  if (isReportDue(last?.created_at ?? null, now, everyDays)) {
    const start = deps.startActionImpl ?? startAction;
    try {
      const action = start(
        { db: deps.db, dataDir: deps.dataDir, warn: (msg) => deps.log?.(msg) },
        { type: 'quality_answers', resource: 'learning:quality', params: { scheduled: true }, startedBy: null },
      );
      started.push('quality_answers');
      deps.log?.(`harmonogram: uruchomiono quality_answers (akcja ${action.id})`);
    } catch (err) {
      // 409 action_already_running = poprzedni bieg jeszcze trwa — to nie błąd.
      deps.log?.(
        `harmonogram: nie uruchomiono quality_answers — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return started;
}
