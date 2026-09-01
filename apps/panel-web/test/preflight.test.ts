import { describe, expect, it } from 'vitest';
import {
  canBuild,
  groupPreflightChecks,
  preflightCheckLabelKey,
  type PreflightCheck,
} from '../src/lib/preflight';
import { pl } from '../src/i18n/pl';

const check = (id: string, ok: boolean, severity: 'error' | 'warn'): PreflightCheck => ({
  id,
  ok,
  severity,
  message: `komunikat ${id}`,
});

describe('groupPreflightChecks()', () => {
  it('dzieli checki na blokady / ostrzeżenia / zaliczone', () => {
    const groups = groupPreflightChecks([
      check('kb_active', true, 'error'),
      check('openspg_reachable', false, 'error'),
      check('embedding_model', false, 'warn'),
      check('promoted_drafts', true, 'error'),
    ]);
    expect(groups.blockers.map((c) => c.id)).toEqual(['openspg_reachable']);
    expect(groups.warnings.map((c) => c.id)).toEqual(['embedding_model']);
    expect(groups.passed.map((c) => c.id)).toEqual(['kb_active', 'promoted_drafts']);
  });

  it('zaliczony check severity=warn ląduje w passed, nie w warnings', () => {
    const groups = groupPreflightChecks([check('dirty_flag', true, 'warn')]);
    expect(groups.warnings).toEqual([]);
    expect(groups.passed).toHaveLength(1);
  });

  it('pusta lista → puste grupy', () => {
    expect(groupPreflightChecks([])).toEqual({ blockers: [], warnings: [], passed: [] });
  });
});

describe('canBuild()', () => {
  it('blokuje tylko przy nieprzeszłym checku severity=error', () => {
    expect(canBuild([check('kb_active', false, 'error')])).toBe(false);
    expect(canBuild([check('embedding_model', false, 'warn')])).toBe(true); // „Buduj mimo ostrzeżeń"
    expect(canBuild([check('kb_active', true, 'error')])).toBe(true);
    expect(canBuild([])).toBe(true);
  });
});

describe('preflightCheckLabelKey()', () => {
  it('znane checki backendu mają dedykowane etykiety PL', () => {
    for (const id of ['kb_active', 'embedding_model', 'openspg_reachable', 'promoted_drafts', 'no_running_build']) {
      const key = preflightCheckLabelKey(id);
      expect(key).not.toBe('kb.preflight.check.generic');
      expect(pl[key]).toBeTypeOf('string'); // klucz istnieje w słowniku
    }
  });

  it('nieznany check nie wycieka surowym id — dostaje etykietę ogólną', () => {
    expect(preflightCheckLabelKey('disk_space')).toBe('kb.preflight.check.generic');
    expect(pl[preflightCheckLabelKey('disk_space')]).toBeTypeOf('string');
  });
});
