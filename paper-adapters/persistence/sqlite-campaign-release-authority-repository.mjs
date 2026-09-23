import { createCampaignReleasePromotionReceipt } from '../../paper-domain/automation/campaign-release-contracts.mjs';
import { assertCampaignReleaseAuthorityPort } from '../../paper-ports/campaign-release-authority-port.mjs';
import { sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import { parseJsonOrThrow } from '../../workflow-kernel/runtime/data-utils.mjs';
import { createSqliteCampaignReleaseQueryRepository } from './sqlite-campaign-release-query-repository.mjs';
import { createExperimentRegistryAuthorityVerifier } from '../../paper-domain/research/experiment-registry-authority.mjs';
import { verifyArtifactWriteReceiptSource } from '../artifacts/artifact-write-receipt-verifier.mjs';
import { createIndependentRawEventArtifactRecomputationVerifier } from '../research-verify/raw-event-artifact-recomputation-verifier.mjs';
import {
  NATIVE_STORE_QUALITY_RELEASE_STATEMENT_IDS,
} from './native-store-quality-release-mutation-plan.mjs';

export function createSqliteCampaignReleaseAuthorityRepository({
  store,
  receiptLedger = null,
  clock = { now: () => new Date(), nowIso: () => new Date().toISOString() },
  operatorDatasetHarnessAuthorityVerifier = null,
  runtimeRoot = null,
  operatorDatasetAuthorityTrustStoreProvider = null,
  gpuScientificPromotionAuthorityVerifier = null,
} = {}) {
  if (!store?.query || !store?.execute) throw new Error('Campaign release authority repository requires StorePort');
  const readOnlyReceiptLedger = receiptLedger || Object.freeze({
    get(receiptId) {
      return store.query('SELECT * FROM effective_receipt_ledger WHERE receipt_id=? LIMIT 1;', [receiptId]).rows?.[0] || null;
    },
  });
  const rawEventRecomputationVerifier = createIndependentRawEventArtifactRecomputationVerifier({
    runtimeRoot,
    trustStoreProvider: operatorDatasetAuthorityTrustStoreProvider,
    clock,
  });
  const experimentRegistryAuthorityVerifier = createExperimentRegistryAuthorityVerifier({
    receiptLedger: readOnlyReceiptLedger,
    artifactVerifier: verifyArtifactWriteReceiptSource,
    rawEventRecomputationVerifier,
    operatorDatasetHarnessAuthorityVerifier,
  });
  const releaseQuery = createSqliteCampaignReleaseQueryRepository({
    store,
    receiptLedger: readOnlyReceiptLedger,
    operatorDatasetHarnessAuthorityVerifier,
    runtimeRoot,
    operatorDatasetAuthorityTrustStoreProvider,
    gpuScientificPromotionAuthorityVerifier,
    clock,
    rawEventRecomputationVerifier,
  });
  const repository = {
    version: 1,
    kind: 'SqliteCampaignReleaseAuthorityRepository',
    getCurrentRelease: releaseQuery.getCurrentRelease,
    promoteCompletedRelease({ campaignId } = {}) {
      if (!campaignId) throw new Error('campaign_release_authority_campaign_id_required');
      const current = repository.getCurrentRelease({ campaignId });
      if (current) return current;
      const source = store.query(`SELECT c.campaign_id AS authority_campaign_id,c.paper_id,c.spec_json AS campaign_spec_json,
          n.node_id,n.attempt_id,n.lease_generation,n.result_json,n.result_sha256,n.prepared_integration_status,
          n.prepared_integration_key,n.prepared_integration_receipt_sha256,n.integrated_at,n.updated_at
        FROM paper_campaigns c JOIN campaign_nodes n ON n.campaign_id=c.campaign_id
        WHERE c.campaign_id=${sqlText(campaignId)} AND c.status='completed' AND n.kind='package' AND n.status='completed'
        ORDER BY n.updated_at DESC,n.node_id LIMIT 1;`);
      if (!source.ok) throw new Error(source.error || 'campaign_release_authority_source_query_failed');
      const row = source.rows?.[0];
      if (!row) throw new Error('campaign_release_completed_package_not_found');
      const packageResult = parseJsonOrThrow(row.result_json, 'campaign_release_authority_result_json_invalid');
      const packageNode = {
        nodeId: row.node_id,
        attemptId: row.attempt_id,
        leaseGeneration: Number(row.lease_generation),
        preparedResultHash: row.result_sha256,
        preparedIntegrationStatus: row.prepared_integration_status,
        preparedIntegrationKey: row.prepared_integration_key,
        preparedIntegrationReceiptHash: row.prepared_integration_receipt_sha256,
      };
      const campaign = {
        campaignId: row.authority_campaign_id,
        paperId: row.paper_id,
        spec: parseJsonOrThrow(row.campaign_spec_json, 'campaign_release_authority_campaign_spec_invalid'),
      };
      const promotedAt = row.integrated_at || row.updated_at || clock.nowIso();
      const promotion = createCampaignReleasePromotionReceipt({
        campaign,
        packageNode,
        packageResult,
        promotedAt,
        experimentRegistryAuthorityVerifier,
        gpuScientificPromotionAuthorityVerifier,
      });
      const packageDeletionWriterSelector = Object.freeze({
        packagePath: packageResult.releaseBundle.packageOutput.packageDir,
      });
      let insert;
      if (typeof store.mutate === 'function') {
        insert = store.mutate({
          databaseRole: 'native-store',
          operationId:
            'native-store.campaign-release-authority-repository.promoteCompletedRelease.v1',
          authorizationReceiptHashes: [],
          sideEffectReservationHashes: [],
          packageDeletionWriterSelector,
          mutate: (transaction) => transaction.run(
            NATIVE_STORE_QUALITY_RELEASE_STATEMENT_IDS
              .insertCurrentCampaignRelease,
            promotion.campaignId,
            promotion.paperId,
            promotion.campaignPlanHash,
            promotion.packageNodeId,
            promotion.packageAttemptId,
            promotion.leaseGeneration,
            promotion.packageResultHash,
            promotion.integrationDescriptorHash,
            promotion.integrationReceiptHash,
            promotion.campaignReleaseBundleHash,
            promotion.materializationReceiptHash,
            JSON.stringify(packageResult.releaseBundle),
            JSON.stringify(promotion),
            promotion.campaignReleasePromotionReceiptHash,
            promotion.packageCompletedAt,
            promotion.promotedAt,
            promotion.packageNodeId,
            promotion.campaignId,
            promotion.packageAttemptId,
            promotion.leaseGeneration,
            promotion.packageResultHash,
            promotion.integrationDescriptorHash,
            promotion.integrationReceiptHash,
            promotion.paperId,
            promotion.campaignPlanHash,
          ).changes,
        });
        if (![
          'externally_fenced_sqlite_mutation_finalized',
          'externally_fenced_sqlite_mutation_no_change',
        ].includes(insert?.status) || ![0, 1].includes(insert.value)) {
          throw new Error('campaign_release_authority_external_mutation_receipt_invalid');
        }
      } else {
        insert = store.execute(`BEGIN IMMEDIATE;
        INSERT OR IGNORE INTO campaign_current_releases(
          campaign_id,paper_id,campaign_plan_hash,package_node_id,package_attempt_id,lease_generation,
          package_result_hash,integration_descriptor_hash,integration_receipt_hash,campaign_release_bundle_hash,
          materialization_receipt_hash,release_bundle_json,promotion_receipt_json,promotion_receipt_hash,
          package_node_status,campaign_status,package_completed_at,promoted_at,status
        ) SELECT ${sqlText(promotion.campaignId)},${sqlText(promotion.paperId)},${sqlText(promotion.campaignPlanHash)},
          ${sqlText(promotion.packageNodeId)},${sqlText(promotion.packageAttemptId)},${promotion.leaseGeneration},
          ${sqlText(promotion.packageResultHash)},${sqlText(promotion.integrationDescriptorHash)},${sqlText(promotion.integrationReceiptHash)},
          ${sqlText(promotion.campaignReleaseBundleHash)},${sqlText(promotion.materializationReceiptHash)},${sqlJson(packageResult.releaseBundle)},
          ${sqlJson(promotion)},${sqlText(promotion.campaignReleasePromotionReceiptHash)},'completed','completed',
          ${sqlText(promotion.packageCompletedAt)},${sqlText(promotion.promotedAt)},'current_completed_release'
        WHERE EXISTS(SELECT 1 FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id
          WHERE n.node_id=${sqlText(promotion.packageNodeId)} AND n.campaign_id=${sqlText(promotion.campaignId)}
            AND n.kind='package' AND n.status='completed' AND n.attempt_id=${sqlText(promotion.packageAttemptId)}
            AND n.lease_generation=${promotion.leaseGeneration} AND n.result_sha256=${sqlText(promotion.packageResultHash)}
            AND n.prepared_integration_status='integrated' AND n.prepared_integration_key=${sqlText(promotion.integrationDescriptorHash)}
            AND n.prepared_integration_receipt_sha256=${sqlText(promotion.integrationReceiptHash)}
            AND c.status='completed' AND c.paper_id=${sqlText(promotion.paperId)}
            AND json_extract(c.spec_json,'$.campaignPlanHash')=${sqlText(promotion.campaignPlanHash)});
        COMMIT;`, { packageDeletionWriterSelector });
        if (!insert.ok) throw new Error(insert.error || 'campaign_release_authority_promotion_failed');
      }
      const promoted = repository.getCurrentRelease({ campaignId });
      if (!promoted) throw new Error('campaign_release_authority_promotion_not_current');
      return promoted;
    },
  };
  return Object.freeze(assertCampaignReleaseAuthorityPort(repository));
}
