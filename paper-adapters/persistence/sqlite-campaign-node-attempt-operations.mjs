import { sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  decideNodeFailureTransition,
} from '../../paper-domain/automation/campaign-state-policy.mjs';
import {
  buildNativeStoreNodeInfrastructureReservation,
} from './native-store-campaign-mutation-plan.mjs';
import { buildSqliteCampaignProjectionStatement } from './sqlite-campaign-projection.mjs';
import { mapCampaignNodeRow as parseNode } from './sqlite-campaign-row-mappers.mjs';

export function createCampaignNodeAttemptOperations({
  store, clock, mutation, guarded, eventStatement, usageSql,
  usageBudgetCondition, getApi,
} = {}) {
  return {
    startNode({ nodeId, workerId, attemptId, leaseGeneration, usageDelta = {} } = {}) {
      if (!attemptId || !Number.isInteger(Number(leaseGeneration))) {
        throw new Error('campaign_node_attempt_fence_required');
      }
      const before = parseNode(store.query(
        `SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`,
      ).rows[0]);
      const now = clock.nowIso();
      if (before?.status === 'running' && before.leaseOwner === workerId
        && before.attemptId === attemptId
        && before.leaseGeneration === Number(leaseGeneration)
        && Date.parse(before.leaseExpiresAt || '') >= Date.parse(now)
        && getApi().getCampaign(before.campaignId)?.status === 'running') return before;
      if (!before) throw new Error(`campaign node not found: ${nodeId}`);
      const infrastructureReservation = buildNativeStoreNodeInfrastructureReservation({
        reservationId: `node-attempt:${attemptId}:base`,
        campaignId: before.campaignId,
        nodeId,
        attemptId,
        leaseGeneration,
        usageDelta,
      });
      const eventRow = eventStatement(before.campaignId, nodeId, 'campaign_node_started', {
        attempt: before.attemptCount + 1,
        workerId,
        attemptId,
        leaseGeneration: Number(leaseGeneration),
        infrastructureReservation,
      }, now);
      try {
        mutation({
          databaseRole: 'native-store',
          operationId: 'native-store.campaign-lease.startNode.v1',
          statements: [
            guarded(`UPDATE campaign_nodes SET status='running',attempt_count=attempt_count+1,node_revision=node_revision+1,updated_at=${sqlText(now)} WHERE node_id=${sqlText(nodeId)} AND status='leased' AND lease_owner=${sqlText(workerId)} AND attempt_id=${sqlText(attemptId)} AND lease_generation=${Number(leaseGeneration)} AND julianday(lease_expires_at)>=julianday(${sqlText(now)}) AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running');`),
            guarded(`UPDATE paper_campaigns SET current_phase=${sqlText(before.kind)},current_review_round=max(current_review_round,${Math.max(0, Number(before.roundIndex || 0))}),${usageSql(usageDelta)},revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(before.campaignId)} AND status='running' AND ${usageBudgetCondition(usageDelta)};`),
            eventRow.sql,
          ],
          fallback: 'campaign_node_start_failed',
          input: {
            before, now, nodeId, workerId, attemptId, leaseGeneration,
            usageDelta, eventRow,
          },
        });
      } catch (error) {
        if (error?.committed) throw error;
        const current = parseNode(store.query(
          `SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`,
        ).rows[0]);
        if (current?.status === 'leased' && current.leaseOwner === workerId
          && current.attemptId === attemptId
          && current.leaseGeneration === Number(leaseGeneration)) {
          throw new Error('campaign_node_budget_reservation_failed');
        }
        throw new Error('campaign_node_lease_lost');
      }
      return parseNode(store.query(
        `SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`,
      ).rows[0]);
    },

    failNode({
      nodeId, workerId, attemptId, leaseGeneration,
      failureClass = 'automation_node_failed', failureDetail = {},
      retryable = true, abandonPreparedResult = false, usageDelta = {},
    } = {}) {
      if (!attemptId || !Number.isInteger(Number(leaseGeneration))) {
        throw new Error('campaign_node_attempt_fence_required');
      }
      const node = parseNode(store.query(
        `SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`,
      ).rows[0]);
      if (!node) throw new Error(`campaign node not found: ${nodeId}`);
      const failureTransition = decideNodeFailureTransition(node, { retryable });
      const { status } = failureTransition;
      const now = clock.nowIso();
      const failureHash = hashRecord('PaperCampaignNodeFailure', failureDetail);
      const eventRow = eventStatement(
        node.campaignId,
        nodeId,
        failureTransition.eventKind,
        {
          failureClass, failureHash, attempt: node.attemptCount, attemptId,
          leaseGeneration: Number(leaseGeneration),
          preparedResultAbandoned: Boolean(abandonPreparedResult),
        },
        now,
      );
      const preparedReset = abandonPreparedResult
        ? ",prepared_result_json=NULL,prepared_result_sha256=NULL,prepared_attempt_id=NULL,prepared_at=NULL,prepared_requires_integration=0,prepared_integration_key=NULL,prepared_integration_status='none',prepared_integration_started_at=NULL,prepared_integration_receipt_json=NULL,prepared_integration_receipt_sha256=NULL,prepared_integrated_at=NULL"
        : ",prepared_integration_status=CASE WHEN prepared_integration_status='integrating' THEN 'pending' ELSE prepared_integration_status END,prepared_integration_started_at=CASE WHEN prepared_integration_status='integrating' THEN NULL ELSE prepared_integration_started_at END";
      try {
        mutation({
          databaseRole: 'native-store',
          operationId: 'native-store.campaign-lease.failNode.v1',
          statements: [
            guarded(`UPDATE campaign_nodes SET status=${sqlText(status)},failure_class=${sqlText(failureClass)},failure_json=${sqlJson(failureDetail)},failure_sha256=${sqlText(failureHash)},lease_owner=NULL,lease_expires_at=NULL,node_revision=node_revision+1${preparedReset},updated_at=${sqlText(now)} WHERE node_id=${sqlText(nodeId)} AND status='running' AND lease_owner=${sqlText(workerId)} AND attempt_id=${sqlText(attemptId)} AND lease_generation=${Number(leaseGeneration)} AND julianday(lease_expires_at)>=julianday(${sqlText(now)}) AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running');`),
            `UPDATE paper_campaigns SET ${usageSql(usageDelta)},updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(node.campaignId)} AND status='running';`,
            eventRow.sql,
            buildSqliteCampaignProjectionStatement({ campaignId: node.campaignId, now }),
          ],
          fallback: 'campaign_node_failure_failed',
          input: {
            node, now, nodeId, workerId, attemptId, leaseGeneration,
            status, failureClass, failureDetail, failureHash,
            abandonPreparedResult, usageDelta, eventRow,
          },
        });
      } catch (error) {
        if (error?.committed) throw error;
        throw new Error('campaign_node_lease_lost');
      }
      return parseNode(store.query(
        `SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`,
      ).rows[0]);
    },
  };
}
