/**
 * Mały walidator JSON Schema — wystarczający dla schematów narzędzi z §7.4:
 * type, required, properties, additionalProperties:false, enum, minLength/maxLength,
 * minimum/maximum, minItems/maxItems, items. Bez zod (schematy narzędzi są surowe).
 * Zwraca listę problemów PL (pusta = poprawne). Defaults NIE są aplikowane tutaj —
 * robią to same narzędzia.
 */

type SchemaObject = Record<string, unknown>;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(expected: string, value: unknown): boolean {
  switch (expected) {
    case 'object':
      return typeOf(value) === 'object';
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'null':
      return value === null;
    default:
      return true; // nieznany typ w schemacie — nie blokujemy
  }
}

export function validateInput(schema: unknown, value: unknown, path = '$'): string[] {
  const problems: string[] = [];
  if (typeof schema !== 'object' || schema === null) return problems;
  const s = schema as SchemaObject;

  if (typeof s.type === 'string' && !matchesType(s.type, value)) {
    problems.push(`${path}: oczekiwano typu ${s.type}, jest ${typeOf(value)}`);
    return problems; // dalsze checki nie mają sensu przy złym typie
  }

  if (Array.isArray(s.enum) && !s.enum.some((e) => e === value)) {
    problems.push(`${path}: wartość spoza enum [${s.enum.map(String).join(', ')}]`);
  }

  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) {
      problems.push(`${path}: za krótkie (min ${s.minLength} znaków)`);
    }
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) {
      problems.push(`${path}: za długie (max ${s.maxLength} znaków)`);
    }
  }

  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) {
      problems.push(`${path}: poniżej minimum ${s.minimum}`);
    }
    if (typeof s.maximum === 'number' && value > s.maximum) {
      problems.push(`${path}: powyżej maximum ${s.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) {
      problems.push(`${path}: za mało elementów (min ${s.minItems})`);
    }
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) {
      problems.push(`${path}: za dużo elementów (max ${s.maxItems})`);
    }
    if (typeof s.items === 'object' && s.items !== null) {
      value.forEach((item, i) => {
        problems.push(...validateInput(s.items, item, `${path}[${i}]`));
      });
    }
  }

  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    const props =
      typeof s.properties === 'object' && s.properties !== null
        ? (s.properties as Record<string, unknown>)
        : {};
    if (Array.isArray(s.required)) {
      for (const key of s.required) {
        if (typeof key === 'string' && !(key in obj)) {
          problems.push(`${path}: brak wymaganego pola '${key}'`);
        }
      }
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) problems.push(`${path}: nieznane pole '${key}'`);
      }
    }
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in obj) problems.push(...validateInput(propSchema, obj[key], `${path}.${key}`));
    }
  }

  return problems;
}
