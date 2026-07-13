import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { evaluatePaperQualityPolicy, PAPER_QUALITY_PROFILES } from './paper-quality-policy.mjs';
import { evaluatePromotionDependencyClosure } from './promotion-dependency-closure.mjs';
import { buildPaperProfileEvidenceContract } from './paper-profile-evidence-contract.mjs';

function values(value) {
  return Array.isArray(value) ? value : [];
}

export function explicitPaperQualityProfile(paperTask = {}) {
  const registry = paperTask.registry || {};
  const metadata = registry.metadata || registry.paperFactory || registry.paper_factory || {};
  const candidate = paperTask.paperQualityProfile
    || registry.paperQualityProfile
    || registry.paper_quality_profile
    || metadata.paperQualityProfile
    || metadata.paper_quality_profile
    || null;
  return Object.prototype.hasOwnProperty.call(PAPER_QUALITY_PROFILES, candidate) ? candidate : null;
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

export function buildPaperQualityEvidence({
  paperTask,
  theoremReadiness = null,
  researchReport = null,
  packageVerificationReceipt = null,
  buildResult = null,
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
  add('proof_review', theoremReadiness?.applicable === true && theoremReadiness?.passed === true,
    theoremReadiness?.theoremManuscriptReadinessPolicyHash);
  add('experiment_registry', capabilities.experimentRegistry?.status === 'experiment_registry_ready', capabilities.experimentRegistry?.experimentRegistryHash);
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
  theoremReadiness = null,
  researchReport = null,
  packageVerificationReceipt = null,
  buildResult = null,
  requirePackageVerification = false,
  requireResearchQuality = false,
  requirePaperQuality = Boolean(profile),
  boundary = 'package',
} = {}) {
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
  if ((profile === 'empirical_or_experiment' || experiments.length > 0)
    && experimentRegistry?.status !== 'experiment_registry_ready') {
    blockers.push('experiment_registry_required_for_promotion');
    blockers.push(...values(experimentRegistry?.incompleteExperimentIds).map((item) => `experiment_not_accepted:${item}`));
  }
  if (profile === 'empirical_or_experiment' && experiments.length === 0) {
    blockers.push('experiment_registry_empty_for_empirical_profile');
  }
  const formal = formalWorkerResults(researchReport);
  for (const item of formal) {
    if (item.resultStatus !== 'formal_claim_verified') blockers.push(`formal_claim_binding_required:${item.workerId || item.workerType}`);
  }
  const qualityEvidence = buildPaperQualityEvidence({ paperTask, theoremReadiness, researchReport, packageVerificationReceipt, buildResult });
  const paperProfileEvidenceContract = profile
    ? buildPaperProfileEvidenceContract({ paperTask, profile, claimRegistry: researchReport?.capabilities?.claimRegistry })
    : null;
  const paperQualityPolicy = profile
    ? evaluatePaperQualityPolicy({ paperId: paperTask?.paperId, profile, evidence: qualityEvidence, shadow: false, requirementsOverride: paperProfileEvidenceContract?.requirements, waivableRequirements: paperProfileEvidenceContract?.waivableRequirements })
    : null;
  if (requirePaperQuality && !profile) blockers.push('paper_quality_profile_required_for_promotion');
  if (requirePaperQuality && paperQualityPolicy?.status !== 'paper_quality_policy_passed') {
    blockers.push(...values(paperQualityPolicy?.blockers).map((item) => `paper_quality:${item}`));
  }
  const uniqueBlockers = [...new Set(blockers)];
  const payload = {
    version: 1,
    kind: 'ManuscriptPromotionGate',
    paperId: paperTask?.paperId || null,
    boundary,
    profile: profile || null,
    status: uniqueBlockers.length ? 'manuscript_promotion_blocked' : 'manuscript_promotion_ready',
    promotionReady: uniqueBlockers.length === 0,
    passed: uniqueBlockers.length === 0,
    theoremReadinessHash: theoremReadiness?.theoremManuscriptReadinessPolicyHash || null,
    paperQualityPolicy,
    paperProfileEvidenceContract,
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
