import { describe, expect, it } from 'vitest';
import { buildMatchExpression, replaceForDocument, searchFts } from '../src/db/index.js';
import { testDb } from './helpers.js';

describe('repos/chunksMirror (FTS5 trigram)', () => {
  function seed(db: ReturnType<typeof testDb>) {
    replaceForDocument(db, 'LightingDocs', 'doc1', [
      {
        id: 'CHUNK_ld000001_001',
        title: 'Montaż szynoprzewodów',
        content: 'Przy montażu szynoprzewodach trójfazowych maksymalne obciążenie wynosi 16A.',
      },
      {
        id: 'CHUNK_ld000001_002',
        title: 'Sterowanie DALI',
        content: 'Magistrala DALI pozwala sterować oprawami indywidualnie.',
      },
    ]);
    replaceForDocument(db, 'OtherKb', 'doc2', [
      { id: 'OtherKb:Chunk:1', title: 'Szyny', content: 'Inne szynoprzewody w innej bazie.' },
    ]);
  }

  it('wyszukiwanie po polsku znajduje odmienione słowo (fleksja)', () => {
    const db = testDb();
    seed(db);
    // zapytanie w dopełniaczu, dokument ma miejscownik ('szynoprzewodach')
    const results = searchFts(db, 'szynoprzewodów obciążenie', ['LightingDocs'], 8);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('CHUNK_ld000001_001');
    expect(results[0]?.docId).toBe('doc1');
    expect(results[0]?.snippet).toContain('<b>');
    expect(results[0]?.bm25).toBeLessThan(0); // bm25() w SQLite: im mniejsze, tym lepsze
  });

  it('filtr namespaces zawęża wyniki; puste namespaces → brak wyników', () => {
    const db = testDb();
    seed(db);
    const both = searchFts(db, 'szynoprzewody', ['LightingDocs', 'OtherKb'], 8);
    expect(both.map((r) => r.namespace).sort()).toEqual(['LightingDocs', 'OtherKb']);
    expect(searchFts(db, 'szynoprzewody', [], 8)).toEqual([]);
  });

  it('zapytanie z cudzysłowami i interpunkcją nie psuje MATCH', () => {
    const db = testDb();
    seed(db);
    expect(() => searchFts(db, '"DALI" AND (sterowanie) OR *', ['LightingDocs'], 8)).not.toThrow();
    const results = searchFts(db, '"DALI" sterowanie!', ['LightingDocs'], 8);
    expect(results[0]?.id).toBe('CHUNK_ld000001_002');
    expect(buildMatchExpression('a b')).toBeNull(); // same krótkie tokeny → brak zapytania
  });

  it('replaceForDocument podmienia chunki dokumentu w transakcji', () => {
    const db = testDb();
    seed(db);
    replaceForDocument(db, 'LightingDocs', 'doc1', [
      { id: 'LightingDocs:Chunk:9', title: 'Nowy', content: 'Zupełnie nowa treść o czujnikach ruchu.' },
    ]);
    expect(searchFts(db, 'szynoprzewody', ['LightingDocs'], 8)).toEqual([]);
    expect(searchFts(db, 'czujniki ruchu', ['LightingDocs'], 8)[0]?.id).toBe('LightingDocs:Chunk:9');
  });
});

describe('polskie stopwordy i OR-fallback', () => {
  it('pytanie ze stopwordami ("Jaki ... ma ...?") znajduje treść', () => {
    const db = testDb();
    replaceForDocument(db, 'X', 'DOC_1', [
      { id: 'c1', title: 'HighBay', content: 'Oprawa HighBay LED 150W: strumień świetlny 21000 lm, stopień ochrony IP65.' },
    ]);
    const hits = searchFts(db, 'Jaki strumień świetlny i stopień ochrony ma oprawa HighBay 150W?', ['X'], 8);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.id).toBe('c1');
  });

  it('AND bez trafień degraduje do OR po najdłuższych rdzeniach', () => {
    const db = testDb();
    replaceForDocument(db, 'X', 'DOC_1', [
      { id: 'c1', title: 'Zasilacz', content: 'Zasilacz Meanwell z gwarancją pięcioletnią.' },
    ]);
    const hits = searchFts(db, 'zasilacz transformator', ['X'], 8);
    expect(hits.length).toBeGreaterThan(0);
  });
});
