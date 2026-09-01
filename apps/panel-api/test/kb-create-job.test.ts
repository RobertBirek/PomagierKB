import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getAction, getKbOrThrow, transitionKb, type Db } from '@pomagierkb/shared/db';
import { OpenSpgClient } from '@pomagierkb/shared/openspg';
import {
  fixture,
  jsonResponse,
  loginResponse,
  makeMockFetch,
  type RecordedCall,
} from '../../../packages/shared/test/helpers/openspg-mock.js';
import { createKbEntry, latestSchemaVersion } from '../src/services/kb.js';
import { launchKbAction } from '../src/jobs/kb-runner.js';
import { runCreateKbJob } from '../src/jobs/create-kb.js';
import { runSchemaSyncJob } from '../src/jobs/schema-sync.js';
import type { AppConfig } from '../src/config.js';
import { makeDb, makeKbTestConfig, seedEmbeddingsSettings } from './helpers/kb.js';

/**
 * E2E jobów create_kb / schema_sync na MOCKU klienta OpenSPG (fetchImpl
 * z fixtures shared/test/fixtures/openspg): pełny provisioning, resume bez
 * duplikatu projektu, idempotentny drugi bieg i ścieżka błędu (status error).
 */

/** Stanowy mock serwera OpenSPG: rejestr modeli + projekty + schemas/graph. */
function makeProvisioningMock(opts: { embeddingRegistered?: boolean } = {}): {
  client: OpenSpgClient;
  calls: RecordedCall[];
  projectPosts: () => RecordedCall[];
} {
  let embeddingRegistered = opts.embeddingRegistered ?? false;
  const createdProjects: Record<string, unknown>[] = [];
  /** Namespace ostatnio scommitowanego schematu — schemas/graph zwraca jego typy. */
  const committedNs = new Map<number, string>();

  const { impl, calls } = makeMockFetch((path, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();

    if (path === '/v1/accounts/login') return loginResponse();

    if (path === '/v1/model/list/') {
      return jsonResponse(
        fixture(embeddingRegistered ? 'model-list-with-embedding.json' : 'model-list.json'),
      );
    }
    if (path === '/v1/model' && method === 'POST') {
      embeddingRegistered = true;
      return jsonResponse({ success: true, result: true });
    }

    if (path.startsWith('/v1/projects/list')) {
      const body = JSON.parse(JSON.stringify(fixture('projects-list.json'))) as {
        result: { data: Record<string, unknown>[] };
      };
      body.result.data.push(...createdProjects);
      return jsonResponse(body);
    }
    if (path === '/v1/projects' && method === 'POST') {
      const req = JSON.parse(String(init?.body)) as Record<string, unknown>;
      createdProjects.push({
        id: 42,
        name: req['name'],
        namespace: req['namespace'],
        config: JSON.stringify(req['config'] ?? {}),
      });
      return jsonResponse({ success: true, result: 42 });
    }

    if (path.startsWith('/v1/schemas/graph/')) {
      const projectId = Number(path.slice('/v1/schemas/graph/'.length));
      const ns = committedNs.get(projectId) ?? 'Unknown';
      const entityTypeDTOList = ['ConceptTaxonomy', 'Topic', 'ReferenceDocument', 'Chunk'].map(
        (t, i) => ({ id: 100 + i, name: `${ns}.${t}`, nameZh: t }),
      );
      return jsonResponse({ success: true, result: { projectId, entityTypeDTOList } });
    }
    if (path.startsWith('/v1/schemas?projectId=') && method === 'POST') {
      const projectId = Number(path.slice('/v1/schemas?projectId='.length));
      const body = JSON.parse(String(init?.body)) as { data: string };
      const ns = /^namespace (\S+)/.exec(body.data)?.[1] ?? 'Unknown';
      committedNs.set(projectId, ns);
      return jsonResponse({ success: true, result: true });
    }

    throw new Error(`mock OpenSPG: nieoczekiwana ścieżka ${method} ${path}`);
  });

  const client = new OpenSpgClient({
    baseUrl: 'http://release-openspg-server:8887',
    account: 'openspg',
    password: 'openspg@kag',
    fetchImpl: impl,
  });
  return {
    client,
    calls,
    projectPosts: () =>
      calls.filter((c) => c.path === '/v1/projects' && (c.init?.method ?? 'GET').toUpperCase() === 'POST'),
  };
}

function runJob(
  db: Db,
  config: AppConfig,
  client: OpenSpgClient,
  namespace: string,
  run = runCreateKbJob,
  type = 'create_kb',
): ReturnType<typeof launchKbAction> {
  return launchKbAction(
    { db, config, client, startedBy: null },
    { type, namespace, params: { namespace }, run },
  );
}

describe('job create_kb (E2E na mocku OpenSPG)', () => {
  it('pełny provisioning: model → projekt → schemat → weryfikacja → rejestr active', async () => {
    const db = makeDb();
    const config = makeKbTestConfig();
    seedEmbeddingsSettings(db, config, 'text-embedding-3-small');
    createKbEntry(db, { namespace: 'TestDocs', name: 'Dokumentacja testowa' });
    const mock = makeProvisioningMock(); // rejestr modeli BEZ embeddingu — job go dorejestruje

    const launched = runJob(db, config, mock.client, 'TestDocs');
    await launched.done;

    const action = getAction(db, launched.actionId)!;
    expect(action.status).toBe('success');

    const kb = getKbOrThrow(db, 'TestDocs');
    expect(kb.status).toBe('active');
    expect(kb.project_id).toBe(42);
    expect(kb.vector_model_id).toBe('b87d551d4ba14909907c6e29218fa011@text-embedding-3-small');
    expect(kb.embedding_model).toBe('text-embedding-3-small'); // nazwa modelu też w rejestrze
    expect(kb.schema_version).toBe(1);
    expect(kb.schema_hash).toMatch(/^[0-9a-f]{64}$/);

    const v1 = latestSchemaVersion(db, 'TestDocs')!;
    expect(v1.version).toBe(1);
    expect(v1.hash).toBe(kb.schema_hash);
    expect(v1.content.startsWith('namespace TestDocs')).toBe(true);

    // Dokładnie jedno utworzenie projektu + rejestracja modelu embeddingu.
    expect(mock.projectPosts()).toHaveLength(1);
    expect(mock.calls.filter((c) => c.path === '/v1/model').length).toBe(1);

    // Log akcji: @@progress na każdym kroku (6 kroków) + wpis o sukcesie.
    const log = readFileSync(launched.logPath, 'utf8');
    expect(log.match(/@@progress /g)?.length).toBe(6);
    expect(log).toContain('akcja zakończona sukcesem');
    expect(JSON.parse(action.progress_json ?? '{}')).toMatchObject({ current: 6, total: 6 });

    db.close();
  });

  it('resume: istniejący projekt w OpenSPG jest przejmowany bez duplikatu (zero POST /v1/projects)', async () => {
    const db = makeDb();
    const config = makeKbTestConfig();
    seedEmbeddingsSettings(db, config, 'text-embedding-3-small');
    // 'LightingDocs' istnieje w fixture projects-list.json (id 3, z modelId w config)
    // — symulacja biegu przerwanego po createProject, przed zapisem rejestru.
    createKbEntry(db, { namespace: 'LightingDocs', name: 'Dokumentacja oświetlenia' });
    transitionKb(db, 'LightingDocs', 'provisioning');
    const mock = makeProvisioningMock({ embeddingRegistered: true });

    const launched = runJob(db, config, mock.client, 'LightingDocs');
    await launched.done;

    expect(getAction(db, launched.actionId)!.status).toBe('success');
    const kb = getKbOrThrow(db, 'LightingDocs');
    expect(kb.status).toBe('active');
    expect(kb.project_id).toBe(3); // przejęty, nie utworzony
    expect(kb.vector_model_id).toBe('b87d551d4ba14909907c6e29218fa011@text-embedding-3-small');
    expect(mock.projectPosts()).toHaveLength(0); // ŻADNEGO duplikatu projektu

    db.close();
  });

  it('idempotencja: drugi bieg na aktywnej bazie nic nie zmienia', async () => {
    const db = makeDb();
    const config = makeKbTestConfig();
    seedEmbeddingsSettings(db, config, 'text-embedding-3-small');
    createKbEntry(db, { namespace: 'TestDocs', name: 'Dokumentacja testowa' });
    const mock = makeProvisioningMock();

    await runJob(db, config, mock.client, 'TestDocs').done;
    const afterFirst = getKbOrThrow(db, 'TestDocs');

    const second = runJob(db, config, mock.client, 'TestDocs');
    await second.done;

    expect(getAction(db, second.actionId)!.status).toBe('success');
    expect(mock.projectPosts()).toHaveLength(1); // wciąż tylko jedno utworzenie
    const afterSecond = getKbOrThrow(db, 'TestDocs');
    expect(afterSecond.schema_version).toBe(1);
    expect(afterSecond.project_id).toBe(afterFirst.project_id);

    db.close();
  });

  it('brak konfiguracji llm.embeddings → akcja error, KB w statusie error, czytelny log', async () => {
    const db = makeDb();
    const config = makeKbTestConfig(); // celowo bez seedEmbeddingsSettings
    createKbEntry(db, { namespace: 'NoCfgDocs', name: 'Bez konfiguracji' });
    const mock = makeProvisioningMock();

    const launched = runJob(db, config, mock.client, 'NoCfgDocs');
    await launched.done;

    expect(getAction(db, launched.actionId)!.status).toBe('error');
    expect(getKbOrThrow(db, 'NoCfgDocs').status).toBe('error');
    const log = readFileSync(launched.logPath, 'utf8');
    expect(log).toContain('llm.embeddings');
    expect(log).toContain('BŁĄD');
    expect(mock.projectPosts()).toHaveLength(0);

    db.close();
  });
});

describe('job schema_sync (E2E na mocku OpenSPG)', () => {
  it('commit bez zmian treści nie podbija wersji; realny commit przechodzi', async () => {
    const db = makeDb();
    const config = makeKbTestConfig();
    seedEmbeddingsSettings(db, config, 'text-embedding-3-small');
    createKbEntry(db, { namespace: 'TestDocs', name: 'Dokumentacja testowa' });
    const mock = makeProvisioningMock();
    await runJob(db, config, mock.client, 'TestDocs').done;

    // Szablon się nie zmienił → sync jest no-opem rejestru (wersja zostaje 1).
    const sync = runJob(db, config, mock.client, 'TestDocs', runSchemaSyncJob, 'schema_sync');
    await sync.done;

    expect(getAction(db, sync.actionId)!.status).toBe('success');
    const kb = getKbOrThrow(db, 'TestDocs');
    expect(kb.schema_version).toBe(1);
    expect(latestSchemaVersion(db, 'TestDocs')!.version).toBe(1);
    // commitSchema poszedł mimo braku zmian (upsert potwierdzający).
    const commits = mock.calls.filter((c) => c.path.startsWith('/v1/schemas?projectId='));
    expect(commits.length).toBe(2);

    db.close();
  });
});
