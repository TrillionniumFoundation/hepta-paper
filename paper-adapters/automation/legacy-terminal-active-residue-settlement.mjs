import crypto from 'node:crypto';
import { failClosedStoreQueries, sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  preparedSqliteReceiptLedgerMutation,
} from '../persistence/sqlite-receipt-ledger.mjs';
import {
  NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_STATEMENT_IDS,
} from './native-store-automation-runtime-reconciliation-mutation-plan.mjs';

const S = NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_STATEMENT_IDS;
const SAFE_CAMPAIGN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const TERMINAL_CAMPAIGN_STATUSES = new Set([
  'failed', 'cancelled', 'stopped', 'completed',
]);
const ACTIVE_NODE_STATUSES = new Set(['leased', 'running']);
const UNCERTAIN_INTEGRATION_STATUSES = new Set(['integrating', 'integrated']);
const EXACTLY_ONE_GUARD_TABLE =
  'legacy_terminal_active_residue_settlement_exactly_one_guard';
const QUEUED_STATE_PAGE_SIZE = 512;

function fail(code) { throw new Error(code); }

function assertCampaignId(campaignId) {
  if (typeof campaignId !== 'string' || !SAFE_CAMPAIGN_ID.test(campaignId)) {
    fail('legacy_terminal_active_residue_campaign_id_invalid');
  }
  return campaignId;
}

function readCampaign(store, campaignId) {
  const rows = store.query(`SELECT campaign_id,paper_id,status,revision,stop_reason,
      spec_json,
      json_type(spec_json,
        '$.terminalSiblingSettlementPolicyVersion') AS policy_type,
      json_extract(spec_json,
        '$.terminalSiblingSettlementPolicyVersion') AS policy_version
    FROM paper_campaigns WHERE campaign_id=${sqlText(campaignId)} LIMIT 2;`).rows;
  if (rows.length !== 1 || rows[0].campaign_id !== campaignId) {
    fail('legacy_terminal_active_residue_campaign_not_found');
  }
  const campaign = rows[0];
  if (!TERMINAL_CAMPAIGN_STATUSES.has(campaign.status)) {
    fail('legacy_terminal_active_residue_campaign_not_terminal');
  }
  const policyMissing = campaign.policy_type === null;
  const explicitIntegerZero = campaign.policy_type === 'integer'
    && Number(campaign.policy_version) === 0;
  if (!policyMissing && !explicitIntegerZero) {
    fail('legacy_terminal_active_residue_policy_not_v0');
  }
  return Object.freeze({
    ...campaign,
    policyEncoding: policyMissing ? 'missing_legacy_v0' : 'explicit_integer_v0',
  });
}

function readResidueNodes(store, campaignId) {
  return store.query(`SELECT node_id,campaign_id,status,lease_owner,
      lease_expires_at,attempt_id,lease_generation,node_revision,
      prepared_integration_status
    FROM campaign_nodes WHERE campaign_id=${sqlText(campaignId)}
      AND status IN ('leased','running')
    ORDER BY node_id;`).rows;
}

function queuedStatePayload(row) {
  return {
    nodeId: row.node_id,
    status: row.status,
    nodeRevision: Number(row.node_revision || 0),
    leaseOwner: row.lease_owner || null,
    leaseExpiresAt: row.lease_expires_at || null,
    attemptId: row.attempt_id || null,
    leaseGeneration: Number(row.lease_generation || 0),
    preparedIntegrationStatus: String(row.prepared_integration_status || 'none'),
    preparedResultHash: row.prepared_result_sha256 || null,
    resultHash: row.result_sha256 || null,
    failureClass: row.failure_class || null,
    failureHash: row.failure_sha256 || null,
    updatedAt: row.updated_at,
  };
}

function readQueuedState(store, campaignId) {
  const digest = crypto.createHash('sha256');
  digest.update('LegacyTerminalPreservedQueuedNodeState:v1\0');
  let lastNodeId = null;
  let count = 0;
  while (true) {
    const rows = store.query(`SELECT node_id,status,node_revision,lease_owner,
        lease_expires_at,attempt_id,lease_generation,prepared_integration_status,
        prepared_result_sha256,result_sha256,failure_class,failure_sha256,updated_at
      FROM campaign_nodes WHERE campaign_id=${sqlText(campaignId)}
        AND status='queued'${lastNodeId ? ` AND node_id>${sqlText(lastNodeId)}` : ''}
      ORDER BY node_id LIMIT ${QUEUED_STATE_PAGE_SIZE};`).rows;
    for (const row of rows) {
      const encoded = JSON.stringify(queuedStatePayload(row));
      digest.update(`${Buffer.byteLength(encoded)}:`);
      digest.update(encoded);
    }
    count += rows.length;
    if (rows.length < QUEUED_STATE_PAGE_SIZE) break;
    lastNodeId = rows.at(-1).node_id;
  }
  return Object.freeze({
    preservedQueuedNodeCount: count,
    preservedQueuedNodeStateHash: `sha256:${digest.digest('hex')}`,
  });
}

function assertCoordinationRowsAbsent(store, campaignId) {
  const rows = store.query(`SELECT 'lease' AS row_kind,lease_id AS row_id
      FROM automation_resource_leases
      WHERE campaign_id=${sqlText(campaignId)}
        OR node_id IN (SELECT node_id FROM campaign_nodes
          WHERE campaign_id=${sqlText(campaignId)})
    UNION ALL
    SELECT 'waiter' AS row_kind,waiter_id AS row_id
      FROM automation_resource_waiters
      WHERE campaign_id=${sqlText(campaignId)}
        OR node_id IN (SELECT node_id FROM campaign_nodes
          WHERE campaign_id=${sqlText(campaignId)})
    ORDER BY row_kind,row_id;`).rows;
  if (rows.length) fail('legacy_terminal_active_residue_coordination_rows_present');
}

function normalizeResidueNode(row) {
  const payload = {
    nodeId: row.node_id,
    campaignId: row.campaign_id,
    status: row.status,
    leaseOwner: row.lease_owner || null,
    leaseExpiresAt: row.lease_expires_at || null,
    attemptId: row.attempt_id || null,
    leaseGeneration: Number(row.lease_generation || 0),
    nodeRevision: Number(row.node_revision || 0),
    preparedIntegrationStatus: String(row.prepared_integration_status || 'none'),
  };
  return Object.freeze({
    ...payload,
    nodeStateHash: hashRecord('LegacyTerminalActiveResidueNodeState', payload),
  });
}

function assertEligibleNodes(rows, plannedAt) {
  const plannedTime = Date.parse(plannedAt);
  if (!Number.isFinite(plannedTime)) fail('legacy_terminal_active_residue_clock_invalid');
  const nodes = rows.map(normalizeResidueNode);
  for (const node of nodes) {
    if (!ACTIVE_NODE_STATUSES.has(node.status)) {
      fail('legacy_terminal_active_residue_node_status_invalid');
    }
    const expiry = Date.parse(node.leaseExpiresAt || '');
    if (!Number.isFinite(expiry) || expiry > plannedTime) {
      fail('legacy_terminal_active_residue_lease_not_expired');
    }
    if (UNCERTAIN_INTEGRATION_STATUSES.has(node.preparedIntegrationStatus)) {
      fail('legacy_terminal_active_residue_integration_outcome_uncertain');
    }
  }
  return Object.freeze(nodes);
}

export function planLegacyTerminalActiveResidueSettlement({
  store: suppliedStore, clock, campaignId,
} = {}) {
  if (!suppliedStore || !clock?.nowIso) {
    fail('legacy_terminal_active_residue_store_and_clock_required');
  }
  const scopedCampaignId = assertCampaignId(campaignId);
  const store = failClosedStoreQueries(suppliedStore);
  const plannedAt = clock.nowIso();
  const campaign = readCampaign(store, scopedCampaignId);
  const nodes = assertEligibleNodes(readResidueNodes(store, scopedCampaignId), plannedAt);
  const queuedState = readQueuedState(store, scopedCampaignId);
  assertCoordinationRowsAbsent(store, scopedCampaignId);
  const payload = {
    version: 1,
    kind: 'LegacyTerminalActiveResidueSettlementPlan',
    status: nodes.length
      ? 'legacy_terminal_active_residue_settlement_required'
      : 'legacy_terminal_active_residue_settlement_clean',
    campaignId: scopedCampaignId,
    paperId: campaign.paper_id,
    campaignStatus: campaign.status,
    campaignRevision: Number(campaign.revision),
    campaignStopReason: campaign.stop_reason || null,
    terminalSiblingSettlementPolicyVersion: 0,
    terminalSiblingSettlementPolicyEncoding: campaign.policyEncoding,
    plannedAt,
    nodes,
    ...queuedState,
    workersStarted: false,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    settlementPlanHash: hashRecord('LegacyTerminalActiveResidueSettlementPlan', payload),
  });
}

function settlementEvent(plan, node, settledAt) {
  const failureDetail = Object.freeze({
    reason: 'legacy_terminal_expired_active_residue_settled',
    campaignStatus: plan.campaignStatus,
    campaignStopReason: plan.campaignStopReason,
    previousStatus: node.status,
    previousLeaseOwner: node.leaseOwner,
    previousLeaseExpiresAt: node.leaseExpiresAt,
    previousAttemptId: node.attemptId,
    previousLeaseGeneration: node.leaseGeneration,
    previousNodeRevision: node.nodeRevision,
    preparedIntegrationStatus: node.preparedIntegrationStatus,
    nodeStateHash: node.nodeStateHash,
    settlementPlanHash: plan.settlementPlanHash,
    workersStarted: false,
    externalActionPerformed: false,
  });
  const failureHash = hashRecord('PaperCampaignNodeFailure', failureDetail);
  const eventPayload = Object.freeze({
    version: 1,
    kind: 'campaign_legacy_terminal_expired_active_residue_settled',
    campaignId: plan.campaignId,
    nodeId: node.nodeId,
    detail: Object.freeze({
      status: 'skipped',
      failureClass: failureDetail.reason,
      failureHash,
      ...failureDetail,
    }),
    createdAt: settledAt,
  });
  const eventHash = hashRecord('PaperCampaignEvent', eventPayload);
  return Object.freeze({
    node,
    failureDetail,
    failureHash,
    event: Object.freeze({
      eventId: `${plan.campaignId}:${node.nodeId}:${eventHash.slice(-24)}`,
      eventHash,
      payload: eventPayload,
    }),
  });
}

function strictLedgerMutation(prepared) {
  const mutation = preparedSqliteReceiptLedgerMutation(prepared);
  if (mutation.strictInsert !== true) {
    fail('legacy_terminal_active_residue_strict_receipt_insert_required');
  }
  return mutation;
}

function runExactlyOne(transaction, statementId, parameters, code) {
  if (transaction.run(statementId, ...parameters).changes !== 1) fail(code);
}

function scopeGuardParameters(plan) {
  return [
    plan.campaignId,
    plan.campaignStatus,
    plan.campaignRevision,
    plan.preservedQueuedNodeCount,
    plan.nodes.length,
    plan.plannedAt,
  ];
}

function nodeSettlementParameters(plan, settlement, settledAt) {
  const { node } = settlement;
  return [
    settlement.failureDetail.reason,
    JSON.stringify(settlement.failureDetail),
    settlement.failureHash,
    settledAt,
    node.nodeId,
    plan.campaignId,
    node.status,
    node.leaseOwner,
    node.leaseOwner,
    node.leaseExpiresAt,
    node.attemptId,
    node.attemptId,
    node.leaseGeneration,
    node.nodeRevision,
    node.preparedIntegrationStatus,
    plan.plannedAt,
    plan.campaignStatus,
    plan.campaignRevision,
  ];
}

function applyStrictSettlement({ transaction, plan, settlements, prepared, settledAt }) {
  const ledgerMutation = strictLedgerMutation(prepared);
  runExactlyOne(
    transaction,
    S.assertLegacyTerminalActiveResidueScope,
    scopeGuardParameters(plan),
    'legacy_terminal_active_residue_scope_precondition_failed',
  );
  for (const settlement of settlements) {
    runExactlyOne(
      transaction,
      S.closeLegacyTerminalActiveResidue,
      nodeSettlementParameters(plan, settlement, settledAt),
      'legacy_terminal_active_residue_node_precondition_failed',
    );
    const { event } = settlement;
    runExactlyOne(transaction, S.insertCampaignEvent, [
      event.eventId,
      plan.campaignId,
      settlement.node.nodeId,
      event.payload.kind,
      JSON.stringify(event.payload),
      event.eventHash,
      settledAt,
    ], 'legacy_terminal_active_residue_event_insert_ambiguous');
  }
  runExactlyOne(
    transaction,
    S.insertReceipt,
    ledgerMutation.parameters,
    'legacy_terminal_active_residue_receipt_insert_ambiguous',
  );
  return Object.freeze({ settledNodeCount: settlements.length, ledgerChanges: 1 });
}

function nullableCondition(column, value) {
  return value === null ? `${column} IS NULL` : `${column}=${sqlText(value)}`;
}

function offlineExactlyOneGuardSql() {
  return `INSERT INTO temp.${EXACTLY_ONE_GUARD_TABLE}(exactly_one) VALUES(changes());
DELETE FROM temp.${EXACTLY_ONE_GUARD_TABLE};`;
}

function offlineExact(sql) {
  return `${sql};
${offlineExactlyOneGuardSql()}`;
}

function offlineScopeGuardSql(plan) {
  return offlineExact(`UPDATE paper_campaigns SET revision=revision
    WHERE campaign_id=${sqlText(plan.campaignId)}
      AND status=${sqlText(plan.campaignStatus)}
      AND revision=${plan.campaignRevision}
      AND status IN ('failed','cancelled','stopped','completed')
      AND (json_type(spec_json,
        '$.terminalSiblingSettlementPolicyVersion') IS NULL
        OR (json_type(spec_json,
          '$.terminalSiblingSettlementPolicyVersion')='integer'
          AND json_extract(spec_json,
            '$.terminalSiblingSettlementPolicyVersion')=0))
      AND (SELECT count(*) FROM campaign_nodes n
        WHERE n.campaign_id=paper_campaigns.campaign_id
          AND n.status='queued')=${plan.preservedQueuedNodeCount}
      AND (SELECT count(*) FROM campaign_nodes n
        WHERE n.campaign_id=paper_campaigns.campaign_id
          AND n.status IN ('leased','running'))=${plan.nodes.length}
      AND NOT EXISTS(SELECT 1 FROM campaign_nodes n
        WHERE n.campaign_id=paper_campaigns.campaign_id
          AND n.status IN ('leased','running')
          AND (n.lease_expires_at IS NULL
            OR julianday(n.lease_expires_at)>julianday(${sqlText(plan.plannedAt)})
            OR n.prepared_integration_status IN ('integrating','integrated')))
      AND NOT EXISTS(SELECT 1 FROM automation_resource_leases r
        WHERE r.campaign_id=paper_campaigns.campaign_id
          OR r.node_id IN (SELECT node_id FROM campaign_nodes
            WHERE campaign_id=paper_campaigns.campaign_id))
      AND NOT EXISTS(SELECT 1 FROM automation_resource_waiters r
        WHERE r.campaign_id=paper_campaigns.campaign_id
          OR r.node_id IN (SELECT node_id FROM campaign_nodes
            WHERE campaign_id=paper_campaigns.campaign_id))`);
}

function offlineSettlementSql(plan, settlement, settledAt) {
  const { node, event } = settlement;
  const update = offlineExact(`UPDATE campaign_nodes SET status='skipped',
    failure_class=${sqlText(settlement.failureDetail.reason)},
    failure_json=${sqlJson(settlement.failureDetail)},
    failure_sha256=${sqlText(settlement.failureHash)},lease_owner=NULL,
    lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,
    updated_at=${sqlText(settledAt)}
    WHERE node_id=${sqlText(node.nodeId)} AND campaign_id=${sqlText(plan.campaignId)}
      AND status=${sqlText(node.status)}
      AND ${nullableCondition('lease_owner', node.leaseOwner)}
      AND lease_expires_at=${sqlText(node.leaseExpiresAt)}
      AND ${nullableCondition('attempt_id', node.attemptId)}
      AND lease_generation=${node.leaseGeneration}
      AND node_revision=${node.nodeRevision}
      AND prepared_integration_status=${sqlText(node.preparedIntegrationStatus)}
      AND status IN ('leased','running')
      AND julianday(lease_expires_at)<=julianday(${sqlText(plan.plannedAt)})
      AND prepared_integration_status NOT IN ('integrating','integrated')
      AND EXISTS(SELECT 1 FROM paper_campaigns c
        WHERE c.campaign_id=campaign_nodes.campaign_id
          AND c.status=${sqlText(plan.campaignStatus)}
          AND c.revision=${plan.campaignRevision}
          AND c.status IN ('failed','cancelled','stopped','completed')
          AND (json_type(c.spec_json,
            '$.terminalSiblingSettlementPolicyVersion') IS NULL
            OR (json_type(c.spec_json,
              '$.terminalSiblingSettlementPolicyVersion')='integer'
              AND json_extract(c.spec_json,
                '$.terminalSiblingSettlementPolicyVersion')=0)))`);
  const insertEvent = offlineExact(`INSERT INTO campaign_events(
    event_id,campaign_id,node_id,kind,event_json,event_sha256,created_at
  ) VALUES(${sqlText(event.eventId)},${sqlText(plan.campaignId)},
    ${sqlText(node.nodeId)},${sqlText(event.payload.kind)},${sqlJson(event.payload)},
    ${sqlText(event.eventHash)},${sqlText(settledAt)})`);
  return `${update}\n${insertEvent}`;
}

function executeOfflineSettlement({ store, plan, settlements, prepared, settledAt }) {
  strictLedgerMutation(prepared);
  const result = store.execute(`BEGIN IMMEDIATE;
CREATE TEMP TABLE IF NOT EXISTS ${EXACTLY_ONE_GUARD_TABLE}(
  exactly_one INTEGER NOT NULL CHECK(exactly_one=1)
);
DELETE FROM temp.${EXACTLY_ONE_GUARD_TABLE};
${offlineScopeGuardSql(plan)}
${settlements.map((entry) => offlineSettlementSql(plan, entry, settledAt)).join('\n')}
${prepared.sql}
${offlineExactlyOneGuardSql()}
DROP TABLE temp.${EXACTLY_ONE_GUARD_TABLE};
COMMIT;`);
  if (!result.ok) {
    fail(result.error || result.stderr || 'legacy_terminal_active_residue_settlement_failed');
  }
}

export function executeLegacyTerminalActiveResidueSettlement({
  store, clock, receiptLedger, campaignId,
} = {}) {
  if (!receiptLedger?.prepare) {
    fail('legacy_terminal_active_residue_atomic_receipt_ledger_required');
  }
  const plan = planLegacyTerminalActiveResidueSettlement({ store, clock, campaignId });
  if (!plan.nodes.length) fail('legacy_terminal_active_residue_nothing_to_settle');
  const settledAt = plan.plannedAt;
  const settlements = Object.freeze(
    plan.nodes.map((node) => settlementEvent(plan, node, settledAt)),
  );
  const receiptPayload = {
    version: 3,
    kind: 'AutomationRuntimeReconciliationReceipt',
    status: 'legacy_terminal_active_residue_settled',
    campaignId: plan.campaignId,
    campaignStatus: plan.campaignStatus,
    campaignRevision: plan.campaignRevision,
    terminalSiblingSettlementPolicyVersion: 0,
    terminalSiblingSettlementPolicyEncoding:
      plan.terminalSiblingSettlementPolicyEncoding,
    settlementPlanHash: plan.settlementPlanHash,
    preservedQueuedNodeCount: plan.preservedQueuedNodeCount,
    preservedQueuedNodeStateHash: plan.preservedQueuedNodeStateHash,
    settledNodeCount: settlements.length,
    settledNodeIds: settlements.map(({ node }) => node.nodeId),
    settledNodeStateHashes: settlements.map(({ node }) => node.nodeStateHash),
    settlementEventHashes: settlements.map(({ event }) => event.eventHash),
    settledAt,
    workersStarted: false,
    externalActionPerformed: false,
  };
  const receiptHash = hashRecord('AutomationRuntimeReconciliationReceipt', receiptPayload);
  const prepared = receiptLedger.prepare({ ...receiptPayload, receiptHash }, {
    stream: 'automation-reconciliation',
    environment: 'administrative',
    evidenceClass: 'legacy_terminal_active_residue_settlement',
    strictInsert: true,
  });
  if (typeof store.mutate === 'function') {
    const coordinated = store.mutate({
      databaseRole: 'native-store',
      operationId:
        'native-store.legacy-terminal-active-residue-settlement.executeLegacyTerminalActiveResidueSettlement.v1',
      authorizationReceiptHashes: [],
      sideEffectReservationHashes: [],
      mutate: (transaction) => applyStrictSettlement({
        transaction, plan, settlements, prepared, settledAt,
      }),
    });
    if (coordinated?.status !== 'externally_fenced_sqlite_mutation_finalized'
      || coordinated.value?.ledgerChanges !== 1
      || coordinated.value?.settledNodeCount !== settlements.length) {
      fail('legacy_terminal_active_residue_external_mutation_receipt_invalid');
    }
  } else {
    executeOfflineSettlement({ store, plan, settlements, prepared, settledAt });
  }
  const after = planLegacyTerminalActiveResidueSettlement({ store, clock, campaignId });
  const { sql: _sql, ...ledgerReceipt } = prepared;
  return Object.freeze({
    ...receiptPayload,
    receiptHash,
    ledgerReceipt,
    after,
  });
}
