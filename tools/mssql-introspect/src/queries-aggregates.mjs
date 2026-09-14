// Stałe, BEZPARAMETROWE agregaty T-SQL dla schematu Subiekt GT (instancja produkcyjna Magnum_Profi).
// Czysta logika: lista AGGREGATES + funkcja k-anonimizacji; wykonaniem zajmuje się dump-aggregates.mjs.
//
// Reguły (egzekwowane w test/queries-aggregates.test.mjs):
//  - każde zapytanie przechodzi checkReadOnly z src/mcp-readonly.mjs (pojedynczy SELECT/WITH, zero DML,
//    deny-lista kolumn osobowych, zakaz `*` na tabelach z danymi osobowymi);
//  - każde zawiera COUNT/SUM/AVG/MIN/MAX i albo ma GROUP BY, albo zwraca jeden wiersz (shape 'single');
//  - żadne nie projektuje nazw/adresów/NIP/PESEL/e-maili/telefonów — jedyne dozwolone kolumny tekstowe to
//    etykiety pól własnych (twp_Nazwa*, twp_NazwaCeny*, khp_Nazwa*), nazwy grup towarowych (grt_Nazwa)
//    i magazynów (mag_Nazwa/mag_Symbol) — to nie są dane osób;
//  - agregaty kind 'people' liczą KONTRAHENTÓW (w tym osoby fizyczne) — ich liczniki (kColumns) poniżej
//    progu k są zastępowane "<k" (k-anonimowość; docs/data-governance.md §1.3).
//
// Źródła znaczeń kodów (dokumentacja producenta, /srv/kag-data/import/subiektkb/out/db/modul-*.md):
//  dok_Typ: 1-FZ 2-FS 3-RZ 4-RS 5-KFZ 6-KFS 9-MM 10-PZ 11-WZ 12-PW 13-RW 14-ZW 15-ZD 16-ZK 21-PA 29-IW
//           35-ZPZ 36-ZWZ 51-TS 62-FM 67-KFM 72-ZM
//  tw_Rodzaj: 1-towar 2-usługa 4-opakowanie 8-komplet 16-opłata (CHECK w katalogu potwierdza zbiór)
//  kh_Rodzaj: 0-dostawca/odbiorca 1-dostawca 2-odbiorca 3-żaden;  kh_Osoba: 1 = osoba fizyczna
//  dok_PlatnikId = kontrahent dokumentu (na FS/PA płatnik, na FZ/PZ dostawca).

export const DOC_TYPES = Object.freeze({
  1: 'FZ', 2: 'FS', 3: 'RZ', 4: 'RS', 5: 'KFZ', 6: 'KFS', 9: 'MM', 10: 'PZ', 11: 'WZ', 12: 'PW', 13: 'RW',
  14: 'ZW', 15: 'ZD', 16: 'ZK', 21: 'PA', 29: 'IW', 35: 'ZPZ', 36: 'ZWZ', 51: 'TS', 62: 'FM', 67: 'KFM', 72: 'ZM',
});
export const SALES_DOC_TYPES = Object.freeze([2, 21]); // FS, PA
export const PURCHASE_DOC_TYPES = Object.freeze([1, 10]); // FZ, PZ
export const PRODUCT_KINDS = Object.freeze({ 1: 'towar', 2: 'usługa', 4: 'opakowanie', 8: 'komplet', 16: 'opłata' });
export const CONTRACTOR_KINDS = Object.freeze({ 0: 'dostawca/odbiorca', 1: 'dostawca', 2: 'odbiorca', 3: 'żaden' });

export const K_DEFAULT = 10;
export const KINDS = Object.freeze(['people', 'products', 'documents', 'suppliers', 'fields', 'warehouses']);
export const SHAPES = Object.freeze(['single', 'grouped']);
/** Górny limit wierszy zapisywanych z jednego agregatu (rankingi mają TOP w SQL; to bezpiecznik). */
export const MAX_ROWS = 500;

const SALES = SALES_DOC_TYPES.join(', ');
const PURCHASE = PURCHASE_DOC_TYPES.join(', ');
const FIELD_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8];
/** Licznik wierszy z niepustym polem tekstowym (pola własne są NOT NULL DEFAULT ''). */
const nonEmptyCount = (col) => `SUM(CASE WHEN LTRIM(RTRIM(ISNULL(${col}, ''))) <> '' THEN 1 ELSE 0 END)`;
const customFieldUsage = (prefix) => FIELD_NUMBERS.map((i) => `${nonEmptyCount(`${prefix}${i}`)} AS field${i}_used`).join(',\n       ');

/**
 * @typedef {object} Aggregate
 * @property {string} id
 * @property {string} title  tytuł po polsku (do renderu)
 * @property {'people'|'products'|'documents'|'suppliers'|'fields'|'warehouses'} kind
 * @property {'single'|'grouped'} shape  'single' = dokładnie jeden wiersz wynikowy
 * @property {string} sql
 * @property {string[]} [kColumns]  kind 'people': kolumny-liczniki kontrahentów objęte progiem k
 */

/** @type {readonly Aggregate[]} */
export const AGGREGATES = Object.freeze([
  // ── a) kontrahenci ──────────────────────────────────────────────────────────────────────
  {
    id: 'contractors_total',
    title: 'Kontrahenci — łącznie (w tym zablokowani i jednorazowi)',
    kind: 'people',
    shape: 'single',
    kColumns: ['contractor_count', 'blocked_count', 'one_off_count', 'potential_count'],
    sql: `
SELECT COUNT(*) AS contractor_count,
       SUM(CASE WHEN kh_Zablokowany = 1 THEN 1 ELSE 0 END) AS blocked_count,
       SUM(CASE WHEN kh_Jednorazowy = 1 THEN 1 ELSE 0 END) AS one_off_count,
       SUM(CASE WHEN kh_Potencjalny = 1 THEN 1 ELSE 0 END) AS potential_count
FROM kh__Kontrahent`,
  },
  {
    id: 'contractors_by_person',
    title: 'Kontrahenci wg formy: osoba fizyczna (kh_Osoba = 1) vs firma (0)',
    kind: 'people',
    shape: 'grouped',
    kColumns: ['contractor_count'],
    sql: `
SELECT kh_Osoba AS is_person, COUNT(*) AS contractor_count
FROM kh__Kontrahent
GROUP BY kh_Osoba
ORDER BY kh_Osoba`,
  },
  {
    id: 'contractors_by_retail_and_person',
    title: 'Kontrahenci wg flagi odbiorcy detalicznego (kh_OdbDet) × osoba/firma (kh_Osoba)',
    kind: 'people',
    shape: 'grouped',
    kColumns: ['contractor_count'],
    sql: `
SELECT kh_OdbDet AS is_retail, kh_Osoba AS is_person, COUNT(*) AS contractor_count
FROM kh__Kontrahent
GROUP BY kh_OdbDet, kh_Osoba
ORDER BY kh_OdbDet, kh_Osoba`,
  },
  {
    id: 'contractors_by_declared_kind',
    title: 'Kontrahenci wg zadeklarowanego rodzaju (kh_Rodzaj: 0 dost./odb., 1 dostawca, 2 odbiorca, 3 żaden)',
    kind: 'people',
    shape: 'grouped',
    kColumns: ['contractor_count'],
    sql: `
SELECT kh_Rodzaj AS declared_kind, COUNT(*) AS contractor_count
FROM kh__Kontrahent
GROUP BY kh_Rodzaj
ORDER BY kh_Rodzaj`,
  },
  {
    id: 'contractors_by_document_role',
    title: `Kontrahenci wg roli w dokumentach: płatnik na sprzedaży (dok_Typ ${SALES} = FS/PA) vs dostawca na zakupie (dok_Typ ${PURCHASE} = FZ/PZ) vs obie role`,
    kind: 'people',
    shape: 'single',
    kColumns: ['customer_only', 'supplier_only', 'both_roles', 'any_role'],
    sql: `
WITH roles AS (
  SELECT dok_PlatnikId AS contractor_id,
         MAX(CASE WHEN dok_Typ IN (${SALES}) THEN 1 ELSE 0 END) AS is_customer,
         MAX(CASE WHEN dok_Typ IN (${PURCHASE}) THEN 1 ELSE 0 END) AS is_supplier
  FROM dok__Dokument
  WHERE dok_PlatnikId IS NOT NULL AND dok_Typ IN (${SALES}, ${PURCHASE})
  GROUP BY dok_PlatnikId
)
SELECT SUM(CASE WHEN is_customer = 1 AND is_supplier = 0 THEN 1 ELSE 0 END) AS customer_only,
       SUM(CASE WHEN is_customer = 0 AND is_supplier = 1 THEN 1 ELSE 0 END) AS supplier_only,
       SUM(CASE WHEN is_customer = 1 AND is_supplier = 1 THEN 1 ELSE 0 END) AS both_roles,
       COUNT(*) AS any_role
FROM roles`,
  },
  {
    id: 'contractor_groups_and_features',
    title: 'Grupy kontrahentów (sl_GrupaKh) i cechy (sl_CechaKh) — wyłącznie liczności',
    kind: 'people',
    shape: 'single',
    kColumns: ['contractors_in_group', 'contractors_with_feature'],
    sql: `
SELECT (SELECT COUNT(*) FROM sl_GrupaKh) AS groups_defined,
       (SELECT COUNT(DISTINCT kh_IdGrupa) FROM kh__Kontrahent WHERE kh_IdGrupa IS NOT NULL) AS groups_used,
       (SELECT COUNT(*) FROM kh__Kontrahent WHERE kh_IdGrupa IS NOT NULL) AS contractors_in_group,
       (SELECT COUNT(*) FROM sl_CechaKh) AS features_defined,
       (SELECT COUNT(DISTINCT ck_IdCecha) FROM kh_CechaKh) AS features_used,
       (SELECT COUNT(DISTINCT ck_IdKhnt) FROM kh_CechaKh) AS contractors_with_feature,
       (SELECT COUNT(*) FROM kh_CechaKh) AS feature_assignments`,
  },

  // ── b) towary ───────────────────────────────────────────────────────────────────────────
  {
    id: 'products_total',
    title: 'Kartoteka towarów — łącznie, w tym oznaczone jako usunięte (tw_Usuniety)',
    kind: 'products',
    shape: 'single',
    sql: `
SELECT COUNT(*) AS product_count,
       SUM(CASE WHEN tw_Usuniety = 1 THEN 1 ELSE 0 END) AS deleted_count,
       SUM(CASE WHEN tw_Usuniety = 0 THEN 1 ELSE 0 END) AS live_count
FROM tw__Towar`,
  },
  {
    id: 'products_by_kind',
    title: 'Towary (bez usuniętych) wg rodzaju kartoteki (tw_Rodzaj: 1 towar, 2 usługa, 4 opakowanie, 8 komplet, 16 opłata)',
    kind: 'products',
    shape: 'grouped',
    sql: `
SELECT tw_Rodzaj AS product_kind, COUNT(*) AS product_count
FROM tw__Towar
WHERE tw_Usuniety = 0
GROUP BY tw_Rodzaj
ORDER BY tw_Rodzaj`,
  },
  {
    id: 'products_by_blocked',
    title: 'Towary (bez usuniętych): zablokowane (tw_Zablokowany = 1) vs aktywne (0)',
    kind: 'products',
    shape: 'grouped',
    sql: `
SELECT tw_Zablokowany AS is_blocked, COUNT(*) AS product_count
FROM tw__Towar
WHERE tw_Usuniety = 0
GROUP BY tw_Zablokowany
ORDER BY tw_Zablokowany`,
  },
  {
    id: 'products_default_supplier',
    title: 'Towary (bez usuniętych) z ustawionym podstawowym dostawcą (tw_IdPodstDostawca)',
    kind: 'products',
    shape: 'single',
    sql: `
SELECT COUNT(*) AS product_count,
       SUM(CASE WHEN tw_IdPodstDostawca IS NOT NULL AND tw_IdPodstDostawca > 0 THEN 1 ELSE 0 END) AS with_default_supplier,
       SUM(CASE WHEN tw_IdPodstDostawca IS NULL OR tw_IdPodstDostawca <= 0 THEN 1 ELSE 0 END) AS without_default_supplier,
       SUM(CASE WHEN tw_IdProducenta IS NOT NULL AND tw_IdProducenta > 0 THEN 1 ELSE 0 END) AS with_producer
FROM tw__Towar
WHERE tw_Usuniety = 0`,
  },
  {
    id: 'products_by_brand',
    title: 'Towary (bez usuniętych) wg grupy towarowej / marki (sl_GrupaTw) — NULL = bez grupy',
    kind: 'products',
    shape: 'grouped',
    sql: `
SELECT t.tw_IdGrupa AS group_id, g.grt_Nazwa AS group_name, COUNT(*) AS product_count,
       SUM(CASE WHEN t.tw_Zablokowany = 0 THEN 1 ELSE 0 END) AS active_count
FROM tw__Towar t
LEFT JOIN sl_GrupaTw g ON g.grt_Id = t.tw_IdGrupa
WHERE t.tw_Usuniety = 0
GROUP BY t.tw_IdGrupa, g.grt_Nazwa
ORDER BY COUNT(*) DESC, t.tw_IdGrupa`,
  },
  {
    id: 'products_sales_channels',
    title: 'Towary (bez usuniętych) oznaczone do sklepu internetowego (tw_SklepInternet), serwisu aukcyjnego i sprzedaży mobilnej',
    kind: 'products',
    shape: 'single',
    sql: `
SELECT COUNT(*) AS product_count,
       SUM(CASE WHEN tw_SklepInternet = 1 THEN 1 ELSE 0 END) AS eshop_count,
       SUM(CASE WHEN tw_SerwisAukcyjny = 1 THEN 1 ELSE 0 END) AS auction_count,
       SUM(CASE WHEN tw_SprzedazMobilna = 1 THEN 1 ELSE 0 END) AS mobile_count,
       SUM(CASE WHEN tw_SklepInternet = 1 AND tw_Zablokowany = 0 THEN 1 ELSE 0 END) AS eshop_active_count
FROM tw__Towar
WHERE tw_Usuniety = 0`,
  },

  // ── c) dokumenty ────────────────────────────────────────────────────────────────────────
  {
    id: 'documents_date_range',
    title: 'Dokumenty — łącznie oraz zakres dat wystawienia (dok_DataWyst)',
    kind: 'documents',
    shape: 'single',
    sql: `
SELECT COUNT(*) AS doc_count, MIN(dok_DataWyst) AS first_date, MAX(dok_DataWyst) AS last_date,
       COUNT(DISTINCT dok_Typ) AS doc_types_used
FROM dok__Dokument`,
  },
  {
    id: 'documents_by_type',
    title: 'Dokumenty wg typu (dok_Typ) — cała historia, z zakresem dat',
    kind: 'documents',
    shape: 'grouped',
    sql: `
SELECT dok_Typ AS doc_type, COUNT(*) AS doc_count, MIN(dok_DataWyst) AS first_date, MAX(dok_DataWyst) AS last_date
FROM dok__Dokument
GROUP BY dok_Typ
ORDER BY dok_Typ`,
  },
  {
    id: 'documents_by_type_year',
    title: 'Dokumenty wg typu (dok_Typ) i roku wystawienia — bieżący rok i 2 poprzednie',
    kind: 'documents',
    shape: 'grouped',
    sql: `
SELECT dok_Typ AS doc_type, YEAR(dok_DataWyst) AS doc_year, COUNT(*) AS doc_count
FROM dok__Dokument
WHERE dok_DataWyst >= DATEADD(YEAR, DATEDIFF(YEAR, 0, GETDATE()) - 2, 0)
GROUP BY dok_Typ, YEAR(dok_DataWyst)
ORDER BY YEAR(dok_DataWyst), dok_Typ`,
  },
  {
    id: 'documents_by_month',
    title: `Dokumenty wg miesiąca wystawienia — ostatnie 24 miesiące (sprzedaż = dok_Typ ${SALES}, zakup = ${PURCHASE})`,
    kind: 'documents',
    shape: 'grouped',
    sql: `
SELECT YEAR(dok_DataWyst) AS doc_year, MONTH(dok_DataWyst) AS doc_month, COUNT(*) AS doc_count,
       SUM(CASE WHEN dok_Typ IN (${SALES}) THEN 1 ELSE 0 END) AS sales_count,
       SUM(CASE WHEN dok_Typ IN (${PURCHASE}) THEN 1 ELSE 0 END) AS purchase_count
FROM dok__Dokument
WHERE dok_DataWyst >= DATEADD(MONTH, DATEDIFF(MONTH, 0, GETDATE()) - 23, 0)
GROUP BY YEAR(dok_DataWyst), MONTH(dok_DataWyst)
ORDER BY YEAR(dok_DataWyst), MONTH(dok_DataWyst)`,
  },

  // ── d) koncentracja dostawców (bez nazw — wyłącznie rangi) ─────────────────────────────
  {
    id: 'suppliers_default_count',
    title: 'Liczba różnych podstawowych dostawców (DISTINCT tw_IdPodstDostawca) na towarach bez usuniętych',
    kind: 'people',
    shape: 'single',
    kColumns: ['supplier_count'],
    sql: `
SELECT COUNT(DISTINCT tw_IdPodstDostawca) AS supplier_count, COUNT(*) AS products_with_supplier
FROM tw__Towar
WHERE tw_Usuniety = 0 AND tw_IdPodstDostawca IS NOT NULL AND tw_IdPodstDostawca > 0`,
  },
  {
    id: 'suppliers_product_coverage_by_rank',
    title: 'Pokrycie kartoteki przez dostawców wg rangi (TOP 20): towary dostawcy, skumulowane, udział — bez nazw',
    kind: 'suppliers',
    shape: 'grouped',
    sql: `
WITH per_supplier AS (
  SELECT tw_IdPodstDostawca AS supplier_id, COUNT(*) AS product_count
  FROM tw__Towar
  WHERE tw_Usuniety = 0 AND tw_IdPodstDostawca IS NOT NULL AND tw_IdPodstDostawca > 0
  GROUP BY tw_IdPodstDostawca
), ranked AS (
  SELECT product_count,
         ROW_NUMBER() OVER (ORDER BY product_count DESC, supplier_id) AS supplier_rank,
         SUM(product_count) OVER () AS total_products
  FROM per_supplier
)
SELECT TOP 20 supplier_rank, product_count,
       SUM(product_count) OVER (ORDER BY supplier_rank ROWS UNBOUNDED PRECEDING) AS cumulative_products,
       CAST(CAST(product_count AS DECIMAL(18, 4)) / total_products AS DECIMAL(6, 4)) AS share,
       CAST(CAST(SUM(product_count) OVER (ORDER BY supplier_rank ROWS UNBOUNDED PRECEDING) AS DECIMAL(18, 4)) / total_products AS DECIMAL(6, 4)) AS cumulative_share
FROM ranked
ORDER BY supplier_rank`,
  },
  {
    id: 'purchase_invoices_by_supplier_rank',
    title: 'Faktury zakupu (dok_Typ 1 = FZ) wg rangi dostawcy (TOP 20): liczba dokumentów, udział, udział skumulowany — bez nazw',
    kind: 'suppliers',
    shape: 'grouped',
    sql: `
WITH per_supplier AS (
  SELECT dok_PlatnikId AS supplier_id, COUNT(*) AS doc_count
  FROM dok__Dokument
  WHERE dok_Typ = 1 AND dok_PlatnikId IS NOT NULL
  GROUP BY dok_PlatnikId
), ranked AS (
  SELECT doc_count,
         ROW_NUMBER() OVER (ORDER BY doc_count DESC, supplier_id) AS supplier_rank,
         SUM(doc_count) OVER () AS total_docs,
         COUNT(*) OVER () AS supplier_count
  FROM per_supplier
)
SELECT TOP 20 supplier_rank, doc_count, supplier_count,
       CAST(CAST(doc_count AS DECIMAL(18, 4)) / total_docs AS DECIMAL(6, 4)) AS share,
       CAST(CAST(SUM(doc_count) OVER (ORDER BY supplier_rank ROWS UNBOUNDED PRECEDING) AS DECIMAL(18, 4)) / total_docs AS DECIMAL(6, 4)) AS cumulative_share
FROM ranked
ORDER BY supplier_rank`,
  },

  // ── e) pola własne i poziomy cen (etykiety, nie wartości) ──────────────────────────────
  {
    id: 'product_field_labels',
    title: 'Etykiety pól własnych towaru (twp_Nazwa1..8) i nazwy poziomów cen (twp_NazwaCeny1..10) — tw_Parametr',
    kind: 'fields',
    shape: 'single',
    sql: `
SELECT ${FIELD_NUMBERS.map((i) => `MAX(twp_Nazwa${i}) AS field${i}_label`).join(', ')},
       ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => `MAX(twp_NazwaCeny${i}) AS price${i}_label`).join(', ')},
       COUNT(*) AS parameter_rows
FROM tw_Parametr`,
  },
  {
    id: 'product_custom_field_usage',
    title: 'Towary (bez usuniętych) z niepustym polem własnym tw_Pole1..8',
    kind: 'products',
    shape: 'single',
    sql: `
SELECT COUNT(*) AS product_count,
       ${customFieldUsage('tw_Pole')}
FROM tw__Towar
WHERE tw_Usuniety = 0`,
  },
  {
    id: 'contractor_field_labels',
    title: 'Etykiety pól własnych kontrahenta (khp_Nazwa1..8) — kh_ParametrG',
    kind: 'fields',
    shape: 'single',
    sql: `
SELECT ${FIELD_NUMBERS.map((i) => `MAX(khp_Nazwa${i}) AS field${i}_label`).join(', ')},
       COUNT(*) AS parameter_rows
FROM kh_ParametrG`,
  },
  {
    id: 'contractor_custom_field_usage',
    title: 'Kontrahenci z niepustym polem własnym kh_Pole1..8',
    kind: 'people',
    shape: 'single',
    kColumns: ['contractor_count', ...FIELD_NUMBERS.map((i) => `field${i}_used`)],
    sql: `
SELECT COUNT(*) AS contractor_count,
       ${customFieldUsage('kh_Pole')}
FROM kh__Kontrahent`,
  },

  // ── f) magazyny ─────────────────────────────────────────────────────────────────────────
  {
    id: 'documents_by_warehouse',
    title: 'Magazyny (sl_Magazyn) z liczbą dokumentów i zakresem dat',
    kind: 'warehouses',
    shape: 'grouped',
    sql: `
SELECT m.mag_Id AS warehouse_id, m.mag_Symbol AS warehouse_symbol, m.mag_Nazwa AS warehouse_name,
       m.mag_Status AS warehouse_status, m.mag_Glowny AS is_main,
       COUNT(d.dok_Id) AS doc_count, MIN(d.dok_DataWyst) AS first_date, MAX(d.dok_DataWyst) AS last_date
FROM sl_Magazyn m
LEFT JOIN dok__Dokument d ON d.dok_MagId = m.mag_Id
GROUP BY m.mag_Id, m.mag_Symbol, m.mag_Nazwa, m.mag_Status, m.mag_Glowny
ORDER BY m.mag_Id`,
  },
  {
    id: 'documents_by_warehouse_and_type',
    title: 'Dokumenty wg magazynu i typu (dok_MagId × dok_Typ) — bieżący rok i 2 poprzednie',
    kind: 'warehouses',
    shape: 'grouped',
    sql: `
SELECT d.dok_MagId AS warehouse_id, m.mag_Symbol AS warehouse_symbol, d.dok_Typ AS doc_type, COUNT(*) AS doc_count
FROM dok__Dokument d
LEFT JOIN sl_Magazyn m ON m.mag_Id = d.dok_MagId
WHERE d.dok_DataWyst >= DATEADD(YEAR, DATEDIFF(YEAR, 0, GETDATE()) - 2, 0)
GROUP BY d.dok_MagId, m.mag_Symbol, d.dok_Typ
ORDER BY d.dok_MagId, d.dok_Typ`,
  },
]);

/**
 * k-anonimizacja: w każdym wierszu liczniki z `columns` mniejsze niż k (także 0) zastępuje "<k".
 * Kolumny nienumeryczne i klucze grupowania nie są dotykane. Czysta funkcja — zwraca nowe wiersze.
 */
export function suppressSmallCounts(rows, k, columns) {
  if (!Number.isInteger(k) || k < 1) throw new Error('próg k musi być liczbą całkowitą >= 1');
  const cols = new Set(columns);
  return rows.map((row) => {
    const out = { ...row };
    for (const c of cols) {
      const v = out[c];
      if (typeof v === 'number' && Number.isFinite(v) && v < k) out[c] = '<k';
    }
    return out;
  });
}

/**
 * Stosuje próg k do wyniku agregatu: tylko kind 'people'. Brak zadeklarowanych kColumns = fail-closed
 * (wszystkie kolumny numeryczne wiersza podlegają progowi).
 */
export function applyKAnonymity(aggregate, rows, k) {
  if (aggregate.kind !== 'people') return rows;
  const columns = aggregate.kColumns?.length ? aggregate.kColumns : [...new Set(rows.flatMap((r) => Object.keys(r).filter((c) => typeof r[c] === 'number')))];
  return suppressSmallCounts(rows, k, columns);
}

/** Wartości sterownika mssql → JSON: daty jako YYYY-MM-DD, bigint jako Number, binaria pomijane. */
export function plainRows(rows) {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, v]) => {
    if (v instanceof Date) return [key, Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10)];
    if (typeof v === 'bigint') return [key, Number(v)];
    if (v !== null && typeof v === 'object') return [key, null];
    return [key, v];
  })));
}
