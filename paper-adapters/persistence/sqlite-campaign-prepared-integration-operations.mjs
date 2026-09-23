import { sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { createCampaignReleasePromotionReceipt } from '../../paper-domain/automation/campaign-release-contracts.mjs';
import { buildSqliteCampaignProjectionStatement } from './sqlite-campaign-projection.mjs';
import { mapCampaignNodeRow as parseNode } from './sqlite-campaign-row-mappers.mjs';

export function createCampaignPreparedIntegrationOperations({
  store,
  clock,
  mutation,
  guarded,
  eventStatement,
  usageSql,
  assertLiveNodeAttempt,
  getApi,
  experimentRegistryAuthorityVerifier = null,
  gpuScientificPromotionAuthorityVerifier = null,
} = {}) {
  return {
    prepareNodeResult({ nodeId, workerId, attemptId, leaseGeneration, result = {}, requiresIntegration = false, integrationKey = null } = {}) {
      if (!attemptId || !Number.isInteger(Number(leaseGeneration))) throw new Error('campaign_node_attempt_fence_required');
      const node = parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
      const now = clock.nowIso();
      if (!node || node.status !== 'running' || node.leaseOwner !== workerId || node.attemptId !== attemptId || node.leaseGeneration !== Number(leaseGeneration)
        || Date.parse(node.leaseExpiresAt || '') < Date.parse(now) || getApi().getCampaign(node.campaignId)?.status !== 'running') throw new Error('campaign_node_lease_lost');
      const resultHash = hashRecord('PaperCampaignNodeResult', result);
      if (node?.preparedResultHash) {
        if (node.preparedResultHash !== resultHash) throw new Error('campaign_prepared_result_immutable');
        if (integrationKey && node.preparedIntegrationKey !== integrationKey) throw new Error('campaign_prepared_integration_key_immutable');
        return node;
      }
      if (requiresIntegration && !integrationKey) throw new Error('campaign_prepared_integration_key_required');
      const eventRow = eventStatement(node?.campaignId, nodeId, 'campaign_node_result_prepared', { resultHash, attemptId, leaseGeneration: Number(leaseGeneration) }, now);
      try {
        mutation({
          databaseRole: 'native-store',
          operationId: 'native-store.campaign-prepared-integration.prepareNodeResult.v1',
          statements: [
            guarded(`UPDATE campaign_nodes SET prepared_result_json=${sqlJson(result)},prepared_result_sha256=${sqlText(resultHash)},prepared_attempt_id=${sqlText(attemptId)},prepared_at=${sqlText(now)},prepared_requires_integration=${requiresIntegration ? 1 : 0},prepared_integration_key=${integrationKey ? sqlText(integrationKey) : 'NULL'},prepared_integration_status=${sqlText(requiresIntegration ? 'pending' : 'none')},prepared_integration_started_at=NULL,prepared_integration_receipt_json=NULL,prepared_integration_receipt_sha256=NULL,prepared_integrated_at=NULL,node_revision=node_revision+1,updated_at=${sqlText(now)} WHERE node_id=${sqlText(nodeId)} AND status='running' AND lease_owner=${sqlText(workerId)} AND attempt_id=${sqlText(attemptId)} AND lease_generation=${Number(leaseGeneration)} AND julianday(lease_expires_at)>=julianday(${sqlText(now)}) AND prepared_result_sha256 IS NULL AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running');`),
            eventRow.sql,
          ],
          fallback: 'campaign_node_result_prepare_failed',
          input: {
            result, resultHash, attemptId, now, requiresIntegration,
            integrationKey, nodeId, workerId, leaseGeneration, eventRow,
          },
        });
      } catch (error) {
        if (error?.committed) throw error;
        throw new Error('campaign_node_lease_lost');
      }
      return parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
    },
    beginNodeResultIntegration({ nodeId, workerId, attemptId, leaseGeneration, integrationKey, integrationLeaseSeconds = 1800 } = {}) {
      if (!attemptId || !integrationKey || !Number.isInteger(Number(leaseGeneration))) throw new Error('campaign_node_attempt_fence_required');
      const node = parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
      const now = clock.nowIso();
      if (['integrating', 'integrated'].includes(node?.preparedIntegrationStatus) && node.preparedIntegrationKey === integrationKey) {
        return assertLiveNodeAttempt({
          nodeId,
          workerId,
          attemptId,
          leaseGeneration,
          now,
          integrationState: 'integrating',
          integrationKey,
        });
      }
      const integrationExpires = new Date(clock.now().getTime() + Math.max(30, Number(integrationLeaseSeconds || 1800)) * 1000).toISOString();
      const eventRow = eventStatement(node?.campaignId, nodeId, 'campaign_node_result_integration_started', { integrationKey, preparedResultHash: node?.preparedResultHash, attemptId, leaseGeneration: Number(leaseGeneration) }, now);
      try {
        mutation({
          databaseRole: 'native-store',
          operationId: 'native-store.campaign-prepared-integration.beginNodeResultIntegration.v1',
          statements: [
            guarded(`UPDATE campaign_nodes SET prepared_integration_status='integrating',prepared_integration_started_at=${sqlText(now)},lease_expires_at=CASE WHEN julianday(lease_expires_at)<julianday(${sqlText(integrationExpires)}) THEN ${sqlText(integrationExpires)} ELSE lease_expires_at END,node_revision=node_revision+1,updated_at=${sqlText(now)} WHERE node_id=${sqlText(nodeId)} AND status='running' AND lease_owner=${sqlText(workerId)} AND attempt_id=${sqlText(attemptId)} AND lease_generation=${Number(leaseGeneration)} AND julianday(lease_expires_at)>=julianday(${sqlText(now)}) AND prepared_requires_integration=1 AND prepared_integration_status='pending' AND prepared_integration_key=${sqlText(integrationKey)} AND prepared_result_sha256 IS NOT NULL AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running');`),
            eventRow.sql,
          ],
          fallback: 'campaign_node_result_integration_begin_failed',
          input: {
            now, integrationExpires, nodeId, workerId, attemptId,
            leaseGeneration, integrationKey, eventRow,
          },
        });
      } catch (error) {
        if (error?.committed) throw error;
        throw new Error('campaign_node_lease_lost');
      }
      return parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
    },
    markNodeResultIntegrated({ nodeId, workerId, attemptId, leaseGeneration, integrationKey, integrationReceipt } = {}) {
      if (!attemptId || !integrationKey || !integrationReceipt || !Number.isInteger(Number(leaseGeneration))) throw new Error('campaign_node_attempt_fence_required');
      const { workspaceAttemptIntegrationReceiptHash: receiptHash = null, ...receiptPayload } = integrationReceipt || {};
      if (!receiptHash || hashRecord('WorkspaceAttemptIntegrationReceipt', receiptPayload) !== receiptHash
        || integrationReceipt.descriptorHash !== integrationKey || integrationReceipt.status !== 'workspace_attempt_integrated') {
        throw new Error('campaign_node_integration_receipt_invalid');
      }
      const node = parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
      const now = clock.nowIso();
      if (node?.preparedIntegrationStatus === 'integrated' && node.preparedIntegrationKey === integrationKey
        && node.preparedIntegrationReceiptHash === receiptHash) {
        return assertLiveNodeAttempt({
          nodeId,
          workerId,
          attemptId,
          leaseGeneration,
          now,
          integrationState: 'integrated',
          integrationKey,
          integrationReceiptHash: receiptHash,
        });
      }
      const eventRow = eventStatement(node?.campaignId, nodeId, 'campaign_node_result_integrated', { integrationKey, integrationReceiptHash: receiptHash, preparedResultHash: node?.preparedResultHash }, now);
      try {
        mutation({
          databaseRole: 'native-store',
          operationId: 'native-store.campaign-prepared-integration.markNodeResultIntegrated.v1',
          statements: [
            guarded(`UPDATE campaign_nodes SET prepared_integration_status='integrated',prepared_integration_receipt_json=${sqlJson(integrationReceipt)},prepared_integration_receipt_sha256=${sqlText(receiptHash)},prepared_integrated_at=${sqlText(now)},node_revision=node_revision+1,updated_at=${sqlText(now)} WHERE node_id=${sqlText(nodeId)} AND status='running' AND lease_owner=${sqlText(workerId)} AND attempt_id=${sqlText(attemptId)} AND lease_generation=${Number(leaseGeneration)} AND julianday(lease_expires_at)>=julianday(${sqlText(now)}) AND prepared_requires_integration=1 AND prepared_integration_status='integrating' AND prepared_integration_key=${sqlText(integrationKey)} AND prepared_result_sha256 IS NOT NULL AND prepared_integrated_at IS NULL AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running');`),
            eventRow.sql,
          ],
          fallback: 'campaign_node_result_integration_mark_failed',
          input: {
            integrationReceipt, receiptHash, now, nodeId, workerId,
            attemptId, leaseGeneration, integrationKey, eventRow,
          },
        });
      } catch (error) {
        if (error?.committed) throw error;
        throw new Error('campaign_node_lease_lost');
      }
      return parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
    },
    completeNode({ nodeId, workerId, attemptId, leaseGeneration, preparedResultHash = null, result, usageDelta = {} } = {}) {
      if (!attemptId || !Number.isInteger(Number(leaseGeneration))) throw new Error('campaign_node_attempt_fence_required');
      let node = parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
      if (node?.status === 'completed' && node.attemptId === attemptId && (!preparedResultHash || node.resultSha256 === preparedResultHash)) return node;
      if (!node?.preparedResultHash && result !== undefined) node = getApi().prepareNodeResult({ nodeId, workerId, attemptId, leaseGeneration, result });
      if (!node?.preparedResultHash) throw new Error('campaign_prepared_result_required');
      if (preparedResultHash && node.preparedResultHash !== preparedResultHash) throw new Error('campaign_prepared_result_hash_mismatch');
      if (node.preparedRequiresIntegration && (node.preparedIntegrationStatus !== 'integrated' || !node.preparedIntegrationReceiptHash)) {
        throw new Error('campaign_prepared_result_integration_required');
      }
      const prepared = node.preparedResult;
      const reviewerId = prepared?.reviewerId || null;
      const role = prepared?.role || node.role || node.spec?.role || null;
      const childSessionId = prepared?.childSessionId || prepared?.sessionKey || null;
      const reviewHash = prepared?.reviewHash || null;
      const promptHash = prepared?.promptHash || null;
      const resolvedModel = prepared?.resolvedModel || null;
      const now = clock.nowIso();
      const campaign = getApi().getCampaign(node.campaignId);
      const releasePromotionReceipt = node.kind === 'package' && prepared?.releaseBundle
        ? createCampaignReleasePromotionReceipt({
          campaign,
          packageNode: node,
          packageResult: prepared,
          promotedAt: now,
          experimentRegistryAuthorityVerifier,
          gpuScientificPromotionAuthorityVerifier,
        })
        : null;
      const packageDeletionWriterSelector = releasePromotionReceipt
        ? Object.freeze({
          packagePath: prepared.releaseBundle.packageOutput.packageDir,
        })
        : null;
      const eventRow = eventStatement(node.campaignId, nodeId, 'campaign_node_completed', {
        resultHash: node.preparedResultHash,
        preparedAttemptId: node.preparedAttemptId,
        integratedByAttemptId: attemptId,
        campaignReleasePromotionReceiptHash: releasePromotionReceipt?.campaignReleasePromotionReceiptHash || null,
      }, now);
      const releaseAuthorityStatement = releasePromotionReceipt ? guarded(`INSERT INTO campaign_current_releases(
        campaign_id,paper_id,campaign_plan_hash,package_node_id,package_attempt_id,lease_generation,
        package_result_hash,integration_descriptor_hash,integration_receipt_hash,campaign_release_bundle_hash,
        materialization_receipt_hash,release_bundle_json,promotion_receipt_json,promotion_receipt_hash,
        package_node_status,campaign_status,package_completed_at,promoted_at,status
      )
      SELECT ${sqlText(releasePromotionReceipt.campaignId)},${sqlText(releasePromotionReceipt.paperId)},${sqlText(releasePromotionReceipt.campaignPlanHash)},
        ${sqlText(releasePromotionReceipt.packageNodeId)},${sqlText(releasePromotionReceipt.packageAttemptId)},${releasePromotionReceipt.leaseGeneration},
        ${sqlText(releasePromotionReceipt.packageResultHash)},${sqlText(releasePromotionReceipt.integrationDescriptorHash)},${sqlText(releasePromotionReceipt.integrationReceiptHash)},
        ${sqlText(releasePromotionReceipt.campaignReleaseBundleHash)},${sqlText(releasePromotionReceipt.materializationReceiptHash)},${sqlJson(prepared.releaseBundle)},
        ${sqlJson(releasePromotionReceipt)},${sqlText(releasePromotionReceipt.campaignReleasePromotionReceiptHash)},'completed','completed',
        ${sqlText(releasePromotionReceipt.packageCompletedAt)},${sqlText(releasePromotionReceipt.promotedAt)},'current_completed_release'
      WHERE EXISTS(
        SELECT 1 FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id
        WHERE n.node_id=${sqlText(nodeId)} AND n.campaign_id=${sqlText(node.campaignId)} AND n.kind='package' AND n.status='completed'
          AND n.attempt_id=${sqlText(attemptId)} AND n.lease_generation=${Number(leaseGeneration)}
          AND n.result_sha256=${sqlText(node.preparedResultHash)}
          AND n.prepared_integration_status='integrated'
          AND n.prepared_integration_key=${sqlText(releasePromotionReceipt.integrationDescriptorHash)}
          AND n.prepared_integration_receipt_sha256=${sqlText(releasePromotionReceipt.integrationReceiptHash)}
          AND json_extract(n.result_json,'$.campaignReleaseBundleHash')=${sqlText(releasePromotionReceipt.campaignReleaseBundleHash)}
          AND json_extract(n.result_json,'$.campaignReleaseBundleMaterializationReceiptHash')=${sqlText(releasePromotionReceipt.materializationReceiptHash)}
          AND c.status='completed' AND c.paper_id=${sqlText(releasePromotionReceipt.paperId)}
          AND json_extract(c.spec_json,'$.campaignPlanHash')=${sqlText(releasePromotionReceipt.campaignPlanHash)}
      );`) : '';
      try {
        mutation({
          databaseRole: 'native-store',
          operationId: 'native-store.campaign-prepared-integration.completeNode.v1',
          statements: [
            guarded(`UPDATE campaign_nodes SET status='completed',result_json=prepared_result_json,result_sha256=prepared_result_sha256,lease_owner=NULL,lease_expires_at=NULL,failure_class=NULL,integrated_at=${sqlText(now)},node_revision=node_revision+1,updated_at=${sqlText(now)},role=${role ? sqlText(role) : 'role'},reviewer_id=${reviewerId ? sqlText(reviewerId) : 'NULL'},child_session_id=${childSessionId ? sqlText(childSessionId) : 'NULL'},review_hash=${reviewHash ? sqlText(reviewHash) : 'NULL'},prompt_hash=${promptHash ? sqlText(promptHash) : 'NULL'},resolved_model=${resolvedModel ? sqlText(resolvedModel) : 'NULL'} WHERE node_id=${sqlText(nodeId)} AND status='running' AND lease_owner=${sqlText(workerId)} AND attempt_id=${sqlText(attemptId)} AND lease_generation=${Number(leaseGeneration)} AND julianday(lease_expires_at)>=julianday(${sqlText(now)}) AND prepared_result_sha256=${sqlText(node.preparedResultHash)} AND (prepared_requires_integration=0 OR (prepared_integration_status='integrated' AND prepared_integration_receipt_sha256 IS NOT NULL)) AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running');`),
            `UPDATE paper_campaigns SET ${usageSql(usageDelta)},updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(node.campaignId)} AND status='running';`,
            eventRow.sql,
            buildSqliteCampaignProjectionStatement({ campaignId: node.campaignId, now }),
            releaseAuthorityStatement,
          ],
          fallback: 'campaign_node_complete_failed',
          packageDeletionWriterSelector,
          input: {
            node, prepared, now, role, reviewerId, childSessionId, reviewHash,
            promptHash, resolvedModel, nodeId, workerId, attemptId,
            leaseGeneration, usageDelta, eventRow, releasePromotionReceipt,
          },
        });
      } catch (error) {
        if (error?.committed) throw error;
        throw new Error('campaign_node_lease_lost');
      }
      return parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
    },
  };
}
