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

function resolveReconciliationCampaignId(store, campaignId) {
  if (campaignId === undefined || campaignId === null) return null;
  if (typeof campaignId !== 'string' || !SAFE_CAMPAIGN_ID.test(campaignId)) {
    throw new Error('automation_runtime_reconciliation_campaign_id_invalid');
  }
  const rows = store.query(`SELECT campaign_id,
      CAST(coalesce(json_extract(spec_json,
        '$.terminalSiblingSettlementPolicyVersion'),0) AS INTEGER) AS policy_version
    FROM paper_campaigns WHERE campaign_id=${sqlText(campaignId)} LIMIT 2;`).rows;
  if (rows.length !== 1 || rows[0].campaign_id !== campaignId) {
    throw new Error('automation_runtime_reconciliation_campaign_scope_not_found');
  }
  if (Number(rows[0].policy_version) !== 1) {
    throw new Error('automation_runtime_reconciliation_campaign_scope_policy_unsupported');
  }
  return campaignId;
}

function assertReconciliationCampaignScope(campaignId, rowGroups) {
  if (!campaignId) return;
  for (const rows of rowGroups) {
    if (rows.some((row) => row.campaign_id !== campaignId)) {
      throw new Error('automation_runtime_reconciliation_campaign_scope_violated');
    }
  }
}

export function planAutomationRuntimeReconciliation({
  store: suppliedStore, clock, noProgressSeconds = 1800, campaignId = null,
} = {}) {
  if (!suppliedStore || !clock) throw new Error('Automation reconciliation requires store and clock');
  const store = failClosedStoreQueries(suppliedStore);
  const resolvedCampaignId = resolveReconciliationCampaignId(store, campaignId);
  const nodeScope = resolvedCampaignId
    ? ` AND n.campaign_id=${sqlText(resolvedCampaignId)}` : '';
  const campaignScope = resolvedCampaignId
    ? ` AND c.campaign_id=${sqlText(resolvedCampaignId)}` : '';
  const resourceScope = resolvedCampaignId
    ? ` AND campaign_id=${sqlText(resolvedCampaignId)}` : '';
  const now = clock.nowIso();
  const noProgressCutoff = new Date(clock.now().getTime() - Math.max(60, Number(noProgressSeconds || 1800)) * 1000).toISOString();
  const expiredNodes = store.query(`SELECT n.node_id,n.campaign_id,n.status,n.lease_owner,n.lease_expires_at,n.attempt_id,n.lease_generation,n.node_revision,
      c.revision AS campaign_revision
    FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id
    WHERE c.status='running' AND n.status IN ('leased','running')
      AND n.lease_expires_at IS NOT NULL
      AND julianday(n.lease_expires_at)<=julianday(${sqlText(now)})
      ${nodeScope}
    ORDER BY n.campaign_id,n.node_id;`).rows;
  const expiredResourceLeases = store.query(`SELECT lease_id,scope,owner_id,campaign_id,
      node_id,agent,cpu,gpu,memory_mib,acquired_at,renewed_at,expires_at
    FROM automation_resource_leases
    WHERE expires_at<=${sqlText(now)}${resourceScope} ORDER BY lease_id;`).rows;
  const expiredWaiters = store.query(`SELECT waiter_id,scope,owner_id,campaign_id,
      node_id,agent,cpu,gpu,memory_mib,requested_at,renewed_at,expires_at
    FROM automation_resource_waiters
    WHERE expires_at IS NOT NULL AND expires_at<=${sqlText(now)}${resourceScope}
    ORDER BY waiter_id;`).rows;
  const noProgressCampaigns = store.query(`SELECT c.campaign_id,c.paper_id,c.updated_at,
      c.current_phase,c.revision,count(n.node_id) AS queued_node_count
    FROM paper_campaigns c
    JOIN campaign_nodes n ON n.campaign_id=c.campaign_id AND n.status='queued'
    WHERE c.status='running' AND c.updated_at<=${sqlText(noProgressCutoff)}
      ${campaignScope}
      AND NOT EXISTS(SELECT 1 FROM campaign_nodes active WHERE active.campaign_id=c.campaign_id AND active.status IN ('leased','running'))
    GROUP BY c.campaign_id,c.paper_id,c.updated_at,c.current_phase,c.revision
    ORDER BY c.updated_at,c.campaign_id;`).rows;
  const terminalCampaignQueuedNodes = store.query(`SELECT n.node_id,n.campaign_id,
      n.node_revision,c.status AS campaign_status,c.stop_reason,
      c.revision AS campaign_revision
    FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id
    WHERE n.status='queued' AND c.status IN ('failed','cancelled','stopped','completed')
      AND CAST(coalesce(json_extract(c.spec_json,
        '$.terminalSiblingSettlementPolicyVersion'),0) AS INTEGER)=1
      ${nodeScope}
    ORDER BY n.campaign_id,n.node_id;`).rows;
  const terminalCampaignActiveNodes = store.query(`SELECT n.node_id,n.campaign_id,
      n.status,n.lease_owner,n.lease_expires_at,n.attempt_id,n.lease_generation,
      n.node_revision,n.prepared_integration_status,
      c.status AS campaign_status,c.stop_reason,c.revision AS campaign_revision
    FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id
    WHERE n.status IN ('leased','running')
      AND c.status IN ('failed','cancelled','stopped','completed')
      AND CAST(coalesce(json_extract(c.spec_json,
        '$.terminalSiblingSettlementPolicyVersion'),0) AS INTEGER)=1
      ${nodeScope}
    ORDER BY n.campaign_id,n.node_id;`).rows;
  const preservedLegacyTerminalNodes = store.query(`SELECT n.node_id,n.campaign_id,
      n.status,n.lease_owner,n.lease_expires_at,n.attempt_id,n.lease_generation,
      n.node_revision,n.prepared_integration_status,
      c.status AS campaign_status,c.stop_reason
    FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id
    WHERE n.status IN ('queued','leased','running')
      AND c.status IN ('failed','cancelled','stopped','completed')
      AND CAST(coalesce(json_extract(c.spec_json,
        '$.terminalSiblingSettlementPolicyVersion'),0) AS INTEGER)<>1
      ${nodeScope}
    ORDER BY n.campaign_id,n.node_id;`).rows;
  assertReconciliationCampaignScope(resolvedCampaignId, [
    expiredNodes,
    expiredResourceLeases,
    expiredWaiters,
    noProgressCampaigns,
    terminalCampaignQueuedNodes,
    terminalCampaignActiveNodes,
    preservedLegacyTerminalNodes,
  ]);
  const reconciliationRequired = expiredNodes.length || expiredResourceLeases.length
    || expiredWaiters.length || noProgressCampaigns.length
    || terminalCampaignQueuedNodes.length || terminalCampaignActiveNodes.length;
  const payload = {
    version: 2,
    kind: 'AutomationRuntimeReconciliationPlan',
    ...(resolvedCampaignId ? { campaignId: resolvedCampaignId } : {}),
    status: reconciliationRequired
      ? 'automation_runtime_reconciliation_required'
      : preservedLegacyTerminalNodes.length
        ? 'automation_runtime_reconciliation_legacy_terminal_evidence_preserved'
      : 'automation_runtime_reconciliation_clean',
    plannedAt: now,
    expiredNodes,
    expiredResourceLeases,
    expiredWaiters,
    noProgressCutoff,
    noProgressCampaigns,
    terminalCampaignQueuedNodes,
    terminalCampaignActiveNodes,
    preservedLegacyTerminalNodes,
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

function terminalActiveNodeSettlement(node, plan, reconciledAt) {
  const integrationStatus = String(node.prepared_integration_status || 'none');
  const outcomeUncertain = ['integrating', 'integrated'].includes(integrationStatus);
  const status = outcomeUncertain ? 'external_outcome_uncertain' : 'skipped';
  const failureClass = outcomeUncertain
    ? 'campaign_terminal_sibling_outcome_uncertain'
    : 'campaign_terminal_sibling_cancelled';
  const failureDetail = Object.freeze({
    reason: failureClass,
    campaignStatus: node.campaign_status,
    campaignStopReason: node.stop_reason || null,
    previousStatus: node.status,
    previousLeaseOwner: node.lease_owner || null,
    previousLeaseExpiresAt: node.lease_expires_at || null,
    previousAttemptId: node.attempt_id || null,
    previousLeaseGeneration: Number(node.lease_generation || 0),
    previousNodeRevision: Number(node.node_revision || 0),
    preparedIntegrationStatus: integrationStatus,
    reconciliationPlanHash: plan.reconciliationPlanHash,
  });
  const failureHash = hashRecord('PaperCampaignNodeFailure', failureDetail);
  return Object.freeze({
    node,
    status,
    failureClass,
    failureDetail,
    failureHash,
    event: campaignEvent({
      kind: 'campaign_terminal_active_child_settled',
      campaignId: node.campaign_id,
      nodeId: node.node_id,
      detail: {
        status,
        failureClass,
        failureHash,
        ...failureDetail,
      },
      createdAt: reconciledAt,
    }),
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
  const terminalActiveNodes = plan.terminalCampaignActiveNodes.map((node) => (
    terminalActiveNodeSettlement(node, plan, reconciledAt)
  ));
  return Object.freeze({
    recoveredNodes,
    noProgressCampaigns,
    terminalNodes,
    terminalActiveNodes,
  });
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
  for (const settlement of events.terminalActiveNodes) {
    const { node, event } = settlement;
    const closed = transaction.run(
      S.closeTerminalActiveNode,
      settlement.status,
      settlement.failureClass,
      JSON.stringify(settlement.failureDetail),
      settlement.failureHash,
      reconciledAt,
      node.node_id,
      node.campaign_id,
      node.status,
      node.lease_owner || null,
      node.lease_owner || null,
      node.attempt_id || null,
      node.attempt_id || null,
      Number(node.lease_generation || 0),
      Number(node.node_revision || 0),
      String(node.prepared_integration_status || 'none'),
    );
    if (closed.changes !== 1) {
      throw new Error(
        'automation_runtime_reconciliation_terminal_active_node_precondition_failed',
      );
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
    plan.campaignId
      ? S.deleteExpiredResourceLeasesForCampaign : S.deleteExpiredResourceLeases,
    reconciledAt,
    ...(plan.campaignId ? [plan.campaignId] : []),
  ).changes;
  const removedWaiters = transaction.run(
    plan.campaignId
      ? S.deleteExpiredResourceWaitersForCampaign : S.deleteExpiredResourceWaiters,
    reconciledAt,
    ...(plan.campaignId ? [plan.campaignId] : []),
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
    closedTerminalActiveNodeCount: events.terminalActiveNodes.length,
    closedTerminalNodeCount: events.terminalNodes.length,
    removedResourceLeaseCount: removedResourceLeases,
    removedWaiterCount: removedWaiters,
  });
}

const OFFLINE_RECONCILIATION_GUARD_TABLE =
  'automation_runtime_reconciliation_exactly_one_guard';

function nullableSqlCondition(column, value) {
  return value === null || value === undefined
    ? `${column} IS NULL`
    : `${column}=${sqlText(value)}`;
}

function offlineExactlyOneGuardSql() {
  return `INSERT INTO temp.${OFFLINE_RECONCILIATION_GUARD_TABLE}(exactly_one)
    VALUES(changes());
DELETE FROM temp.${OFFLINE_RECONCILIATION_GUARD_TABLE};`;
}

function offlineExactMutationSql(statement) {
  return `${statement};
${offlineExactlyOneGuardSql()}`;
}

function offlineExactEventSql(event) {
  return offlineExactMutationSql(`INSERT INTO campaign_events(
    event_id,campaign_id,node_id,kind,event_json,event_sha256,created_at
  ) VALUES(${sqlText(event.eventId)},${sqlText(event.campaignId)},${event.nodeId
    ? sqlText(event.nodeId) : 'NULL'},${sqlText(event.kind)},${sqlJson(event.payload)},${sqlText(event.eventHash)},${sqlText(event.createdAt)})`);
}

function executeOfflineReconciliation({ store, plan, events, prepared, reconciledAt }) {
  const recoverySql = events.recoveredNodes.map(({ node, event }) => {
    const attemptCondition = node.attempt_id
      ? `attempt_id=${sqlText(node.attempt_id)}` : 'attempt_id IS NULL';
    const ownerCondition = node.lease_owner
      ? `lease_owner=${sqlText(node.lease_owner)}` : 'lease_owner IS NULL';
    const update = `UPDATE campaign_nodes SET status='queued',lease_owner=NULL,
      lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,
      failure_class='lease_expired_recovered',updated_at=${sqlText(reconciledAt)}
      WHERE node_id=${sqlText(node.node_id)}
        AND campaign_id=${sqlText(node.campaign_id)}
        AND status=${sqlText(node.status)} AND ${ownerCondition} AND ${attemptCondition}
        AND lease_generation=${Number(node.lease_generation || 0)}
        AND node_revision=${Number(node.node_revision || 0)}
        AND lease_expires_at=${sqlText(node.lease_expires_at)}
        AND julianday(lease_expires_at)<=julianday(${sqlText(reconciledAt)})
        AND EXISTS(SELECT 1 FROM paper_campaigns c
          WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running'
            AND c.revision=${Number(node.campaign_revision)})`;
    return `${offlineExactMutationSql(update)}
${offlineExactEventSql(event)}`;
  }).join('\n');
  const noProgressSql = events.noProgressCampaigns.map(({ campaign, event }) => {
    const update = `UPDATE paper_campaigns SET status='paused',current_phase='paused',
      stop_reason='reconciliation_no_progress_timeout',
      accumulated_run_ms=accumulated_run_ms+CASE WHEN last_resumed_at IS NULL THEN 0
        ELSE max(0,CAST((julianday(${sqlText(reconciledAt)})-julianday(last_resumed_at))*86400000 AS INTEGER)) END,
      last_resumed_at=NULL,revision=revision+1,updated_at=${sqlText(reconciledAt)}
      WHERE campaign_id=${sqlText(campaign.campaign_id)} AND paper_id=${sqlText(campaign.paper_id)}
        AND status='running' AND revision=${Number(campaign.revision)}
        AND updated_at=${sqlText(campaign.updated_at)}
        AND ${nullableSqlCondition('current_phase', campaign.current_phase)}
        AND updated_at<=${sqlText(plan.noProgressCutoff)}
        AND (SELECT count(*) FROM campaign_nodes queued
          WHERE queued.campaign_id=paper_campaigns.campaign_id
            AND queued.status='queued')=${Number(campaign.queued_node_count || 0)}
        AND NOT EXISTS(SELECT 1 FROM campaign_nodes active
          WHERE active.campaign_id=paper_campaigns.campaign_id
            AND active.status IN ('leased','running'))`;
    return `${offlineExactMutationSql(update)}
${offlineExactEventSql(event)}`;
  }).join('\n');
  const terminalActiveNodeSql = events.terminalActiveNodes.map((settlement) => {
    const { node, event } = settlement;
    const ownerCondition = node.lease_owner
      ? `lease_owner=${sqlText(node.lease_owner)}` : 'lease_owner IS NULL';
    const attemptCondition = node.attempt_id
      ? `attempt_id=${sqlText(node.attempt_id)}` : 'attempt_id IS NULL';
    const update = `UPDATE campaign_nodes SET status=${sqlText(settlement.status)},
      failure_class=${sqlText(settlement.failureClass)},
      failure_json=${sqlJson(settlement.failureDetail)},
      failure_sha256=${sqlText(settlement.failureHash)},lease_owner=NULL,
      lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,
      updated_at=${sqlText(reconciledAt)} WHERE node_id=${sqlText(node.node_id)}
        AND campaign_id=${sqlText(node.campaign_id)} AND status=${sqlText(node.status)}
        AND ${ownerCondition} AND ${attemptCondition}
        AND ${nullableSqlCondition('lease_expires_at', node.lease_expires_at)}
        AND lease_generation=${Number(node.lease_generation || 0)}
        AND node_revision=${Number(node.node_revision || 0)}
        AND prepared_integration_status=${sqlText(node.prepared_integration_status || 'none')}
        AND EXISTS(SELECT 1 FROM paper_campaigns c
          WHERE c.campaign_id=campaign_nodes.campaign_id
            AND c.status=${sqlText(node.campaign_status)}
            AND c.revision=${Number(node.campaign_revision)}
            AND ${nullableSqlCondition('c.stop_reason', node.stop_reason)}
            AND CAST(coalesce(json_extract(c.spec_json,
              '$.terminalSiblingSettlementPolicyVersion'),0) AS INTEGER)=1)`;
    return `${offlineExactMutationSql(update)}
${offlineExactEventSql(event)}`;
  }).join('\n');
  const terminalNodeSql = events.terminalNodes.map(({ node, event }) => {
    const update = `UPDATE campaign_nodes SET status='skipped',
      failure_class='terminal_campaign_reconciled',failure_json=NULL,
      failure_sha256=NULL,lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,
      node_revision=node_revision+1,updated_at=${sqlText(reconciledAt)}
      WHERE node_id=${sqlText(node.node_id)} AND campaign_id=${sqlText(node.campaign_id)}
        AND status='queued' AND node_revision=${Number(node.node_revision || 0)}
        AND EXISTS(SELECT 1 FROM paper_campaigns c
          WHERE c.campaign_id=campaign_nodes.campaign_id
            AND c.status=${sqlText(node.campaign_status)}
            AND c.revision=${Number(node.campaign_revision)}
            AND ${nullableSqlCondition('c.stop_reason', node.stop_reason)}
            AND CAST(coalesce(json_extract(c.spec_json,
              '$.terminalSiblingSettlementPolicyVersion'),0) AS INTEGER)=1)`;
    return `${offlineExactMutationSql(update)}
${offlineExactEventSql(event)}`;
  }).join('\n');
  const resourceLeaseSql = plan.expiredResourceLeases.map((lease) => (
    offlineExactMutationSql(`DELETE FROM automation_resource_leases
      WHERE lease_id=${sqlText(lease.lease_id)} AND scope=${sqlText(lease.scope)}
        AND owner_id=${sqlText(lease.owner_id)}
        AND ${nullableSqlCondition('campaign_id', lease.campaign_id)}
        AND ${nullableSqlCondition('node_id', lease.node_id)}
        AND agent=${Number(lease.agent)} AND cpu=${Number(lease.cpu)}
        AND gpu=${Number(lease.gpu)} AND memory_mib=${Number(lease.memory_mib)}
        AND acquired_at=${sqlText(lease.acquired_at)}
        AND renewed_at=${sqlText(lease.renewed_at)}
        AND expires_at=${sqlText(lease.expires_at)}
        AND expires_at<=${sqlText(reconciledAt)}`)
  )).join('\n');
  const resourceWaiterSql = plan.expiredWaiters.map((waiter) => (
    offlineExactMutationSql(`DELETE FROM automation_resource_waiters
      WHERE waiter_id=${sqlText(waiter.waiter_id)} AND scope=${sqlText(waiter.scope)}
        AND owner_id=${sqlText(waiter.owner_id)}
        AND ${nullableSqlCondition('campaign_id', waiter.campaign_id)}
        AND ${nullableSqlCondition('node_id', waiter.node_id)}
        AND agent=${Number(waiter.agent)} AND cpu=${Number(waiter.cpu)}
        AND gpu=${Number(waiter.gpu)} AND memory_mib=${Number(waiter.memory_mib)}
        AND requested_at=${sqlText(waiter.requested_at)}
        AND renewed_at=${sqlText(waiter.renewed_at)}
        AND expires_at=${sqlText(waiter.expires_at)}
        AND expires_at<=${sqlText(reconciledAt)}`)
  )).join('\n');
  const result = store.execute(`BEGIN IMMEDIATE;
CREATE TEMP TABLE IF NOT EXISTS ${OFFLINE_RECONCILIATION_GUARD_TABLE}(
  exactly_one INTEGER NOT NULL CHECK(exactly_one=1)
);
DELETE FROM temp.${OFFLINE_RECONCILIATION_GUARD_TABLE};
${recoverySql}
${noProgressSql}
${terminalActiveNodeSql}
${terminalNodeSql}
${resourceLeaseSql}
${resourceWaiterSql}
${prepared.sql}
${offlineExactlyOneGuardSql()}
DROP TABLE temp.${OFFLINE_RECONCILIATION_GUARD_TABLE};
COMMIT;`);
  if (!result.ok) {
    throw new Error(result.error || result.stderr || 'automation_runtime_reconciliation_failed');
  }
}

export function executeAutomationRuntimeReconciliation({
  store, clock, receiptLedger, noProgressSeconds = 1800, campaignId = null,
} = {}) {
  if (!receiptLedger?.prepare) throw new Error('Automation reconciliation requires atomic receipt ledger preparation');
  const plan = planAutomationRuntimeReconciliation({
    store, clock, noProgressSeconds, campaignId,
  });
  const reconciledAt = clock.nowIso();
  const receiptPayload = {
    version: 2,
    kind: 'AutomationRuntimeReconciliationReceipt',
    status: 'automation_runtime_reconciled',
    ...(plan.campaignId ? { campaignId: plan.campaignId } : {}),
    reconciliationPlanHash: plan.reconciliationPlanHash,
    recoveredNodeCount: plan.expiredNodes.length,
    removedResourceLeaseCount: plan.expiredResourceLeases.length,
    removedWaiterCount: plan.expiredWaiters.length,
    pausedNoProgressCampaignCount: plan.noProgressCampaigns.length,
    closedTerminalCampaignQueuedNodeCount: plan.terminalCampaignQueuedNodes.length,
    closedTerminalCampaignActiveNodeCount: plan.terminalCampaignActiveNodes.length,
    preservedLegacyTerminalNodeCount: plan.preservedLegacyTerminalNodes.length,
    recoveredNodeIds: plan.expiredNodes.map((row) => row.node_id),
    pausedNoProgressCampaignIds: plan.noProgressCampaigns.map((row) => row.campaign_id),
    closedTerminalCampaignQueuedNodeIds: plan.terminalCampaignQueuedNodes.map((row) => row.node_id),
    closedTerminalCampaignActiveNodeIds:
      plan.terminalCampaignActiveNodes.map((row) => row.node_id),
    preservedLegacyTerminalNodeIds:
      plan.preservedLegacyTerminalNodes.map((row) => row.node_id),
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
  const after = planAutomationRuntimeReconciliation({
    store, clock, noProgressSeconds, campaignId: plan.campaignId || null,
  });
  const { sql: _sql, ...ledgerReceipt } = prepared;
  return Object.freeze({ ...receiptPayload, receiptHash, ledgerReceipt, after });
}
