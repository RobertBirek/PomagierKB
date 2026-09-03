/**
 * Parser front-matter lekcji (docs/lessons-convention.md) — CZYSTA logika.
 * Świadomie NIE jest pełnym YAML-em: czytamy wyłącznie płaskie `klucz: wartość`
 * z pierwszego bloku `---`…`---` i tylko znane pola. Nieznane/zepsute → null
 * (draft wyświetla się normalnie, bez chipa lekcji).
 */

export type LessonKind = 'lesson' | 'decision' | 'runbook';

export interface LessonMeta {
  kind: LessonKind;
  project: string | null;
  sessionDate: string | null;
  supersedes: string | null;
}

const KINDS = new Set<string>(['lesson', 'decision', 'runbook']);

export function parseLessonFrontmatter(content: string): LessonMeta | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!m) return null;
  const fields = new Map<string, string>();
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim());
    if (kv) fields.set(kv[1]!.toLowerCase(), kv[2]!.trim().replace(/^['"]|['"]$/g, ''));
  }
  const kind = fields.get('kind') ?? '';
  if (!KINDS.has(kind)) return null;
  const date = fields.get('session_date') ?? '';
  return {
    kind: kind as LessonKind,
    project: fields.get('project') ?? null,
    sessionDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    supersedes: fields.get('supersedes') ?? null,
  };
}
