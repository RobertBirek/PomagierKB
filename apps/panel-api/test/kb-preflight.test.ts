import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createDraft,
  getAction,
  promoteDraft,
  transitionKb,
  type Db,
} from '@pomagierkb/shared/db';
import { OpenSpgClient } from '@pomagierkb/shared/openspg';
import {
  fixture,
  jsonResponse,
  loginResponse,
  makeMockFetch,
} from '../../../packages/shared/test/helpers/openspg-mock.js';
import { buildApp } from '../src/app.js';
import {
  createKbEntry,
  finishProvisioning,
  preflightBuild,
  type PreflightCheck,
} from '../src/services/kb.js';
import { renderSchema } from '../src/services/schema-template.js';
import type { AppConfig } from '../src/config.js';
import type { AppUser } from '../src/types.js';
import { makeDb, makeKbTestConfig, seedEmbeddingsSettings, seedUser } from './helpers/kb.js';

/**
 * Preflight buildu: GUARD NIEZMIENNOŚCI EMBEDDINGU (zamrożony vector_model_id
 * + inny model w settings → FAIL) oraz trasy preflight/schema-sync
 * (422 preflight_failed z listą naruszeń przy destrukcyjnym diffie schematu).
 */

/** Klient na mocku odpowiadającym tylko na login + projects/list (health check). */
function makeHealthyClient(): OpenSpgClient {
  const { impl } = makeMockFetch((path) => {
    if (path === '/v1/accounts/login') return loginResponse();
    if (path.startsWith('/v1/projects/list')) return jsonResponse(fixture('projects-list.json'));
    throw new Error(`mock: nieoczekiwana ścieżka ${path}`);
  });
  return new OpenSpgClient({
    baseUrl: 'http://release-openspg-server:8887',
    account: 'openspg',
    password: 'openspg@kag',
    fetchImpl: impl,
  });
}

function check(checks: PreflightCheck[], id: string): PreflightCheck {
  const found = checks.find((c) => c.id === id);
  expect(found, `brak checku ${id}`).toBeDefined();
  return found!;
}

/** Provisioning bazy w teście (bez jobów): draft → provisioning → active z projektem. */
function provisionKb(db: Db, namespace: string, content: string, vectorModelId: string, projectId: number): void {
  createKbEntry(db, { namespace, name: `Baza ${namespace}` });
  transitionKb(db, namespace, 'provisioning');
  finishProvisioning(db, namespace, {
    projectId,
    vectorModelId,
    hash: renderSchema(namespace).hash,
    content,
    createdBy: null,
  });
}

describe('preflightBuild — guard niezmienności embeddingu', () => {
  let db: Db;
  let config: AppConfig;

  beforeAll(() => {
    db = makeDb();
    config = makeKbTestConfig();
    provisionKb(
      db,
      'GuardDocs',
      renderSchema('GuardDocs').content,
      'inst1@text-embedding-3-small',
      7,
    );
  });

  afterAll(() => db.close());

  it('vector_model_id zamrożony + INNY model w settings → FAIL', async () => {
    seedEmbeddingsSettings(db, config, 'text-embedding-3-large');
    const result = await preflightBuild({ db, config, client: makeHealthyClient() }, 'GuardDocs');
    expect(result.ok).toBe(false);
    const emb = check(result.checks, 'embedding_model');
    expect(emb.ok).toBe(false);
    expect(emb.severity).toBe('error');
    expect(emb.message).toContain('NIE wolno zmieniać');
    expect(check(result.checks, 'kb_active').ok).toBe(true);
  });

  it('brak konfiguracji llm.embeddings przy zamrożonym modelu → FAIL', async () => {
    const bareDb = makeDb();
    provisionKb(bareDb, 'GuardDocs', renderSchema('GuardDocs').content, 'inst1@text-embedding-3-small', 7);
    const result = await preflightBuild({ db: bareDb, config, client: makeHealthyClient() }, 'GuardDocs');
    expect(check(result.checks, 'embedding_model').ok).toBe(false);
    expect(result.ok).toBe(false);
    bareDb.close();
  });

  it('zgodny model → check ok; komplet checków przechodzi po promocji draftu', async () => {
    seedEmbeddingsSettings(db, config, 'text-embedding-3-small');
    const before = await preflightBuild({ db, config, client: makeHealthyClient() }, 'GuardDocs');
    expect(check(before.checks, 'embedding_model').ok).toBe(true);
    expect(check(before.checks, 'promoted_drafts').ok).toBe(false); // brak eksportu
    expect(before.ok).toBe(false);

    const draft = createDraft(db, {
      title: 'Dokument do buildu',
      content: 'Treść dokumentu przechodzącego preflight.',
      sourceType: 'text',
      namespace: 'GuardDocs',
    });
    promoteDraft(db, draft.id, 'u-test');

    const after = await preflightBuild({ db, config, client: makeHealthyClient() }, 'GuardDocs');
    expect(after.checks.filter((c) => !c.ok)).toEqual([]);
    expect(after.ok).toBe(true);
  });
});

describe('trasy preflight i schema-sync', () => {
  let app: FastifyInstance;
  let db: Db;
  let config: AppConfig;
  let admin: AppUser;

  beforeAll(async () => {
    db = makeDb();
    config = makeKbTestConfig();
    admin = seedUser(db, 'u-admin', 'admin');
    seedEmbeddingsSettings(db, config, 'text-embedding-3-small');
    app = await buildApp({ config, db });
    app.addHook('onRequest', async (req) => {
      req.user = admin;
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  it('POST /kbs/:ns/preflight → 200 z checks[] (OpenSPG nieosiągalny w teście = check error)', async () => {
    provisionKb(db, 'RouteDocs', renderSchema('RouteDocs').content, 'inst1@text-embedding-3-small', 9);
    const res = await app.inject({ method: 'POST', url: '/api/v1/kbs/RouteDocs/preflight' });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(Array.isArray(data.checks)).toBe(true);
    expect(data.ok).toBe(false);
    const upstream = data.checks.find((c: PreflightCheck) => c.id === 'openspg_reachable');
    expect(upstream.ok).toBe(false);
    const emb = data.checks.find((c: PreflightCheck) => c.id === 'embedding_model');
    expect(emb.ok).toBe(true);
  });

  it('POST /kbs/:ns/schema-sync z destrukcyjnym diffem → 422 preflight_failed z listą naruszeń', async () => {
    // Stara wersja schematu ma pole, którego świeży render szablonu już nie ma
    // → diff wykrywa usunięcie pola (zmiana destrukcyjna, blokada).
    const oldContent = renderSchema('SyncDocs').content.replace(
      '\t\ttopicSlug(topicSlug): Text',
      '\t\tlegacyField(legacyField): Text\n\t\ttopicSlug(topicSlug): Text',
    );
    provisionKb(db, 'SyncDocs', oldContent, 'inst1@text-embedding-3-small', 11);

    const res = await app.inject({ method: 'POST', url: '/api/v1/kbs/SyncDocs/schema-sync' });
    expect(res.statusCode).toBe(422);
    const { error } = res.json();
    expect(error.code).toBe('preflight_failed');
    expect(error.details.checks).toHaveLength(1);
    expect(error.details.checks[0].message).toContain('usunięto pole Topic.legacyField');
  });

  it('POST /kbs/:ns/schema-sync bez naruszeń → 202 z actionId', async () => {
    provisionKb(db, 'CleanDocs', renderSchema('CleanDocs').content, 'inst1@text-embedding-3-small', 12);
    const res = await app.inject({ method: 'POST', url: '/api/v1/kbs/CleanDocs/schema-sync' });
    expect(res.statusCode).toBe(202);
    const { data } = res.json();
    expect(data.actionId).toMatch(/^act_/);
    expect(data.resource).toBe('kb:CleanDocs');

    // Job w tle na realnym (nieosiągalnym) kliencie — czekamy na status terminalny,
    // żeby test nie zostawił wiszącej asynchroniczności.
    const deadline = Date.now() + 5000;
    let status = 'running';
    while (Date.now() < deadline) {
      status = getAction(db, data.actionId)?.status ?? 'running';
      if (status !== 'running') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(status).toBe('error'); // commitSchema do openspg.test nie ma prawa przejść
  });
});
