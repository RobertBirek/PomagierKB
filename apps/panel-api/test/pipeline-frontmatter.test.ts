import { describe, expect, it } from 'vitest';
import { parseLessonFrontmatter } from '../src/pipeline/frontmatter.js';

/** Parser front-matter lekcji (docs/lessons-convention.md) — pure. */

describe('parseLessonFrontmatter', () => {
  it('parsuje kind/project/session_date/supersedes z bloku ---', () => {
    const md = [
      '---',
      'kind: lesson',
      'project: pomagierkb',
      'session_date: 2026-09-03',
      'supersedes: draft_2026-09-01_ab12cd34_stara-lekcja',
      '---',
      '',
      '## Kontekst',
      'Treść.',
    ].join('\n');
    expect(parseLessonFrontmatter(md)).toEqual({
      kind: 'lesson',
      project: 'pomagierkb',
      sessionDate: '2026-09-03',
      supersedes: 'draft_2026-09-01_ab12cd34_stara-lekcja',
    });
  });

  it('kind decision/runbook przechodzi; nieznany kind → null', () => {
    const make = (kind: string): string => `---\nkind: ${kind}\nproject: x\n---\ntreść`;
    expect(parseLessonFrontmatter(make('decision'))?.kind).toBe('decision');
    expect(parseLessonFrontmatter(make('runbook'))?.kind).toBe('runbook');
    expect(parseLessonFrontmatter(make('notatka'))).toBeNull();
  });

  it('brak front-mattera / zepsuty blok / zła data → defensywnie', () => {
    expect(parseLessonFrontmatter('# Zwykły dokument\ntreść')).toBeNull();
    expect(parseLessonFrontmatter('---\nkind: lesson')).toBeNull(); // niedomknięty
    const badDate = parseLessonFrontmatter('---\nkind: lesson\nsession_date: wczoraj\n---\nx');
    expect(badDate).toEqual({ kind: 'lesson', project: null, sessionDate: null, supersedes: null });
  });

  it('front-matter musi być na POCZĄTKU treści (nie w środku)', () => {
    expect(parseLessonFrontmatter('wstęp\n---\nkind: lesson\n---\n')).toBeNull();
  });
});
