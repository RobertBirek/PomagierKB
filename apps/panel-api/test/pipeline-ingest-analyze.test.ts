import { describe, it, expect } from 'vitest';
import type { KbRow } from '@pomagierkb/shared/db';
import type { LlmClient, ChatResult } from '@pomagierkb/shared/llm';
import { analyzeContent, heuristicAnalyze } from '../src/pipeline/analyze.js';

/**
 * Etap 4 — analyze: chat_llm structured output z walidacją (kbNamespace tylko
 * active z rejestru, documentCategory z config_json.documentTypes), fallback
 * heurystyczny przy padniętym LLM. Wynik ZAWSZE z provider + warnings[].
 */

function kbRow(overrides: Partial<KbRow>): KbRow {
  return {
    namespace: 'LightingDocs',
    name: 'Dokumentacja oświetleniowa',
    description: 'Normy i dobór opraw',
    project_id: 1,
    status: 'active',
    vector_model_id: 'x@model',
    embedding_model: 'model',
    schema_version: 1,
    schema_hash: 'h',
    job_prefix: 'LD',
    routing_keywords: '[]',
    is_default: 0,
    dirty: 0,
    config_json: '{}',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const REGISTRY: KbRow[] = [
  kbRow({
    namespace: 'LightingDocs',
    routing_keywords: '["oświetlenie","oprawa","luks"]',
    config_json: JSON.stringify({ documentTypes: [{ name: 'norma' }, { name: 'poradnik' }] }),
  }),
  kbRow({ namespace: 'OfficeDocs', name: 'Biuro', routing_keywords: '["faktura","urlop"]', is_default: 1 }),
  kbRow({ namespace: 'OldDocs', status: 'archived' }),
];

const CONTENT =
  '# Dobór opraw LED\n\nOświetlenie hali magazynowej wymaga natężenia minimum 200 luks. ' +
  'Oprawa liniowa LED zapewnia równomierny rozsył światła.';

function mockLlm(result: ChatResult | Error): LlmClient {
  return {
    chat: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
    embed: async () => [],
  };
}

describe('fallback heurystyczny', () => {
  it('LLM rzuca → provider heuristic + warning, routing po routing_keywords', async () => {
    const res = await analyzeContent(
      { content: CONTENT, registry: REGISTRY },
      { llm: mockLlm(new Error('timeout')) },
    );
    expect(res.provider).toBe('heuristic');
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(res.warnings.join(' ')).toContain('heurystyczna');
    expect(res.kbNamespace).toBe('LightingDocs'); // match 'oświetlenie'
    expect(res.title).toBe('Dobór opraw LED'); // pierwszy H1
    expect(res.language).toBe('pl');
    expect(res.summary.length).toBeLessThanOrEqual(400);
    expect(res.tags.length).toBeGreaterThan(0);
  });

  it('brak klienta LLM → heurystyka z warningiem o braku konfiguracji', async () => {
    const res = await analyzeContent({ content: CONTENT, registry: REGISTRY }, { llm: null });
    expect(res.provider).toBe('heuristic');
    expect(res.warnings.join(' ')).toContain('niedostępny');
  });

  it('bez matcha keywords → default KB (is_default); bez aktywnych baz → null + warning', () => {
    const noMatch = heuristicAnalyze({ content: 'Zupełnie inny temat bez słów kluczowych.', registry: REGISTRY });
    expect(noMatch.kbNamespace).toBe('OfficeDocs'); // is_default=1

    const empty = heuristicAnalyze({ content: CONTENT, registry: [kbRow({ status: 'archived' })] });
    expect(empty.kbNamespace).toBeNull();
    expect(empty.warnings.join(' ')).toContain('brak aktywnej bazy');
  });

  it('tagi heurystyczne bez stopwords PL', () => {
    const res = heuristicAnalyze({
      content: 'Oprawa oprawa oprawa. Które które które. Oraz oraz oraz. Fotometria fotometria.',
      registry: REGISTRY,
    });
    expect(res.tags).toContain('oprawa');
    expect(res.tags).not.toContain('które');
    expect(res.tags).not.toContain('oraz');
    expect(res.tags.length).toBeLessThanOrEqual(8);
  });
});

describe('ścieżka chat_llm (structured output)', () => {
  it('poprawny JSON modelu → provider chat_llm, kategoria z documentTypes', async () => {
    const parsed = {
      title: 'Dobór opraw LED do hali',
      tags: ['oświetlenie', 'LED'],
      kbNamespace: 'LightingDocs',
      documentCategory: 'poradnik',
      summary: 'Poradnik doboru opraw LED do hal magazynowych.',
      language: 'pl',
    };
    const res = await analyzeContent(
      { content: CONTENT, registry: REGISTRY },
      { llm: mockLlm({ text: JSON.stringify(parsed), parsed }) },
    );
    expect(res.provider).toBe('chat_llm');
    expect(res.kbNamespace).toBe('LightingDocs');
    expect(res.documentCategory).toBe('poradnik');
    expect(res.warnings).toHaveLength(0);
  });

  it('kbNamespace spoza aktywnych → warning + routing heurystyczny (nadal chat_llm)', async () => {
    const parsed = {
      title: 'Tytuł',
      tags: [],
      kbNamespace: 'OldDocs', // archived — niedozwolony
      summary: 'Streszczenie dokumentu.',
      language: 'pl',
    };
    const res = await analyzeContent(
      { content: CONTENT, registry: REGISTRY },
      { llm: mockLlm({ text: '', parsed }) },
    );
    expect(res.provider).toBe('chat_llm');
    expect(res.kbNamespace).toBe('LightingDocs'); // heurystyka po keywords
    expect(res.warnings.join(' ')).toContain('spoza rejestru');
  });

  it('documentCategory spoza documentTypes bazy → pominięta z warningiem', async () => {
    const parsed = {
      title: 'Tytuł',
      tags: ['a'],
      kbNamespace: 'LightingDocs',
      documentCategory: 'wymyślona',
      summary: 'Streszczenie.',
      language: 'pl',
    };
    const res = await analyzeContent(
      { content: CONTENT, registry: REGISTRY },
      { llm: mockLlm({ text: '', parsed }) },
    );
    expect(res.documentCategory).toBeNull();
    expect(res.warnings.join(' ')).toContain('spoza konfiguracji');
  });

  it('niesparsowalna odpowiedź (brak parsed) → fallback heurystyczny', async () => {
    const res = await analyzeContent(
      { content: CONTENT, registry: REGISTRY },
      { llm: mockLlm({ text: 'to nie jest json' }) },
    );
    expect(res.provider).toBe('heuristic');
    expect(res.warnings.join(' ')).toContain('niesparsowalny');
  });
});
