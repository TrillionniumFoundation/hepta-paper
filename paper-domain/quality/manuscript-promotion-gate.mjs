import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { evaluatePaperQualityPolicy, PAPER_QUALITY_PROFILES } from './paper-quality-policy.mjs';
import { evaluatePromotionDependencyClosure } from './promotion-dependency-closure.mjs';
import { buildPaperProfileEvidenceContract } from './paper-profile-evidence-contract.mjs';
import { verifyExperimentRegistry } from '../research/experiment-registry-verifier.mjs';

function values(value) {
  return Array.isArray(value) ? value : [];
}

export function explicitPaperQualityProfile(paperTask = {}) {
  return explicitPaperQualityProfiles(paperTask)[0] || null;
}

export function explicitPaperQualityProfiles(paperTask = {}) {
  const registry = paperTask.registry || {};
  const metadata = registry.metadata || registry.paperFactory || registry.paper_factory || {};
  const candidates = [
    ...(Array.isArray(paperTask.paperQualityProfiles) ? paperTask.paperQualityProfiles : []),
    paperTask.paperQualityProfile,
    ...(Array.isArray(registry.paperQualityProfiles) ? registry.paperQualityProfiles : []),
    registry.paperQualityProfile,
    registry.paper_quality_profile,
    metadata.paperQualityProfile,
    metadata.paper_quality_profile,
  ];
  return [...new Set(candidates.filter((candidate) => Object.prototype.hasOwnProperty.call(PAPER_QUALITY_PROFILES, candidate)))];
}

function formalWorkerResults(researchReport = {}) {
  return values(researchReport?.nativeResearchWorkerExecution?.workerReceipts)
    .filter((receipt) => ['formal_verifier_lake', 'formal_verifier_lean'].includes(receipt?.workerType))
    .map((receipt) => ({
      workerId: receipt.workerId || null,
      workerType: receipt.workerType,
      receiptStatus: receipt.status || null,
      resultStatus: receipt.result?.status || null,
      receiptHash: receipt.nativeResearchWorkerExecutionReceiptHash || null,
    }));
}

function empiricalClaimPromotionBijectionBlockers(claimRegistry, experimentRegistry) {
  const claims = values(claimRegistry?.claims).filter((claim) => claim?.claimKind === 'empirical_claim');
  const claimById = new Map(claims.map((claim) => [claim.claimId, claim]));
  const promotedIds = [...values(experimentRegistry?.academicPromotionClaimIds)].sort();
  const manuscriptIds = [...claimById.keys()].sort();
  const blockers = [];
  if (JSON.stringify(promotedIds) !== JSON.stringify(manuscriptIds)) {
    blockers.push('empirical_claim_experiment_bijection_invalid');
  }
  for (const authorityClaim of values(experimentRegistry?.empiricalClaimUniverse?.claims)) {
    const manuscriptClaim = claimById.get(authorityClaim.claimId);
    if (!manuscriptClaim
      || manuscriptClaim.manuscriptClaimHash !== authorityClaim.manuscriptClaimHash
      || manuscriptClaim.empiricalClaimUniverseHash !== experimentRegistry.empiricalClaimUniverseHash
      || manuscriptClaim.manuscriptCorpusHash !== experimentRegistry.manuscriptCorpusHash
      || manuscriptClaim.proposalClaimRecordHash !== authorityClaim.proposalClaimRecordHash) {
      blockers.push(`empirical_claim_registry_authority_mismatch:${authorityClaim.claimId}`);
    }
  }
  return blockers;
}

export function buildPaperQualityEvidence({
  paperTask,
  profiles = explicitPaperQualityProfiles(paperTask),
  theoremReadiness = null,
  researchReport = null,
  packageVerificationReceipt = null,
  buildResult = null,
  experimentRegistryAuthorityVerifier = null,
  expectedCampaignId = null,
} = {}) {
  const evidence = [];
  const add = (requirementId, verified, hash, kind = requirementId) => {
    if (evidence.some((item) => (item.requirementId || item.kind) === requirementId)) return;
    evidence.push({ requirementId, kind, verified: verified === true, hash: hash || null, blocked: verified !== true });
  };
  const capabilities = researchReport?.capabilities || {};
  const typed = researchReport?.typedContracts || {};
  const formal = formalWorkerResults(researchReport);
  add('claim_registry', capabilities.claimRegistry?.status === 'claim_graph_valid', capabilities.claimRegistry?.claimRegistryHash);
  add('formal_claim_binding', formal.length > 0 && formal.every((item) => item.resultStatus === 'formal_claim_verified'),
    formal.length ? hashRecord('FormalPromotionEvidence', formal) : null);
  add('proof_surface_readiness', theoremReadiness?.applicable === true && theoremReadiness?.passed === true,
    theoremReadiness?.theoremManuscriptReadinessPolicyHash);
  const experimentRegistry = capabilities.experimentRegistry;
  const experimentRegistryVerification = verifyExperimentRegistry(experimentRegistry, {
    expectedPaperId: paperTask?.paperId || null,
    expectedCampaignId,
    authorityVerifier: experimentRegistryAuthorityVerifier,
  });
  const empiricalProfile = profiles.includes('empirical_or_experiment');
  add('experiment_registry', experimentRegistryVerification.valid && experimentRegistry?.status === 'experiment_registry_ready'
    && (!empiricalProfile || Number(experimentRegistry?.academicExperimentCount || 0) > 0), experimentRegistry?.experimentRegistryHash);
  add('dataset_provenance', values(researchReport?.academicEvidenceAttestation?.verifiedArtifacts)
    .some((item) => item.verified === true && /dataset|data/i.test(String(item.kind || ''))),
  researchReport?.academicEvidenceAttestation?.academicEvidenceAttestationVerificationHash);
  add('reproduction_receipt', typed.reproducibilityContract?.status === 'reproducibility_evidence_present',
    typed.reproducibilityContract?.reproducibilityContractHash);
  add('artifact_manifest', packageVerificationReceipt?.status === 'package_verification_passed',
    packageVerificationReceipt?.packageVerificationReceiptHash);
  add('build_receipt', buildResult?.buildArtifactAcceptance?.accepted === true,
    buildResult?.buildArtifactAcceptance?.paperBuildArtifactAcceptanceHash);
  add('source_provenance', Boolean(researchReport?.academicEvidenceAttestation?.sourceSnapshot?.verified),
    researchReport?.academicEvidenceAttestation?.academicEvidenceAttestationVerificationHash);
  const intake = capabilities.evidenceIntake;
  const typedQualityEvidence = new Map(values(intake?.items)
    .filter((item) => item?.consumptionPolicy?.status === 'evidence_consumption_ready')
    .map((item) => [String(item.provenance || ''), item]));
  const addTypedQuality = (requirementId) => {
    const item = typedQualityEvidence.get(requirementId);
    add(requirementId, Boolean(item), item ? (item.provenanceReceiptHash || item.hash || intake?.evidenceIntakeHash) : null);
  };
  addTypedQuality('novelty_scope_review');
  add('limitations', theoremReadiness?.manuscriptQualitySurfaces?.limitationsPresent === true,
    theoremReadiness?.theoremManuscriptReadinessPolicyHash);
  addTypedQuality('data_rights');
  addTypedQuality('ethics_review');
  addTypedQuality('privacy_review');
  return evidence;
}

export function evaluateManuscriptPromotion({
  paperTask,
  profile = explicitPaperQualityProfile(paperTask),
  profiles = explicitPaperQualityProfiles(paperTask),
  theoremReadiness = null,
  researchReport = null,
  packageVerificationReceipt = null,
  buildResult = null,
  requirePackageVerification = false,
  requireResearchQuality = false,
  requirePaperQuality = Boolean(profile),
  boundary = 'package',
  experimentRegistryAuthorityVerifier = null,
  expectedCampaignId = null,
} = {}) {
  const effectiveProfiles = [...new Set([
    ...(Array.isArray(profiles) ? profiles : []),
    profile,
  ].filter((candidate) => Object.prototype.hasOwnProperty.call(PAPER_QUALITY_PROFILES, candidate)))];
  const primaryProfile = effectiveProfiles[0] || null;
  const empiricalProfile = effectiveProfiles.includes('empirical_or_experiment');
  const blockers = [];
  if (!paperTask?.paperId) blockers.push('promotion_paper_task_required');
  if (theoremReadiness?.applicable === true && theoremReadiness.passed !== true) {
    blockers.push(...values(theoremReadiness.blockers).map((item) => `theorem_readiness:${item}`));
  }
  if (requirePackageVerification && packageVerificationReceipt?.status !== 'package_verification_passed') {
    blockers.push('package_verification_required_for_promotion');
  }
  const evidenceQualityGate = researchReport?.capabilities?.evidenceQualityGate || null;
  const promotionDependencyClosure = requireResearchQuality
    ? evaluatePromotionDependencyClosure({ researchReport })
    : null;
  if (requireResearchQuality && evidenceQualityGate?.status !== 'evidence_quality_ready') {
    blockers.push('evidence_quality_gate_required_for_promotion');
    blockers.push(...values(evidenceQualityGate?.blockers).map((item) => `evidence_quality:${item}`));
  }
  if (requireResearchQuality && promotionDependencyClosure?.status !== 'promotion_dependency_closure_ready') {
    blockers.push(...values(promotionDependencyClosure?.blockers));
  }
  const experimentRegistry = researchReport?.capabilities?.experimentRegistry || null;
  const experiments = values(experimentRegistry?.experiments);
  const experimentRegistryRequired = empiricalProfile || experiments.length > 0;
  const experimentRegistryVerification = verifyExperimentRegistry(experimentRegistry, {
    expectedPaperId: paperTask?.paperId || null,
    expectedCampaignId,
    authorityVerifier: experimentRegistryAuthorityVerifier,
  });
  if (experimentRegistryRequired && !experimentRegistryVerification.valid) {
    blockers.push('experiment_registry_semantics_invalid');
    blockers.push(...experimentRegistryVerification.blockers.map((item) => `experiment_registry:${item}`));
  }
  if (experimentRegistryRequired
    && experimentRegistry?.status !== 'experiment_registry_ready') {
    blockers.push('experiment_registry_required_for_promotion');
    blockers.push(...values(experimentRegistry?.incompleteExperimentIds).map((item) => `experiment_not_accepted:${item}`));
  }
  if (empiricalProfile && experiments.length === 0) {
    blockers.push('experiment_registry_empty_for_empirical_profile');
  }
  if (empiricalProfile && Number(experimentRegistry?.academicExperimentCount || 0) < 1) {
    blockers.push('synthetic_conformance_evidence_not_academic');
  }
  if (empiricalProfile) {
    blockers.push(...empiricalClaimPromotionBijectionBlockers(
      researchReport?.capabilities?.claimRegistry,
      experimentRegistry,
    ));
  }
  const formal = formalWorkerResults(researchReport);
  for (const item of formal) {
    if (item.resultStatus !== 'formal_claim_verified') blockers.push(`formal_claim_binding_required:${item.workerId || item.workerType}`);
  }
  const qualityEvidence = buildPaperQualityEvidence({
    paperTask,
    profiles: effectiveProfiles,
    theoremReadiness,
    researchReport,
    packageVerificationReceipt,
    buildResult,
    experimentRegistryAuthorityVerifier,
    expectedCampaignId,
  });
  const paperProfileEvidenceContracts = effectiveProfiles.map((qualityProfile) => buildPaperProfileEvidenceContract({
    paperTask, profile: qualityProfile, claimRegistry: researchReport?.capabilities?.claimRegistry,
  }));
  const paperQualityPolicies = effectiveProfiles.map((qualityProfile, index) => evaluatePaperQualityPolicy({
    paperId: paperTask?.paperId,
    profile: qualityProfile,
    evidence: qualityEvidence,
    shadow: false,
    requirementsOverride: paperProfileEvidenceContracts[index]?.requirements,
    waivableRequirements: paperProfileEvidenceContracts[index]?.waivableRequirements,
  }));
  const paperProfileEvidenceContract = paperProfileEvidenceContracts[0] || null;
  const paperQualityPolicy = paperQualityPolicies[0] || null;
  if (requirePaperQuality && !effectiveProfiles.length) blockers.push('paper_quality_profile_required_for_promotion');
  if (requirePaperQuality) {
    for (const policy of paperQualityPolicies) {
      if (policy.status !== 'paper_quality_policy_passed') {
        blockers.push(...values(policy.blockers).map((item) => `paper_quality:${item}`));
      }
    }
  }
  const uniqueBlockers = [...new Set(blockers)];
  const payload = {
    version: 1,
    kind: 'ManuscriptPromotionGate',
    paperId: paperTask?.paperId || null,
    boundary,
    profile: primaryProfile,
    profiles: effectiveProfiles,
    status: uniqueBlockers.length ? 'manuscript_promotion_blocked' : 'manuscript_promotion_ready',
    promotionReady: uniqueBlockers.length === 0,
    passed: uniqueBlockers.length === 0,
    theoremReadinessHash: theoremReadiness?.theoremManuscriptReadinessPolicyHash || null,
    paperQualityPolicy,
    paperQualityPolicies,
    paperProfileEvidenceContract,
    paperProfileEvidenceContracts,
    evidenceQualityGateHash: evidenceQualityGate?.evidenceQualityGateHash || null,
    promotionDependencyClosure,
    promotionInputSnapshotHash: researchReport?.capabilities?.promotionInputSnapshot?.promotionInputSnapshotHash || null,
    experimentRegistryHash: experimentRegistry?.experimentRegistryHash || null,
    formalWorkerResults: formal,
    packageVerificationReceiptHash: packageVerificationReceipt?.packageVerificationReceiptHash || null,
    blockers: uniqueBlockers,
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, manuscriptPromotionGateHash: hashRecord('ManuscriptPromotionGate', payload) });
}
