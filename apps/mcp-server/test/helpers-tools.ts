import Ajv from 'ajv';
import { fileURLToPath } from 'node:url';
import {
  KNOWN_MCP_TOOLS,
  createKb,
  createKey,
  createProfile,
  nowIso,
  openDb,
  replaceEdgesForNamespace,
  replaceForDocument,
  resolveNamespaces,
  runMigrations,
} from '@pomagierkb/shared/db';
import type { ChunkInput, Db, GraphEdge } from '@pomagierkb/shared/db';
import type { ChatRequest, ChatResult } from '@pomagierkb/shared/llm';
import type { ToolCtx, ToolLlm } from '../src/tools/types.js';

/**
 * Pomocniki testów NARZĘDZI kb_* (handlery wołane bezpośrednio, bez shellu HTTP).
 * Osobny plik od helpers.ts (helpery shellu) — obie warstwy testują co innego.
 */

/** Baza :memory: ze zmigrowanym schematem (migracje SQL z packages/shared). */
export function testDb(): Db {
  const db = openDb(':memory:');
  runMigrations(db, fileURLToPath(new URL('../../../packages/shared/src/db/migrations', import.meta.url)));
  return db;
}

/** Użytkownik serwisowy pod FK api_keys/drafts. */
export function ensureUser(db: Db, id = 'user_test'): string {
  db.prepare(
    `INSERT OR IGNORE INTO users (id, display_name, kind, role, status, created_at, updated_at)
     VALUES (?, 'Testowy', 'service', 'operator', 'active', ?, ?)`,
  ).run(id, nowIso(), nowIso());
  return id;
}

/** KB w rejestrze od razu w statusie active (skrót testowy). */
export function seedKb(db: Db, namespace: string, opts: { embeddingModel?: string; name?: string } = {}): void {
  createKb(db, {
    namespace,
    name: opts.name ?? `Baza ${namespace}`,
    description: `Testowa baza ${namespace}`,
    ...(opts.embeddingModel !== undefined ? { embeddingModel: opts.embeddingModel } : {}),
  });
  db.prepare("UPDATE kb_registry SET status = 'active' WHERE namespace = ?").run(namespace);
}

export interface SeedLightingChunksOpts {
  /** Identyfikator dokumentu w mirrorze (domyślnie 'doc1'). */
  docId?: string;
  /** Nagłówki sekcji per id chunka — domyślnie żaden chunk nie ma sectionHeading. */
  sectionHeadings?: Record<string, string>;
}

/** Chunki po polsku (odmiana ≠ zapytanie → trafienie przez tokenizer trigram). */
export function seedLightingChunks(db: Db, opts: SeedLightingChunksOpts = {}): void {
  const heading = (id: string): Pick<ChunkInput, 'sectionHeading'> => {
    const h = opts.sectionHeadings?.[id];
    return h === undefined ? {} : { sectionHeading: h };
  };
  replaceForDocument(db, 'LightingDocs', opts.docId ?? 'doc1', [
    {
      id: 'CHUNK_ld000001_001',
      title: 'Montaż szynoprzewodów',
      ...heading('CHUNK_ld000001_001'),
      content:
        'Przy montażu na szynoprzewodach trójfazowych maksymalne obciążenie toru wynosi 16 amperów na fazę.',
      sourceRef: 'https://example.com/karta.pdf',
    },
    {
      id: 'CHUNK_ld000001_002',
      title: 'Sterowanie DALI',
      ...heading('CHUNK_ld000001_002'),
      content: 'Magistrala DALI pozwala sterować oprawami indywidualnie i grupowo.',
    },
  ]);
}

export const GRAPH_DOC_ID = 'DOC_g1';
export const GRAPH_TOPIC_ID = 'TOPIC_HIGHBAY';

/** Domyślne chunki mini-grafu (bez sekcji/źródła — testy dokładają metadane przez `chunks`). */
export const GRAPH_CHUNKS = [
  { id: 'CHUNK_g1_001', title: 'Karta HighBay', content: 'Strumień 21000 lm.' },
  { id: 'CHUNK_g1_002', title: 'Karta HighBay', content: 'Sterowanie DALI-2.' },
] as const satisfies readonly ChunkInput[];

/**
 * Mini-graf w mirrorze + graph_edges: DOC_g1 z chunkami (każdy `in_document` → DOC_g1)
 * i DOC_g1 `about_topic` → TOPIC_HIGHBAY. Krawędzie namespace'u są ZASTĘPOWANE.
 */
export function seedGraph(db: Db, chunks: readonly ChunkInput[] = GRAPH_CHUNKS): void {
  replaceForDocument(db, 'LightingDocs', GRAPH_DOC_ID, [...chunks]);
  const edges: GraphEdge[] = [
    ...chunks.map((c): GraphEdge => ({ srcId: c.id, rel: 'in_document', dstId: GRAPH_DOC_ID })),
    { srcId: GRAPH_DOC_ID, rel: 'about_topic', dstId: GRAPH_TOPIC_ID },
  ];
  replaceEdgesForNamespace(db, 'LightingDocs', edges);
}

export interface MockLlm {
  llm: ToolLlm;
  calls: { chat: number; embed: number };
  setChatText(text: string): void;
}

/** Mock LLM: chat = stały tekst (z [1] i CONFIDENCE), embed = deterministyczne wektory. */
export function mockLlm(
  initialText = 'Na podstawie źródła [1] maksymalne obciążenie wynosi 16 A na fazę.\nCONFIDENCE: 0.8',
): MockLlm {
  const calls = { chat: 0, embed: 0 };
  let text = initialText;
  return {
    calls,
    setChatText(t: string) {
      text = t;
    },
    llm: {
      async chat(_req: ChatRequest): Promise<ChatResult> {
        calls.chat += 1;
        return { text };
      },
      async embed(texts: string[]): Promise<number[][]> {
        calls.embed += 1;
        return texts.map((t, i) => [((t.length % 7) + 1) / 10, 0.2, 0.3 + i * 0.01]);
      },
    },
  };
}

const toolTestConfig: ToolCtx['config'] = {
  dataDir: '/tmp/kag-test',
  dbPath: ':memory:',
  usageDir: '/tmp/kag-test/mcp-usage',
  port: 0,
  host: '127.0.0.1',
  internalPort: 0,
  internalToken: null,
  publicUrl: null,
  openspg: null,
  tokenEncKey: null,
  version: '0.0.0-test',
};

function stubLog(): ToolCtx['log'] {
  const log: Record<string, unknown> = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    fatal: () => undefined,
  };
  log['child'] = () => log;
  return log as unknown as ToolCtx['log'];
}

let profileSeq = 0;

export interface MakeCtxOpts {
  /** null/undefined = wszystkie aktywne KB; lista = profil zawężony. */
  namespaces?: string[] | null;
  scopes?: string[];
  llm?: ToolLlm | null;
}

/** ToolCtx budowany ręcznie: prawdziwy profil+klucz z DB, openspg zawsze null. */
export function makeCtx(db: Db, opts: MakeCtxOpts = {}): ToolCtx {
  const userId = ensureUser(db);
  const profile = createProfile(db, {
    id: `test-prof-${++profileSeq}`,
    name: 'Profil testowy',
    namespaces: opts.namespaces === undefined ? null : opts.namespaces,
    tools: [...KNOWN_MCP_TOOLS],
  });
  const scopes = opts.scopes ?? ['read'];
  const { row: keyRow } = createKey(db, userId, 'klucz testowy', scopes, profile.id, 30);
  return {
    db,
    profile,
    keyRow,
    allowedNamespaces: resolveNamespaces(db, profile),
    scopes,
    llm: opts.llm ?? null,
    openspg: null,
    config: toolTestConfig,
    log: stubLog(),
  };
}

/**
 * Walidacja `structured` narzędzia względem jego `outputSchema` — DOKŁADNIE to robi klient MCP
 * (SDK odrzuca odpowiedź: „Structured content does not match the tool's output schema").
 * Dryf schematu wykryty 2026-09-10: cytowania kb_answer dostały docId/sectionHeading, a schemat
 * z additionalProperties:false ich nie znał — curl przechodził, Claude Code odrzucał każdą odpowiedź.
 */
export function assertMatchesOutputSchema(tool: { name: string; outputSchema: object }, structured: unknown): void {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validate = ajv.compile(tool.outputSchema);
  if (!validate(structured)) {
    throw new Error(`${tool.name}: structured nie pasuje do outputSchema: ${ajv.errorsText(validate.errors)}`);
  }
}
