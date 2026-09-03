import { describe, expect, it } from 'vitest';
import {
  actionProgressPercent,
  actionProgressStep,
  actionStatusVariant,
  KNOWN_ACTION_TYPES,
  OTHER_ACTION_TYPE,
  typeFilterFromUrl,
} from '../src/components/actions/actions-core';

describe('typeFilterFromUrl() — mapowanie filtra typu na Select+Input („inny…")', () => {
  it('pusty filtr → „wszystkie" bez pola własnego', () => {
    expect(typeFilterFromUrl('')).toEqual({ select: '', custom: '' });
    expect(typeFilterFromUrl('   ')).toEqual({ select: '', custom: '' });
  });

  it('każdy znany typ z rejestru jobów mapuje na opcję słownikową', () => {
    for (const type of KNOWN_ACTION_TYPES) {
      expect(typeFilterFromUrl(type)).toEqual({ select: type, custom: '' });
    }
  });

  it('słownik pokrywa typy z panel-api (run-job JOB_MODULES + routes/kbs)', () => {
    expect([...KNOWN_ACTION_TYPES].sort()).toEqual(
      ['build_kb', 'create_kb', 'noop', 'quality_gate', 'schema_sync'].sort(),
    );
  });

  it('nieznany typ → opcja „inny…" z wartością w polu tekstowym', () => {
    expect(typeFilterFromUrl('export_drafts')).toEqual({
      select: OTHER_ACTION_TYPE,
      custom: 'export_drafts',
    });
    // wartość wartownika nie koliduje ze znanymi typami
    expect((KNOWN_ACTION_TYPES as readonly string[]).includes(OTHER_ACTION_TYPE)).toBe(false);
  });

  it('przycina białe znaki wokół typu z URL-a', () => {
    expect(typeFilterFromUrl(' build_kb ')).toEqual({ select: 'build_kb', custom: '' });
  });
});

describe('actionProgressPercent() — procent z progress_json (lustro ActionProgress)', () => {
  it('percent wprost, z przycięciem do 0–100', () => {
    expect(actionProgressPercent({ percent: 42 })).toBe(42);
    expect(actionProgressPercent({ percent: 140 })).toBe(100);
    expect(actionProgressPercent({ percent: -5 })).toBe(0);
  });

  it('current/total gdy brak percent', () => {
    expect(actionProgressPercent({ current: 3, total: 4 })).toBe(75);
    expect(actionProgressPercent({ current: 8, total: 4 })).toBe(100);
  });

  it('brak danych → null (pasek indeterminate)', () => {
    expect(actionProgressPercent(null)).toBeNull();
    expect(actionProgressPercent({})).toBeNull();
    expect(actionProgressPercent({ percent: 'x', current: 1, total: 0 })).toBeNull();
  });
});

describe('actionProgressStep() — etykieta etapu', () => {
  it('preferuje stepLabel, potem message/step/stage', () => {
    expect(actionProgressStep({ stepLabel: 'Eksport', message: 'm' })).toBe('Eksport');
    expect(actionProgressStep({ message: 'Buduję graf' })).toBe('Buduję graf');
    expect(actionProgressStep({ stage: 'chunking' })).toBe('chunking');
  });

  it('null/puste → null', () => {
    expect(actionProgressStep(null)).toBeNull();
    expect(actionProgressStep({ stepLabel: '' })).toBeNull();
  });
});

describe('actionStatusVariant() — status akcji → wariant Badge', () => {
  it('mapuje wszystkie statusy z ACTION_STATUSES panel-api', () => {
    expect(actionStatusVariant('running')).toBe('info');
    expect(actionStatusVariant('success')).toBe('ok');
    expect(actionStatusVariant('error')).toBe('fail');
    expect(actionStatusVariant('cancelled')).toBe('warn');
  });

  it('nieznany status → neutral (defensywnie)', () => {
    expect(actionStatusVariant('archiwalny')).toBe('neutral');
  });
});
