import { verifyProposalClaimToTheoremBinding } from '../research/proposal-claim-to-theorem-binding.mjs';
import { hashPaperRecord } from '../contracts/primitives.mjs';
import {
  formalClosureClaimBindingsFromProposalBinding,
  verifyGenericFormalCertificateIntakeClosureBinding,
  verifyNativeFormalResearchClosureBinding,
} from '../research/formal-certificate-intake.mjs';
import {
  BOUNDED_CAPABILITY_QUALIFICATION_SCOPE,
  PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE,
  verifyAutonomousResearchReleaseBinding,
} from './autonomous-research-release-binding-contract.mjs';
import {
  inspectAutonomousResearchReleaseReviewerEvidence,
} from './autonomous-research-release-reviewer-evidence-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export const MANUSCRIPT_RELEASE_PROOF_FIELDS = Object.freeze([
  'trustedAutonomousManuscriptRenderReceiptHash',
  'evidenceBoundManuscriptIrHash',
  'manuscriptIrFileHash',
  'renderedManuscriptHash',
  'agentExecutionReceiptHash',
  'isolatedAgentMergeReceiptHash',
  'agentAuthoredSourceDraftHash',
  'agentAuthoredSourceDraftFileHash',
  'agentWorkspacePostimageBindingHash',
  'venueProfileSelectionHash',
  'submissionMetadataReceiptHash',
]);
const REQUIRED_MANUSCRIPT_RELEASE_PROOF_FIELDS = Object.freeze(
  MANUSCRIPT_RELEASE_PROOF_FIELDS.filter((field) => ![
    'venueProfileSelectionHash',
    'submissionMetadataReceiptHash',
  ].includes(field)),
);

function formalProposalBindingMatchesReleaseAuthority(proposalBinding, releaseBinding) {
  return proposalBinding?.paperId === releaseBinding?.paperId
    && proposalBinding?.campaignId === releaseBinding?.campaignId
    && SHA256.test(String(releaseBinding?.seedBindingHash || ''))
    && proposalBinding?.claimAuthorityBindingHash === releaseBinding.seedBindingHash
    && SHA256.test(String(
      releaseBinding?.trustedAutonomousManuscriptRenderReceipt?.seedBundleHash || '',
    ))
    && proposalBinding?.claimAuthorityBundleHash
      === releaseBinding.trustedAutonomousManuscriptRenderReceipt.seedBundleHash;
}

function formalProposalBindingMatchesRelease(proposalBinding, releaseBinding) {
  const formalClaims = (releaseBinding?.proposal?.claims || []).filter((claim) => (
    claim?.verificationMode === 'formal_kernel'
  ));
  const entries = proposalBinding?.entries || [];
  if (formalClaims.length !== 1 || entries.length !== 1) return false;
  const claim = formalClaims[0];
  const entry = entries[0];
  return formalProposalBindingMatchesReleaseAuthority(proposalBinding, releaseBinding)
    && entry?.scientificClaimKey === claim?.claimKey
    && entry?.proposalClaimText === claim?.statement
    && entry?.theoremStatement === claim?.statement
    && JSON.stringify(entry?.proofObligations)
      === JSON.stringify(claim?.proofObligations);
}

export function inspectAutonomousResearchReleaseQualificationScope({
  authority,
  receipt,
  allowBoundedGoldenCapability = false,
} = {}) {
  const bundle = authority?.releaseBundle || null;
  const releaseBinding = bundle?.autonomousResearchReleaseBinding || null;
  const bindingVerification = verifyAutonomousResearchReleaseBinding(releaseBinding, {
    campaignId: authority?.campaignId,
    paperId: authority?.paperId,
    campaignPlanHash: bundle?.campaignPlanHash,
  });
  const productionScope = releaseBinding?.qualificationScope
    === PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE
    && releaseBinding?.fullResearchQualificationEligible === true;
  const boundedGoldenScope = allowBoundedGoldenCapability
    && releaseBinding?.qualificationScope === BOUNDED_CAPABILITY_QUALIFICATION_SCOPE
    && releaseBinding?.launchMode === 'golden-bootstrap'
    && releaseBinding?.fullResearchQualificationEligible === false
    && releaseBinding?.genericContentCanaryVerified === true
    && Boolean(releaseBinding?.globalGoldenQualificationAuthorityHash);
  const blockers = [];
  if (!bindingVerification.valid || (!productionScope && !boundedGoldenScope)
    || receipt?.qualificationScope !== releaseBinding?.qualificationScope
    || receipt?.genericContentCanaryVerified
      !== releaseBinding?.genericContentCanaryVerified) {
    blockers.push('research_release_qualification_scope_invalid');
  }
  if (MANUSCRIPT_RELEASE_PROOF_FIELDS.some((field) => (
    (receipt?.[field] || null) !== (releaseBinding?.[field] || null)
  )) || (productionScope && REQUIRED_MANUSCRIPT_RELEASE_PROOF_FIELDS.some(
    (field) => !SHA256.test(String(receipt?.[field] || '')),
  )) || (releaseBinding?.externalSubmissionEligible === true && [
    'venueProfileSelectionHash',
    'submissionMetadataReceiptHash',
  ].some(
    (field) => !SHA256.test(String(receipt?.[field] || '')),
  ))) {
    blockers.push('research_release_manuscript_proof_mismatch');
  }
  return Object.freeze({
    valid: blockers.length === 0,
    releaseBinding,
    productionScope,
    boundedGoldenScope,
    blockers: Object.freeze(blockers),
  });
}

export function inspectSuccessfulFullResearchRelease({
  authority,
  receipt,
  issuedAt,
  maximumReceiptAgeMs,
  allowBoundedGoldenCapability = false,
  runtimePrincipalBinding = null,
  reviewerEvidenceAuthority = null,
} = {}) {
  const blockers = [];
  if (!authority || authority.status !== 'current_completed_release'
    || authority.campaignStatus !== 'completed' || authority.packageNodeStatus !== 'completed') {
    return Object.freeze({
      bundle: null,
      blockers: Object.freeze(['golden_micro_campaign_current_completed_release_required']),
    });
  }
  const bundle = authority.releaseBundle;
  const scope = inspectAutonomousResearchReleaseQualificationScope({
    authority, receipt, allowBoundedGoldenCapability,
  });
  if (scope.blockers.includes('research_release_qualification_scope_invalid')) {
    blockers.push('golden_micro_campaign_release_qualification_scope_invalid');
  }
  if (scope.blockers.includes('research_release_manuscript_proof_mismatch')) {
    blockers.push('golden_micro_campaign_manuscript_release_proof_mismatch');
  }
  if (scope.productionScope) {
    const reviewerEvidenceInspection = inspectAutonomousResearchReleaseReviewerEvidence(
      scope.releaseBinding?.releaseReviewerEvidence,
      {
        runtimePrincipalBinding,
        reviewerEvidenceAuthority,
        expected: {
          campaignId: authority?.campaignId,
          paperId: authority?.paperId,
          campaignPlanHash: bundle?.campaignPlanHash,
          expectedManuscriptHash: scope.releaseBinding?.renderedManuscriptHash,
        },
      },
    );
    if (!reviewerEvidenceInspection.valid) {
      blockers.push('golden_micro_campaign_reviewer_evidence_invalid');
    }
  }
  if (authority.campaignId !== receipt?.campaignId || authority.paperId !== receipt?.paperId
    || authority.campaignReleaseBundleHash !== receipt?.campaignReleaseBundleHash
    || bundle?.campaignReleaseBundleHash !== receipt?.campaignReleaseBundleHash) {
    blockers.push('golden_micro_campaign_release_pointer_mismatch');
  }
  if (bundle?.status !== 'campaign_release_bundle_prepared'
    || bundle?.researchReport?.promotionEligibility?.status !== 'research_promotion_ready') {
    blockers.push('golden_micro_campaign_research_promotion_not_ready');
  }
  const manifest = bundle?.researchEvidenceCapsuleManifest;
  if (manifest?.status !== 'research_evidence_capsule_ready'
    || Number(manifest?.academicExperimentCount) < 1
    || Number(manifest?.academicExperimentCount) !== Number(manifest?.experimentCount)
    || !Array.isArray(manifest?.experiments) || !manifest.experiments.length
    || manifest.experiments.some((experiment) => experiment?.academicPromotionEligible !== true)) {
    blockers.push('golden_micro_campaign_academic_empirical_release_required');
  }
  if (!Array.isArray(manifest?.experiments) || !manifest.experiments.length
    || manifest.experiments.some((experiment) => (
      experiment?.independentRecomputationImplementationVerified !== true
      || experiment?.recomputationIndependenceLevel
        !== 'repository-separate-implementation-same-process-v1'
      || !SHA256.test(String(experiment?.rawEventRecomputationIndependenceContractHash || ''))
      || experiment?.recomputationProcessIndependent !== false
    ))) {
    blockers.push('golden_micro_campaign_recomputation_implementation_independence_required');
  }
  const report = bundle?.researchReport;
  const proposalBinding = report?.capabilities?.proposalClaimToTheoremBinding || null;
  const proposalVerification = verifyProposalClaimToTheoremBinding(proposalBinding || {});
  const researchSourceSnapshotHash = bundle?.campaignResearchSourceSnapshotHash || null;
  const expectedClaimBindings =
    formalClosureClaimBindingsFromProposalBinding(proposalBinding);
  const formalIntakes = report?.capabilities?.formalCertificateIntakes;
  const formalReplays = report?.capabilities?.formalReplayReceipts;
  const nativeFormalVerification = verifyNativeFormalResearchClosureBinding(
    report?.nativeResearchWorkerExecution,
    {
      paperId: authority?.paperId,
      campaignId: authority?.campaignId,
      researchSourceSnapshotHash,
      taskKey: report?.taskKey,
      proposalBinding,
      expectedClaimBindings,
    },
  );
  const formalIntakeVerifications = (Array.isArray(formalIntakes)
    ? formalIntakes : []).map((intake) => (
    verifyGenericFormalCertificateIntakeClosureBinding(intake, {
      paperId: authority?.paperId,
      campaignId: authority?.campaignId,
      researchSourceSnapshotHash,
      taskKey: report?.taskKey,
      proposalBinding,
      expectedClaimBindings,
      nativeResearchWorkerExecution: report?.nativeResearchWorkerExecution,
    })
  ));
  const formalWorkers = (report?.nativeResearchWorkerExecution?.workerReceipts || [])
    .filter((worker) => worker?.workerType === 'formal_verifier_lake');
  const { researchReportHash: claimedReportHash, ...reportPayload } = report || {};
  const boundedFormalReleaseBindingValid = scope.boundedGoldenScope
    && scope.releaseBinding?.version === 3
    && (scope.releaseBinding?.proposal ?? null) === null
    && (scope.releaseBinding?.researchAgendaIr ?? null) === null
    && (scope.releaseBinding?.researchAgendaIrHash ?? null) === null
    && (scope.releaseBinding?.researchReportHash ?? null) === null
    && (scope.releaseBinding?.proposalClaimToTheoremBindingHash ?? null) === null
    && formalProposalBindingMatchesReleaseAuthority(
      proposalBinding,
      scope.releaseBinding,
    );
  const productionFormalReleaseBindingValid = scope.productionScope
    && scope.releaseBinding?.researchReportHash === claimedReportHash
    && scope.releaseBinding?.proposalClaimToTheoremBindingHash
      === proposalBinding?.proposalClaimToTheoremBindingHash
    && formalProposalBindingMatchesRelease(proposalBinding, scope.releaseBinding);
  if (!proposalVerification.valid
    || proposalBinding?.paperId !== authority?.paperId
    || proposalBinding?.campaignId !== authority?.campaignId
    || report?.paperId !== authority?.paperId
    || typeof report?.taskKey !== 'string'
    || report.taskKey.trim() !== report.taskKey
    || report.taskKey.length === 0
    || !SHA256.test(String(researchSourceSnapshotHash || ''))
    || report?.campaignResearchSourceSnapshotHash !== researchSourceSnapshotHash
    || !SHA256.test(String(claimedReportHash || ''))
    || hashPaperRecord('PaperResearchVerifyReport', reportPayload)
      !== claimedReportHash
    || bundle?.researchReportHash !== claimedReportHash
    || report?.proposalClaimToTheoremBindingHash !== proposalBinding?.proposalClaimToTheoremBindingHash
    || bundle?.proposalClaimToTheoremBindingHash !== proposalBinding?.proposalClaimToTheoremBindingHash
    || (!boundedFormalReleaseBindingValid && !productionFormalReleaseBindingValid)
    || !expectedClaimBindings.length
    || !nativeFormalVerification.valid
    || !Array.isArray(formalIntakes) || !formalIntakes.length
    || formalIntakes.some((intake) => intake?.version !== 3
      || intake?.status !== 'formal_certificate_intake_verified')
    || formalIntakeVerifications.some((verification) => !verification.valid)
    || !Array.isArray(formalReplays) || !formalReplays.length
    || formalReplays.some((replay) => replay?.status !== 'formal_claim_replay_verified')
    || !formalWorkers.length
    || formalWorkers.some((worker) => worker?.result?.status !== 'formal_claim_verified'
      || worker?.result?.replayReceipt?.status !== 'formal_claim_replay_verified')) {
    blockers.push('golden_micro_campaign_formal_release_required');
  }
  const releaseCreatedAt = Date.parse(String(bundle?.createdAt || ''));
  const promotedAt = Date.parse(String(authority?.promotedAt || ''));
  if (!Number.isFinite(releaseCreatedAt) || !Number.isFinite(promotedAt)
    || releaseCreatedAt > issuedAt || promotedAt > issuedAt
    || issuedAt - releaseCreatedAt > maximumReceiptAgeMs
    || issuedAt - promotedAt > maximumReceiptAgeMs) {
    blockers.push('golden_micro_campaign_release_not_fresh');
  }
  return Object.freeze({ bundle, blockers: Object.freeze(blockers) });
}
