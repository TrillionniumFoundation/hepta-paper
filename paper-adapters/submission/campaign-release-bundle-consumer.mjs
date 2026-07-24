import { verifyCampaignReleaseAuthorityRecord, verifyCampaignReleaseBundle } from '../../paper-domain/automation/campaign-release-contracts.mjs';
import { createCampaignReleaseQueryCapability } from '../../paper-ports/campaign-release-query-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import path from 'node:path';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { experimentRegistryAuthorityVerifierForReleaseAuthority } from '../persistence/sqlite-campaign-release-query-repository.mjs';

export function verifyCampaignReleaseBundleForSubmission({ releaseAuthority = null, releaseBundle = releaseAuthority?.releaseBundle || null, expected = {}, runtimeRoot = null } = {}) {
  const experimentRegistryAuthorityVerifier = experimentRegistryAuthorityVerifierForReleaseAuthority(releaseAuthority);
  const verification = verifyCampaignReleaseBundle(releaseBundle, expected, { experimentRegistryAuthorityVerifier });
  const blockers = [...verification.blockers];
  if (!releaseAuthority) blockers.push('campaign_release_authority_required');
  else {
    const authorityVerification = verifyCampaignReleaseAuthorityRecord(releaseAuthority, expected, { experimentRegistryAuthorityVerifier });
    blockers.push(...authorityVerification.blockers);
    if (releaseAuthority.releaseBundle !== releaseBundle
      && releaseAuthority.campaignReleaseBundleHash !== releaseBundle?.campaignReleaseBundleHash) {
      blockers.push('campaign_release_authority_bundle_binding_mismatch');
    }
  }
  const output = releaseBundle?.packageOutput;
  const resolvedRuntimeRoot = runtimeRoot ? path.resolve(runtimeRoot) : null;
  if (!resolvedRuntimeRoot) blockers.push('campaign_release_runtime_root_required');
  if (resolvedRuntimeRoot) {
    const releaseRoot = path.resolve(output?.releaseRoot || '.');
    const packageDir = path.resolve(output?.packageDir || '.');
    const legacyPackageScope = isPathWithin(releaseRoot, packageDir);
    const lifecyclePackageScope = path.dirname(packageDir)
      === path.join(resolvedRuntimeRoot, 'packages');
    if (!isPathWithin(resolvedRuntimeRoot, releaseRoot)
      || !isPathWithin(resolvedRuntimeRoot, packageDir)
      || (!legacyPackageScope && !lifecyclePackageScope)) {
      blockers.push('campaign_release_package_output_scope_invalid');
    }
    for (const file of output?.files || []) {
      const candidate = path.resolve(file.path || '.');
      const fileInReleaseScope = isPathWithin(releaseRoot, candidate);
      const fileInPackageScope = isPathWithin(packageDir, candidate);
      if (!fileInReleaseScope && !fileInPackageScope) { blockers.push(`campaign_release_package_output_file_scope_invalid:${file.role || 'unknown'}`); continue; }
      const read = readScopedFileSync({
        scopeRoot: fileInPackageScope ? packageDir : releaseRoot,
        candidate,
      });
      if (read.status !== 'scoped_file_read_verified') blockers.push(`campaign_release_package_output_file_unreadable:${file.role || 'unknown'}`);
      else {
        if (read.hash !== file.hash) blockers.push(`campaign_release_package_output_file_hash_mismatch:${file.role || 'unknown'}`);
        if (Number(read.bytes) !== Number(file.bytes)) blockers.push(`campaign_release_package_output_file_size_mismatch:${file.role || 'unknown'}`);
      }
    }
    const materialization = releaseAuthority?.materializationReceipt;
    const materializedBundlePath = path.resolve(materialization?.path || '.');
    const expectedBundlePath = path.join(releaseRoot, 'CAMPAIGN_RELEASE_BUNDLE.json');
    if (materializedBundlePath !== expectedBundlePath || !isPathWithin(releaseRoot, materializedBundlePath)) {
      blockers.push('campaign_release_materialized_bundle_scope_invalid');
    } else {
      const read = readScopedFileSync({ scopeRoot: releaseRoot, candidate: materializedBundlePath, maximumBytes: 32 * 1024 * 1024 });
      if (read.status !== 'scoped_file_read_verified') blockers.push('campaign_release_materialized_bundle_unreadable');
      else {
        if (read.hash !== materialization?.contentHash) blockers.push('campaign_release_materialized_bundle_hash_mismatch');
        if (Number(read.bytes) !== Number(materialization?.bytes)) blockers.push('campaign_release_materialized_bundle_size_mismatch');
        try {
          const materializedBundle = JSON.parse(read.content.toString('utf8'));
          const materializedVerification = verifyCampaignReleaseBundle(materializedBundle, expected, { experimentRegistryAuthorityVerifier });
          if (!materializedVerification.valid
            || materializedBundle.campaignReleaseBundleHash !== releaseBundle?.campaignReleaseBundleHash) {
            blockers.push('campaign_release_materialized_bundle_content_invalid');
          }
        } catch {
          blockers.push('campaign_release_materialized_bundle_content_invalid');
        }
      }
    }
  }
  const payload = {
    version: 1,
    kind: 'SubmissionCampaignReleaseVerificationReceipt',
    status: blockers.length === 0 ? 'submission_campaign_release_verified' : 'submission_campaign_release_blocked',
    campaignId: releaseBundle?.campaignId || null,
    paperId: releaseBundle?.paperId || null,
    venueTarget: releaseBundle?.venueTarget || null,
    campaignPlanHash: releaseBundle?.campaignPlanHash || null,
    packageNodeId: releaseBundle?.packageNodeId || null,
    packageAttemptId: releaseBundle?.packageAttemptId || null,
    leaseGeneration: releaseAuthority?.leaseGeneration || null,
    packageResultHash: releaseAuthority?.packageResultHash || null,
    integrationDescriptorHash: releaseAuthority?.integrationDescriptorHash || null,
    integrationReceiptHash: releaseAuthority?.integrationReceiptHash || null,
    campaignReleaseBundleHash: releaseBundle?.campaignReleaseBundleHash || null,
    campaignReleasePromotionReceiptHash: releaseAuthority?.promotionReceipt?.campaignReleasePromotionReceiptHash || null,
    artifactPackageHash: releaseBundle?.artifactPackageHash || null,
    packageVerificationReceiptHash: releaseBundle?.packageVerificationReceiptHash || null,
    verifiedSourceMerkleHash: releaseBundle?.verifiedSourceMerkleHash || null,
    verifiedSourceWorkspaceManifestHash: releaseBundle?.verifiedSourceWorkspaceManifestHash || null,
    campaignResearchSourceSnapshotHash: releaseBundle?.campaignResearchSourceSnapshotHash || null,
    experimentRegistryHash: releaseBundle?.experimentRegistryHash || null,
    researchVerifyNodeId: releaseBundle?.researchVerifyNodeId || null,
    researchVerifyAttemptId: releaseBundle?.researchVerifyAttemptId || null,
    researchVerifyLeaseGeneration: releaseBundle?.researchVerifyLeaseGeneration || null,
    sourceAuthority: 'immutable_generated_source_zip',
    mutableSourceWorkspaceConsulted: false,
    blockers: [...new Set(blockers)],
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, submissionCampaignReleaseVerificationReceiptHash: hashRecord('SubmissionCampaignReleaseVerificationReceipt', payload) });
}

export function consumeCampaignReleaseBundleForSubmission(options = {}) {
  if (options.releaseBundle) throw new Error('campaign_release_raw_bundle_consumption_forbidden');
  const releaseQuery = createCampaignReleaseQueryCapability(
    options.releaseAuthorityQuery || options.releaseAuthorityRepository,
  );
  const campaignId = options.campaignId || options.expected?.campaignId;
  if (!campaignId) throw new Error('campaign_release_submission_campaign_id_required');
  const releaseAuthority = releaseQuery.getCurrentRelease({ campaignId, ...(options.expected || {}) });
  const releaseBundle = releaseAuthority?.releaseBundle || null;
  const verificationReceipt = verifyCampaignReleaseBundleForSubmission({ ...options, releaseAuthority, releaseBundle });
  if (verificationReceipt.status !== 'submission_campaign_release_verified') {
    const error = new Error(`submission_campaign_release_blocked:${verificationReceipt.blockers.join(',')}`);
    error.code = 'submission_campaign_release_blocked';
    error.receipt = verificationReceipt;
    throw error;
  }
  const payload = {
    version: 1,
    kind: 'CampaignReleaseSubmissionInput',
    status: 'campaign_release_submission_input_ready',
    campaignReleaseBundleHash: releaseBundle.campaignReleaseBundleHash,
    venueTarget: releaseBundle.venueTarget || null,
    campaignReleasePromotionReceiptHash: releaseAuthority.promotionReceipt.campaignReleasePromotionReceiptHash,
    submissionCampaignReleaseVerificationReceiptHash: verificationReceipt.submissionCampaignReleaseVerificationReceiptHash,
    artifactPackageHash: releaseBundle.artifactPackageHash,
    packageVerificationReceiptHash: releaseBundle.packageVerificationReceiptHash,
    manuscriptPromotionGateHash: releaseBundle.manuscriptPromotionGateHash,
    verifiedSourceMerkleHash: releaseBundle.verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash: releaseBundle.verifiedSourceWorkspaceManifestHash,
    campaignResearchSourceSnapshotHash: releaseBundle.campaignResearchSourceSnapshotHash || null,
    experimentRegistryHash: releaseBundle.experimentRegistryHash || null,
    researchVerifyNodeId: releaseBundle.researchVerifyNodeId || null,
    researchVerifyAttemptId: releaseBundle.researchVerifyAttemptId || null,
    researchVerifyLeaseGeneration: releaseBundle.researchVerifyLeaseGeneration || null,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    campaignReleaseSubmissionInputHash: hashRecord('CampaignReleaseSubmissionInput', payload),
    verificationReceipt,
    artifactPackage: releaseBundle.artifactPackage,
    packageResult: Object.freeze({
      version: 1,
      kind: 'ConsumedCampaignReleasePackageResult',
      status: 'package_ready',
      submitReady: true,
      artifactPackage: releaseBundle.artifactPackage,
      packageVerificationReceipt: releaseBundle.packageVerificationReceipt,
      manuscriptPromotionGate: releaseBundle.manuscriptPromotionGate,
      releaseBundle,
      releaseAuthority,
    }),
    releaseAuthority,
  });
}
