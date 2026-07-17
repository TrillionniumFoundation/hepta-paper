import { verifyCampaignReleaseAuthorityRecord } from '../../paper-domain/automation/campaign-release-contracts.mjs';
import { assertCampaignReleaseQueryPort } from '../../paper-ports/campaign-release-query-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { parseJsonOrThrow } from '../../workflow-kernel/runtime/data-utils.mjs';
import { createExperimentRegistryAuthorityVerifier } from '../../paper-domain/research/experiment-registry-authority.mjs';
import { verifyArtifactWriteReceiptSource } from '../artifacts/artifact-write-receipt-verifier.mjs';
import { createIndependentRawEventArtifactRecomputationVerifier } from '../research-verify/raw-event-artifact-recomputation-verifier.mjs';

const RELEASE_AUTHORITY_VERIFIERS = new WeakMap();

export function experimentRegistryAuthorityVerifierForReleaseAuthority(record) {
  return record && RELEASE_AUTHORITY_VERIFIERS.get(record) || null;
}

function authorityFromRow(row, experimentRegistryAuthorityVerifier) {
  if (!row) return null;
  const releaseBundle = parseJsonOrThrow(row.release_bundle_json, 'campaign_release_authority_bundle_json_invalid');
  const promotionReceipt = parseJsonOrThrow(row.promotion_receipt_json, 'campaign_release_authority_promotion_json_invalid');
  const packageResult = parseJsonOrThrow(row.result_json, 'campaign_release_authority_result_json_invalid');
  const integrationReceipt = parseJsonOrThrow(row.prepared_integration_receipt_json, 'campaign_release_authority_integration_receipt_json_invalid');
  const { workspaceAttemptIntegrationReceiptHash: claimedIntegrationHash, ...integrationPayload } = integrationReceipt;
  if (!claimedIntegrationHash
    || claimedIntegrationHash !== row.integration_receipt_hash
    || hashRecord('WorkspaceAttemptIntegrationReceipt', integrationPayload) !== claimedIntegrationHash
    || integrationReceipt.descriptorHash !== row.integration_descriptor_hash) {
    throw new Error('campaign_release_authority_integration_receipt_invalid');
  }
  if (hashRecord('PaperCampaignNodeResult', packageResult) !== row.package_result_hash
    || packageResult.campaignReleaseBundleHash !== row.campaign_release_bundle_hash
    || packageResult.campaignReleaseBundleMaterializationReceiptHash !== row.materialization_receipt_hash) {
    throw new Error('campaign_release_authority_result_binding_invalid');
  }
  const record = Object.freeze({
    version: 1,
    kind: 'CurrentCampaignReleaseAuthority',
    status: row.release_status,
    campaignId: row.campaign_id,
    paperId: row.paper_id,
    venueTarget: releaseBundle.venueTarget || null,
    campaignPlanHash: row.campaign_plan_hash,
    packageNodeId: row.package_node_id,
    packageAttemptId: row.package_attempt_id,
    leaseGeneration: Number(row.lease_generation),
    packageResultHash: row.package_result_hash,
    integrationDescriptorHash: row.integration_descriptor_hash,
    integrationReceiptHash: row.integration_receipt_hash,
    campaignReleaseBundleHash: row.campaign_release_bundle_hash,
    verifiedSourceMerkleHash: promotionReceipt.verifiedSourceMerkleHash || null,
    verifiedSourceWorkspaceManifestHash: promotionReceipt.verifiedSourceWorkspaceManifestHash || null,
    campaignResearchSourceSnapshotHash: promotionReceipt.campaignResearchSourceSnapshotHash || null,
    experimentRegistryHash: promotionReceipt.experimentRegistryHash || null,
    empiricalAssertionAuthorityHash: promotionReceipt.empiricalAssertionAuthorityHash || null,
    empiricalAssertionUniverseHash: promotionReceipt.empiricalAssertionUniverseHash || null,
    empiricalAssertionUniverseBindingHash: promotionReceipt.empiricalAssertionUniverseBindingHash || null,
    empiricalAssertionManuscriptCorpusHash: promotionReceipt.empiricalAssertionManuscriptCorpusHash || null,
    researchVerifyNodeId: promotionReceipt.researchVerifyNodeId || null,
    researchVerifyAttemptId: promotionReceipt.researchVerifyAttemptId || null,
    researchVerifyLeaseGeneration: promotionReceipt.researchVerifyLeaseGeneration || null,
    materializationReceiptHash: row.materialization_receipt_hash,
    packageNodeStatus: row.live_node_status,
    campaignStatus: row.live_campaign_status,
    packageCompletedAt: row.package_completed_at,
    promotedAt: row.promoted_at,
    nodeRevision: Number(row.node_revision),
    promotionReceipt,
    materializationReceipt: packageResult.materializationReceipt || null,
    releaseBundle,
  });
  const verification = verifyCampaignReleaseAuthorityRecord(record, {}, { experimentRegistryAuthorityVerifier });
  if (!verification.valid) throw new Error(`campaign_release_authority_record_invalid:${verification.blockers.join(',')}`);
  if (promotionReceipt.campaignReleasePromotionReceiptHash !== row.promotion_receipt_hash) {
    throw new Error('campaign_release_authority_promotion_hash_binding_invalid');
  }
  RELEASE_AUTHORITY_VERIFIERS.set(record, experimentRegistryAuthorityVerifier);
  return record;
}

const CURRENT_RELEASE_SQL = `SELECT r.*,r.status AS release_status,n.status AS live_node_status,c.status AS live_campaign_status,
    n.node_revision,n.result_json,n.prepared_integration_receipt_json
  FROM campaign_current_releases r
  JOIN paper_campaigns c ON c.campaign_id=r.campaign_id
  JOIN campaign_nodes n ON n.node_id=r.package_node_id AND n.campaign_id=r.campaign_id
  WHERE r.campaign_id=?
    AND r.status='current_completed_release' AND r.package_node_status='completed' AND r.campaign_status='completed'
    AND c.status='completed' AND c.paper_id=r.paper_id
    AND json_extract(c.spec_json,'$.campaignPlanHash')=r.campaign_plan_hash
    AND n.kind='package' AND n.status='completed'
    AND n.attempt_id=r.package_attempt_id AND n.lease_generation=r.lease_generation
    AND n.result_sha256=r.package_result_hash
    AND n.prepared_integration_status='integrated'
    AND n.prepared_integration_key=r.integration_descriptor_hash
    AND n.prepared_integration_receipt_sha256=r.integration_receipt_hash
    AND json_extract(n.result_json,'$.campaignReleaseBundleHash')=r.campaign_release_bundle_hash
    AND json_extract(n.result_json,'$.campaignReleaseBundleMaterializationReceiptHash')=r.materialization_receipt_hash
  LIMIT 1;`;

export function createSqliteCampaignReleaseQueryRepository({
  store,
  receiptLedger = null,
  artifactVerifier = verifyArtifactWriteReceiptSource,
  rawEventRecomputationVerifier: suppliedRawEventRecomputationVerifier = null,
  operatorDatasetHarnessAuthorityVerifier = null,
  runtimeRoot = null,
  operatorDatasetAuthorityTrustStoreProvider = null,
  clock = { now: () => new Date() },
} = {}) {
  if (typeof store?.query !== 'function') throw new Error('Campaign release query repository requires query capability');
  const readOnlyReceiptLedger = receiptLedger || Object.freeze({
    get(receiptId) {
      return store.query('SELECT * FROM effective_receipt_ledger WHERE receipt_id=? LIMIT 1;', [receiptId]).rows?.[0] || null;
    },
  });
  const rawEventRecomputationVerifier = suppliedRawEventRecomputationVerifier
    || createIndependentRawEventArtifactRecomputationVerifier({
      runtimeRoot,
      trustStoreProvider: operatorDatasetAuthorityTrustStoreProvider,
      clock,
    });
  const experimentRegistryAuthorityVerifier = createExperimentRegistryAuthorityVerifier({
    receiptLedger: readOnlyReceiptLedger,
    artifactVerifier,
    rawEventRecomputationVerifier,
    operatorDatasetHarnessAuthorityVerifier,
  });
  return Object.freeze(assertCampaignReleaseQueryPort({
    version: 1,
    kind: 'SqliteCampaignReleaseQueryRepository',
    getCurrentRelease({ campaignId, ...expected } = {}) {
      if (!campaignId) throw new Error('campaign_release_authority_campaign_id_required');
      const result = store.query(CURRENT_RELEASE_SQL, [campaignId]);
      if (!result?.ok) throw new Error(result?.error || 'campaign_release_authority_query_failed');
      const record = authorityFromRow(result.rows?.[0], experimentRegistryAuthorityVerifier);
      if (!record) return null;
      const verification = verifyCampaignReleaseAuthorityRecord(record, { campaignId, ...expected }, { experimentRegistryAuthorityVerifier });
      if (!verification.valid) throw new Error(`campaign_release_authority_mismatch:${verification.blockers.join(',')}`);
      return record;
    },
  }));
}
