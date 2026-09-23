import { sqlText } from '../../paper-ports/store-port.mjs';
import {
  buildCampaignExternalActionDescriptor,
  buildCampaignExternalActionOutcome,
} from '../../paper-domain/automation/campaign-external-action-journal-contract.mjs';
import {
  infrastructureControlError,
  readNodeExternalAction,
} from './sqlite-campaign-node-infrastructure-reservations.mjs';
import {
  mapCampaignNodeRow as parseNode,
  mapCampaignRow as parseCampaign,
} from './sqlite-campaign-row-mappers.mjs';

function persistedCampaign(store, campaignId) {
  return parseCampaign(store.query(
    `SELECT * FROM paper_campaigns WHERE campaign_id=${sqlText(campaignId)} LIMIT 1;`,
  ).rows[0]);
}

function actionDescriptor({ store, node, action, actionOrdinal, resolverKind,
  requestDigest, externalActionId, campaignPlanHash, nodeSemanticSpecHash } = {}) {
  const descriptor = buildCampaignExternalActionDescriptor({
    campaign: persistedCampaign(store, node.campaignId),
    node,
    request: { action, requestDigest },
    actionOrdinal: Number(actionOrdinal || 1),
    resolverKind: resolverKind || 'unqualified',
  });
  if ((externalActionId && externalActionId !== descriptor.externalActionId)
    || (campaignPlanHash && campaignPlanHash !== descriptor.campaignPlanHash)
    || (nodeSemanticSpecHash
      && nodeSemanticSpecHash !== descriptor.nodeSemanticSpecHash)) {
    throw new Error('campaign_external_action_descriptor_conflict');
  }
  return descriptor;
}

export function createCampaignNodeExternalActionOperations({
  store, clock, mutation, guarded, eventStatement, usageSql,
} = {}) {
  return Object.freeze({
    getNodeExternalAction({ campaignId, nodeId, externalActionId } = {}) {
      if (!campaignId || !nodeId || !externalActionId) {
        throw new Error('campaign_external_action_identity_required');
      }
      return readNodeExternalAction(store, { campaignId, nodeId, externalActionId });
    },

    markNodeExternalActionStarted({
      nodeId, workerId, attemptId, leaseGeneration, action = 'unspecified',
      actionOrdinal = 1, resolverKind = 'unqualified', requestDigest = null,
      externalActionId = null, campaignPlanHash = null,
      nodeSemanticSpecHash = null,
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
        || node.leaseGeneration !== Number(leaseGeneration)) {
        throw new Error('campaign_node_external_action_started_fence_lost');
      }
      const descriptor = actionDescriptor({
        store, node, action, actionOrdinal, resolverKind, requestDigest,
        externalActionId, campaignPlanHash, nodeSemanticSpecHash,
      });
      const existing = readNodeExternalAction(store, descriptor);
      if (existing?.status === 'completed'
        || existing?.startedAttempts.some((item) => (
          item.attemptId === attemptId
          && item.leaseGeneration === Number(leaseGeneration)
        ))) return existing;
      const eventRow = eventStatement(
        node.campaignId,
        nodeId,
        'campaign_node_external_action_started',
        {
          workerId,
          attemptId,
          leaseGeneration: Number(leaseGeneration),
          ...descriptor,
          externalActionMayHaveStarted: true,
        },
        now,
      );
      try {
        mutation({
          databaseRole: 'native-store',
          operationId: 'native-store.campaign-lease.markNodeExternalActionStarted.v1',
          statements: [
            guarded(`UPDATE campaign_nodes SET node_revision=node_revision+1 WHERE node_id=${sqlText(nodeId)} AND status='running' AND lease_owner=${sqlText(workerId)} AND attempt_id=${sqlText(attemptId)} AND lease_generation=${Number(leaseGeneration)} AND node_revision=${Number(node.nodeRevision)} AND julianday(lease_expires_at)>=julianday(${sqlText(now)}) AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running');`),
            eventRow.sql,
          ],
          fallback: 'campaign_node_external_action_started_failed',
          input: {
            node, nodeId, workerId, attemptId, leaseGeneration, now,
            descriptor, eventRow,
          },
        });
      } catch (error) {
        if (infrastructureControlError(error)) throw error;
        const replay = readNodeExternalAction(store, descriptor);
        if (replay?.startedAttempts.some((item) => (
          item.attemptId === attemptId
          && item.leaseGeneration === Number(leaseGeneration)
        )) || replay?.status === 'completed') return replay;
        throw new Error('campaign_node_external_action_started_fence_lost');
      }
      return readNodeExternalAction(store, descriptor);
    },

    completeNodeExternalAction({
      nodeId, workerId, attemptId, leaseGeneration, externalActionId,
      outcome, usageDelta = {},
    } = {}) {
      if (!attemptId || !Number.isInteger(Number(leaseGeneration))
        || !externalActionId) {
        throw new Error('campaign_external_action_completion_identity_required');
      }
      const node = parseNode(store.query(
        `SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`,
      ).rows[0]);
      const existing = node ? readNodeExternalAction(store, {
        campaignId: node.campaignId, nodeId, externalActionId,
      }) : null;
      if (!existing) throw new Error('campaign_external_action_start_missing');
      const completed = buildCampaignExternalActionOutcome(outcome);
      if (existing.status === 'completed') {
        if (existing.outcomeHash !== completed.outcomeHash) {
          throw new Error('campaign_external_action_outcome_conflict');
        }
        return existing;
      }
      if (!node || node.status !== 'running' || node.leaseOwner !== workerId
        || node.attemptId !== attemptId
        || node.leaseGeneration !== Number(leaseGeneration)
        || !existing.startedAttempts.some((item) => (
          item.attemptId === attemptId
          && item.leaseGeneration === Number(leaseGeneration)
        ))) {
        throw new Error('campaign_external_action_completion_fence_lost');
      }
      const now = clock.nowIso();
      const eventRow = eventStatement(
        node.campaignId,
        nodeId,
        'campaign_node_external_action_completed',
        {
          workerId,
          attemptId,
          leaseGeneration: Number(leaseGeneration),
          campaignId: existing.campaignId,
          nodeId: existing.nodeId,
          campaignPlanHash: existing.campaignPlanHash,
          nodeSemanticSpecHash: existing.nodeSemanticSpecHash,
          action: existing.action,
          actionOrdinal: existing.actionOrdinal,
          requestDigest: existing.requestDigest,
          resolverKind: existing.resolverKind,
          externalActionId,
          outcomePayload: completed.payload,
          outcomeHash: completed.outcomeHash,
          usageDelta,
          completionMode: 'executed',
        },
        now,
      );
      try {
        mutation({
          databaseRole: 'native-store',
          operationId: 'native-store.campaign-lease.completeNodeExternalAction.v1',
          statements: [
            guarded(`UPDATE campaign_nodes SET node_revision=node_revision+1 WHERE node_id=${sqlText(nodeId)} AND status='running' AND lease_owner=${sqlText(workerId)} AND attempt_id=${sqlText(attemptId)} AND lease_generation=${Number(leaseGeneration)} AND node_revision=${Number(node.nodeRevision)} AND julianday(lease_expires_at)>=julianday(${sqlText(now)}) AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running');`),
            `UPDATE paper_campaigns SET ${usageSql(usageDelta)},updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(node.campaignId)} AND status='running';`,
            eventRow.sql,
          ],
          fallback: 'campaign_external_action_completion_failed',
          input: {
            node, nodeId, workerId, attemptId, leaseGeneration, now,
            descriptor: existing, completed, usageDelta, eventRow,
          },
        });
      } catch (error) {
        if (infrastructureControlError(error)) throw error;
        const replay = readNodeExternalAction(store, {
          campaignId: node.campaignId, nodeId, externalActionId,
        });
        if (replay?.status === 'completed'
          && replay.outcomeHash === completed.outcomeHash) return replay;
        throw new Error('campaign_external_action_completion_fence_lost');
      }
      return readNodeExternalAction(store, {
        campaignId: node.campaignId, nodeId, externalActionId,
      });
    },
  });
}
