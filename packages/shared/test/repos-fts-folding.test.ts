import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildFtsSnippet,
  buildMatchExpression,
  buildOrMatchExpression,
  createKb,
  foldPolish,
  listMigrationFiles,
  openDb,
  queryStems,
  replaceForDocument,
  searchFts,
  stemPolish,
  type Db,
} from '../src/db/index.js';
import { testDb } from './helpers.js';

/**
 * D8-04/D8-05 — FTS5 po polsku: składanie diakrytyków (także 'ł'), lekki stemmer
 * zamiast „utnij 2 znaki", znakowanie luźnego fallbacku OR i snippety o użytecznej
 * długości. Korpus = REALNA treść bazy StagingSmoke (audyt: evidence/mirror-chunks).
 */

const NS = 'StagingSmoke';

/** 1:1 treść produkcyjnych chunków CHUNK_EF8A5D4D_000/_001 (audyt D8). */
function seedRealCorpus(db: Db): void {
  createKb(db, { namespace: NS, name: 'Staging' });
  db.prepare("UPDATE kb_registry SET status = 'active' WHERE namespace = ?").run(NS);
  replaceForDocument(db, NS, 'DOC_EF8A5D4D_OPRAWA_HIGHBAY_LED_150W_KARTA_PRODUKTU', [
    {
      id: 'CHUNK_EF8A5D4D_000',
      title: 'Oprawa HighBay LED 150W — karta produktu',
      sectionHeading: 'Oprawa HighBay LED 150W — karta produktu',
      sourceRef: 'highbay-150w.md',
      content:
        '# Oprawa HighBay LED 150W — karta produktu\n\n' +
        'Oprawa przemysłowa HighBay LED 150W przeznaczona do magazynów wysokiego składowania.\n' +
        'Strumień świetlny: 21000 lm, skuteczność 140 lm/W. Stopień ochrony IP65, odporność IK08.\n' +
        'Barwa światła 4000K (neutralna), współczynnik CRI powyżej 80. Zasilacz Meanwell z 5-letnią gwarancją.\n' +
        'Montaż na haku lub uchwycie; zalecana wysokość zawieszenia 6-12 metrów.',
    },
    {
      id: 'CHUNK_EF8A5D4D_001',
      title: 'Oprawa HighBay LED 150W — karta produktu',
      sectionHeading: 'Sterowanie',
      sourceRef: 'highbay-150w.md',
      content:
        '## Sterowanie\n' +
        'Wersja DALI-2 pozwala na ściemnianie i integrację z systemem zarządzania budynkiem.\n' +
        'Czujnik ruchu (opcja) ogranicza zużycie energii do 40% w strefach o małym ruchu.',
    },
  ]);
}

describe('foldPolish / stemPolish (czysta logika)', () => {
  it('składa polskie znaki łącznie z ł (NFD ich nie rozkłada)', () => {
    expect(foldPolish('Światła')).toBe('swiatla');
    expect(foldPolish('PRZEMYSŁOWYCH')).toBe('przemyslowych');
    expect(foldPolish('gwarancją')).toBe('gwarancja');
    expect(foldPolish('Łuk')).toBe('luk');
    expect(foldPolish('ściemnianie')).toBe('sciemnianie');
  });

  it('stemmer zdejmuje końcówkę fleksyjną, nie ślepe 2 znaki', () => {
    expect(stemPolish('strumienia')).toBe('strumien'); // stare '-2' dawało 'strumieni'
    expect(stemPolish('strumieniem')).toBe('strumien');
    expect(stemPolish('przemyslowych')).toBe('przemyslow');
    expect(stemPolish('haka')).toBe('hak'); // 4 znaki — stare '-2' zostawiało 'haka'
    expect(stemPolish('oprawy')).toBe('opraw');
    expect(stemPolish('ip65')).toBe('ip65'); // token z cyfrą nietykalny
    expect(stemPolish('led')).toBe('led'); // za krótki na stemming
  });

  it('para krótkich tokenów tworzących kod („IP 65") przeżywa jako grupa OR', () => {
    const expr = buildMatchExpression('stopień IP 65');
    expect(expr).toContain('"ip65"');
    expect(expr).toContain('"ip 65"');
    // sam krótki token bez pary jest odrzucany (trigram i tak go nie dopasuje)
    expect(buildMatchExpression('lm')).toBeNull();
  });

  it('OR-fallback tylko po rdzeniach ≥5 znaków (koniec fałszywek typu „świa")', () => {
    const or = buildOrMatchExpression('kto wygrał mistrzostwa świata w piłce nożnej');
    expect(or).not.toBeNull();
    expect(or).not.toContain('"swia"');
    expect(queryStems('kto wygrał mistrzostwa świata')).toContain('mistrzostw');
  });
});

describe('searchFts na realnym korpusie StagingSmoke', () => {
  it('fleksja i alternacje trafiają (regresja D8-04)', () => {
    const db = testDb();
    seedRealCorpus(db);
    for (const q of [
      'strumienia świetlnego',
      'strumieniem świetlnym',
      'opraw przemysłowych LED',
      'montaż na haka',
      'ściemnianie DALI',
    ]) {
      expect(searchFts(db, q, [NS], 8).length, `zapytanie: ${q}`).toBeGreaterThan(0);
    }
  });

  it('wejście bez ogonków trafia w treść z ogonkami (regresja D8-04)', () => {
    const db = testDb();
    seedRealCorpus(db);
    for (const q of ['strumien swietlny', 'sciemnianie', 'swiatla barwa', 'oprawa przemyslowa']) {
      expect(searchFts(db, q, [NS], 8).length, `zapytanie: ${q}`).toBeGreaterThan(0);
    }
  });

  it('kod „IP 65" znajduje treść „IP65"', () => {
    const db = testDb();
    seedRealCorpus(db);
    expect(searchFts(db, 'stopień ochrony IP 65', [NS], 8).length).toBeGreaterThan(0);
  });

  it('trafienia merytoryczne mają matchKind=and, szum spoza bazy tylko or', () => {
    const db = testDb();
    seedRealCorpus(db);
    expect(searchFts(db, 'strumień świetlny oprawy', [NS], 8)[0]?.matchKind).toBe('and');
    // adwersarialne negatywy z audytu (dzielą słownictwo z korpusem przez trigram)
    for (const q of [
      'kto wygrał mistrzostwa świata w piłce nożnej',
      'procedura zgłaszania urlopu w systemie kadrowym',
      'maksymalne stawki podatku od nieruchomości',
      'systemy operacyjne w komputerach',
    ]) {
      const hits = searchFts(db, q, [NS], 8);
      expect(hits.every((h) => h.matchKind === 'or'), `negatyw '${q}' dopasowany AND-em`).toBe(true);
    }
  });

  it('snippet ma użyteczną długość i całe słowa (regresja D8-05)', () => {
    const db = testDb();
    seedRealCorpus(db);
    const hit = searchFts(db, 'czujnik ruchu zużycie energii', [NS], 8)[0];
    expect(hit).toBeDefined();
    const plain = hit!.snippet.replace(/<\/?b>/g, '');
    expect(plain.length).toBeGreaterThanOrEqual(120);
    expect(hit!.snippet).toContain('<b>');
    // podświetlone są CAŁE słowa — nigdy '<b>Czujn</b>ik'
    for (const m of hit!.snippet.matchAll(/<b>([^<]+)<\/b>/g)) {
      expect(m[1]).not.toMatch(/^\S*<|>\S*$/);
      expect(m[1]!.trim()).toBe(m[1]);
    }
    expect(hit!.snippet).not.toContain('<b>Czujn</b>ik');
  });

  it('buildFtsSnippet: okno wokół pierwszego trafienia, elipsy na obciętych krawędziach', () => {
    const content = `${'x '.repeat(200)}strumień świetlny oprawy${' y'.repeat(200)}`;
    const snip = buildFtsSnippet(content, ['strumien', 'swietln']);
    expect(snip.startsWith('…')).toBe(true);
    expect(snip.endsWith('…')).toBe(true);
    expect(snip).toContain('<b>strumień</b>');
    expect(snip.replace(/<\/?b>/g, '').replace(/…/g, '').length).toBeLessThanOrEqual(320);
  });
});

describe('migracja 0047: przebudowa indeksu FTS na istniejących danych', () => {
  it('chunki sprzed migracji stają się wyszukiwalne bez ogonków, triggery działają dalej', () => {
    const dir = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
    const files = listMigrationFiles(dir);
    const g4 = files.find((f) => f.name.startsWith('0047_g4_'));
    expect(g4, 'migracja 0047_g4_fts_folding.sql musi istnieć').toBeDefined();

    // Baza w stanie SPRZED naprawy (tokenize='trigram' bez składania diakrytyków).
    const db = openDb(':memory:');
    for (const m of files.filter((f) => f.id <= 7)) db.exec(readFileSync(m.path, 'utf8'));
    createKb(db, { namespace: 'TestKb', name: 'Test' });
    replaceForDocument(db, 'TestKb', 'DOC_1', [
      { id: 'C1', title: 'Oprawa przemysłowa', content: 'Barwa światła 4000K, montaż na haku, oprawa przemysłowa LED.' },
    ]);
    expect(searchFts(db, 'swiatla', ['TestKb'], 5)).toHaveLength(0); // stan sprzed naprawy

    db.exec(readFileSync(g4!.path, 'utf8'));

    // rebuild objął dane wstawione PRZED migracją
    expect(searchFts(db, 'swiatla', ['TestKb'], 5)).toHaveLength(1);
    expect(searchFts(db, 'przemyslowej', ['TestKb'], 5)).toHaveLength(1);
    expect(searchFts(db, 'haka', ['TestKb'], 5)).toHaveLength(1);

    // nowe triggery indeksują dane wstawione PO migracji
    replaceForDocument(db, 'TestKb', 'DOC_2', [
      { id: 'C2', content: 'Zasilacz Meanwell z 5-letnią gwarancją, wysokość zawieszenia.' },
    ]);
    expect(searchFts(db, 'gwarancja', ['TestKb'], 5)).toHaveLength(1);
    expect(searchFts(db, 'wysokosci', ['TestKb'], 5)).toHaveLength(1);

    // indeks zewnętrzny pozostaje spójny z tabelą treści
    expect(() => db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')")).not.toThrow();
  });
});
