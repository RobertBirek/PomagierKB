import { describe, expect, it } from 'vitest';
import {
  createDraft,
  gapStats,
  normalizeQuestion,
  recordAnswer,
  recordFeedback,
  recordGap,
  resolveByDraft,
  setGapStatus,
  getGap,
  listGaps,
  reopenGap,
} from '../src/db/index.js';
import { AppError } from '../src/errors.js';
import { testDb } from './helpers.js';

describe('repos/learningGaps + answersFeedback', () => {
  it('dedupe: to samo pytanie (po normalizacji) nie tworzy drugiej otwartej luki', () => {
    const db = testDb();
    const first = recordGap(db, { question: 'Jak podłączyć szynoprzewód 3F?', source: 'mcp' });
    expect(first.created).toBe(true);
    const dup = recordGap(db, { question: '  jak PODŁĄCZYĆ szynoprzewód 3f???  ', source: 'panel' });
    expect(dup.created).toBe(false);
    expect(dup.row.id).toBe(first.row.id);
    expect(dup.row.evidence_count).toBe(2);
    expect(gapStats(db).open).toBe(1);

    expect(normalizeQuestion('Co?! To — "test", nr 5.')).toBe('co to test nr 5');
  });

  it('przejścia statusów: open→in_draft→resolved; nielegalne → conflict; resolveByDraft', () => {
    const db = testDb();
    const gap = recordGap(db, { question: 'Ile luksów w magazynie?', source: 'mcp' }).row;
    expect(() => setGapStatus(db, gap.id, 'in_draft')).toThrowError(/draftId/);

    const draft = createDraft(db, { title: 'Oświetlenie magazynu', content: 'treść', sourceType: 'gap' });
    const inDraft = setGapStatus(db, gap.id, 'in_draft', { draftId: draft.id, processedBy: 'u1' });
    expect(inDraft.status).toBe('in_draft');
    expect(inDraft.draft_id).toBe(draft.id);

    // po in_draft ta sama treść pytania może znów otworzyć lukę (dedupe tylko wśród open)
    const again = recordGap(db, { question: 'Ile luksów w magazynie?', source: 'panel' });
    expect(again.created).toBe(true);

    expect(resolveByDraft(db, draft.id)).toBe(1);
    // resolved jest terminalny — dalsze przejścia nielegalne
    expect(() => setGapStatus(db, gap.id, 'ignored')).toThrowError(/przejście/);

    const ignored = setGapStatus(db, again.row.id, 'ignored');
    expect(ignored.status).toBe('ignored');
  });

  it('feedback down → automatyczna luka source=feedback z metadata.answerId', () => {
    const db = testDb();
    const ans = recordAnswer(db, {
      question: 'Jaka moc naświetlacza na halę?',
      namespaces: ['LightingDocs'],
      confidence: 0.7,
      source: 'mcp',
      apiKeyId: 'key_x',
    });
    const up = recordFeedback(db, ans.id, 'up', null, 'u1');
    expect(up.gap).toBeNull();

    const down = recordFeedback(db, ans.id, 'down', 'odpowiedź nie na temat', 'u1');
    expect(down.gap).not.toBeNull();
    expect(down.gap?.source).toBe('feedback');
    expect(down.gap?.kb_namespace).toBe('LightingDocs');
    expect(JSON.parse(down.gap?.metadata_json ?? '{}').answerId).toBe(ans.id);

    // drugi down na to samo pytanie → dedupe (evidence_count rośnie)
    const down2 = recordFeedback(db, ans.id, 'down');
    expect(down2.gap?.id).toBe(down.gap?.id);
    expect(down2.gap?.evidence_count).toBe(2);
  });
});

describe('reopen + dedupe per namespace (Faza 8 programu rozbudowy)', () => {
  it('dedupe: to samo pytanie do dwóch KB = DWIE luki (wcześniej globalnie jedna)', () => {
    const db = testDb();
    const a = recordGap(db, { question: 'Jak montować oprawy?', source: 'mcp', kbNamespace: 'KbA' });
    const b = recordGap(db, { question: 'Jak montować oprawy?', source: 'mcp', kbNamespace: 'KbB' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.row.id).not.toBe(b.row.id);
    // powtórka w tym samym ns → dedupe
    const a2 = recordGap(db, { question: 'Jak montować oprawy?', source: 'mcp', kbNamespace: 'KbA' });
    expect(a2.created).toBe(false);
    expect(a2.row.id).toBe(a.row.id);
    expect(a2.row.evidence_count).toBe(2);
  });

  it('reopen: ignored → open; resolved → open; open → conflict', () => {
    const db = testDb();
    const gap = recordGap(db, { question: 'Pytanie do reopenu?', source: 'panel' }).row;
    setGapStatus(db, gap.id, 'ignored', { processedBy: 'u1' });
    const reopened = reopenGap(db, gap.id, 'u1');
    expect(reopened.status).toBe('open');
    setGapStatus(db, gap.id, 'resolved');
    expect(reopenGap(db, gap.id).status).toBe('open');
    try {
      reopenGap(db, gap.id); // już open
      expect.unreachable('powinno rzucić');
    } catch (err) {
      expect((err as AppError).code).toBe('conflict');
    }
  });

  it('reopen z kolizją: otwarta bliźniacza luka przejmuje evidence (merge)', () => {
    const db = testDb();
    const first = recordGap(db, { question: 'Kolizyjne pytanie?', source: 'mcp', kbNamespace: 'KbA' }).row;
    setGapStatus(db, first.id, 'ignored');
    // nowa otwarta luka o tym samym pytaniu/ns (możliwa, bo pierwsza nie jest open)
    const second = recordGap(db, { question: 'Kolizyjne pytanie?', source: 'mcp', kbNamespace: 'KbA' });
    expect(second.created).toBe(true);
    const survivor = reopenGap(db, first.id);
    expect(survivor.id).toBe(second.row.id);
    expect(survivor.evidence_count).toBe(2); // 1 własne + 1 przejęte
    expect(getGap(db, first.id)?.status).toBe('ignored'); // reopenowana została terminalna
  });

  it('listGaps sort=evidence: najczęściej dopytywane najpierw', () => {
    const db = testDb();
    recordGap(db, { question: 'Rzadkie pytanie?', source: 'mcp' });
    const hot = recordGap(db, { question: 'Częste pytanie?', source: 'mcp' }).row;
    recordGap(db, { question: 'Częste pytanie?', source: 'mcp' });
    recordGap(db, { question: 'Częste pytanie?', source: 'mcp' });
    const byEvidence = listGaps(db, { sort: 'evidence' });
    expect(byEvidence.items[0]?.id).toBe(hot.id);
    expect(byEvidence.items[0]?.evidence_count).toBe(3);
  });
});

