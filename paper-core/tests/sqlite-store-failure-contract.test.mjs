import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { planAutomationRuntimeReconciliation } from '../../paper-adapters/automation/automation-runtime-reconciler.mjs';
import { createSqliteResourceGovernor } from '../../paper-adapters/automation/sqlite-resource-governor.mjs';
import { buildWorkspaceLineageBackfillPlan } from '../../paper-adapters/automation/workspace-lineage-backfill.mjs';
import { createWorkspaceRegistry } from '../../paper-adapters/automation/workspace-registry.mjs';
import { assertScopedSchemaVersion } from '../../paper-adapters/persistence/scoped-schema-version-gate.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { createSqliteJobReceiptStore } from '../../paper-adapters/persistence/sqlite-job-receipt-store.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createSqliteStore } from '../../paper-adapters/persistence/sqlite-store.mjs';
import { createSqliteWorkflowStateStore } from '../../paper-adapters/persistence/sqlite-workflow-state-store.mjs';
import { readRefereeRevisionRequests } from '../../paper-adapters/research-verify/research-evidence-reader.mjs';
import { createSqliteDeliveryPersistence } from '../../paper-adapters/submission/sqlite-delivery-persistence.mjs';
import { assertStoreQueryResult } from '../../paper-ports/store-port.mjs';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-sqlite-query-contract-'));
  const dbPath = path.join(root, 'store.sqlite');
  const store = createSqliteStore({ dbPath, ...options });
  t.after(() => {
    try { store.close(); } catch { /* already closed by the test */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { dbPath, store };
}

test('SQLite query distinguishes legitimate no-row results from operational failures', (t) => {
  const { store } = fixture(t);
  assert.equal(store.execute('CREATE TABLE sample(id INTEGER PRIMARY KEY,value TEXT);').ok, true);

  const noRows = store.query('SELECT * FROM sample WHERE id=?;', [404]);
  assert.equal(noRows.ok, true);
  assert.deepEqual(noRows.rows, []);
  assert.equal(noRows.stdout, '');

  assert.throws(() => store.query('SELECT * FROM missing_table;'), /no such table: missing_table/);
  assert.throws(() => store.query('SELECT FROM sample;'), /syntax error/);
});

test('SQLite query fails closed after the underlying connection is closed', (t) => {
  const { store } = fixture(t);
  store.close();
  assert.equal(store.available(), false);
  assert.throws(() => store.query('SELECT 1;'), /(?:not open|closed)/i);
});

test('SQLite query exposes SQLITE_BUSY instead of returning an empty result', (t) => {
  const { dbPath, store: lockOwner } = fixture(t, { busyTimeoutMs: 1 });
  assert.equal(lockOwner.execute('CREATE TABLE sample(id INTEGER PRIMARY KEY,value TEXT);').ok, true);
  const contender = createSqliteStore({ dbPath, busyTimeoutMs: 1 });
  t.after(() => contender.close());

  lockOwner.transaction((transactionStore) => {
    assert.equal(transactionStore.run('INSERT INTO sample(value) VALUES(?);', ['owner']).ok, true);
    assert.throws(
      () => contender.query("INSERT INTO sample(value) VALUES('contender') RETURNING id;"),
      (error) => error?.code === 'ERR_SQLITE_ERROR' && /locked/i.test(error.message),
    );
  });

  assert.deepEqual(lockOwner.query('SELECT value FROM sample ORDER BY id;').rows, [{ value: 'owner' }]);
});

test('a caught transaction query failure still poisons and rolls back the unit of work', (t) => {
  const { store } = fixture(t);
  assert.equal(store.execute('CREATE TABLE sample(value TEXT);').ok, true);

  assert.throws(() => store.transaction((transactionStore) => {
    assert.equal(transactionStore.run('INSERT INTO sample(value) VALUES(?);', ['rolled-back']).ok, true);
    assert.throws(() => transactionStore.query('SELECT * FROM missing_table;'), /no such table/);
    return 'must_not_commit';
  }), /no such table/);

  assert.deepEqual(store.query('SELECT value FROM sample;').rows, []);
});

test('query result guard rejects legacy failure-as-empty adapter results', () => {
  assert.throws(
    () => assertStoreQueryResult({ ok: false, rows: [], error: 'simulated_query_failure' }),
    /simulated_query_failure/,
  );
  assert.deepEqual(assertStoreQueryResult({ ok: true, rows: [] }).rows, []);
});

test('critical persistence adapters reject legacy failure-as-empty StorePorts', () => {
  const failedStore = Object.freeze({
    version: 3,
    query: () => ({ ok: false, rows: [], error: 'simulated_query_failure' }),
    execute: () => ({ ok: true, status: 0, error: null }),
  });
  const clock = Object.freeze({ now: () => new Date('2026-07-14T00:00:00.000Z'), nowIso: () => '2026-07-14T00:00:00.000Z' });
  const expected = /simulated_query_failure/;

  const delivery = createSqliteDeliveryPersistence({ store: failedStore });
  assert.throws(() => delivery.rows('SELECT * FROM submission_outbox;'), expected);

  const receipts = createSqliteReceiptLedger({ store: failedStore, clock });
  assert.throws(() => receipts.getRawForAudit('missing'), expected);

  const workspaces = createWorkspaceRegistry({ store: failedStore, clock });
  assert.throws(() => workspaces.list(), expected);

  const campaigns = createSqliteCampaignStore({ store: failedStore, clock });
  assert.throws(() => campaigns.getCampaign('missing'), expected);

  assert.throws(() => createSqliteResourceGovernor({ store: failedStore, clock }), expected);

  const jobs = createSqliteJobReceiptStore({
    store: failedStore,
    clock,
    receiptLedger: { prepare: () => ({ sql: '' }) },
  });
  assert.throws(() => jobs.get('missing'), expected);

  assert.throws(() => planAutomationRuntimeReconciliation({ store: failedStore, clock }), expected);
  assert.throws(() => buildWorkspaceLineageBackfillPlan({
    store: failedStore,
    runtimeRoot: '/tmp/runtime-not-read-after-query-failure',
    assetRoot: '/tmp/assets-not-read-after-query-failure',
  }), expected);

  const workflowStates = createSqliteWorkflowStateStore({
    store: failedStore,
    clock,
    receiptLedger: { prepare: () => ({ sql: '' }) },
  });
  assert.throws(() => workflowStates.get('missing'), expected);
  assert.throws(() => readRefereeRevisionRequests(failedStore, 'paper'), expected);
  assert.throws(() => assertScopedSchemaVersion({ store: { ...failedStore, available: () => true } }), expected);
});
