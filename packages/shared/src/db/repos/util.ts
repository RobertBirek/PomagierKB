import { createHash, randomBytes } from 'node:crypto';

/** Wspólne pomocniki repozytoriów (id, slug, hash, JSON). */

export function hex8(): string {
  return randomBytes(4).toString('hex');
}

/** 'yyyymmdd' w UTC — do id akcji/luk. */
export function ymd(date = new Date()): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

/** 'yyyy-mm-dd' w UTC — do id draftów i limitów dziennych. */
export function ymdDashed(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Slug z tytułu: bez diakrytyków, małe litery, '-' zamiast reszty, ≤40 znaków. */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'l')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'bez-tytulu';
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text == null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Czy błąd better-sqlite3 to naruszenie ograniczenia (UNIQUE/CHECK/FK). */
export function isConstraintError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    (err as { code: string }).code.startsWith('SQLITE_CONSTRAINT')
  );
}
