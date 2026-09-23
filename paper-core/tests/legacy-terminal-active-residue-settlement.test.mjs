import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  executeLegacyTerminalActiveResidueSettlement,
  planLegacyTerminalActiveResidueSettlement,
} from '../../paper-adapters/automation/legacy-terminal-active-residue-settlement.mjs';
import { issueAutomationReconcilerWriter } from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const CAMPAIGN_ID = 'autonomous-research:local-auto-20260730-45';
const NOW = '2026-08-01T05:00:00.000Z';
const EXPIRED = '2026-07-30T05:00:00.000Z';
const FUTURE = '2026-08-02T05:00:00.000Z';

function createFixture({ policy = 'explicit_integer_v0', queuedCount = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-legacy-residue-'));
  const store = createDefaultPaperStore({
    root,
    runtimeRoot: root,
    dbPath: path.join(root, 'test.sqlite'),
  });
  const clock = {
    now: () => new Date(NOW),
    nowIso: () => NOW,
  };
  const campaigns = createSqliteCampaignStore({ store, clock });
  const policyField = policy === 'missing' ? {} : {
    terminalSiblingSettlementPolicyVersion: {
      explicit_integer_v0: 0,
      text_zero: '0',
      boolean_false: false,
      integer_v1: 1,
    }[policy],
  };
  campaigns.createCampaign({
    campaignId: CAMPAIGN_ID,
    paperId: 'legacy-paper-45',
    ...policyField,
    nodes: [
      { nodeId: `${CAMPAIGN_ID}:terminal`, kind: 'agent', dependencies: [] },
      { nodeId: `${CAMPAIGN_ID}:expired-a`, kind: 'agent', dependencies: [] },
      { nodeId: `${CAMPAIGN_ID}:expired-b`, kind: 'agent', dependencies: [] },
      ...Array.from({ length: queuedCount }, (_, ordinal) => ({
        nodeId: `${CAMPAIGN_ID}:queued-${String(ordinal).padStart(4, '0')}`,
        kind: 'agent',
        dependencies: [],
      })),
    ],
  });
  assert.equal(store.execute(`UPDATE paper_campaigns SET status='failed',
    stop_reason='legacy_terminal_failure',revision=7
    WHERE campaign_id='${CAMPAIGN_ID}';`).ok, true);
  assert.equal(store.execute(`UPDATE campaign_nodes SET status='failed_terminal',
    failure_class='historical_failure',node_revision=3
    WHERE node_id='${CAMPAIGN_ID}:terminal';`).ok, true);
  for (const [suffix, ordinal] of [['expired-a', 1], ['expired-b', 2]]) {
    assert.equal(store.execute(`UPDATE campaign_nodes SET status='running',
      lease_owner='expired-worker-${ordinal}',lease_expires_at='${EXPIRED}',
      attempt_id='legacy-attempt-${ordinal}',lease_generation=${ordinal + 4},
      node_revision=${ordinal + 8},prepared_integration_status='none'
      WHERE node_id='${CAMPAIGN_ID}:${suffix}';`).ok, true);
  }
  const receiptLedger = createSqliteReceiptLedger({
    store,
    clock,
    issuerCapability: issueAutomationReconcilerWriter(),
  });
  return {
    root,
    store,
    clock,
    receiptLedger,
    close() {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function mutationEvidence(store) {
  return {
    events: Number(store.query(`SELECT count(*) AS count FROM campaign_events
      WHERE kind='campaign_legacy_terminal_expired_active_residue_settled'`).rows[0].count),
    receipts: Number(store.query(`SELECT count(*) AS count FROM receipt_ledger
      WHERE evidence_class='legacy_terminal_active_residue_settlement'`).rows[0].count),
  };
}

test('campaign45-shaped policy-v0 terminal residue is planned read-only and settled atomically', () => {
  const f = createFixture({ policy: 'missing', queuedCount: 2538 });
  try {
    const plan = planLegacyTerminalActiveResidueSettlement({
      store: f.store,
      clock: f.clock,
      campaignId: CAMPAIGN_ID,
    });
    assert.equal(plan.status, 'legacy_terminal_active_residue_settlement_required');
    assert.equal(plan.campaignStatus, 'failed');
    assert.equal(plan.campaignRevision, 7);
    assert.equal(plan.terminalSiblingSettlementPolicyVersion, 0);
    assert.equal(plan.terminalSiblingSettlementPolicyEncoding, 'missing_legacy_v0');
    assert.equal(plan.preservedQueuedNodeCount, 2538);
    assert.match(plan.preservedQueuedNodeStateHash, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(plan.nodes.map((node) => node.nodeId), [
      `${CAMPAIGN_ID}:expired-a`,
      `${CAMPAIGN_ID}:expired-b`,
    ]);
    assert.equal(plan.workersStarted, false);
    assert.equal(plan.externalActionPerformed, false);
    assert.equal(f.store.query(`SELECT count(*) AS count FROM campaign_nodes
      WHERE campaign_id='${CAMPAIGN_ID}' AND status='queued';`).rows[0].count, 2538);
    assert.deepEqual(mutationEvidence(f.store), { events: 0, receipts: 0 });

    const receipt = executeLegacyTerminalActiveResidueSettlement({
      store: f.store,
      clock: f.clock,
      campaignId: CAMPAIGN_ID,
      receiptLedger: f.receiptLedger,
    });
    assert.equal(receipt.status, 'legacy_terminal_active_residue_settled');
    assert.equal(receipt.settlementPlanHash, plan.settlementPlanHash);
    assert.equal(receipt.settledNodeCount, 2);
    assert.equal(receipt.preservedQueuedNodeCount, 2538);
    assert.equal(receipt.preservedQueuedNodeStateHash,
      plan.preservedQueuedNodeStateHash);
    assert.equal(receipt.workersStarted, false);
    assert.equal(receipt.externalActionPerformed, false);
    assert.equal(receipt.after.status, 'legacy_terminal_active_residue_settlement_clean');
    assert.deepEqual(receipt.after.nodes, []);
    assert.equal(receipt.after.preservedQueuedNodeCount, 2538);
    assert.equal(receipt.after.preservedQueuedNodeStateHash,
      plan.preservedQueuedNodeStateHash);
    assert.deepEqual(mutationEvidence(f.store), { events: 2, receipts: 1 });

    const rows = f.store.query(`SELECT node_id,status,failure_class,failure_json,
      failure_sha256,lease_owner,lease_expires_at,attempt_id,node_revision
      FROM campaign_nodes WHERE node_id IN (
        '${CAMPAIGN_ID}:expired-a','${CAMPAIGN_ID}:expired-b',
        '${CAMPAIGN_ID}:terminal') ORDER BY node_id;`).rows;
    assert.equal(rows[0].status, 'skipped');
    assert.equal(rows[1].status, 'skipped');
    assert.equal(rows[2].status, 'failed_terminal');
    assert.equal(f.store.query(`SELECT count(*) AS count FROM campaign_nodes
      WHERE campaign_id='${CAMPAIGN_ID}' AND status='queued';`).rows[0].count, 2538);
    for (const row of rows.slice(0, 2)) {
      assert.equal(row.failure_class, 'legacy_terminal_expired_active_residue_settled');
      assert.equal(row.lease_owner, null);
      assert.equal(row.lease_expires_at, null);
      assert.equal(row.attempt_id, null);
      const failure = JSON.parse(row.failure_json);
      assert.equal(hashRecord('PaperCampaignNodeFailure', failure), row.failure_sha256);
      assert.equal(failure.settlementPlanHash, plan.settlementPlanHash);
      assert.equal(failure.workersStarted, false);
      assert.equal(failure.externalActionPerformed, false);
    }

    const events = f.store.query(`SELECT event_json,event_sha256 FROM campaign_events
      WHERE kind='campaign_legacy_terminal_expired_active_residue_settled'
      ORDER BY node_id;`).rows;
    assert.deepEqual(events.map((row) => row.event_sha256), receipt.settlementEventHashes);
    for (const row of events) {
      assert.equal(hashRecord('PaperCampaignEvent', JSON.parse(row.event_json)),
        row.event_sha256);
    }
    const ledgerRow = f.store.query(`SELECT receipt_json,receipt_sha256,
      issuer_policy_id FROM receipt_ledger
      WHERE evidence_class='legacy_terminal_active_residue_settlement';`).rows[0];
    const persistedReceipt = JSON.parse(ledgerRow.receipt_json);
    const { receiptHash, ...persistedPayload } = persistedReceipt;
    assert.equal(hashRecord('AutomationRuntimeReconciliationReceipt', persistedPayload),
      receiptHash);
    assert.equal(ledgerRow.receipt_sha256, receiptHash);
    assert.equal(ledgerRow.issuer_policy_id, 'automation-reconciler');
    assert.throws(() => executeLegacyTerminalActiveResidueSettlement({
      store: f.store,
      clock: f.clock,
      campaignId: CAMPAIGN_ID,
      receiptLedger: f.receiptLedger,
    }), /legacy_terminal_active_residue_nothing_to_settle/);
  } finally {
    f.close();
  }
});

test('legacy residue settlement rejects every unsafe scope before writing', () => {
  const explicit = createFixture();
  try {
    const plan = planLegacyTerminalActiveResidueSettlement({
      store: explicit.store,
      clock: explicit.clock,
      campaignId: CAMPAIGN_ID,
    });
    assert.equal(plan.terminalSiblingSettlementPolicyEncoding, 'explicit_integer_v0');
    assert.equal(plan.status, 'legacy_terminal_active_residue_settlement_required');
  } finally {
    explicit.close();
  }
  const cases = [
    ['non-terminal parent', `UPDATE paper_campaigns SET status='running'
      WHERE campaign_id='${CAMPAIGN_ID}'`,
    /legacy_terminal_active_residue_campaign_not_terminal/],
    ['policy v1 parent', `UPDATE paper_campaigns SET spec_json=json_set(spec_json,
      '$.terminalSiblingSettlementPolicyVersion',1)
      WHERE campaign_id='${CAMPAIGN_ID}'`,
    /legacy_terminal_active_residue_policy_not_v0/],
    ['text-zero policy', `UPDATE paper_campaigns SET spec_json=json_set(spec_json,
      '$.terminalSiblingSettlementPolicyVersion','0')
      WHERE campaign_id='${CAMPAIGN_ID}'`,
    /legacy_terminal_active_residue_policy_not_v0/],
    ['boolean-false policy', `UPDATE paper_campaigns SET spec_json=json_set(spec_json,
      '$.terminalSiblingSettlementPolicyVersion',json('false'))
      WHERE campaign_id='${CAMPAIGN_ID}'`,
    /legacy_terminal_active_residue_policy_not_v0/],
    ['unexpired node lease', `UPDATE campaign_nodes SET lease_expires_at='${FUTURE}'
      WHERE node_id='${CAMPAIGN_ID}:expired-a'`,
    /legacy_terminal_active_residue_lease_not_expired/],
    ['integrating prepared result', `UPDATE campaign_nodes
      SET prepared_integration_status='integrating'
      WHERE node_id='${CAMPAIGN_ID}:expired-a'`,
    /legacy_terminal_active_residue_integration_outcome_uncertain/],
    ['integrated prepared result', `UPDATE campaign_nodes
      SET prepared_integration_status='integrated'
      WHERE node_id='${CAMPAIGN_ID}:expired-a'`,
    /legacy_terminal_active_residue_integration_outcome_uncertain/],
  ];
  for (const [label, mutation, expected] of cases) {
    const f = createFixture();
    try {
      assert.equal(f.store.execute(mutation).ok, true, label);
      assert.throws(() => planLegacyTerminalActiveResidueSettlement({
        store: f.store,
        clock: f.clock,
        campaignId: CAMPAIGN_ID,
      }), expected, label);
      assert.deepEqual(mutationEvidence(f.store), { events: 0, receipts: 0 }, label);
    } finally {
      f.close();
    }
  }
});

test('legacy residue settlement rejects stale queued or active state atomically', () => {
  for (const mutation of [
    `UPDATE campaign_nodes SET lease_expires_at='${FUTURE}',
      node_revision=node_revision+1 WHERE node_id='${CAMPAIGN_ID}:expired-a'`,
    `UPDATE campaign_nodes SET status='queued',node_revision=node_revision+1
      WHERE node_id='${CAMPAIGN_ID}:terminal'`,
  ]) {
    const f = createFixture();
    try {
      let injected = false;
      const racingLedger = {
        prepare(receipt, options) {
          const prepared = f.receiptLedger.prepare(receipt, options);
          assert.equal(injected, false);
          injected = true;
          assert.equal(f.store.execute(mutation).ok, true);
          return prepared;
        },
      };
      assert.throws(() => executeLegacyTerminalActiveResidueSettlement({
        store: f.store,
        clock: f.clock,
        campaignId: CAMPAIGN_ID,
        receiptLedger: racingLedger,
      }), /CHECK constraint failed|exactly_one/);
      assert.equal(injected, true);
      const rows = f.store.query(`SELECT node_id,status,lease_owner,attempt_id
        FROM campaign_nodes WHERE campaign_id='${CAMPAIGN_ID}'
        AND node_id LIKE '%:expired-%' ORDER BY node_id;`).rows;
      assert.deepEqual(rows.map((row) => row.status), ['running', 'running']);
      for (const row of rows) {
        assert.notEqual(row.lease_owner, null);
        assert.notEqual(row.attempt_id, null);
      }
      assert.deepEqual(mutationEvidence(f.store), { events: 0, receipts: 0 });
    } finally {
      f.close();
    }
  }
});
