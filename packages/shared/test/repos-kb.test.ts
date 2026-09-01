import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import {
  clearDirty,
  createKb,
  createProfile,
  deriveJobPrefix,
  getKbOrThrow,
  getProfileOrThrow,
  listKbs,
  markDirty,
  resolveNamespaces,
  setDefaultKb,
  setProvisioned,
  transitionKb,
} from '../src/db/index.js';
import { testDb } from './helpers.js';

describe('repos/kbRegistry', () => {
  it('create: walidacja namespace i auto job_prefix; duplikat → conflict', () => {
    const db = testDb();
    const kb = createKb(db, { namespace: 'LightingDocs', name: 'Dokumentacja oświetlenia' });
    expect(kb.status).toBe('draft');
    expect(kb.job_prefix).toBe('LD');
    expect(deriveJobPrefix('ABCDEFGHIJK')).toBe('ABCDEFGH'); // ≤8

    for (const bad of ['lighting', 'Ab', 'Zażółć', 'X'.repeat(31)]) {
      expect(() => createKb(db, { namespace: bad, name: 'x' })).toThrowError(/namespace/);
    }
    try {
      createKb(db, { namespace: 'LightingDocs', name: 'duplikat' });
      expect.unreachable('powinno rzucić');
    } catch (err) {
      expect((err as AppError).code).toBe('conflict');
    }
  });

  it('przejścia stanów: draft→provisioning→active→archived; nielegalne → conflict', () => {
    const db = testDb();
    createKb(db, { namespace: 'FlowKb', name: 'Flow' });
    expect(() => transitionKb(db, 'FlowKb', 'active')).toThrowError(/przejście/); // draft→active nielegalne
    expect(transitionKb(db, 'FlowKb', 'provisioning').status).toBe('provisioning');
    expect(transitionKb(db, 'FlowKb', 'error').status).toBe('error');
    expect(transitionKb(db, 'FlowKb', 'provisioning').status).toBe('provisioning'); // retry
    expect(transitionKb(db, 'FlowKb', 'active').status).toBe('active');
    expect(transitionKb(db, 'FlowKb', 'archived').status).toBe('archived');
    expect(() => transitionKb(db, 'FlowKb', 'active')).toThrowError(/przejście/); // archived jest terminalny
  });

  it('setProvisioned zapisuje projectId + zamrożony vector_model_id; dirty flagi; setDefault dokładnie jeden', () => {
    const db = testDb();
    createKb(db, { namespace: 'AlphaKb', name: 'A' });
    createKb(db, { namespace: 'BetaKb', name: 'B' });

    const provisioned = setProvisioned(db, 'AlphaKb', 7, 'inst-1@text-embedding-3-small', 'abc123');
    expect(provisioned.project_id).toBe(7);
    expect(provisioned.vector_model_id).toBe('inst-1@text-embedding-3-small');
    expect(provisioned.schema_hash).toBe('abc123');
    expect(provisioned.schema_version).toBe(1);

    markDirty(db, 'AlphaKb');
    expect(getKbOrThrow(db, 'AlphaKb').dirty).toBe(1);
    clearDirty(db, 'AlphaKb');
    expect(getKbOrThrow(db, 'AlphaKb').dirty).toBe(0);

    setDefaultKb(db, 'AlphaKb');
    setDefaultKb(db, 'BetaKb');
    const defaults = listKbs(db).filter((k) => k.is_default === 1);
    expect(defaults.map((k) => k.namespace)).toEqual(['BetaKb']);
  });

  it('resolveNamespaces profilu: NULL = wszystkie active; lista = przecięcie z active', () => {
    const db = testDb();
    for (const ns of ['ActiveA', 'ActiveB', 'DraftC']) createKb(db, { namespace: ns, name: ns });
    for (const ns of ['ActiveA', 'ActiveB']) {
      transitionKb(db, ns, 'provisioning');
      transitionKb(db, ns, 'active');
    }
    // seedowany profil 'default' ma namespaces_json = NULL
    expect(resolveNamespaces(db, getProfileOrThrow(db, 'default'))).toEqual(['ActiveA', 'ActiveB']);

    const scoped = createProfile(db, {
      id: 'waski',
      name: 'Wąski',
      tools: ['kb_search'],
      namespaces: ['ActiveB', 'DraftC'],
    });
    expect(resolveNamespaces(db, scoped)).toEqual(['ActiveB']); // DraftC nie jest active
  });
});
