import { describe, expect, it } from 'vitest';
import {
  daysUntil,
  keyBadgeInfo,
  KEY_EXPIRY_WARN_DAYS,
  MCP_TOOLS,
  PROFILE_ID_RE,
  validateProfileForm,
} from '../src/lib/mcp';
import { pl } from '../src/i18n/pl';

const KNOWN_NS = ['ProductDocs', 'Procedures'];

function form(overrides: Partial<Parameters<typeof validateProfileForm>[0]> = {}) {
  return {
    id: 'standard',
    name: 'Profil standardowy',
    tools: ['kb_search', 'kb_answer'],
    allNamespaces: true,
    namespaces: [],
    ...overrides,
  };
}

describe('validateProfileForm()', () => {
  it('akceptuje poprawny formularz (wszystkie bazy)', () => {
    expect(validateProfileForm(form(), KNOWN_NS)).toEqual({ ok: true, errors: [] });
  });

  it('akceptuje wybrane namespaces z listy istniejących KB', () => {
    const result = validateProfileForm(
      form({ allNamespaces: false, namespaces: ['ProductDocs'] }),
      KNOWN_NS,
    );
    expect(result.ok).toBe(true);
  });

  it('odrzuca puste tools (wymagane co najmniej jedno narzędzie)', () => {
    const result = validateProfileForm(form({ tools: [] }), KNOWN_NS);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('tools');
  });

  it('odrzuca nieznane narzędzie (spoza listy KNOWN_MCP_TOOLS)', () => {
    const result = validateProfileForm(form({ tools: ['kb_search', 'kb_hack'] }), KNOWN_NS);
    expect(result.errors).toContain('tools');
  });

  it('odrzuca namespace spoza listy istniejących KB', () => {
    const result = validateProfileForm(
      form({ allNamespaces: false, namespaces: ['ProductDocs', 'Nieistniejąca'] }),
      KNOWN_NS,
    );
    expect(result.errors).toContain('namespaces');
  });

  it('odrzuca pustą listę namespaces gdy nie wybrano „wszystkie"', () => {
    const result = validateProfileForm(form({ allNamespaces: false, namespaces: [] }), KNOWN_NS);
    expect(result.errors).toContain('namespaces');
  });

  it('waliduje id wzorcem backendu i wymaga niepustej nazwy', () => {
    expect(validateProfileForm(form({ id: 'Duże-Litery' }), KNOWN_NS).errors).toContain('id');
    expect(validateProfileForm(form({ id: '' }), KNOWN_NS).errors).toContain('id');
    expect(validateProfileForm(form({ name: '   ' }), KNOWN_NS).errors).toContain('name');
  });

  it('zbiera wiele błędów naraz', () => {
    const result = validateProfileForm(
      { id: '!', name: '', tools: [], allNamespaces: false, namespaces: [] },
      KNOWN_NS,
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['id', 'name', 'tools', 'namespaces']);
  });
});

describe('PROFILE_ID_RE / MCP_TOOLS (lustro backendu)', () => {
  it('wzorzec id zgodny z routes/mcp-admin.ts', () => {
    expect(PROFILE_ID_RE.test('standard')).toBe(true);
    expect(PROFILE_ID_RE.test('a')).toBe(true);
    expect(PROFILE_ID_RE.test('profil-1')).toBe(true);
    expect(PROFILE_ID_RE.test('-start')).toBe(false);
    expect(PROFILE_ID_RE.test('a'.repeat(65))).toBe(false);
  });

  it('lista narzędzi zgodna z KNOWN_MCP_TOOLS z shared', () => {
    expect([...MCP_TOOLS]).toEqual(['kb_search', 'kb_answer', 'kb_list', 'kb_get_source', 'kb_list_documents', 'kb_draft_status', 'kb_submit_draft', 'kb_feedback']);
  });
});

describe('daysUntil()', () => {
  const now = Date.parse('2026-09-01T12:00:00.000Z');

  it('liczy pełne dni do przodu (ceil)', () => {
    expect(daysUntil('2026-09-02T12:00:00.000Z', now)).toBe(1);
    expect(daysUntil('2026-09-02T18:00:00.000Z', now)).toBe(2); // 1,25 dnia → 2
    expect(daysUntil('2026-10-01T12:00:00.000Z', now)).toBe(30);
  });

  it('data w przeszłości → wartość niedodatnia; śmieci → null', () => {
    expect(daysUntil('2026-08-31T12:00:00.000Z', now)).toBe(-1);
    expect(daysUntil('nie-data', now)).toBeNull();
  });
});

describe('keyBadgeInfo()', () => {
  const now = Date.parse('2026-09-01T12:00:00.000Z');
  const farFuture = '2026-12-01T12:00:00.000Z';

  it('active z odległym terminem → ok/Aktywny z liczbą dni', () => {
    const info = keyBadgeInfo('active', farFuture, now);
    expect(info.variant).toBe('ok');
    expect(info.labelKey).toBe('mcp.keyStatus.active');
    expect(info.days).toBe(91);
  });

  it('active blisko terminu (≤ próg) → warn/Wygasa wkrótce', () => {
    const soon = `2026-09-${String(1 + KEY_EXPIRY_WARN_DAYS).padStart(2, '0')}T11:00:00.000Z`;
    const info = keyBadgeInfo('active', soon, now);
    expect(info.variant).toBe('warn');
    expect(info.labelKey).toBe('mcp.keyStatus.expiringSoon');
  });

  it('active po terminie (sweep TTL jeszcze nie przeszedł) → uczciwie „Wygasł"', () => {
    const info = keyBadgeInfo('active', '2026-08-01T00:00:00.000Z', now);
    expect(info.variant).toBe('fail');
    expect(info.labelKey).toBe('mcp.keyStatus.expired');
  });

  it('revoked → neutral, expired → fail', () => {
    expect(keyBadgeInfo('revoked', farFuture, now)).toEqual({
      variant: 'neutral',
      labelKey: 'mcp.keyStatus.revoked',
      days: null,
    });
    expect(keyBadgeInfo('expired', farFuture, now).variant).toBe('fail');
  });

  it('nieznany status nie wycieka po angielsku — etykieta ze słownika', () => {
    const info = keyBadgeInfo('weird', farFuture, now);
    expect(info.variant).toBe('neutral');
    expect(Object.keys(pl)).toContain(info.labelKey);
  });
});
