import { describe, expect, it } from 'vitest';
import {
  buildDraftFilterChips,
  DRAFT_STATUS_DEFAULT,
} from '../src/components/inbox/filterChips';

const statusLabel = (s: string): string => (s === 'all' ? 'Wszystkie' : `S:${s}`);
const kbLabel = (ns: string): string | undefined => (ns === 'kb1' ? 'Baza pierwsza' : undefined);

describe('buildDraftFilterChips()', () => {
  it('brak filtrów (domyślny widok pending) → zero chipów', () => {
    expect(buildDraftFilterChips({}, statusLabel, kbLabel)).toEqual([]);
    expect(
      buildDraftFilterChips({ status: DRAFT_STATUS_DEFAULT }, statusLabel, kbLabel),
    ).toEqual([]);
  });

  it('status inny niż pending → chip statusu (także all)', () => {
    const chips = buildDraftFilterChips({ status: 'rejected' }, statusLabel, kbLabel);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toEqual({ key: 'status', label: 'Status: S:rejected' });

    const all = buildDraftFilterChips({ status: 'all' }, statusLabel, kbLabel);
    expect(all[0]?.label).toBe('Status: Wszystkie');
  });

  it('kb → chip z nazwą bazy z resolvera', () => {
    const chips = buildDraftFilterChips({ kb: 'kb1' }, statusLabel, kbLabel);
    expect(chips).toEqual([{ key: 'kb', label: 'Baza: Baza pierwsza' }]);
  });

  it('kb bez nazwy w rejestrze → fallback na surowy namespace', () => {
    const chips = buildDraftFilterChips({ kb: 'unknown-ns' }, statusLabel, kbLabel);
    expect(chips[0]?.label).toBe('Baza: unknown-ns');
  });

  it('q → chip frazy w cudzysłowie', () => {
    const chips = buildDraftFilterChips({ q: 'cennik' }, statusLabel, kbLabel);
    expect(chips).toEqual([{ key: 'q', label: 'Szukaj: „cennik”' }]);
  });

  it('puste stringi NIE tworzą chipów', () => {
    expect(buildDraftFilterChips({ kb: '', q: '' }, statusLabel, kbLabel)).toEqual([]);
  });

  it('wszystkie filtry → kolejność status, kb, q', () => {
    const chips = buildDraftFilterChips(
      { status: 'promoted', kb: 'kb1', q: 'x' },
      statusLabel,
      kbLabel,
    );
    expect(chips.map((c) => c.key)).toEqual(['status', 'kb', 'q']);
  });
});
