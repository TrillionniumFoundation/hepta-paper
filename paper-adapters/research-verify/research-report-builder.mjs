import { relativePath } from '../../workflow-kernel/runtime/file-utils.mjs';
import { uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import {
  buildPaperResearchVerifyReceipt,
  createClaimScopeContract,
  createEvidenceMatrixContract,
  createProofObligationContract,
  createReproducibilityContract,
  hashPaperRecord,
} from '../../paper-domain/contracts/index.mjs';
import { buildClaimRegistry } from '../../paper-domain/research/claim-registry.mjs';
import { buildEvidenceQualityGate } from '../../paper-domain/research/evidence-quality-gate.mjs';
import { buildExperimentRegistry } from '../../paper-domain/research/experiment-registry.mjs';
import { verifyExperimentRegistry } from '../../paper-domain/research/experiment-registry-verifier.mjs';
import { createExperimentRegistryAuthorityVerifier } from '../../paper-domain/research/experiment-registry-authority.mjs';
import { buildFormalVerifierRegistry } from '../../paper-domain/research/formal-verifier-registry.mjs';
import {
  buildGenericFormalCertificateIntake,
  formalClosureClaimBindingsFromProposalBinding,
} from '../../paper-domain/research/formal-certificate-intake.mjs';
import { buildResearchChangeProposal } from '../../paper-domain/research/change-proposal.mjs';
import { buildResearchGapPlan } from '../../paper-domain/research/gap-planner.mjs';
import { buildPromotionInputSnapshot, buildResearchGapClosureReceipt } from '../../paper-domain/quality/promotion-input-snapshot.mjs';
import { verifyArtifactWriteReceiptSource } from '../artifacts/artifact-write-receipt-verifier.mjs';
import { verifyIndependentRawEventArtifactRecomputation } from './raw-event-artifact-recomputation-verifier.mjs';
import { buildEmpiricalAssertionReportCapability } from './empirical-assertion-report-capability.mjs';
import {
  verifyExternalResearchReplayReceipt,
} from '../../paper-domain/research/external-research-replay-contract.mjs';
import {
  buildEvidenceVerificationCandidates,
  buildResearchEvidenceIntake,
} from './research-evidence-candidates.mjs';

export { buildEvidenceVerificationCandidates };

export function buildResearchContractContext({
  row,
  sourceRoot,
  evidenceRecords,
  proposalSeedEvidence,
  structured,
  nativeResearchWorkerExecution,
  requireNativeWorkers = false,
} = {}) {
  const evidenceRefs = uniqueStrings([
    ...(row.state.evidenceRefs || []).map((ref) => ref.ref),
    ...evidenceRecords.map((ref) => ref.path),
  ], 128);
  const blockers = [];
  const warnings = [];
  if (!sourceRoot) blockers.push('source_workspace_missing');
  if (requireNativeWorkers && nativeResearchWorkerExecution.status !== 'native_research_workers_verified') {
    blockers.push('native_research_workers_required');
  }
  if (structured.canonicalClaimRegistry?.status === 'canonical_claim_registry_blocked') {
    blockers.push('canonical_claim_registry_required', ...(structured.canonicalClaimRegistry.blockers || []));
  }
  if (structured.canonicalEmpiricalClaimRegistry?.status === 'canonical_empirical_claim_registry_blocked') {
    blockers.push('canonical_empirical_claim_registry_required',
      ...(structured.canonicalEmpiricalClaimRegistry.blockers || []));
  }
  if (structured.canonicalEmpiricalAssertionUniverse?.status === 'canonical_empirical_assertion_universe_blocked') {
    blockers.push('canonical_empirical_assertion_universe_required',
      ...(structured.canonicalEmpiricalAssertionUniverse.blockers || []));
  }
  if (!evidenceRefs.length) warnings.push('claim_evidence_not_found');
  if (proposalSeedEvidence.length) warnings.push('proposal_seed_contracts_require_real_evidence_followup');
  const claimScopeContract = createClaimScopeContract({
    paperTask: row.task,
    claims: structured.claims,
    evidenceRefs,
    blockers,
  });
  const proofObligationContract = createProofObligationContract({
    paperTask: row.task,
    obligations: structured.obligations,
    evidenceRefs,
  });
  const evidenceMatrixContract = createEvidenceMatrixContract({
    paperTask: row.task,
    evidenceItems: structured.evidenceItems,
    evidenceRefs,
  });
  const reproducibilityContract = createReproducibilityContract({
    paperTask: row.task,
    artifacts: structured.reproducibilityItems,
    evidenceRefs: evidenceRefs.filter((ref) => /reproduc|result|seed|checksum|sha256|command|run/i.test(ref)),
  });
  const claimRegistry = buildClaimRegistry({ paperTask: row.task, claims: structured.claims });
  return {
    evidenceRefs,
    blockers,
    warnings,
    claimScopeContract,
    proofObligationContract,
    evidenceMatrixContract,
    reproducibilityContract,
    claimRegistry,
  };
}

export function buildResearchCapabilityState({
  row,
  structured,
  contractContext,
  academicEvidenceAttestation,
  nativeResearchWorkerExecution,
  evidenceVerificationReceipts,
  trustedFormalEvidence,
  revisionRequests,
  receiptLedger,
  campaignEvidenceContext,
  researchSourceSnapshotHash = null,
  formalReviewEnvelope = null,
  operatorDatasetHarnessAuthorityVerifier,
  rawEventRecomputationVerifier = verifyIndependentRawEventArtifactRecomputation,
  externalReplayRequired = false,
  externalReplayRequest = null,
  externalReplayReceipt = null,
  externalReplayReceiptVerifier = null,
  now,
} = {}) {
  const paperQualityProfiles = new Set([
    ...(Array.isArray(row.task.paperQualityProfiles) ? row.task.paperQualityProfiles : []),
    row.task.paperQualityProfile,
  ].filter(Boolean));
  const evidenceIntake = buildResearchEvidenceIntake({
    paperTask: row.task,
    structured,
    academicEvidenceAttestation,
    evidenceVerificationReceipts,
    now,
  });
  const experimentRegistry = buildExperimentRegistry({
    paperTask: row.task,
    artifacts: structured.experiments,
    receiptLedger,
    campaignEvidenceContext,
    artifactVerifier: verifyArtifactWriteReceiptSource,
    rawEventRecomputationVerifier,
    operatorDatasetHarnessAuthorityVerifier,
    empiricalClaimUniverse: structured.canonicalEmpiricalClaimRegistry?.empiricalClaimUniverse || null,
  });
  const experimentRegistryAuthorityVerifier = createExperimentRegistryAuthorityVerifier({
    receiptLedger,
    artifactVerifier: verifyArtifactWriteReceiptSource,
    rawEventRecomputationVerifier,
    operatorDatasetHarnessAuthorityVerifier,
    expectedCampaignId: campaignEvidenceContext?.campaignId || null,
  });
  const experimentRegistryVerification = verifyExperimentRegistry(experimentRegistry, {
    expectedPaperId: row.task.paperId,
    expectedCampaignId: campaignEvidenceContext?.campaignId || null,
    authorityVerifier: experimentRegistryAuthorityVerifier,
    empiricalClaimUniverse: structured.canonicalEmpiricalClaimRegistry?.empiricalClaimUniverse || null,
  });
  if (!experimentRegistryVerification.valid) {
    throw new Error(`research_experiment_registry_invalid:${experimentRegistryVerification.blockers.join(',')}`);
  }
  const empiricalAssertionCapability = buildEmpiricalAssertionReportCapability({
    required: paperQualityProfiles.has('empirical_or_experiment'),
    registry: experimentRegistry,
    registryVerified: experimentRegistryVerification.valid,
    universe: structured.canonicalEmpiricalAssertionUniverse?.empiricalAssertionUniverse || null,
    paperId: row.task.paperId,
    campaignId: campaignEvidenceContext?.campaignId || null,
  });
  const producedAdapterReceipts = trustedFormalEvidence
    .filter((item) => item.status === 'trusted_formal_evidence_recorded')
    .map((item) => item.adapterReceipt);
  const producedCertificateRequests = trustedFormalEvidence
    .filter((item) => item.status === 'trusted_formal_evidence_recorded')
    .map((item) => item.certificateRequest);
  const formalVerifierRegistry = buildFormalVerifierRegistry({
    adapterReceipts: [...structured.formalAdapterReceipts, ...producedAdapterReceipts],
    receiptLedger,
  });
  const expectedFormalClaimBindings = formalClosureClaimBindingsFromProposalBinding(
    formalReviewEnvelope?.proposalClaimToTheoremBinding,
  );
  const formalCertificateIntakes = [...structured.formalCertificateRequests, ...producedCertificateRequests]
    .map((request) => buildGenericFormalCertificateIntake({
      paperId: request.paperId || request.paper_id || null,
      campaignId: request.campaignId || request.campaign_id || null,
      researchSourceSnapshotHash:
        request.researchSourceSnapshotHash || request.research_source_snapshot_hash || null,
      verifierKind: request.verifierKind || request.verifier_kind,
      certificate: request.certificate,
      sourceRecords: request.sourceRecords || request.source_records || [],
      claimBindings: request.claimBindings || request.claim_bindings || [],
      executionReceipt: request.executionReceipt || request.execution_receipt,
      verifierRegistry: formalVerifierRegistry,
      receiptLedger,
      artifactVerifier: verifyArtifactWriteReceiptSource,
    }, {
      expectedPaperId: row.task.paperId,
      expectedCampaignId: campaignEvidenceContext?.campaignId || null,
      expectedResearchSourceSnapshotHash: researchSourceSnapshotHash,
      expectedClaimBindings: expectedFormalClaimBindings,
      expectedTaskKey: row.task.taskKey,
      expectedProposalBinding:
        formalReviewEnvelope?.proposalClaimToTheoremBinding || null,
      nativeResearchWorkerExecution,
    }));
  const evidenceQualityGate = buildEvidenceQualityGate({
    paperTask: row.task,
    claimRegistry: contractContext.claimRegistry,
    evidenceIntake,
    nativeWorkerReceipts: nativeResearchWorkerExecution.workerReceipts,
    receiptLedger,
    experimentEvidenceBindings: experimentRegistry.experiments.map((experiment) => experiment.evidenceBinding),
    formalCertificateIntakes,
    campaignId: campaignEvidenceContext?.campaignId || null,
    researchSourceSnapshotHash,
    expectedFormalClaimBindings,
    proposalClaimToTheoremBinding:
      formalReviewEnvelope?.proposalClaimToTheoremBinding || null,
    nativeResearchWorkerExecution,
  });
  const researchGapPlan = buildResearchGapPlan({
    paperTask: row.task,
    claimRegistry: contractContext.claimRegistry,
    evidenceQualityGate,
    revisionRequests,
  });
  const promotionInputSnapshot = buildPromotionInputSnapshot({
    paperTask: row.task,
    claimRegistry: contractContext.claimRegistry,
    evidenceQualityGate,
    researchGapPlan,
    revisionRequests,
    createdAt: now.toISOString(),
  });
  const researchGapClosureReceipt = buildResearchGapClosureReceipt({ promotionInputSnapshot, researchGapPlan });
  const formalWorkerReceipts = (nativeResearchWorkerExecution.workerReceipts || [])
    .filter((receipt) => receipt.workerType === 'formal_verifier_lake');
  const formalReplayReceipts = formalWorkerReceipts
    .map((receipt) => receipt.result?.replayReceipt || null)
    .filter(Boolean);
  const externalReplayVerified = externalReplayRequired === true
    && verifyExternalResearchReplayReceipt(externalReplayReceipt, {
      request: externalReplayRequest,
      cryptographicVerifier: externalReplayReceiptVerifier,
    });
  const claimById = new Map(contractContext.claimRegistry.claims.map((claim) => [claim.claimId, claim]));
  const formalClaimLineageBlockers = formalWorkerReceipts.flatMap((receipt) => {
    const bindings = receipt.result?.claimBindingReport?.bindings || [];
    return bindings.flatMap((binding) => {
      const claim = claimById.get(binding.claimId);
      if (!claim) return [`formal_claim_registry_binding_missing:${binding.claimId || 'missing'}`];
      return binding.manuscriptClaimHash === claim.manuscriptClaimHash
        ? []
        : [`formal_claim_manuscript_identity_mismatch:${binding.claimId}`];
    });
  });
  const promotionBlockers = [
    ...(evidenceQualityGate.status === 'evidence_quality_ready' ? [] : ['evidence_quality_gate_not_ready', ...(evidenceQualityGate.blockers || []).map((item) => `evidence_quality:${item}`)]),
    ...(experimentRegistry.experiments.length === 0 || experimentRegistry.status === 'experiment_registry_ready'
      ? [] : ['experiment_registry_not_ready', ...(experimentRegistry.incompleteExperimentIds || []).map((item) => `experiment_not_accepted:${item}`)]),
    ...(paperQualityProfiles.has('empirical_or_experiment') && experimentRegistry.experiments.length === 0
      ? ['empirical_campaign_experiment_evidence_required'] : []),
    ...(paperQualityProfiles.has('empirical_or_experiment') && Number(experimentRegistry.academicExperimentCount || 0) < 1
      ? ['synthetic_conformance_evidence_not_academic'] : []),
    ...formalWorkerReceipts.filter((receipt) => receipt.result?.status !== 'formal_claim_verified')
      .map((receipt) => `formal_claim_verification_required:${receipt.workerId || receipt.workerType}`),
    ...formalWorkerReceipts.filter((receipt) => receipt.result?.replayReceipt?.status !== 'formal_claim_replay_verified'
      || !receipt.result?.formalCertificateReplayReceiptHash)
      .map((receipt) => `formal_claim_replay_required:${receipt.workerId || receipt.workerType}`),
    ...formalClaimLineageBlockers,
    ...empiricalAssertionCapability.blockers,
    ...(externalReplayRequired && !externalReplayVerified
      ? ['external_research_replay_required'] : []),
  ];
  const researchChangeProposal = buildResearchChangeProposal({
    paperTask: row.task,
    patches: [],
    evidenceQualityGate,
  });
  return {
    evidenceIntake,
    evidenceQualityGate,
    researchGapPlan,
    promotionInputSnapshot,
    researchGapClosureReceipt,
    experimentRegistry,
    experimentRegistryAuthorityVerifier,
    empiricalAssertionAuthority: empiricalAssertionCapability.empiricalAssertionAuthority,
    empiricalAssertionUniverse: empiricalAssertionCapability.empiricalAssertionUniverse,
    empiricalAssertionUniverseBinding: empiricalAssertionCapability.empiricalAssertionUniverseBinding,
    formalVerifierRegistry,
    formalCertificateIntakes,
    formalReplayReceipts,
    externalReplayRequired: externalReplayRequired === true,
    externalReplayVerified,
    externalReplayRequest,
    externalReplayReceipt,
    researchChangeProposal,
    promotionBlockers,
  };
}

export function buildResearchVerifyReport({
  root,
  row,
  sourceRoot,
  logRoot,
  empiricalRoot,
  sourceEvidence,
  logEvidence,
  empiricalEvidence,
  evidenceRecords,
  proposalSeedEvidence,
  contractContext,
  capabilityState,
  academicEvidenceAttestation,
  nativeResearchWorkerExecution,
  trustedFormalEvidence,
  evidenceVerificationReceipts,
  researchGapPlanBinding,
  executeResearchWorkers,
  campaignResearchSourceSnapshot = null,
  formalReviewEnvelope = null,
  externalReplayRequired = false,
  externalReplayRequest = null,
  externalReplayReceipt = null,
} = {}) {
  const legacyCatalogReferences = [];
  const researchWorkers = [];
  const verifyReceipt = buildPaperResearchVerifyReceipt({
    paperTask: row.task,
    claimScopeContract: contractContext.claimScopeContract,
    proofObligationContract: contractContext.proofObligationContract,
    evidenceMatrixContract: contractContext.evidenceMatrixContract,
    reproducibilityContract: contractContext.reproducibilityContract,
    legacyCatalogReferences,
    evidenceRefs: contractContext.evidenceRefs,
    blockers: contractContext.blockers,
    warnings: contractContext.warnings,
  });
  const reportStatus = proposalSeedEvidence.length > 0
    && proposalSeedEvidence.length === evidenceRecords.length
    ? 'proposal_seed_present'
    : verifyReceipt.status;
  const report = {
    version: 1,
    kind: 'PaperResearchVerifyReport',
    paperId: row.task.paperId,
    taskKey: row.task.taskKey,
    status: reportStatus,
    academicEvidenceStatus: academicEvidenceAttestation.status,
    academicEvidenceEligible: academicEvidenceAttestation.academicEvidenceEligible,
    sourceEvidenceCount: sourceEvidence.length,
    logEvidenceCount: logEvidence.length,
    empiricalEvidenceCount: empiricalEvidence.length,
    proposalSeedEvidenceCount: proposalSeedEvidence.length,
    claimCount: contractContext.claimScopeContract.claimCount,
    proofObligationCount: contractContext.proofObligationContract.proofObligationCount,
    evidenceItemCount: contractContext.evidenceMatrixContract.evidenceItemCount,
    reproducibilityItemCount: contractContext.reproducibilityContract.reproducibilityItemCount,
    legacyCatalogReferenceCount: researchWorkers.length,
    legacyCatalogReferenceReceiptCount: legacyCatalogReferences.length,
    nativeResearchWorkerPlanStatus: nativeResearchWorkerExecution.status,
    nativeResearchWorkerCount: nativeResearchWorkerExecution.plannedResearchWorkerCount,
    executedResearchWorkerCount: nativeResearchWorkerExecution.executedResearchWorkerCount,
    verifiedNativeResearchWorkerCount: nativeResearchWorkerExecution.verifiedAcademicEvidenceWorkerCount,
    semanticMigrationVerifiedWorkerCount: 0,
    experimentRegistryHash: capabilityState.experimentRegistry.experimentRegistryHash,
    empiricalAssertionAuthorityHash:
      capabilityState.empiricalAssertionAuthority?.empiricalAssertionAuthorityHash || null,
    empiricalAssertionUniverseHash:
      capabilityState.empiricalAssertionUniverse?.empiricalAssertionUniverseHash || null,
    empiricalAssertionUniverseBindingHash:
      capabilityState.empiricalAssertionUniverseBinding?.empiricalAssertionUniverseBindingHash || null,
    empiricalAssertionManuscriptCorpusHash:
      capabilityState.empiricalAssertionUniverse?.manuscriptCorpusHash || null,
    proposalClaimToTheoremBindingHash:
      formalReviewEnvelope?.proposalClaimToTheoremBindingHash || null,
    ...(externalReplayRequired ? {
      externalReplayRequestHash: externalReplayRequest?.requestHash || null,
      externalResearchReplayReceiptHash:
        externalReplayReceipt?.externalResearchReplayReceiptHash || null,
      externalReplayVerified: capabilityState.externalReplayVerified === true,
    } : {}),
    evidenceProvenance: {
      sourceCandidateRecordCount: sourceEvidence.length,
      operationalLogRecordCount: logEvidence.length,
      pipelineSmokeRecordCount: empiricalEvidence.length,
      pipelineSmokeExcludedFromAcademicEvidence: true,
    },
    academicEvidenceAttestation,
    nativeResearchWorkerExecution,
    capabilities: {
      claimRegistry: contractContext.claimRegistry,
      evidenceIntake: capabilityState.evidenceIntake,
      evidenceQualityGate: capabilityState.evidenceQualityGate,
      researchGapPlan: capabilityState.researchGapPlan,
      promotionInputSnapshot: capabilityState.promotionInputSnapshot,
      researchGapClosureReceipt: capabilityState.researchGapClosureReceipt,
      researchGapPlanBinding,
      experimentRegistry: capabilityState.experimentRegistry,
      empiricalAssertionAuthority: capabilityState.empiricalAssertionAuthority,
      empiricalAssertionUniverse: capabilityState.empiricalAssertionUniverse,
      empiricalAssertionUniverseBinding: capabilityState.empiricalAssertionUniverseBinding,
      formalVerifierRegistry: capabilityState.formalVerifierRegistry,
      formalCertificateIntakes: capabilityState.formalCertificateIntakes,
      formalReplayReceipts: capabilityState.formalReplayReceipts,
      ...(externalReplayRequired ? {
        externalReplayRequest,
        externalReplayReceipt,
      } : {}),
      proposalClaimToTheoremBinding:
        formalReviewEnvelope?.proposalClaimToTheoremBinding || null,
      trustedFormalEvidence,
      researchChangeProposal: capabilityState.researchChangeProposal,
      evidenceVerificationReceipts,
    },
    promotionEligibility: {
      status: capabilityState.promotionBlockers.length ? 'research_promotion_blocked' : 'research_promotion_ready',
      blockers: capabilityState.promotionBlockers,
    },
    ...(campaignResearchSourceSnapshot ? {
      researchNodeId: campaignResearchSourceSnapshot.researchNodeId,
      researchAttemptId: campaignResearchSourceSnapshot.researchAttemptId,
      researchLeaseGeneration: campaignResearchSourceSnapshot.researchLeaseGeneration,
      verifiedSourceMerkleHash: campaignResearchSourceSnapshot.verifiedSourceMerkleHash,
      verifiedSourceWorkspaceManifestHash: campaignResearchSourceSnapshot.verifiedSourceWorkspaceManifestHash,
      campaignResearchSourceSnapshotHash: campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash,
      campaignResearchSourceSnapshot,
    } : {}),
    evidenceRefs: contractContext.evidenceRefs,
    typedContracts: {
      claimScopeContract: contractContext.claimScopeContract,
      proofObligationContract: contractContext.proofObligationContract,
      evidenceMatrixContract: contractContext.evidenceMatrixContract,
      reproducibilityContract: contractContext.reproducibilityContract,
      legacyCatalogReferences,
      verifyReceipt,
    },
    blockers: contractContext.blockers,
    warnings: uniqueStrings([
      ...contractContext.warnings,
      ...(verifyReceipt.warnings || []),
    ], 64),
    sourceRoots: {
      sourceWorkspace: sourceRoot ? relativePath(root, sourceRoot) : null,
      paperctlLog: relativePath(root, logRoot),
      empiricalAnalysis: relativePath(root, empiricalRoot),
    },
    safety: {
      readsOnly: !executeResearchWorkers,
      writesRuntimeOnly: Boolean(executeResearchWorkers),
      sourceMutation: false,
      externalActionPerformed: false,
      legacyWorkerCatalogScanned: false,
    },
  };
  return { ...report, researchReportHash: hashPaperRecord('PaperResearchVerifyReport', report) };
}
