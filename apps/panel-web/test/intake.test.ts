import { describe, expect, it } from 'vitest';
import {
  isIntakeTerminal,
  MAX_UPLOAD_BYTES,
  stagesToSteps,
  validateUploadFile,
  type IntakeStageApi,
} from '../src/lib/intake';

function stage(id: string, reached: boolean, current: boolean): IntakeStageApi {
  return { stage: id, label: `PL:${id}`, reached, current };
}

describe('stagesToSteps()', () => {
  const stages: IntakeStageApi[] = [
    stage('received', true, false),
    stage('extracted', true, true),
    stage('cleaned', false, false),
    stage('analyzed', false, false),
    stage('drafted', false, false),
  ];

  it('w toku: reached→done, current→active, reszta pending; etykiety z backendu', () => {
    const steps = stagesToSteps(stages, 'extracted');
    expect(steps.map((s) => s.status)).toEqual(['done', 'active', 'pending', 'pending', 'pending']);
    expect(steps[0]?.label).toBe('PL:received');
  });

  it('failed: najdalszy osiągnięty etap oznaczony jako failed', () => {
    const failedStages = [stage('received', true, false), stage('extracted', true, false), stage('cleaned', false, false)];
    const steps = stagesToSteps(failedStages, 'failed');
    expect(steps.map((s) => s.status)).toEqual(['done', 'failed', 'pending']);
  });

  it('drafted (terminalny sukces): bieżący etap done, nie active', () => {
    const doneStages = stages.map((s) => ({ ...s, reached: true, current: s.stage === 'drafted' }));
    const steps = stagesToSteps(doneStages, 'drafted');
    expect(steps.every((s) => s.status === 'done')).toBe(true);
  });
});

describe('validateUploadFile()', () => {
  it('akceptuje whitelistę rozszerzeń (case-insensitive)', () => {
    expect(validateUploadFile('cennik.PDF', 1024)).toEqual({ ok: true });
    expect(validateUploadFile('notatka.md', 1)).toEqual({ ok: true });
  });

  it('odrzuca nieobsługiwane rozszerzenie i brak rozszerzenia', () => {
    expect(validateUploadFile('wirus.exe', 10)).toEqual({ ok: false, code: 'extension' });
    expect(validateUploadFile('bez-rozszerzenia', 10)).toEqual({ ok: false, code: 'extension' });
  });

  it('odrzuca plik ponad 50 MB', () => {
    expect(validateUploadFile('duzy.pdf', MAX_UPLOAD_BYTES + 1)).toEqual({ ok: false, code: 'size' });
    expect(validateUploadFile('graniczny.pdf', MAX_UPLOAD_BYTES)).toEqual({ ok: true });
  });
});

describe('isIntakeTerminal()', () => {
  it('drafted i failed kończą polling; reszta nie', () => {
    expect(isIntakeTerminal('drafted')).toBe(true);
    expect(isIntakeTerminal('failed')).toBe(true);
    expect(isIntakeTerminal('received')).toBe(false);
    expect(isIntakeTerminal(undefined)).toBe(false);
  });
});
