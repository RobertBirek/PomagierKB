import { describe, expect, it } from 'vitest';
import { routeNamespaces } from '../src/answer/routing.js';
import { rrfFuse } from '../src/openspg/index.js';

/** Routing hints cross-KB + ważony RRF (Faza 7 programu rozbudowy). */

const KBS = [
  { namespace: 'LightingDocs', name: 'Oświetlenie', routingKeywords: ['oświetlenie', 'oprawa', 'szynoprzewod', 'dali'] },
  { namespace: 'FirmProcedures', name: 'Procedury firmowe', routingKeywords: ['urlop', 'delegacja', 'kadry'] },
];

describe('routeNamespaces', () => {
  it('zapytanie o oprawy boostuje KB oświetleniową, nie procedury', () => {
    const r = routeNamespaces('jaka oprawa do hali wysokiego składowania', KBS);
    expect(r.matched).toEqual(['LightingDocs']);
    expect(r.weights.get('LightingDocs')!).toBeGreaterThan(1);
    expect(r.weights.get('FirmProcedures')).toBe(1);
  });

  it('fleksja: dopasowanie prefiksowe (szynoprzewodów ~ szynoprzewod)', () => {
    const r = routeNamespaces('obciążenie szynoprzewodów', KBS);
    expect(r.matched).toContain('LightingDocs');
  });

  it('nazwa KB też routuje; brak dopasowań → wszystkie wagi 1', () => {
    const byName = routeNamespaces('procedury dotyczące zwrotów', KBS);
    expect(byName.matched).toContain('FirmProcedures');
    const none = routeNamespaces('zupełnie inny temat kosmiczny', KBS);
    expect(none.matched).toEqual([]);
    expect([...none.weights.values()]).toEqual([1, 1]);
  });

  it('waga rośnie z liczbą trafień, ale ma sufit 1.5', () => {
    const r = routeNamespaces('oprawa dali oświetlenie szynoprzewody oprawy', KBS);
    expect(r.weights.get('LightingDocs')).toBe(1.5);
  });
});

describe('rrfFuse z wagami (fuzja per-KB)', () => {
  const listA = { source: 'KbA', items: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }] };
  const listB = { source: 'KbB', items: [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }] };

  it('bez wag: rank-1 obu KB ma równy wkład (koniec dominacji gęstszej bazy)', () => {
    const fused = rrfFuse([listA, listB]);
    const a1 = fused.find((f) => f.id === 'a1')!;
    const b1 = fused.find((f) => f.id === 'b1')!;
    expect(a1.score).toBeCloseTo(b1.score, 12);
  });

  it('waga 1.5 wynosi rank-1 boostowanej KB nad rank-1 pozostałych', () => {
    const fused = rrfFuse([listA, { ...listB, weight: 1.5 }]);
    expect(fused[0]?.id).toBe('b1');
    const b1 = fused.find((f) => f.id === 'b1')!;
    const a1 = fused.find((f) => f.id === 'a1')!;
    expect(b1.score).toBeCloseTo(a1.score * 1.5, 12);
  });

  it('weight default 1 — wynik identyczny jak klasyczny RRF', () => {
    const classic = rrfFuse([listA, listB]);
    const explicit = rrfFuse([{ ...listA, weight: 1 }, { ...listB, weight: 1 }]);
    expect(explicit).toEqual(classic);
  });
});
