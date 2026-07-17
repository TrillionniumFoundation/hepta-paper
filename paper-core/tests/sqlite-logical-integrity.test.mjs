import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDefaultPaperStore, createReadOnlyPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { buildSqliteLogicalIntegrityReport } from '../../paper-adapters/persistence/sqlite-logical-integrity.mjs';

test('logical integrity is read-only and stable across insert-delete page churn', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-logical-integrity-'));
  try {
    const dbPath = path.join(root, 'hepta-paper.sqlite');
    const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath });
    store.execute("INSERT INTO papers(slug,title,canonical_dir,source_dir,status) VALUES('logical-fixture','Logical fixture','logical-fixture','','draft');");
    const before = buildSqliteLogicalIntegrityReport({ dbPath, store: createReadOnlyPaperStore({ dbPath }) });
    assert.equal(before.status, 'sqlite_logical_integrity_verified');
    store.execute("INSERT INTO audit_receipts(receipt_id,kind,status,receipt_json,receipt_sha256) VALUES('transient','Transient','test','{}','sha256:test'); DELETE FROM audit_receipts WHERE receipt_id='transient';");
    const after = buildSqliteLogicalIntegrityReport({ dbPath, store: createReadOnlyPaperStore({ dbPath }) });
    assert.equal(after.status, 'sqlite_logical_integrity_verified');
    assert.equal(after.logicalDatabaseHash, before.logicalDatabaseHash);
    assert.equal(after.readonlyCheckMutatedDatabase, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
