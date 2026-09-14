// Lista dostawców będących OSOBAMI PRAWNYMI — czysta logika dla dump-suppliers.mjs (test:
// test/queries-aggregates.test.mjs).
//
// JEDYNE sankcjonowane miejsce w repozytorium, które czyta kolumnę nazwy kontrahenta
// (adr__Ewid.adr_NazwaPelna / adr_Nazwa dla adr_TypAdresu = 1 — adres siedziby; kh__Kontrahent
// NIE ma kolumny nazwy, ma tylko kh_Symbol/kh_Imie/kh_Nazwisko). Podstawa: docs/data-governance.md
// §1.2, decyzja IloveKB 2026-09-11 — nazwy dostawców-osób prawnych nie są danymi osobowymi; nazwy
// jednoosobowych działalności (osób fizycznych) są i muszą zostać odrzucone. Dlatego:
//  1. SQL ogranicza zbiór do kh_Osoba = 0 (firma) i wyłącznie do kontrahentów wskazanych jako
//     podstawowy dostawca towaru (tw__Towar.tw_IdPodstDostawca);
//  2. w JS zostają WYŁĄCZNIE nazwy pasujące do wzorca formy prawnej (LEGAL_FORMS); wszystko inne
//     (np. „Jan Kowalski Handel", „FHU Nowak") jest odrzucane i nigdzie nie zapisywane;
//  3. zapytanie z kolumną nazwy jest sprawdzane bramką checkReadOnly z ZAMASKOWANĄ kolumną nazwy
//     (checkReadOnlyExcept) — każdy inny identyfikator osobowy i każde DML dalej są odrzucane.
// Zmiana zakresu (inna kolumna, inna tabela) wymaga wpisu w docs/data-governance.md.

import { checkReadOnly } from './mcp-readonly.mjs';

/** Kolumny nazwy kontrahenta, które WOLNO odczytać wyłącznie w tym narzędziu. */
export const SANCTIONED_NAME_COLUMNS = Object.freeze(['adr_NazwaPelna', 'adr_Nazwa']);
/**
 * Fałszywe alarmy bramki: adr_TypAdresu to kod typu adresu (int, 1 = siedziba), nie dana osobowa —
 * wzorzec `adres` bramki trafia w podciąg „TypAdresu". Maskowane razem z kolumnami nazwy.
 */
export const GATE_FALSE_POSITIVES = Object.freeze(['adr_TypAdresu']);
export const NAMES_QUERY_MASKED_IDENTIFIERS = Object.freeze([...SANCTIONED_NAME_COLUMNS, ...GATE_FALSE_POSITIVES]);

/** Zbiór kandydatów: podstawowi dostawcy towarów (bez usuniętych) będący firmami (kh_Osoba = 0). */
const CANDIDATE_SUPPLIERS = `
  SELECT t.tw_IdPodstDostawca
  FROM tw__Towar t
  JOIN kh__Kontrahent k ON k.kh_Id = t.tw_IdPodstDostawca
  WHERE t.tw_Usuniety = 0 AND k.kh_Osoba = 0`;

export const SUPPLIER_QUERIES = Object.freeze({
  /** Liczba towarów per dostawca-firma (bez nazw; przechodzi checkReadOnly). */
  counts: `
SELECT k.kh_Id AS supplier_id, COUNT(*) AS product_count
FROM tw__Towar t
JOIN kh__Kontrahent k ON k.kh_Id = t.tw_IdPodstDostawca
WHERE t.tw_Usuniety = 0 AND k.kh_Osoba = 0
GROUP BY k.kh_Id`,
  /** Grupy towarowe (marki) per dostawca-firma (bez nazw kontrahentów; przechodzi checkReadOnly). */
  brands: `
SELECT t.tw_IdPodstDostawca AS supplier_id, g.grt_Nazwa AS brand, COUNT(*) AS product_count
FROM tw__Towar t
JOIN kh__Kontrahent k ON k.kh_Id = t.tw_IdPodstDostawca
LEFT JOIN sl_GrupaTw g ON g.grt_Id = t.tw_IdGrupa
WHERE t.tw_Usuniety = 0 AND k.kh_Osoba = 0
GROUP BY t.tw_IdPodstDostawca, g.grt_Nazwa`,
  /** Nazwa (siedziba, adr_TypAdresu = 1) WYŁĄCZNIE dla kandydatów — jedyne czytanie nazwy kontrahenta. */
  names: `
SELECT a.adr_IdObiektu AS supplier_id,
       COALESCE(NULLIF(LTRIM(RTRIM(a.adr_NazwaPelna)), ''), a.adr_Nazwa) AS display_name
FROM adr__Ewid a
WHERE a.adr_TypAdresu = 1
  AND a.adr_IdObiektu IN (${CANDIDATE_SUPPLIERS})`,
});

/**
 * Bramka tylko-do-odczytu z listą sankcjonowanych identyfikatorów: zamienia je na neutralne
 * placeholdery i sprawdza resztę zwykłym checkReadOnly (DML, inne kolumny osobowe, `*` na tabelach
 * osobowych dalej odrzucane). Zwraca ten sam kształt co checkReadOnly.
 */
export function checkReadOnlyExcept(sql, allowedIdentifiers) {
  let masked = String(sql);
  allowedIdentifiers.forEach((ident, i) => {
    masked = masked.replace(new RegExp(`\\b${ident}\\b`, 'g'), `sanctioned_col_${i}`);
  });
  return checkReadOnly(masked);
}

/**
 * Formy prawne osób prawnych / spółek rejestrowych. Granice słów (\b) chronią przed trafieniami w
 * środku wyrazów („Zinc" ≠ Inc, „Kebab" ≠ AB, „Toys" ≠ Oy). Wzorce z końcówką `$` wymagają formy na
 * końcu nazwy (po przycięciu). Kolejność = kolejność raportowania w LEGAL_FORM_RULE.
 */
export const LEGAL_FORMS = Object.freeze([
  { form: 'sp. z o.o.', re: /\bsp\.?\s*z\s*o\.?\s*o\.?(?=$|[\s,.;)])/i },
  { form: 'spółka z ograniczoną odpowiedzialnością', re: /\bsp[oó][lł]ka\s+z\s+ograniczon/i },
  { form: 'S.A.', re: /\bs\.\s?a\.(?=$|[\s,;)])/i },
  { form: 'spółka akcyjna', re: /\bsp[oó][lł]ka\s+akcyjna\b/i },
  { form: 'S.K.A.', re: /\bs\.\s?k\.\s?a\.(?=$|[\s,;)])/i },
  { form: 'sp. j.', re: /\bsp\.\s?j\.(?=$|[\s,;)])/i },
  { form: 'sp. k.', re: /\bsp\.\s?k\.(?=$|[\s,;)])/i },
  { form: 's.c.', re: /\bs\.\s?c\.(?=$|[\s,;)])/i },
  { form: 'GmbH', re: /\bgmbh\b/i },
  { form: 'Ltd', re: /\bltd\b/i },
  { form: 'Limited', re: /\blimited\b/i },
  { form: 's.r.o.', re: /\bs\.\s?r\.\s?o\.?(?=$|[\s,;)])/i },
  { form: 'a.s.', re: /\ba\.\s?s\.(?=$|[\s,;)])/i },
  { form: 'S.r.l.', re: /\b(srl|s\.\s?r\.\s?l\.?)(?=$|[\s,;)])/i },
  { form: 'S.p.A.', re: /\bs\.\s?p\.\s?a\.?(?=$|[\s,;)])/i },
  { form: 'B.V.', re: /\bb\.\s?v\.?(?=$|[\s,;)])/i },
  { form: 'Inc', re: /\binc\b/i },
  { form: 'AG', re: /\bag$/i },
  { form: 'Oy', re: /\boy\b/i },
  { form: 'AB', re: /\bab$/i },
  { form: 'LLC', re: /\bllc\b/i },
]);

export const LEGAL_FORM_RULE =
  `tw__Towar.tw_IdPodstDostawca → kh__Kontrahent.kh_Osoba = 0 (firma) → nazwa siedziby (adr__Ewid, adr_TypAdresu = 1) ` +
  `musi zawierać formę prawną: ${LEGAL_FORMS.map((f) => f.form).join(' | ')}; pozostałe (jednoosobowe działalności = osoby fizyczne) odrzucone`;

const normalizeName = (name) => String(name ?? '').trim().replace(/[\s.]+$/g, (m) => (m.includes('.') ? '.' : ''));

/** Forma prawna rozpoznana w nazwie albo null (nazwa osoby fizycznej / brak formy). */
export function matchLegalForm(name) {
  const n = normalizeName(name);
  if (n === '') return null;
  return LEGAL_FORMS.find((f) => f.re.test(n))?.form ?? null;
}

export function isLegalEntityName(name) {
  return matchLegalForm(name) !== null;
}

export const TOP_BRANDS = 5;

/**
 * Składa wynik z trzech zapytań (czysta funkcja). Zostają wyłącznie dostawcy z nazwą formy prawnej;
 * odrzuceni są liczeni, nigdy zapisywani. Marki = nazwy grup towarowych, TOP_BRANDS wg liczby towarów.
 * @param {{counts: Array<{supplier_id:number, product_count:number}>,
 *          brands: Array<{supplier_id:number, brand:string|null, product_count:number}>,
 *          names: Array<{supplier_id:number, display_name:string|null}>}} input
 */
export function buildSupplierList({ counts, brands, names }) {
  const nameById = new Map();
  for (const r of names) {
    const n = String(r.display_name ?? '').trim();
    if (n !== '' && !nameById.has(r.supplier_id)) nameById.set(r.supplier_id, n);
  }
  const brandsById = new Map();
  for (const r of brands) {
    const brand = String(r.brand ?? '').trim();
    if (brand === '') continue;
    if (!brandsById.has(r.supplier_id)) brandsById.set(r.supplier_id, []);
    brandsById.get(r.supplier_id).push({ brand, count: Number(r.product_count) || 0 });
  }
  const stats = { candidates: counts.length, kept: 0, droppedNaturalPersons: 0, unnamed: 0 };
  const suppliers = [];
  for (const r of counts) {
    const name = nameById.get(r.supplier_id);
    if (name === undefined) { stats.unnamed += 1; continue; }
    if (!isLegalEntityName(name)) { stats.droppedNaturalPersons += 1; continue; }
    const topBrands = (brandsById.get(r.supplier_id) ?? [])
      .sort((a, b) => b.count - a.count || a.brand.localeCompare(b.brand, 'pl'))
      .slice(0, TOP_BRANDS)
      .map((b) => b.brand);
    suppliers.push({ name, productCount: Number(r.product_count) || 0, brands: topBrands });
    stats.kept += 1;
  }
  suppliers.sort((a, b) => b.productCount - a.productCount || a.name.localeCompare(b.name, 'pl'));
  return { suppliers, stats };
}
