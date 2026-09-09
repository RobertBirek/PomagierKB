import { describe, expect, it } from 'vitest';
import { parseArticle, parseList } from '../fetch-epomoc.mjs';

const LIST = `<html><body><div class="results-summary">Znaleziono 3528 zagadnień.</div>
<a href="/dla_uzytkownikow/e-pomoc_techniczna/11234,subiekt-gt-%E2%80%93-jak-wygenerowac-e-fakture.html?token=abc"><strong>Subiekt GT – Jak wygenerować e-Fakturę?</strong></a>
<a href="/dla_uzytkownikow/e-pomoc_techniczna/12591,subiekt-gt-jak-ustawic-domyslna-forme-dokumentu.html">x</a>
<a href="/dla_uzytkownikow/e-pomoc_techniczna/11234,subiekt-gt-%E2%80%93-jak-wygenerowac-e-fakture.html">dup</a>
<table class="navigators"><tr><td><a href="/dla_uzytkownikow/e-pomoc_techniczna.html?program=2&amp;offset=2">2</a>
<a href="/dla_uzytkownikow/e-pomoc_techniczna.html?program=2&amp;offset=142">142</a><a href="/dla_uzytkownikow/e-pomoc_techniczna.html?program=2&amp;offset=2">Następne</a></td></tr></table></body></html>`;

const ARTICLE = `<html><body><div class="main"><div class="support-head"><a class="go-back-link" href="#">Wróć</a><h2>e-Pomoc techniczna</h2>
<h1><strong>Subiekt GT – Jak wygenerować e-Fakturę?</strong></h1>
<div class="modification-date">Ostatnia modyfikacja: <span class="modification-date-yellow">26.11.2025</span></div>
<p class="filter-support">Program: <a href="?program=1">InsERT GT</a>, <a href="?program=2">Subiekt GT</a></p>
<p class="filter-support">Kategoria: <a href="?category=191">KSeF</a></p></div>
<div class="support-content"><p class="content">Program <strong>Subiekt GT</strong> umożliwia generowanie e-Faktur.</p><script>x()</script><ol><li>Przejść do modułu.</li></ol></div>
<div class="support-rate">Oceń</div></div></body></html>`;

describe('fetch-epomoc: parseList', () => {
  it('zbiera unikalne id/slug, liczbę stron z paginacji i sumę wyników', () => {
    const r = parseList(LIST);
    expect(r.items.map((i) => i.id)).toEqual([11234, 12591]);
    expect(r.items[0].slug).toContain('jak-wygenerowac-e-fakture');
    expect(r.pages).toBe(142);
    expect(r.total).toBe(3528);
  });
  it('strona bez paginacji → 1 strona', () => {
    expect(parseList('<html><body></body></html>').pages).toBe(1);
  });
});

describe('fetch-epomoc: parseArticle', () => {
  it('wyciąga tytuł, datę, programy, kategorie i treść bez skryptów', () => {
    const a = parseArticle(ARTICLE, 11234);
    expect(a.title).toBe('Subiekt GT – Jak wygenerować e-Fakturę?');
    expect(a.modified).toBe('26.11.2025');
    expect(a.programs).toEqual(['InsERT GT', 'Subiekt GT']);
    expect(a.categories).toEqual(['KSeF']);
    expect(a.text).toContain('umożliwia generowanie e-Faktur');
    expect(a.text).not.toContain('x()');
    expect(a.html).toContain('<ol>');
  });
});
