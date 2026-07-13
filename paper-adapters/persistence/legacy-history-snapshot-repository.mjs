import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createReadOnlySqliteStore } from './sqlite-store.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export const LEGACY_HISTORY_TABLES = Object.freeze([
  Object.freeze({ name: 'gate_runs', category: 'gate_history', translationTarget: 'receipt_ledger_archive' }),
  Object.freeze({ name: 'referee_rounds', category: 'referee_history', translationTarget: 'referee_lineage_reference' }),
  Object.freeze({ name: 'events', category: 'event_history', translationTarget: 'receipt_ledger_archive' }),
  Object.freeze({ name: 'todos', category: 'todo_history', translationTarget: 'archive_only' }),
  Object.freeze({ name: 'paper_versions', category: 'version_history', translationTarget: 'artifact_lineage_reference' }),
  Object.freeze({ name: 'archive_events', category: 'archive_history', translationTarget: 'archive_only' }),
  Object.freeze({ name: 'submission_portal_events', category: 'submission_history', translationTarget: 'submission_lineage_reference' }),
  Object.freeze({ name: 'plugins', category: 'plugin_inventory', translationTarget: 'adapter_migration_reference' }),
  Object.freeze({ name: 'jobs', category: 'job_history', translationTarget: 'campaign_lineage_reference' }),
  Object.freeze({ name: 'job_edges', category: 'job_graph_history', translationTarget: 'campaign_lineage_reference' }),
  Object.freeze({ name: 'source_workspaces', category: 'workspace_history', translationTarget: 'workspace_lineage_reference' }),
]);

function sha256Bytes(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function fileHash(candidate) {
  return sha256Bytes(fs.readFileSync(candidate));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function query(store, sql) {
  const result = store.query(sql);
  if (!result.ok) throw new Error(result.error || result.stderr || 'legacy_history_query_failed');
  return result.rows || [];
}

function immutableWrite(candidate, bytes) {
  fs.mkdirSync(path.dirname(candidate), { recursive: true });
  try {
    fs.writeFileSync(candidate, bytes, { flag: 'wx', mode: 0o444 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (fileHash(candidate) !== sha256Bytes(bytes)) throw new Error(`legacy_history_immutable_collision:${candidate}`);
  }
}

function tableRows(store, table) {
  const columns = query(store, `PRAGMA table_info(${quoteIdentifier(table)});`);
  if (!columns.length) return null;
  const primaryKey = columns.filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => column.name);
  const orderColumns = primaryKey.length ? primaryKey : columns.map((column) => column.name);
  const order = orderColumns.length ? ` ORDER BY ${orderColumns.map(quoteIdentifier).join(',')}` : '';
  return {
    columns: columns.map((column) => column.name),
    primaryKey,
    rows: query(store, `SELECT * FROM ${quoteIdentifier(table)}${order};`).map(stable),
  };
}

function ndjson(rows) {
  return rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
}

function rowLineageRecords(table, contract) {
  return table.rows.map((row, ordinal) => ({
    version: 1,
    kind: 'LegacyHistoryRowLineageReference',
    sourceTable: contract.name,
    sourceOrdinal: ordinal,
    sourcePrimaryKey: Object.fromEntries(table.primaryKey.map((key) => [key, row[key]])),
    sourceRowHash: hashRecord('LegacyHistoryRow', { table: contract.name, row }),
    sourceTableContentTarget: contract.translationTarget,
    authorityImported: false,
    activeControlPlaneRowCreated: false,
  }));
}

export function exportLegacyHistorySnapshot({
  legacyDbPath,
  outputRoot,
  receiptLedger = null,
  clock = { nowIso: () => new Date().toISOString() },
  store = null,
} = {}) {
  if (!legacyDbPath || !fs.existsSync(legacyDbPath)) throw new Error('legacy_history_database_missing');
  if (!outputRoot) throw new Error('legacy_history_output_root_required');
  const sourceDatabaseHash = fileHash(legacyDbPath);
  const ownedStore = store || createReadOnlySqliteStore({ dbPath: legacyDbPath });
  const tablePayloads = [];
  const missingTables = [];
  try {
    const existing = new Set(query(ownedStore, "SELECT name FROM sqlite_schema WHERE type='table';").map((row) => row.name));
    for (const contract of LEGACY_HISTORY_TABLES) {
      if (!existing.has(contract.name)) {
        missingTables.push(contract.name);
        continue;
      }
      const table = tableRows(ownedStore, contract.name);
      const bytes = Buffer.from(ndjson(table.rows), 'utf8');
      const rowLineage = Buffer.from(ndjson(rowLineageRecords(table, contract)), 'utf8');
      tablePayloads.push({
        ...contract,
        columns: table.columns,
        primaryKey: table.primaryKey,
        rowCount: table.rows.length,
        contentHash: sha256Bytes(bytes),
        rowLineageHash: sha256Bytes(rowLineage),
        rowLineageCount: table.rows.length,
        bytes: bytes.length,
        content: bytes,
        rowLineage,
      });
    }
  } finally {
    if (!store) ownedStore.close();
  }
  const subject = {
    version: 1,
    kind: 'LegacyHistorySnapshotManifest',
    sourceDatabaseHash,
    sourceDatabaseBytes: fs.statSync(legacyDbPath).size,
    tables: tablePayloads.map(({ content: _content, rowLineage: _rowLineage, ...table }) => table),
    missingTables,
    policy: {
      activeControlPlaneImported: false,
      historicalRowsAreAuthority: false,
      selectiveTranslationRequired: true,
      generatedControlPlaneEventsRemainArchiveOnly: true,
    },
  };
  const manifestHash = hashRecord('LegacyHistorySnapshotManifest', subject);
  const snapshotId = manifestHash.replace(/^sha256:/, '');
  const snapshotRoot = path.join(path.resolve(outputRoot), snapshotId);
  for (const table of tablePayloads) {
    immutableWrite(path.join(snapshotRoot, `${table.name}.ndjson`), table.content);
    immutableWrite(path.join(snapshotRoot, `${table.name}.lineage.ndjson`), table.rowLineage);
  }
  const manifestPath = path.join(snapshotRoot, 'manifest.json');
  immutableWrite(manifestPath, Buffer.from(`${JSON.stringify({ ...subject, manifestHash }, null, 2)}\n`));
  const blockers = missingTables.map((table) => `legacy_history_table_missing:${table}`);
  const receiptPayload = {
    version: 1,
    kind: 'LegacyHistorySnapshotReceipt',
    status: blockers.length ? 'legacy_history_snapshot_blocked' : 'legacy_history_snapshot_verified',
    sourceDatabaseHash,
    manifestHash,
    manifestPath,
    snapshotId,
    tableCount: tablePayloads.length,
    rowCount: tablePayloads.reduce((total, table) => total + table.rowCount, 0),
    tableCounts: Object.fromEntries(tablePayloads.map((table) => [table.name, table.rowCount])),
    blockers,
    createdAt: clock.nowIso(),
    safety: { activeControlPlaneImported: false, legacyDatabaseMutated: false, externalActionPerformed: false },
  };
  const snapshotReceiptHash = hashRecord('LegacyHistorySnapshotReceipt', receiptPayload);
  const ledger = receiptLedger?.record
    ? receiptLedger.record({ ...receiptPayload, snapshotReceiptHash }, { stream: 'legacy-history', evidenceClass: 'legacy_history_archive', environment: 'administrative' })
    : null;
  const lineagePayload = {
    version: 1,
    kind: 'LegacyHistoryLineageReceipt',
    status: blockers.length ? 'legacy_history_lineage_blocked' : 'legacy_history_lineage_references_recorded',
    sourceDatabaseHash,
    manifestHash,
    lineage: tablePayloads
      .filter((table) => table.translationTarget !== 'archive_only')
      .map((table) => ({
        sourceTable: table.name,
        category: table.category,
        translationTarget: table.translationTarget,
        sourceRowCount: table.rowCount,
        sourceContentHash: table.contentHash,
        sourceRowLineageHash: table.rowLineageHash,
        sourceRowLineageCount: table.rowLineageCount,
        sourceRowLineagePath: path.join(snapshotRoot, `${table.name}.lineage.ndjson`),
        authorityImported: false,
        activeControlPlaneRowsCreated: false,
      })),
    blockers,
    policy: {
      translationsAreHashBoundReferences: true,
      replayRequiresExplicitNativeImporter: true,
      legacyStatusIsNotNativeAuthority: true,
    },
  };
  const lineageReceiptHash = hashRecord('LegacyHistoryLineageReceipt', lineagePayload);
  const lineageLedger = receiptLedger?.record
    ? receiptLedger.record({ ...lineagePayload, lineageReceiptHash }, { stream: 'legacy-lineage', evidenceClass: 'legacy_lineage_reference', environment: 'administrative' })
    : null;
  return Object.freeze({ ...receiptPayload, snapshotReceiptHash, ledgerReceiptId: ledger?.receiptId || null, lineageReceiptHash, lineageLedgerReceiptId: lineageLedger?.receiptId || null, lineage: lineagePayload.lineage });
}

export function verifyLegacyHistorySnapshot({ manifestPath } = {}) {
  if (!manifestPath || !fs.existsSync(manifestPath)) throw new Error('legacy_history_manifest_missing');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const payload = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'manifestHash'));
  const blockers = [];
  if (hashRecord('LegacyHistorySnapshotManifest', payload) !== manifest.manifestHash) blockers.push('legacy_history_manifest_hash_mismatch');
  let rowCount = 0;
  for (const table of manifest.tables || []) {
    const candidate = path.join(path.dirname(manifestPath), `${table.name}.ndjson`);
    if (!fs.existsSync(candidate)) {
      blockers.push(`legacy_history_table_file_missing:${table.name}`);
      continue;
    }
    if (fileHash(candidate) !== table.contentHash) blockers.push(`legacy_history_table_hash_mismatch:${table.name}`);
    const text = fs.readFileSync(candidate, 'utf8');
    const rows = text ? text.trimEnd().split('\n').length : 0;
    rowCount += rows;
    if (rows !== Number(table.rowCount)) blockers.push(`legacy_history_table_row_count_mismatch:${table.name}`);
    const lineageCandidate = path.join(path.dirname(manifestPath), `${table.name}.lineage.ndjson`);
    if (!fs.existsSync(lineageCandidate)) blockers.push(`legacy_history_row_lineage_missing:${table.name}`);
    else {
      if (fileHash(lineageCandidate) !== table.rowLineageHash) blockers.push(`legacy_history_row_lineage_hash_mismatch:${table.name}`);
      const lineageText = fs.readFileSync(lineageCandidate, 'utf8');
      const lineageRows = lineageText ? lineageText.trimEnd().split('\n').length : 0;
      if (lineageRows !== Number(table.rowLineageCount)) blockers.push(`legacy_history_row_lineage_count_mismatch:${table.name}`);
    }
  }
  const result = {
    version: 1,
    kind: 'LegacyHistorySnapshotVerification',
    status: blockers.length ? 'legacy_history_snapshot_invalid' : 'legacy_history_snapshot_verified',
    manifestHash: manifest.manifestHash || null,
    tableCount: (manifest.tables || []).length,
    rowCount,
    blockers,
  };
  return Object.freeze({ ...result, verificationHash: hashRecord('LegacyHistorySnapshotVerification', result) });
}
