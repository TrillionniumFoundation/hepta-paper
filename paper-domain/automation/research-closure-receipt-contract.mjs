import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hashPaperRecord } from '../contracts/primitives.mjs';
import {
  PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE,
  verifyAutonomousResearchReleaseBinding,
} from './autonomous-research-release-binding-contract.mjs';
import {
  verifyAutonomousVenueComplianceReceipt,
} from './autonomous-venue-compliance-contract.mjs';
import {
  autonomousSubmissionQualificationInspectionValid,
} from './autonomous-submission-qualification-inspection.mjs';
import {
  verifyFullResearchQualificationReceiptEnvelope,
} from './full-research-qualification-contract.mjs';
import {
  verifyProposalClaimToTheoremBinding,
} from '../research/proposal-claim-to-theorem-binding.mjs';
import {
  formalClosureClaimBindingsFromProposalBinding,
  verifyGenericFormalCertificateIntakeClosureBinding,
  verifyNativeFormalResearchClosureBinding,
} from '../research/formal-certificate-intake.mjs';
import { verifyExperimentRegistry } from '../research/experiment-registry-verifier.mjs';
import {
  verifyCampaignReleaseAuthorityRecord,
} from './campaign-release-contracts.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const MANUSCRIPT_PROOF_FIELDS = Object.freeze([
  'trustedAutonomousManuscriptRenderReceiptHash',
  'evidenceBoundManuscriptIrHash',
  'manuscriptIrFileHash',
  'renderedManuscriptHash',
  'agentExecutionReceiptHash',
  'isolatedAgentMergeReceiptHash',
  'agentAuthoredSourceDraftHash',
  'agentAuthoredSourceDraftFileHash',
  'agentWorkspacePostimageBindingHash',
]);
const RECEIPT_KEYS = Object.freeze([
  'blockers', 'campaignId', 'campaignPlanHash', 'campaignReleaseAuthority',
  'campaignReleaseBundleHash', 'closedAt', 'evidenceBoundManuscriptIrHash',
  'experimentIrExecutionAuthorityReceiptHash', 'experimentRegistryHash',
  'experimentReplayReceiptHash', 'externalActionPerformed',
  'humanApprovalPerformed', 'kind', 'paperId',
  'priorArtClaimAlignmentReceiptHash', 'priorArtEvidenceReceiptHash',
  'proposalClaimToTheoremBindingHash', 'qualificationInspection',
  'qualificationReceiptHash', 'qualificationScope',
  'researchAgendaClaimBindingReceiptHash', 'researchAgendaIrHash',
  'researchClosurePolicy', 'researchClosureReceiptHash', 'researchReportHash',
  'status', 'trustedAutonomousManuscriptRenderReceiptHash', 'venueComplianceReceipt',
  'venueComplianceReceiptHash', 'venueId', 'venueRequirementIrHash', 'version',
]);

function sha(value) {
  return SHA256.test(String(value || '').toLowerCase());
}

function recordHashValid(record, kind, hashField) {
  const { [hashField]: claimedHash, ...payload } = record || {};
  return sha(claimedHash) && hashRecord(kind, payload) === claimedHash;
}

function formalReportMatchesReleaseProposal(proposalBinding, releaseBinding) {
  const proposal = releaseBinding?.proposal || null;
  const claims = Array.isArray(proposal?.claims) ? proposal.claims : [];
  const formalClaims = claims.map((claim, index) => ({ claim, index }))
    .filter(({ claim }) => claim?.verificationMode === 'formal_kernel');
  const formal = formalClaims[0] || null;
  const agendaBinding = releaseBinding?.researchAgendaClaimBindingReceipt || null;
  const entry = proposalBinding?.entries?.[0] || null;
  if (formalClaims.length !== 1 || proposalBinding?.entries?.length !== 1 || !entry) {
    return false;
  }
  const { claim, index } = formal;
  const dynamicFormalClaimSeed = proposal?.version === 2
    ? proposal?.dynamicFormalClaimSeed || null : null;
  const seedClaim = {
    id: `${proposal.paperId}:autonomous_claim:${index + 1}`,
    kind: 'machine_proposed_claim_seed',
    status: 'machine_proposed_policy_authorized_for_bounded_execution',
    text: claim.statement,
    scientificClaimKey: claim.claimKey,
    verificationMode: claim.verificationMode,
    assumptions: claim.assumptions,
    quantifiers: claim.quantifiers,
    negativeBoundaries: claim.negativeBoundaries,
    proofObligations: claim.proofObligations,
    empiricalObligations: claim.empiricalObligations,
    machineProposedScientificClaimSetHash:
      proposal.machineProposedScientificClaimSetHash,
    ...(dynamicFormalClaimSeed ? {
      dynamicFormalClaimSeedHash: dynamicFormalClaimSeed.dynamicFormalClaimSeedHash,
      leanDeclarationName: dynamicFormalClaimSeed.leanDeclarationName,
      leanTypeSource: dynamicFormalClaimSeed.leanTypeSource,
      leanTypeSourceHash: dynamicFormalClaimSeed.leanTypeSourceHash,
      leanNormalizedTypeHash: dynamicFormalClaimSeed.leanNormalizedTypeHash,
      allowedImports: dynamicFormalClaimSeed.allowedImports,
      formalClaimCapabilityScopeManifestHash:
        dynamicFormalClaimSeed.capabilityScopeManifestHash,
      formalClaimGeneratorReceiptHash: dynamicFormalClaimSeed.generatorReceiptHash,
    } : {}),
  };
  return releaseBinding?.proposalHash === proposal?.machineProposedScientificClaimSetHash
    && releaseBinding?.paperId === proposal?.paperId
    && proposalBinding?.paperId === releaseBinding?.paperId
    && proposalBinding?.campaignId === releaseBinding?.campaignId
    && proposalBinding?.claimAuthorityBindingHash === releaseBinding?.seedBindingHash
    && proposalBinding?.claimAuthorityBundleHash
      === releaseBinding?.trustedAutonomousManuscriptRenderReceipt?.seedBundleHash
    && releaseBinding?.researchAgendaIr?.formalTargets?.length === 1
    && releaseBinding.researchAgendaIr.formalTargets[0] === claim.statement
    && agendaBinding?.formalClaimKey === claim.claimKey
    && agendaBinding?.formalClaimRecordHash
      === hashRecord('AutonomousResearchClaimRecord', claim)
    && entry.proposalClaimId === seedClaim.id
    && entry.scientificClaimKey === claim.claimKey
    && entry.proposalClaimText === claim.statement
    && entry.theoremStatement === claim.statement
    && JSON.stringify(entry.proofObligations)
      === JSON.stringify(claim.proofObligations)
    && entry.proposalClaimTextHash
      === hashBytes(Buffer.from(claim.statement, 'utf8'))
    && entry.proposalClaimRecordHash
      === hashRecord('AutonomousResearchClaimRecord', seedClaim);
}

function experimentRegistryAuthorityVerifier(releaseBinding) {
  return (experiment, { expectedPaperId, campaignId } = {}) => {
    const binding = experiment?.evidenceBinding || null;
    const evidence = binding?.authorityEvidence || null;
    const replay = evidence?.experimentReplayReceipt || null;
    const run = evidence?.experimentRunReceipt || null;
    const authority = releaseBinding?.experimentIrExecutionAuthorityReceipt || null;
    const verified = evidence?.paperId === expectedPaperId
      && evidence?.campaignId === campaignId
      && JSON.stringify(replay) === JSON.stringify(releaseBinding?.experimentReplayReceipt)
      && JSON.stringify(run) === JSON.stringify(replay?.originalRunReceipt)
      && run?.experimentRunReceiptHash === authority?.originalExperimentRunReceiptHash
      && replay?.replayRunReceipt?.experimentRunReceiptHash
        === authority?.replayExperimentRunReceiptHash
      && replay?.experimentReplayReceiptHash === authority?.experimentReplayReceiptHash
      && binding?.experimentId === experiment?.experimentId
      && sha(binding?.experimentEvidenceBindingHash);
    return Object.freeze({
      verified: Boolean(verified),
      status: verified
        ? 'experiment_registry_authority_verified'
        : 'experiment_registry_authority_blocked',
      experimentId: experiment?.experimentId || null,
      experimentEvidenceBindingHash: binding?.experimentEvidenceBindingHash || null,
    });
  };
}

function formalCertificateIntakeValid(intake, expected) {
  return verifyGenericFormalCertificateIntakeClosureBinding(intake, expected).valid;
}

function formalReplayValid(replay) {
  return replay?.version === 1
    && replay?.kind === 'FormalCertificateReplayReceipt'
    && replay?.status === 'formal_claim_replay_verified'
    && recordHashValid(
      replay,
      'FormalCertificateReplayReceipt',
      'formalCertificateReplayReceiptHash',
    )
    && Array.isArray(replay?.blockers) && replay.blockers.length === 0
    && [
      replay?.originalCertificateBundleHash,
      replay?.rerunCertificateBundleHash,
      replay?.projectManifestHash,
      replay?.systemAuditHash,
      replay?.toolchainHash,
      replay?.formalProjectClosureHash,
      replay?.leanReadableProofPrintAuditSetHash,
    ].every(sha)
    && replay?.externalActionPerformed === false;
}

function nativeFormalExecutionValid(
  nativeExecution,
  report,
  proposalBinding,
  expectedFormalClaimBindings,
) {
  return verifyNativeFormalResearchClosureBinding(nativeExecution, {
    paperId: report?.paperId || null,
    campaignId: proposalBinding?.campaignId || null,
    researchSourceSnapshotHash:
      report?.campaignResearchSourceSnapshotHash || null,
    taskKey: report?.taskKey || null,
    proposalBinding,
    expectedClaimBindings: expectedFormalClaimBindings,
  }).valid;
}

export function inspectResearchReportForClosure(report, releaseBundle, releaseBinding) {
  const { researchReportHash: claimedHash, ...payload } = report || {};
  const proposalBinding = report?.capabilities?.proposalClaimToTheoremBinding || null;
  const proposalVerification = verifyProposalClaimToTheoremBinding(proposalBinding || {}, {
    paperId: releaseBinding?.paperId,
    campaignId: releaseBinding?.campaignId,
    claimAuthorityBindingHash: releaseBinding?.seedBindingHash,
    claimAuthorityBundleHash:
      releaseBinding?.trustedAutonomousManuscriptRenderReceipt?.seedBundleHash,
  });
  const formalIntakes = report?.capabilities?.formalCertificateIntakes;
  const formalReplays = report?.capabilities?.formalReplayReceipts;
  const formalWorkers = (report?.nativeResearchWorkerExecution?.workerReceipts || [])
    .filter((worker) => worker?.workerType === 'formal_verifier_lake');
  const formalWorkerReceiptHashes = new Set(formalWorkers.map((worker) => (
    worker?.nativeResearchWorkerExecutionReceiptHash
  )).filter(Boolean));
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
  const expectedFormalClaimBindings =
    formalClosureClaimBindingsFromProposalBinding(proposalBinding);
  const experimentRegistry = report?.capabilities?.experimentRegistry || null;
  const experimentRegistryVerification = verifyExperimentRegistry(experimentRegistry, {
    expectedPaperId: releaseBinding?.paperId,
    expectedCampaignId: releaseBinding?.campaignId,
    authorityVerifier: experimentRegistryAuthorityVerifier(releaseBinding),
    empiricalClaimUniverse: experimentRegistry?.empiricalClaimUniverse || null,
  });
  const matchingExperiments = (experimentRegistry?.experiments || []).filter((experiment) => {
    const replay = experiment?.evidenceBinding?.authorityEvidence
      ?.experimentReplayReceipt || null;
    return replay?.experimentReplayReceiptHash
      === releaseBinding?.experimentReplayReceiptHash
      && JSON.stringify(replay) === JSON.stringify(releaseBinding?.experimentReplayReceipt);
  });
  const checks = Object.freeze({
    report_shape_and_promotion:
      report?.kind === 'PaperResearchVerifyReport'
      && report?.paperId === releaseBinding?.paperId
      && report?.promotionEligibility?.status === 'research_promotion_ready',
    report_hash_binding:
      sha(claimedHash)
      && hashPaperRecord('PaperResearchVerifyReport', payload) === claimedHash
      && claimedHash === releaseBundle?.researchReportHash
      && claimedHash === releaseBinding?.researchReportHash,
    source_snapshot_binding:
      report?.campaignResearchSourceSnapshotHash
        === releaseBundle?.campaignResearchSourceSnapshotHash
      && JSON.stringify(report?.campaignResearchSourceSnapshot)
        === JSON.stringify(releaseBundle?.campaignResearchSourceSnapshot)
      && report?.campaignResearchSourceSnapshot?.campaignId === releaseBinding?.campaignId
      && report?.campaignResearchSourceSnapshot?.paperId === releaseBinding?.paperId,
    research_execution_lineage_binding:
      report?.researchNodeId === releaseBundle?.researchVerifyNodeId
      && report?.researchAttemptId === releaseBundle?.researchVerifyAttemptId
      && report?.researchLeaseGeneration === releaseBundle?.researchVerifyLeaseGeneration
      && report?.verifiedSourceMerkleHash === releaseBundle?.verifiedSourceMerkleHash
      && report?.verifiedSourceWorkspaceManifestHash
        === releaseBundle?.verifiedSourceWorkspaceManifestHash,
    proposal_binding_verified: proposalVerification.valid === true,
    proposal_binding_hashes:
      proposalBinding?.proposalClaimToTheoremBindingHash
        === report?.proposalClaimToTheoremBindingHash
      && proposalBinding?.proposalClaimToTheoremBindingHash
        === releaseBundle?.proposalClaimToTheoremBindingHash
      && proposalBinding?.proposalClaimToTheoremBindingHash
        === releaseBinding?.proposalClaimToTheoremBindingHash,
    formal_report_matches_release_proposal:
      formalReportMatchesReleaseProposal(proposalBinding, releaseBinding),
    formal_certificate_intakes:
      expectedFormalClaimBindings.length > 0
      && Array.isArray(formalIntakes) && formalIntakes.length > 0
      && formalIntakes.every((intake) => (
        formalCertificateIntakeValid(intake, {
          paperId: releaseBinding?.paperId,
          campaignId: releaseBinding?.campaignId,
          researchSourceSnapshotHash:
            releaseBundle?.campaignResearchSourceSnapshotHash,
          campaignResearchSourceSnapshot:
            releaseBundle?.campaignResearchSourceSnapshot || null,
          taskKey: report?.taskKey || null,
          expectedClaimBindings: expectedFormalClaimBindings,
          proposalBinding,
          nativeResearchWorkerExecution:
            report?.nativeResearchWorkerExecution || null,
          authoritativeFormalNode,
          requireNativeFormalLedgerTrust: true,
          trustedNativeFormalReceiptHashes,
        })
      )),
    formal_evidence_quality_gate:
      evidenceQualityGate?.status === 'evidence_quality_ready'
      && sha(claimedEvidenceQualityGateHash)
      && hashRecord('EvidenceQualityGate', evidenceQualityGatePayload)
        === claimedEvidenceQualityGateHash
      && trustedFormalProjections.length === 1
      && trustedNativeFormalReceiptHashes.length === formalWorkers.length,
    formal_replay_receipts:
      Array.isArray(formalReplays) && formalReplays.length > 0
      && formalReplays.every(formalReplayValid),
    formal_replay_worker_binding:
      formalWorkers.length > 0
      && JSON.stringify(formalReplays)
        === JSON.stringify(formalWorkers.map((worker) => worker?.result?.replayReceipt)),
    native_formal_execution:
      nativeFormalExecutionValid(
        report?.nativeResearchWorkerExecution,
        report,
        proposalBinding,
        expectedFormalClaimBindings,
      ),
    experiment_registry_hashes:
      experimentRegistry?.experimentRegistryHash === report?.experimentRegistryHash
      && experimentRegistry?.experimentRegistryHash === releaseBundle?.experimentRegistryHash
      && experimentRegistry?.experimentRegistryHash === releaseBinding?.experimentRegistryHash,
    experiment_registry_verified: experimentRegistryVerification.valid === true,
    experiment_registry_scope:
      experimentRegistry?.status === 'experiment_registry_ready'
      && experimentRegistry?.academicExperimentCount === 1
      && experimentRegistry?.experiments?.length === 1
      && matchingExperiments.length === 1,
  });
  const blockers = Object.freeze(Object.entries(checks)
    .filter(([, valid]) => valid !== true)
    .map(([name]) => `research_closure_report_${name}_invalid`));
  return Object.freeze({
    valid: blockers.length === 0,
    blockers,
    checks,
    proposalVerificationBlockers:
      Object.freeze([...(proposalVerification?.blockers || [])]),
    experimentRegistryVerificationBlockers:
      Object.freeze([...(experimentRegistryVerification?.blockers || [])]),
  });
}

function researchReportValidForClosure(report, releaseBundle, releaseBinding) {
  return inspectResearchReportForClosure(report, releaseBundle, releaseBinding).valid;
}

function closureInputsValid({
  campaignReleaseAuthority,
  qualificationInspection,
  venueComplianceReceipt,
  closedAt,
} = {}, {
  verifyQualificationSignature = null,
  verifyIndependentQualificationEvidence = null,
} = {}) {
  if (typeof verifyQualificationSignature !== 'function'
    || typeof verifyIndependentQualificationEvidence !== 'function') {
    return false;
  }
  const releaseBundle = campaignReleaseAuthority?.releaseBundle || null;
  const releaseBinding = releaseBundle?.autonomousResearchReleaseBinding || null;
  const qualificationReceipt = qualificationInspection?.qualificationReceipt || null;
  const packageOutput = releaseBundle?.packageOutput || null;
  const sourceTreeManifest = releaseBundle?.promotionCandidate?.sourceTreeManifest || null;
  const timestamp = String(closedAt || '');
  const releaseVerification = verifyAutonomousResearchReleaseBinding(releaseBinding, {
    campaignId: campaignReleaseAuthority?.campaignId,
    paperId: campaignReleaseAuthority?.paperId,
    campaignPlanHash: releaseBundle?.campaignPlanHash,
    qualificationScope: PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE,
    fullResearchQualificationEligible: true,
    externalSubmissionEligible: true,
    authorityObservedAt: timestamp,
  });
  const releaseAuthorityVerification = verifyCampaignReleaseAuthorityRecord(
    campaignReleaseAuthority,
    {
      campaignId: releaseBundle?.campaignId,
      paperId: releaseBundle?.paperId,
      campaignPlanHash: releaseBundle?.campaignPlanHash,
      venueTarget: releaseBinding?.venueProfileSelection?.venueId,
      packageNodeId: releaseBundle?.packageNodeId,
      packageAttemptId: releaseBundle?.packageAttemptId,
    },
    {
      experimentRegistryAuthorityVerifier:
        experimentRegistryAuthorityVerifier(releaseBinding),
    },
  );
  const qualificationSignatureVerifier =
    typeof verifyQualificationSignature === 'function'
      ? (input) => {
        try { return verifyQualificationSignature(input) === true; }
        catch { return false; }
      }
      : null;
  const qualificationEnvelopeVerification =
    verifyFullResearchQualificationReceiptEnvelope(
      qualificationReceipt,
      {
        now: timestamp,
        campaignReleaseAuthority,
        expectedPaperId: campaignReleaseAuthority?.paperId,
        expectedProposalHash: releaseBinding?.proposalHash || null,
        expectedPolicyAuthorizationHash:
          releaseBinding?.policyAuthorizationHash || null,
        expectedSeedBindingHash: releaseBinding?.seedBindingHash || null,
        verifyQualificationSignature: qualificationSignatureVerifier,
        allowBoundedGoldenCapability: false,
      },
    );
  const complianceValid = verifyAutonomousVenueComplianceReceipt(
    venueComplianceReceipt,
    {
      paperId: campaignReleaseAuthority?.paperId,
      campaignId: campaignReleaseAuthority?.campaignId,
      venueId: releaseBinding?.venueProfileSelection?.venueId,
      campaignReleaseBundleHash: campaignReleaseAuthority?.campaignReleaseBundleHash,
      autonomousResearchReleaseBindingHash:
        releaseBinding?.autonomousResearchReleaseBindingHash,
      researchAgendaIrHash: releaseBinding?.researchAgendaIrHash,
      venueRequirementIrHash: releaseBinding?.venueRequirementIrHash,
      venueProfileSelectionHash: releaseBinding?.venueProfileSelectionHash,
      qualificationScope: PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE,
      trustedAutonomousManuscriptRenderReceiptHash:
        releaseBinding?.trustedAutonomousManuscriptRenderReceiptHash,
      evidenceBoundManuscriptIrHash: releaseBinding?.evidenceBoundManuscriptIrHash,
      manuscriptIrFileHash: releaseBinding?.manuscriptIrFileHash,
      renderedSourceHash: releaseBinding?.renderedManuscriptHash,
      agentExecutionReceiptHash: releaseBinding?.agentExecutionReceiptHash,
      isolatedAgentMergeReceiptHash: releaseBinding?.isolatedAgentMergeReceiptHash,
      agentWorkspacePostimageBindingHash:
        releaseBinding?.agentWorkspacePostimageBindingHash,
      campaignReleaseAuthority,
    },
  );
  const templateAssetRows = Array.isArray(sourceTreeManifest?.rows)
    ? sourceTreeManifest.rows.filter((row) => (
      String(row?.hash || '').toLowerCase()
        === String(releaseBinding?.venueRequirementIr?.templateAssetHash || '').toLowerCase()
    )) : [];
  return campaignReleaseAuthority?.status === 'current_completed_release'
    && SAFE_ID.test(String(campaignReleaseAuthority?.campaignId || ''))
    && SAFE_ID.test(String(campaignReleaseAuthority?.paperId || ''))
    && releaseBundle?.version === 1
    && releaseBundle?.kind === 'CampaignReleaseBundle'
    && releaseBundle?.status === 'campaign_release_bundle_prepared'
    && recordHashValid(releaseBundle, 'CampaignReleaseBundle', 'campaignReleaseBundleHash')
    && releaseBundle?.campaignReleaseBundleHash
      === campaignReleaseAuthority?.campaignReleaseBundleHash
    && releaseBundle?.campaignId === campaignReleaseAuthority?.campaignId
    && releaseBundle?.paperId === campaignReleaseAuthority?.paperId
    && recordHashValid(
      packageOutput,
      'ImmutableCampaignPackageOutput',
      'immutableCampaignPackageOutputHash',
    )
    && packageOutput?.immutable === true
    && releaseBundle?.immutableCampaignPackageOutputHash
      === packageOutput?.immutableCampaignPackageOutputHash
    && recordHashValid(
      sourceTreeManifest,
      'ScopedSourceTreeManifest',
      'sourceTreeManifestHash',
    )
    && sourceTreeManifest?.status === 'scoped_source_tree_verified'
    && sourceTreeManifest?.sourceTreeManifestHash === releaseBundle?.sourceTreeManifestHash
    && templateAssetRows.length === 1
    && releaseBinding?.version === 4
    && releaseVerification.valid
    && releaseAuthorityVerification.valid
    && releaseBundle?.autonomousResearchReleaseBindingHash
      === releaseBinding?.autonomousResearchReleaseBindingHash
    && releaseBundle?.promotionCandidate?.autonomousResearchReleaseBindingHash
      === releaseBinding?.autonomousResearchReleaseBindingHash
    && JSON.stringify(releaseBundle?.promotionCandidate?.autonomousResearchReleaseBinding)
      === JSON.stringify(releaseBinding)
    && researchReportValidForClosure(
      releaseBundle?.researchReport,
      releaseBundle,
      releaseBinding,
    )
    && autonomousSubmissionQualificationInspectionValid(
      qualificationInspection,
      releaseBinding,
      campaignReleaseAuthority,
      MANUSCRIPT_PROOF_FIELDS,
      {
        verifyIndependentQualificationEvidence,
        verificationTime: timestamp,
      },
    )
    && qualificationEnvelopeVerification.ready === true
    && qualificationEnvelopeVerification.signatureVerified === true
    && qualificationEnvelopeVerification.timeWindowVerified === true
    && qualificationEnvelopeVerification.releasePointerVerified === true
    && qualificationEnvelopeVerification.qualificationReceiptHash
      === qualificationInspection?.qualificationReceiptHash
    && qualificationReceipt?.independentHypothesisPriorArtReceiptHash
      === releaseBinding?.priorArtEvidenceReceiptHash
    && qualificationReceipt?.priorArtEvidenceReceipt?.priorArtEvidenceReceiptHash
      === releaseBinding?.priorArtEvidenceReceiptHash
    && JSON.stringify(qualificationReceipt?.priorArtEvidenceReceipt)
      === JSON.stringify(releaseBinding?.priorArtEvidenceReceipt)
    && complianceValid
    && venueComplianceReceipt?.version === 3
    && venueComplianceReceipt?.researchAgendaIrHash === releaseBinding?.researchAgendaIrHash
    && JSON.stringify(venueComplianceReceipt?.researchAgendaIr)
      === JSON.stringify(releaseBinding?.researchAgendaIr)
    && venueComplianceReceipt?.venueRequirementIrHash
      === releaseBinding?.venueRequirementIrHash
    && JSON.stringify(venueComplianceReceipt?.venueRequirementIr)
      === JSON.stringify(releaseBinding?.venueRequirementIr)
    && venueComplianceReceipt?.venueRequirementObservations?.templateAssetPresent === true
    && venueComplianceReceipt?.sourceEvidenceBundleHash
      === venueComplianceReceipt?.sourceEvidenceBundle
        ?.autonomousVenueSourceEvidenceBundleHash
    && Number.isFinite(Date.parse(timestamp))
    && new Date(timestamp).toISOString() === timestamp;
}

export function buildResearchClosureReceipt({
  campaignReleaseAuthority,
  qualificationInspection,
  venueComplianceReceipt,
  closedAt,
} = {}, {
  verifyQualificationSignature = null,
  verifyIndependentQualificationEvidence = null,
} = {}) {
  if (!closureInputsValid({
    campaignReleaseAuthority,
    qualificationInspection,
    venueComplianceReceipt,
    closedAt,
  }, {
    verifyQualificationSignature,
    verifyIndependentQualificationEvidence,
  })) throw new Error('research_closure_receipt_input_invalid');
  const releaseBundle = campaignReleaseAuthority.releaseBundle;
  const releaseBinding = releaseBundle.autonomousResearchReleaseBinding;
  const payload = {
    version: 1,
    kind: 'ResearchClosureReceipt',
    status: 'research_closure_verified',
    researchClosurePolicy: 'recursive-production-research-submission-closure-v1',
    campaignId: campaignReleaseAuthority.campaignId,
    paperId: campaignReleaseAuthority.paperId,
    campaignPlanHash: releaseBundle.campaignPlanHash,
    venueId: releaseBinding.venueProfileSelection.venueId,
    campaignReleaseBundleHash: campaignReleaseAuthority.campaignReleaseBundleHash,
    researchReportHash: releaseBinding.researchReportHash,
    proposalClaimToTheoremBindingHash:
      releaseBinding.proposalClaimToTheoremBindingHash,
    experimentRegistryHash: releaseBinding.experimentRegistryHash,
    researchAgendaIrHash: releaseBinding.researchAgendaIrHash,
    researchAgendaClaimBindingReceiptHash:
      releaseBinding.researchAgendaClaimBindingReceiptHash,
    priorArtEvidenceReceiptHash: releaseBinding.priorArtEvidenceReceiptHash,
    priorArtClaimAlignmentReceiptHash:
      releaseBinding.priorArtClaimAlignmentReceiptHash,
    experimentIrExecutionAuthorityReceiptHash:
      releaseBinding.experimentIrExecutionAuthorityReceiptHash,
    experimentReplayReceiptHash: releaseBinding.experimentReplayReceiptHash,
    venueRequirementIrHash: releaseBinding.venueRequirementIrHash,
    trustedAutonomousManuscriptRenderReceiptHash:
      releaseBinding.trustedAutonomousManuscriptRenderReceiptHash,
    evidenceBoundManuscriptIrHash: releaseBinding.evidenceBoundManuscriptIrHash,
    qualificationReceiptHash: qualificationInspection.qualificationReceiptHash,
    qualificationScope: releaseBinding.qualificationScope,
    venueComplianceReceiptHash:
      venueComplianceReceipt.autonomousVenueComplianceReceiptHash,
    campaignReleaseAuthority,
    qualificationInspection,
    venueComplianceReceipt,
    humanApprovalPerformed: false,
    externalActionPerformed: false,
    blockers: Object.freeze([]),
    closedAt,
  };
  return Object.freeze({
    ...payload,
    researchClosureReceiptHash: hashRecord('ResearchClosureReceipt', payload),
  });
}

export function verifyResearchClosureReceipt(receipt, expected = {}, {
  verifyQualificationSignature = null,
  verifyIndependentQualificationEvidence = null,
} = {}) {
  if (!hasExactObjectKeys(receipt, RECEIPT_KEYS)
    || receipt?.version !== 1
    || receipt?.kind !== 'ResearchClosureReceipt'
    || receipt?.status !== 'research_closure_verified'
    || receipt?.researchClosurePolicy
      !== 'recursive-production-research-submission-closure-v1'
    || receipt?.humanApprovalPerformed !== false
    || receipt?.externalActionPerformed !== false
    || !Array.isArray(receipt?.blockers) || receipt.blockers.length !== 0
    || !recordHashValid(receipt, 'ResearchClosureReceipt', 'researchClosureReceiptHash')
    || Object.entries(expected).some(([field, value]) => (
      value !== undefined && value !== null && receipt?.[field] !== value
    ))) return false;
  let rebuilt = null;
  try {
    rebuilt = buildResearchClosureReceipt({
      campaignReleaseAuthority: receipt.campaignReleaseAuthority,
      qualificationInspection: receipt.qualificationInspection,
      venueComplianceReceipt: receipt.venueComplianceReceipt,
      closedAt: receipt.closedAt,
    }, {
      verifyQualificationSignature,
      verifyIndependentQualificationEvidence,
    });
  } catch { return false; }
  return JSON.stringify(rebuilt) === JSON.stringify(receipt);
}
