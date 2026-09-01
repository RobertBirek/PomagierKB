import { describe, expect, it } from 'vitest';
import {
  isValidNamespace,
  namespaceProblem,
  suggestNamespace,
  NAMESPACE_REGEX,
} from '../src/lib/namespace';

describe('isValidNamespace()', () => {
  it('akceptuje PascalCase 3–30 znaków zgodny z kontraktem panel-api', () => {
    expect(isValidNamespace('LightingDocs')).toBe(true);
    expect(isValidNamespace('Abc')).toBe(true);
    expect(isValidNamespace('A12')).toBe(true);
    expect(isValidNamespace('A' + 'b'.repeat(29))).toBe(true); // dokładnie 30
  });

  it('odrzuca: za krótkie, za długie, zły start, złe znaki', () => {
    expect(isValidNamespace('')).toBe(false);
    expect(isValidNamespace('Ab')).toBe(false); // 2 znaki
    expect(isValidNamespace('A' + 'b'.repeat(30))).toBe(false); // 31 znaków
    expect(isValidNamespace('lighting')).toBe(false); // mała litera na starcie
    expect(isValidNamespace('1Docs')).toBe(false); // cyfra na starcie
    expect(isValidNamespace('Moja Baza')).toBe(false); // spacja
    expect(isValidNamespace('Łuki')).toBe(false); // polski znak
    expect(isValidNamespace('Kb_test')).toBe(false); // podkreślnik
  });

  it('wzorzec jest identyczny z NAMESPACE_PATTERN backendu', () => {
    expect(NAMESPACE_REGEX.source).toBe('^[A-Z][A-Za-z0-9]{2,29}$');
  });
});

describe('namespaceProblem()', () => {
  it('rozpoznaje konkretny problem (komunikat PL per przypadek)', () => {
    expect(namespaceProblem('')).toBe('empty');
    expect(namespaceProblem('Moja Baza')).toBe('badChars');
    expect(namespaceProblem('Żarówki')).toBe('badChars');
    expect(namespaceProblem('abc')).toBe('badStart');
    expect(namespaceProblem('9abc')).toBe('badStart');
    expect(namespaceProblem('Ab')).toBe('tooShort');
    expect(namespaceProblem('A' + 'b'.repeat(30))).toBe('tooLong');
    expect(namespaceProblem('LightingDocs')).toBe(null);
  });
});

describe('suggestNamespace()', () => {
  it('transliteruje polskie znaki i skleja słowa w PascalCase', () => {
    expect(suggestNamespace('Katalog produktów')).toBe('KatalogProduktow');
    expect(suggestNamespace('oświetlenie żarówki LED')).toBe('OswietlenieZarowkiLED');
    expect(suggestNamespace('procedury serwisowe')).toBe('ProcedurySerwisowe');
  });

  it('wynik zawsze przechodzi walidację (albo jest pusty)', () => {
    const cases = ['Katalog produktów', 'a', '!!!', '2024 cennik', 'oś', 'Bazą wiedzy — ILL (2026)!'];
    for (const name of cases) {
      const suggestion = suggestNamespace(name);
      if (suggestion !== '') expect(isValidNamespace(suggestion)).toBe(true);
    }
  });

  it('nazwa zaczynająca się cyfrą dostaje prefiks, krótka jest dopełniana', () => {
    expect(suggestNamespace('2024 cennik')).toBe('Kb2024Cennik');
    expect(suggestNamespace('oś')).toBe('OsK'); // 'Os' + dopełnienie do 3 znaków
  });

  it('obcina do 30 znaków', () => {
    const long = suggestNamespace('bardzo długa nazwa bazy wiedzy o oprawach oświetleniowych zewnętrznych');
    expect(long.length).toBeLessThanOrEqual(30);
    expect(isValidNamespace(long)).toBe(true);
  });

  it('nic-nie-da-się-zbudować → pusty string (UI zostawia pole)', () => {
    expect(suggestNamespace('')).toBe('');
    expect(suggestNamespace('!!! ???')).toBe('');
  });
});
