import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEGRADED_REASONS, RETRIEVAL_SOURCES, clearAnswerCache } from '@pomagierkb/shared/answer';
import { AppError } from '@pomagierkb/shared/errors';
import {
  createDraft,
  finishExportRun,
  markDirty,
  promoteDraft,
  recordAnswer,
  rejectDraft,
  replaceForDocument,
  setProvisioned,
  startExportRun,
  withdrawDraft,
} from '@pomagierkb/shared/db';
import type { Db } from '@pomagierkb/shared/db';
import { OpenSpgClient } from '@pomagierkb/shared/openspg';
import { jsonResponse, loginResponse, makeMockFetch } from '../../../packages/shared/test/helpers/openspg-mock.js';
import { createMcpPair, executeToolCall } from '../src/mcp.js';
import {
  ALL_TOOLS,
  kbAnswerTool,
  kbClaimVerifyTool,
  kbDraftStatusTool,
  kbEntityGetTool,
  kbFeedbackTool,
  kbGetSourceTool,
  kbGraphNeighborsTool,
  kbListDocumentsTool,
  kbListTool,
  kbSearchTool,
  kbSubmitDraftTool,
} from '../src/tools/index.js';
import type { ToolErrorCode } from '../src/tools/messages.js';
import type { KbTool, ToolCtx, ToolLlm, ToolResult } from '../src/tools/types.js';
import {
  GRAPH_CHUNKS,
  assertMatchesOutputSchema,
  makeCtx,
  mockLlm,
  seedGraph,
  seedKb,
  seedLightingChunks,
  testDb,
} from './helpers-tools.js';
import type { MakeCtxOpts } from './helpers-tools.js';

/**
 * KONTRAKT outputSchema KAŻDEGO narzędzia MCP — dla wyników SUKCESU ta sama walidacja, którą
 * robi klient (SDK kompiluje outputSchema ajv i odrzuca odpowiedź, gdy structuredContent nie
 * pasuje); jeden fixture przechodzi dodatkowo przez PRAWDZIWY Client SDK na InMemoryTransport
 * (blok „prawdziwy klient SDK" niżej), żeby to twierdzenie nie było tylko komentarzem.
 *
 * Dlaczego osobny test, skoro tools-*.test.ts wołają assertMatchesOutputSchema:
 * dryf z 2026-09-10 (docId/sectionHeading w cytowaniach kb_answer) przeszedł przez
 * tamte testy, bo ich fixture'y nie emitowały pól opcjonalnych — walidacja MINIMALNEGO
 * wyniku nic nie mówi o polu, którego w tym wyniku nie ma. Tu każde narzędzie dostaje
 * fixture'y, po których WSZYSTKIE zadeklarowane ścieżki schematu (także opcjonalne,
 * także elementy tablic) i WSZYSTKIE wartości enum są realnie wyemitowane — i dopiero
 * wtedy walidowane ajv.
 *
 * Wynik handlera jest najpierw sprowadzany do postaci DRUTOWEJ (JSON.parse(JSON.stringify)):
 * klucz o wartości `undefined` nie istnieje dla klienta, więc nie może ani „domknąć"
 * pokrycia, ani wywrócić additionalProperties:false.
 *
 * Trzy osobne bramki na każde narzędzie:
 *  1) ajv per wynik (typ/enum/additionalProperties — jak w kliencie),
 *  2) pokrycie ścieżek: unia ścieżek wyemitowanych ⊇ ścieżki schematu ORAZ żadna
 *     ścieżka wyemitowana nie jest niezadeklarowana — to łapie wyciek pola także w
 *     schematach OTWARTYCH (bez additionalProperties:false), które ajv by przepuścił,
 *  3) pokrycie enum: każda wartość zadeklarowana w `enum` została zaobserwowana — usunięcie
 *     wartości ze schematu (dryf D8-03/D8-10: 'embed_failed' w degradedReasons) wywraca
 *     bramkę 1 na fixture, który ją emituje, a brak fixture'u wywraca bramkę 3.
 *     Enumy degradedReasons/source są w schematach ROZWIJANE z runtime'owych list
 *     DEGRADED_REASONS/RETRIEVAL_SOURCES (packages/shared; typy są ich pochodną), a ENUM_VALUES
 *     niżej importuje TE SAME listy — więc nowa wartość dopisana w retrievalu jest w schemacie
 *     od razu, a bramka 3 jest czerwona, dopóki fixture jej nie wyemituje. Bramka typów
 *     (`satisfies Record<DegradedReason, true>`) NIE wchodzi w grę: tsconfig workspace'u
 *     obejmuje tylko src/, vitest nie typechekuje — test/ nigdy nie przechodzi przez tsc.
 *
 * Ścieżka BŁĘDU (isError:true) ma własny kontrakt: TOOL_ERROR_SCHEMA + ERROR_CASES per narzędzie
 * (§7.4: structured = {errorCode} [+errorId z shellu przy wyjątku, +problems z walidacji
 * wejścia w shellu]). Shell (mcp.ts toCallToolResult) przenosi ten obiekt do `_meta`, a NIE do
 * structuredContent: Client SDK 1.30 waliduje structuredContent ZAWSZE, gdy jest obecny (isError
 * zwalnia tylko z obowiązku jego posiadania), więc {errorCode} w structuredContent zamieniał każdy
 * błąd narzędzia w McpError -32602 u klienta (2026-09-10). Blok „prawdziwy klient SDK" pilnuje,
 * że błąd dociera do Client.callTool jako wynik isError z `_meta.errorCode`.
 */

// ── Ścieżki schematu i wyniku (tablice jako `[]`, obiekt bez `properties` = liść) ──

interface Schema {
  properties?: Record<string, Schema>;
  items?: Schema;
  required?: string[];
  enum?: string[];
}

interface Coverage {
  emitted: Set<string>;
  undeclared: Set<string>;
  /** Wartości liści z `enum` zaobserwowane pod daną ścieżką. */
  enumValues: Map<string, Set<string>>;
}

function joinPath(prefix: string, key: string): string {
  return prefix === '' ? key : `${prefix}.${key}`;
}

function schemaPaths(schema: Schema, prefix = ''): string[] {
  const out: string[] = [];
  if (schema.properties !== undefined) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      const path = joinPath(prefix, key);
      out.push(path, ...schemaPaths(sub, path));
    }
  } else if (schema.items !== undefined) {
    const path = `${prefix}[]`;
    out.push(path, ...schemaPaths(schema.items, path));
  }
  return out;
}

/**
 * Ścieżki spoza `required` — transytywnie: potomkowie pola opcjonalnego też są opcjonalni,
 * element tablicy (`[]`) dziedziczy opcjonalność po tablicy.
 */
function optionalSchemaPaths(schema: Schema, prefix = '', parentOptional = false): string[] {
  const out: string[] = [];
  if (schema.properties !== undefined) {
    const required = new Set(schema.required ?? []);
    for (const [key, sub] of Object.entries(schema.properties)) {
      const path = joinPath(prefix, key);
      const optional = parentOptional || !required.has(key);
      if (optional) out.push(path);
      out.push(...optionalSchemaPaths(sub, path, optional));
    }
  } else if (schema.items !== undefined) {
    const path = `${prefix}[]`;
    if (parentOptional) out.push(path);
    out.push(...optionalSchemaPaths(schema.items, path, parentOptional));
  }
  return out;
}

/** Ścieżka → zadeklarowane wartości `enum` (tylko liście). */
function schemaEnums(schema: Schema, prefix = ''): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (schema.enum !== undefined) out[prefix] = [...schema.enum].sort();
  if (schema.properties !== undefined) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      Object.assign(out, schemaEnums(sub, joinPath(prefix, key)));
    }
  } else if (schema.items !== undefined) {
    Object.assign(out, schemaEnums(schema.items, `${prefix}[]`));
  }
  return out;
}

function collectPaths(value: unknown, schema: Schema, prefix: string, into: Coverage): void {
  if (schema.enum !== undefined && typeof value === 'string') {
    const seen = into.enumValues.get(prefix) ?? new Set<string>();
    seen.add(value);
    into.enumValues.set(prefix, seen);
  }
  if (schema.properties !== undefined) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    for (const [key, v] of Object.entries(value)) {
      const path = joinPath(prefix, key);
      const sub = schema.properties[key];
      if (sub === undefined) {
        into.undeclared.add(path);
        continue;
      }
      into.emitted.add(path);
      collectPaths(v, sub, path, into);
    }
  } else if (schema.items !== undefined) {
    if (!Array.isArray(value)) return;
    const path = `${prefix}[]`;
    for (const el of value) {
      into.emitted.add(path);
      collectPaths(el, schema.items, path, into);
    }
  }
}

function coverage(): Coverage {
  return { emitted: new Set(), undeclared: new Set(), enumValues: new Map() };
}

/** Postać drutowa wyniku — to (i tylko to) widzi klient SDK po deserializacji JSON-RPC. */
function toWire(structured: unknown): unknown {
  return JSON.parse(JSON.stringify(structured)) as unknown;
}

/** Wynik SUKCESU: bez isError, w postaci drutowej zgodny z ajv, ścieżki i enumy dopisane do pokrycia. */
function pass<T>(tool: KbTool, cov: Coverage, res: ToolResult): T {
  expect(res.isError, `${tool.name}: fixture zwrócił błąd: ${res.text}`).toBeUndefined();
  const wire = toWire(res.structured);
  assertMatchesOutputSchema(tool, wire);
  collectPaths(wire, tool.outputSchema as Schema, '', cov);
  return wire as T;
}

// ── Ścieżka błędu (§7.4: isError + structured {errorCode}) ──

/**
 * Kody błędów narzędzi — lista jawna (ToolErrorCode w src/tools/messages.ts nie ma postaci
 * runtime). `satisfies` pilnuje zgodności tylko w IDE (test/ nie przechodzi przez tsc);
 * bramką runtime jest TOOL_ERROR_SCHEMA: kod spoza listy wyemitowany przez fixture = czerwony.
 */
const TOOL_ERROR_CODES = Object.keys({
  namespace_not_allowed: true,
  upstream_unavailable: true,
  rate_limited: true,
  validation: true,
  forbidden: true,
  internal: true,
} satisfies Record<ToolErrorCode, true>);

/**
 * Kontrakt `structured` wyniku błędnego — WSPÓLNY dla wszystkich narzędzi (nie jest częścią
 * żadnego outputSchema, patrz nagłówek). errorId dopisuje shell przy wyjątku handlera
 * (mcp.ts executeToolCall), problems — shell przy odrzuceniu wejścia przez validateInput.
 */
const TOOL_ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['errorCode'],
  properties: {
    errorCode: { type: 'string', enum: TOOL_ERROR_CODES },
    errorId: { type: 'string' },
    problems: { type: 'array', items: { type: 'string' } },
  },
};

/** Wynik BŁĘDU: isError:true, tekst PL, structured po drucie zgodny z TOOL_ERROR_SCHEMA i z oczekiwanym kodem. */
function fail(toolName: string, cov: Coverage, res: ToolResult, code: ToolErrorCode): Record<string, unknown> {
  expect(res.isError, `${toolName}: fixture błędu zwrócił sukces`).toBe(true);
  expect(typeof res.text === 'string' && res.text.length > 0, `${toolName}: błąd bez tekstu`).toBe(true);
  const wire = toWire(res.structured) as Record<string, unknown>;
  assertMatchesOutputSchema({ name: `${toolName} (błąd)`, outputSchema: TOOL_ERROR_SCHEMA }, wire);
  expect(wire['errorCode'], `${toolName}: errorCode`).toBe(code);
  collectPaths(wire, TOOL_ERROR_SCHEMA as Schema, '', cov);
  return wire;
}

/**
 * Pola OPCJONALNE (spoza `required`) każdego narzędzia — lista jawna, nie wyliczona ze
 * schematu: gdyby ktoś usunął pole i ze schematu, i z handlera, pokrycie liczone ze
 * schematu nadal byłoby zielone, a tu lista musi zostać świadomie zaktualizowana.
 * assertFullCoverage wymaga RÓWNOŚCI ze ścieżkami spoza `required` w schemacie —
 * lista nie może być ani za krótka, ani zawierać ścieżek spoza schematu.
 */
const OPTIONAL_PATHS: Record<string, string[]> = {
  kb_search: [
    'results[].title',
    'results[].sourceRef',
    'results[].kbName',
    'results[].label',
    'tookMs',
    'degradedReasons',
    'degradedReasons[]',
    'matchedRouting',
    'matchedRouting[]',
  ],
  kb_answer: [
    'citations[].title',
    'citations[].snippet',
    'citations[].sourceRef',
    'citations[].docId',
    'citations[].sectionHeading',
    'claims',
    'claims[]',
    'claims[].claim',
    'claims[].evidenceNs',
    'claims[].evidenceNs[]',
    'model',
    'degraded',
    'degradedReasons',
    'degradedReasons[]',
    'noAnswer',
    'warnings',
    'warnings[]',
  ],
  kb_list: ['kbs[].projectId', 'kbs[].description', 'kbs[].documentCount'],
  kb_get_source: ['docId', 'title', 'sourceRef', 'nextChunkId', 'prevChunkId', 'chunkCount'],
  kb_list_documents: ['documents[].title', 'documents[].sourceRef', 'documents[].updatedAt'],
  kb_draft_status: [
    'drafts[].namespace',
    'drafts[].createdAt',
    'drafts[].decidedAt',
    'drafts[].promotedAt',
    'drafts[].rejectReason',
    'counts',
    'counts.pending',
    'counts.promoted',
    'counts.rejected',
    'counts.withdrawn',
  ],
  // wszystkie pola wymagane; `properties` to wolna mapa string→string (sprawdzana w teście)
  kb_entity_get: [],
  kb_graph_neighbors: ['nodes[].title', 'nodes[].kind'],
  kb_claim_verify: ['citations[].title', 'citations[].snippet', 'citations[].sourceRef', 'degraded', 'gapRecorded'],
  kb_submit_draft: ['duplicate'],
  kb_feedback: ['gapUpdated'],
};

/**
 * Wartości `enum` (ścieżka → wartości) narzędzi, które je deklarują — wymagana RÓWNOŚĆ ze
 * schematem; każda wartość musi być realnie wyemitowana przez fixture. Dryf D8-03/D8-10 (brak
 * 'embed_failed' w enum degradedReasons) był niewidoczny dla walidacji wyniku minimalnego —
 * tu brak fixture'u = czerwony test.
 *
 * degradedReasons/source NIE są listą lokalną, tylko RUNTIME listami z packages/shared
 * (DEGRADED_REASONS/RETRIEVAL_SOURCES) — tymi samymi, z których schematy kb_search/kb_answer
 * rozwijają `enum`. Lokalna kopia z `satisfies Record<DegradedReason, true>` byłaby martwa:
 * test/ nie przechodzi przez tsc (tsconfig: include ['src']), więc nowa wartość typu nie
 * wywraca niczego. Z listą runtime nowa wartość = brak fixture'u = czerwona bramka 3.
 */
const ENUM_VALUES: Record<string, Record<string, string[]>> = {
  kb_search: {
    'results[].source': [...RETRIEVAL_SOURCES],
    'degradedReasons[]': [...DEGRADED_REASONS],
  },
  kb_answer: { 'degradedReasons[]': [...DEGRADED_REASONS] },
  kb_draft_status: { 'drafts[].status': ['pending', 'promoted', 'rejected', 'withdrawn'] },
  kb_graph_neighbors: {
    'nodes[].kind': ['chunk', 'document', 'topic'],
    'edges[].rel': ['in_document', 'about_topic'],
  },
  kb_claim_verify: { status: ['supported', 'contradicted', 'insufficient'] },
};

function sortedEnums(enums: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(enums)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, values]) => [path, [...values].sort()]),
  );
}

function assertFullCoverage(tool: KbTool, cov: Coverage): void {
  const schema = tool.outputSchema as Schema;
  const declared = schemaPaths(schema);
  const missing = declared.filter((p) => !cov.emitted.has(p));
  expect(missing, `${tool.name}: ścieżki schematu, których żaden fixture nie wyemitował`).toEqual([]);
  expect([...cov.undeclared], `${tool.name}: ścieżki wyemitowane bez deklaracji w outputSchema`).toEqual([]);

  const optional = OPTIONAL_PATHS[tool.name];
  expect(optional, `${tool.name}: brak wpisu w OPTIONAL_PATHS`).toBeDefined();
  expect([...(optional ?? [])].sort(), `${tool.name}: OPTIONAL_PATHS ≠ ścieżki spoza required w schemacie`).toEqual(
    optionalSchemaPaths(schema).sort(),
  );
  for (const path of optional ?? []) {
    expect(cov.emitted.has(path), `${tool.name}: pole opcjonalne ${path} nie zostało wyemitowane`).toBe(true);
  }

  const enums = ENUM_VALUES[tool.name] ?? {};
  expect(sortedEnums(enums), `${tool.name}: ENUM_VALUES ≠ enumy zadeklarowane w schemacie`).toEqual(
    sortedEnums(schemaEnums(schema)),
  );
  for (const [path, values] of Object.entries(enums)) {
    const seen = cov.enumValues.get(path) ?? new Set<string>();
    const unseen = values.filter((v) => !seen.has(v));
    expect(unseen, `${tool.name}: wartości enum ${path}, których żaden fixture nie wyemitował`).toEqual([]);
  }
}

// ── Wspólne fixture'y ──

const NS = 'LightingDocs';

/** Chunki LightingDocs z pełnymi metadanymi (tytuł, sekcja, źródło) pod dokumentem DOC_ld000001. */
function seedRichDocument(db: Db): void {
  seedLightingChunks(db, { docId: 'DOC_ld000001', sectionHeadings: { CHUNK_ld000001_001: 'Obciążenie toru' } });
}

/** KB z zamrożonym modelem i projectId — warunek kanałów OpenSPG (text: projectId; vector: + embedding_model). */
function seedProvisionedKb(db: Db): void {
  seedKb(db, NS, { embeddingModel: 'text-embedding-3-small' });
  setProvisioned(db, NS, 1, 'inst@text-embedding-3-small', 'h');
}

/** Klient OpenSPG na mock fetch: login + search/text + search/vector (+ query/spgType). */
function mockOpenspg(routes: Record<string, (body: Record<string, unknown>) => unknown>): OpenSpgClient {
  const { impl } = makeMockFetch((path, init) => {
    if (path === '/v1/accounts/login') return loginResponse();
    const route = routes[path];
    if (route === undefined) return jsonResponse([]);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return jsonResponse(route(body));
  });
  return new OpenSpgClient({ baseUrl: 'http://openspg:8887', account: 'o', password: 'x', fetchImpl: impl });
}

/** OpenSPG zdrowy, ale bez trafień w obu kanałach (openspg_no_hits). */
function emptyOpenspg(): OpenSpgClient {
  return mockOpenspg({ '/public/v1/search/text': () => [], '/public/v1/search/vector': () => [] });
}

/** makeCtx zawsze daje openspg:null — kanały OpenSPG wymagają jawnego nadpisania. */
function withOpenspg(ctx: ToolCtx, openspg: OpenSpgClient): ToolCtx {
  return { ...ctx, openspg };
}

/** LLM, którego dostawca embeddingów padł (429) — kanał wektorowy pominięty (embed_failed), chat działa. */
function llmWithFailingEmbed(): ToolLlm {
  return {
    ...mockLlm().llm,
    async embed() {
      throw new Error('429');
    },
  };
}

const QUESTION = 'Maksymalne obciążenie szynoprzewodów przy montażu?';
const SEARCH_QUERY = 'maksymalne obciążenie szynoprzewodów';

// ── Przypadki kontraktu per narzędzie (klucz = nazwa z rejestru; it() generowane z tabeli) ──

interface ContractCase {
  title: string;
  run(cov: Coverage): Promise<void>;
}

const CONTRACT_CASES: Record<string, ContractCase> = {
  kb_search: {
    title: 'cztery źródła trafień, pięć powodów degradacji, routing i metadane wyniku',
    async run(cov) {
      // A: fallback_fts + openspg_down + kb_dirty + matchedRouting + title/sourceRef/kbName/label
      {
        const db = testDb();
        seedKb(db, NS);
        db.prepare('UPDATE kb_registry SET routing_keywords = ? WHERE namespace = ?').run(
          JSON.stringify(['szynoprzewod']),
          NS,
        );
        markDirty(db, NS);
        seedLightingChunks(db);
        interface SearchHit {
          id: string;
          source: string;
          title?: string;
          sourceRef?: string;
          kbName?: string;
          label?: string;
        }
        const out = pass<{
          results: SearchHit[];
          degraded: boolean;
          degradedReasons: string[];
          matchedRouting: string[];
          tookMs: number;
        }>(kbSearchTool, cov, await kbSearchTool.handler(makeCtx(db), { query: SEARCH_QUERY }));
        expect(out.results[0]).toMatchObject({
          id: 'CHUNK_ld000001_001',
          source: 'fallback_fts',
          title: 'Montaż szynoprzewodów',
          sourceRef: 'https://example.com/karta.pdf',
          kbName: 'Baza LightingDocs',
          label: 'LightingDocs.Chunk',
        });
        expect(out.degraded).toBe(true);
        expect(out.degradedReasons).toEqual(['openspg_down', 'kb_dirty']);
        expect(out.matchedRouting).toEqual([NS]);
        expect(Number.isInteger(out.tookMs)).toBe(true);
      }

      // B: openspg_vector + openspg_text, degraded:false, degradedReasons:[]
      {
        const db = testDb();
        seedProvisionedKb(db);
        seedLightingChunks(db);
        const openspg = mockOpenspg({
          '/public/v1/search/vector': () => [
            { docId: 'CHUNK_ld000001_001', score: 0.91, fields: { id: 'CHUNK_ld000001_001' } },
          ],
          '/public/v1/search/text': () => [
            {
              docId: 'CHUNK_ld000001_002',
              score: 1.2,
              fields: { title: '"Sterowanie DALI"', content: '"Magistrala DALI..."' },
            },
          ],
        });
        const ctx = withOpenspg(makeCtx(db, { llm: mockLlm().llm }), openspg);
        const out = pass<{ results: { id: string; source: string }[]; degraded: boolean; degradedReasons: string[] }>(
          kbSearchTool,
          cov,
          await kbSearchTool.handler(ctx, { query: SEARCH_QUERY, limit: 5 }),
        );
        expect(out.results.map((r) => r.source)).toEqual(['openspg_vector', 'openspg_text']);
        expect(out.degraded).toBe(false);
        expect(out.degradedReasons).toEqual([]);
      }

      // C: exact_match (token wersji) + snippet_only (DOC_ bez mirrora) + label ReferenceDocument
      {
        const db = testDb();
        seedProvisionedKb(db);
        replaceForDocument(db, NS, 'DOC_V3', [
          {
            id: 'CHUNK_V3_000',
            title: 'Zmiany w InsERT GT 1.84 SP1',
            sectionHeading: 'Zmiany',
            content: 'Lista zmian w wersji 1.84 SP1: obsługa kodów EAN.',
          },
        ]);
        const openspg = mockOpenspg({
          '/public/v1/search/text': () => [
            { docId: 'CHUNK_V3_000', score: 1.1, fields: {} },
            { docId: 'DOC_GHOST', score: 0.9, fields: { title: 'Ghost doc', contentPreview: 'tylko snippet' } },
          ],
        });
        const out = pass<{
          results: { id: string; source: string; label?: string; snippet: string }[];
          degradedReasons: string[];
        }>(
          kbSearchTool,
          cov,
          await kbSearchTool.handler(withOpenspg(makeCtx(db), openspg), {
            query: 'nowości w wersji 1.84 SP1',
            mode: 'text',
          }),
        );
        expect(out.results[0]).toMatchObject({
          id: 'CHUNK_V3_000',
          source: 'exact_match',
          label: 'LightingDocs.Chunk',
        });
        expect(out.results[1]).toMatchObject({
          id: 'DOC_GHOST',
          source: 'openspg_text',
          snippet: 'tylko snippet',
          label: 'LightingDocs.ReferenceDocument',
        });
        expect(out.degradedReasons).toEqual(['snippet_only']);
      }

      // D: embed_failed + openspg_no_hits (OpenSPG zdrowy, ale pusty; dostawca embeddingów padł)
      {
        const db = testDb();
        seedProvisionedKb(db);
        seedLightingChunks(db);
        const ctx = withOpenspg(makeCtx(db, { llm: llmWithFailingEmbed() }), emptyOpenspg());
        const out = pass<{ results: { source: string }[]; degraded: boolean; degradedReasons: string[] }>(
          kbSearchTool,
          cov,
          await kbSearchTool.handler(ctx, { query: SEARCH_QUERY }),
        );
        expect(out.degradedReasons).toEqual(['openspg_no_hits', 'embed_failed']);
        expect(out.degraded).toBe(true);
        expect(out.results[0]?.source).toBe('fallback_fts');
      }
    },
  },

  kb_answer: {
    title: 'cytowania z docId/sectionHeading, claims, model, warnings, odmowa, snippet_only z grafu, embed_failed',
    async run(cov) {
      // A: jedno wywołanie emituje KAŻDE pole opcjonalne (model z ChatResult, [7] → warning, kb_dirty)
      {
        const db = testDb();
        seedKb(db, NS);
        seedRichDocument(db);
        markDirty(db, NS);
        const base = mockLlm(
          'Na podstawie źródła [1] oraz [7] maksymalne obciążenie wynosi 16 A na fazę.\nCONFIDENCE: 0.8',
        );
        const llm: ToolLlm = {
          ...base.llm,
          async chat(req) {
            return { ...(await base.llm.chat(req)), model: 'mock-chat-1' };
          },
        };
        const out = pass<{
          citations: Record<string, unknown>[];
          claims: { claim: string; evidenceNs: number[] }[];
          model?: string;
          degraded: boolean;
          degradedReasons: string[];
          gapRecorded: boolean;
          noAnswer: boolean;
          warnings: string[];
        }>(
          kbAnswerTool,
          cov,
          await kbAnswerTool.handler(makeCtx(db, { llm }), { question: QUESTION, maxSources: 3, language: 'pl' }),
        );
        expect(out.citations).toHaveLength(1);
        expect(out.citations[0]).toEqual({
          n: 1,
          id: 'CHUNK_ld000001_001',
          namespace: NS,
          title: 'Montaż szynoprzewodów',
          snippet: expect.stringContaining('16 amperów'),
          sourceRef: 'https://example.com/karta.pdf',
          docId: 'DOC_ld000001',
          sectionHeading: 'Obciążenie toru',
        });
        expect(out.claims[0]?.evidenceNs).toEqual([1]);
        expect(out.model).toBe('mock-chat-1');
        expect(out.degraded).toBe(true);
        expect(out.degradedReasons).toEqual(['openspg_down', 'kb_dirty']);
        expect(out.noAnswer).toBe(false);
        expect(out.gapRecorded).toBe(false);
        expect(out.warnings.join(' ')).toContain('[7]');
      }

      // B: bramka odmowy — noAnswer:true, gapRecorded:true, `model` NIEOBECNY (nie null)
      {
        const db = testDb();
        seedKb(db, NS);
        seedRichDocument(db);
        const out = pass<{ noAnswer: boolean; gapRecorded: boolean; citations: unknown[]; confidence: number }>(
          kbAnswerTool,
          cov,
          await kbAnswerTool.handler(makeCtx(db, { llm: mockLlm().llm }), {
            question: 'Ile kosztuje bilet miesięczny w Krakowie?',
          }),
        );
        expect(out).toMatchObject({ noAnswer: true, gapRecorded: true, citations: [], confidence: 0 });
        expect('model' in out).toBe(false);
      }

      // C: docId/sectionHeading/sourceRef Z PÓL GRAFU (trafienie bez wiersza w mirrorze → snippet_only)
      {
        const db = testDb();
        seedProvisionedKb(db);
        seedRichDocument(db);
        const openspg = mockOpenspg({
          '/public/v1/search/text': () => [
            {
              docId: 'CHUNK_ld000001_009',
              score: 1.2,
              fields: {
                title: 'Widmo',
                content:
                  'Maksymalne obciążenie toru szynoprzewodu przy montażu. ' +
                  'Treść z grafu bez mirrora. '.repeat(14),
                sourceDocumentRefId: 'DOC_ghost',
                sectionHeading: 'Sekcja z grafu',
                sourceRef: 'https://example.com/ghost',
              },
            },
          ],
          '/public/v1/search/vector': () => [{ docId: '8', score: 0.85, fields: { id: 'CHUNK_ld000001_001' } }],
        });
        const llm = mockLlm('Wg [1] i [2] obciążenie wynosi 16 A.\nCONFIDENCE: 0.9').llm;
        const out = pass<{
          citations: Record<string, unknown>[];
          claims: { evidenceNs: number[] }[];
          degraded: boolean;
          degradedReasons: string[];
          warnings: string[];
        }>(
          kbAnswerTool,
          cov,
          await kbAnswerTool.handler(withOpenspg(makeCtx(db, { llm }), openspg), { question: QUESTION }),
        );
        expect(out.degraded).toBe(false);
        expect(out.degradedReasons).toEqual(['snippet_only']);
        expect(out.citations[1]).toMatchObject({
          n: 2,
          id: 'CHUNK_ld000001_009',
          title: 'Widmo',
          sourceRef: 'https://example.com/ghost',
          docId: 'DOC_ghost',
          sectionHeading: 'Sekcja z grafu',
        });
        expect(out.claims[0]?.evidenceNs).toEqual([1, 2]);
        expect(out.warnings.join(' ')).toContain('brak pełnej treści');
      }

      // D: embed_failed + openspg_no_hits — powody retrievalu przechodzą 1:1 do wyniku (D8-03/D8-10:
      // brak którejś wartości w enum wywracał odpowiedź dokładnie przy padniętym dostawcy embeddingów)
      {
        // C było cache'owalne (niezdegradowane, pewne) i ma ten sam klucz — trafienie ukryłoby degradację
        clearAnswerCache();
        const db = testDb();
        seedProvisionedKb(db);
        seedRichDocument(db);
        const ctx = withOpenspg(makeCtx(db, { llm: llmWithFailingEmbed() }), emptyOpenspg());
        const out = pass<{ noAnswer: boolean; degraded: boolean; degradedReasons: string[]; citations: unknown[] }>(
          kbAnswerTool,
          cov,
          await kbAnswerTool.handler(ctx, { question: QUESTION }),
        );
        expect(out.noAnswer).toBe(false);
        expect(out.citations.length).toBeGreaterThan(0); // odpowiedź z mirrora FTS, nie odmowa
        expect(out.degraded).toBe(true);
        expect(out.degradedReasons).toEqual(['openspg_no_hits', 'embed_failed']);
      }
    },
  },

  kb_list: {
    title: 'projectId, description i documentCount z ostatniego udanego eksportu; wpis minimalny obok',
    async run(cov) {
      const db = testDb();
      seedKb(db, 'AlphaDocs'); // description 'Testowa baza AlphaDocs' (niepusta → emitowana)
      setProvisioned(db, 'AlphaDocs', 42, 'inst@text-embedding-3-small', 'sha-x');
      const run = startExportRun(db, 'AlphaDocs');
      finishExportRun(db, run.id, 'success', { docCount: 3, chunkCount: 9 });
      seedKb(db, 'BetaDocs');
      db.prepare("UPDATE kb_registry SET description = '' WHERE namespace = 'BetaDocs'").run();

      const out = pass<{ kbs: Record<string, unknown>[] }>(kbListTool, cov, await kbListTool.handler(makeCtx(db), {}));
      expect(out.kbs).toEqual([
        {
          namespace: 'AlphaDocs',
          name: 'Baza AlphaDocs',
          status: 'active',
          projectId: 42,
          description: 'Testowa baza AlphaDocs',
          documentCount: 3,
        },
        { namespace: 'BetaDocs', name: 'Baza BetaDocs', status: 'active' },
      ]);
    },
  },

  kb_get_source: {
    title: 'CHUNK_* z sąsiadami prev/next, DOC_* z truncated+nextChunkId, wariant bez pól opcjonalnych',
    async run(cov) {
      const db = testDb();
      seedKb(db, NS);
      const ctx = makeCtx(db);
      const src = 'https://example.com/dok.pdf';
      replaceForDocument(db, NS, 'DOC_x1', [
        { id: 'CHUNK_x1_001', title: 'Dok', sectionHeading: 'Wstęp', content: 'Pierwsza sekcja.', sourceRef: src },
        {
          id: 'CHUNK_x1_002',
          title: 'Dok',
          sectionHeading: 'Montaż',
          content: 'Druga sekcja o montażu.',
          sourceRef: src,
        },
        { id: 'CHUNK_x1_003', title: 'Dok', content: 'Trzecia sekcja.', sourceRef: src },
      ]);
      replaceForDocument(db, NS, 'DOC_x2', [
        { id: 'CHUNK_x2_001', title: 'Dok2', sectionHeading: 'A', content: 'a'.repeat(800), sourceRef: src },
        { id: 'CHUNK_x2_002', title: 'Dok2', sectionHeading: 'B', content: 'b'.repeat(800), sourceRef: src },
      ]);
      replaceForDocument(db, NS, 'DOC_min', [{ id: 'CHUNK_min_abc', content: 'Sam tekst.' }]);

      // A: środkowy chunk → wszystkie 10 pól naraz
      const chunk = pass<Record<string, unknown>>(
        kbGetSourceTool,
        cov,
        await kbGetSourceTool.handler(ctx, { id: 'CHUNK_x1_002' }),
      );
      expect(chunk).toEqual({
        id: 'CHUNK_x1_002',
        docId: 'DOC_x1',
        namespace: NS,
        content: 'Druga sekcja o montażu.',
        truncated: false,
        chunkCount: 3,
        title: 'Dok',
        sourceRef: src,
        prevChunkId: 'CHUNK_x1_001',
        nextChunkId: 'CHUNK_x1_003',
      });

      // B: dokument przycięty maxChars → truncated:true + nextChunkId (gałąź DOC_ nigdy nie emituje prevChunkId)
      const doc = pass<Record<string, unknown>>(
        kbGetSourceTool,
        cov,
        await kbGetSourceTool.handler(ctx, { id: 'DOC_x2', maxChars: 1000 }),
      );
      expect(doc).toMatchObject({
        id: 'DOC_x2',
        truncated: true,
        nextChunkId: 'CHUNK_x2_002',
        chunkCount: 2,
        title: 'Dok2',
        sourceRef: src,
      });
      expect('prevChunkId' in doc).toBe(false);

      // C: bez tytułu/źródła/sufiksu _NNN → pola opcjonalne POMINIĘTE, nie null
      const minimal = pass<Record<string, unknown>>(
        kbGetSourceTool,
        cov,
        await kbGetSourceTool.handler(ctx, { id: 'CHUNK_min_abc' }),
      );
      expect(Object.keys(minimal).sort()).toEqual(['chunkCount', 'content', 'docId', 'id', 'namespace', 'truncated']);
    },
  },

  kb_list_documents: {
    title: 'dokument z tytułem i źródłem obok dokumentu bez metadanych',
    async run(cov) {
      const db = testDb();
      seedKb(db, NS);
      const ctx = makeCtx(db);
      seedLightingChunks(db); // doc1: title + sourceRef
      replaceForDocument(db, NS, 'DOC_bare', [{ id: 'CHUNK_bare_001', content: 'Bez tytułu i źródła.' }]);

      const out = pass<{ documents: Record<string, unknown>[]; total: number }>(
        kbListDocumentsTool,
        cov,
        await kbListDocumentsTool.handler(ctx, { namespace: NS, q: '', limit: 50, offset: 0 }),
      );
      expect(out.total).toBe(2);
      expect(out.documents[0]).toEqual({
        docId: 'doc1',
        chunks: 2,
        title: 'Montaż szynoprzewodów',
        sourceRef: 'https://example.com/karta.pdf',
        updatedAt: expect.any(String),
      });
      expect(out.documents[1]).toEqual({ docId: 'DOC_bare', chunks: 1, updatedAt: expect.any(String) });
    },
  },

  kb_draft_status: {
    title: 'pending/promoted/rejected(+powód)/withdrawn z licznikami oraz pojedynczy draft',
    async run(cov) {
      const db = testDb();
      seedKb(db, NS);
      const ctx = makeCtx(db);
      const mk = (title: string) =>
        createDraft(db, {
          title,
          content: `Treść testowa draftu ${title}`,
          sourceType: 'mcp',
          namespace: NS,
          submittedByKey: ctx.keyRow.id,
        });
      const pending = mk('pending');
      const promoted = promoteDraft(db, mk('promoted').id, 'op');
      const rejected = rejectDraft(db, mk('rejected').id, 'op', 'za krótkie');
      const rejectedNoReason = rejectDraft(db, mk('rejected2').id, 'op');
      const withdrawn = withdrawDraft(db, promoteDraft(db, mk('withdrawn').id, 'op').id, 'op');

      const list = pass<{ drafts: Record<string, unknown>[]; counts: Record<string, number> }>(
        kbDraftStatusTool,
        cov,
        await kbDraftStatusTool.handler(ctx, {}),
      );
      expect(list.counts).toEqual({ pending: 1, promoted: 1, rejected: 2, withdrawn: 1 });
      const byId = new Map(list.drafts.map((d) => [d['draftId'], d]));
      expect(byId.get(pending.id)).toEqual({
        draftId: pending.id,
        status: 'pending',
        title: 'pending',
        namespace: NS,
        createdAt: expect.any(String),
      });
      expect(byId.get(promoted.id)).toMatchObject({
        status: 'promoted',
        decidedAt: expect.any(String),
        promotedAt: expect.any(String),
      });
      expect(byId.get(rejected.id)).toMatchObject({
        status: 'rejected',
        decidedAt: expect.any(String),
        rejectReason: 'za krótkie',
      });
      expect('rejectReason' in (byId.get(rejectedNoReason.id) ?? {})).toBe(false);
      expect(byId.get(withdrawn.id)).toMatchObject({
        status: 'withdrawn',
        decidedAt: expect.any(String),
        promotedAt: expect.any(String),
      });

      // pojedynczy draft: `counts` nieobecne (dozwolone — nie jest wymagane)
      const one = pass<{ drafts: unknown[]; counts?: unknown }>(
        kbDraftStatusTool,
        cov,
        await kbDraftStatusTool.handler(ctx, { draftId: rejected.id }),
      );
      expect(one.drafts).toHaveLength(1);
      expect('counts' in one).toBe(false);
    },
  },

  kb_entity_get: {
    title: 'fallback z mirrora (chunk z sekcją i źródłem, dokument z chunkCount) oraz primary z grafu',
    async run(cov) {
      const db = testDb();
      seedKb(db, NS);
      const highbay = 'https://example.com/highbay.pdf';
      seedGraph(db, [
        { ...GRAPH_CHUNKS[0], sectionHeading: 'Parametry', sourceRef: highbay },
        { ...GRAPH_CHUNKS[1], sectionHeading: 'Sterowanie', sourceRef: highbay },
      ]);
      replaceForDocument(db, NS, 'DOC_g2', [{ id: 'CHUNK_g2_001', content: 'Bez metadanych.' }]);
      interface EntityOut {
        id: string;
        namespace: string;
        spgType: string;
        properties: Record<string, unknown>;
        degraded: boolean;
      }
      const isStringMap = (p: Record<string, unknown>): boolean => Object.values(p).every((v) => typeof v === 'string');

      // A: fallback (openspg null) — degraded:true; `properties` zawsze string→string
      {
        const ctx = makeCtx(db);
        const chunk = pass<EntityOut>(kbEntityGetTool, cov, await kbEntityGetTool.handler(ctx, { id: 'CHUNK_g1_001' }));
        expect(chunk).toEqual({
          id: 'CHUNK_g1_001',
          namespace: NS,
          spgType: 'LightingDocs.Chunk',
          degraded: true,
          properties: {
            name: 'Karta HighBay',
            content: 'Strumień 21000 lm.',
            sourceDocumentRefId: 'DOC_g1',
            sectionHeading: 'Parametry',
            sourceUrl: highbay,
          },
        });
        const bare = pass<EntityOut>(kbEntityGetTool, cov, await kbEntityGetTool.handler(ctx, { id: 'CHUNK_g2_001' }));
        expect(Object.keys(bare.properties).sort()).toEqual(['content', 'name', 'sourceDocumentRefId']);
        const doc = pass<EntityOut>(
          kbEntityGetTool,
          cov,
          await kbEntityGetTool.handler(ctx, { id: 'DOC_g1', namespace: NS }),
        );
        expect(doc).toMatchObject({
          spgType: 'LightingDocs.ReferenceDocument',
          degraded: true,
          properties: { name: 'Karta HighBay', chunkCount: '2', sourceUrl: highbay },
        });
        for (const out of [chunk, bare, doc]) expect(isStringMap(out.properties)).toBe(true);
      }

      // B: primary — query/spgType przez prawdziwego klienta na mock fetch; wartości grafu stringowane, wektory odcięte
      {
        setProvisioned(db, NS, 7, 'inst@text-embedding-3-small', 'h'); // projectId = warunek kanału grafu
        const openspg = mockOpenspg({
          '/public/v1/query/spgType': (body) => {
            const { spgType, ids } = body as { spgType: string; ids: string[] };
            const id = ids[0];
            if (id === 'CHUNK_g1_001') {
              return [
                {
                  id,
                  spgType,
                  properties: {
                    name: '"Karta HighBay"',
                    content: '"Strumień 21000 lm."',
                    sectionHeading: 'Parametry',
                    sectionOrder: 0,
                    isCurrent: true,
                    sourceDocumentRefId: 'DOC_g1',
                    _content_vector: [0.1],
                  },
                },
              ];
            }
            if (id === 'TOPIC_HIGHBAY') return [{ id, properties: { name: 'HighBay' } }]; // bez spgType → z parametru
            if (id === 'DOC_g1') {
              return [{ id, spgType, properties: { name: 'Karta HighBay', sourceUrl: highbay, chunkCount: 2 } }];
            }
            return [];
          },
        });
        const ctx = withOpenspg(makeCtx(db), openspg);
        const chunk = pass<EntityOut>(kbEntityGetTool, cov, await kbEntityGetTool.handler(ctx, { id: 'CHUNK_g1_001' }));
        expect(chunk.degraded).toBe(false);
        expect(chunk.properties).toEqual({
          name: 'Karta HighBay',
          content: 'Strumień 21000 lm.',
          sectionHeading: 'Parametry',
          sectionOrder: '0',
          isCurrent: 'true',
          sourceDocumentRefId: 'DOC_g1',
        });
        const topic = pass<EntityOut>(
          kbEntityGetTool,
          cov,
          await kbEntityGetTool.handler(ctx, { id: 'TOPIC_HIGHBAY' }),
        );
        expect(topic).toMatchObject({
          spgType: 'LightingDocs.Topic',
          degraded: false,
          properties: { name: 'HighBay' },
        });
        const doc = pass<EntityOut>(kbEntityGetTool, cov, await kbEntityGetTool.handler(ctx, { id: 'DOC_g1' }));
        expect(doc.properties['chunkCount']).toBe('2');
        // graf zwraca [] → cichy fallback do mirrora z degraded:true
        const fallback = pass<EntityOut>(
          kbEntityGetTool,
          cov,
          await kbEntityGetTool.handler(ctx, { id: 'CHUNK_g2_001' }),
        );
        expect(fallback.degraded).toBe(true);
        for (const out of [chunk, topic, doc, fallback]) expect(isStringMap(out.properties)).toBe(true);
      }
    },
  },

  kb_graph_neighbors: {
    title: 'węzły z tytułem i bez, wszystkie trzy kind, obie relacje',
    async run(cov) {
      const db = testDb();
      seedKb(db, NS);
      seedGraph(db, [...GRAPH_CHUNKS, { id: 'CHUNK_g1_003', title: null, content: 'Bez tytułu.' }]);
      const ctx = makeCtx(db);

      const out = pass<{ nodes: Record<string, unknown>[]; edges: { rel: string }[] }>(
        kbGraphNeighborsTool,
        cov,
        await kbGraphNeighborsTool.handler(ctx, { id: 'CHUNK_g1_001', depth: 2, direction: 'both', namespace: NS }),
      );
      expect(out.nodes).toEqual([
        { id: 'DOC_g1', distance: 1, kind: 'document', title: 'Karta HighBay' },
        { id: 'CHUNK_g1_002', distance: 2, kind: 'chunk', title: 'Karta HighBay' },
        { id: 'CHUNK_g1_003', distance: 2, kind: 'chunk' },
        { id: 'TOPIC_HIGHBAY', distance: 2, kind: 'topic' },
      ]);
      expect(new Set(out.edges.map((e) => e.rel))).toEqual(new Set(['in_document', 'about_topic']));

      // auto-detekcja namespace z graph_edges — ten sam kształt
      const auto = pass<{ nodes: unknown[] }>(
        kbGraphNeighborsTool,
        cov,
        await kbGraphNeighborsTool.handler(ctx, { id: 'DOC_g1', direction: 'in' }),
      );
      expect(auto.nodes).toHaveLength(3);
    },
  },

  kb_claim_verify: {
    title: 'supported z pełnym cytowaniem, contradicted, insufficient z bramki (gapRecorded) i bez metadanych',
    async run(cov) {
      const db = testDb();
      seedKb(db, NS);
      seedLightingChunks(db); // CHUNK_ld000001_001: title + sourceRef
      replaceForDocument(db, NS, 'doc2', [
        { id: 'CHUNK_ld000002_001', content: 'Magistrala DALI pozwala sterować oprawami indywidualnie i grupowo.' },
      ]);
      const CLAIM = 'Maksymalne obciążenie toru szynoprzewodów wynosi 16 amperów na fazę';
      interface VerifyOut {
        status: string;
        explanation: string;
        citations: Record<string, unknown>[];
        degraded: boolean;
        gapRecorded: boolean;
      }
      const verify = (llmText: string, claim: string, namespaces?: string[]) => {
        const mock = mockLlm(llmText);
        const input = { claim, ...(namespaces !== undefined ? { namespaces } : {}) };
        return { mock, result: kbClaimVerifyTool.handler(makeCtx(db, { llm: mock.llm }), input) };
      };

      // A: supported — każde pole opcjonalne cytowania + degraded + gapRecorded:false
      {
        const { mock, result } = verify(
          '{"status":"supported","explanation":"Źródło [1] podaje 16 A na fazę.","evidenceNs":[1]}',
          CLAIM,
          [NS],
        );
        const out = pass<VerifyOut>(kbClaimVerifyTool, cov, await result);
        expect(out).toEqual({
          status: 'supported',
          explanation: 'Źródło [1] podaje 16 A na fazę.',
          citations: [
            {
              n: 1,
              id: 'CHUNK_ld000001_001',
              namespace: NS,
              title: 'Montaż szynoprzewodów',
              snippet: expect.stringContaining('16 amperów'),
              sourceRef: 'https://example.com/karta.pdf',
            },
          ],
          degraded: true,
          gapRecorded: false,
        });
        expect(mock.calls.chat).toBe(1);
      }

      // B: contradicted z pustym evidenceNs (fallback top-3)
      {
        const { result } = verify(
          '{"status":"contradicted","explanation":"Źródło mówi 16 A, nie 32 A.","evidenceNs":[]}',
          'Maksymalne obciążenie toru szynoprzewodów wynosi 32 amperów na fazę',
        );
        const out = pass<VerifyOut>(kbClaimVerifyTool, cov, await result);
        expect(out).toMatchObject({ status: 'contradicted', gapRecorded: false });
        expect(out.citations[0]?.['id']).toBe('CHUNK_ld000001_001');
      }

      // C: insufficient z bramki — chat NIE wołany, cytowania puste, gapRecorded:true
      {
        const { mock, result } = verify(
          '{"status":"supported","explanation":"nie powinno być użyte","evidenceNs":[1]}',
          'Bilet miesięczny w Krakowie kosztuje 150 złotych',
        );
        const out = pass<VerifyOut>(kbClaimVerifyTool, cov, await result);
        expect(out).toMatchObject({ status: 'insufficient', citations: [], gapRecorded: true, degraded: true });
        expect(mock.calls.chat).toBe(0);
      }

      // D: cytowanie bez title/sourceRef → klucze POMINIĘTE, nie null
      {
        const { result } = verify(
          '{"status":"supported","explanation":"DALI steruje grupowo.","evidenceNs":[1]}',
          'Magistrala DALI pozwala sterować oprawami grupowo',
        );
        const out = pass<VerifyOut>(kbClaimVerifyTool, cov, await result);
        expect(Object.keys(out.citations[0] ?? {}).sort()).toEqual(['id', 'n', 'namespace', 'snippet']);
      }
    },
  },

  kb_submit_draft: {
    title: 'świeży draft bez `duplicate`, duplikat po content_hash i po idempotencyKey',
    async run(cov) {
      const db = testDb();
      seedKb(db, NS);
      const ctx = makeCtx(db, { scopes: ['read', 'write'] });
      const CONTENT =
        '# Szynoprzewody\n\nMaksymalne obciążenie toru trójfazowego wynosi 16 A na fazę. ' +
        'Przed montażem sprawdź nośność stropu i przekroje przewodów zasilających.';
      interface SubmitOut {
        draftId: string;
        status: string;
        reviewRequired: boolean;
        duplicate?: boolean;
      }

      const fresh = pass<SubmitOut>(
        kbSubmitDraftTool,
        cov,
        await kbSubmitDraftTool.handler(ctx, {
          namespace: NS,
          title: 'Szynoprzewody — obciążenia',
          content: CONTENT,
          sourceUrl: 'https://example.com/norma.pdf',
          tags: ['elektryka'],
        }),
      );
      expect(fresh).toEqual({ draftId: expect.stringMatching(/^draft_/), status: 'inbox', reviewRequired: true });

      const byHash = pass<SubmitOut>(
        kbSubmitDraftTool,
        cov,
        await kbSubmitDraftTool.handler(ctx, { namespace: NS, title: 'Inny tytuł', content: CONTENT }),
      );
      expect(byHash).toEqual({ draftId: fresh.draftId, status: 'inbox', reviewRequired: true, duplicate: true });

      const idem = { namespace: NS, title: 'Lekcja o zawiesiach', idempotencyKey: 'idem-test-123456' }; // gitleaks:allow (klucz idempotencji testu, nie sekret)
      const first = pass<SubmitOut>(
        kbSubmitDraftTool,
        cov,
        await kbSubmitDraftTool.handler(ctx, {
          ...idem,
          content: 'Pierwsza wersja treści lekcji o montażu zawiesi w halach przemysłowych.',
        }),
      );
      const retry = pass<SubmitOut>(
        kbSubmitDraftTool,
        cov,
        await kbSubmitDraftTool.handler(ctx, {
          ...idem,
          content: 'INNA treść po retry — nie powinna utworzyć nowego draftu w Inboxie.',
        }),
      );
      expect(retry).toEqual({ draftId: first.draftId, status: 'inbox', reviewRequired: true, duplicate: true });
    },
  },

  kb_feedback: {
    title: 'up bez luki, down tworzy lukę, drugi down podbija istniejącą (gapUpdated)',
    async run(cov) {
      const db = testDb();
      seedKb(db, NS);
      const ctx = makeCtx(db);
      const seedAnswer = () =>
        recordAnswer(db, {
          question: 'Jakie jest maksymalne obciążenie szynoprzewodów?', // ten sam tekst → ta sama znormalizowana luka
          namespaces: [NS],
          citations: [{ n: 1, id: 'CHUNK_ld000001_001', namespace: NS }],
          confidence: 0.9,
          source: 'mcp',
          apiKeyId: ctx.keyRow.id, // anty-IDOR: klucz ocenia tylko własne odpowiedzi
        }).id;
      const a1 = seedAnswer();
      const a2 = seedAnswer();
      const a3 = seedAnswer();

      const up = pass<Record<string, boolean>>(
        kbFeedbackTool,
        cov,
        await kbFeedbackTool.handler(ctx, { answerId: a3, verdict: 'up' }),
      );
      expect(up).toEqual({ ok: true, gapCreated: false, gapUpdated: false });
      const down = pass<Record<string, boolean>>(
        kbFeedbackTool,
        cov,
        await kbFeedbackTool.handler(ctx, {
          answerId: a1,
          verdict: 'down',
          comment: 'Odpowiedź pomija warunki montażu.',
        }),
      );
      expect(down).toEqual({ ok: true, gapCreated: true, gapUpdated: false });
      const again = pass<Record<string, boolean>>(
        kbFeedbackTool,
        cov,
        await kbFeedbackTool.handler(ctx, { answerId: a2, verdict: 'down' }),
      );
      expect(again).toEqual({ ok: true, gapCreated: false, gapUpdated: true });
    },
  },
};

// ── Przypadki BŁĘDU per narzędzie (kod §7.4 zwracany przez SAM handler, bez shellu) ──

interface ErrorCase {
  title: string;
  code: ToolErrorCode;
  run(): Promise<ToolResult>;
}

/** Profil zawężony do LightingDocs — `namespaces` spoza niego to namespace_not_allowed. */
function narrowCtx(db: Db, opts: Omit<MakeCtxOpts, 'namespaces'> = {}): ToolCtx {
  seedKb(db, NS);
  return makeCtx(db, { ...opts, namespaces: [NS] });
}

const FOREIGN_NS = 'ObcaBaza';

const ERROR_CASES: Record<string, ErrorCase> = {
  kb_search: {
    title: 'namespace spoza profilu',
    code: 'namespace_not_allowed',
    run: () => kbSearchTool.handler(narrowCtx(testDb()), { query: SEARCH_QUERY, namespaces: [FOREIGN_NS] }),
  },
  kb_answer: {
    title: 'LLM nieskonfigurowany (ctx.llm === null)',
    code: 'upstream_unavailable',
    run: () => kbAnswerTool.handler(narrowCtx(testDb()), { question: QUESTION }),
  },
  kb_list: {
    title: 'nieznane pole wejścia (zod strictObject)',
    code: 'validation',
    run: () => kbListTool.handler(makeCtx(testDb()), { bogus: 1 }),
  },
  kb_get_source: {
    title: 'nieistniejące źródło',
    code: 'validation',
    run: () => kbGetSourceTool.handler(narrowCtx(testDb()), { id: 'CHUNK_nie_ma_000' }),
  },
  kb_list_documents: {
    title: 'namespace spoza profilu',
    code: 'namespace_not_allowed',
    run: () => kbListDocumentsTool.handler(narrowCtx(testDb()), { namespace: FOREIGN_NS }),
  },
  kb_draft_status: {
    title: 'nieistniejący draft',
    code: 'validation',
    run: () => kbDraftStatusTool.handler(narrowCtx(testDb()), { draftId: 'draft_nie_ma' }),
  },
  kb_entity_get: {
    title: 'nieistniejąca encja (mirror pusty, openspg null)',
    code: 'validation',
    run: () => kbEntityGetTool.handler(narrowCtx(testDb()), { id: 'CHUNK_nie_ma_000' }),
  },
  kb_graph_neighbors: {
    title: 'encja bez krawędzi w grafie',
    code: 'validation',
    run: () => kbGraphNeighborsTool.handler(narrowCtx(testDb()), { id: 'CHUNK_nie_ma_000' }),
  },
  kb_claim_verify: {
    title: 'namespace spoza profilu',
    code: 'namespace_not_allowed',
    run: () =>
      kbClaimVerifyTool.handler(narrowCtx(testDb(), { llm: mockLlm().llm }), {
        claim: 'Maksymalne obciążenie toru wynosi 16 amperów na fazę',
        namespaces: [FOREIGN_NS],
      }),
  },
  kb_submit_draft: {
    title: 'klucz bez scope write (deny-by-default §7.2)',
    code: 'forbidden',
    run: () =>
      kbSubmitDraftTool.handler(narrowCtx(testDb(), { scopes: ['read'] }), {
        namespace: NS,
        title: 'Próba zapisu',
        content: 'Treść, która nie powinna trafić do Inboxu bez scope write.',
      }),
  },
  kb_feedback: {
    title: 'ocena cudzej/nieistniejącej odpowiedzi (AppError not_found → validation)',
    code: 'validation',
    run: () => kbFeedbackTool.handler(narrowCtx(testDb()), { answerId: 'ans_nie_ma', verdict: 'up' }),
  },
};

/** Stub handlera rzucającego — ścieżka `catch` shellu (executeToolCall) z errorId. */
function throwingTool(err: unknown): KbTool {
  return {
    ...kbListTool,
    async handler() {
      throw err;
    },
  };
}

/** Prawdziwy Client SDK spięty z serwerem z createMcpPair przez InMemoryTransport (bez HTTP). */
async function connectSdkClient(ctx: ToolCtx): Promise<Client> {
  const { server } = createMcpPair({ ctx, tools: ALL_TOOLS });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'contract-output-schema-test', version: '0.0.0' });
  await client.connect(clientTransport);
  await client.listTools(); // klient kompiluje walidatory outputSchema z tools/list
  return client;
}

// ── Testy ──

describe('kontrakt outputSchema: każde narzędzie emituje wszystkie pola i przechodzi walidację klienta', () => {
  // cache odpowiedzi jest per proces — trafienie odtworzyłoby kształt z poprzedniego testu
  beforeEach(() => clearAnswerCache());

  for (const [name, { title, run }] of Object.entries(CONTRACT_CASES)) {
    it(`${name}: ${title}`, async () => {
      const tool = ALL_TOOLS.find((t) => t.name === name);
      if (tool === undefined) throw new Error(`${name}: klucz CONTRACT_CASES spoza rejestru ALL_TOOLS`);
      const cov = coverage();
      await run(cov);
      assertFullCoverage(tool, cov);
    });
  }

  it('każde narzędzie z ALL_TOOLS ma przypadek kontraktu, błędu i wpis w OPTIONAL_PATHS (nowe narzędzie = czerwony)', () => {
    const names = ALL_TOOLS.map((t) => t.name).sort();
    expect(Object.keys(CONTRACT_CASES).sort()).toEqual(names);
    expect(Object.keys(ERROR_CASES).sort()).toEqual(names);
    expect(Object.keys(OPTIONAL_PATHS).sort()).toEqual(names);
    expect(names).toEqual(expect.arrayContaining(Object.keys(ENUM_VALUES)));
  });
});

describe('kontrakt ścieżki błędu: isError + structured {errorCode} wg TOOL_ERROR_SCHEMA (§7.4)', () => {
  beforeEach(() => clearAnswerCache());
  // jedno pokrycie dla całego bloku — testy pliku biegną sekwencyjnie w kolejności deklaracji,
  // więc ostatni `it` widzi wszystko, co wyemitowały poprzednie
  const errCov = coverage();

  for (const [name, { title, code, run }] of Object.entries(ERROR_CASES)) {
    it(`${name}: ${title} → ${code}`, async () => {
      fail(name, errCov, await run(), code);
    });
  }

  it('shell executeToolCall: odrzucone wejście → validation + problems[]; wyjątek handlera → kod z mapowania + errorId', async () => {
    const db = testDb();
    const ctx = narrowCtx(db);
    const opts = { ctx, tools: ALL_TOOLS };

    // validateInput przed handlerem: brak wymaganego `query` → problems (handler nie jest wołany)
    const rejected = await executeToolCall(opts, ALL_TOOLS, 'kb_search', {});
    if (rejected.kind !== 'result') throw new Error('oczekiwano wyniku isError, nie błędu protokołu');
    const problems = fail('kb_search (shell)', errCov, rejected.result, 'validation')['problems'];
    expect(problems).toEqual([expect.stringContaining('query')]);

    // wyjątki handlera: AppError upstream → upstream_unavailable, rate_limited → rate_limited,
    // dowolny inny → internal; ZAWSZE errorId, NIGDY treść wyjątku w tekście ani w structured
    const LEAK = 'release-openspg-server:8887';
    const thrown: [unknown, ToolErrorCode][] = [
      [new AppError('upstream_timeout', LEAK), 'upstream_unavailable'],
      [new AppError('rate_limited', LEAK), 'rate_limited'],
      [new Error(LEAK), 'internal'],
    ];
    for (const [err, code] of thrown) {
      const outcome = await executeToolCall(opts, [throwingTool(err)], 'kb_list', {});
      if (outcome.kind !== 'result') throw new Error('oczekiwano wyniku isError, nie błędu protokołu');
      const wire = fail(`kb_list (shell, ${code})`, errCov, outcome.result, code);
      expect(wire['errorId']).toEqual(expect.stringMatching(/^[0-9a-f]{8}$/));
      expect(JSON.stringify([outcome.result.text, wire])).not.toContain(LEAK);
    }
  });

  it('każdy kod ToolErrorCode i każda ścieżka TOOL_ERROR_SCHEMA zostały realnie wyemitowane', () => {
    const declared = schemaPaths(TOOL_ERROR_SCHEMA as Schema);
    expect(declared.filter((p) => !errCov.emitted.has(p))).toEqual([]);
    expect([...errCov.undeclared]).toEqual([]);
    const seen = errCov.enumValues.get('errorCode') ?? new Set<string>();
    expect(TOOL_ERROR_CODES.filter((c) => !seen.has(c)), 'kody błędów bez fixture').toEqual([]);
  });
});

describe('kontrakt outputSchema: prawdziwy klient SDK (InMemoryTransport, walidacja po stronie Client)', () => {
  it('wynik SUKCESU przechodzi przez Client.callTool z walidacją outputSchema (ta sama, co ajv w assertMatchesOutputSchema)', async () => {
    const db = testDb();
    seedKb(db, 'AlphaDocs');
    const client = await connectSdkClient(makeCtx(db));
    const res = await client.callTool({ name: 'kb_list', arguments: {} });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({
      kbs: [{ namespace: 'AlphaDocs', name: 'Baza AlphaDocs', status: 'active', description: 'Testowa baza AlphaDocs' }],
    });
    await client.close();
  });

  // Regresja 2026-09-10: {errorCode} w structuredContent → Client SDK rzucał McpError -32602
  // „Structured content does not match the tool's output schema" na KAŻDYM błędzie narzędzia.
  it('błąd narzędzia dociera do Client SDK jako wynik isError z _meta.errorCode, nie McpError -32602', async () => {
    const db = testDb();
    const client = await connectSdkClient(narrowCtx(db));
    try {
      const res = await client.callTool({ name: 'kb_search', arguments: { query: SEARCH_QUERY, namespaces: [FOREIGN_NS] } });
      expect(res.isError).toBe(true);
      expect(res.structuredContent).toBeUndefined();
      expect((res._meta as { errorCode: string }).errorCode).toBe('namespace_not_allowed');
      expect(String((res.content as { text: string }[])[0]?.text)).not.toBe('');
    } finally {
      await client.close();
    }
  });
});

describe('kontrakt outputSchema: strażnik ma zęby', () => {
  beforeEach(() => clearAnswerCache());

  it('usunięcie citations[].docId ze schematu kb_answer → PRAWDZIWY wynik pada na walidacji (2026-09-10)', async () => {
    const db = testDb();
    seedKb(db, NS);
    seedRichDocument(db);
    const res = await kbAnswerTool.handler(makeCtx(db, { llm: mockLlm().llm }), { question: QUESTION });
    expect(res.isError).toBeUndefined();
    const out = res.structured as { citations: Record<string, unknown>[] };
    expect(out.citations[0]).toHaveProperty('docId'); // wynik REALNIE niesie pole, które zaraz „zapomnimy"
    assertMatchesOutputSchema(kbAnswerTool, res.structured); // pełny schemat: OK

    const crippled = structuredClone(kbAnswerTool.outputSchema) as {
      properties: { citations: { items: { properties: Record<string, unknown> } } };
    };
    delete crippled.properties.citations.items.properties['docId'];
    // ajv nie nazywa nadmiarowego klucza — wskazuje element cytowania i regułę additionalProperties
    const crippledTool = { name: kbAnswerTool.name, outputSchema: crippled };
    expect(() => assertMatchesOutputSchema(crippledTool, res.structured)).toThrow(
      /kb_answer: structured nie pasuje do outputSchema: .*citations\/0 must NOT have additional properties/,
    );
  });

  it('usunięcie wartości enum degradedReasons z kb_answer → fixture embed_failed pada na walidacji', async () => {
    // D8-03/D8-10: dokładnie ten dryf (schemat bez wartości, którą retrieval realnie emituje) wywracał narzędzie
    const db = testDb();
    seedProvisionedKb(db);
    seedRichDocument(db);
    const ctx = withOpenspg(makeCtx(db, { llm: llmWithFailingEmbed() }), emptyOpenspg());
    const res = await kbAnswerTool.handler(ctx, { question: QUESTION });
    expect(res.isError).toBeUndefined();
    assertMatchesOutputSchema(kbAnswerTool, res.structured);

    const crippled = structuredClone(kbAnswerTool.outputSchema) as {
      properties: { degradedReasons: { items: { enum: string[] } } };
    };
    crippled.properties.degradedReasons.items.enum = crippled.properties.degradedReasons.items.enum.filter(
      (v) => v !== 'embed_failed',
    );
    const crippledTool = { name: kbAnswerTool.name, outputSchema: crippled };
    expect(() => assertMatchesOutputSchema(crippledTool, res.structured)).toThrow(
      /degradedReasons\/1 must be equal to one of the allowed values/,
    );
  });

  it('pokrycie ścieżek: wynik minimalny (same pola wymagane) NIE domyka kontraktu', () => {
    const cov = coverage();
    collectPaths(
      { answer: 'x', citations: [], confidence: 0, gapRecorded: false, answerId: 'ans_1' },
      kbAnswerTool.outputSchema as Schema,
      '',
      cov,
    );
    const missing = schemaPaths(kbAnswerTool.outputSchema as Schema).filter((p) => !cov.emitted.has(p));
    expect(missing).toEqual(
      expect.arrayContaining(['citations[]', 'citations[].docId', 'claims', 'model', 'warnings[]']),
    );
    // pole spoza schematu jest raportowane nawet tam, gdzie ajv nie ma additionalProperties:false
    collectPaths(
      { kbs: [{ namespace: 'A', name: 'A', status: 'active', extra: 1 }] },
      kbListTool.outputSchema as Schema,
      '',
      cov,
    );
    expect([...cov.undeclared]).toEqual(['kbs[].extra']);
  });

  it('pokrycie enum: wartości spoza fixture są raportowane; klucz `undefined` po drucie NIE jest wyemitowany', () => {
    const cov = coverage();
    const wire = toWire({
      results: [{ id: 'c', namespace: 'A', score: 1, snippet: 's', source: 'fallback_fts' }],
      degraded: false,
      tookMs: undefined,
    });
    collectPaths(wire, kbSearchTool.outputSchema as Schema, '', cov);
    expect([...(cov.enumValues.get('results[].source') ?? [])]).toEqual(['fallback_fts']);
    expect(cov.enumValues.has('degradedReasons[]')).toBe(false);
    expect(cov.emitted.has('tookMs')).toBe(false);
    expect(cov.undeclared.size).toBe(0);
  });

  it('OPTIONAL_PATHS i ENUM_VALUES liczone z tego samego schematu, co pokrycie (kb_answer: 17 ścieżek, 5 enum)', () => {
    expect(optionalSchemaPaths(kbAnswerTool.outputSchema as Schema)).toHaveLength(17);
    expect(schemaEnums(kbAnswerTool.outputSchema as Schema)).toEqual({
      'degradedReasons[]': [...DEGRADED_REASONS].sort(),
    });
    expect(schemaEnums(kbListTool.outputSchema as Schema)).toEqual({});
  });

  it('enumy schematów kb_search/kb_answer = RUNTIME listy z packages/shared (nie ręczna kopia, która mogłaby dryfować)', () => {
    // 5 powodów i 4 źródła — liczby jawne, żeby przypadkowe skrócenie listy w shared też było widoczne
    expect(DEGRADED_REASONS).toHaveLength(5);
    expect(RETRIEVAL_SOURCES).toHaveLength(4);
    expect(schemaEnums(kbSearchTool.outputSchema as Schema)).toEqual({
      'results[].source': [...RETRIEVAL_SOURCES].sort(),
      'degradedReasons[]': [...DEGRADED_REASONS].sort(),
    });
    expect(schemaEnums(kbAnswerTool.outputSchema as Schema)['degradedReasons[]']).toEqual(
      [...DEGRADED_REASONS].sort(),
    );
  });
});
