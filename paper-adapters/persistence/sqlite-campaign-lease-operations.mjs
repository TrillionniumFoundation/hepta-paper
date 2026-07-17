import crypto from 'node:crypto';
import { sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { decideNodeFailureTransition, selectReadyCampaignNodes } from '../../paper-domain/automation/campaign-state-policy.mjs';
import { buildSqliteCampaignProjectionStatement } from './sqlite-campaign-projection.mjs';
import { mapCampaignNodeRow as parseNode } from './sqlite-campaign-row-mappers.mjs';
import { parseProcessIdentitySuffix, processIdentityIsStale } from '../../workflow-kernel/runtime/process-identity.mjs';

export function createCampaignLeaseOperations({ store, clock, transaction, guarded, eventStatement, usageSql, usageBudgetCondition, getApi } = {}) {
  return {
    recoverExpiredLeases(campaignId) {
      const now = clock.nowIso();
      const candidates = getApi().listNodes(campaignId).filter((node) => {
        if (!['leased', 'running'].includes(node.status)) return false;
        if (node.leaseExpiresAt && Date.parse(node.leaseExpiresAt) < Date.parse(now)) return true;
        const owner = String(node.leaseOwner || '');
        const identity = parseProcessIdentitySuffix(owner);
        if (identity) return processIdentityIsStale(identity);
        const legacy = owner.match(/^paper-campaign-worker:(\d+):/);
        return legacy ? processIdentityIsStale({ pid: Number(legacy[1]), pidStartTime: null }) : false;
      });
      if (!candidates.length) return [];
      const recovered = [];
      for (const node of candidates) {
        const expired = Boolean(node.leaseExpiresAt && Date.parse(node.leaseExpiresAt) < Date.parse(now));
        const eventRow = eventStatement(campaignId, node.nodeId, 'campaign_node_lease_recovered', {
          previousLeaseOwner: node.leaseOwner || null,
          previousAttemptId: node.attemptId,
          leaseGeneration: node.leaseGeneration,
        }, now);
        const staleCondition = expired
          ? `lease_expires_at IS NOT NULL AND julianday(lease_expires_at)<julianday(${sqlText(now)})`
          : `lease_owner=${sqlText(node.leaseOwner)}`;
        try {
          transaction([
            guarded(`UPDATE campaign_nodes SET status='queued',lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,failure_class='lease_expired_recovered',prepared_integration_status=CASE WHEN prepared_integration_status='integrating' THEN 'pending' ELSE prepared_integration_status END,prepared_integration_started_at=CASE WHEN prepared_integration_status='integrating' THEN NULL ELSE prepared_integration_started_at END,updated_at=${sqlText(now)} WHERE node_id=${sqlText(node.nodeId)} AND campaign_id=${sqlText(campaignId)} AND status=${sqlText(node.status)} AND lease_owner=${sqlText(node.leaseOwner)} AND ${node.attemptId ? `attempt_id=${sqlText(node.attemptId)}` : 'attempt_id IS NULL'} AND lease_generation=${node.leaseGeneration} AND ${staleCondition} AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=${sqlText(campaignId)} AND c.status='running');`),
            eventRow.sql,
          ], 'campaign_lease_recovery_failed');
          recovered.push(parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(node.nodeId)} LIMIT 1;`).rows[0]));
        } catch (error) {
          const latest = parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(node.nodeId)} LIMIT 1;`).rows[0]);
          if (latest?.status === node.status && latest?.attemptId === node.attemptId && latest?.leaseGeneration === node.leaseGeneration && latest?.leaseExpiresAt === node.leaseExpiresAt) throw error;
        }
      }
      return recovered;
    },
    renewNodeLease({ nodeId, workerId, attemptId, leaseGeneration, leaseSeconds = 120 } = {}) {
      if (!attemptId || !Number.isInteger(Number(leaseGeneration))) throw new Error('campaign_node_attempt_fence_required');
      const now = clock.nowIso();
      const expires = new Date(clock.now().getTime() + Math.max(1, Number(leaseSeconds)) * 1000).toISOString();
      try {
        transaction([
          guarded(`UPDATE campaign_nodes SET lease_expires_at=${sqlText(expires)},updated_at=${sqlText(now)} WHERE node_id=${sqlText(nodeId)} AND status='running' AND lease_owner=${sqlText(workerId)} AND attempt_id=${sqlText(attemptId)} AND lease_generation=${Number(leaseGeneration)} AND julianday(lease_expires_at)>=julianday(${sqlText(now)}) AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running');`),
        ], 'campaign_node_lease_renew_failed');
      } catch {
        throw new Error('campaign_node_lease_lost');
      }
      return parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
    },
    claimReady({ campaignId, workerId, leaseSeconds = 120, limit = 1 } = {}) {
      if (getApi().getCampaign(campaignId)?.status !== 'running') return [];
      getApi().recoverExpiredLeases(campaignId);
      const nodes = getApi().listNodes(campaignId);
      const candidates = selectReadyCampaignNodes(nodes, { limit });
      const now = clock.nowIso();
      const expires = new Date(clock.now().getTime() + Math.max(1, Number(leaseSeconds)) * 1000).toISOString();
      const claimed = [];
      for (const node of candidates) {
        const attemptId = crypto.randomUUID();
        try {
          transaction([
            guarded(`UPDATE campaign_nodes SET status='leased',lease_owner=${sqlText(workerId)},lease_expires_at=${sqlText(expires)},attempt_id=${sqlText(attemptId)},lease_generation=lease_generation+1,node_revision=node_revision+1,updated_at=${sqlText(now)} WHERE node_id=${sqlText(node.nodeId)} AND campaign_id=${sqlText(campaignId)} AND status='queued' AND node_revision=${node.nodeRevision} AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=${sqlText(campaignId)} AND c.status='running') AND NOT EXISTS(SELECT 1 FROM json_each(campaign_nodes.dependencies_json) d LEFT JOIN campaign_nodes dependency ON dependency.node_id=d.value WHERE dependency.status NOT IN ('completed','skipped') OR dependency.node_id IS NULL);`),
          ], 'campaign_node_claim_failed');
          const current = parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(node.nodeId)} AND lease_owner=${sqlText(workerId)} AND attempt_id=${sqlText(attemptId)} LIMIT 1;`).rows[0]);
          if (current) claimed.push(current);
        } catch (error) {
          const latest = parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(node.nodeId)} LIMIT 1;`).rows[0]);
          if (latest?.status === 'queued' && latest?.nodeRevision === node.nodeRevision && getApi().getCampaign(campaignId)?.status === 'running') throw error;
        }
      }
      return claimed;
    },
    startNode({ nodeId, workerId, attemptId, leaseGeneration, usageDelta = {} } = {}) {
      if (!attemptId || !Number.isInteger(Number(leaseGeneration))) throw new Error('campaign_node_attempt_fence_required');
      const before = parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
      const now = clock.nowIso();
      if (before?.status === 'running' && before.leaseOwner === workerId && before.attemptId === attemptId && before.leaseGeneration === Number(leaseGeneration)
        && Date.parse(before.leaseExpiresAt || '') >= Date.parse(now) && getApi().getCampaign(before.campaignId)?.status === 'running') return before;
      if (!before) throw new Error(`campaign node not found: ${nodeId}`);
      const eventRow = eventStatement(before.campaignId, nodeId, 'campaign_node_started', { attempt: before.attemptCount + 1, workerId, attemptId, leaseGeneration: Number(leaseGeneration) }, now);
      try {
        transaction([
          guarded(`UPDATE campaign_nodes SET status='running',attempt_count=attempt_count+1,node_revision=node_revision+1,updated_at=${sqlText(now)} WHERE node_id=${sqlText(nodeId)} AND status='leased' AND lease_owner=${sqlText(workerId)} AND attempt_id=${sqlText(attemptId)} AND lease_generation=${Number(leaseGeneration)} AND julianday(lease_expires_at)>=julianday(${sqlText(now)}) AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running');`),
          guarded(`UPDATE paper_campaigns SET current_phase=${sqlText(before.kind)},current_review_round=max(current_review_round,${Math.max(0, Number(before.roundIndex || 0))}),${usageSql(usageDelta)},revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(before.campaignId)} AND status='running' AND ${usageBudgetCondition(usageDelta)};`),
          eventRow.sql,
        ], 'campaign_node_start_failed');
      } catch {
        const current = parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
        if (current?.status === 'leased' && current.leaseOwner === workerId
          && current.attemptId === attemptId
          && current.leaseGeneration === Number(leaseGeneration)) {
          throw new Error('campaign_node_budget_reservation_failed');
        }
        throw new Error('campaign_node_lease_lost');
      }
      const node = parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
      return node;
    },
    failNode({ nodeId, workerId, attemptId, leaseGeneration, failureClass = 'automation_node_failed', failureDetail = {}, retryable = true, abandonPreparedResult = false, usageDelta = {} } = {}) {
      if (!attemptId || !Number.isInteger(Number(leaseGeneration))) throw new Error('campaign_node_attempt_fence_required');
      const node = parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
      if (!node) throw new Error(`campaign node not found: ${nodeId}`);
      const failureTransition = decideNodeFailureTransition(node, { retryable });
      const { status } = failureTransition;
      const now = clock.nowIso();
      const failureHash = hashRecord('PaperCampaignNodeFailure', failureDetail);
      const eventRow = eventStatement(node.campaignId, nodeId, failureTransition.eventKind, { failureClass, failureHash, attempt: node.attemptCount, attemptId, leaseGeneration: Number(leaseGeneration), preparedResultAbandoned: Boolean(abandonPreparedResult) }, now);
      const preparedReset = abandonPreparedResult
        ? ",prepared_result_json=NULL,prepared_result_sha256=NULL,prepared_attempt_id=NULL,prepared_at=NULL,prepared_requires_integration=0,prepared_integration_key=NULL,prepared_integration_status='none',prepared_integration_started_at=NULL,prepared_integration_receipt_json=NULL,prepared_integration_receipt_sha256=NULL,prepared_integrated_at=NULL"
        : ",prepared_integration_status=CASE WHEN prepared_integration_status='integrating' THEN 'pending' ELSE prepared_integration_status END,prepared_integration_started_at=CASE WHEN prepared_integration_status='integrating' THEN NULL ELSE prepared_integration_started_at END";
      try {
        transaction([
          guarded(`UPDATE campaign_nodes SET status=${sqlText(status)},failure_class=${sqlText(failureClass)},failure_json=${sqlJson(failureDetail)},failure_sha256=${sqlText(failureHash)},lease_owner=NULL,lease_expires_at=NULL,node_revision=node_revision+1${preparedReset},updated_at=${sqlText(now)} WHERE node_id=${sqlText(nodeId)} AND status='running' AND lease_owner=${sqlText(workerId)} AND attempt_id=${sqlText(attemptId)} AND lease_generation=${Number(leaseGeneration)} AND julianday(lease_expires_at)>=julianday(${sqlText(now)}) AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running');`),
          `UPDATE paper_campaigns SET ${usageSql(usageDelta)},updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(node.campaignId)} AND status='running';`,
          eventRow.sql,
          buildSqliteCampaignProjectionStatement({ campaignId: node.campaignId, now }),
        ], 'campaign_node_failure_failed');
      } catch {
        throw new Error('campaign_node_lease_lost');
      }
      return parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
    },
  };
}
