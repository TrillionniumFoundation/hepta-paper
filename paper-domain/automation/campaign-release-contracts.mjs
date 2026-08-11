import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  createAutonomousResearchReleaseBinding,
  verifyAutonomousResearchReleaseBinding,
} from './autonomous-research-release-binding-contract.mjs';

export { createAutonomousResearchReleaseBinding };
import {
  verifyCampaignReleaseEvidenceCapsuleManifest,
} from './campaign-release-evidence-capsule-contract.mjs';
import { manuscriptPromotionEvidenceEntailmentValid } from '../research/manuscript-promotion-entailment-release-policy.mjs';
import { verifyCampaignReleaseExecutionAttestationManifestBinding } from './campaign-release-execution-attestation-contract.mjs';
import { verifyCampaignReleasePackageBinding } from './campaign-release-package-binding-policy.mjs';
import {
  artifactPackageHashesValid,
  explicitTimestamp,
  matchesRecordHash,
  required,
  researchReportValid,
  researchSourceLineageValid,
  sourceRowsMerkleHash,
} from './campaign-release-contract-helpers.mjs';
import {
  verifyAdvancedNumericalCampaignExecutionPlan,
  verifyCampaignAdvancedNumericalExecutionResult,
} from './advanced-numerical-campaign-execution-contract.mjs';

const EMPIRICAL_ASSERTION_RELEASE_HASH_FIELDS = Object.freeze([
  'empiricalAssertionAuthorityHash',
  'empiricalAssertionUniverseHash',
  'empiricalAssertionUniverseBindingHash',
  'empiricalAssertionManuscriptCorpusHash',
]);

function empiricalAssertionReleaseHashes(record) {
  return Object.fromEntries(EMPIRICAL_ASSERTION_RELEASE_HASH_FIELDS.map((field) => [field, record?.[field] || null]));
}

function empiricalAssertionReleaseHashesMatch(left, right) {
  return EMPIRICAL_ASSERTION_RELEASE_HASH_FIELDS.every((field) => (left?.[field] || null) === (right?.[field] || null));
}

function advancedNumericalReleaseEvidenceValid({
  campaignPlanHash,
  campaignId,
  paperId,
  plan,
  evidence,
} = {}) {
  if (!plan && !evidence) return true;
  if (!plan || !evidence
    || !verifyAdvancedNumericalCampaignExecutionPlan(plan, {
      campaignId,
      paperId,
      nodeId: evidence.nodeId,
    })) return false;
  const node = {
    nodeId: evidence.nodeId,
    kind: 'advanced-numerical-analysis',
    attemptId: evidence.attemptId,
    leaseGeneration: evidence.leaseGeneration,
  };
  const campaign = {
    campaignId,
    paperId,
    spec: { campaignPlanHash },
  };
  const result = evidence.result;
  return verifyCampaignAdvancedNumericalExecutionResult(result, {
    campaign,
    node,
    plan,
    requirePromotionEligible: true,
  })
    && evidence.executionPlanHash
      === plan.advancedNumericalCampaignExecutionPlanHash
    && evidence.executionReceiptHash
      === result.advancedNumericalCampaignExecutionReceiptHash
    && evidence.evidenceHash === result.advancedNumericalCampaignEvidenceHash
    && evidence.evidenceDocumentHash === result.evidenceDocumentHash
    && evidence.productionQualified === true
    && evidence.promotionEligible === true;
}

function autonomousManuscriptSourceRowsMatch(binding, sourceTreeManifest) {
  if (!binding) return true;
  const rows = new Map((sourceTreeManifest?.rows || []).map((row) => [row.path, row]));
  const expected = [
    [binding.manuscriptPath, binding.renderedManuscriptHash],
    ['AUTONOMOUS_MANUSCRIPT_IR.json', binding.manuscriptIrFileHash],
    ['AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json', binding.agentAuthoredSourceDraftFileHash],
  ].filter(([, hash]) => hash);
  return expected.every(([path, hash]) => rows.get(path)?.hash === hash);
}

export function createAutomationPromotionCandidate({
  campaignPlanHash,
  campaignId,
  paperId,
  venueTarget = null,
  packageNode,
  finalCompileNode,
  researchVerifyNode = null,
  researchReport = null,
  campaignResearchSourceSnapshot = null,
  verifiedSourceMerkleHash,
  verifiedSourceWorkspaceManifestHash,
  sourceWorkspace,
  sourceSnapshotHash,
  sourceTreeManifest,
  researchEvidenceCapsuleManifest,
  researchExecutionReleaseAttestation = null,
  autonomousResearchReleaseBinding = null,
  createdAt,
  experimentRegistryAuthorityVerifier = null,
  advancedNumericalExecutionPlan = null,
  advancedNumericalExecutionEvidence = null,
} = {}) {
  if (packageNode?.kind !== 'package') throw new Error('automation_promotion_package_node_required');
  if (finalCompileNode?.kind !== 'final-compile') throw new Error('automation_promotion_final_compile_node_required');
  if (!(packageNode.dependencies || []).includes(finalCompileNode.nodeId)) {
    throw new Error('automation_promotion_final_compile_dependency_missing');
  }
  if (sourceTreeManifest?.status !== 'scoped_source_tree_verified' || !sourceTreeManifest?.sourceTreeManifestHash) {
    throw new Error('automation_promotion_source_manifest_not_verified');
  }
  if (!matchesRecordHash(sourceTreeManifest, 'ScopedSourceTreeManifest', 'sourceTreeManifestHash')) {
    throw new Error('automation_promotion_source_manifest_hash_invalid');
  }
  if (sourceRowsMerkleHash(sourceTreeManifest) !== verifiedSourceMerkleHash) {
    throw new Error('automation_promotion_source_archive_merkle_mismatch');
  }
  const capsuleVerification = verifyCampaignReleaseEvidenceCapsuleManifest(researchEvidenceCapsuleManifest, {
    campaignId,
    paperId,
    researchReportHash: researchReport?.researchReportHash,
    experimentRegistryHash: researchReport?.capabilities?.experimentRegistry?.experimentRegistryHash,
    campaignResearchSourceSnapshotHash: campaignResearchSourceSnapshot?.campaignResearchSourceSnapshotHash,
    verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash,
    researchVerifyNodeId: researchVerifyNode?.nodeId,
    researchVerifyAttemptId: researchVerifyNode?.attemptId,
    researchVerifyLeaseGeneration: researchVerifyNode?.leaseGeneration,
  });
  if (!capsuleVerification.valid) {
    throw new Error(`automation_promotion_research_evidence_capsule_invalid:${capsuleVerification.blockers.join(',')}`);
  }
  const executionAttestationVerification = verifyCampaignReleaseExecutionAttestationManifestBinding({
    manifest: researchEvidenceCapsuleManifest, attestation: researchExecutionReleaseAttestation,
  });
  if (!executionAttestationVerification.valid) {
    throw new Error(`automation_promotion_research_execution_attestation_invalid:${executionAttestationVerification.blockers.join(',')}`);
  }
  if (autonomousResearchReleaseBinding) {
    const autonomousBindingVerification = verifyAutonomousResearchReleaseBinding(
      autonomousResearchReleaseBinding,
      { campaignId, paperId, campaignPlanHash },
    );
    if (!autonomousBindingVerification.valid) {
      throw new Error(`automation_promotion_autonomous_research_binding_invalid:${autonomousBindingVerification.blockers.join(',')}`);
    }
    if (!autonomousManuscriptSourceRowsMatch(
      autonomousResearchReleaseBinding,
      sourceTreeManifest,
    )) {
      throw new Error('automation_promotion_autonomous_manuscript_source_binding_invalid');
    }
  }
  if (researchVerifyNode) {
    if (researchVerifyNode.kind !== 'research-verify' || !(packageNode.dependencies || []).includes(researchVerifyNode.nodeId)
      || !(researchVerifyNode.dependencies || []).includes(finalCompileNode.nodeId)) {
      throw new Error('automation_promotion_research_dependency_invalid');
    }
    if (!researchVerifyNode.attemptId || !Number.isInteger(researchVerifyNode.leaseGeneration) || researchVerifyNode.leaseGeneration < 1
      || !researchVerifyNode.resultSha256 || hashRecord('PaperCampaignNodeResult', researchVerifyNode.result) !== researchVerifyNode.resultSha256
      || !researchReportValid(researchReport, experimentRegistryAuthorityVerifier)
      || researchVerifyNode.result?.researchNodeId !== researchVerifyNode.nodeId
      || researchVerifyNode.result?.researchAttemptId !== researchVerifyNode.attemptId
      || researchVerifyNode.result?.researchLeaseGeneration !== researchVerifyNode.leaseGeneration
      || researchVerifyNode.result?.campaignResearchSourceSnapshotHash !== campaignResearchSourceSnapshot?.campaignResearchSourceSnapshotHash
      || researchVerifyNode.result?.verifiedSourceMerkleHash !== verifiedSourceMerkleHash
      || researchVerifyNode.result?.verifiedSourceWorkspaceManifestHash !== verifiedSourceWorkspaceManifestHash
      || researchVerifyNode.result?.proposalClaimToTheoremBindingHash
        !== researchReport?.proposalClaimToTheoremBindingHash) {
      throw new Error('automation_promotion_research_report_not_verified');
    }
  } else throw new Error('automation_promotion_research_node_required');
  if (!advancedNumericalReleaseEvidenceValid({
    campaignPlanHash,
    campaignId,
    paperId,
    plan: advancedNumericalExecutionPlan,
    evidence: advancedNumericalExecutionEvidence,
  })) {
    throw new Error('automation_promotion_advanced_numerical_evidence_invalid');
  }
  const finalCompileResultHash = finalCompileNode.resultSha256 || null;
  if (!finalCompileResultHash || hashRecord('PaperCampaignNodeResult', finalCompileNode.result) !== finalCompileResultHash) throw new Error('automation_promotion_final_compile_result_hash_required');
  if (finalCompileNode.result?.sourceMerkleHash !== verifiedSourceMerkleHash
    || finalCompileNode.result?.sourceWorkspaceManifestHash !== verifiedSourceWorkspaceManifestHash) {
    throw new Error('automation_promotion_final_compile_source_identity_mismatch');
  }
  const packageAttemptId = packageNode.attemptId || null;
  if (!packageAttemptId) throw new Error('automation_promotion_package_attempt_id_required');
  if (researchVerifyNode || researchReport) {
    if (researchVerifyNode?.kind !== 'research-verify' || researchVerifyNode.status !== 'completed' || !(packageNode.dependencies || []).includes(researchVerifyNode.nodeId)) throw new Error('automation_promotion_research_dependency_invalid');
    if (researchReport?.kind !== 'PaperResearchVerifyReport' || !researchReport.researchReportHash || researchReport.promotionEligibility?.status !== 'research_promotion_ready') throw new Error('automation_promotion_research_report_invalid');
    if (!researchSourceLineageValid({
      researchReport,
      campaignResearchSourceSnapshot,
      campaignId,
      paperId,
      researchVerifyNodeId: researchVerifyNode.nodeId,
      researchVerifyAttemptId: researchVerifyNode.attemptId,
      researchVerifyLeaseGeneration: researchVerifyNode.leaseGeneration,
      verifiedSourceMerkleHash,
      verifiedSourceWorkspaceManifestHash,
    })) throw new Error('automation_promotion_research_source_lineage_invalid');
  } else if (campaignResearchSourceSnapshot) {
    throw new Error('automation_promotion_research_source_snapshot_without_report');
  }
  const payload = {
    version: 1,
    kind: 'AutomationPromotionCandidate',
    status: 'automation_promotion_candidate_ready',
    campaignPlanHash: required(campaignPlanHash, 'automation_promotion_campaign_plan_hash'),
    campaignId: required(campaignId, 'automation_promotion_campaign_id'),
    paperId: required(paperId, 'automation_promotion_paper_id'),
    venueTarget: String(venueTarget || '').trim() || null,
    packageNodeId: required(packageNode.nodeId, 'automation_promotion_package_node_id'),
    packageAttemptId,
    finalCompileNodeId: required(finalCompileNode.nodeId, 'automation_promotion_final_compile_node_id'),
    finalCompileResultHash,
    researchVerifyNodeId: researchVerifyNode?.nodeId || null,
    researchVerifyAttemptId: researchVerifyNode?.attemptId || null,
    researchVerifyLeaseGeneration: researchVerifyNode?.leaseGeneration || null,
    researchVerifyResultHash: researchVerifyNode?.resultSha256 || null,
    researchReportHash: researchReport?.researchReportHash || null,
    proposalClaimToTheoremBindingHash:
      researchReport?.proposalClaimToTheoremBindingHash || null,
    experimentRegistryHash: researchReport?.capabilities?.experimentRegistry?.experimentRegistryHash || null,
    ...empiricalAssertionReleaseHashes(researchReport),
    campaignResearchSourceSnapshotHash: campaignResearchSourceSnapshot?.campaignResearchSourceSnapshotHash || null,
    campaignResearchSourceSnapshot,
    verifiedSourceMerkleHash: required(verifiedSourceMerkleHash, 'automation_promotion_verified_source_merkle_hash'),
    verifiedSourceWorkspaceManifestHash: required(verifiedSourceWorkspaceManifestHash, 'automation_promotion_verified_source_workspace_manifest_hash'),
    sourceWorkspace: required(sourceWorkspace, 'automation_promotion_source_workspace'),
    sourceSnapshotHash: required(sourceSnapshotHash, 'automation_promotion_source_snapshot_hash'),
    sourceTreeManifestHash: sourceTreeManifest.sourceTreeManifestHash,
    sourceTreeManifest,
    researchEvidenceCapsuleManifestHash: researchEvidenceCapsuleManifest.researchEvidenceCapsuleManifestHash,
    researchExecutionReleaseAttestationHash:
      researchExecutionReleaseAttestation?.campaignReleaseExecutionAttestationHash || null,
    ...(autonomousResearchReleaseBinding ? {
      autonomousResearchReleaseBindingHash:
        autonomousResearchReleaseBinding.autonomousResearchReleaseBindingHash,
      autonomousResearchReleaseBinding,
    } : {}),
    ...(advancedNumericalExecutionPlan ? {
      advancedNumericalExecutionPlanHash:
        advancedNumericalExecutionPlan.advancedNumericalCampaignExecutionPlanHash,
      advancedNumericalCampaignExecutionReceiptHash:
        advancedNumericalExecutionEvidence.executionReceiptHash,
      advancedNumericalCampaignEvidenceHash:
        advancedNumericalExecutionEvidence.evidenceHash,
      advancedNumericalExecutionPlan,
      advancedNumericalExecutionEvidence,
    } : {}),
    createdAt: explicitTimestamp(createdAt),
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, automationPromotionCandidateHash: hashRecord('AutomationPromotionCandidate', payload) });
}

export function createCampaignReleaseBundle({
  promotionCandidate,
  artifactPackage,
  packageVerificationReceipt,
  manuscriptPromotionGate,
  researchReport = null,
  researchEvidenceCapsuleManifest,
  researchExecutionReleaseAttestation = null,
  packageOutput,
  createdAt,
  experimentRegistryAuthorityVerifier = null,
} = {}) {
  if (!matchesRecordHash(promotionCandidate, 'AutomationPromotionCandidate', 'automationPromotionCandidateHash')) {
    throw new Error('campaign_release_promotion_candidate_hash_invalid');
  }
  if (!advancedNumericalReleaseEvidenceValid({
    campaignPlanHash: promotionCandidate.campaignPlanHash,
    campaignId: promotionCandidate.campaignId,
    paperId: promotionCandidate.paperId,
    plan: promotionCandidate.advancedNumericalExecutionPlan || null,
    evidence: promotionCandidate.advancedNumericalExecutionEvidence || null,
  })) {
    throw new Error('campaign_release_advanced_numerical_evidence_invalid');
  }
  if (promotionCandidate.autonomousResearchReleaseBinding) {
    const autonomousBindingVerification = verifyAutonomousResearchReleaseBinding(
      promotionCandidate.autonomousResearchReleaseBinding,
      {
        campaignId: promotionCandidate.campaignId,
        paperId: promotionCandidate.paperId,
        campaignPlanHash: promotionCandidate.campaignPlanHash,
      },
    );
    if (!autonomousBindingVerification.valid
      || promotionCandidate.autonomousResearchReleaseBindingHash
        !== promotionCandidate.autonomousResearchReleaseBinding
          .autonomousResearchReleaseBindingHash) {
      throw new Error('campaign_release_autonomous_research_binding_invalid');
    }
  }
  if (!artifactPackageHashesValid(artifactPackage)) {
    throw new Error('campaign_release_artifact_package_hash_invalid');
  }
  if (artifactPackage.submitReady !== true) throw new Error('campaign_release_artifact_package_not_submit_ready');
  if (artifactPackage.paperId !== promotionCandidate.paperId) throw new Error('campaign_release_artifact_package_paper_mismatch');
  if (!matchesRecordHash(packageVerificationReceipt, 'PackageVerificationReceipt', 'packageVerificationReceiptHash')) {
    throw new Error('campaign_release_package_verification_hash_invalid');
  }
  if (packageVerificationReceipt.status !== 'package_verification_passed') {
    throw new Error('campaign_release_package_verification_not_passed');
  }
  if (packageVerificationReceipt.paperId !== promotionCandidate.paperId) throw new Error('campaign_release_package_verification_paper_mismatch');
  if (packageVerificationReceipt.verifiedArtifactPackageHash !== artifactPackage.candidateArtifactPackageHash) {
    throw new Error('campaign_release_candidate_artifact_package_mismatch');
  }
  if (artifactPackage.packageVerificationReceiptHash !== packageVerificationReceipt.packageVerificationReceiptHash) {
    throw new Error('campaign_release_package_verification_binding_mismatch');
  }
  if (!matchesRecordHash(manuscriptPromotionGate, 'ManuscriptPromotionGate', 'manuscriptPromotionGateHash')
    || manuscriptPromotionGate.status !== 'manuscript_promotion_ready'
    || artifactPackage.manuscriptPromotionGateHash !== manuscriptPromotionGate.manuscriptPromotionGateHash
    || manuscriptPromotionGate.experimentRegistryHash !== promotionCandidate.experimentRegistryHash
    || !manuscriptPromotionEvidenceEntailmentValid(manuscriptPromotionGate)) {
    throw new Error('campaign_release_manuscript_promotion_binding_invalid');
  }
  if (promotionCandidate.researchReportHash) {
    if (!researchReportValid(researchReport, experimentRegistryAuthorityVerifier) || researchReport.researchReportHash !== promotionCandidate.researchReportHash) throw new Error('campaign_release_research_report_binding_invalid');
    if (researchReport?.capabilities?.experimentRegistry?.experimentRegistryHash !== promotionCandidate.experimentRegistryHash) throw new Error('campaign_release_experiment_registry_binding_invalid');
    if (!empiricalAssertionReleaseHashesMatch(promotionCandidate, researchReport)) throw new Error('campaign_release_empirical_assertion_binding_invalid');
    if (!researchSourceLineageValid({
      researchReport,
      campaignResearchSourceSnapshot: promotionCandidate.campaignResearchSourceSnapshot,
      campaignId: promotionCandidate.campaignId,
      paperId: promotionCandidate.paperId,
      researchVerifyNodeId: promotionCandidate.researchVerifyNodeId,
      researchVerifyAttemptId: promotionCandidate.researchVerifyAttemptId,
      researchVerifyLeaseGeneration: promotionCandidate.researchVerifyLeaseGeneration,
      verifiedSourceMerkleHash: promotionCandidate.verifiedSourceMerkleHash,
      verifiedSourceWorkspaceManifestHash: promotionCandidate.verifiedSourceWorkspaceManifestHash,
    })) throw new Error('campaign_release_research_source_lineage_invalid');
  } else if (promotionCandidate.experimentRegistryHash || researchReport) {
    throw new Error('campaign_release_experiment_registry_without_research_report');
  }
  if (artifactPackage.sourceSnapshotHash !== promotionCandidate.sourceSnapshotHash
    || artifactPackage.sourceTreeManifestHash !== promotionCandidate.sourceTreeManifestHash
    || packageVerificationReceipt.sourceTreeManifestHash !== promotionCandidate.sourceTreeManifestHash) {
    throw new Error('campaign_release_source_lineage_mismatch');
  }
  const capsuleVerification = verifyCampaignReleaseEvidenceCapsuleManifest(researchEvidenceCapsuleManifest, {
    campaignId: promotionCandidate.campaignId,
    paperId: promotionCandidate.paperId,
    researchReportHash: promotionCandidate.researchReportHash,
    experimentRegistryHash: promotionCandidate.experimentRegistryHash,
    campaignResearchSourceSnapshotHash: promotionCandidate.campaignResearchSourceSnapshotHash,
    verifiedSourceMerkleHash: promotionCandidate.verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash: promotionCandidate.verifiedSourceWorkspaceManifestHash,
    researchVerifyNodeId: promotionCandidate.researchVerifyNodeId,
    researchVerifyAttemptId: promotionCandidate.researchVerifyAttemptId,
    researchVerifyLeaseGeneration: promotionCandidate.researchVerifyLeaseGeneration,
  });
  if (!capsuleVerification.valid
    || promotionCandidate.researchEvidenceCapsuleManifestHash !== researchEvidenceCapsuleManifest?.researchEvidenceCapsuleManifestHash) {
    throw new Error(`campaign_release_evidence_capsule_binding_invalid:${capsuleVerification.blockers.join(',')}`);
  }
  const executionAttestationVerification = verifyCampaignReleaseExecutionAttestationManifestBinding({
    manifest: researchEvidenceCapsuleManifest, attestation: researchExecutionReleaseAttestation,
    manifestFileHash: packageOutput?.researchEvidenceCapsuleManifestFileHash,
  });
  if (!executionAttestationVerification.valid
    || promotionCandidate.researchExecutionReleaseAttestationHash
      !== (researchExecutionReleaseAttestation?.campaignReleaseExecutionAttestationHash || null)) {
    throw new Error('campaign_release_execution_attestation_binding_invalid');
  }
  const packageBinding = verifyCampaignReleasePackageBinding({
    packageOutput, artifactPackage, packageVerificationReceipt,
    paperId: promotionCandidate.paperId,
    sourcePackageContractHash: promotionCandidate.sourceTreeManifest?.sourcePackageContractHash,
    sourceTreeManifestHash: promotionCandidate.sourceTreeManifestHash,
    sourceMerkleHash: promotionCandidate.verifiedSourceMerkleHash,
    sourceWorkspaceManifestHash: promotionCandidate.verifiedSourceWorkspaceManifestHash,
    researchEvidenceCapsuleManifest,
    researchExecutionReleaseAttestation,
  });
  if (!packageBinding.valid) {
    throw new Error(`campaign_release_immutable_package_output_required:${packageBinding.blockers.join(',')}`);
  }
  const payload = {
    version: 1,
    kind: 'CampaignReleaseBundle',
    status: 'campaign_release_bundle_prepared',
    campaignPlanHash: promotionCandidate.campaignPlanHash,
    campaignId: promotionCandidate.campaignId,
    paperId: promotionCandidate.paperId,
    venueTarget: promotionCandidate.venueTarget || null,
    packageNodeId: promotionCandidate.packageNodeId,
    packageAttemptId: promotionCandidate.packageAttemptId,
    sourceSnapshotHash: promotionCandidate.sourceSnapshotHash,
    sourceTreeManifestHash: promotionCandidate.sourceTreeManifestHash,
    verifiedSourceMerkleHash: promotionCandidate.verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash: promotionCandidate.verifiedSourceWorkspaceManifestHash,
    campaignResearchSourceSnapshotHash: promotionCandidate.campaignResearchSourceSnapshotHash,
    campaignResearchSourceSnapshot: promotionCandidate.campaignResearchSourceSnapshot,
    researchVerifyNodeId: promotionCandidate.researchVerifyNodeId,
    researchVerifyAttemptId: promotionCandidate.researchVerifyAttemptId,
    researchVerifyLeaseGeneration: promotionCandidate.researchVerifyLeaseGeneration,
    automationPromotionCandidateHash: promotionCandidate.automationPromotionCandidateHash,
    promotionCandidate,
    artifactPackageHash: artifactPackage.artifactPackageHash,
    artifactPackage,
    packageVerificationReceiptHash: packageVerificationReceipt.packageVerificationReceiptHash,
    packageVerificationReceipt,
    manuscriptPromotionGateHash: manuscriptPromotionGate.manuscriptPromotionGateHash,
    manuscriptPromotionGate,
    researchReportHash: researchReport?.researchReportHash || null,
    proposalClaimToTheoremBindingHash:
      researchReport?.proposalClaimToTheoremBindingHash || null,
    experimentRegistryHash: researchReport?.capabilities?.experimentRegistry?.experimentRegistryHash || null,
    ...empiricalAssertionReleaseHashes(researchReport),
    researchReport,
    researchEvidenceCapsuleManifestHash: researchEvidenceCapsuleManifest.researchEvidenceCapsuleManifestHash,
    researchEvidenceCapsuleManifest,
    researchExecutionReleaseAttestationHash:
      researchExecutionReleaseAttestation?.campaignReleaseExecutionAttestationHash || null,
    researchExecutionReleaseAttestation,
    ...(promotionCandidate.autonomousResearchReleaseBinding ? {
      autonomousResearchReleaseBindingHash:
        promotionCandidate.autonomousResearchReleaseBindingHash,
      autonomousResearchReleaseBinding:
        promotionCandidate.autonomousResearchReleaseBinding,
    } : {}),
    ...(promotionCandidate.advancedNumericalExecutionPlan ? {
      advancedNumericalExecutionPlanHash:
        promotionCandidate.advancedNumericalExecutionPlanHash,
      advancedNumericalCampaignExecutionReceiptHash:
        promotionCandidate.advancedNumericalCampaignExecutionReceiptHash,
      advancedNumericalCampaignEvidenceHash:
        promotionCandidate.advancedNumericalCampaignEvidenceHash,
      advancedNumericalExecutionPlan:
        promotionCandidate.advancedNumericalExecutionPlan,
      advancedNumericalExecutionEvidence:
        promotionCandidate.advancedNumericalExecutionEvidence,
    } : {}),
    immutableCampaignPackageOutputHash: packageOutput.immutableCampaignPackageOutputHash,
    packageOutput: Object.freeze({ ...packageOutput }),
    createdAt: explicitTimestamp(createdAt),
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, campaignReleaseBundleHash: hashRecord('CampaignReleaseBundle', payload) });
}

export function verifyCampaignReleaseBundle(bundle, expected = {}, { experimentRegistryAuthorityVerifier = null } = {}) {
  const blockers = [];
  if (bundle?.version !== 1 || bundle?.kind !== 'CampaignReleaseBundle' || bundle?.status !== 'campaign_release_bundle_prepared') {
    blockers.push('campaign_release_bundle_shape_invalid');
  }
  if (!matchesRecordHash(bundle, 'CampaignReleaseBundle', 'campaignReleaseBundleHash')) blockers.push('campaign_release_bundle_hash_invalid');
  const candidate = bundle?.promotionCandidate;
  if (!matchesRecordHash(candidate, 'AutomationPromotionCandidate', 'automationPromotionCandidateHash')) blockers.push('automation_promotion_candidate_hash_invalid');
  if (bundle?.automationPromotionCandidateHash !== candidate?.automationPromotionCandidateHash) blockers.push('campaign_release_candidate_binding_mismatch');
  if (!advancedNumericalReleaseEvidenceValid({
    campaignPlanHash: bundle?.campaignPlanHash,
    campaignId: bundle?.campaignId,
    paperId: bundle?.paperId,
    plan: bundle?.advancedNumericalExecutionPlan || null,
    evidence: bundle?.advancedNumericalExecutionEvidence || null,
  })
    || bundle?.advancedNumericalExecutionPlanHash
      !== candidate?.advancedNumericalExecutionPlanHash
    || bundle?.advancedNumericalCampaignExecutionReceiptHash
      !== candidate?.advancedNumericalCampaignExecutionReceiptHash
    || bundle?.advancedNumericalCampaignEvidenceHash
      !== candidate?.advancedNumericalCampaignEvidenceHash
    || JSON.stringify(bundle?.advancedNumericalExecutionPlan || null)
      !== JSON.stringify(candidate?.advancedNumericalExecutionPlan || null)
    || JSON.stringify(bundle?.advancedNumericalExecutionEvidence || null)
      !== JSON.stringify(candidate?.advancedNumericalExecutionEvidence || null)) {
    blockers.push('campaign_release_advanced_numerical_evidence_invalid');
  }
  if (bundle?.autonomousResearchReleaseBinding || candidate?.autonomousResearchReleaseBinding) {
    const autonomousBindingVerification = verifyAutonomousResearchReleaseBinding(
      bundle?.autonomousResearchReleaseBinding,
      {
        campaignId: bundle?.campaignId,
        paperId: bundle?.paperId,
        campaignPlanHash: bundle?.campaignPlanHash,
      },
    );
    if (!autonomousBindingVerification.valid
      || bundle?.autonomousResearchReleaseBindingHash
        !== bundle?.autonomousResearchReleaseBinding?.autonomousResearchReleaseBindingHash
      || bundle?.autonomousResearchReleaseBindingHash
        !== candidate?.autonomousResearchReleaseBindingHash) {
      blockers.push('campaign_release_autonomous_research_binding_invalid');
    }
    if (!autonomousManuscriptSourceRowsMatch(
      bundle?.autonomousResearchReleaseBinding,
      candidate?.sourceTreeManifest,
    )) blockers.push('campaign_release_autonomous_manuscript_source_binding_invalid');
  }
  if (['campaignPlanHash', 'campaignId', 'paperId', 'venueTarget', 'packageNodeId', 'packageAttemptId', 'sourceSnapshotHash', 'sourceTreeManifestHash',
    'verifiedSourceMerkleHash', 'verifiedSourceWorkspaceManifestHash', 'campaignResearchSourceSnapshotHash',
    'researchVerifyNodeId', 'researchVerifyAttemptId', 'researchVerifyLeaseGeneration', 'experimentRegistryHash',
    'proposalClaimToTheoremBindingHash',
    'advancedNumericalExecutionPlanHash',
    'advancedNumericalCampaignExecutionReceiptHash',
    'advancedNumericalCampaignEvidenceHash',
    ...EMPIRICAL_ASSERTION_RELEASE_HASH_FIELDS,
    'researchEvidenceCapsuleManifestHash', 'researchExecutionReleaseAttestationHash']
    .some((field) => bundle?.[field] !== candidate?.[field])) blockers.push('campaign_release_candidate_lineage_mismatch');
  const manifest = candidate?.sourceTreeManifest;
  if (!matchesRecordHash(manifest, 'ScopedSourceTreeManifest', 'sourceTreeManifestHash')) blockers.push('campaign_release_source_manifest_hash_invalid');
  if (manifest?.status !== 'scoped_source_tree_verified') blockers.push('campaign_release_source_manifest_not_verified');
  if (candidate?.sourceSnapshotHash !== bundle?.sourceSnapshotHash
    || candidate?.sourceTreeManifestHash !== bundle?.sourceTreeManifestHash
    || candidate?.sourceTreeManifestHash !== manifest?.sourceTreeManifestHash) blockers.push('campaign_release_source_lineage_mismatch');
  if (sourceRowsMerkleHash(manifest) !== bundle?.verifiedSourceMerkleHash) blockers.push('campaign_release_source_archive_merkle_mismatch');
  const artifactPackage = bundle?.artifactPackage;
  if (!artifactPackageHashesValid(artifactPackage)) blockers.push('campaign_release_artifact_package_hash_invalid');
  if (artifactPackage?.submitReady !== true) blockers.push('campaign_release_artifact_package_not_submit_ready');
  if (artifactPackage?.paperId !== bundle?.paperId) blockers.push('campaign_release_artifact_package_paper_mismatch');
  if (bundle?.artifactPackageHash !== artifactPackage?.artifactPackageHash) blockers.push('campaign_release_artifact_package_binding_mismatch');
  const verification = bundle?.packageVerificationReceipt;
  if (!matchesRecordHash(verification, 'PackageVerificationReceipt', 'packageVerificationReceiptHash')) blockers.push('campaign_release_package_verification_hash_invalid');
  if (verification?.status !== 'package_verification_passed') blockers.push('campaign_release_package_verification_not_passed');
  if (verification?.paperId !== bundle?.paperId) blockers.push('campaign_release_package_verification_paper_mismatch');
  if (bundle?.packageVerificationReceiptHash !== verification?.packageVerificationReceiptHash
    || artifactPackage?.packageVerificationReceiptHash !== verification?.packageVerificationReceiptHash) blockers.push('campaign_release_package_verification_binding_mismatch');
  if (verification?.verifiedArtifactPackageHash !== artifactPackage?.candidateArtifactPackageHash) blockers.push('campaign_release_candidate_artifact_package_mismatch');
  const promotionGate = bundle?.manuscriptPromotionGate;
  if (!matchesRecordHash(promotionGate, 'ManuscriptPromotionGate', 'manuscriptPromotionGateHash')
    || promotionGate?.status !== 'manuscript_promotion_ready'
    || bundle?.manuscriptPromotionGateHash !== promotionGate?.manuscriptPromotionGateHash
    || artifactPackage?.manuscriptPromotionGateHash !== promotionGate?.manuscriptPromotionGateHash
    || !manuscriptPromotionEvidenceEntailmentValid(promotionGate)) blockers.push('campaign_release_manuscript_promotion_binding_invalid');
  if (promotionGate?.experimentRegistryHash !== bundle?.experimentRegistryHash
    || promotionGate?.experimentRegistryHash !== candidate?.experimentRegistryHash) {
    blockers.push('campaign_release_promotion_gate_experiment_registry_binding_invalid');
  }
  if (candidate?.researchReportHash) {
    if (!researchReportValid(bundle?.researchReport, experimentRegistryAuthorityVerifier)
      || bundle?.researchReportHash !== candidate.researchReportHash
      || bundle?.researchReport?.researchReportHash !== candidate.researchReportHash
      || bundle?.proposalClaimToTheoremBindingHash !== candidate.proposalClaimToTheoremBindingHash
      || (bundle?.researchReport?.proposalClaimToTheoremBindingHash || null)
        !== candidate.proposalClaimToTheoremBindingHash
      || !empiricalAssertionReleaseHashesMatch(bundle, bundle?.researchReport)
      || bundle?.researchReport?.promotionEligibility?.status !== 'research_promotion_ready') blockers.push('campaign_release_research_report_binding_invalid');
    if (bundle?.experimentRegistryHash !== candidate?.experimentRegistryHash
      || bundle?.researchReport?.capabilities?.experimentRegistry?.experimentRegistryHash !== candidate?.experimentRegistryHash) {
      blockers.push('campaign_release_experiment_registry_binding_invalid');
    }
    if (bundle?.campaignResearchSourceSnapshotHash !== bundle?.campaignResearchSourceSnapshot?.campaignResearchSourceSnapshotHash
      || candidate?.campaignResearchSourceSnapshotHash !== candidate?.campaignResearchSourceSnapshot?.campaignResearchSourceSnapshotHash
      || !researchSourceLineageValid({
        researchReport: bundle?.researchReport,
        campaignResearchSourceSnapshot: bundle?.campaignResearchSourceSnapshot,
        campaignId: bundle?.campaignId,
        paperId: bundle?.paperId,
        researchVerifyNodeId: bundle?.researchVerifyNodeId,
        researchVerifyAttemptId: bundle?.researchVerifyAttemptId,
        researchVerifyLeaseGeneration: bundle?.researchVerifyLeaseGeneration,
        verifiedSourceMerkleHash: bundle?.verifiedSourceMerkleHash,
        verifiedSourceWorkspaceManifestHash: bundle?.verifiedSourceWorkspaceManifestHash,
      })) blockers.push('campaign_release_research_source_lineage_invalid');
    const capsuleVerification = verifyCampaignReleaseEvidenceCapsuleManifest(bundle?.researchEvidenceCapsuleManifest, {
      campaignId: bundle?.campaignId,
      paperId: bundle?.paperId,
      researchReportHash: bundle?.researchReportHash,
      experimentRegistryHash: bundle?.experimentRegistryHash,
      campaignResearchSourceSnapshotHash: bundle?.campaignResearchSourceSnapshotHash,
      verifiedSourceMerkleHash: bundle?.verifiedSourceMerkleHash,
      verifiedSourceWorkspaceManifestHash: bundle?.verifiedSourceWorkspaceManifestHash,
      researchVerifyNodeId: bundle?.researchVerifyNodeId,
      researchVerifyAttemptId: bundle?.researchVerifyAttemptId,
      researchVerifyLeaseGeneration: bundle?.researchVerifyLeaseGeneration,
    });
    if (!capsuleVerification.valid
      || bundle?.researchEvidenceCapsuleManifestHash !== bundle?.researchEvidenceCapsuleManifest?.researchEvidenceCapsuleManifestHash
      || bundle?.researchEvidenceCapsuleManifestHash !== candidate?.researchEvidenceCapsuleManifestHash) {
      blockers.push('campaign_release_evidence_capsule_binding_invalid', ...capsuleVerification.blockers);
    }
    const executionAttestationVerification = verifyCampaignReleaseExecutionAttestationManifestBinding({
      manifest: bundle?.researchEvidenceCapsuleManifest,
      attestation: bundle?.researchExecutionReleaseAttestation,
      manifestFileHash: bundle?.packageOutput?.researchEvidenceCapsuleManifestFileHash,
    });
    if (!executionAttestationVerification.valid
      || bundle?.researchExecutionReleaseAttestationHash
        !== (bundle?.researchExecutionReleaseAttestation?.campaignReleaseExecutionAttestationHash || null)) {
      blockers.push('campaign_release_execution_attestation_binding_invalid', ...executionAttestationVerification.blockers);
    }
  } else {
    if (bundle?.campaignResearchSourceSnapshotHash || bundle?.campaignResearchSourceSnapshot) {
      blockers.push('campaign_release_research_source_snapshot_without_report');
    }
    if (bundle?.experimentRegistryHash || candidate?.experimentRegistryHash || promotionGate?.experimentRegistryHash || bundle?.researchReport) {
      blockers.push('campaign_release_experiment_registry_without_research_report');
    }
  }
  if (artifactPackage?.sourceSnapshotHash !== bundle?.sourceSnapshotHash
    || artifactPackage?.sourceTreeManifestHash !== bundle?.sourceTreeManifestHash
    || verification?.sourceTreeManifestHash !== bundle?.sourceTreeManifestHash) blockers.push('campaign_release_artifact_source_lineage_mismatch');
  const packageBinding = verifyCampaignReleasePackageBinding({
    packageOutput: bundle?.packageOutput,
    artifactPackage,
    packageVerificationReceipt: verification,
    paperId: bundle?.paperId,
    sourcePackageContractHash: candidate?.sourceTreeManifest?.sourcePackageContractHash,
    sourceTreeManifestHash: bundle?.sourceTreeManifestHash,
    sourceMerkleHash: bundle?.verifiedSourceMerkleHash,
    sourceWorkspaceManifestHash: bundle?.verifiedSourceWorkspaceManifestHash,
    researchEvidenceCapsuleManifest: bundle?.researchEvidenceCapsuleManifest,
    researchExecutionReleaseAttestation: bundle?.researchExecutionReleaseAttestation,
  });
  if (!packageBinding.valid
    || bundle?.immutableCampaignPackageOutputHash !== bundle?.packageOutput?.immutableCampaignPackageOutputHash) {
    blockers.push(...packageBinding.blockers, 'campaign_release_package_output_binding_invalid');
  }
  for (const [field, blocker] of [
    ['campaignId', 'campaign_release_campaign_id_mismatch'],
    ['campaignPlanHash', 'campaign_release_campaign_plan_hash_mismatch'],
    ['paperId', 'campaign_release_paper_id_mismatch'],
    ['venueTarget', 'campaign_release_venue_target_mismatch'],
    ['packageNodeId', 'campaign_release_package_node_id_mismatch'],
    ['packageAttemptId', 'campaign_release_package_attempt_id_mismatch'],
    ['researchReportHash', 'campaign_release_research_report_mismatch'],
    ['experimentRegistryHash', 'campaign_release_experiment_registry_mismatch'],
    ...EMPIRICAL_ASSERTION_RELEASE_HASH_FIELDS.map((field) => [field, `campaign_release_${field}_mismatch`]),
    ['proposalClaimToTheoremBindingHash', 'campaign_release_proposal_theorem_lineage_mismatch'],
    ['autonomousResearchReleaseBindingHash', 'campaign_release_autonomous_research_binding_mismatch'],
    ['researchVerifyNodeId', 'campaign_release_research_node_mismatch'],
    ['researchVerifyAttemptId', 'campaign_release_research_attempt_mismatch'],
    ['researchVerifyLeaseGeneration', 'campaign_release_research_lease_mismatch'],
    ['verifiedSourceMerkleHash', 'campaign_release_verified_source_merkle_mismatch'],
    ['verifiedSourceWorkspaceManifestHash', 'campaign_release_verified_source_manifest_mismatch'],
    ['advancedNumericalExecutionPlanHash', 'campaign_release_advanced_numerical_plan_mismatch'],
    ['advancedNumericalCampaignExecutionReceiptHash', 'campaign_release_advanced_numerical_receipt_mismatch'],
    ['advancedNumericalCampaignEvidenceHash', 'campaign_release_advanced_numerical_evidence_mismatch'],
  ]) if (expected[field] && bundle?.[field] !== expected[field]) blockers.push(blocker);
  return Object.freeze({ valid: blockers.length === 0, blockers: [...new Set(blockers)] });
}

export function createCampaignReleasePromotionReceipt({ campaign, packageNode, packageResult, promotedAt, experimentRegistryAuthorityVerifier = null } = {}) {
  const releaseBundle = packageResult?.releaseBundle;
  const expected = {
    campaignId: campaign?.campaignId,
    campaignPlanHash: campaign?.spec?.campaignPlanHash,
    paperId: campaign?.paperId,
    venueTarget: campaign?.spec?.venueTarget || null,
    packageNodeId: packageNode?.nodeId,
    packageAttemptId: packageNode?.attemptId,
  };
  const verification = verifyCampaignReleaseBundle(releaseBundle, expected, { experimentRegistryAuthorityVerifier });
  if (!verification.valid) throw new Error(`campaign_release_promotion_bundle_invalid:${verification.blockers.join(',')}`);
  const {
    campaignReleasePackageResultHash: claimedPackageResultHash,
    workspaceAttemptIntegration: _workspaceAttemptIntegration,
    ...packageResultPayload
  } = packageResult || {};
  if (!claimedPackageResultHash || hashRecord('CampaignReleasePackageResult', packageResultPayload) !== claimedPackageResultHash) {
    throw new Error('campaign_release_package_result_hash_invalid');
  }
  const authoritativeResultHash = packageNode?.preparedResultHash || null;
  if (!authoritativeResultHash || hashRecord('PaperCampaignNodeResult', packageResult) !== authoritativeResultHash) {
    throw new Error('campaign_release_authoritative_result_hash_invalid');
  }
  const materializationReceipt = packageResult?.materializationReceipt;
  if (!matchesRecordHash(materializationReceipt, 'CampaignReleaseBundleMaterializationReceipt', 'campaignReleaseBundleMaterializationReceiptHash')
    || materializationReceipt?.status !== 'campaign_release_bundle_materialized'
    || materializationReceipt?.campaignReleaseBundleHash !== releaseBundle.campaignReleaseBundleHash
    || packageResult?.campaignReleaseBundleMaterializationReceiptHash !== materializationReceipt?.campaignReleaseBundleMaterializationReceiptHash) {
    throw new Error('campaign_release_materialization_receipt_invalid');
  }
  const integrationDescriptorHash = packageNode?.preparedIntegrationKey || packageNode?.prepared_integration_key || null;
  const integrationReceiptHash = packageNode?.preparedIntegrationReceiptHash || packageNode?.prepared_integration_receipt_sha256 || null;
  if (packageNode?.preparedIntegrationStatus !== 'integrated' && packageNode?.prepared_integration_status !== 'integrated') {
    throw new Error('campaign_release_package_attempt_not_integrated');
  }
  if (!integrationDescriptorHash || !integrationReceiptHash) throw new Error('campaign_release_integration_authority_required');
  const leaseGeneration = Number(packageNode?.leaseGeneration ?? packageNode?.lease_generation);
  if (!Number.isInteger(leaseGeneration) || leaseGeneration < 1) throw new Error('campaign_release_lease_generation_invalid');
  const payload = {
    version: 1,
    kind: 'CampaignReleasePromotionReceipt',
    status: 'campaign_release_current_completed',
    campaignId: expected.campaignId,
    paperId: expected.paperId,
    venueTarget: releaseBundle.venueTarget || null,
    campaignPlanHash: expected.campaignPlanHash,
    packageNodeId: expected.packageNodeId,
    packageAttemptId: expected.packageAttemptId,
    leaseGeneration,
    packageResultHash: authoritativeResultHash,
    integrationDescriptorHash,
    integrationReceiptHash,
    campaignReleaseBundleHash: releaseBundle.campaignReleaseBundleHash,
    verifiedSourceMerkleHash: releaseBundle.verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash: releaseBundle.verifiedSourceWorkspaceManifestHash,
    campaignResearchSourceSnapshotHash: releaseBundle.campaignResearchSourceSnapshotHash || null,
    experimentRegistryHash: releaseBundle.experimentRegistryHash || null,
    ...empiricalAssertionReleaseHashes(releaseBundle),
    researchVerifyNodeId: releaseBundle.researchVerifyNodeId || null,
    researchVerifyAttemptId: releaseBundle.researchVerifyAttemptId || null,
    researchVerifyLeaseGeneration: releaseBundle.researchVerifyLeaseGeneration || null,
    materializationReceiptHash: materializationReceipt.campaignReleaseBundleMaterializationReceiptHash,
    packageNodeStatus: 'completed',
    campaignStatus: 'completed',
    packageCompletedAt: explicitTimestamp(promotedAt),
    promotedAt: explicitTimestamp(promotedAt),
    submissionConsumable: true,
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, campaignReleasePromotionReceiptHash: hashRecord('CampaignReleasePromotionReceipt', payload) });
}

export function verifyCampaignReleaseAuthorityRecord(record, expected = {}, { experimentRegistryAuthorityVerifier = null } = {}) {
  const blockers = [];
  if (record?.version !== 1 || record?.kind !== 'CurrentCampaignReleaseAuthority' || record?.status !== 'current_completed_release') {
    blockers.push('campaign_release_authority_shape_invalid');
  }
  const promotion = record?.promotionReceipt;
  if (!matchesRecordHash(promotion, 'CampaignReleasePromotionReceipt', 'campaignReleasePromotionReceiptHash')) {
    blockers.push('campaign_release_promotion_receipt_hash_invalid');
  }
  if (promotion?.status !== 'campaign_release_current_completed'
    || promotion?.packageNodeStatus !== 'completed'
    || promotion?.campaignStatus !== 'completed'
    || promotion?.submissionConsumable !== true) blockers.push('campaign_release_promotion_not_current_completed');
  const materialization = record?.materializationReceipt;
  if (!matchesRecordHash(materialization, 'CampaignReleaseBundleMaterializationReceipt', 'campaignReleaseBundleMaterializationReceiptHash')
    || materialization?.status !== 'campaign_release_bundle_materialized'
    || materialization?.campaignReleaseBundleHash !== record?.campaignReleaseBundleHash
    || materialization?.campaignReleaseBundleMaterializationReceiptHash !== promotion?.materializationReceiptHash) {
    blockers.push('campaign_release_authority_materialization_binding_invalid');
  }
  const releaseBundle = record?.releaseBundle;
  const bundleVerification = verifyCampaignReleaseBundle(releaseBundle, {
    campaignId: record?.campaignId,
    campaignPlanHash: record?.campaignPlanHash,
    paperId: record?.paperId,
    venueTarget: record?.venueTarget || null,
    packageNodeId: record?.packageNodeId,
    packageAttemptId: record?.packageAttemptId,
  }, { experimentRegistryAuthorityVerifier });
  blockers.push(...bundleVerification.blockers);
  for (const field of [
    'campaignId', 'paperId', 'venueTarget', 'campaignPlanHash', 'packageNodeId', 'packageAttemptId', 'leaseGeneration',
    'packageResultHash', 'integrationDescriptorHash', 'integrationReceiptHash', 'campaignReleaseBundleHash',
    'verifiedSourceMerkleHash', 'verifiedSourceWorkspaceManifestHash', 'campaignResearchSourceSnapshotHash',
    'experimentRegistryHash',
    ...EMPIRICAL_ASSERTION_RELEASE_HASH_FIELDS,
    'researchVerifyNodeId', 'researchVerifyAttemptId', 'researchVerifyLeaseGeneration',
    'materializationReceiptHash', 'packageNodeStatus', 'campaignStatus', 'packageCompletedAt',
  ]) if (record?.[field] !== promotion?.[field]) blockers.push(`campaign_release_authority_${field}_binding_mismatch`);
  if (record?.campaignReleaseBundleHash !== releaseBundle?.campaignReleaseBundleHash) blockers.push('campaign_release_authority_bundle_binding_mismatch');
  if (record?.experimentRegistryHash !== releaseBundle?.experimentRegistryHash) {
    blockers.push('campaign_release_authority_experiment_registry_binding_mismatch');
  }
  if (!empiricalAssertionReleaseHashesMatch(record, releaseBundle)) blockers.push('campaign_release_authority_empirical_assertion_binding_mismatch');
  for (const [field, blocker] of [
    ['campaignId', 'campaign_release_campaign_id_mismatch'],
    ['paperId', 'campaign_release_paper_id_mismatch'],
    ['venueTarget', 'campaign_release_venue_target_mismatch'],
    ['campaignPlanHash', 'campaign_release_campaign_plan_hash_mismatch'],
    ['packageNodeId', 'campaign_release_package_node_id_mismatch'],
    ['packageAttemptId', 'campaign_release_package_attempt_id_mismatch'],
    ['leaseGeneration', 'campaign_release_lease_generation_mismatch'],
    ['packageResultHash', 'campaign_release_result_hash_mismatch'],
    ['integrationDescriptorHash', 'campaign_release_integration_descriptor_hash_mismatch'],
    ['integrationReceiptHash', 'campaign_release_integration_receipt_hash_mismatch'],
  ]) if (expected[field] !== undefined && expected[field] !== null && record?.[field] !== expected[field]) blockers.push(blocker);
  return Object.freeze({ valid: blockers.length === 0, blockers: [...new Set(blockers)] });
}
