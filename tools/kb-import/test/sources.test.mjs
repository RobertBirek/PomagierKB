import { describe, expect, it } from 'vitest';
import { CATEGORIES, classifySource, curateArchiveFile, slugify } from '../lib/sources.mjs';

describe('sources: classifySource', () => {
  it('rozpoznaje PDF-y, CHM w Pomoc/, kolejność reguł (GTA.chm w korzeniu = pominięty)', () => {
    expect(classifySource('Sfera_dla_InsERT_GT-1.pdf').category).toBe(CATEGORIES.api);
    expect(classifySource('Pomoc/gta.chm').title).toContain('modelu obiektowego');
    expect(classifySource('GTA.chm')).toBeNull();
    expect(classifySource('Pomoc.zip')).toBeNull();
    expect(classifySource('Skrypty_SQL_1_89_HF1.zip')).toBeNull();
    expect(classifySource('Zmiany_w_InsERT_GT.pdf').category).toBe(CATEGORIES.changes);
    expect(classifySource('nieznany.pdf')).toBeUndefined();
  });
  it('dodaje produkt do słów kluczowych i slug z nazwy pliku', () => {
    const m = classifySource('Komunikacja_EDI++_1_12.pdf', 'InsERT GT');
    expect(m.keywords[0]).toBe('InsERT GT');
    expect(m.slug).toBe('komunikacja-edi-1-12');
  });
  it('InsERTGT.chm pomija stronę struktury bazy i płatną listę zmian', () => {
    const m = classifySource('Pomoc/InsERTGT.chm');
    expect(m.skipPages.test('Opis_struktury_zbiorow_danych.htm')).toBe(true);
    expect(m.skipPages.test('Lista_zmian.htm')).toBe(true);
    expect(m.skipPages.test('Lista_zmian_all.htm')).toBe(false);
  });
});

describe('sources: curateArchiveFile', () => {
  it('włącza pliki tekstowe/kod, wyklucza binaria i projekty', () => {
    expect(curateArchiveFile('a/opis.txt', 100).include).toBe(true);
    expect(curateArchiveFile('a/skrypt.vbs', 100).lang).toBe('vb');
    expect(curateArchiveFile('a/x.xls', 100)).toEqual({ include: false, reason: 'arkusz Excel (makra VBA) — pominięty, brak konwertera' });
    expect(curateArchiveFile('a/vssver.scc', 10).include).toBe(false);
    expect(curateArchiveFile('a/p.vbp', 10).include).toBe(false);
    expect(curateArchiveFile('a/duzy.xml', 500_000).include).toBe(false);
  });
});

describe('sources: slugify', () => {
  it('bez diakrytyków, ≤80 znaków, fallback', () => {
    expect(slugify('Zażółć gęślą jaźń — Sfera!')).toBe('zazolc-gesla-jazn-sfera');
    expect(slugify('')).toBe('plik');
    expect(slugify('x'.repeat(100)).length).toBe(80);
  });
});
