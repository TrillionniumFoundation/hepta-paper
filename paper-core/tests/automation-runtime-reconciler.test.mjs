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

test('startup reconciliation atomically requeues expired nodes and removes only expired coordination rows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-automation-reconcile-'));
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'test.sqlite') });
  const clock = { now: () => new Date('2026-07-13T08:00:00.000Z'), nowIso: () => '2026-07-13T08:00:00.000Z' };
  try {
    const campaigns = createSqliteCampaignStore({ store, clock });
    campaigns.createCampaign({ campaignId: 'campaign-1', paperId: 'paper-1', nodes: [{ nodeId: 'node-1', kind: 'agent', dependencies: [] }] });
    campaigns.createCampaign({ campaignId: 'campaign-2', paperId: 'paper-2', nodes: [{ nodeId: 'node-2', kind: 'agent', dependencies: [] }] });
    assert.equal(store.execute("UPDATE paper_campaigns SET updated_at='2026-07-13T06:00:00.000Z' WHERE campaign_id='campaign-2';").ok, true);
    assert.equal(store.execute("UPDATE campaign_nodes SET status='running',lease_owner='dead-worker',lease_expires_at='2026-07-13T07:00:00.000Z' WHERE node_id='node-1';").ok, true);
    assert.equal(store.execute("INSERT OR IGNORE INTO automation_resource_limits(scope,agent_limit,cpu_limit,gpu_limit,memory_mib_limit,created_at,updated_at) VALUES('global',4,4,1,8192,'2026-07-13T00:00:00.000Z','2026-07-13T00:00:00.000Z');").ok, true);
    assert.equal(store.execute("INSERT INTO automation_resource_leases(lease_id,scope,owner_id,agent,cpu,gpu,memory_mib,acquired_at,renewed_at,expires_at) VALUES('expired-lease','global','dead',1,0,0,0,'2026-07-13T06:00:00.000Z','2026-07-13T06:00:00.000Z','2026-07-13T07:00:00.000Z'),('active-lease','global','live',1,0,0,0,'2026-07-13T07:30:00.000Z','2026-07-13T07:30:00.000Z','2026-07-13T09:00:00.000Z');").ok, true);
    assert.equal(store.execute("INSERT INTO automation_resource_waiters(waiter_id,scope,owner_id,agent,cpu,gpu,memory_mib,requested_at,renewed_at,expires_at) VALUES('expired-waiter','global','dead',1,0,0,0,'2026-07-13T06:00:00.000Z','2026-07-13T06:00:00.000Z','2026-07-13T07:00:00.000Z'),('active-waiter','global','live',1,0,0,0,'2026-07-13T07:30:00.000Z','2026-07-13T07:30:00.000Z','2026-07-13T09:00:00.000Z');").ok, true);
    const plan = planAutomationRuntimeReconciliation({ store, clock });
    assert.equal(plan.expiredNodes.length, 1);
    assert.deepEqual(plan.noProgressCampaigns.map((campaign) => campaign.campaign_id), ['campaign-2']);
    const receiptLedger = createSqliteReceiptLedger({ store, clock, issuerCapability: issueAutomationReconcilerWriter() });
    const receipt = executeAutomationRuntimeReconciliation({ store, clock, receiptLedger });
    assert.equal(receipt.recoveredNodeCount, 1);
    assert.equal(receipt.pausedNoProgressCampaignCount, 1);
    assert.equal(store.query("SELECT status FROM campaign_nodes WHERE node_id='node-1'").rows[0].status, 'queued');
    assert.equal(store.query("SELECT status FROM paper_campaigns WHERE campaign_id='campaign-2'").rows[0].status, 'paused');
    assert.equal(store.query("SELECT status FROM campaign_nodes WHERE node_id='node-2'").rows[0].status, 'queued');
    assert.equal(store.query("SELECT count(*) count FROM campaign_events WHERE campaign_id='campaign-2' AND kind='campaign_no_progress_paused'").rows[0].count, 1);
    assert.equal(store.query('SELECT count(*) count FROM automation_resource_leases').rows[0].count, 1);
    assert.equal(store.query('SELECT count(*) count FROM automation_resource_waiters').rows[0].count, 1);
    assert.equal(receiptLedger.get(receipt.ledgerReceipt.receiptId).issuer_policy_id, 'automation-reconciler');
    assert.equal(planAutomationRuntimeReconciliation({ store, clock }).status, 'automation_runtime_reconciliation_clean');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
