import crypto from 'node:crypto';
import { sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  selectReadyCampaignNodes,
} from '../../paper-domain/automation/campaign-state-policy.mjs';
import { mapCampaignNodeRow as parseNode } from './sqlite-campaign-row-mappers.mjs';
import {
  parseProcessIdentitySuffix,
  processIdentityIsStale,
} from '../../workflow-kernel/runtime/process-identity.mjs';
import {
  inspectNodeInfrastructureAttempt,
} from './sqlite-campaign-node-infrastructure-reservations.mjs';

export function createCampaignLeaseOperations({
  store, clock, mutation, guarded, eventStatement, getApi,
} = {}) {
  return {
    recoverExpiredLeases(campaignId) {
      const now = clock.nowIso();
      const candidates = getApi().listNodes(campaignId).filter((node) => {
        if (!['leased', 'running'].includes(node.status)) return false;
        if (node.leaseExpiresAt
          && Date.parse(node.leaseExpiresAt) < Date.parse(now)) return true;
        const owner = String(node.leaseOwner || '');
        const identity = parseProcessIdentitySuffix(owner);
        if (identity) return processIdentityIsStale(identity);
        const legacy = owner.match(/^paper-campaign-worker:(\d+):/);
        return legacy
          ? processIdentityIsStale({ pid: Number(legacy[1]), pidStartTime: null })
          : false;
      });
      if (!candidates.length) return [];
      const recovered = [];
      for (const node of candidates) {
        const expired = Boolean(node.leaseExpiresAt
          && Date.parse(node.leaseExpiresAt) < Date.parse(now));
        const attemptInspection = node.status === 'running' && node.attemptId
          ? inspectNodeInfrastructureAttempt(store, {
            campaignId,
            nodeId: node.nodeId,
            attemptId: node.attemptId,
            leaseGeneration: node.leaseGeneration,
          }) : null;
        const disposition = node.status === 'leased'
          ? 'leased_requeue'
          : node.preparedResultHash
            ? 'prepared_result_recovery'
            : attemptInspection?.unresolvedExternalActions.length
              ? 'external_outcome_uncertain'
              : 'pre_external_action_refund_requeue';
        const refund = disposition === 'pre_external_action_refund_requeue'
          ? attemptInspection.refundableUsage
          : Object.freeze({ agentCalls: 0, cpuJobs: 0, gpuJobs: 0 });
        const unresolvedExternalActions = disposition === 'external_outcome_uncertain'
          ? attemptInspection.unresolvedExternalActions
          : Object.freeze([]);
        const failureDetail = disposition === 'external_outcome_uncertain'
          ? Object.freeze({
            version: 1,
            kind: 'CampaignNodeExternalOutcomeUncertain',
            campaignId,
            nodeId: node.nodeId,
            attemptId: node.attemptId,
            leaseGeneration: node.leaseGeneration,
            externalActions: unresolvedExternalActions,
            detectedAt: now,
          }) : null;
        const failureHash = failureDetail
          ? hashRecord('CampaignNodeFailureDetail', failureDetail) : null;
        const eventRow = eventStatement(
          campaignId,
          node.nodeId,
          disposition === 'external_outcome_uncertain'
            ? 'campaign_node_external_outcome_uncertain'
            : 'campaign_node_lease_recovered',
          {
            previousLeaseOwner: node.leaseOwner || null,
            previousAttemptId: node.attemptId,
            leaseGeneration: node.leaseGeneration,
            recoveryDisposition: disposition,
            budgetReservationRefunded:
              disposition === 'pre_external_action_refund_requeue',
            refundedUsage: refund,
            unresolvedExternalActions,
          },
          now,
        );
        const staleCondition = expired
          ? `lease_expires_at IS NOT NULL AND julianday(lease_expires_at)<julianday(${sqlText(now)})`
          : `lease_owner=${sqlText(node.leaseOwner)}`;
        try {
          const nodeStatement = disposition === 'external_outcome_uncertain'
            ? guarded(`UPDATE campaign_nodes SET status='external_outcome_uncertain',lease_owner=NULL,lease_expires_at=NULL,failure_class='external_outcome_uncertain',failure_json=${sqlJson(failureDetail)},failure_sha256=${sqlText(failureHash)},node_revision=node_revision+1,updated_at=${sqlText(now)} WHERE node_id=${sqlText(node.nodeId)} AND campaign_id=${sqlText(campaignId)} AND status=${sqlText(node.status)} AND lease_owner=${sqlText(node.leaseOwner)} AND attempt_id=${sqlText(node.attemptId)} AND lease_generation=${node.leaseGeneration} AND prepared_result_sha256 IS NULL AND ${staleCondition} AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=${sqlText(campaignId)} AND c.status='running');`)
            : guarded(`UPDATE campaign_nodes SET status='queued',attempt_count=attempt_count-${node.status === 'running' ? 1 : 0},lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,failure_class='lease_expired_recovered',prepared_integration_status=CASE WHEN prepared_integration_status='integrating' THEN 'pending' ELSE prepared_integration_status END,prepared_integration_started_at=CASE WHEN prepared_integration_status='integrating' THEN NULL ELSE prepared_integration_started_at END,updated_at=${sqlText(now)} WHERE node_id=${sqlText(node.nodeId)} AND campaign_id=${sqlText(campaignId)} AND status=${sqlText(node.status)} AND lease_owner=${sqlText(node.leaseOwner)} AND ${node.attemptId ? `attempt_id=${sqlText(node.attemptId)}` : 'attempt_id IS NULL'} AND lease_generation=${node.leaseGeneration} AND attempt_count>=${node.status === 'running' ? 1 : 0} AND ${staleCondition} AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=${sqlText(campaignId)} AND c.status='running');`);
          const refundStatement = disposition === 'pre_external_action_refund_requeue'
            ? [guarded(`UPDATE paper_campaigns SET agent_call_count=agent_call_count-${refund.agentCalls},cpu_job_count=cpu_job_count-${refund.cpuJobs},gpu_job_count=gpu_job_count-${refund.gpuJobs},revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status='running' AND agent_call_count>=${refund.agentCalls} AND cpu_job_count>=${refund.cpuJobs} AND gpu_job_count>=${refund.gpuJobs};`)]
            : [];
          mutation({
            databaseRole: 'native-store',
            operationId: 'native-store.campaign-lease.recoverExpiredLeases.v1',
            statements: [
              nodeStatement,
              ...refundStatement,
              eventRow.sql,
            ],
            fallback: 'campaign_lease_recovery_failed',
            input: {
              node, campaignId, expired, now, eventRow, disposition,
              refund, failureDetail, failureHash, unresolvedExternalActions,
            },
          });
          recovered.push(parseNode(store.query(
            `SELECT * FROM campaign_nodes WHERE node_id=${sqlText(node.nodeId)} LIMIT 1;`,
          ).rows[0]));
        } catch (error) {
          if (error?.committed) throw error;
          const latest = parseNode(store.query(
            `SELECT * FROM campaign_nodes WHERE node_id=${sqlText(node.nodeId)} LIMIT 1;`,
          ).rows[0]);
          if (latest?.status === node.status && latest?.attemptId === node.attemptId
            && latest?.leaseGeneration === node.leaseGeneration
            && latest?.leaseExpiresAt === node.leaseExpiresAt) throw error;
        }
      }
      return recovered;
    },

    renewNodeLease({
      nodeId, workerId, attemptId, leaseGeneration, leaseSeconds = 120,
    } = {}) {
      if (!attemptId || !Number.isInteger(Number(leaseGeneration))) {
        throw new Error('campaign_node_attempt_fence_required');
      }
      const now = clock.nowIso();
      const expires = new Date(
        clock.now().getTime() + Math.max(1, Number(leaseSeconds)) * 1000,
      ).toISOString();
      try {
        mutation({
          databaseRole: 'native-store',
          operationId: 'native-store.campaign-lease.renewNodeLease.v1',
          statements: [
            guarded(`UPDATE campaign_nodes SET lease_expires_at=${sqlText(expires)},updated_at=${sqlText(now)} WHERE node_id=${sqlText(nodeId)} AND status='running' AND lease_owner=${sqlText(workerId)} AND attempt_id=${sqlText(attemptId)} AND lease_generation=${Number(leaseGeneration)} AND julianday(lease_expires_at)>=julianday(${sqlText(now)}) AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running');`),
          ],
          fallback: 'campaign_node_lease_renew_failed',
          input: {
            expires, now, nodeId, workerId, attemptId, leaseGeneration,
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

    claimReady({ campaignId, workerId, leaseSeconds = 120, limit = 1 } = {}) {
      if (getApi().getCampaign(campaignId)?.status !== 'running') return [];
      getApi().recoverExpiredLeases(campaignId);
      const nodes = getApi().listNodes(campaignId);
      const candidates = selectReadyCampaignNodes(nodes, { limit });
      const now = clock.nowIso();
      const expires = new Date(
        clock.now().getTime() + Math.max(1, Number(leaseSeconds)) * 1000,
      ).toISOString();
      const claimed = [];
      for (const node of candidates) {
        const attemptId = crypto.randomUUID();
        try {
          mutation({
            databaseRole: 'native-store',
            operationId: 'native-store.campaign-lease.claimReady.v1',
            statements: [
              guarded(`UPDATE campaign_nodes SET status='leased',lease_owner=${sqlText(workerId)},lease_expires_at=${sqlText(expires)},attempt_id=${sqlText(attemptId)},lease_generation=lease_generation+1,node_revision=node_revision+1,updated_at=${sqlText(now)} WHERE node_id=${sqlText(node.nodeId)} AND campaign_id=${sqlText(campaignId)} AND status='queued' AND node_revision=${node.nodeRevision} AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=${sqlText(campaignId)} AND c.status='running') AND NOT EXISTS(SELECT 1 FROM json_each(campaign_nodes.dependencies_json) d LEFT JOIN campaign_nodes dependency ON dependency.node_id=d.value WHERE dependency.status NOT IN ('completed','skipped') OR dependency.node_id IS NULL);`),
            ],
            fallback: 'campaign_node_claim_failed',
            input: { workerId, expires, attemptId, now, node, campaignId },
          });
          const current = parseNode(store.query(
            `SELECT * FROM campaign_nodes WHERE node_id=${sqlText(node.nodeId)} AND lease_owner=${sqlText(workerId)} AND attempt_id=${sqlText(attemptId)} LIMIT 1;`,
          ).rows[0]);
          if (current) claimed.push(current);
        } catch (error) {
          if (error?.committed) throw error;
          const latest = parseNode(store.query(
            `SELECT * FROM campaign_nodes WHERE node_id=${sqlText(node.nodeId)} LIMIT 1;`,
          ).rows[0]);
          if (latest?.status === 'queued' && latest?.nodeRevision === node.nodeRevision
            && getApi().getCampaign(campaignId)?.status === 'running') throw error;
        }
      }
      return claimed;
    },
  };
}
