import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AREAS, loadCatalog } from '../src/templates.mjs';

const DIR = fileURLToPath(new URL('../templates/', import.meta.url));

describe('katalog szablonów w repo (templates/)', () => {
  const c = loadCatalog(DIR);
  it('zero błędnych plików', () => {
    expect(c.errors).toEqual([]);
  });
  it('każdy obszar ma zasady i szablony; co najmniej 46 szablonów', () => {
    for (const area of AREAS) {
      expect(c.rules[area], area).toBeTruthy();
      expect(c.templates.some((t) => t.area === area), area).toBe(true);
    }
    expect(c.templates.length).toBeGreaterThanOrEqual(46);
  });
});
