import { describe, expect, it } from 'vitest';
import { buildHealthCockpit, normalizeStatus, worstStatus, type HealthStatus } from '../src/lib/health';

describe('normalizeStatus()', () => {
  it('mapuje statusy sukcesu na OK', () => {
    for (const raw of ['OK', 'pass', 'FINISH', 'done', 'Success', 'active', 'healthy']) {
      expect(normalizeStatus(raw)).toBe('OK');
    }
  });
  it('mapuje awarie na FAIL', () => {
    for (const raw of ['FAIL', 'failed', 'ERROR', 'down', 'TERMINATE']) {
      expect(normalizeStatus(raw)).toBe('FAIL');
    }
  });
  it('mapuje stany przejściowe/ostrzegawcze na WARN', () => {
    for (const raw of ['WARN', 'running', 'STALE', 'pending', 'degraded']) {
      expect(normalizeStatus(raw)).toBe('WARN');
    }
  });
  it('nieznane i puste → UNKNOWN (białe znaki i wielkość liter obojętne)', () => {
    expect(normalizeStatus(undefined)).toBe('UNKNOWN');
    expect(normalizeStatus(null)).toBe('UNKNOWN');
    expect(normalizeStatus('coś-dziwnego')).toBe('UNKNOWN');
    expect(normalizeStatus('  ok  ')).toBe('OK');
  });
});

describe('worstStatus()', () => {
  it('FAIL > WARN > UNKNOWN > OK', () => {
    expect(worstStatus(['OK', 'WARN', 'FAIL'])).toBe('FAIL');
    expect(worstStatus(['OK', 'WARN'])).toBe('WARN');
    expect(worstStatus(['OK', 'UNKNOWN'])).toBe('UNKNOWN');
    expect(worstStatus(['OK', 'OK'])).toBe('OK');
  });
  it('pusta lista → UNKNOWN', () => {
    expect(worstStatus([])).toBe('UNKNOWN');
  });
});

describe('buildHealthCockpit()', () => {
  it('komponenty z API: down → FAIL, ok → OK; overall = najgorszy', () => {
    const cockpit = buildHealthCockpit({
      components: [
        { id: 'openspg', label: 'Graf wiedzy', status: 'ok' },
        { id: 'mcp', label: 'Serwer MCP', status: 'down', detail: 'timeout' },
      ],
    });
    expect(cockpit.overallStatus).toBe('FAIL');
    expect(cockpit.signals.map((s) => [s.id, s.status])).toEqual([
      ['openspg', 'OK'],
      ['mcp', 'FAIL'],
    ]);
    expect(cockpit.signals[1]?.value).toBe('timeout');
  });

  it('pending drafty > 0 → WARN (czeka recenzja człowieka)', () => {
    expect(buildHealthCockpit({ pendingDrafts: 3 }).overallStatus).toBe('WARN');
    expect(buildHealthCockpit({ pendingDrafts: 0 }).overallStatus).toBe('OK');
  });

  it('akcje: failed → FAIL ma pierwszeństwo przed running → WARN', () => {
    expect(buildHealthCockpit({ failedActions: 1, runningActions: 2 }).overallStatus).toBe('FAIL');
    expect(buildHealthCockpit({ failedActions: 0, runningActions: 2 }).overallStatus).toBe('WARN');
    expect(buildHealthCockpit({ failedActions: 0, runningActions: 0 }).overallStatus).toBe('OK');
  });

  it('luki wiedzy powyżej progu → WARN (domyślny próg 10)', () => {
    expect(buildHealthCockpit({ openGaps: 11 }).overallStatus).toBe('WARN');
    expect(buildHealthCockpit({ openGaps: 10 }).overallStatus).toBe('OK');
    expect(buildHealthCockpit({ openGaps: 3, gapsWarnThreshold: 2 }).overallStatus).toBe('WARN');
  });

  it('otwarty/half-open breaker → WARN; zamknięte → OK', () => {
    expect(buildHealthCockpit({ breakers: [{ name: 'llm.chat', state: 'open' }] }).overallStatus).toBe('WARN');
    expect(buildHealthCockpit({ breakers: [{ name: 'llm.chat', state: 'half_open' }] }).overallStatus).toBe('WARN');
    expect(buildHealthCockpit({ breakers: [{ name: 'llm.chat', state: 'closed' }] }).overallStatus).toBe('OK');
  });

  it('quality = najgorszy verdict aktywnych KB', () => {
    const cockpit = buildHealthCockpit({ qualityVerdicts: ['OK', 'WARN'] });
    const quality = cockpit.signals.find((s) => s.id === 'quality');
    expect(quality?.status).toBe('WARN' satisfies HealthStatus);
  });

  it('pusty input → brak sygnałów, overall UNKNOWN', () => {
    const cockpit = buildHealthCockpit({});
    expect(cockpit.signals).toEqual([]);
    expect(cockpit.overallStatus).toBe('UNKNOWN');
  });
});
