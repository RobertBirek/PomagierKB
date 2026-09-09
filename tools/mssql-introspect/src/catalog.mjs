// Budowa modelu katalogu (tools/kb-import/lib/catalog-md.mjs) z wyników zapytań sys.*.
// Czysta transformacja wierszy → model; testowalna na fixture bez połączenia.

import { emptyCatalog, ensureTable, formatSqlType, tableKey } from '../../kb-import/lib/catalog-md.mjs';

/** Moduły kadrowo-płacowe: liczności wierszy pomijane (ostrożność wg data-governance). */
export const ROWCOUNT_SKIP_PREFIX = /^(pr|gr|ub|um|kd|pl|zus|del|wyn|lp)_/i;

export function buildCatalog(meta, rows) {
  const catalog = emptyCatalog(meta);
  const alias = new Map();
  for (const a of rows.aliasTypes ?? []) {
    alias.set(a.typeName.toLowerCase(), formatSqlType(a.baseTypeName, a.maxLength, a.precision, a.scale));
  }
  catalog.aliasTypes = Object.fromEntries([...alias.entries()].sort());
  const typeOf = (r) => {
    const base = formatSqlType(r.typeName, r.maxLength, r.precision, r.scale);
    const a = alias.get(String(r.typeName).toLowerCase());
    return a ? `${r.typeName} (${a})` : base;
  };
  for (const r of rows.tables ?? []) {
    const t = ensureTable(catalog, r.schemaName, r.tableName);
    t.description = r.description || null;
  }
  for (const r of rows.columns ?? []) {
    const t = ensureTable(catalog, r.schemaName, r.tableName);
    t.columns.push({
      name: r.columnName,
      type: typeOf(r),
      nullable: Boolean(r.isNullable),
      identity: Boolean(r.isIdentity),
      computed: r.computedDefinition || null,
      default: r.defaultDefinition || null,
      description: r.description || null,
    });
  }
  const keyGroups = new Map();
  for (const r of rows.keys ?? []) {
    const k = `${tableKey(r.schemaName, r.tableName)}|${r.constraintName}`;
    if (!keyGroups.has(k)) keyGroups.set(k, { schema: r.schemaName, table: r.tableName, name: r.constraintName, kind: r.kind, cols: [] });
    keyGroups.get(k).cols.push(r.columnName);
  }
  for (const g of keyGroups.values()) {
    const t = ensureTable(catalog, g.schema, g.table);
    if (g.kind === 'PK') t.pk = g.cols;
    else t.uniques.push({ name: g.name, cols: g.cols });
  }
  const fkGroups = new Map();
  for (const r of rows.foreignKeys ?? []) {
    const k = `${tableKey(r.schemaName, r.tableName)}|${r.constraintName}`;
    if (!fkGroups.has(k)) {
      fkGroups.set(k, {
        schema: r.schemaName,
        table: r.tableName,
        name: r.constraintName,
        cols: [],
        refTable: tableKey(r.refSchemaName, r.refTableName),
        refCols: [],
        onDelete: r.onDelete,
        onUpdate: r.onUpdate,
      });
    }
    const g = fkGroups.get(k);
    g.cols.push(r.columnName);
    g.refCols.push(r.refColumnName);
  }
  for (const g of fkGroups.values()) {
    const t = ensureTable(catalog, g.schema, g.table);
    t.fks.push({ name: g.name, cols: g.cols, refTable: g.refTable, refCols: g.refCols, onDelete: g.onDelete, onUpdate: g.onUpdate });
    const ref = catalog.tables[g.refTable];
    if (ref) ref.referencedBy.push({ fromTable: tableKey(g.schema, g.table), cols: g.cols, refCols: g.refCols });
  }
  const idxGroups = new Map();
  for (const r of rows.indexes ?? []) {
    const k = `${tableKey(r.schemaName, r.tableName)}|${r.indexName}`;
    if (!idxGroups.has(k)) {
      idxGroups.set(k, {
        schema: r.schemaName,
        table: r.tableName,
        name: r.indexName,
        type: r.typeDesc,
        unique: Boolean(r.isUnique),
        primaryKey: Boolean(r.isPrimaryKey),
        cols: [],
        includes: [],
        filter: r.filterDefinition || null,
      });
    }
    const g = idxGroups.get(k);
    if (r.isIncluded) g.includes.push(r.columnName);
    else g.cols.push(r.columnName);
  }
  for (const g of idxGroups.values()) ensureTable(catalog, g.schema, g.table).indexes.push(g);
  for (const r of rows.rowCounts ?? []) {
    if (ROWCOUNT_SKIP_PREFIX.test(r.tableName)) continue;
    const t = catalog.tables[tableKey(r.schemaName, r.tableName)];
    if (t) t.rows = Number(r.rowsCount);
  }
  const params = new Map();
  for (const p of rows.parameters ?? []) {
    const k = tableKey(p.schemaName, p.objectName);
    if (!params.has(k)) params.set(k, []);
    params.get(k).push({ name: p.paramName, type: typeOf(p), output: Boolean(p.isOutput) });
  }
  for (const m of rows.modules ?? []) {
    catalog.modules.push({
      schema: m.schemaName,
      name: m.objectName,
      type: m.typeDesc,
      parentTable: m.parentTableName ? `${m.schemaName}.${m.parentTableName}` : null,
      definition: m.definition || null,
      params: params.get(tableKey(m.schemaName, m.objectName)) ?? [],
      createdAt: m.createdAt,
      modifiedAt: m.modifiedAt,
    });
  }
  return catalog;
}
