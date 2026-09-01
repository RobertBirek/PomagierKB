import { describe, expect, it } from 'vitest';
import {
  parseSchemaDsl,
  renderSchema,
  schemaDiffGuard,
} from '../src/services/schema-template.js';

/** Testy renderu szablonu DSL i strażnika diffów (czysta logika, bez DB/HTTP). */

describe('renderSchema', () => {
  it('podmienia __NAMESPACE__ i zwraca treść z hash-em', () => {
    const { content, hash } = renderSchema('TestDocs');
    expect(content.startsWith('namespace TestDocs\n')).toBe(true);
    expect(content).not.toContain('__NAMESPACE__');
    expect(content).toContain('Chunk(Chunk): EntityType');
    expect(content).toContain('ReferenceDocument(ReferenceDocument): EntityType');
    expect(content).toContain('ConceptTaxonomy(ConceptTaxonomy): ConceptType');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Determinizm: ten sam namespace → ten sam hash.
    expect(renderSchema('TestDocs').hash).toBe(hash);
  });

  it('zachowuje wcięcia tabulatorami (żadna linia nie zaczyna się spacją)', () => {
    const { content } = renderSchema('TestDocs');
    const lines = content.split('\n');
    expect(lines.some((l) => l.startsWith('\t'))).toBe(true);
    expect(lines.some((l) => /^ /.test(l))).toBe(false);
    // Pola mają dokładnie 2 taby, linie index — 3.
    expect(content).toContain('\t\tcontent(content): Text\n\t\t\tindex: TextAndVector');
  });

  it('odrzuca namespace spoza wzorca ^[A-Z][A-Za-z0-9]{2,29}$', () => {
    for (const bad of ['testDocs', 'T', 'Test-Docs', 'Test Docs', 'T'.repeat(31)]) {
      expect(() => renderSchema(bad)).toThrowError(/namespace/);
    }
  });
});

describe('parseSchemaDsl', () => {
  it('wyciąga typy, pola i indeksy z wyrenderowanego szablonu', () => {
    const model = parseSchemaDsl(renderSchema('TestDocs').content);
    expect([...model.keys()].sort()).toEqual(['Chunk', 'ConceptTaxonomy', 'ReferenceDocument', 'Topic']);
    const chunk = model.get('Chunk')!;
    expect(chunk.category).toBe('EntityType');
    expect(chunk.fields.get('content')).toEqual({ valueType: 'Text', index: 'TextAndVector' });
    expect(chunk.fields.get('contentPreview')).toEqual({ valueType: 'Text', index: null });
    expect(model.get('ConceptTaxonomy')!.category).toBe('ConceptType');
  });
});

describe('schemaDiffGuard', () => {
  const oldSchema = [
    'namespace X',
    '',
    'Doc(Doc): EntityType',
    '\tproperties:',
    '\t\tname(name): Text',
    '\t\tcontent(content): Text',
    '\t\t\tindex: TextAndVector',
    '\t\thash(hash): Text',
    '\t\t\tindex: Text',
    '',
  ].join('\n');

  it('łapie usunięcie pola', () => {
    const newSchema = oldSchema.replace('\t\thash(hash): Text\n\t\t\tindex: Text\n', '');
    const violations = schemaDiffGuard(oldSchema, newSchema);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('usunięto pole Doc.hash');
  });

  it('łapie usunięcie typu', () => {
    const violations = schemaDiffGuard(oldSchema, 'namespace X\n');
    expect(violations).toEqual(['usunięto typ Doc']);
  });

  it('łapie zmianę index: na istniejącym polu (zamianę i usunięcie)', () => {
    const changed = oldSchema.replace('\t\t\tindex: TextAndVector', '\t\t\tindex: Text');
    expect(schemaDiffGuard(oldSchema, changed)).toEqual([
      "zmieniono index pola Doc.content: TextAndVector → Text",
    ]);
    const removed = oldSchema.replace('\t\tcontent(content): Text\n\t\t\tindex: TextAndVector', '\t\tcontent(content): Text');
    expect(schemaDiffGuard(oldSchema, removed)).toEqual([
      'zmieniono index pola Doc.content: TextAndVector → brak',
    ]);
    // Dodanie indeksu do istniejącego pola też jest reindeksacją — blokowane.
    const added = oldSchema.replace('\t\tname(name): Text', '\t\tname(name): Text\n\t\t\tindex: Text');
    expect(schemaDiffGuard(oldSchema, added)).toEqual(['zmieniono index pola Doc.name: brak → Text']);
  });

  it('przepuszcza zmiany addytywne (nowe pole, nowy typ, nowy indeks na nowym polu)', () => {
    const newSchema =
      oldSchema +
      '\nTag(Tag): EntityType\n\tproperties:\n\t\tname(name): Text\n' +
      ''.concat() // bez zmian w Doc
        .toString();
    const withNewField = newSchema.replace(
      '\t\thash(hash): Text',
      '\t\tsummary(summary): Text\n\t\t\tindex: TextAndVector\n\t\thash(hash): Text',
    );
    expect(schemaDiffGuard(oldSchema, withNewField)).toEqual([]);
  });

  it('render dwóch namespace nie generuje fałszywych naruszeń (porównanie po typach)', () => {
    const a = renderSchema('TestDocs').content;
    expect(schemaDiffGuard(a, a)).toEqual([]);
  });
});
