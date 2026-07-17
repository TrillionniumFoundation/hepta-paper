import fs from 'node:fs';
import { selectReceiptHash } from '../../paper-domain/evidence/receipt-hash-selector.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function fileHash(file) {
  return sha256FileSync(file);
}

function queryRows(store, sql) {
  const result = store.query(sql);
  if (!result.ok) throw new Error(result.error || result.stderr || 'sqlite_readonly_integrity_query_failed');
  return result.rows || [];
}

export function buildSqliteLogicalIntegrityReport({ dbPath, store } = {}) {
  if (!dbPath || !fs.existsSync(dbPath)) throw new Error(`SQLite database missing: ${dbPath || '(unset)'}`);
  if (!store || typeof store.query !== 'function') throw new Error('Read-only StorePort is required for logical integrity');
  const byteHashBefore = fileHash(dbPath);
  const schemaRows = queryRows(store, `
SELECT type,name,tbl_name,coalesce(sql,'') AS sql
FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%'
ORDER BY type,name,tbl_name;
`);
  const tables = schemaRows.filter((row) => row.type === 'table').map((row) => row.name);
  const tableReports = tables.map((table) => {
    const columns = queryRows(store, `PRAGMA table_info(${quoteIdentifier(table)});`);
    const primaryKey = columns.filter((column) => Number(column.pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((column) => column.name);
    const orderColumns = primaryKey.length ? primaryKey : columns.map((column) => column.name);
    const order = orderColumns.length
      ? ` ORDER BY ${orderColumns.map(quoteIdentifier).join(',')}`
      : '';
    const canonicalRows = queryRows(store, `SELECT * FROM ${quoteIdentifier(table)}${order};`);
    const rowCount = Number(queryRows(store, `SELECT count(*) AS count FROM ${quoteIdentifier(table)};`)[0]?.count || 0);
    return {
      name: table,
      rowCount,
      primaryKey,
      canonicalRowsHash: hashRecord('SqliteCanonicalRows', canonicalRows),
    };
  });
  const quickCheckRows = queryRows(store, 'PRAGMA quick_check;');
  const quickCheck = String(quickCheckRows[0]?.quick_check || quickCheckRows[0]?.integrity_check || 'unknown');
  const foreignKeyRows = queryRows(store, 'PRAGMA foreign_key_check;');
  const receiptRows = tables.includes('receipt_ledger')
    ? queryRows(store, 'SELECT receipt_id,receipt_json,receipt_sha256 FROM receipt_ledger ORDER BY receipt_id;')
    : [];
  const invalidReceiptRows = receiptRows.flatMap((row) => {
    try {
      const receipt = JSON.parse(row.receipt_json);
      const expected = selectReceiptHash(receipt);
      return expected === row.receipt_sha256 && String(row.receipt_id).endsWith(`:${expected}`)
        ? []
        : [{ receiptId: row.receipt_id, expected, actual: row.receipt_sha256 }];
    } catch (error) {
      return [{ receiptId: row.receipt_id, error: error.name }];
    }
  });
  const logicalSubject = {
    schemaRows,
    tables: tableReports,
  };
  const logicalDatabaseHash = hashRecord('SqliteLogicalDatabase', logicalSubject);
  const byteHashAfter = fileHash(dbPath);
  const blockers = [
    ...(quickCheck === 'ok' ? [] : ['sqlite_quick_check_failed']),
    ...(foreignKeyRows.length ? ['sqlite_foreign_key_check_failed'] : []),
    ...(invalidReceiptRows.length ? ['receipt_ledger_hash_mismatch'] : []),
    ...(byteHashBefore === byteHashAfter ? [] : ['readonly_integrity_check_mutated_database']),
  ];
  return Object.freeze({
    version: 1,
    kind: 'SqliteLogicalIntegrityReport',
    status: blockers.length ? 'sqlite_logical_integrity_blocked' : 'sqlite_logical_integrity_verified',
    dbPath,
    byteHashBefore,
    byteHashAfter,
    readonlyCheckMutatedDatabase: byteHashBefore !== byteHashAfter,
    logicalDatabaseHash,
    schemaHash: hashRecord('SqliteSchema', schemaRows),
    tableCount: tableReports.length,
    totalRowCount: tableReports.reduce((sum, table) => sum + table.rowCount, 0),
    tables: tableReports,
    quickCheck,
    foreignKeyViolationCount: foreignKeyRows.length,
    receiptLedgerRowCount: receiptRows.length,
    invalidReceiptHashCount: invalidReceiptRows.length,
    invalidReceiptRows: invalidReceiptRows.slice(0, 20),
    blockers,
  });
}
