import { sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  CAMPAIGN_NODE_DONE_STATUSES,
  cascadeCancelledNodeIds,
  decideCampaignCommand,
  decideManualNodeRetry,
} from '../../paper-domain/automation/campaign-state-policy.mjs';
import { buildSqliteCampaignProjectionStatement } from './sqlite-campaign-projection.mjs';
import { mapCampaignNodeRow as parseNode } from './sqlite-campaign-row-mappers.mjs';

const DONE = new Set(CAMPAIGN_NODE_DONE_STATUSES);

export function createCampaignLifecycleTerminalOperations({
  store, clock, mutation, guarded, eventStatement, usageSql,
  usageBudgetCondition, getApi,
} = {}) {
  return {
    cancelNode(nodeId, reason = 'operator_node_cancelled') {
      const node = parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
      if (!node) throw new Error(`campaign node not found: ${nodeId}`);
      if (DONE.has(node.status) || node.status === 'failed_terminal') return node;
      const nodes = getApi().listNodes(node.campaignId);
      const cancelled = new Set(cascadeCancelledNodeIds(nodes, nodeId));
      const now = clock.nowIso();
      const ids = [...cancelled].map(sqlText).join(',');
      const failureDetail = { reason, rootNodeId: nodeId };
      const failureHash = hashRecord('PaperCampaignNodeFailure', failureDetail);
      const packageNode = nodes.find((candidate) => candidate.kind === 'package');
      const campaign = getApi().getCampaign(node.campaignId);
      const eventRow = eventStatement(node.campaignId, nodeId, 'campaign_node_cancelled', { reason, skippedNodeIds: [...cancelled].sort() }, now);
      const statements = [
        guarded(`UPDATE paper_campaigns SET revision=revision WHERE campaign_id=${sqlText(node.campaignId)} AND NOT EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.node_id IN (${ids}) AND n.status<>'completed' AND n.prepared_integration_status IN ('integrating','integrated'));`),
        `UPDATE campaign_nodes SET status='skipped',failure_class=${sqlText(reason)},failure_json=${sqlJson(failureDetail)},failure_sha256=${sqlText(failureHash)},lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,updated_at=${sqlText(now)} WHERE node_id IN (${ids}) AND status IN ('queued','leased','running');`,
        eventRow.sql,
      ];
      let stoppedEvent = null;
      if (packageNode && cancelled.has(packageNode.nodeId) && campaign?.status === 'running') {
        statements.push(guarded(`UPDATE paper_campaigns SET status='stopped',stop_reason='operator_node_cancelled_required_path',accumulated_run_ms=accumulated_run_ms+CASE WHEN last_resumed_at IS NULL THEN 0 ELSE max(0,CAST((julianday(${sqlText(now)})-julianday(last_resumed_at))*86400000 AS INTEGER)) END,last_resumed_at=NULL,revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(node.campaignId)} AND status='running' AND revision=${campaign.revision};`));
        stoppedEvent = eventStatement(node.campaignId, null, 'campaign_stopped', { reason: 'operator_node_cancelled_required_path' }, now);
        statements.push(stoppedEvent.sql);
      } else {
        statements.push(buildSqliteCampaignProjectionStatement({ campaignId: node.campaignId, now }));
      }
      mutation({
        databaseRole: 'native-store',
        operationId: 'native-store.campaign-lifecycle.cancelNode.v1',
        statements,
        fallback: 'campaign_node_cancel_failed',
        input: {
          node, campaign, cancelled: [...cancelled], failureDetail, failureHash,
          reason, now, eventRow, stoppedEvent,
        },
      });
      return parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
    },
    retryNode(nodeId) {
      const node = parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
      if (!node) throw new Error(`campaign node not found: ${nodeId}`);
      if (!decideManualNodeRetry(node).apply) return node;
      const now = clock.nowIso();
      const campaign = getApi().getCampaign(node.campaignId);
      const eventRow = eventStatement(node.campaignId, nodeId, 'campaign_node_manually_retried', {}, now);
      mutation({
        databaseRole: 'native-store',
        operationId: 'native-store.campaign-lifecycle.retryNode.v1',
        statements: [
          guarded(`UPDATE campaign_nodes SET status='queued',attempt_count=0,failure_class=NULL,failure_json=NULL,failure_sha256=NULL,lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,prepared_result_json=CASE WHEN prepared_integration_status='integrated' THEN prepared_result_json ELSE NULL END,prepared_result_sha256=CASE WHEN prepared_integration_status='integrated' THEN prepared_result_sha256 ELSE NULL END,prepared_attempt_id=CASE WHEN prepared_integration_status='integrated' THEN prepared_attempt_id ELSE NULL END,prepared_at=CASE WHEN prepared_integration_status='integrated' THEN prepared_at ELSE NULL END,prepared_requires_integration=CASE WHEN prepared_integration_status='integrated' THEN prepared_requires_integration ELSE 0 END,prepared_integration_key=CASE WHEN prepared_integration_status='integrated' THEN prepared_integration_key ELSE NULL END,prepared_integration_status=CASE WHEN prepared_integration_status='integrated' THEN 'integrated' ELSE 'none' END,prepared_integration_started_at=CASE WHEN prepared_integration_status='integrated' THEN prepared_integration_started_at ELSE NULL END,prepared_integration_receipt_json=CASE WHEN prepared_integration_status='integrated' THEN prepared_integration_receipt_json ELSE NULL END,prepared_integration_receipt_sha256=CASE WHEN prepared_integration_status='integrated' THEN prepared_integration_receipt_sha256 ELSE NULL END,prepared_integrated_at=CASE WHEN prepared_integration_status='integrated' THEN prepared_integrated_at ELSE NULL END,node_revision=node_revision+1,updated_at=${sqlText(now)} WHERE node_id=${sqlText(nodeId)} AND status='failed_terminal' AND node_revision=${node.nodeRevision};`),
          guarded(`UPDATE paper_campaigns SET status='running',current_phase=${sqlText(node.kind)},current_review_round=max(current_review_round,${Math.max(0, Number(node.roundIndex || 0))}),stop_reason=NULL,last_resumed_at=coalesce(last_resumed_at,${sqlText(now)}),revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(node.campaignId)} AND status=${sqlText(campaign.status)} AND revision=${campaign.revision};`),
          eventRow.sql,
        ],
        fallback: 'campaign_node_retry_failed',
        input: { node, campaign, now, eventRow },
      });
      return parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
    },
    recordUsage(campaignId, delta = {}, { enforceBudget = false } = {}) {
      const now = clock.nowIso();
      const statements = enforceBudget
        ? [guarded(`UPDATE paper_campaigns SET ${usageSql(delta)},updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status='running' AND ${usageBudgetCondition(delta)};`)]
        : [`UPDATE paper_campaigns SET ${usageSql(delta)},updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status='running';`];
      try {
        mutation({
          databaseRole: 'native-store',
          operationId: 'native-store.campaign-lifecycle.recordUsage.v1',
          statements,
          fallback: enforceBudget ? 'campaign_usage_budget_reservation_failed' : 'campaign_usage_write_failed',
          input: { campaignId, delta, now, enforceBudget, required: enforceBudget },
        });
      } catch (error) {
        if (error?.committed) throw error;
        throw new Error(enforceBudget
          ? 'campaign_usage_budget_reservation_failed' : 'campaign_usage_write_failed');
      }
      return getApi().getCampaign(campaignId);
    },
    failCampaign(campaignId, reason = 'campaign_failed') {
      return terminalCampaign({
        campaignId,
        reason,
        status: 'failed',
        getApi,
        clock,
        guarded,
        eventStatement,
      }, (payload) => mutation({
          databaseRole: 'native-store',
          operationId: 'native-store.campaign-lifecycle.failCampaign.v1',
          ...payload,
        }));
    },
    stopCampaign(campaignId, reason = 'campaign_stopped') {
      return terminalCampaign({
        campaignId,
        reason,
        status: 'stopped',
        getApi,
        clock,
        guarded,
        eventStatement,
      }, (payload) => mutation({
          databaseRole: 'native-store',
          operationId: 'native-store.campaign-lifecycle.stopCampaign.v1',
          ...payload,
        }));
    },
  };
}

function terminalCampaign({
  campaignId,
  reason,
  status,
  getApi,
  clock,
  guarded,
  eventStatement,
}, executeMutation) {
  const campaign = getApi().getCampaign(campaignId);
  if (!campaign) throw new Error(`campaign not found: ${campaignId}`);
  const command = status === 'failed' ? 'fail' : 'stop';
  if (!decideCampaignCommand(campaign, command).apply) return campaign;
  const now = clock.nowIso();
  const elapsedSql = campaign.lastResumedAt ? `accumulated_run_ms=accumulated_run_ms+max(0,CAST((julianday(${sqlText(now)})-julianday(last_resumed_at))*86400000 AS INTEGER)),` : '';
  const eventRow = eventStatement(campaignId, null, `campaign_${status}`, { reason }, now);
  executeMutation({
    statements: [
      guarded(`UPDATE paper_campaigns SET ${elapsedSql}status=${sqlText(status)},stop_reason=${sqlText(reason)},last_resumed_at=NULL,revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status=${sqlText(campaign.status)} AND revision=${campaign.revision} AND NOT EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status<>'completed' AND n.prepared_integration_status IN ('integrating','integrated'));`),
      `UPDATE campaign_nodes SET status=${sqlText(status === 'failed' ? 'failed_terminal' : 'skipped')},failure_class=${sqlText(reason)},lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status IN ('queued','leased','running');`,
      eventRow.sql,
    ],
    fallback: status === 'failed' ? 'campaign_fail_failed' : 'campaign_stop_failed',
    input: { campaign, now, reason, campaignId, eventRow },
  });
  return getApi().getCampaign(campaignId);
}
