import { describe, expect, it } from 'vitest';
import {
  actionTypeLabelKey,
  computeKbStats,
  metaTotal,
  openGapsCount,
} from '../src/lib/overviewMetrics';
import { pl } from '../src/i18n/pl';

describe('computeKbStats()', () => {
  it('sumuje bazy, aktywne oraz totals dokumentów i chunków', () => {
    const stats = computeKbStats([
      { status: 'active', totals: { documents: 10, chunks: 120 } },
      { status: 'active', totals: { documents: 5, chunks: 40 } },
      { status: 'archived', totals: { documents: 2, chunks: 8 } },
      { status: 'draft', totals: { documents: 0, chunks: 0 } },
    ]);
    expect(stats).toEqual({ total: 4, active: 2, documents: 17, chunks: 168 });
  });

  it('defensywnie: brak totals / śmieciowe wartości liczone jako 0', () => {
    const stats = computeKbStats([
      { status: 'active' },
      { status: 'active', totals: null },
      { status: 'active', totals: { documents: 'x' as unknown as number, chunks: -5 } },
      { status: 'active', totals: { documents: Number.NaN, chunks: 3 } },
    ]);
    expect(stats).toEqual({ total: 4, active: 4, documents: 0, chunks: 3 });
  });

  it('nie-tablica / pusta lista → zera', () => {
    expect(computeKbStats(undefined)).toEqual({ total: 0, active: 0, documents: 0, chunks: 0 });
    expect(computeKbStats(null)).toEqual({ total: 0, active: 0, documents: 0, chunks: 0 });
    expect(computeKbStats([])).toEqual({ total: 0, active: 0, documents: 0, chunks: 0 });
  });
});

describe('metaTotal()', () => {
  it('poprawny licznik z meta.total (0 też jest poprawne)', () => {
    expect(metaTotal({ page: 1, limit: 1, total: 134 })).toBe(134);
    expect(metaTotal({ total: 0 })).toBe(0);
  });

  it('brak meta / brak total / śmieci → null (kafel pokaże „—")', () => {
    expect(metaTotal(undefined)).toBeNull();
    expect(metaTotal({})).toBeNull();
    expect(metaTotal({ total: Number.NaN })).toBeNull();
    expect(metaTotal({ total: -1 })).toBeNull();
  });
});

describe('openGapsCount()', () => {
  it('wyciąga stats.open z odpowiedzi GET /learning/stats', () => {
    expect(openGapsCount({ stats: { open: 7, in_draft: 2, resolved: 1, ignored: 0 }, total: 10 })).toBe(7);
    expect(openGapsCount({ stats: { open: 0 }, total: 0 })).toBe(0);
  });

  it('defensywnie: brak stats / brak open / zły typ → null', () => {
    expect(openGapsCount(null)).toBeNull();
    expect(openGapsCount({})).toBeNull();
    expect(openGapsCount({ stats: null })).toBeNull();
    expect(openGapsCount({ stats: { open: 'x' } })).toBeNull();
  });
});

describe('actionTypeLabelKey()', () => {
  it('znane typy akcji mają klucze PL istniejące w słowniku', () => {
    for (const type of ['build_kb', 'create_kb', 'quality_gate', 'schema_sync']) {
      const key = actionTypeLabelKey(type);
      expect(key).not.toBeNull();
      expect(pl[key!]).toBeTypeOf('string');
    }
  });

  it('nieznany typ → null (UI pokazuje surowy typ)', () => {
    expect(actionTypeLabelKey('unknown_type')).toBeNull();
    expect(actionTypeLabelKey('')).toBeNull();
  });
});
