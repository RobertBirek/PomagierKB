import { beforeEach, describe, expect, it } from 'vitest';
import { answerQuestion, clearAnswerCache } from '../src/answer/index.js';
import type { AnswerCtx, AnswerLlm } from '../src/answer/index.js';
import { createKb, replaceForDocument, type Db } from '../src/db/index.js';
import { testDb } from './helpers.js';

/**
 * Kontynuacja sekcji w kontekście odpowiedzi (2026-09-23): nagłówek agregatu „Top 20 towarów…"
 * trafiał w retrieval, ale lista wierszy leżała w NASTĘPNYM chunku tej samej sekcji i model
 * odpowiadał „nie mam listy". buildContext dokłada następny chunk tej samej sekcji do źródła [n].
 */
const NS = 'ContTest';
function seed(db: Db): void {
  createKb(db, { namespace: NS, name: 'Cont', embeddingModel: '' });
  db.prepare("UPDATE kb_registry SET status = 'active' WHERE namespace = ?").run(NS);
  replaceForDocument(db, NS, 'DOC_T1', [
    { id: 'CHUNK_T1_000', title: 'Agregaty', sectionHeading: 'Top 20 towarów wg sprzedaży', content: 'Gotowa lista najlepiej sprzedających się produktów (top 10 produktów, bestsellery) w instancji.' },
    { id: 'CHUNK_T1_001', title: 'Agregaty', sectionHeading: 'Top 20 towarów wg sprzedaży', content: 'Top 20 towarów — pozycje 1–8: miejsce 1 MOLITE PND-1098; miejsce 2 BALBO 20006PM.' },
    { id: 'CHUNK_T1_002', title: 'Agregaty', sectionHeading: 'Sprzedaż netto dziennie', content: 'Sprzedaż netto dziennie: 2026-09-23: 54026.' },
  ]);
}
function recordingLlm(): AnswerLlm & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async chat(r: { system: string; user: string }) {
      prompts.push(r.user);
      return { text: 'Top 10 to MOLITE i BALBO [1].\nCONFIDENCE: 0.8' };
    },
    async embed(texts: string[]) {
      return texts.map(() => [1, 0]);
    },
  };
}

describe('buildContext — kontynuacja sekcji', () => {
  beforeEach(() => clearAnswerCache());

  it('następny chunk tej samej sekcji trafia do tego samego źródła; chunk innej sekcji — nie', async () => {
    const db = testDb();
    seed(db);
    const llm = recordingLlm();
    const ctx: AnswerCtx = { db, llm, openspg: null, log: { warn: () => undefined } };
    const res = await answerQuestion(ctx, { question: 'jakie są top 10 produktów bestsellery', allowedNamespaces: [NS], source: 'mcp', maxSources: 1 });
    expect(res.noAnswer).toBe(false);
    expect(llm.prompts).toHaveLength(1);
    const prompt = llm.prompts[0]!;
    expect(prompt).toContain('pozycje 1–8');            // kontynuacja dołożona do [1]
    expect(prompt).not.toContain('Sprzedaż netto dziennie'); // inna sekcja — nie
    expect(res.citations).toHaveLength(1);
  });
});
