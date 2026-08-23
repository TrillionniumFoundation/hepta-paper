import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  executeAutomationRuntimeReconciliation,
  planAutomationRuntimeReconciliation,
} from '../../paper-adapters/automation/automation-runtime-reconciler.mjs';
import {
  executeLegacyTerminalActiveResidueSettlement,
} from '../../paper-adapters/automation/legacy-terminal-active-residue-settlement.mjs';
import {
  createExternallyFencedSqliteMutationTransaction,
} from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-plan.mjs';
import {
  NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_MUTATION_PLANS,
  NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_OPERATION_ID,
  NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_WRITER_PLAN_HASH,
  NATIVE_STORE_LEGACY_TERMINAL_ACTIVE_RESIDUE_SETTLEMENT_OPERATION_ID,
} from '../../paper-adapters/automation/native-store-automation-runtime-reconciliation-mutation-plan.mjs';
import {
  createSqliteResourceGovernor,
} from '../../paper-adapters/automation/sqlite-resource-governor.mjs';
import {
  createTheoremQualityRevisionSink,
} from '../../paper-adapters/automation/theorem-quality-revision-sink.mjs';
import {
  createWorkspaceRegistry,
} from '../../paper-adapters/automation/workspace-registry.mjs';
import {
  exportWorkspaceSnapshot,
  restoreWorkspaceSnapshot,
} from '../../paper-adapters/automation/workspace-snapshot-exporter.mjs';
import {
  NATIVE_STORE_QUALITY_RELEASE_MUTATION_PLANS,
  NATIVE_STORE_QUALITY_RELEASE_OPERATION_IDS,
  NATIVE_STORE_QUALITY_RELEASE_STATEMENT_IDS,
  NATIVE_STORE_QUALITY_RELEASE_WRITER_PLAN_HASH,
} from '../../paper-adapters/persistence/native-store-quality-release-mutation-plan.mjs';
import {
  NATIVE_STORE_RESOURCE_WORKSPACE_MUTATION_PLANS,
  NATIVE_STORE_RESOURCE_WORKSPACE_OPERATION_IDS,
  NATIVE_STORE_RESOURCE_WORKSPACE_WRITER_PLAN_HASH,
} from '../../paper-adapters/persistence/native-store-resource-workspace-mutation-plan.mjs';
import {
  issueAutomationReconcilerWriter,
  issueWorkspaceSnapshotVerifierWriter,
} from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
import {
  createSqliteCampaignStore,
} from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import {
  createSqliteReceiptLedger,
} from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import {
  createDefaultPaperStore,
} from '../../paper-adapters/persistence/store-provider.mjs';
import {
  currentProcessIdentity,
} from '../../workflow-kernel/runtime/process-identity.mjs';

const NOW = '2026-07-18T09:00:00.000Z';
const FUTURE = '2026-07-18T10:00:00.000Z';
const PAST = '2026-07-18T08:00:00.000Z';
const ALL_PLANS = Object.freeze({
  ...NATIVE_STORE_RESOURCE_WORKSPACE_MUTATION_PLANS,
  ...NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_MUTATION_PLANS,
  ...NATIVE_STORE_QUALITY_RELEASE_MUTATION_PLANS,
});

function invoke(statement, operation, parameters) {
  if (Array.isArray(parameters)) return statement[operation](...parameters);
  if (parameters && typeof parameters === 'object') {
    return statement[operation](parameters);
  }
  return statement[operation]();
}

function fixedClock(value = NOW) {
  return Object.freeze({
    now: () => new Date(value),
    nowIso: () => value,
  });
}

function seedNativeStore(offline) {
  assert.equal(offline.execute(`INSERT INTO papers(slug,title,canonical_dir)
    VALUES('quality-paper','Quality paper','quality-paper')`).ok, true);
  const campaigns = createSqliteCampaignStore({ store: offline, clock: fixedClock(PAST) });
  for (const [campaignId, paperId, nodeId, kind] of [
    ['reconcile-expired', 'paper-expired', 'node-expired', 'agent'],
    ['reconcile-idle', 'paper-idle', 'node-idle', 'agent'],
    ['reconcile-terminal', 'paper-terminal', 'node-terminal', 'agent'],
    ['reconcile-terminal-other', 'paper-terminal-other', 'node-terminal-other', 'agent'],
    ['reconcile-terminal-active', 'paper-terminal-active', 'node-terminal-active', 'agent'],
    ['workspace-campaign', 'paper-workspace', 'workspace-node', 'draft'],
  ]) {
    campaigns.createCampaign({
      campaignId,
      paperId,
      ...(campaignId.startsWith('reconcile-terminal')
        ? { terminalSiblingSettlementPolicyVersion: 1 } : {}),
      nodes: [{ nodeId, kind, dependencies: [] }],
    });
  }
  assert.equal(offline.execute(`UPDATE campaign_nodes SET
      status='running',lease_owner='dead-worker',attempt_id='attempt-expired',
      lease_expires_at='${PAST}'
    WHERE node_id='node-expired'`).ok, true);
  assert.equal(offline.execute(`UPDATE paper_campaigns SET
      updated_at='${PAST}' WHERE campaign_id='reconcile-idle'`).ok, true);
  assert.equal(offline.execute(`UPDATE paper_campaigns SET
      updated_at='${NOW}' WHERE campaign_id='workspace-campaign'`).ok, true);
  assert.equal(offline.execute(`UPDATE paper_campaigns SET
      status='failed',stop_reason='fixture-terminal'
    WHERE campaign_id='reconcile-terminal'`).ok, true);
  assert.equal(offline.execute(`UPDATE paper_campaigns SET
      status='failed',stop_reason='fixture-terminal-other'
    WHERE campaign_id='reconcile-terminal-other'`).ok, true);
  assert.equal(offline.execute(`UPDATE paper_campaigns SET
      status='failed',stop_reason='fixture-terminal-active'
    WHERE campaign_id='reconcile-terminal-active'`).ok, true);
  assert.equal(offline.execute(`UPDATE campaign_nodes SET
      status='running',lease_owner='terminal-dead-worker',
      attempt_id='terminal-active-attempt',lease_generation=3,node_revision=4,
      lease_expires_at='${PAST}'
    WHERE node_id='node-terminal-active'`).ok, true);
  assert.equal(offline.execute(`INSERT INTO automation_resource_leases(
      lease_id,scope,owner_id,agent,cpu,gpu,memory_mib,
      acquired_at,renewed_at,expires_at
    ) VALUES
      ('reconcile-expired-lease','global','dead',1,0,0,0,'${PAST}','${PAST}','${PAST}'),
      ('reconcile-live-lease','global','live',0,1,0,0,'${PAST}','${PAST}','${FUTURE}')`).ok, true);
  assert.equal(offline.execute(`INSERT INTO automation_resource_waiters(
      waiter_id,scope,owner_id,agent,cpu,gpu,memory_mib,
      requested_at,renewed_at,expires_at
    ) VALUES
      ('reconcile-expired-waiter','global','dead',1,0,0,0,'${PAST}','${PAST}','${PAST}'),
      ('reconcile-live-waiter','global','live',0,1,0,0,'${PAST}','${PAST}','${FUTURE}')`).ok, true);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-native-tail-online-'));
  const offline = createDefaultPaperStore({ root, runtimeRoot: root });
  seedNativeStore(offline);
  const databasePath = offline.dbPath;
  offline.close();
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys=ON');
  const operationIds = [];
  let genericWriteAttempts = 0;
  let beforeMutation = null;
  const strictStore = {
    version: 3,
    kind: 'TestExternallyFencedNativeSqliteStoreAdapter',
    query(sql, parameters = []) {
      const rows = invoke(database.prepare(String(sql)), 'all', parameters)
        .map((row) => ({ ...row }));
      return {
        ok: true,
        status: 0,
        rows,
        stdout: JSON.stringify(rows),
        stderr: '',
        error: null,
      };
    },
    run() {
      genericWriteAttempts += 1;
      return { ok: false, status: 1, error: 'native_store_unfenced_write_forbidden' };
    },
    execute() {
      genericWriteAttempts += 1;
      return { ok: false, status: 1, error: 'native_store_unfenced_write_forbidden' };
    },
    transaction(callback, { readOnly = false } = {}) {
      if (!readOnly) throw new Error('native_store_unfenced_write_forbidden');
      return callback(strictStore);
    },
    mutate({ operationId, mutate }) {
      const operationPlan = ALL_PLANS[operationId];
      if (!operationPlan || typeof mutate !== 'function') {
        throw new Error('native_store_online_mutation_input_invalid');
      }
      operationIds.push(operationId);
      if (beforeMutation) {
        const injected = beforeMutation;
        beforeMutation = null;
        injected(database, operationId);
      }
      database.exec('BEGIN IMMEDIATE');
      const scoped = createExternallyFencedSqliteMutationTransaction(
        database,
        operationPlan,
      );
      try {
        const value = mutate(scoped.transaction);
        scoped.revoke();
        database.exec('COMMIT');
        return Object.freeze({
          status: 'externally_fenced_sqlite_mutation_finalized',
          value,
        });
      } catch (error) {
        scoped.revoke();
        if (database.isTransaction) database.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const directLedgerStore = Object.freeze({
    version: 3,
    query: strictStore.query,
    execute(sql) {
      try {
        database.exec(String(sql));
        return { ok: true, status: 0, stdout: '', stderr: '', error: null };
      } catch (error) {
        return {
          ok: false,
          status: 1,
          stdout: '',
          stderr: error.message,
          error: error.message,
        };
      }
    },
  });
  t.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return Object.freeze({
    root,
    database,
    strictStore,
    directLedgerStore,
    operationIds,
    genericWriteAttempts: () => genericWriteAttempts,
    beforeNextMutation(callback) { beforeMutation = callback; },
  });
}

test('native-store tail plans pin all thirteen remaining DML operations', () => {
  assert.equal(Object.keys(NATIVE_STORE_RESOURCE_WORKSPACE_MUTATION_PLANS).length, 9);
  assert.equal(Object.keys(
    NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_MUTATION_PLANS,
  ).length, 2);
  assert.equal(Object.keys(NATIVE_STORE_QUALITY_RELEASE_MUTATION_PLANS).length, 2);
  for (const value of [
    NATIVE_STORE_RESOURCE_WORKSPACE_WRITER_PLAN_HASH,
    NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_WRITER_PLAN_HASH,
    NATIVE_STORE_QUALITY_RELEASE_WRITER_PLAN_HASH,
  ]) assert.match(value, /^sha256:[a-f0-9]{64}$/);

  const theoremSource = fs.readFileSync(path.resolve(
    'paper-adapters/automation/theorem-quality-revision-sink.mjs',
  ), 'utf8');
  const releaseSource = fs.readFileSync(path.resolve(
    'paper-adapters/persistence/sqlite-campaign-release-authority-repository.mjs',
  ), 'utf8');
  assert.match(theoremSource, /store\.mutate\s*\(/);
  assert.match(releaseSource, /store\.mutate\s*\(/);
  assert.match(
    theoremSource,
    /native-store\.theorem-quality-revision-sink\.record\.v1/,
  );
  assert.match(
    releaseSource,
    /native-store\.campaign-release-authority-repository\.promoteCompletedRelease\.v1/,
  );
  assert.match(
    releaseSource,
    /packageDeletionWriterSelector[\s\S]*packageResult\.releaseBundle\.packageOutput\.packageDir/,
  );
});

test('strict legacy terminal residue settlement uses its least-privilege fixed plan', (t) => {
  const f = fixture(t);
  const campaignId = 'legacy-terminal-online-fixture';
  const nodeId = 'legacy-terminal-online-node';
  f.database.prepare(`INSERT INTO paper_campaigns(
    campaign_id,paper_id,status,revision,current_round,max_rounds,spec_json,
    created_at,updated_at
  ) VALUES(?,?,?,?,0,1,?,?,?)`).run(
    campaignId,
    'legacy-terminal-online-paper',
    'failed',
    3,
    JSON.stringify({ legacyCampaign: true }),
    PAST,
    PAST,
  );
  f.database.prepare(`INSERT INTO campaign_nodes(
    node_id,campaign_id,kind,round_index,status,priority,dependencies_json,
    spec_json,lease_owner,lease_expires_at,attempt_id,lease_generation,
    node_revision,max_attempts,created_at,updated_at
  ) VALUES(?,?,'agent',0,'running',100,'[]','{}','legacy-dead-worker',
    ?,'legacy-attempt',2,4,3,?,?)`).run(nodeId, campaignId, PAST, PAST, PAST);
  f.database.prepare(`INSERT INTO campaign_nodes(
    node_id,campaign_id,kind,round_index,status,priority,dependencies_json,
    spec_json,max_attempts,created_at,updated_at
  ) VALUES(?,?,'agent',0,'queued',100,'[]','{}',3,?,?)`).run(
    'legacy-terminal-preserved-queued', campaignId, PAST, PAST,
  );
  const receiptLedger = createSqliteReceiptLedger({
    store: f.strictStore,
    clock: fixedClock(),
    issuerCapability: issueAutomationReconcilerWriter(),
  });
  const receipt = executeLegacyTerminalActiveResidueSettlement({
    store: f.strictStore,
    clock: fixedClock(),
    campaignId,
    receiptLedger,
  });
  assert.equal(receipt.settledNodeCount, 1);
  assert.equal(receipt.preservedQueuedNodeCount, 1);
  assert.equal(f.database.prepare(`SELECT status FROM campaign_nodes
    WHERE node_id=?`).get(nodeId).status, 'skipped');
  assert.equal(f.database.prepare(`SELECT status FROM campaign_nodes
    WHERE node_id='legacy-terminal-preserved-queued'`).get().status, 'queued');
  assert.deepEqual(f.operationIds, [
    NATIVE_STORE_LEGACY_TERMINAL_ACTIVE_RESIDUE_SETTLEMENT_OPERATION_ID,
  ]);
  assert.equal(f.genericWriteAttempts(), 0);
});

test('strict runtime reconciliation applies every planned row and receipt atomically', (t) => {
  const f = fixture(t);
  const receiptLedger = createSqliteReceiptLedger({
    store: f.strictStore,
    clock: fixedClock(),
    issuerCapability: issueAutomationReconcilerWriter(),
  });
  const receipt = executeAutomationRuntimeReconciliation({
    store: f.strictStore,
    clock: fixedClock(),
    receiptLedger,
  });
  assert.equal(receipt.recoveredNodeCount, 1);
  assert.equal(receipt.removedResourceLeaseCount, 1);
  assert.equal(receipt.removedWaiterCount, 1);
  assert.equal(receipt.pausedNoProgressCampaignCount, 1);
  assert.equal(receipt.closedTerminalCampaignQueuedNodeCount, 2);
  assert.equal(receipt.closedTerminalCampaignActiveNodeCount, 1);
  assert.equal(f.database.prepare(`SELECT status FROM campaign_nodes
    WHERE node_id='node-expired'`).get().status, 'queued');
  assert.equal(f.database.prepare(`SELECT status FROM paper_campaigns
    WHERE campaign_id='reconcile-idle'`).get().status, 'paused');
  assert.equal(f.database.prepare(`SELECT status FROM campaign_nodes
    WHERE node_id='node-terminal'`).get().status, 'skipped');
  assert.equal(f.database.prepare(`SELECT status FROM campaign_nodes
    WHERE node_id='node-terminal-other'`).get().status, 'skipped');
  assert.equal(f.database.prepare(`SELECT status FROM campaign_nodes
    WHERE node_id='node-terminal-active'`).get().status, 'skipped');
  assert.equal(f.database.prepare(`SELECT count(*) AS count FROM campaign_events
    WHERE node_id='node-terminal-active'
      AND kind='campaign_terminal_active_child_settled'`).get().count, 1);
  assert.equal(f.database.prepare(`SELECT count(*) AS count FROM receipt_ledger
    WHERE stream='automation-reconciliation'`).get().count, 1);
  assert.deepEqual(f.operationIds, [
    NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_OPERATION_ID,
  ]);
  assert.equal(f.genericWriteAttempts(), 0);
});

test('strict campaign-scoped reconciliation closes only the selected policy-v1 lineage', (t) => {
  const f = fixture(t);
  for (const [table, idColumn, id, campaignId, nodeId] of [
    ['automation_resource_leases', 'lease_id', 'scoped-expired-lease',
      'reconcile-terminal', 'node-terminal'],
    ['automation_resource_leases', 'lease_id', 'other-expired-lease',
      'reconcile-terminal-other', 'node-terminal-other'],
    ['automation_resource_waiters', 'waiter_id', 'scoped-expired-waiter',
      'reconcile-terminal', 'node-terminal'],
    ['automation_resource_waiters', 'waiter_id', 'other-expired-waiter',
      'reconcile-terminal-other', 'node-terminal-other'],
  ]) {
    const timingColumns = table === 'automation_resource_leases'
      ? 'acquired_at,renewed_at' : 'requested_at,renewed_at';
    f.database.prepare(`INSERT INTO ${table}(
      ${idColumn},scope,owner_id,campaign_id,node_id,agent,cpu,gpu,memory_mib,
      ${timingColumns},expires_at
    ) VALUES(?,?,?,?,?,1,0,0,0,?,?,?)`).run(
      id,
      'global',
      'dead-scoped-owner',
      campaignId,
      nodeId,
      PAST,
      PAST,
      PAST,
    );
  }
  const plan = planAutomationRuntimeReconciliation({
    store: f.strictStore,
    clock: fixedClock(),
    campaignId: 'reconcile-terminal',
  });
  assert.equal(plan.campaignId, 'reconcile-terminal');
  assert.deepEqual(plan.terminalCampaignQueuedNodes.map((node) => node.node_id),
    ['node-terminal']);
  assert.deepEqual(plan.expiredResourceLeases.map((lease) => lease.lease_id),
    ['scoped-expired-lease']);
  assert.deepEqual(plan.expiredWaiters.map((waiter) => waiter.waiter_id),
    ['scoped-expired-waiter']);
  for (const rows of [
    plan.expiredNodes,
    plan.noProgressCampaigns,
    plan.terminalCampaignActiveNodes,
    plan.preservedLegacyTerminalNodes,
  ]) assert.deepEqual(rows, []);
  const receiptLedger = createSqliteReceiptLedger({
    store: f.strictStore,
    clock: fixedClock(),
    issuerCapability: issueAutomationReconcilerWriter(),
  });
  const receipt = executeAutomationRuntimeReconciliation({
    store: f.strictStore,
    clock: fixedClock(),
    receiptLedger,
    campaignId: 'reconcile-terminal',
  });
  assert.equal(receipt.campaignId, 'reconcile-terminal');
  assert.equal(receipt.closedTerminalCampaignQueuedNodeCount, 1);
  assert.equal(receipt.removedResourceLeaseCount, 1);
  assert.equal(receipt.removedWaiterCount, 1);
  assert.equal(receipt.after.campaignId, 'reconcile-terminal');
  assert.equal(receipt.after.status, 'automation_runtime_reconciliation_clean');
  assert.equal(f.database.prepare(`SELECT status FROM campaign_nodes
    WHERE node_id='node-terminal'`).get().status, 'skipped');
  assert.equal(f.database.prepare(`SELECT status FROM campaign_nodes
    WHERE node_id='node-terminal-other'`).get().status, 'queued');
  assert.equal(f.database.prepare(`SELECT status FROM campaign_nodes
    WHERE node_id='node-terminal-active'`).get().status, 'running');
  assert.equal(f.database.prepare(`SELECT status FROM campaign_nodes
    WHERE node_id='node-expired'`).get().status, 'running');
  assert.equal(f.database.prepare(`SELECT status FROM paper_campaigns
    WHERE campaign_id='reconcile-idle'`).get().status, 'running');
  for (const [table, idColumn, removedId, preservedId] of [
    ['automation_resource_leases', 'lease_id', 'scoped-expired-lease',
      'other-expired-lease'],
    ['automation_resource_waiters', 'waiter_id', 'scoped-expired-waiter',
      'other-expired-waiter'],
  ]) {
    assert.equal(f.database.prepare(`SELECT count(*) count FROM ${table}
      WHERE ${idColumn}=?`).get(removedId).count, 0);
    assert.equal(f.database.prepare(`SELECT count(*) count FROM ${table}
      WHERE ${idColumn}=?`).get(preservedId).count, 1);
  }
  assert.equal(f.database.prepare(`SELECT count(*) count FROM campaign_events
    WHERE campaign_id='reconcile-terminal'
      AND kind='campaign_terminal_child_closed'`).get().count, 1);
  assert.equal(f.database.prepare(`SELECT count(*) count FROM campaign_events
    WHERE campaign_id='reconcile-terminal-other'
      AND kind='campaign_terminal_child_closed'`).get().count, 0);
  const ledgerReceipt = f.database.prepare(`SELECT receipt_json FROM receipt_ledger
    WHERE stream='automation-reconciliation'`).get();
  assert.equal(JSON.parse(ledgerReceipt.receipt_json).campaignId, 'reconcile-terminal');
  assert.equal(f.genericWriteAttempts(), 0);
});

test('strict runtime reconciliation rolls back a stale plan before its receipt', (t) => {
  const f = fixture(t);
  const receiptLedger = createSqliteReceiptLedger({
    store: f.strictStore,
    clock: fixedClock(),
    issuerCapability: issueAutomationReconcilerWriter(),
  });
  f.beforeNextMutation((database, operationId) => {
    assert.equal(
      operationId,
      NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_OPERATION_ID,
    );
    database.prepare(`UPDATE campaign_nodes SET status='queued'
      WHERE node_id='node-expired'`).run();
  });
  assert.throws(() => executeAutomationRuntimeReconciliation({
    store: f.strictStore,
    clock: fixedClock(),
    receiptLedger,
  }), /automation_runtime_reconciliation_node_precondition_failed/);
  assert.equal(f.database.prepare(`SELECT status FROM paper_campaigns
    WHERE campaign_id='reconcile-idle'`).get().status, 'running');
  assert.equal(f.database.prepare(`SELECT count(*) AS count
    FROM automation_resource_leases WHERE lease_id='reconcile-expired-lease'`)
    .get().count, 1);
  assert.equal(f.database.prepare(`SELECT count(*) AS count FROM receipt_ledger
    WHERE stream='automation-reconciliation'`).get().count, 0);
  assert.equal(f.database.prepare(`SELECT count(*) AS count FROM campaign_events
    WHERE kind LIKE 'campaign_%_reconciled'
       OR kind IN ('campaign_node_lease_recovered','campaign_no_progress_paused')`)
    .get().count, 0);
  assert.equal(f.genericWriteAttempts(), 0);
});

test('strict resource governor and workspace registry use only fixed mutations', async (t) => {
  const f = fixture(t);
  f.database.prepare(`DELETE FROM automation_resource_leases`).run();
  f.database.prepare(`DELETE FROM automation_resource_waiters`).run();
  const identity = currentProcessIdentity();
  const staleStart = identity.pidStartTime === '1' ? '2' : '1';
  const staleOwner = `resource-owner:fixture:process:${identity.pid}:${staleStart}`;
  f.database.prepare(`INSERT INTO automation_resource_leases(
    lease_id,scope,owner_id,agent,cpu,gpu,memory_mib,
    acquired_at,renewed_at,expires_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    'stale-resource-lease', 'global', staleOwner, 1, 0, 0, 0,
    NOW, NOW, FUTURE,
  );
  const governor = createSqliteResourceGovernor({
    store: f.strictStore,
    limits: { agent: 4, cpu: 4, gpu: 1, memoryMiB: 8192 },
    ownerId: 'strict-owner',
    leaseSeconds: 1,
    pollMs: 5,
    clock: fixedClock(),
  });
  assert.equal(governor.snapshot().activeLeases, 0);
  const release = await governor.acquire({ agent: 1, memoryMiB: 32 }, {
    campaignId: 'workspace-campaign',
    nodeId: 'workspace-node',
  });
  await new Promise((resolve) => setTimeout(resolve, 380));
  assert.equal(release(), true);

  const verifierLedger = createSqliteReceiptLedger({
    store: f.directLedgerStore,
    clock: fixedClock(),
    issuerCapability: issueWorkspaceSnapshotVerifierWriter(),
  });
  const registry = createWorkspaceRegistry({
    store: f.strictStore,
    clock: fixedClock(),
    receiptLedger: verifierLedger,
  });
  const workspacePath = path.join(f.root, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(path.join(workspacePath, 'main.tex'), 'strict workspace\n');
  registry.register({
    workspaceId: 'strict-workspace',
    campaignId: 'workspace-campaign',
    nodeId: 'workspace-node',
    sourcePath: '/source',
    workspacePath,
    manifestHash: 'sha256:initial',
  });
  const exported = exportWorkspaceSnapshot({
    registry,
    workspaceId: 'strict-workspace',
    workspacePath,
    exportRoot: path.join(f.root, 'exports'),
  });
  restoreWorkspaceSnapshot({
    receipt: exported,
    restoreRoot: path.join(f.root, 'restored'),
    registry,
    restoreReceiptLedger: verifierLedger,
    workspaceId: 'strict-workspace',
    verifiedAt: '2026-07-18T09:05:00.000Z',
  });
  assert.equal(registry.retentionRecords()[0].retentionState, 'eligible');
  for (const operationId of Object.values(
    NATIVE_STORE_RESOURCE_WORKSPACE_OPERATION_IDS,
  )) assert.ok(f.operationIds.includes(operationId), operationId);
  assert.equal(f.genericWriteAttempts(), 0);
});

test('strict theorem revisions and release promotion statements are plan-bound', (t) => {
  const f = fixture(t);
  const sink = createTheoremQualityRevisionSink({
    store: f.strictStore,
    clock: fixedClock(),
  });
  const report = Object.freeze({
    passed: false,
    blockers: Object.freeze([
      'theorem_proof_status_missing',
      'theorem_evidence_manifest_missing',
    ]),
    theoremManuscriptReadinessPolicyHash: 'sha256:theorem-policy',
  });
  assert.equal(sink.record({
    paperId: 'quality-paper',
    report,
    sourceWorkspace: '/quality-source',
  }).requestCount, 2);
  assert.equal(sink.record({
    paperId: 'quality-paper',
    report,
    sourceWorkspace: '/quality-source',
  }).requestCount, 2);
  const replaySink = createTheoremQualityRevisionSink({
    store: {
      execute() { throw new Error('generic_write_must_not_run'); },
      mutate({ mutate }) {
        const value = mutate({ run: () => ({ changes: 1 }) });
        return Object.freeze({
          status: 'externally_fenced_sqlite_mutation_no_change',
          value,
        });
      },
    },
    clock: fixedClock(),
  });
  assert.equal(replaySink.record({
    paperId: 'quality-paper',
    report,
    sourceWorkspace: '/quality-source',
  }).requestCount, 2);
  assert.equal(f.database.prepare(`SELECT count(*) AS count
    FROM referee_revision_requests WHERE slug='quality-paper'`).get().count, 2);

  f.database.prepare(`UPDATE paper_campaigns SET status='completed',
    current_phase='completed',spec_json=? WHERE campaign_id='workspace-campaign'`)
    .run(JSON.stringify({ campaignPlanHash: 'sha256:campaign-plan' }));
  f.database.prepare(`UPDATE campaign_nodes SET kind='package',status='completed',
    attempt_id='package-attempt',lease_generation=1,
    result_sha256='sha256:package-result',
    prepared_integration_status='integrated',
    prepared_integration_key='sha256:integration-descriptor',
    prepared_integration_receipt_sha256='sha256:integration-receipt',
    integrated_at=? WHERE node_id='workspace-node'`).run(NOW);
  const promoted = f.strictStore.mutate({
    operationId: NATIVE_STORE_QUALITY_RELEASE_OPERATION_IDS
      .promoteCompletedRelease,
    mutate: (transaction) => transaction.run(
      NATIVE_STORE_QUALITY_RELEASE_STATEMENT_IDS.insertCurrentCampaignRelease,
      'workspace-campaign',
      'paper-workspace',
      'sha256:campaign-plan',
      'workspace-node',
      'package-attempt',
      1,
      'sha256:package-result',
      'sha256:integration-descriptor',
      'sha256:integration-receipt',
      'sha256:release-bundle',
      'sha256:materialization-receipt',
      '{}',
      '{}',
      'sha256:promotion-receipt',
      NOW,
      NOW,
      'workspace-node',
      'workspace-campaign',
      'package-attempt',
      1,
      'sha256:package-result',
      'sha256:integration-descriptor',
      'sha256:integration-receipt',
      'paper-workspace',
      'sha256:campaign-plan',
    ).changes,
  });
  assert.equal(promoted.value, 1);
  assert.equal(f.database.prepare(`SELECT count(*) AS count
    FROM campaign_current_releases WHERE campaign_id='workspace-campaign'`)
    .get().count, 1);
  assert.equal(f.operationIds.filter((operationId) => operationId
    === NATIVE_STORE_QUALITY_RELEASE_OPERATION_IDS.recordTheoremQualityRevision)
    .length, 2);
  assert.ok(f.operationIds.includes(
    NATIVE_STORE_QUALITY_RELEASE_OPERATION_IDS.promoteCompletedRelease,
  ));
  assert.equal(f.genericWriteAttempts(), 0);
});
