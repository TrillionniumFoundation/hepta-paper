import { failClosedStoreQueries, sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  preparedSqliteReceiptLedgerMutation,
} from '../persistence/sqlite-receipt-ledger.mjs';
import {
  NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_STATEMENT_IDS,
} from './native-store-automation-runtime-reconciliation-mutation-plan.mjs';

const S = NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_STATEMENT_IDS;

export function planAutomationRuntimeReconciliation({ store: suppliedStore, clock, noProgressSeconds = 1800 } = {}) {
  if (!suppliedStore || !clock) throw new Error('Automation reconciliation requires store and clock');
  const store = failClosedStoreQueries(suppliedStore);
  const now = clock.nowIso();
  const noProgressCutoff = new Date(clock.now().getTime() - Math.max(60, Number(noProgressSeconds || 1800)) * 1000).toISOString();
  const expiredNodes = store.query(`SELECT node_id,campaign_id,status,lease_owner,lease_expires_at,attempt_id,lease_generation,node_revision FROM campaign_nodes WHERE status IN ('leased','running') AND lease_expires_at IS NOT NULL AND julianday(lease_expires_at)<=julianday(${sqlText(now)}) ORDER BY campaign_id,node_id;`).rows;
  const expiredResourceLeases = store.query(`SELECT lease_id,scope,owner_id,campaign_id,node_id,expires_at FROM automation_resource_leases WHERE expires_at<=${sqlText(now)} ORDER BY lease_id;`).rows;
  const expiredWaiters = store.query(`SELECT waiter_id,scope,owner_id,campaign_id,node_id,expires_at FROM automation_resource_waiters WHERE expires_at IS NOT NULL AND expires_at<=${sqlText(now)} ORDER BY waiter_id;`).rows;
  const noProgressCampaigns = store.query(`SELECT c.campaign_id,c.paper_id,c.updated_at,c.current_phase,count(n.node_id) AS queued_node_count
    FROM paper_campaigns c
    JOIN campaign_nodes n ON n.campaign_id=c.campaign_id AND n.status='queued'
    WHERE c.status='running' AND c.updated_at<=${sqlText(noProgressCutoff)}
      AND NOT EXISTS(SELECT 1 FROM campaign_nodes active WHERE active.campaign_id=c.campaign_id AND active.status IN ('leased','running'))
    GROUP BY c.campaign_id,c.paper_id,c.updated_at,c.current_phase
    ORDER BY c.updated_at,c.campaign_id;`).rows;
  const terminalCampaignQueuedNodes = store.query(`SELECT n.node_id,n.campaign_id,c.status AS campaign_status,c.stop_reason
    FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id
    WHERE n.status='queued' AND c.status IN ('failed','cancelled','stopped','completed')
    ORDER BY n.campaign_id,n.node_id;`).rows;
  const payload = {
    version: 2,
    kind: 'AutomationRuntimeReconciliationPlan',
    status: expiredNodes.length || expiredResourceLeases.length || expiredWaiters.length || noProgressCampaigns.length || terminalCampaignQueuedNodes.length
      ? 'automation_runtime_reconciliation_required'
      : 'automation_runtime_reconciliation_clean',
    plannedAt: now,
    expiredNodes,
    expiredResourceLeases,
    expiredWaiters,
    noProgressCutoff,
    noProgressCampaigns,
    terminalCampaignQueuedNodes,
  };
  return Object.freeze({ ...payload, reconciliationPlanHash: hashRecord('AutomationRuntimeReconciliationPlan', payload) });
}

function campaignEvent({ kind, campaignId, nodeId = null, detail, createdAt }) {
  const payload = {
    version: 1,
    kind,
    campaignId,
    nodeId,
    detail,
    createdAt,
  };
  const eventHash = hashRecord('PaperCampaignEvent', payload);
  return Object.freeze({
    eventId: `${campaignId}:${createdAt}:${eventHash.slice(-16)}`,
    campaignId,
    nodeId,
    kind,
    payload: Object.freeze(payload),
    eventHash,
    createdAt,
  });
}

function reconciliationEvents(plan, reconciledAt) {
  const recoveredNodes = plan.expiredNodes.map((node) => Object.freeze({
    node,
    event: campaignEvent({
      kind: 'campaign_node_lease_recovered',
      campaignId: node.campaign_id,
      nodeId: node.node_id,
      detail: {
        previousStatus: node.status,
        previousLeaseOwner: node.lease_owner,
        previousLeaseExpiresAt: node.lease_expires_at,
        reconciliationPlanHash: plan.reconciliationPlanHash,
      },
      createdAt: reconciledAt,
    }),
  }));
  const noProgressCampaigns = plan.noProgressCampaigns.map((campaign) => Object.freeze({
    campaign,
    event: campaignEvent({
      kind: 'campaign_no_progress_paused',
      campaignId: campaign.campaign_id,
      detail: {
        previousStatus: 'running',
        previousPhase: campaign.current_phase,
        previousUpdatedAt: campaign.updated_at,
        queuedNodeCount: Number(campaign.queued_node_count || 0),
        noProgressCutoff: plan.noProgressCutoff,
        reconciliationPlanHash: plan.reconciliationPlanHash,
      },
      createdAt: reconciledAt,
    }),
  }));
  const terminalNodes = plan.terminalCampaignQueuedNodes.map((node) => Object.freeze({
    node,
    event: campaignEvent({
      kind: 'campaign_terminal_child_closed',
      campaignId: node.campaign_id,
      nodeId: node.node_id,
      detail: {
        campaignStatus: node.campaign_status,
        campaignStopReason: node.stop_reason || null,
        reconciliationPlanHash: plan.reconciliationPlanHash,
      },
      createdAt: reconciledAt,
    }),
  }));
  return Object.freeze({ recoveredNodes, noProgressCampaigns, terminalNodes });
}

function insertStrictEvent(transaction, event) {
  const inserted = transaction.run(
    S.insertCampaignEvent,
    event.eventId,
    event.campaignId,
    event.nodeId,
    event.kind,
    JSON.stringify(event.payload),
    event.eventHash,
    event.createdAt,
  );
  if (inserted.changes !== 1) {
    throw new Error('automation_runtime_reconciliation_event_insert_ambiguous');
  }
}

function applyStrictReconciliation({ transaction, plan, events, prepared, reconciledAt }) {
  const ledgerMutation = preparedSqliteReceiptLedgerMutation(prepared);
  if (ledgerMutation.strictInsert !== true) {
    throw new Error('automation_runtime_reconciliation_strict_receipt_insert_required');
  }
  for (const { node, event } of events.recoveredNodes) {
    const recovered = transaction.run(
      S.recoverExpiredNode,
      reconciledAt,
      node.node_id,
      node.status,
      node.lease_owner,
      node.lease_owner,
      node.attempt_id,
      node.attempt_id,
      Number(node.lease_generation || 0),
      Number(node.node_revision || 0),
      reconciledAt,
    );
    if (recovered.changes !== 1) {
      throw new Error('automation_runtime_reconciliation_node_precondition_failed');
    }
    insertStrictEvent(transaction, event);
  }
  for (const { campaign, event } of events.noProgressCampaigns) {
    const paused = transaction.run(
      S.pauseNoProgressCampaign,
      reconciledAt,
      reconciledAt,
      campaign.campaign_id,
    );
    if (paused.changes !== 1) {
      throw new Error('automation_runtime_reconciliation_campaign_precondition_failed');
    }
    insertStrictEvent(transaction, event);
  }
  for (const { node, event } of events.terminalNodes) {
    const closed = transaction.run(
      S.closeTerminalQueuedNode,
      reconciledAt,
      node.node_id,
    );
    if (closed.changes !== 1) {
      throw new Error('automation_runtime_reconciliation_terminal_node_precondition_failed');
    }
    insertStrictEvent(transaction, event);
  }
  const removedResourceLeases = transaction.run(
    S.deleteExpiredResourceLeases,
    reconciledAt,
  ).changes;
  const removedWaiters = transaction.run(
    S.deleteExpiredResourceWaiters,
    reconciledAt,
  ).changes;
  if (removedResourceLeases !== plan.expiredResourceLeases.length
    || removedWaiters !== plan.expiredWaiters.length) {
    throw new Error('automation_runtime_reconciliation_resource_precondition_failed');
  }
  const ledgerChanges = transaction.run(
    S.insertReceipt,
    ...ledgerMutation.parameters,
  ).changes;
  if (ledgerChanges !== 1) {
    throw new Error('automation_runtime_reconciliation_receipt_insert_ambiguous');
  }
  return Object.freeze({
    ledgerChanges,
    recoveredNodeCount: events.recoveredNodes.length,
    pausedCampaignCount: events.noProgressCampaigns.length,
    closedTerminalNodeCount: events.terminalNodes.length,
    removedResourceLeaseCount: removedResourceLeases,
    removedWaiterCount: removedWaiters,
  });
}

function executeOfflineReconciliation({ store, plan, events, prepared, reconciledAt }) {
  const recoverySql = events.recoveredNodes.map(({ node, event }) => {
    const attemptCondition = node.attempt_id
      ? `attempt_id=${sqlText(node.attempt_id)}` : 'attempt_id IS NULL';
    const ownerCondition = node.lease_owner
      ? `lease_owner=${sqlText(node.lease_owner)}` : 'lease_owner IS NULL';
    return `UPDATE campaign_nodes SET status='queued',lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,failure_class='lease_expired_recovered',updated_at=${sqlText(reconciledAt)} WHERE node_id=${sqlText(node.node_id)} AND status=${sqlText(node.status)} AND ${ownerCondition} AND ${attemptCondition} AND lease_generation=${Number(node.lease_generation || 0)} AND node_revision=${Number(node.node_revision || 0)} AND julianday(lease_expires_at)<=julianday(${sqlText(reconciledAt)}) AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running');
INSERT OR IGNORE INTO campaign_events(event_id,campaign_id,node_id,kind,event_json,event_sha256,created_at) SELECT ${sqlText(event.eventId)},${sqlText(event.campaignId)},${sqlText(event.nodeId)},${sqlText(event.kind)},${sqlJson(event.payload)},${sqlText(event.eventHash)},${sqlText(event.createdAt)} WHERE changes()=1;`;
  }).join('\n');
  const campaignEventSql = events.noProgressCampaigns.map(({ event }) => (
    `INSERT OR IGNORE INTO campaign_events(event_id,campaign_id,node_id,kind,event_json,event_sha256,created_at) VALUES(${sqlText(event.eventId)},${sqlText(event.campaignId)},NULL,${sqlText(event.kind)},${sqlJson(event.payload)},${sqlText(event.eventHash)},${sqlText(event.createdAt)});`
  )).join('\n');
  const terminalNodeEventSql = events.terminalNodes.map(({ event }) => (
    `INSERT OR IGNORE INTO campaign_events(event_id,campaign_id,node_id,kind,event_json,event_sha256,created_at) VALUES(${sqlText(event.eventId)},${sqlText(event.campaignId)},${sqlText(event.nodeId)},${sqlText(event.kind)},${sqlJson(event.payload)},${sqlText(event.eventHash)},${sqlText(event.createdAt)});`
  )).join('\n');
  const result = store.execute(`BEGIN IMMEDIATE;
${recoverySql}
${plan.noProgressCampaigns.length ? `UPDATE paper_campaigns SET status='paused',current_phase='paused',stop_reason='reconciliation_no_progress_timeout',accumulated_run_ms=accumulated_run_ms+CASE WHEN last_resumed_at IS NULL THEN 0 ELSE max(0,CAST((julianday(${sqlText(reconciledAt)})-julianday(last_resumed_at))*86400000 AS INTEGER)) END,last_resumed_at=NULL,revision=revision+1,updated_at=${sqlText(reconciledAt)} WHERE campaign_id IN (${plan.noProgressCampaigns.map((campaign) => sqlText(campaign.campaign_id)).join(',')}) AND status='running';` : ''}
${campaignEventSql}
${plan.terminalCampaignQueuedNodes.length ? `UPDATE campaign_nodes SET status='skipped',failure_class='terminal_campaign_reconciled',failure_json=NULL,failure_sha256=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=${sqlText(reconciledAt)} WHERE node_id IN (${plan.terminalCampaignQueuedNodes.map((node) => sqlText(node.node_id)).join(',')}) AND status='queued' AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status IN ('failed','cancelled','stopped','completed'));` : ''}
${terminalNodeEventSql}
DELETE FROM automation_resource_leases WHERE expires_at<=${sqlText(reconciledAt)};
DELETE FROM automation_resource_waiters WHERE expires_at IS NOT NULL AND expires_at<=${sqlText(reconciledAt)};
${prepared.sql}
COMMIT;`);
  if (!result.ok) {
    throw new Error(result.error || result.stderr || 'automation_runtime_reconciliation_failed');
  }
}

export function executeAutomationRuntimeReconciliation({
  store, clock, receiptLedger, noProgressSeconds = 1800,
} = {}) {
  if (!receiptLedger?.prepare) throw new Error('Automation reconciliation requires atomic receipt ledger preparation');
  const plan = planAutomationRuntimeReconciliation({ store, clock, noProgressSeconds });
  const reconciledAt = clock.nowIso();
  const receiptPayload = {
    version: 2,
    kind: 'AutomationRuntimeReconciliationReceipt',
    status: 'automation_runtime_reconciled',
    reconciliationPlanHash: plan.reconciliationPlanHash,
    recoveredNodeCount: plan.expiredNodes.length,
    removedResourceLeaseCount: plan.expiredResourceLeases.length,
    removedWaiterCount: plan.expiredWaiters.length,
    pausedNoProgressCampaignCount: plan.noProgressCampaigns.length,
    closedTerminalCampaignQueuedNodeCount: plan.terminalCampaignQueuedNodes.length,
    recoveredNodeIds: plan.expiredNodes.map((row) => row.node_id),
    pausedNoProgressCampaignIds: plan.noProgressCampaigns.map((row) => row.campaign_id),
    closedTerminalCampaignQueuedNodeIds: plan.terminalCampaignQueuedNodes.map((row) => row.node_id),
    reconciledAt,
    workersStarted: false,
    externalActionPerformed: false,
  };
  const receiptHash = hashRecord('AutomationRuntimeReconciliationReceipt', receiptPayload);
  const prepared = receiptLedger.prepare({ ...receiptPayload, receiptHash }, {
    stream: 'automation-reconciliation',
    environment: 'administrative',
    evidenceClass: 'runtime_reconciliation',
    strictInsert: true,
  });
  const events = reconciliationEvents(plan, reconciledAt);
  if (typeof store.mutate === 'function') {
    const coordinated = store.mutate({
      databaseRole: 'native-store',
      operationId:
        'native-store.automation-runtime-reconciler.executeAutomationRuntimeReconciliation.v1',
      authorizationReceiptHashes: [],
      sideEffectReservationHashes: [],
      mutate: (transaction) => applyStrictReconciliation({
        transaction,
        plan,
        events,
        prepared,
        reconciledAt,
      }),
    });
    if (coordinated?.status !== 'externally_fenced_sqlite_mutation_finalized'
      || coordinated.value?.ledgerChanges !== 1) {
      throw new Error('automation_runtime_reconciliation_external_mutation_receipt_invalid');
    }
  } else {
    executeOfflineReconciliation({ store, plan, events, prepared, reconciledAt });
  }
  const after = planAutomationRuntimeReconciliation({ store, clock, noProgressSeconds });
  const { sql: _sql, ...ledgerReceipt } = prepared;
  return Object.freeze({ ...receiptPayload, receiptHash, ledgerReceipt, after });
}
