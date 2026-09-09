// WSZYSTKIE zapytania narzędzia. Wyłącznie odczyt katalogu systemowego (sys.*, INFORMATION_SCHEMA,
// sys.sql_modules) — zero SELECT na tabelach użytkownika, zero DML/DDL. Test
// test/queries-readonly.test.mjs egzekwuje to na tej liście, więc nowe zapytanie dopisuj TUTAJ.
//
// Zapytania per-baza używają prefiksu bazy (`[db].sys.tables`) zamiast `USE`, bo połączenie
// jest do `master`; nazwa bazy pochodzi z sys.databases i jest cytowana przez quoteName().

/** Cytowanie identyfikatora jak QUOTENAME(): [nazwa] z podwojeniem ']'. */
export function quoteName(name) {
  if (typeof name !== 'string' || name === '' || name.length > 128) {
    throw new Error('nieprawidłowa nazwa identyfikatora');
  }
  return `[${name.replaceAll(']', ']]')}]`;
}

export const SERVER_INFO = `
SELECT @@VERSION AS version, SERVERPROPERTY('ProductVersion') AS productVersion,
       SERVERPROPERTY('Edition') AS edition, SERVERPROPERTY('InstanceName') AS instanceName,
       SERVERPROPERTY('Collation') AS collation, SERVERPROPERTY('MachineName') AS machineName`;

export const LIST_DATABASES = `
SELECT d.name, d.database_id AS databaseId, d.state_desc AS state, d.compatibility_level AS compat,
       d.recovery_model_desc AS recovery, d.collation_name AS collation, d.create_date AS createdAt,
       CAST(SUM(CASE WHEN mf.type = 0 THEN mf.size ELSE 0 END) * 8.0 / 1024 AS DECIMAL(12,1)) AS dataMb,
       CAST(SUM(CASE WHEN mf.type = 1 THEN mf.size ELSE 0 END) * 8.0 / 1024 AS DECIMAL(12,1)) AS logMb
FROM sys.databases d
LEFT JOIN sys.master_files mf ON mf.database_id = d.database_id
GROUP BY d.name, d.database_id, d.state_desc, d.compatibility_level, d.recovery_model_desc, d.collation_name, d.create_date
ORDER BY d.name`;

/** Tabele charakterystyczne — obecność rozpoznaje produkt (odcisk), nie czyta danych. */
export const FINGERPRINT_TABLES = {
  insertGt: ['tw__Towar', 'dok__Dokument', 'kh__Kontrahent', 'sl_Uzytkownik', 'pd_Parametr', 'adr__Ewid'],
  insertNexo: ['ModelDanychContainer', 'Podmioty', 'Asortymenty'],
  comarchOptima: ['Towary', 'Kontrahenci', 'TraNag', 'TraElem', 'DokNag', 'Sesje'],
};

export function dbTablesSummary(db) {
  const q = quoteName(db);
  return `
SELECT s.name AS schemaName, t.name AS tableName
FROM ${q}.sys.tables t JOIN ${q}.sys.schemas s ON s.schema_id = t.schema_id
ORDER BY s.name, t.name`;
}

export function dbObjectCounts(db) {
  const q = quoteName(db);
  return `
SELECT type_desc AS typeDesc, COUNT(*) AS cnt
FROM ${q}.sys.objects
WHERE is_ms_shipped = 0 AND type IN ('U','V','P','FN','IF','TF','TR')
GROUP BY type_desc ORDER BY type_desc`;
}

export function dbColumns(db) {
  const q = quoteName(db);
  return `
SELECT s.name AS schemaName, t.name AS tableName, c.column_id AS ordinal, c.name AS columnName,
       ty.name AS typeName, c.max_length AS maxLength, c.precision AS [precision], c.scale AS scale,
       c.is_nullable AS isNullable, c.is_identity AS isIdentity, c.is_computed AS isComputed,
       dc.definition AS defaultDefinition, cc.definition AS computedDefinition,
       CAST(ep.value AS NVARCHAR(4000)) AS description
FROM ${q}.sys.tables t
JOIN ${q}.sys.schemas s ON s.schema_id = t.schema_id
JOIN ${q}.sys.columns c ON c.object_id = t.object_id
JOIN ${q}.sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN ${q}.sys.default_constraints dc ON dc.object_id = c.default_object_id
LEFT JOIN ${q}.sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
LEFT JOIN ${q}.sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id
     AND ep.class = 1 AND ep.name = 'MS_Description'
ORDER BY s.name, t.name, c.column_id`;
}

export function dbTableDescriptions(db) {
  const q = quoteName(db);
  return `
SELECT s.name AS schemaName, t.name AS tableName, CAST(ep.value AS NVARCHAR(4000)) AS description,
       t.create_date AS createdAt, t.modify_date AS modifiedAt
FROM ${q}.sys.tables t
JOIN ${q}.sys.schemas s ON s.schema_id = t.schema_id
LEFT JOIN ${q}.sys.extended_properties ep ON ep.major_id = t.object_id AND ep.minor_id = 0
     AND ep.class = 1 AND ep.name = 'MS_Description'
ORDER BY s.name, t.name`;
}

export function dbKeys(db) {
  const q = quoteName(db);
  return `
SELECT s.name AS schemaName, t.name AS tableName, kc.name AS constraintName, kc.type AS kind,
       ic.key_ordinal AS ordinal, c.name AS columnName
FROM ${q}.sys.key_constraints kc
JOIN ${q}.sys.tables t ON t.object_id = kc.parent_object_id
JOIN ${q}.sys.schemas s ON s.schema_id = t.schema_id
JOIN ${q}.sys.index_columns ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
JOIN ${q}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
ORDER BY s.name, t.name, kc.name, ic.key_ordinal`;
}

export function dbForeignKeys(db) {
  const q = quoteName(db);
  return `
SELECT fk.name AS constraintName, ps.name AS schemaName, pt.name AS tableName, pc.name AS columnName,
       rs.name AS refSchemaName, rt.name AS refTableName, rc.name AS refColumnName,
       fkc.constraint_column_id AS ordinal, fk.delete_referential_action_desc AS onDelete,
       fk.update_referential_action_desc AS onUpdate
FROM ${q}.sys.foreign_keys fk
JOIN ${q}.sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN ${q}.sys.tables pt ON pt.object_id = fk.parent_object_id
JOIN ${q}.sys.schemas ps ON ps.schema_id = pt.schema_id
JOIN ${q}.sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
JOIN ${q}.sys.tables rt ON rt.object_id = fk.referenced_object_id
JOIN ${q}.sys.schemas rs ON rs.schema_id = rt.schema_id
JOIN ${q}.sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
ORDER BY ps.name, pt.name, fk.name, fkc.constraint_column_id`;
}

export function dbIndexes(db) {
  const q = quoteName(db);
  return `
SELECT s.name AS schemaName, t.name AS tableName, i.name AS indexName, i.type_desc AS typeDesc,
       i.is_unique AS isUnique, i.is_primary_key AS isPrimaryKey, i.is_unique_constraint AS isUniqueConstraint,
       ic.key_ordinal AS ordinal, ic.is_included_column AS isIncluded, c.name AS columnName,
       i.filter_definition AS filterDefinition
FROM ${q}.sys.indexes i
JOIN ${q}.sys.tables t ON t.object_id = i.object_id
JOIN ${q}.sys.schemas s ON s.schema_id = t.schema_id
JOIN ${q}.sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN ${q}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE i.type > 0
ORDER BY s.name, t.name, i.name, ic.is_included_column, ic.key_ordinal`;
}

/** Liczności z metadanych partycji — NIE czyta wierszy. */
export function dbRowCounts(db) {
  const q = quoteName(db);
  return `
SELECT s.name AS schemaName, t.name AS tableName, SUM(p.rows) AS rowsCount
FROM ${q}.sys.tables t
JOIN ${q}.sys.schemas s ON s.schema_id = t.schema_id
JOIN ${q}.sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
GROUP BY s.name, t.name ORDER BY s.name, t.name`;
}

/** Widoki, procedury, funkcje, triggery z definicją (sys.sql_modules — wymaga VIEW DEFINITION). */
export function dbModules(db) {
  const q = quoteName(db);
  return `
SELECT s.name AS schemaName, o.name AS objectName, o.type_desc AS typeDesc, o.create_date AS createdAt,
       o.modify_date AS modifiedAt, m.definition AS definition,
       pt.name AS parentTableName
FROM ${q}.sys.objects o
JOIN ${q}.sys.schemas s ON s.schema_id = o.schema_id
LEFT JOIN ${q}.sys.sql_modules m ON m.object_id = o.object_id
LEFT JOIN ${q}.sys.tables pt ON pt.object_id = o.parent_object_id
WHERE o.is_ms_shipped = 0 AND o.type IN ('V','P','FN','IF','TF','TR')
ORDER BY o.type_desc, s.name, o.name`;
}

export function dbParameters(db) {
  const q = quoteName(db);
  return `
SELECT s.name AS schemaName, o.name AS objectName, p.parameter_id AS ordinal, p.name AS paramName,
       ty.name AS typeName, p.max_length AS maxLength, p.precision AS [precision], p.scale AS scale,
       p.is_output AS isOutput, p.has_default_value AS hasDefault
FROM ${q}.sys.parameters p
JOIN ${q}.sys.objects o ON o.object_id = p.object_id
JOIN ${q}.sys.schemas s ON s.schema_id = o.schema_id
JOIN ${q}.sys.types ty ON ty.user_type_id = p.user_type_id
WHERE o.is_ms_shipped = 0
ORDER BY s.name, o.name, p.parameter_id`;
}

/** Typy aliasowe (CREATE TYPE ... FROM ...) — InsERT GT używa ich masowo (tsymbol, tnazwa...). */
export function dbAliasTypes(db) {
  const q = quoteName(db);
  return `
SELECT t.name AS typeName, st.name AS baseTypeName, t.max_length AS maxLength, t.precision AS [precision],
       t.scale AS scale, t.is_nullable AS isNullable
FROM ${q}.sys.types t
JOIN ${q}.sys.types st ON st.user_type_id = t.system_type_id
WHERE t.is_user_defined = 1
ORDER BY t.name`;
}

/** Wszystkie stałe/generatory — do testu read-only. */
export const ALL_QUERIES = {
  SERVER_INFO,
  LIST_DATABASES,
  dbTablesSummary: dbTablesSummary('x'),
  dbObjectCounts: dbObjectCounts('x'),
  dbColumns: dbColumns('x'),
  dbTableDescriptions: dbTableDescriptions('x'),
  dbKeys: dbKeys('x'),
  dbForeignKeys: dbForeignKeys('x'),
  dbIndexes: dbIndexes('x'),
  dbRowCounts: dbRowCounts('x'),
  dbModules: dbModules('x'),
  dbParameters: dbParameters('x'),
  dbAliasTypes: dbAliasTypes('x'),
};
