import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyAutonomousResearchReleaseBinding } from './autonomous-research-release-binding-contract.mjs';
import { verifyCampaignReleaseEvidenceCapsuleManifest } from './campaign-release-evidence-capsule-contract.mjs';
import { verifyCampaignReleaseExecutionAttestationManifestBinding } from './campaign-release-execution-attestation-contract.mjs';
import {
  verifyGpuScientificReleaseAuthorityFreshnessReceipt,
} from './gpu-scientific-release-authority-freshness-receipt-contract.mjs';
import {
  advancedNumericalReleaseEvidenceValid,
  autonomousManuscriptSourceRowsMatch,
  empiricalAssertionReleaseHashes,
  explicitTimestamp,
  gpuScientificPromotionCandidateEvidenceValid,
  gpuScientificReleaseFields,
  matchesRecordHash,
  required,
  researchReportValid,
  researchSourceLineageValid,
  sourceRowsMerkleHash,
} from './campaign-release-contract-helpers.mjs';

function authoritativeGpuScientificResearchEvidence({
  plan,
  researchVerifyNode,
  suppliedEvidence,
} = {}) {
  const authoritativeEvidence =
    researchVerifyNode?.result?.gpuScientificQualificationEvidence || null;
  if (!plan) {
    if (suppliedEvidence || authoritativeEvidence) {
      throw new Error(
        'automation_promotion_gpu_scientific_research_evidence_binding_invalid',
      );
    }
    return null;
  }
  const authoritativeHash =
    authoritativeEvidence?.campaignResearchGpuScientificEvidenceHash || null;
  const suppliedHash =
    suppliedEvidence?.campaignResearchGpuScientificEvidenceHash || null;
  const authorityInspectionHash = authoritativeEvidence?.authorityInspection
    ?.gpuScientificCampaignQualificationAuthorityInspectionHash || null;
  if (!authoritativeEvidence || !suppliedEvidence || !authoritativeHash
    || suppliedHash !== authoritativeHash || !authorityInspectionHash
    || JSON.stringify(suppliedEvidence) !== JSON.stringify(authoritativeEvidence)
    || researchVerifyNode?.result?.gpuScientificCampaignExecutionResultHash
      !== authoritativeEvidence.executionResultHash
    || researchVerifyNode?.result?.gpuScientificArtifactBodyArchiveManifestHash
      !== authoritativeEvidence.artifactArchiveManifestHash
    || researchVerifyNode?.result
      ?.gpuScientificCampaignQualificationEvidenceHash
      !== authoritativeEvidence.qualificationEvidenceHash) {
    throw new Error(
      'automation_promotion_gpu_scientific_research_evidence_binding_invalid',
    );
  }
  return authoritativeEvidence;
}

function releaseAuthorityInspectionVerifier(verifier) {
  if (typeof verifier?.verifyReleaseSnapshot === 'function') {
    return (input) => verifier.verifyReleaseSnapshot(input);
  }
  return null;
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
  researchEvidenceCapsuleManifestFileHash = null,
  researchExecutionReleaseAttestation = null,
  autonomousResearchReleaseBinding = null,
  createdAt,
  experimentRegistryAuthorityVerifier = null,
  gpuScientificPromotionAuthorityVerifier = null,
  gpuScientificAuthorityVerificationTime = null,
  advancedNumericalExecutionPlan = null,
  advancedNumericalExecutionEvidence = null,
  gpuScientificExecutionPlan = null,
  gpuScientificExecutionEvidence = null,
  gpuScientificResearchEvidence = null,
  gpuScientificPromotionEvidence = null,
  gpuScientificReleaseAuthorityFreshnessReceipt = null,
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
  const boundGpuScientificResearchEvidence =
    authoritativeGpuScientificResearchEvidence({
      plan: gpuScientificExecutionPlan,
      researchVerifyNode,
      suppliedEvidence: gpuScientificResearchEvidence,
    });
  if (!advancedNumericalReleaseEvidenceValid({
    campaignPlanHash,
    campaignId,
    paperId,
    plan: advancedNumericalExecutionPlan,
    evidence: advancedNumericalExecutionEvidence,
  })) {
    throw new Error('automation_promotion_advanced_numerical_evidence_invalid');
  }
  if (!gpuScientificPromotionCandidateEvidenceValid({
    campaignPlanHash,
    campaignId,
    paperId,
    plan: gpuScientificExecutionPlan,
    evidence: gpuScientificExecutionEvidence,
    researchEvidence: boundGpuScientificResearchEvidence,
    promotionEvidence: gpuScientificPromotionEvidence,
    researchEvidenceCapsuleManifest,
    researchEvidenceCapsuleManifestHash:
      researchEvidenceCapsuleManifest?.researchEvidenceCapsuleManifestHash,
    researchEvidenceCapsuleManifestFileHash,
    researchExecutionReleaseAttestationHash:
      researchExecutionReleaseAttestation
        ?.campaignReleaseExecutionAttestationHash || null,
  })) {
    throw new Error('automation_promotion_gpu_scientific_authority_invalid');
  }
  const gpuScientificFreshnessVerification =
    verifyGpuScientificReleaseAuthorityFreshnessReceipt(
      gpuScientificReleaseAuthorityFreshnessReceipt,
      {
        qualificationEvidence:
          boundGpuScientificResearchEvidence?.qualificationEvidence || null,
        researchEvidenceCapsuleManifest,
        researchEvidenceCapsuleManifestFileHash,
        researchExecutionReleaseAttestationHash:
          researchExecutionReleaseAttestation
            ?.campaignReleaseExecutionAttestationHash || null,
        authorityInspectionVerifier: releaseAuthorityInspectionVerifier(
          gpuScientificPromotionAuthorityVerifier,
        ),
        verificationTime: gpuScientificAuthorityVerificationTime,
      },
    );
  if ((gpuScientificExecutionPlan
      && !gpuScientificFreshnessVerification.valid)
    || (!gpuScientificExecutionPlan
      && gpuScientificReleaseAuthorityFreshnessReceipt)) {
    throw new Error(
      `automation_promotion_gpu_scientific_authority_freshness_invalid:${gpuScientificFreshnessVerification.blockers.join(',')}`,
    );
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
    ...gpuScientificReleaseFields(
      gpuScientificExecutionPlan,
      gpuScientificExecutionEvidence,
      gpuScientificPromotionEvidence,
    ),
    ...(gpuScientificExecutionPlan ? {
      campaignResearchGpuScientificEvidenceHash:
        boundGpuScientificResearchEvidence
          .campaignResearchGpuScientificEvidenceHash,
      gpuScientificCampaignQualificationAuthorityInspectionHash:
        boundGpuScientificResearchEvidence.authorityInspection
          .gpuScientificCampaignQualificationAuthorityInspectionHash,
      gpuScientificReleaseAuthorityFreshnessReceiptHash:
        gpuScientificReleaseAuthorityFreshnessReceipt
          .gpuScientificReleaseAuthorityFreshnessReceiptHash,
      gpuScientificReleaseAuthorityFreshnessReceipt:
        gpuScientificReleaseAuthorityFreshnessReceipt,
    } : {}),
    createdAt: explicitTimestamp(createdAt),
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, automationPromotionCandidateHash: hashRecord('AutomationPromotionCandidate', payload) });
}
