import crypto from 'node:crypto';
import { sqlText } from '../../paper-ports/store-port.mjs';
import {
  buildNativeStoreNodeInfrastructureReservation,
} from './native-store-campaign-mutation-plan.mjs';
import {
  infrastructureControlError,
  refundableNodeInfrastructureReservation,
} from './sqlite-campaign-node-infrastructure-reservations.mjs';
import { mapCampaignNodeRow as parseNode } from './sqlite-campaign-row-mappers.mjs';
import {
  createCampaignNodeExternalActionOperations,
} from './sqlite-campaign-node-external-action-operations.mjs';

function createCampaignNodeInfrastructureReservationOperations({
  store, clock, mutation, guarded, eventStatement, usageSql, usageBudgetCondition,
} = {}) {
  return Object.freeze({
    cancelNodeInfrastructureDeferred({
      nodeId, workerId, attemptId, leaseGeneration,
    } = {}) {
      if (!attemptId || !Number.isInteger(Number(leaseGeneration))) {
        throw new Error('campaign_node_attempt_fence_required');
      }
      const node = parseNode(store.query(
        `SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`,
      ).rows[0]);
      const now = clock.nowIso();
      if (!node || node.status !== 'running' || node.leaseOwner !== workerId
        || node.attemptId !== attemptId
        || node.leaseGeneration !== Number(leaseGeneration)
        || node.preparedResultHash) {
        throw new Error('campaign_node_infrastructure_cancel_fence_lost');
      }
      const identity = Object.freeze({
        campaignId: node.campaignId,
        nodeId,
        attemptId,
        leaseGeneration: Number(leaseGeneration),
      });
      const refund = refundableNodeInfrastructureReservation(store, identity);
      const eventRow = eventStatement(
        node.campaignId,
        nodeId,
        'campaign_node_infrastructure_deferred',
        {
          attempt: node.attemptCount,
          workerId,
          attemptId,
          leaseGeneration: Number(leaseGeneration),
          budgetReservationRefunded: true,
          refundedUsage: refund,
          externalActionPerformed: false,
        },
        now,
      );
      try {
        mutation({
          databaseRole: 'native-store',
          operationId: 'native-store.campaign-lease.cancelNodeInfrastructureDeferred.v1',
          statements: [
            guarded(`UPDATE campaign_nodes SET status='queued',attempt_count=attempt_count-1,lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,failure_class=NULL,failure_json=NULL,failure_sha256=NULL,node_revision=node_revision+1,updated_at=${sqlText(now)} WHERE node_id=${sqlText(nodeId)} AND status='running' AND lease_owner=${sqlText(workerId)} AND attempt_id=${sqlText(attemptId)} AND lease_generation=${Number(leaseGeneration)} AND attempt_count=${Number(node.attemptCount)} AND attempt_count>0 AND prepared_result_sha256 IS NULL AND NOT EXISTS(SELECT 1 FROM campaign_events e WHERE e.campaign_id=campaign_nodes.campaign_id AND e.node_id=campaign_nodes.node_id AND e.kind='campaign_node_external_action_started' AND json_extract(e.event_json,'$.detail.attemptId')=campaign_nodes.attempt_id AND CAST(json_extract(e.event_json,'$.detail.leaseGeneration') AS INTEGER)=campaign_nodes.lease_generation) AND julianday(lease_expires_at)>=julianday(${sqlText(now)}) AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running');`),
            guarded(`UPDATE paper_campaigns SET agent_call_count=agent_call_count-${refund.agentCalls},cpu_job_count=cpu_job_count-${refund.cpuJobs},gpu_job_count=gpu_job_count-${refund.gpuJobs},revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(node.campaignId)} AND status='running' AND agent_call_count>=${refund.agentCalls} AND cpu_job_count>=${refund.cpuJobs} AND gpu_job_count>=${refund.gpuJobs};`),
            eventRow.sql,
          ],
          fallback: 'campaign_node_infrastructure_cancel_failed',
          input: {
            node, now, nodeId, workerId, attemptId, leaseGeneration,
            refund, eventRow,
          },
        });
      } catch (error) {
        if (infrastructureControlError(error)) throw error;
        throw new Error('campaign_node_infrastructure_cancel_fence_lost');
      }
      return parseNode(store.query(
        `SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`,
      ).rows[0]);
    },

    reserveNodeInfrastructureUsage({
      nodeId, workerId, attemptId, leaseGeneration, usageDelta = {},
    } = {}) {
      if (!attemptId || !Number.isInteger(Number(leaseGeneration))) {
        throw new Error('campaign_node_attempt_fence_required');
      }
      const node = parseNode(store.query(
        `SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`,
      ).rows[0]);
      const now = clock.nowIso();
      if (!node || node.status !== 'running' || node.leaseOwner !== workerId
        || node.attemptId !== attemptId
        || node.leaseGeneration !== Number(leaseGeneration)
        || node.preparedResultHash) {
        throw new Error('campaign_node_infrastructure_reservation_fence_lost');
      }
      const reservation = buildNativeStoreNodeInfrastructureReservation({
        reservationId: `node-subreservation:${crypto.randomUUID()}`,
        campaignId: node.campaignId,
        nodeId,
        attemptId,
        leaseGeneration,
        usageDelta,
      });
      const eventRow = eventStatement(
        node.campaignId,
        nodeId,
        'campaign_node_infrastructure_subreservation',
        {
          workerId,
          attemptId,
          leaseGeneration: Number(leaseGeneration),
          infrastructureReservation: reservation,
        },
        now,
      );
      try {
        mutation({
          databaseRole: 'native-store',
          operationId: 'native-store.campaign-lease.reserveNodeInfrastructureUsage.v1',
          statements: [
            guarded(`UPDATE campaign_nodes SET node_revision=node_revision WHERE node_id=${sqlText(nodeId)} AND status='running' AND lease_owner=${sqlText(workerId)} AND attempt_id=${sqlText(attemptId)} AND lease_generation=${Number(leaseGeneration)} AND prepared_result_sha256 IS NULL AND julianday(lease_expires_at)>=julianday(${sqlText(now)}) AND NOT EXISTS(SELECT 1 FROM campaign_events e WHERE e.campaign_id=campaign_nodes.campaign_id AND e.node_id=campaign_nodes.node_id AND e.kind='campaign_node_external_action_started' AND json_extract(e.event_json,'$.detail.attemptId')=campaign_nodes.attempt_id AND CAST(json_extract(e.event_json,'$.detail.leaseGeneration') AS INTEGER)=campaign_nodes.lease_generation) AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running');`),
            guarded(`UPDATE paper_campaigns SET ${usageSql(reservation.usage)},revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(node.campaignId)} AND status='running' AND ${usageBudgetCondition(reservation.usage)};`),
            eventRow.sql,
          ],
          fallback: 'campaign_node_infrastructure_reservation_failed',
          input: {
            node, nodeId, workerId, attemptId, leaseGeneration, now,
            usageDelta: reservation.usage, reservation, eventRow,
          },
        });
      } catch (error) {
        if (infrastructureControlError(error)) throw error;
        throw new Error('campaign_node_infrastructure_reservation_failed');
      }
      return reservation;
    },
  });
}

export function createCampaignNodeInfrastructureOperations(options = {}) {
  return Object.freeze({
    ...createCampaignNodeInfrastructureReservationOperations(options),
    ...createCampaignNodeExternalActionOperations(options),
  });
}
