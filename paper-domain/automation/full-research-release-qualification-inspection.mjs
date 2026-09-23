import { verifyProposalClaimToTheoremBinding } from '../research/proposal-claim-to-theorem-binding.mjs';
import { hashPaperRecord } from '../contracts/primitives.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
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
import { CAMPAIGN_RELEASE_GPU_SCIENTIFIC_ARCHIVE_MANIFEST_ROLE,
  CAMPAIGN_RELEASE_GPU_SCIENTIFIC_QUALIFICATION_EVIDENCE_ROLE,
  verifyCampaignReleaseGpuScientificEvidenceDescriptor } from './campaign-release-gpu-scientific-evidence-capsule-contract.mjs';
import { campaignReleaseExecutionAttestationDocumentFileHash,
  verifyCampaignReleaseExecutionAttestationManifestBinding } from './campaign-release-execution-attestation-contract.mjs';
import { verifyGpuScientificCampaignPromotionEvidence } from './gpu-scientific-campaign-promotion-contract.mjs';
import {
  verifyGpuScientificReleaseAuthorityFreshnessReceipt,
} from './gpu-scientific-release-authority-freshness-receipt-contract.mjs';

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

const GPU_SCIENTIFIC_RELEASE_PROJECTION_FIELDS = Object.freeze([
  'gpuScientificExecutionPlanHash', 'gpuScientificExecutionPlan',
  'gpuScientificCampaignExecutionResultHash', 'gpuScientificExecutionEvidence',
  'gpuScientificArtifactBodyArchiveManifestHash', 'gpuScientificCampaignQualificationEvidenceHash',
  'gpuScientificCampaignPromotionEvidenceHash', 'gpuScientificCampaignPromotionEvidence',
  'campaignResearchGpuScientificEvidenceHash',
  'gpuScientificCampaignQualificationAuthorityInspectionHash',
  'gpuScientificReleaseAuthorityFreshnessReceiptHash',
  'gpuScientificReleaseAuthorityFreshnessReceipt',
]);

function hashedRecordValid(record, kind, hashField) {
  if (!record || typeof record !== 'object') return false;
  const { [hashField]: claimedHash, ...payload } = record;
  return SHA256.test(String(claimedHash || ''))
    && hashRecord(kind, payload) === claimedHash;
}

function singlePackageFile(packageOutput, predicate) {
  const matches = (packageOutput?.files || []).filter(predicate);
  return matches.length === 1 ? matches[0] : null;
}

function gpuScientificReleaseRequired(bundle) {
  const records = [bundle, bundle?.promotionCandidate];
  return bundle?.researchEvidenceCapsuleManifest?.gpuScientificEvidenceIncluded === true
    || records.some((record) => GPU_SCIENTIFIC_RELEASE_PROJECTION_FIELDS.some(
      (field) => Object.hasOwn(record || {}, field),
    ));
}

function releaseAuthorityInspectionVerifier(verifier) {
  if (typeof verifier?.verifyReleaseSnapshot === 'function') {
    return (input) => verifier.verifyReleaseSnapshot(input);
  }
  return null;
}

export function inspectFullResearchGpuScientificCampaignLineage(bundle, {
  gpuScientificPromotionAuthorityVerifier = null,
  gpuScientificAuthorityVerificationTime = null,
} = {}) {
  const required = gpuScientificReleaseRequired(bundle);
  if (!required) return Object.freeze({
    required: false, verified: true,
    researchVerificationProjectionVerified: true,
    promotionEvidenceHash: null, qualificationEvidenceHash: null,
    artifactArchiveManifestHash: null,
    blockers: Object.freeze([]),
  });
  const blockers = [];
  const candidate = bundle?.promotionCandidate || null;
  const promotion = bundle?.gpuScientificCampaignPromotionEvidence || null;
  const qualification = promotion?.gpuScientificCampaignQualificationEvidence || null;
  const request = qualification?.gpuScientificCampaignQualificationRequest || null;
  const manifest = bundle?.researchEvidenceCapsuleManifest || null;
  const descriptor = manifest?.gpuScientificEvidence || null;
  const packageOutput = bundle?.packageOutput || null;
  const attestation = bundle?.researchExecutionReleaseAttestation || null;
  const manifestFileHash = packageOutput?.researchEvidenceCapsuleManifestFileHash || null;
  const freshnessReceipt =
    bundle?.gpuScientificReleaseAuthorityFreshnessReceipt || null;
  const freshnessVerification =
    verifyGpuScientificReleaseAuthorityFreshnessReceipt(
      freshnessReceipt,
      {
        qualificationEvidence: qualification,
        researchEvidenceCapsuleManifest: manifest,
        researchEvidenceCapsuleManifestFileHash: manifestFileHash,
        researchExecutionReleaseAttestationHash:
          bundle?.researchExecutionReleaseAttestationHash,
        authorityInspectionVerifier: releaseAuthorityInspectionVerifier(
          gpuScientificPromotionAuthorityVerifier,
        ),
        verificationTime: gpuScientificAuthorityVerificationTime,
      },
    );
  if (!freshnessVerification.valid
    || bundle?.gpuScientificReleaseAuthorityFreshnessReceiptHash
      !== freshnessReceipt
        ?.gpuScientificReleaseAuthorityFreshnessReceiptHash
    || candidate?.gpuScientificReleaseAuthorityFreshnessReceiptHash
      !== bundle?.gpuScientificReleaseAuthorityFreshnessReceiptHash
    || JSON.stringify(
      candidate?.gpuScientificReleaseAuthorityFreshnessReceipt || null,
    ) !== JSON.stringify(freshnessReceipt)) {
    blockers.push(
      'golden_micro_campaign_gpu_scientific_authority_freshness_invalid',
      ...freshnessVerification.blockers,
    );
  }
  if (!verifyGpuScientificCampaignPromotionEvidence(promotion, {
    campaignId: bundle?.campaignId,
    paperId: bundle?.paperId,
    gpuScientificCampaignExecutionResultHash:
      bundle?.gpuScientificCampaignExecutionResultHash,
    artifactArchiveManifestHash:
      bundle?.gpuScientificArtifactBodyArchiveManifestHash,
    researchEvidenceCapsuleManifestHash:
      bundle?.researchEvidenceCapsuleManifestHash,
    researchEvidenceCapsuleManifestFileHash: manifestFileHash,
    researchExecutionReleaseAttestationHash:
      bundle?.researchExecutionReleaseAttestationHash,
  })) blockers.push('golden_micro_campaign_gpu_scientific_promotion_evidence_invalid');
  const projection = [
    ['gpuScientificCampaignExecutionResultHash', promotion?.gpuScientificCampaignExecutionResultHash],
    ['gpuScientificArtifactBodyArchiveManifestHash', promotion?.artifactArchiveManifestHash],
    ['gpuScientificCampaignQualificationEvidenceHash', promotion?.gpuScientificCampaignQualificationEvidenceHash],
    ['gpuScientificCampaignPromotionEvidenceHash', promotion?.gpuScientificCampaignPromotionEvidenceHash],
  ];
  if (!hashedRecordValid(bundle, 'CampaignReleaseBundle', 'campaignReleaseBundleHash')
    || !hashedRecordValid(candidate, 'AutomationPromotionCandidate',
      'automationPromotionCandidateHash')
    || bundle?.automationPromotionCandidateHash
      !== candidate?.automationPromotionCandidateHash
    || candidate?.campaignId !== bundle?.campaignId
    || candidate?.paperId !== bundle?.paperId
    || candidate?.campaignPlanHash !== bundle?.campaignPlanHash
    || projection.some(([field, value]) => (
      bundle?.[field] !== value || candidate?.[field] !== value
    ))
    || request?.campaignPlanHash !== bundle?.campaignPlanHash
    || request?.executionPlanHash !== bundle?.gpuScientificExecutionPlanHash
    || bundle?.gpuScientificExecutionPlanHash
      !== bundle?.gpuScientificExecutionPlan?.gpuScientificCampaignExecutionPlanHash
    || bundle?.gpuScientificCampaignExecutionResultHash
      !== bundle?.gpuScientificExecutionEvidence
        ?.gpuScientificCampaignExecutionResultHash
    || JSON.stringify(candidate?.gpuScientificExecutionPlan)
      !== JSON.stringify(bundle?.gpuScientificExecutionPlan)
    || JSON.stringify(candidate?.gpuScientificExecutionEvidence)
      !== JSON.stringify(bundle?.gpuScientificExecutionEvidence)
    || JSON.stringify(candidate?.gpuScientificCampaignPromotionEvidence)
      !== JSON.stringify(promotion)) {
    blockers.push('golden_micro_campaign_gpu_scientific_research_projection_mismatch');
  }
  const qualificationBytes = qualification
    ? Buffer.from(`${JSON.stringify(qualification, null, 2)}\n`, 'utf8') : null;
  if (!hashedRecordValid(manifest, 'CampaignReleaseResearchEvidenceCapsuleManifest',
    'researchEvidenceCapsuleManifestHash')
    || manifest?.version !== 3 || manifest?.gpuScientificEvidenceIncluded !== true
    || manifest?.campaignId !== bundle?.campaignId
    || manifest?.paperId !== bundle?.paperId
    || bundle?.researchEvidenceCapsuleManifestHash
      !== manifest?.researchEvidenceCapsuleManifestHash
    || !verifyCampaignReleaseGpuScientificEvidenceDescriptor(manifest)
    || descriptor?.gpuScientificCampaignExecutionResultHash
      !== promotion?.gpuScientificCampaignExecutionResultHash
    || descriptor?.gpuScientificArtifactBodyArchiveManifestHash
      !== promotion?.artifactArchiveManifestHash
    || descriptor?.gpuScientificCampaignQualificationEvidenceHash
      !== promotion?.gpuScientificCampaignQualificationEvidenceHash
    || descriptor?.scientificOutputCommitmentHash
      !== promotion?.scientificOutputCommitmentHash
    || descriptor?.executionPlanHash !== request?.executionPlanHash
    || !qualificationBytes
    || descriptor?.qualificationEvidenceFileHash !== hashBytes(qualificationBytes)
    || Number(descriptor?.qualificationEvidenceFileBytes)
      !== qualificationBytes?.length) {
    blockers.push('golden_micro_campaign_gpu_scientific_capsule_binding_invalid');
  }
  const requiredCapsuleFiles = [
    [CAMPAIGN_RELEASE_GPU_SCIENTIFIC_QUALIFICATION_EVIDENCE_ROLE,
      descriptor?.qualificationEvidencePath, descriptor?.qualificationEvidenceFileHash,
      descriptor?.qualificationEvidenceFileBytes],
    [CAMPAIGN_RELEASE_GPU_SCIENTIFIC_ARCHIVE_MANIFEST_ROLE,
      descriptor?.artifactArchiveManifestPath, descriptor?.artifactArchiveManifestFileHash,
      descriptor?.artifactArchiveManifestFileBytes],
    ...(descriptor?.archiveEntries || []).map((entry) => [
      entry.role, entry.path, entry.hash, entry.bytes,
    ]),
  ];
  const manifestFile = singlePackageFile(
    packageOutput,
    (file) => file?.role === 'research_evidence_capsule_manifest',
  );
  if (!hashedRecordValid(packageOutput, 'ImmutableCampaignPackageOutput',
    'immutableCampaignPackageOutputHash')
    || bundle?.immutableCampaignPackageOutputHash
      !== packageOutput?.immutableCampaignPackageOutputHash
    || packageOutput?.researchEvidenceCapsuleManifestHash
      !== manifest?.researchEvidenceCapsuleManifestHash
    || manifestFile?.hash !== manifestFileHash
    || requiredCapsuleFiles.some(([role, path, hash, bytes]) => {
      const file = singlePackageFile(
        packageOutput,
        (item) => item?.capsuleRole === role,
      );
      return file?.packageRelativePath !== path || file?.hash !== hash
        || Number(file?.bytes) !== Number(bytes);
    })) blockers.push('golden_micro_campaign_gpu_scientific_package_output_binding_invalid');
  const attestationFile = singlePackageFile(
    packageOutput,
    (file) => file?.role === 'research_execution_release_attestation',
  );
  if (!verifyCampaignReleaseExecutionAttestationManifestBinding({
    manifest, attestation, manifestFileHash,
  }).valid
    || promotion?.researchExecutionReleaseAttestationHash
      !== attestation?.campaignReleaseExecutionAttestationHash
    || bundle?.researchExecutionReleaseAttestationHash
      !== attestation?.campaignReleaseExecutionAttestationHash
    || packageOutput?.researchExecutionReleaseAttestationHash
      !== attestation?.campaignReleaseExecutionAttestationHash
    || packageOutput?.researchExecutionReleaseAttestationFileHash
      !== campaignReleaseExecutionAttestationDocumentFileHash(attestation)
    || attestationFile?.hash
      !== packageOutput?.researchExecutionReleaseAttestationFileHash) {
    blockers.push('golden_micro_campaign_gpu_scientific_release_attestation_binding_invalid');
  }
  return Object.freeze({
    required: true, verified: blockers.length === 0,
    researchVerificationProjectionVerified: !blockers.includes(
      'golden_micro_campaign_gpu_scientific_research_projection_mismatch',
    ),
    promotionEvidenceHash: promotion?.gpuScientificCampaignPromotionEvidenceHash || null,
    qualificationEvidenceHash: promotion?.gpuScientificCampaignQualificationEvidenceHash || null,
    artifactArchiveManifestHash: promotion?.artifactArchiveManifestHash || null,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

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
  gpuScientificPromotionAuthorityVerifier = null,
  gpuScientificAuthorityVerificationTime = null,
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
  const gpuScientificLineageInspection =
    inspectFullResearchGpuScientificCampaignLineage(bundle, {
      gpuScientificPromotionAuthorityVerifier,
      gpuScientificAuthorityVerificationTime,
    });
  blockers.push(...gpuScientificLineageInspection.blockers);
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
  const campaignResearchSourceSnapshot =
    bundle?.campaignResearchSourceSnapshot
      || report?.campaignResearchSourceSnapshot
      || null;
  const expectedClaimBindings =
    formalClosureClaimBindingsFromProposalBinding(proposalBinding);
  const formalIntakes = report?.capabilities?.formalCertificateIntakes;
  const formalReplays = report?.capabilities?.formalReplayReceipts;
  const evidenceQualityGate = report?.capabilities?.evidenceQualityGate || null;
  const {
    evidenceQualityGateHash: claimedEvidenceQualityGateHash,
    ...evidenceQualityGatePayload
  } = evidenceQualityGate || {};
  const trustedFormalProjections = (
    report?.capabilities?.trustedFormalEvidence || []
  ).filter((item) => (
    item?.status === 'trusted_formal_evidence_projected'
    && item?.nativeProjectionRequest?.authoritativeFormalNode
  ));
  const authoritativeFormalNode = trustedFormalProjections.length === 1
    ? trustedFormalProjections[0].nativeProjectionRequest.authoritativeFormalNode
    : null;
  const formalWorkers = (
    report?.nativeResearchWorkerExecution?.workerReceipts || []
  ).filter((worker) => worker?.workerType === 'formal_verifier_lake');
  const formalWorkerReceiptHashes = new Set(formalWorkers.map((worker) => (
    worker?.nativeResearchWorkerExecutionReceiptHash
  )).filter(Boolean));
  const trustedNativeFormalReceiptHashes = (
    evidenceQualityGate?.workerLedgerVerifications || []
  ).filter((verification) => (
    verification?.status === 'trusted_ledger_receipt_verified'
    && verification?.receiptKind === 'NativeResearchWorkerExecutionReceipt'
    && verification?.stream === 'jobs'
    && verification?.writerKind === 'native-research-worker'
    && verification?.writerTrusted === true
    && verification?.issuerPolicyVerified === true
    && formalWorkerReceiptHashes.has(verification?.receiptHash)
  )).map((verification) => verification.receiptHash);
  const nativeFormalVerification = verifyNativeFormalResearchClosureBinding(
    report?.nativeResearchWorkerExecution,
    {
      paperId: authority?.paperId,
      campaignId: authority?.campaignId,
      researchSourceSnapshotHash,
      campaignResearchSourceSnapshot,
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
      campaignResearchSourceSnapshot,
      taskKey: report?.taskKey,
      proposalBinding,
      expectedClaimBindings,
      nativeResearchWorkerExecution: report?.nativeResearchWorkerExecution,
      authoritativeFormalNode,
      requireNativeFormalLedgerTrust: true,
      trustedNativeFormalReceiptHashes,
    })
  ));
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
    || evidenceQualityGate?.status !== 'evidence_quality_ready'
    || !SHA256.test(String(claimedEvidenceQualityGateHash || ''))
    || hashRecord('EvidenceQualityGate', evidenceQualityGatePayload)
      !== claimedEvidenceQualityGateHash
    || trustedFormalProjections.length !== 1
    || trustedNativeFormalReceiptHashes.length !== formalWorkers.length
    || !Array.isArray(formalIntakes) || !formalIntakes.length
    || formalIntakes.some((intake) => intake?.version !== 4
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
