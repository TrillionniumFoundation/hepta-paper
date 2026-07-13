import { sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function planAutomationRuntimeReconciliation({ store, clock, noProgressSeconds = 1800 } = {}) {
  if (!store || !clock) throw new Error('Automation reconciliation requires store and clock');
  const now = clock.nowIso();
  const noProgressCutoff = new Date(clock.now().getTime() - Math.max(60, Number(noProgressSeconds || 1800)) * 1000).toISOString();
  const expiredNodes = store.query(`SELECT node_id,campaign_id,status,lease_owner,lease_expires_at FROM campaign_nodes WHERE status IN ('leased','running') AND lease_expires_at IS NOT NULL AND lease_expires_at<=${sqlText(now)} ORDER BY campaign_id,node_id;`).rows;
  const expiredResourceLeases = store.query(`SELECT lease_id,scope,owner_id,campaign_id,node_id,expires_at FROM automation_resource_leases WHERE expires_at<=${sqlText(now)} ORDER BY lease_id;`).rows;
  const expiredWaiters = store.query(`SELECT waiter_id,scope,owner_id,campaign_id,node_id,expires_at FROM automation_resource_waiters WHERE expires_at IS NOT NULL AND expires_at<=${sqlText(now)} ORDER BY waiter_id;`).rows;
  const noProgressCampaigns = store.query(`SELECT c.campaign_id,c.paper_id,c.updated_at,c.current_phase,count(n.node_id) AS queued_node_count
    FROM paper_campaigns c
    JOIN campaign_nodes n ON n.campaign_id=c.campaign_id AND n.status='queued'
    WHERE c.status='running' AND c.updated_at<=${sqlText(noProgressCutoff)}
      AND NOT EXISTS(SELECT 1 FROM campaign_nodes active WHERE active.campaign_id=c.campaign_id AND active.status IN ('leased','running'))
    GROUP BY c.campaign_id,c.paper_id,c.updated_at,c.current_phase
    ORDER BY c.updated_at,c.campaign_id;`).rows;
  const payload = {
    version: 2,
    kind: 'AutomationRuntimeReconciliationPlan',
    status: expiredNodes.length || expiredResourceLeases.length || expiredWaiters.length || noProgressCampaigns.length
      ? 'automation_runtime_reconciliation_required'
      : 'automation_runtime_reconciliation_clean',
    plannedAt: now,
    expiredNodes,
    expiredResourceLeases,
    expiredWaiters,
    noProgressCutoff,
    noProgressCampaigns,
  };
  return Object.freeze({ ...payload, reconciliationPlanHash: hashRecord('AutomationRuntimeReconciliationPlan', payload) });
}

export function executeAutomationRuntimeReconciliation({ store, clock, receiptLedger, noProgressSeconds = 1800 } = {}) {
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
    recoveredNodeIds: plan.expiredNodes.map((row) => row.node_id),
    pausedNoProgressCampaignIds: plan.noProgressCampaigns.map((row) => row.campaign_id),
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
  const eventSql = plan.expiredNodes.map((node) => {
    const eventPayload = {
      version: 1,
      kind: 'campaign_node_lease_recovered',
      campaignId: node.campaign_id,
      nodeId: node.node_id,
      detail: { previousStatus: node.status, previousLeaseOwner: node.lease_owner, previousLeaseExpiresAt: node.lease_expires_at, reconciliationPlanHash: plan.reconciliationPlanHash },
      createdAt: reconciledAt,
    };
    const eventHash = hashRecord('PaperCampaignEvent', eventPayload);
    const eventId = `${node.campaign_id}:${reconciledAt}:${eventHash.slice(-16)}`;
    return `INSERT OR IGNORE INTO campaign_events(event_id,campaign_id,node_id,kind,event_json,event_sha256,created_at) VALUES(${sqlText(eventId)},${sqlText(node.campaign_id)},${sqlText(node.node_id)},'campaign_node_lease_recovered',${sqlJson(eventPayload)},${sqlText(eventHash)},${sqlText(reconciledAt)});`;
  }).join('\n');
  const campaignEventSql = plan.noProgressCampaigns.map((campaign) => {
    const eventPayload = {
      version: 1,
      kind: 'campaign_no_progress_paused',
      campaignId: campaign.campaign_id,
      nodeId: null,
      detail: {
        previousStatus: 'running',
        previousPhase: campaign.current_phase,
        previousUpdatedAt: campaign.updated_at,
        queuedNodeCount: Number(campaign.queued_node_count || 0),
        noProgressCutoff: plan.noProgressCutoff,
        reconciliationPlanHash: plan.reconciliationPlanHash,
      },
      createdAt: reconciledAt,
    };
    const eventHash = hashRecord('PaperCampaignEvent', eventPayload);
    const eventId = `${campaign.campaign_id}:${reconciledAt}:${eventHash.slice(-16)}`;
    return `INSERT OR IGNORE INTO campaign_events(event_id,campaign_id,node_id,kind,event_json,event_sha256,created_at) VALUES(${sqlText(eventId)},${sqlText(campaign.campaign_id)},NULL,'campaign_no_progress_paused',${sqlJson(eventPayload)},${sqlText(eventHash)},${sqlText(reconciledAt)});`;
  }).join('\n');
  const result = store.execute(`BEGIN IMMEDIATE;
${plan.expiredNodes.length ? `UPDATE campaign_nodes SET status='queued',lease_owner=NULL,lease_expires_at=NULL,failure_class='lease_expired_recovered',updated_at=${sqlText(reconciledAt)} WHERE node_id IN (${plan.expiredNodes.map((node) => sqlText(node.node_id)).join(',')}) AND status IN ('leased','running') AND lease_expires_at<=${sqlText(reconciledAt)};` : ''}
${eventSql}
${plan.noProgressCampaigns.length ? `UPDATE paper_campaigns SET status='paused',current_phase='paused',stop_reason='reconciliation_no_progress_timeout',accumulated_run_ms=accumulated_run_ms+CASE WHEN last_resumed_at IS NULL THEN 0 ELSE max(0,CAST((julianday(${sqlText(reconciledAt)})-julianday(last_resumed_at))*86400000 AS INTEGER)) END,last_resumed_at=NULL,revision=revision+1,updated_at=${sqlText(reconciledAt)} WHERE campaign_id IN (${plan.noProgressCampaigns.map((campaign) => sqlText(campaign.campaign_id)).join(',')}) AND status='running';` : ''}
${campaignEventSql}
DELETE FROM automation_resource_leases WHERE expires_at<=${sqlText(reconciledAt)};
DELETE FROM automation_resource_waiters WHERE expires_at IS NOT NULL AND expires_at<=${sqlText(reconciledAt)};
${prepared.sql}
COMMIT;`);
  if (!result.ok) throw new Error(result.error || result.stderr || 'automation_runtime_reconciliation_failed');
  const after = planAutomationRuntimeReconciliation({ store, clock, noProgressSeconds });
  const { sql: _sql, ...ledgerReceipt } = prepared;
  return Object.freeze({ ...receiptPayload, receiptHash, ledgerReceipt, after });
}
