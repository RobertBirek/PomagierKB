import { describe, expect, it } from 'vitest';
import { kbAnswerTool, kbSearchTool } from '../src/tools/index.js';
import { makeCtx, mockLlm, seedKb, seedLightingChunks, testDb } from './helpers-tools.js';

/**
 * G12 (D8-03, D8-10): retrieval rozróżnia snippet_only / kb_dirty / embed_failed /
 * openspg_down, ale API oddawało wyłącznie boolean `degraded` — agent nie wiedział,
 * CO jest zdegradowane. Pole `degradedReasons` jest DODANE obok boola (jego kontrakt
 * musi zostać nienaruszony), a schematy wyjściowe są `additionalProperties:false`,
 * więc każde pole struktury musi być w nich zadeklarowane.
 */

interface ObjectSchema {
  additionalProperties?: boolean;
  properties: Record<string, { items?: { enum?: string[] } }>;
}

/**
 * Odpowiednik `additionalProperties:false` dla realnej struktury: klucz wyniku
 * spoza `properties` schematu wywróciłby walidację po stronie klienta MCP.
 */
function undeclaredKeys(schema: unknown, structured: unknown): string[] {
  const props = (schema as ObjectSchema).properties;
  return Object.keys(structured as Record<string, unknown>).filter((k) => !(k in props));
}

/** Wszystkie powody z typu DegradedReason (packages/shared/src/answer/retrieval.ts). */
const ALL_REASONS = ['openspg_down', 'openspg_no_hits', 'embed_failed', 'snippet_only', 'kb_dirty'];

describe('kb_search: degradedReasons w wyniku (D8-03/D8-10)', () => {
  it('bez OpenSPG zwraca powód openspg_down, a struktura mieści się w schemacie', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    seedLightingChunks(db);
    const ctx = makeCtx(db); // openspg: null

    const res = await kbSearchTool.handler(ctx, { query: 'maksymalne obciążenie szynoprzewodów' });
    const out = res.structured as { degraded: boolean; degradedReasons: string[] };
    expect(out.degraded).toBe(true); // kontrakt boola BEZ ZMIAN
    expect(out.degradedReasons).toContain('openspg_down');
    expect(undeclaredKeys(kbSearchTool.outputSchema, out)).toEqual([]);
    // także pozycje wyników (mają własne additionalProperties:false)
    const itemSchema = (kbSearchTool.outputSchema as { properties: { results: { items: ObjectSchema } } })
      .properties.results.items;
    for (const item of out['results' as keyof typeof out] as unknown as Record<string, unknown>[]) {
      expect(undeclaredKeys(itemSchema, item)).toEqual([]);
    }
  });

  it('outputSchema jest domknięty i zna WSZYSTKIE powody (w tym embed_failed)', () => {
    const schema = kbSearchTool.outputSchema as ObjectSchema;
    expect(schema.additionalProperties).toBe(false);
    // embed_failed realnie występuje (padł dostawca embeddingów przy zdrowym
    // OpenSPG) — brak w enumie wywracał walidację wyniku dokładnie wtedy, gdy
    // diagnostyka była najbardziej potrzebna.
    expect(schema.properties['degradedReasons']?.items?.enum).toEqual(expect.arrayContaining(ALL_REASONS));
    expect((schema.properties['results'] as unknown as { items: ObjectSchema }).items.additionalProperties).toBe(
      false,
    );
  });
});

describe('kb_answer: degradedReasons w wyniku (D8-03/D8-10)', () => {
  it('odpowiedź niesie powody degradacji, a struktura mieści się w schemacie', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    seedLightingChunks(db);
    const llm = mockLlm();
    const ctx = makeCtx(db, { llm: llm.llm });

    const res = await kbAnswerTool.handler(ctx, {
      question: 'Jakie jest maksymalne obciążenie szynoprzewodów trójfazowych?',
    });
    expect(res.isError).toBeUndefined();
    const out = res.structured as { degraded: boolean; degradedReasons: string[] };
    expect(typeof out.degraded).toBe('boolean');
    expect(out.degradedReasons).toContain('openspg_down');
    expect(undeclaredKeys(kbAnswerTool.outputSchema, out)).toEqual([]);
  });

  it('outputSchema jest domknięty (additionalProperties:false) i zna degradedReasons', () => {
    const schema = kbAnswerTool.outputSchema as ObjectSchema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties['degraded']).toBeDefined();
    expect(schema.properties['degradedReasons']?.items?.enum).toEqual(expect.arrayContaining(ALL_REASONS));
  });
});
