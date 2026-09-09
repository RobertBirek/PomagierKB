/**
 * Parser front-matter (docs/lessons-convention.md) — CZYSTA logika.
 * Świadomie NIE jest pełnym YAML-em: czytamy wyłącznie płaskie `klucz: wartość`
 * z pierwszego bloku `---`…`---` i tylko znane pola. Nieznane/zepsute → null
 * (draft wyświetla się normalnie, bez chipa lekcji).
 *
 * Dwa poziomy odczytu:
 *  - parseLessonFrontmatter — metadane lekcji (wymaga poprawnego `kind`);
 *  - parseSourceFrontmatter — metadane ŹRÓDŁA i precedencji (owner/license/date/
 *    supersedes), czytane dla KAŻDEGO dokumentu, bo reguła zastępowania (GAP-02)
 *    i atrybuty źródła (GAP-03) nie są związane z konwencją lekcji.
 */

export type LessonKind = 'lesson' | 'decision' | 'runbook';

export interface LessonMeta {
  kind: LessonKind;
  project: string | null;
  sessionDate: string | null;
  supersedes: string | null;
}

/** Metadane źródła i precedencji z front-mattera (wszystkie opcjonalne). */
export interface SourceMeta {
  /** Kto odpowiada merytorycznie za treść (`owner:` / `wlasciciel:`). */
  owner: string | null;
  /** Licencja treści (`license:` / `licencja:`) — czy wolno reprodukować. */
  license: string | null;
  /** Data SAMEGO dokumentu w formacie YYYY-MM-DD (`date:` / `source_date:`). */
  date: string | null;
  /** Id draftu, który ten dokument zastępuje (reguła precedencji). */
  supersedes: string | null;
}

const KINDS = new Set<string>(['lesson', 'decision', 'runbook']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Limit pojedynczej wartości metadanej — front-matter bywa wklejany maszynowo. */
const VALUE_MAX = 200;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Zdejmuje blok front-mattera z początku treści (zwraca resztę). Wywoływane PRZED czyszczeniem,
 * bo reguła BASE_DROP `^[-–—•.\s]*$` kasuje linie `---` i front-matter zostawał w treści jako
 * gołe „owner: …" bez metadanych (parser widział już tekst bez ograniczników).
 */
export function stripFrontmatter(content: string): string {
  return FRONTMATTER_RE.test(content) ? content.replace(FRONTMATTER_RE, '') : content;
}

/** Płaskie pary klucz→wartość z pierwszego bloku `---`…`---` (klucze lowercase). */
function frontmatterFields(content: string): Map<string, string> | null {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return null;
  const fields = new Map<string, string>();
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim());
    if (kv) fields.set(kv[1]!.toLowerCase(), kv[2]!.trim().replace(/^['"]|['"]$/g, ''));
  }
  return fields;
}

function pick(fields: Map<string, string>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = fields.get(key);
    if (value !== undefined && value !== '') return value.slice(0, VALUE_MAX);
  }
  return null;
}

export function parseLessonFrontmatter(content: string): LessonMeta | null {
  const fields = frontmatterFields(content);
  if (fields === null) return null;
  const kind = fields.get('kind') ?? '';
  if (!KINDS.has(kind)) return null;
  const date = fields.get('session_date') ?? '';
  return {
    kind: kind as LessonKind,
    project: fields.get('project') ?? null,
    sessionDate: ISO_DATE_RE.test(date) ? date : null,
    supersedes: fields.get('supersedes') ?? null,
  };
}

/** Metadane źródła/precedencji — bez wymogu `kind` (GAP-02, GAP-03). */
export function parseSourceFrontmatter(content: string): SourceMeta {
  const empty: SourceMeta = { owner: null, license: null, date: null, supersedes: null };
  const fields = frontmatterFields(content);
  if (fields === null) return empty;
  const date = pick(fields, ['source_date', 'document_date', 'date', 'data']);
  return {
    owner: pick(fields, ['owner', 'wlasciciel', 'właściciel', 'source_owner']),
    license: pick(fields, ['license', 'licencja', 'source_license']),
    date: date !== null && ISO_DATE_RE.test(date) ? date : null,
    supersedes: pick(fields, ['supersedes', 'zastepuje', 'zastępuje']),
  };
}
