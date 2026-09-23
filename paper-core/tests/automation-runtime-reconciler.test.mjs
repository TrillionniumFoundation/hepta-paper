import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeAutomationRuntimeReconciliation, planAutomationRuntimeReconciliation } from '../../paper-adapters/automation/automation-runtime-reconciler.mjs';
import { issueAutomationReconcilerWriter } from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

test('startup reconciliation atomically requeues expired nodes and removes only expired coordination rows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-automation-reconcile-'));
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'test.sqlite') });
  const clock = { now: () => new Date('2026-07-13T08:00:00.000Z'), nowIso: () => '2026-07-13T08:00:00.000Z' };
  try {
    const campaigns = createSqliteCampaignStore({ store, clock });
    for (const ordinal of [1, 2, 3, 4, 5, 6]) campaigns.createCampaign({
      campaignId: `campaign-${ordinal}`,
      paperId: `paper-${ordinal}`,
      ...([3, 4, 5].includes(ordinal)
        ? { terminalSiblingSettlementPolicyVersion: 1 } : {}),
      nodes: [{ nodeId: `node-${ordinal}`, kind: 'agent', dependencies: [] }],
    });
    assert.equal(store.execute("UPDATE paper_campaigns SET status='failed',stop_reason='historical_failure' WHERE campaign_id='campaign-3';").ok, true);
    assert.equal(store.execute("UPDATE paper_campaigns SET status='failed',stop_reason='historical_parallel_failure' WHERE campaign_id='campaign-4';").ok, true);
    assert.equal(store.execute("UPDATE paper_campaigns SET status='failed',stop_reason='historical_integration_failure' WHERE campaign_id='campaign-5';").ok, true);
    assert.equal(store.execute("UPDATE paper_campaigns SET status='failed',stop_reason='pre_cutover_frozen_failure' WHERE campaign_id='campaign-6';").ok, true);
    assert.equal(store.execute("UPDATE paper_campaigns SET updated_at='2026-07-13T06:00:00.000Z' WHERE campaign_id='campaign-2';").ok, true);
    assert.equal(store.execute("UPDATE campaign_nodes SET status='running',lease_owner='dead-worker',lease_expires_at='2026-07-13T07:00:00.000Z' WHERE node_id='node-1';").ok, true);
    assert.equal(store.execute("UPDATE campaign_nodes SET status='running',lease_owner='terminal-dead-worker',lease_expires_at='2026-07-13T07:00:00.000Z',attempt_id='terminal-attempt-4',lease_generation=4,node_revision=7 WHERE node_id='node-4';").ok, true);
    assert.equal(store.execute("UPDATE campaign_nodes SET status='running',lease_owner='integration-dead-worker',lease_expires_at='2026-07-13T07:00:00.000Z',attempt_id='terminal-attempt-5',lease_generation=5,node_revision=8,prepared_integration_status='integrating' WHERE node_id='node-5';").ok, true);
    assert.equal(store.execute("UPDATE campaign_nodes SET status='running',lease_owner='legacy-dead-worker',lease_expires_at='2026-07-13T07:00:00.000Z',attempt_id='legacy-attempt-6',lease_generation=6,node_revision=9 WHERE node_id='node-6';").ok, true);
    assert.equal(store.execute("INSERT OR IGNORE INTO automation_resource_limits(scope,agent_limit,cpu_limit,gpu_limit,memory_mib_limit,created_at,updated_at) VALUES('global',4,4,1,8192,'2026-07-13T00:00:00.000Z','2026-07-13T00:00:00.000Z');").ok, true);
    assert.equal(store.execute("INSERT INTO automation_resource_leases(lease_id,scope,owner_id,agent,cpu,gpu,memory_mib,acquired_at,renewed_at,expires_at) VALUES('expired-lease','global','dead',1,0,0,0,'2026-07-13T06:00:00.000Z','2026-07-13T06:00:00.000Z','2026-07-13T07:00:00.000Z'),('active-lease','global','live',1,0,0,0,'2026-07-13T07:30:00.000Z','2026-07-13T07:30:00.000Z','2026-07-13T09:00:00.000Z');").ok, true);
    assert.equal(store.execute("INSERT INTO automation_resource_waiters(waiter_id,scope,owner_id,agent,cpu,gpu,memory_mib,requested_at,renewed_at,expires_at) VALUES('expired-waiter','global','dead',1,0,0,0,'2026-07-13T06:00:00.000Z','2026-07-13T06:00:00.000Z','2026-07-13T07:00:00.000Z'),('active-waiter','global','live',1,0,0,0,'2026-07-13T07:30:00.000Z','2026-07-13T07:30:00.000Z','2026-07-13T09:00:00.000Z');").ok, true);
    assert.throws(() => planAutomationRuntimeReconciliation({
      store, clock, campaignId: '',
    }), /automation_runtime_reconciliation_campaign_id_invalid/);
    assert.throws(() => planAutomationRuntimeReconciliation({
      store, clock, campaignId: 'campaign-missing',
    }), /automation_runtime_reconciliation_campaign_scope_not_found/);
    assert.throws(() => planAutomationRuntimeReconciliation({
      store, clock, campaignId: 'campaign-6',
    }), /automation_runtime_reconciliation_campaign_scope_policy_unsupported/);
    const scopedPlan = planAutomationRuntimeReconciliation({
      store, clock, campaignId: 'campaign-3',
    });
    assert.equal(scopedPlan.campaignId, 'campaign-3');
    assert.deepEqual(scopedPlan.terminalCampaignQueuedNodes.map((node) => node.node_id),
      ['node-3']);
    for (const rows of [
      scopedPlan.expiredNodes,
      scopedPlan.expiredResourceLeases,
      scopedPlan.expiredWaiters,
      scopedPlan.noProgressCampaigns,
      scopedPlan.terminalCampaignActiveNodes,
      scopedPlan.preservedLegacyTerminalNodes,
    ]) assert.deepEqual(rows, []);
    const plan = planAutomationRuntimeReconciliation({ store, clock });
    assert.equal(plan.expiredNodes.length, 1);
    assert.deepEqual(plan.expiredNodes.map((node) => node.node_id), ['node-1']);
    assert.deepEqual(plan.noProgressCampaigns.map((campaign) => campaign.campaign_id), ['campaign-2']);
    assert.deepEqual(plan.terminalCampaignQueuedNodes.map((node) => node.node_id), ['node-3']);
    assert.deepEqual(plan.terminalCampaignActiveNodes.map((node) => node.node_id),
      ['node-4', 'node-5']);
    assert.deepEqual(plan.preservedLegacyTerminalNodes.map((node) => node.node_id),
      ['node-6']);
    const receiptLedger = createSqliteReceiptLedger({ store, clock, issuerCapability: issueAutomationReconcilerWriter() });
    const receipt = executeAutomationRuntimeReconciliation({ store, clock, receiptLedger });
    assert.equal(receipt.recoveredNodeCount, 1);
    assert.equal(receipt.pausedNoProgressCampaignCount, 1);
    assert.equal(receipt.closedTerminalCampaignQueuedNodeCount, 1);
    assert.equal(receipt.closedTerminalCampaignActiveNodeCount, 2);
    assert.equal(receipt.preservedLegacyTerminalNodeCount, 1);
    assert.equal(store.query("SELECT status FROM campaign_nodes WHERE node_id='node-1'").rows[0].status, 'queued');
    assert.equal(store.query("SELECT status FROM paper_campaigns WHERE campaign_id='campaign-2'").rows[0].status, 'paused');
    assert.equal(store.query("SELECT status FROM campaign_nodes WHERE node_id='node-2'").rows[0].status, 'queued');
    assert.equal(store.query("SELECT status FROM campaign_nodes WHERE node_id='node-3'").rows[0].status, 'skipped');
    assert.equal(store.query("SELECT status FROM campaign_nodes WHERE node_id='node-4'").rows[0].status, 'skipped');
    assert.equal(store.query("SELECT status FROM campaign_nodes WHERE node_id='node-5'").rows[0].status, 'external_outcome_uncertain');
    assert.equal(store.query("SELECT status FROM campaign_nodes WHERE node_id='node-6'").rows[0].status, 'running');
    for (const nodeId of ['node-4', 'node-5']) {
      const row = store.query(`SELECT failure_class,failure_json,failure_sha256,
        lease_owner,lease_expires_at,attempt_id FROM campaign_nodes
        WHERE node_id='${nodeId}'`).rows[0];
      const failure = JSON.parse(row.failure_json);
      assert.equal(failure.reason, row.failure_class);
      assert.equal(hashRecord('PaperCampaignNodeFailure', failure), row.failure_sha256);
      assert.equal(row.lease_owner, null);
      assert.equal(row.lease_expires_at, null);
      assert.equal(row.attempt_id, null);
    }
    assert.equal(store.query("SELECT count(*) count FROM campaign_events WHERE node_id='node-3' AND kind='campaign_terminal_child_closed'").rows[0].count, 1);
    assert.equal(store.query("SELECT count(*) count FROM campaign_events WHERE kind='campaign_terminal_active_child_settled'").rows[0].count, 2);
    assert.equal(store.query("SELECT count(*) count FROM campaign_events WHERE campaign_id='campaign-2' AND kind='campaign_no_progress_paused'").rows[0].count, 1);
    assert.equal(store.query('SELECT count(*) count FROM automation_resource_leases').rows[0].count, 1);
    assert.equal(store.query('SELECT count(*) count FROM automation_resource_waiters').rows[0].count, 1);
    assert.equal(receiptLedger.get(receipt.ledgerReceipt.receiptId).issuer_policy_id, 'automation-reconciler');
    const after = planAutomationRuntimeReconciliation({ store, clock });
    assert.equal(after.status,
      'automation_runtime_reconciliation_legacy_terminal_evidence_preserved');
    assert.deepEqual(after.preservedLegacyTerminalNodes.map((node) => node.node_id),
      ['node-6']);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('offline reconciliation rolls back every mutation when a terminal queued plan becomes stale', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-automation-reconcile-race-'));
  const store = createDefaultPaperStore({
    root,
    runtimeRoot: root,
    dbPath: path.join(root, 'test.sqlite'),
  });
  const clock = {
    now: () => new Date('2026-07-13T08:00:00.000Z'),
    nowIso: () => '2026-07-13T08:00:00.000Z',
  };
  try {
    const campaigns = createSqliteCampaignStore({ store, clock });
    campaigns.createCampaign({
      campaignId: 'race-running',
      paperId: 'race-running-paper',
      nodes: [{ nodeId: 'race-expired-node', kind: 'agent', dependencies: [] }],
    });
    campaigns.createCampaign({
      campaignId: 'race-terminal',
      paperId: 'race-terminal-paper',
      terminalSiblingSettlementPolicyVersion: 1,
      nodes: [{ nodeId: 'race-terminal-node', kind: 'agent', dependencies: [] }],
    });
    assert.equal(store.execute(`UPDATE campaign_nodes SET status='running',
      lease_owner='dead-race-worker',lease_expires_at='2026-07-13T07:00:00.000Z',
      attempt_id='race-attempt',lease_generation=2,node_revision=3
      WHERE node_id='race-expired-node';`).ok, true);
    assert.equal(store.execute(`UPDATE paper_campaigns SET status='failed',
      stop_reason='race_terminal_failure' WHERE campaign_id='race-terminal';`).ok, true);
    assert.equal(store.execute(`INSERT OR IGNORE INTO automation_resource_limits(
      scope,agent_limit,cpu_limit,gpu_limit,memory_mib_limit,created_at,updated_at
    ) VALUES('race-scope',1,1,0,1024,'2026-07-13T00:00:00.000Z',
      '2026-07-13T00:00:00.000Z');`).ok, true);
    assert.equal(store.execute(`INSERT INTO automation_resource_leases(
      lease_id,scope,owner_id,campaign_id,node_id,agent,cpu,gpu,memory_mib,
      acquired_at,renewed_at,expires_at
    ) VALUES('race-expired-lease','race-scope','race-owner','race-running',
      'race-expired-node',1,0,0,0,'2026-07-13T06:00:00.000Z',
      '2026-07-13T06:00:00.000Z','2026-07-13T07:00:00.000Z');`).ok, true);

    const beforeRecoveredNode = store.query(`SELECT * FROM campaign_nodes
      WHERE node_id='race-expired-node'`).rows[0];
    const beforeEventCount = Number(store.query(
      'SELECT count(*) AS count FROM campaign_events',
    ).rows[0].count);
    const receiptLedger = createSqliteReceiptLedger({
      store,
      clock,
      issuerCapability: issueAutomationReconcilerWriter(),
    });
    let injected = false;
    const racingReceiptLedger = {
      prepare(receipt, options) {
        const prepared = receiptLedger.prepare(receipt, options);
        assert.equal(injected, false);
        injected = true;
        const result = store.execute(`UPDATE campaign_nodes SET status='completed',
          node_revision=node_revision+1,updated_at='2026-07-13T08:00:00.000Z'
          WHERE node_id='race-terminal-node' AND status='queued';`);
        assert.equal(result.ok, true);
        return prepared;
      },
    };

    assert.throws(() => executeAutomationRuntimeReconciliation({
      store,
      clock,
      receiptLedger: racingReceiptLedger,
    }), /exactly_one/);
    assert.equal(injected, true);

    const afterRecoveredNode = store.query(`SELECT * FROM campaign_nodes
      WHERE node_id='race-expired-node'`).rows[0];
    assert.deepEqual(afterRecoveredNode, beforeRecoveredNode);
    const terminalNode = store.query(`SELECT status,node_revision,failure_class
      FROM campaign_nodes WHERE node_id='race-terminal-node'`).rows[0];
    assert.equal(terminalNode.status, 'completed');
    assert.equal(Number(terminalNode.node_revision), 1);
    assert.equal(terminalNode.failure_class, null);
    assert.equal(store.query(`SELECT count(*) AS count
      FROM automation_resource_leases WHERE lease_id='race-expired-lease'`).rows[0].count, 1);
    assert.equal(Number(store.query(
      'SELECT count(*) AS count FROM campaign_events',
    ).rows[0].count), beforeEventCount);
    assert.equal(store.query(`SELECT count(*) AS count FROM receipt_ledger
      WHERE stream='automation-reconciliation'`).rows[0].count, 0);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
