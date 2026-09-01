import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@pomagierkb/shared/errors';
import {
  MESSAGES,
  humanize,
  ACTION_STATUSES,
  BUILDER_JOB_STATUSES,
  INTAKE_STAGES,
  INTAKE_ERROR_CODES,
  PREFLIGHT_CODES,
  DRAFT_STATUSES,
  GAP_STATUSES,
  ANSWER_PHASES,
  QUALITY_CHECK_CODES,
  QUALITY_VERDICTS,
} from '../src/services/messages.js';
import { PREFLIGHT_CHECK_IDS } from '../src/services/preflight.js';

/**
 * Test kompletności słownika komunikatów PL (PLAN Faza 3.5): każdy status/kod
 * używany w kodzie tras i jobów — wyliczany z EKSPORTOWANYCH stałych, nie
 * z literałów w teście — musi mieć wpis z niepustą etykietą.
 */

describe('słownik komunikatów PL — kompletność', () => {
  const families: [string, readonly string[]][] = [
    ['kody błędów AppError', Object.keys(ERROR_CODES)],
    ['statusy akcji', ACTION_STATUSES],
    ['statusy builder joba', BUILDER_JOB_STATUSES],
    ['etapy intake', INTAKE_STAGES],
    ['kody błędów intake', INTAKE_ERROR_CODES],
    ['kody preflight (słownik)', PREFLIGHT_CODES],
    ['kody preflight (silnik)', PREFLIGHT_CHECK_IDS],
    // Rodziny Fazy 4 (pipeline wiedzy) — drafty, luki, /ask, quality gate.
    ['statusy draftów', DRAFT_STATUSES],
    ['statusy luk wiedzy', GAP_STATUSES],
    ['etapy odpowiedzi /ask', ANSWER_PHASES],
    ['checki quality gate', QUALITY_CHECK_CODES],
    ['werdykty quality gate', QUALITY_VERDICTS],
  ];

  it.each(families)('%s: każdy kod ma wpis z niepustą etykietą', (_name, codes) => {
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      const entry = MESSAGES[code];
      expect(entry, `brak wpisu w MESSAGES dla kodu '${code}'`).toBeDefined();
      expect(entry!.label.length, `pusta etykieta dla kodu '${code}'`).toBeGreaterThan(0);
      // Etykieta ma być po polsku/ludzka — nie może być kopią surowego kodu.
      expect(entry!.label, `etykieta dla '${code}' to surowy kod`).not.toBe(code);
    }
  });

  it('PREFLIGHT_CODES słownika pokrywa się 1:1 z PREFLIGHT_CHECK_IDS silnika', () => {
    expect([...PREFLIGHT_CODES].sort()).toEqual([...PREFLIGHT_CHECK_IDS].sort());
  });
});

describe('humanize', () => {
  it('znany kod → wpis ze słownika', () => {
    expect(humanize('running').label).toBe('w trakcie');
    expect(humanize('FINISH').label).toBe('zbudowano');
    expect(humanize('extraction_below_quality_threshold').action).toContain('spróbuj inną wersję');
  });

  it('nieznany kod NIGDY nie wraca goły — etykieta "status techniczny: X"', () => {
    const msg = humanize('XYZZY_42');
    expect(msg.label).toBe('status techniczny: XYZZY_42');
  });

  it('nieznany kod z fallbackiem → fallback jako etykieta', () => {
    expect(humanize('XYZZY_42', 'coś poszło nie tak')).toEqual({ label: 'coś poszło nie tak' });
    // Pusty fallback nie liczy się jako etykieta.
    expect(humanize('XYZZY_42', '').label).toBe('status techniczny: XYZZY_42');
  });
});
