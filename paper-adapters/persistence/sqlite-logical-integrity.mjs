import crypto from 'node:crypto';
import fs from 'node:fs';
import { selectReceiptHash } from '../../paper-domain/evidence/receipt-hash-selector.mjs';
import { hashRecord, stableStringify } from '../../workflow-kernel/record-hash.mjs';
import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';

const DEFAULT_ROW_BATCH_SIZE = 500;

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function fileHash(file) {
  return sha256FileSync(file);
}

function queryRows(store, sql, parameters = []) {
  const result = store.query(sql, parameters);
  if (!result.ok) throw new Error(result.error || result.stderr || 'sqlite_readonly_integrity_query_failed');
  return result.rows || [];
}

function normalizedBatchSize(value) {
  const batchSize = Number(value ?? DEFAULT_ROW_BATCH_SIZE);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new Error('sqlite_logical_integrity_batch_size_invalid');
  }
  return batchSize;
}

function forEachCanonicalRow({ store, table, order, rowCount, batchSize, visit }) {
  let offset = 0;
  while (offset < rowCount) {
    const rows = queryRows(
      store,
      `SELECT * FROM ${quoteIdentifier(table)}${order} LIMIT ? OFFSET ?;`,
      [Math.min(batchSize, rowCount - offset), offset],
    );
    if (rows.length === 0) throw new Error(`sqlite_logical_integrity_row_count_drift:${table}`);
    for (const row of rows) visit(row);
    offset += rows.length;
  }
  if (offset !== rowCount) throw new Error(`sqlite_logical_integrity_row_count_drift:${table}`);
}

function canonicalRowsHash(input) {
  const hasher = crypto.createHash('sha256');
  hasher.update('{"kind":"SqliteCanonicalRows","value":[');
  let first = true;
  forEachCanonicalRow({
    ...input,
    visit(row) {
      if (!first) hasher.update(',');
      hasher.update(stableStringify(row));
      first = false;
    },
  });
  hasher.update(']}');
  return `sha256:${hasher.digest('hex')}`;
}

function inspectReceiptLedger({ store, rowCount, batchSize }) {
  let invalidReceiptHashCount = 0;
  const invalidReceiptRows = [];
  forEachCanonicalRow({
    store,
    table: 'receipt_ledger',
    order: ' ORDER BY "receipt_id"',
    rowCount,
    batchSize,
    visit(row) {
      let invalid = null;
      try {
        const receipt = JSON.parse(row.receipt_json);
        const expected = selectReceiptHash(receipt);
        if (expected !== row.receipt_sha256
          || !String(row.receipt_id).endsWith(`:${expected}`)) {
          invalid = { receiptId: row.receipt_id, expected, actual: row.receipt_sha256 };
        }
      } catch (error) {
        invalid = { receiptId: row.receipt_id, error: error.name };
      }
      if (invalid) {
        invalidReceiptHashCount += 1;
        if (invalidReceiptRows.length < 20) invalidReceiptRows.push(invalid);
      }
    },
  });
  return { invalidReceiptHashCount, invalidReceiptRows };
}

function inspectLogicalSnapshot(store, batchSize) {
  const schemaRows = queryRows(store, `
SELECT type,name,tbl_name,coalesce(sql,'') AS sql
FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%'
ORDER BY type,name,tbl_name;
`);
  const tables = schemaRows.filter((row) => row.type === 'table').map((row) => row.name);
  const tableReports = tables.map((table) => {
    const columns = queryRows(
      store,
      'SELECT name,pk FROM pragma_table_info(?) ORDER BY cid;',
      [table],
    );
    const primaryKey = columns.filter((column) => Number(column.pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((column) => column.name);
    const orderColumns = primaryKey.length ? primaryKey : columns.map((column) => column.name);
    const order = orderColumns.length
      ? ` ORDER BY ${orderColumns.map(quoteIdentifier).join(',')}`
      : '';
    const rowCount = Number(queryRows(
      store,
      `SELECT count(*) AS count FROM ${quoteIdentifier(table)};`,
    )[0]?.count || 0);
    return {
      name: table,
      rowCount,
      primaryKey,
      canonicalRowsHash: canonicalRowsHash({
        store, table, order, rowCount, batchSize,
      }),
    };
  });
  const quickCheckRows = queryRows(store, 'SELECT * FROM pragma_quick_check;');
  const quickCheck = String(
    quickCheckRows[0]?.quick_check || quickCheckRows[0]?.integrity_check || 'unknown',
  );
  const foreignKeyViolationCount = Number(queryRows(
    store,
    'SELECT count(*) AS count FROM pragma_foreign_key_check;',
  )[0]?.count || 0);
  const receiptLedgerRowCount = tableReports
    .find((table) => table.name === 'receipt_ledger')?.rowCount || 0;
  const receiptInspection = tables.includes('receipt_ledger')
    ? inspectReceiptLedger({ store, rowCount: receiptLedgerRowCount, batchSize })
    : { invalidReceiptHashCount: 0, invalidReceiptRows: [] };
  return {
    schemaRows,
    tableReports,
    quickCheck,
    foreignKeyViolationCount,
    receiptLedgerRowCount,
    ...receiptInspection,
  };
}

export function buildSqliteLogicalIntegrityReport({ dbPath, store, rowBatchSize } = {}) {
  if (!dbPath || !fs.existsSync(dbPath)) throw new Error(`SQLite database missing: ${dbPath || '(unset)'}`);
  if (!store || typeof store.query !== 'function') throw new Error('Read-only StorePort is required for logical integrity');
  const batchSize = normalizedBatchSize(rowBatchSize);
  const byteHashBefore = fileHash(dbPath);
  const snapshot = typeof store.transaction === 'function'
    ? store.transaction(
      (transactionStore) => inspectLogicalSnapshot(transactionStore, batchSize),
      { readOnly: true },
    )
    : inspectLogicalSnapshot(store, batchSize);
  const {
    schemaRows,
    tableReports,
    quickCheck,
    foreignKeyViolationCount,
    receiptLedgerRowCount,
    invalidReceiptHashCount,
    invalidReceiptRows,
  } = snapshot;
  const logicalSubject = {
    schemaRows,
    tables: tableReports,
  };
  const logicalDatabaseHash = hashRecord('SqliteLogicalDatabase', logicalSubject);
  const byteHashAfter = fileHash(dbPath);
  const blockers = [
    ...(quickCheck === 'ok' ? [] : ['sqlite_quick_check_failed']),
    ...(foreignKeyViolationCount ? ['sqlite_foreign_key_check_failed'] : []),
    ...(invalidReceiptHashCount ? ['receipt_ledger_hash_mismatch'] : []),
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
    foreignKeyViolationCount,
    receiptLedgerRowCount,
    invalidReceiptHashCount,
    invalidReceiptRows,
    blockers,
  });
}
