import { describe, expect, it } from 'vitest';
import { createKb, replaceForDocument } from '../src/db/index.js';
import { extractClaims, parseVerdict, verifyClaim } from '../src/answer/index.js';
import type { AnswerCtx } from '../src/answer/index.js';
import { testDb } from './helpers.js';

/** Faza B4/B5 modernizacji MCP: weryfikacja tez + kontrakt claims. */

describe('extractClaims', () => {
  it('mapuje zdania na cytowania [n]; pomija nagłówki i krótkie frazy', () => {
    const answer = [
      '## Podsumowanie',
      'Maksymalne obciążenie toru wynosi 16 amperów na fazę [1].',
      'Odstęp zawiesi nie może przekraczać 1,5 metra [1][2]. Magistrala DALI obsługuje 64 urządzenia [2].',
      '- Krótkie.',
      '- Oprawy awaryjne wymagają comiesięcznego testu (bez cytowania).',
    ].join('\n');
    const claims = extractClaims(answer);
    expect(claims).toEqual([
      { claim: 'Maksymalne obciążenie toru wynosi 16 amperów na fazę.', evidenceNs: [1] },
      { claim: 'Odstęp zawiesi nie może przekraczać 1,5 metra.', evidenceNs: [1, 2] },
      { claim: 'Magistrala DALI obsługuje 64 urządzenia.', evidenceNs: [2] },
      { claim: 'Oprawy awaryjne wymagają comiesięcznego testu (bez cytowania).', evidenceNs: [] },
    ]);
  });
});

describe('parseVerdict', () => {
  it('poprawny JSON → werdykt; śmieci/nieznany status → null', () => {
    expect(parseVerdict('{"status":"supported","explanation":"Źródło [1] potwierdza.","evidenceNs":[1]}'))
      .toEqual({ status: 'supported', explanation: 'Źródło [1] potwierdza.', evidenceNs: [1] });
    expect(parseVerdict('nie-json')).toBeNull();
    expect(parseVerdict('{"status":"maybe"}')).toBeNull();
  });
});

describe('verifyClaim', () => {
  function seededCtx(db: ReturnType<typeof testDb>, chatText: string | null): AnswerCtx {
    createKb(db, { namespace: 'KbV', name: 'Weryfikacyjna' });
    db.prepare("UPDATE kb_registry SET status = 'active' WHERE namespace = 'KbV'").run();
    replaceForDocument(db, 'KbV', 'DOC_v1', [
      {
        id: 'CHUNK_v1_001',
        title: 'Karta oprawy',
        content: 'Strumień świetlny oprawy HighBay wynosi 21000 lumenów przy mocy 150 W.',
      },
    ]);
    return {
      db,
      llm:
        chatText === null
          ? null
          : { chat: async () => ({ text: chatText }), embed: async (t: string[]) => t.map(() => [1, 0]) },
      openspg: null,
      log: { warn: () => undefined },
    };
  }

  it('teza z pokryciem → werdykt LLM z cytowaniami', async () => {
    const db = testDb();
    const ctx = seededCtx(
      db,
      '{"status":"supported","explanation":"Źródło [1] podaje dokładnie 21000 lm.","evidenceNs":[1]}',
    );
    const res = await verifyClaim(ctx, {
      claim: 'Oprawa HighBay ma strumień 21000 lumenów',
      allowedNamespaces: ['KbV'],
      source: 'mcp',
    });
    expect(res.status).toBe('supported');
    expect(res.citations[0]?.id).toBe('CHUNK_v1_001');
    expect(res.gapRecorded).toBe(false);
  });

  it('brak dowodów → insufficient BEZ wywołania LLM + luka wiedzy', async () => {
    const db = testDb();
    let chatCalls = 0;
    const ctx = seededCtx(db, '{"status":"supported"}');
    ctx.llm = {
      chat: async () => {
        chatCalls++;
        return { text: '' };
      },
      embed: async (t: string[]) => t.map(() => [1, 0]),
    };
    const res = await verifyClaim(ctx, {
      claim: 'Zupełnie niezwiązana teza o gotowaniu bigosu staropolskiego',
      allowedNamespaces: ['KbV'],
      source: 'mcp',
    });
    expect(res.status).toBe('insufficient');
    expect(res.gapRecorded).toBe(true);
    expect(chatCalls).toBe(0);
    const gaps = (db.prepare('SELECT COUNT(*) AS n FROM learning_gaps').get() as { n: number }).n;
    expect(gaps).toBe(1);
  });

  it('nieparsowalny werdykt LLM → insufficient bez luki (defensywnie)', async () => {
    const db = testDb();
    const ctx = seededCtx(db, 'przepraszam, nie mogę');
    const res = await verifyClaim(ctx, {
      claim: 'Oprawa HighBay ma strumień 21000 lumenów',
      allowedNamespaces: ['KbV'],
      source: 'mcp',
    });
    expect(res.status).toBe('insufficient');
    expect(res.gapRecorded).toBe(false);
  });
});
