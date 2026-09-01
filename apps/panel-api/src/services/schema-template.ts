import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NAMESPACE_RE } from '@pomagierkb/shared/db';
import { AppError } from '@pomagierkb/shared/errors';

/**
 * Szablon schema DSL OpenSPG (schemas/document_kb.schema.tpl) + strażnik diffów.
 *
 * renderSchema: podmiana __NAMESPACE__ → walidacja (zero pozostałych placeholderów,
 * wcięcia wyłącznie TABEM — spacje psują parser DSL serwera).
 * schemaDiffGuard: parser typów/pól DSL i blokada zmian DESTRUKCYJNYCH
 * (usunięcie typu/pola, zmiana typu wartości lub index: na istniejącym polu);
 * zmiany addytywne (nowy typ, nowe pole) przechodzą.
 */

/**
 * Ścieżka szablonu względem tego pliku: src/services → 4 poziomy w górę = root repo
 * (identyczna głębokość po kompilacji: dist/services). W kontenerze szablon jest
 * kopiowany razem z repo (schemas/ obok apps/).
 */
const DEFAULT_TEMPLATE_PATH = fileURLToPath(
  new URL('../../../../schemas/document_kb.schema.tpl', import.meta.url),
);

/** Placeholdery w konwencji __NAZWA__ — po renderze nie może zostać żaden. */
const PLACEHOLDER_RE = /__[A-Z0-9_]+__/;

export interface RenderedSchema {
  /** Pełna treść pliku .schema gotowa do POST /v1/schemas. */
  content: string;
  /** sha256 hex treści — do kb_registry.schema_hash i schema_versions.hash. */
  hash: string;
}

export function sha256OfSchema(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Renderuje szablon dla namespace. Walidacje twarde (fail-closed):
 * - namespace wg ^[A-Z][A-Za-z0-9]{2,29}$ (ANGIELSKI — bug OpenSPG #753);
 * - po podmianie nie został ŻADEN placeholder __X__;
 * - wcięcia wyłącznie tabulatorami (linia zaczynająca się spacją = błąd);
 * - plik zaczyna się od 'namespace <ns>'.
 */
export function renderSchema(
  namespace: string,
  opts: { templatePath?: string } = {},
): RenderedSchema {
  if (!NAMESPACE_RE.test(namespace)) {
    throw new AppError(
      'validation_error',
      `namespace nie spełnia ^[A-Z][A-Za-z0-9]{2,29}$: ${namespace}`,
    );
  }
  const templatePath = opts.templatePath ?? DEFAULT_TEMPLATE_PATH;
  let template: string;
  try {
    template = readFileSync(templatePath, 'utf8');
  } catch (err) {
    throw new AppError('internal', `nie można odczytać szablonu schema: ${templatePath}`, {
      cause: (err as Error).message,
    });
  }
  if (!template.includes('__NAMESPACE__')) {
    throw new AppError('internal', 'szablon schema nie zawiera placeholdera __NAMESPACE__');
  }

  const content = template.replaceAll('__NAMESPACE__', namespace);

  const leftover = content.match(PLACEHOLDER_RE);
  if (leftover) {
    throw new AppError('internal', `w wyrenderowanym schemacie został placeholder: ${leftover[0]}`);
  }
  const lines = content.split('\n');
  const spaceIndented = lines.findIndex((l) => /^ /.test(l));
  if (spaceIndented !== -1) {
    throw new AppError(
      'internal',
      `schemat ma wcięcie spacją w linii ${spaceIndented + 1} — DSL wymaga tabulatorów`,
    );
  }
  if (!content.startsWith(`namespace ${namespace}`)) {
    throw new AppError('internal', 'wyrenderowany schemat nie zaczyna się od "namespace <ns>"');
  }

  return { content, hash: sha256OfSchema(content) };
}

// ── Parser DSL (na potrzeby diffów — nie pełny parser OpenSPG) ──────────────

export interface SchemaFieldDef {
  /** Typ wartości pola (u nas zawsze 'Text', ale porównujemy generycznie). */
  valueType: string;
  /** Wartość linii 'index:' (np. 'Text', 'TextAndVector') albo null gdy brak indeksu. */
  index: string | null;
}

export interface SchemaTypeDef {
  /** 'EntityType' | 'ConceptType'. */
  category: string;
  fields: Map<string, SchemaFieldDef>;
}

const TYPE_LINE_RE = /^([A-Za-z][A-Za-z0-9]*)\(([^)]*)\):\s*(EntityType|ConceptType)\s*$/;
const FIELD_LINE_RE = /^\t\t([A-Za-z][A-Za-z0-9]*)\(([^)]*)\):\s*([A-Za-z][A-Za-z0-9]*)\s*$/;
const INDEX_LINE_RE = /^\t\t\tindex:\s*(\S+)\s*$/;

/**
 * Parsuje DSL do mapy typ → {category, fields}. Linie spoza wzorców
 * (namespace, properties:, hypernymPredicate:) są pomijane — parser służy
 * WYŁĄCZNIE do porównywania wersji, nie do walidacji składni serwera.
 */
export function parseSchemaDsl(content: string): Map<string, SchemaTypeDef> {
  const types = new Map<string, SchemaTypeDef>();
  let currentType: SchemaTypeDef | null = null;
  let lastField: SchemaFieldDef | null = null;

  for (const line of content.split('\n')) {
    const typeMatch = TYPE_LINE_RE.exec(line);
    if (typeMatch) {
      currentType = { category: typeMatch[3]!, fields: new Map() };
      types.set(typeMatch[1]!, currentType);
      lastField = null;
      continue;
    }
    const fieldMatch = FIELD_LINE_RE.exec(line);
    if (fieldMatch && currentType) {
      lastField = { valueType: fieldMatch[3]!, index: null };
      currentType.fields.set(fieldMatch[1]!, lastField);
      continue;
    }
    const indexMatch = INDEX_LINE_RE.exec(line);
    if (indexMatch && lastField) {
      lastField.index = indexMatch[1]!;
    }
  }
  return types;
}

/**
 * Strażnik zmian schematu: porównuje starą i nową treść DSL i zwraca listę
 * naruszeń (pusta = zmiana czysto addytywna, bezpieczna do commitSchema).
 * DESTRUKCYJNE (blokowane): usunięcie typu, zmiana kategorii typu, usunięcie
 * pola, zmiana typu wartości pola, KAŻDA zmiana 'index:' na istniejącym polu
 * (dodanie/usunięcie/zamiana — reindeksacja psuje wektory i wyszukiwanie).
 */
export function schemaDiffGuard(oldContent: string, newContent: string): string[] {
  const oldTypes = parseSchemaDsl(oldContent);
  const newTypes = parseSchemaDsl(newContent);
  const violations: string[] = [];
  const show = (v: string | null): string => (v === null ? 'brak' : v);

  for (const [typeName, oldDef] of oldTypes) {
    const newDef = newTypes.get(typeName);
    if (!newDef) {
      violations.push(`usunięto typ ${typeName}`);
      continue;
    }
    if (newDef.category !== oldDef.category) {
      violations.push(
        `zmieniono kategorię typu ${typeName}: ${oldDef.category} → ${newDef.category}`,
      );
    }
    for (const [fieldName, oldField] of oldDef.fields) {
      const newField = newDef.fields.get(fieldName);
      if (!newField) {
        violations.push(`usunięto pole ${typeName}.${fieldName}`);
        continue;
      }
      if (newField.valueType !== oldField.valueType) {
        violations.push(
          `zmieniono typ pola ${typeName}.${fieldName}: ${oldField.valueType} → ${newField.valueType}`,
        );
      }
      if (newField.index !== oldField.index) {
        violations.push(
          `zmieniono index pola ${typeName}.${fieldName}: ${show(oldField.index)} → ${show(newField.index)}`,
        );
      }
    }
  }
  return violations;
}
