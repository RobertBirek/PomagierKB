import { describe, expect, it } from 'vitest';
import { can, PAGE_PERMISSION, type Permission, type Role } from '../src/lib/permissions';

describe('can()', () => {
  it('viewer: pyta, daje feedback i proponuje treść — nic operacyjnego', () => {
    expect(can('viewer', 'ask')).toBe(true);
    expect(can('viewer', 'feedback')).toBe(true);
    expect(can('viewer', 'propose')).toBe(true);
    expect(can('viewer', 'inbox')).toBe(false);
    expect(can('viewer', 'kb-build')).toBe(false);
    expect(can('viewer', 'mcp')).toBe(false);
    expect(can('viewer', 'settings')).toBe(false);
  });

  it('operator: wszystko viewera + inbox/content/kb-build/gaps, bez adminowych', () => {
    expect(can('operator', 'ask')).toBe(true);
    expect(can('operator', 'inbox')).toBe(true);
    expect(can('operator', 'content')).toBe(true);
    expect(can('operator', 'kb-build')).toBe(true);
    expect(can('operator', 'gaps')).toBe(true);
    expect(can('operator', 'kb-create')).toBe(false);
    expect(can('operator', 'mcp')).toBe(false);
    expect(can('operator', 'settings')).toBe(false);
  });

  it('admin: wszystkie uprawnienia', () => {
    const all: Permission[] = [
      'ask', 'feedback', 'propose', 'inbox', 'content',
      'kb-build', 'gaps', 'kb-create', 'mcp', 'settings',
    ];
    for (const perm of all) expect(can('admin', perm)).toBe(true);
  });

  it('fail-closed: brak roli / nieznana rola → false', () => {
    expect(can(null, 'ask')).toBe(false);
    expect(can(undefined, 'ask')).toBe(false);
    expect(can('root' as Role, 'ask')).toBe(false);
  });
});

describe('PAGE_PERMISSION', () => {
  it('pokrywa wszystkie strony shellu', () => {
    expect(Object.keys(PAGE_PERMISSION).sort()).toEqual(
      ['/add', '/ask', '/inbox', '/kb', '/mcp', '/overview', '/settings'],
    );
  });

  it('viewer widzi tylko /ask i /add', () => {
    const visible = Object.entries(PAGE_PERMISSION)
      .filter(([, perm]) => can('viewer', perm))
      .map(([path]) => path)
      .sort();
    expect(visible).toEqual(['/add', '/ask', '/overview']);
  });
});
