import { describe, expect, it } from 'vitest';
import { parseLessonFrontmatter, parseSourceFrontmatter, stripFrontmatter } from '../src/pipeline/frontmatter.js';
import { cleanContent } from '../src/pipeline/clean.js';

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

describe('stripFrontmatter + kolejność względem cleanera (GAP-03)', () => {
  it('zdejmuje blok --- z początku i zostawia resztę nietkniętą', () => {
    const text = '---\nowner: InsERT S.A.\nlicense: producent\ndate: 2026-09-09\n---\n# Tytuł\n\nTreść.\n';
    expect(stripFrontmatter(text)).toBe('# Tytuł\n\nTreść.\n');
    expect(parseSourceFrontmatter(text)).toEqual({ owner: 'InsERT S.A.', license: 'producent', date: '2026-09-09', supersedes: null });
  });

  it('bez front-mattera zwraca treść bez zmian; blok w środku nie jest ruszany', () => {
    expect(stripFrontmatter('# A\n\n---\nowner: x\n---\n')).toBe('# A\n\n---\nowner: x\n---\n');
    expect(stripFrontmatter('zwykły tekst')).toBe('zwykły tekst');
  });

  it('po cleanerze ograniczniki znikają — dlatego metadane muszą być czytane PRZED czyszczeniem', () => {
    const text = '---\nowner: InsERT S.A.\n---\n# T\n\nTreść.\n';
    const cleaned = cleanContent(text, 'generic').text;
    expect(cleaned).not.toMatch(/^---$/m);
    expect(parseSourceFrontmatter(cleaned).owner).toBeNull();
    expect(parseSourceFrontmatter(text).owner).toBe('InsERT S.A.');
  });
});
