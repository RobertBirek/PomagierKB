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
} from '../src/db/index.js';
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
