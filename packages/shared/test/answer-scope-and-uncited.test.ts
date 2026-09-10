import { beforeEach, describe, expect, it } from 'vitest';
import {
  ANSWER_PROMPT_VERSION,
  answerQuestion,
  answerSystemPrompt,
  clearAnswerCache,
  parseScopeLine,
  uncitedShare,
} from '../src/answer/index.js';
import type { AnswerCtx, AnswerLlm } from '../src/answer/index.js';
import { createKb, replaceForDocument, type Db } from '../src/db/index.js';
import { testDb } from './helpers.js';

/**
 * Sędzia LLM (2026-09-10, SubiektKB, 26 próbek) pokazał dwie słabości GENEROWANIA (retrieval
 * był w porządku): (1) pytanie o inny produkt/technologię niż źródła („Subiekt nexo", „replikacja
 * PostgreSQL") dostawało częściową odpowiedź o Subiekcie GT / MSSQL zamiast odmowy; (2) odpowiedź
 * dokładała twierdzenia spoza źródeł („SQL Server 2025"). Prompt answer-v2 nazywa obie reguły
 * wprost, a pewność spada proporcjonalnie do udziału akapitów bez żadnego cytowania — liczonego
 * po BLOKACH (akapit/lista), żeby lista z cytowaniem na końcu nie była karana za każdy punkt.
 */

describe('uncitedShare (czysta logika)', () => {
  it('lista z cytowaniem na końcu = jeden blok cytowany; zero kary', () => {
    const answer = [
      'Uruchomienie odbywa się przez utworzenie obiektów:',
      '- `gt As New InsERT.gt`',
      '- `sgt As InsERT.Subiekt` [1]',
      '',
      'Następnie ustawia się parametry połączenia [1][2].',
    ].join('\n');
    expect(uncitedShare(answer)).toEqual({ blocks: 2, uncited: 0, share: 0 });
  });
  it('akapit bez cytowania liczy się jako niepoparty; nagłówki i krótkie linie pomijane', () => {
    const answer = [
      '## Limit bazy',
      '',
      'Limit rozmiaru bazy w SQL Server Express wynosi 10 GB [1].',
      '',
      'W SQL Server 2025 limit ten został podniesiony do 16 GB.',
      '',
      'OK.',
    ].join('\n');
    expect(uncitedShare(answer)).toEqual({ blocks: 2, uncited: 1, share: 0.5 });
  });
  it('pusta odpowiedź i odpowiedź bez bloków → share 0 (nie ma czego karać)', () => {
    expect(uncitedShare('')).toEqual({ blocks: 0, uncited: 0, share: 0 });
    expect(uncitedShare('## Tylko nagłówek')).toEqual({ blocks: 0, uncited: 0, share: 0 });
  });
});

describe('parseScopeLine (czysta logika)', () => {
  it('rozpoznaje znacznik odmowy zakresu w obu językach i usuwa go z treści', () => {
    expect(parseScopeLine('Źródła tego nie obejmują [1].\nSCOPE: poza_zrodlami\nCONFIDENCE: 0.6')).toEqual({
      text: 'Źródła tego nie obejmują [1].\nCONFIDENCE: 0.6',
      outOfScope: true,
    });
    expect(parseScopeLine('The sources do not cover it.\n scope: OUT_OF_SOURCES \nCONFIDENCE: 0.5').outOfScope).toBe(true);
    expect(parseScopeLine('Limit wynosi 10 GB [1].\nCONFIDENCE: 0.9')).toEqual({
      text: 'Limit wynosi 10 GB [1].\nCONFIDENCE: 0.9',
      outOfScope: false,
    });
    // znacznik w środku zdania (cytat ze źródła) nie liczy się — tylko osobna linia
    expect(parseScopeLine('W dokumentacji jest napis SCOPE: poza_zrodlami w tabeli [1].\nCONFIDENCE: 0.9').outOfScope).toBe(false);
  });
});

describe('answerSystemPrompt (answer-v3)', () => {
  it('wersja promptu podbita, reguła zakresu, zakaz wiedzy spoza źródeł i znacznik SCOPE w obu językach', () => {
    expect(ANSWER_PROMPT_VERSION).toBe('answer-v3');
    expect(answerSystemPrompt('pl')).toContain('SCOPE: poza_zrodlami');
    expect(answerSystemPrompt('en')).toContain('SCOPE: out_of_sources');
    const pl = answerSystemPrompt('pl');
    expect(pl).toMatch(/inn(ego|y) produkt/i);
    expect(pl).toMatch(/nie odpowiadaj o podobnym/i);
    expect(pl).toMatch(/spoza źródeł/i);
    expect(pl).toContain('CONFIDENCE:');
    const en = answerSystemPrompt('en');
    expect(en).toMatch(/different product/i);
    expect(en).toMatch(/outside the sources/i);
    expect(en).toContain('CONFIDENCE:');
  });
});

const NS = 'ScopeTest';
function seed(db: Db): void {
  createKb(db, { namespace: NS, name: 'Scope', embeddingModel: '' });
  db.prepare("UPDATE kb_registry SET status = 'active' WHERE namespace = ?").run(NS);
  replaceForDocument(db, NS, 'DOC_S1', [
    {
      id: 'CHUNK_S1_000',
      title: 'Instalacja serwera SQL dla InsERT GT',
      content:
        'InsERT GT pracuje na Microsoft SQL Server, nie na PostgreSQL. Edycja Express ma limit rozmiaru bazy 10 GB; ' +
        'po jego przekroczeniu należy przenieść bazę na wyższą edycję serwera.',
    },
  ]);
}
function llmReturning(text: string): AnswerLlm {
  return {
    async chat() {
      return { text };
    },
    async embed(texts: string[]) {
      return texts.map(() => [1, 0]);
    },
  };
}
function ctxOf(db: Db, llm: AnswerLlm): AnswerCtx {
  return { db, llm, openspg: null, log: { warn: () => undefined } };
}
const QUESTION = 'Jaki jest limit rozmiaru bazy w SQL Server Express dla InsERT GT?';

describe('answerQuestion — kara za akapity bez cytowania', () => {
  beforeEach(() => clearAnswerCache());

  it('ten sam llmSelf: odpowiedź z niepopartym akapitem ma niższą pewność i ostrzeżenie', async () => {
    const cited = 'Limit rozmiaru bazy w SQL Server Express wynosi 10 GB [1].\nCONFIDENCE: 0.9';
    const padded =
      'Limit rozmiaru bazy w SQL Server Express wynosi 10 GB [1].\n\n' +
      'W SQL Server 2025 limit ten został podniesiony do 16 GB i nie trzeba już migrować.\n' +
      'CONFIDENCE: 0.9';
    const db1 = testDb();
    seed(db1);
    const a = await answerQuestion(ctxOf(db1, llmReturning(cited)), { question: QUESTION, allowedNamespaces: [NS], source: 'mcp' });
    const db2 = testDb();
    seed(db2);
    const b = await answerQuestion(ctxOf(db2, llmReturning(padded)), { question: QUESTION, allowedNamespaces: [NS], source: 'mcp' });
    expect(a.noAnswer).toBe(false);
    expect(b.noAnswer).toBe(false);
    expect(a.warnings.some((w) => /bez cytowania/.test(w))).toBe(false);
    expect(b.warnings.some((w) => /akapit.*bez cytowania/i.test(w))).toBe(true);
    // 2 bloki, 1 niepoparty → share 0.5 → mnożnik 1 - 0.4*0.5 = 0.8
    expect(b.confidence).toBeCloseTo(a.confidence * 0.8, 5);
  });
});

describe('answerQuestion — odmowa zakresu ze znacznikiem SCOPE', () => {
  beforeEach(() => clearAnswerCache());

  it('SCOPE: poza_zrodlami → noAnswer=true, treść wyjaśnienia zachowana, luka „out_of_scope", wiersz answers no_answer=1', async () => {
    const text =
      'Źródła nie opisują replikacji PostgreSQL — dotyczą wyłącznie Microsoft SQL Server [1].\n' +
      'SCOPE: poza_zrodlami\nCONFIDENCE: 0.6';
    const db = testDb();
    seed(db);
    const res = await answerQuestion(ctxOf(db, llmReturning(text)), {
      // pytanie leksykalnie „na temat" (bramka retrievalu przepuszcza), ale poza zakresem źródeł
      question: 'Jaki limit rozmiaru bazy ma InsERT GT na PostgreSQL w edycji Express?',
      allowedNamespaces: [NS],
      source: 'mcp',
    });
    expect(res.noAnswer).toBe(true);
    expect(res.answer).toContain('nie opisują replikacji PostgreSQL');
    expect(res.answer).not.toContain('SCOPE:');
    expect(res.gapRecorded).toBe(true);
    expect(res.citations.map((c) => c.n)).toEqual([1]);
    const row = db.prepare('SELECT no_answer FROM answers WHERE id = ?').get(res.answerId) as { no_answer: number };
    expect(row.no_answer).toBe(1);
    const gap = db.prepare('SELECT metadata_json FROM learning_gaps ORDER BY id DESC LIMIT 1').get() as { metadata_json: string };
    expect(JSON.parse(gap.metadata_json).reason).toBe('out_of_scope');
    // druga identyczna prośba nie idzie z cache (odmowy nie cache'ujemy) — nadal noAnswer
    const again = await answerQuestion(ctxOf(db, llmReturning(text)), {
      question: 'Jaki limit rozmiaru bazy ma InsERT GT na PostgreSQL w edycji Express?',
      allowedNamespaces: [NS],
      source: 'mcp',
    });
    expect(again.noAnswer).toBe(true);
  });
});
