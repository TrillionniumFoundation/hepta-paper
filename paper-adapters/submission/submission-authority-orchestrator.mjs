import path from 'node:path';
import { buildSemanticPromotionLock } from '../../paper-domain/submission/semantic-promotion-lock.mjs';
import { buildReviewedVenueEvidence } from '../../paper-domain/submission/reviewed-venue-evidence.mjs';
import { buildReviewedSubmissionDecisionPacket } from '../../paper-domain/submission/reviewed-submission-decision.mjs';
import { loadAuthorityTrustStore } from '../authority/authority-signatures.mjs';
import { verifyIndependentRefereeAuthority } from '../referee-review/independent-authority.mjs';
import { consumeCampaignReleaseBundleForSubmission } from './campaign-release-bundle-consumer.mjs';
import { verifyLiveSubmissionAuthorization } from './live-authorization.mjs';
import { buildSubmissionVenuePlan } from './submission-venue-plan.mjs';
import { verifyReviewedVenueObservationSource } from './venue-observation-verification.mjs';

export async function prepareSubmissionAuthorities({
  root,
  runtimeRoot,
  row,
  venues = [],
  artifactPackage = null,
  packageResult = null,
  researchReport = null,
  targetScopeReceipt = null,
  mode = 'reviewed-submit',
  trustStoreOverride = null,
  now = new Date(),
  authorityVerifier = null,
  executorDescriptor = null,
  submissionMetadata = null,
  submissionMetadataReview = null,
  venuePreflightObservation = null,
  signedVenueObservation = null,
  receiptLedger = null,
  redrivePlan = null,
  redriveDecision = null,
  providerCapabilityVerificationReceipt = null,
  campaignReleaseAuthorityRepository = null,
} = {}) {
  const sourceRoot = row?.task?.sourceWorkspace
    ? (path.isAbsolute(row.task.sourceWorkspace)
      ? row.task.sourceWorkspace
      : path.join(root, row.task.sourceWorkspace))
    : null;
  const campaignReleaseSubmissionInput = packageResult?.releaseBundle
    ? consumeCampaignReleaseBundleForSubmission({
      releaseAuthorityRepository: campaignReleaseAuthorityRepository,
      campaignId: packageResult.campaignId || packageResult.releaseBundle.campaignId,
      expected: { campaignId: packageResult.campaignId || packageResult.releaseBundle.campaignId, paperId: row?.task?.paperId || null },
      runtimeRoot,
      sourceScopeRoots: [root, runtimeRoot, sourceRoot].filter(Boolean),
    })
    : null;
  if (campaignReleaseSubmissionInput) {
    if (artifactPackage?.artifactPackageHash
      && artifactPackage.artifactPackageHash !== campaignReleaseSubmissionInput.artifactPackage.artifactPackageHash) {
      throw new Error('submission_campaign_release_artifact_package_mismatch');
    }
    artifactPackage = campaignReleaseSubmissionInput.artifactPackage;
    packageResult = campaignReleaseSubmissionInput.packageResult;
  }
  const venuePlan = buildSubmissionVenuePlan({ row, venues, artifactPackage, mode });
  const promotionGate = packageResult?.manuscriptPromotionGate || null;
  const semanticPromotionLock = buildSemanticPromotionLock({
    paperTask: row.task,
    targetScopeReceipt,
    artifactPackage,
    packageVerificationReceipt: packageResult?.packageVerificationReceipt || null,
    researchReport,
    promotionGate,
    venuePlan,
  });
  const verifyIndependent = authorityVerifier?.verifyIndependentReferee || verifyIndependentRefereeAuthority;
  const verifyLive = authorityVerifier?.verifyLiveAuthorization || verifyLiveSubmissionAuthorization;
  const independentReviewAuthorityReceipt = await verifyIndependent({
    root,
    runtimeRoot,
    sourceRoot,
    paperTask: row.task,
    researchReport,
    artifactPackage,
    venuePlan,
    semanticPromotionLock,
    trustStoreOverride,
    now,
  });
  const submissionDecisionPacket = buildReviewedSubmissionDecisionPacket({
    paperTask: row.task,
    venuePlan,
    metadata: submissionMetadata,
    review: submissionMetadataReview,
  });
  const trustStore = await loadAuthorityTrustStore({ runtimeRoot, trustStoreOverride });
  const venueObservationSourceVerificationReceipt = verifyReviewedVenueObservationSource({
    paperTask: row.task,
    venuePlan,
    observation: venuePreflightObservation,
    signedObservation: signedVenueObservation,
    receiptLedger,
    trustStore,
    now,
  });
  const reviewedVenueEvidence = buildReviewedVenueEvidence({
    paperTask: row.task,
    venuePlan,
    observation: venuePreflightObservation,
    now,
    sourceVerificationReceipt: venueObservationSourceVerificationReceipt,
  });
  const liveAuthorizationReceipt = await verifyLive({
    root,
    runtimeRoot,
    paperTask: row.task,
    artifactPackage,
    researchReport,
    independentReviewAuthorityReceipt,
    venuePlan,
    semanticPromotionLock,
    trustStoreOverride,
    now,
    executorDescriptor,
    submissionDecisionPacket,
    reviewedVenueEvidence,
    redrivePlan,
    redriveDecision,
    venueObservationSourceVerificationReceipt,
    providerCapabilityVerificationReceipt,
  });
  return {
    venuePlan,
    promotionGate,
    semanticPromotionLock,
    independentReviewAuthorityReceipt,
    liveAuthorizationReceipt,
    submissionDecisionPacket,
    venueObservationSourceVerificationReceipt,
    reviewedVenueEvidence,
    campaignReleaseSubmissionInput,
  };
}
