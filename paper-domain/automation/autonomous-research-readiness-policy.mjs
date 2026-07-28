import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyAutonomousResearchPolicyAuthorization } from './autonomous-research-policy-contract.mjs';
import { buildCampaignBenchmarkSelector } from './campaign-benchmark-selector.mjs';
import {
  verifyAutonomousEmpiricalExecutionProfileSelection,
} from './autonomous-empirical-execution-profile-policy.mjs';
import {
  BOUNDED_CAPABILITY_QUALIFICATION_SCOPE,
  PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE,
  verifyAutonomousResearchGlobalGoldenQualificationAuthority,
  verifyAutonomousResearchReleaseBinding,
} from './autonomous-research-release-binding-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

function recordHashValid(record, kind, hashField) {
  if (!record || typeof record !== 'object' || !record[hashField]) return false;
  const { [hashField]: claimedHash, ...payload } = record;
  return hashRecord(kind, payload) === claimedHash;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function reachable(byId, fromId, targetId, visited = new Set()) {
  if (fromId === targetId) return true;
  if (visited.has(fromId)) return false;
  visited.add(fromId);
  const node = byId.get(fromId);
  return (node?.dependencies || []).some((dependency) => reachable(byId, String(dependency), targetId, visited));
}

function nodeKinds(nodes, roundIndex, pattern) {
  return nodes.filter((node) => Number(node?.roundIndex || 0) === roundIndex
    && pattern.test(String(node?.kind || '')));
}

export function evaluateAutonomousResearchPrincipalSeparation({
  authorPrincipal = null,
  formalReviewerPrincipal = null,
} = {}) {
  const blockers = [];
  const authorCapability = authorPrincipal?.capabilityReceipt;
  const reviewerCapability = formalReviewerPrincipal?.capabilityReceipt;
  if (!authorPrincipal?.principalId
    || authorCapability?.kind !== 'CodexResearchAuthorCapabilityReceipt'
    || authorCapability?.status !== 'codex_research_author_capability_ready'
    || !recordHashValid(
      authorCapability,
      'CodexResearchAuthorCapabilityReceipt',
      'codexResearchAuthorCapabilityReceiptHash',
    )) blockers.push('autonomous_research_author_principal_invalid');
  if (!formalReviewerPrincipal?.principalId
    || reviewerCapability?.kind !== 'CodexFormalReviewerCapabilityReceipt'
    || reviewerCapability?.status !== 'codex_formal_reviewer_capability_ready'
    || !recordHashValid(
      reviewerCapability,
      'CodexFormalReviewerCapabilityReceipt',
      'codexFormalReviewerCapabilityReceiptHash',
    )) blockers.push('autonomous_research_formal_reviewer_principal_invalid');
  if (authorPrincipal?.principalId === formalReviewerPrincipal?.principalId) {
    blockers.push('autonomous_research_author_reviewer_principal_not_distinct');
  }
  if (!SHA256.test(String(authorCapability?.credentialRootIdentityHash || ''))
    || !SHA256.test(String(reviewerCapability?.credentialRootIdentityHash || ''))
    || reviewerCapability?.authorCredentialRootIdentityHash
      !== authorCapability?.credentialRootIdentityHash
    || authorCapability?.freshEphemeralSessionRequired !== true
    || authorCapability?.priorAgentContextInheritanceForbidden !== true
    || reviewerCapability?.providerCredentialSharingPermitted !== true
    || reviewerCapability?.freshEphemeralSessionRequired !== true
    || reviewerCapability?.authorContextInheritanceForbidden !== true
    || reviewerCapability?.frozenArtifactReviewRequired !== true
    || reviewerCapability?.reviewerMustDifferFromAuthorPrincipal !== true
    || reviewerCapability?.assuranceScope
      !== 'ephemeral_session_frozen_artifact_and_role_separation') {
    blockers.push('autonomous_research_author_reviewer_session_separation_invalid');
  }
  const payload = {
    version: 1,
    kind: 'AutonomousResearchPrincipalSeparation',
    status: blockers.length
      ? 'autonomous_research_principal_separation_blocked'
      : 'autonomous_research_principal_separation_ready',
    authorPrincipalId: authorPrincipal?.principalId || null,
    formalReviewerPrincipalId: formalReviewerPrincipal?.principalId || null,
    authorCapabilityReceiptHash: authorCapability?.codexResearchAuthorCapabilityReceiptHash || null,
    formalReviewerCapabilityReceiptHash:
      reviewerCapability?.codexFormalReviewerCapabilityReceiptHash || null,
    authorCredentialRootIdentityHash: authorCapability?.credentialRootIdentityHash || null,
    formalReviewerCredentialRootIdentityHash: reviewerCapability?.credentialRootIdentityHash || null,
    providerCredentialSharingPermitted:
      reviewerCapability?.providerCredentialSharingPermitted === true,
    providerCredentialRootShared:
      authorCapability?.credentialRootIdentityHash
        === reviewerCapability?.credentialRootIdentityHash,
    freshSessionSeparationVerified: blockers.length === 0,
    providerAccountIndependenceVerified: false,
    externalProviderAccountIndependenceAttestationRequired: true,
    blockers: Object.freeze([...new Set(blockers)]),
  };
  return Object.freeze({
    ...payload,
    autonomousResearchPrincipalSeparationHash:
      hashRecord('AutonomousResearchPrincipalSeparation', payload),
  });
}

export function evaluateAutonomousCampaignTopology({ nodes = [] } = {}) {
  const candidates = Array.isArray(nodes) ? nodes : [];
  const blockers = [];
  const byId = new Map(candidates.map((node) => [String(node?.nodeId || ''), node]));
  if (byId.size !== candidates.length || byId.has('')) {
    blockers.push('autonomous_research_campaign_node_identity_invalid');
  }
  const writer = candidates.find((node) => node?.kind === 'writer');
  const researchPlan = candidates.find((node) => node?.kind === 'research-plan');
  const initialFormal = candidates.find((node) => node?.kind === 'formal-verify'
    && Number(node?.roundIndex || 0) === 0);
  if (!researchPlan || !writer || !initialFormal) {
    blockers.push('autonomous_research_initial_research_writer_formal_chain_missing');
  } else if (!reachable(byId, String(writer.nodeId), String(researchPlan.nodeId))
    || !reachable(byId, String(initialFormal.nodeId), String(writer.nodeId))) {
    blockers.push('autonomous_research_initial_research_writer_formal_chain_invalid');
  }
  const roundIndexes = unique(candidates
    .filter((node) => node?.kind === 'convergence')
    .map((node) => Number(node.roundIndex || 0)))
    .filter((roundIndex) => roundIndex > 0)
    .sort((left, right) => left - right);
  if (!roundIndexes.length) blockers.push('autonomous_research_revision_round_missing');
  for (const roundIndex of roundIndexes) {
    const initialReferees = nodeKinds(candidates, roundIndex, /^referee-\d+$/);
    const revisionReferees = nodeKinds(candidates, roundIndex, /^revision-referee-\d+$/);
    const revises = nodeKinds(candidates, roundIndex, /^revise$/);
    const convergences = nodeKinds(candidates, roundIndex, /^convergence$/);
    const revalidations = nodeKinds(
      candidates,
      roundIndex,
      /^(?:revalidate-(?:code|empirical|empirical-reproduce)(?:-|$)|revalidate-(?:compile|citations|artifacts)$)/,
    );
    if (initialReferees.length < 2 || revisionReferees.length < 2
      || revises.length !== 1 || convergences.length !== 1 || revalidations.length < 3) {
      blockers.push(`autonomous_research_fresh_revision_topology_incomplete:${roundIndex}`);
      continue;
    }
    const revise = revises[0];
    const convergence = convergences[0];
    if (initialReferees.some((referee) => !reachable(byId, String(revise.nodeId), String(referee.nodeId)))) {
      blockers.push(`autonomous_research_revision_missing_initial_referee_dependency:${roundIndex}`);
    }
    if (revalidations.some((node) => !reachable(byId, String(node.nodeId), String(revise.nodeId)))) {
      blockers.push(`autonomous_research_post_revision_revalidation_missing:${roundIndex}`);
    }
    if (revisionReferees.some((referee) => revalidations
      .some((node) => !reachable(byId, String(referee.nodeId), String(node.nodeId))))) {
      blockers.push(`autonomous_research_fresh_referee_revalidation_dependency_missing:${roundIndex}`);
    }
    if (revisionReferees.some((referee) => (
      !reachable(byId, String(convergence.nodeId), String(referee.nodeId))
    ))) blockers.push(`autonomous_research_convergence_fresh_referee_dependency_missing:${roundIndex}`);
  }
  const finalCompile = candidates.find((node) => node?.kind === 'final-compile');
  const researchVerify = candidates.find((node) => node?.kind === 'research-verify');
  const packageNode = candidates.find((node) => node?.kind === 'package');
  const convergenceNodes = candidates.filter((node) => node?.kind === 'convergence');
  if (!finalCompile || !researchVerify || !packageNode
    || convergenceNodes.some((node) => !reachable(byId, String(finalCompile?.nodeId), String(node.nodeId)))
    || !reachable(byId, String(researchVerify?.nodeId), String(finalCompile?.nodeId))
    || !reachable(byId, String(packageNode?.nodeId), String(researchVerify?.nodeId))) {
    blockers.push('autonomous_research_release_chain_invalid');
  }
  const payload = {
    version: 1,
    kind: 'AutonomousResearchCampaignTopologyInspection',
    status: blockers.length
      ? 'autonomous_research_campaign_topology_blocked'
      : 'autonomous_research_campaign_topology_ready',
    nodeCount: candidates.length,
    revisionRounds: roundIndexes.length,
    minimumInitialRefereeCount: roundIndexes.length
      ? Math.min(...roundIndexes.map((roundIndex) => nodeKinds(candidates, roundIndex, /^referee-\d+$/).length))
      : 0,
    minimumFreshRefereeCount: roundIndexes.length
      ? Math.min(...roundIndexes.map((roundIndex) => nodeKinds(candidates, roundIndex, /^revision-referee-\d+$/).length))
      : 0,
    freshReviewOccursAfterRevisionAndRevalidation: blockers.length === 0,
    nodeTopologyHash: hashRecord('AutonomousResearchCampaignNodeTopology', candidates),
    blockers: Object.freeze([...new Set(blockers)]),
  };
  return Object.freeze({
    ...payload,
    autonomousResearchCampaignTopologyInspectionHash:
      hashRecord('AutonomousResearchCampaignTopologyInspection', payload),
  });
}

export function evaluateAutonomousDatasetLaunchReadiness({
  protocolFamily = null,
  datasetMounts = [],
  datasetAuthorityReceipt = null,
} = {}) {
  const blockers = [];
  let selector = null;
  const mounts = Array.isArray(datasetMounts) ? datasetMounts : [];
  const mount = mounts[0] || null;
  if (datasetAuthorityReceipt?.status !== 'operator_dataset_harness_authority_verified'
    || !recordHashValid(
      datasetAuthorityReceipt,
      'OperatorDatasetHarnessAuthorityReceipt',
      'operatorDatasetHarnessAuthorityReceiptHash',
    )
    || datasetAuthorityReceipt?.authorityVerification?.status
      !== 'operator_dataset_authority_verified'
    || datasetAuthorityReceipt?.authorityVerification?.cryptographicSignaturesVerified !== true
    || datasetAuthorityReceipt?.authorityVerification?.timeWindowValid !== true
    || !Array.isArray(datasetAuthorityReceipt?.blockers)
    || datasetAuthorityReceipt.blockers.length !== 0
    || datasetAuthorityReceipt?.datasetName !== mount?.name
    || datasetAuthorityReceipt?.datasetManifestHash !== mount?.manifestHash
    || datasetAuthorityReceipt?.operatorDatasetAuthorityDocumentHash
      !== mount?.operatorDatasetAuthorityDocumentHash
    || datasetAuthorityReceipt?.analysisProtocolHash !== mount?.analysisProtocolHash
    || datasetAuthorityReceipt?.benchmarkFamily !== mount?.benchmarkFamily) {
    blockers.push('autonomous_research_dataset_runtime_authority_preflight_required');
  }
  if (mounts.length !== 1 || mounts[0]?.benchmarkFamily !== protocolFamily) {
    blockers.push('autonomous_research_unique_matching_dataset_mount_required');
  } else {
    try {
      selector = buildCampaignBenchmarkSelector({
        benchmarkId: mounts[0].name,
        datasetMounts: mounts,
      });
    } catch (error) {
      blockers.push(String(error?.message || 'autonomous_research_dataset_authority_invalid'));
    }
  }
  if (!selector || selector.selectorType !== 'authorized_dataset_mount'
    || selector.assuranceScope !== 'operator-authorized-hidden-evaluation-v1'
    || selector.benchmarkFamily !== protocolFamily
    || !recordHashValid(
      selector,
      'CampaignBenchmarkSelector',
      'campaignBenchmarkSelectorHash',
    )) {
    blockers.push('autonomous_research_dataset_selector_authority_binding_invalid');
  }
  const payload = {
    version: 1,
    kind: 'AutonomousResearchDatasetLaunchInspection',
    status: blockers.length
      ? 'autonomous_research_dataset_launch_blocked'
      : 'autonomous_research_dataset_launch_ready',
    protocolFamily,
    datasetMountCount: mounts.length,
    datasetMountName: mounts[0]?.name || null,
    datasetManifestHash: mounts[0]?.manifestHash || null,
    operatorDatasetAuthorityDocumentHash:
      mounts[0]?.operatorDatasetAuthorityDocumentHash || null,
    operatorDatasetHarnessAuthorityReceiptHash:
      datasetAuthorityReceipt?.operatorDatasetHarnessAuthorityReceiptHash || null,
    operatorDatasetAuthorityVerificationHash:
      datasetAuthorityReceipt?.operatorDatasetAuthorityVerificationHash || null,
    campaignBenchmarkSelectorHash: selector?.campaignBenchmarkSelectorHash || null,
    blockers: Object.freeze([...new Set(blockers)]),
  };
  return Object.freeze({
    ...payload,
    autonomousResearchDatasetLaunchInspectionHash:
      hashRecord('AutonomousResearchDatasetLaunchInspection', payload),
  });
}

export function evaluateAutonomousResearchQualificationEligibility({
  proposal = null,
  policyAuthorization = null,
  seedBundle = null,
  seedBinding = null,
  principalSeparation = null,
  topologyInspection = null,
  datasetLaunchInspection = null,
  empiricalRuntimeCapabilityInspection = null,
  empiricalExecutionProfileSelection = null,
  runtimeImageReproducibilityInspection = null,
  capabilityScopeManifest = null,
  externalCapabilityTrustInspection = null,
  researchAgendaProducerReceipt = null,
  autonomousResearchProviderConfigurationHash = null,
  autonomousResearchLoopPreparationReportHash = null,
  autonomousResearchMachineIntakeAdmissionHash = null,
  launchMode = null,
  observedAt = null,
  campaignReleaseAuthority = null,
  fullResearchQualificationInspection = null,
} = {}) {
  const launchBlockers = [];
  const policyVerification = verifyAutonomousResearchPolicyAuthorization(policyAuthorization, { proposal });
  launchBlockers.push(...policyVerification.blockers);
  if (!recordHashValid(
    seedBundle,
    'AutonomousResearchSeedContractBundle',
    'autonomousResearchSeedContractBundleHash',
  ) || seedBundle?.status !== 'autonomous_research_seed_contracts_ready'
    || seedBundle?.policyAuthorizationHash
      !== policyAuthorization?.autonomousResearchPolicyAuthorizationHash) {
    launchBlockers.push('autonomous_research_qualification_seed_bundle_invalid');
  }
  if (!recordHashValid(
    seedBinding,
    'AutonomousResearchSeedBinding',
    'autonomousResearchSeedBindingHash',
  ) || seedBinding?.status !== 'autonomous_research_seed_bound'
    || seedBinding?.seedBundleHash !== seedBundle?.autonomousResearchSeedContractBundleHash) {
    launchBlockers.push('autonomous_research_qualification_seed_binding_invalid');
  }
  if (!recordHashValid(
    principalSeparation,
    'AutonomousResearchPrincipalSeparation',
    'autonomousResearchPrincipalSeparationHash',
  ) || principalSeparation?.status !== 'autonomous_research_principal_separation_ready') {
    launchBlockers.push('autonomous_research_qualification_principal_separation_invalid');
  }
  if (!recordHashValid(
    topologyInspection,
    'AutonomousResearchCampaignTopologyInspection',
    'autonomousResearchCampaignTopologyInspectionHash',
  ) || topologyInspection?.status !== 'autonomous_research_campaign_topology_ready') {
    launchBlockers.push('autonomous_research_qualification_campaign_topology_invalid');
  }
  if (!recordHashValid(
    datasetLaunchInspection,
    'AutonomousResearchDatasetLaunchInspection',
    'autonomousResearchDatasetLaunchInspectionHash',
  ) || datasetLaunchInspection?.status !== 'autonomous_research_dataset_launch_ready') {
    launchBlockers.push('autonomous_research_qualification_dataset_launch_not_ready');
  }
  if (!verifyAutonomousEmpiricalExecutionProfileSelection(
    empiricalExecutionProfileSelection,
    {
      protocolFamily: proposal?.protocolFamily,
      requireReady: true,
      runtimeCapabilityInspection: empiricalRuntimeCapabilityInspection,
      requireRuntimeCapabilityInspection: true,
      runtimeReproducibilityInspection: runtimeImageReproducibilityInspection,
      requireRegisteredRuntime: launchMode === 'production-run',
      observedAt,
    },
  )) {
    launchBlockers.push('autonomous_research_qualification_empirical_runtime_profile_not_ready');
  }
  const uniqueLaunchBlockers = Object.freeze([...new Set(launchBlockers)]);
  const qualificationBlockers = [];
  const expectedProposalHash = proposal?.machineProposedScientificClaimSetHash || null;
  const expectedPolicyAuthorizationHash =
    policyAuthorization?.autonomousResearchPolicyAuthorizationHash || null;
  const expectedSeedBindingHash = seedBinding?.autonomousResearchSeedBindingHash || null;
  const releaseBinding = campaignReleaseAuthority?.releaseBundle
    ?.autonomousResearchReleaseBinding || null;
  const releaseBindingVerification = verifyAutonomousResearchReleaseBinding(releaseBinding);
  const expectedExternalCapabilityTrustInspection =
    externalCapabilityTrustInspection || null;
  const expectedResearchAgendaProducerReceipt =
    researchAgendaProducerReceipt || null;
  const preparationEvidenceBound = releaseBinding
    && releaseBinding.capabilityScopeManifestHash
      === capabilityScopeManifest?.autonomousResearchCapabilityScopeManifestHash
    && JSON.stringify(releaseBinding.capabilityScopeManifest)
      === JSON.stringify(capabilityScopeManifest)
    && releaseBinding.externalCapabilityTrustInspectionHash
      === (expectedExternalCapabilityTrustInspection
        ?.autonomousResearchExternalCapabilityTrustInspectionHash || null)
    && JSON.stringify(releaseBinding.externalCapabilityTrustInspection)
      === JSON.stringify(expectedExternalCapabilityTrustInspection)
    && releaseBinding.researchAgendaProductionReceiptHash
      === (expectedResearchAgendaProducerReceipt
        ?.autonomousResearchAgendaProductionReceiptHash || null)
    && JSON.stringify(releaseBinding.researchAgendaProductionReceipt)
      === JSON.stringify(expectedResearchAgendaProducerReceipt);
  const releaseBindingValid = releaseBindingVerification.valid
    && campaignReleaseAuthority?.releaseBundle?.autonomousResearchReleaseBindingHash
      === releaseBinding?.autonomousResearchReleaseBindingHash
    && releaseBinding?.campaignId === campaignReleaseAuthority?.campaignId
    && releaseBinding?.paperId === proposal?.paperId
    && releaseBinding?.campaignPlanHash === campaignReleaseAuthority?.releaseBundle?.campaignPlanHash
    && releaseBinding?.launchMode === launchMode
    && releaseBinding?.proposalHash === expectedProposalHash
    && releaseBinding?.policyAuthorizationHash === expectedPolicyAuthorizationHash
    && releaseBinding?.seedBindingHash === expectedSeedBindingHash
    && preparationEvidenceBound;
  const globalGoldenPreparationAuthorityVerification =
    verifyAutonomousResearchGlobalGoldenQualificationAuthority(
      releaseBinding?.globalGoldenQualificationAuthority,
      {
        campaignId: campaignReleaseAuthority?.campaignId,
        paperId: proposal?.paperId,
        campaignPlanHash: campaignReleaseAuthority?.releaseBundle?.campaignPlanHash,
        launchMode,
        providerConfigurationHash:
          autonomousResearchProviderConfigurationHash,
        autonomousResearchLoopPreparationReportHash,
        capabilityScopeManifestHash:
          capabilityScopeManifest?.autonomousResearchCapabilityScopeManifestHash,
        autonomousResearchMachineIntakeAdmissionHash,
      },
    );
  const productionQualificationRelease = releaseBindingValid
    && releaseBinding.qualificationScope === PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE
    && releaseBinding.fullResearchQualificationEligible === true;
  const boundedGoldenQualificationRelease = releaseBindingValid
    && releaseBinding.qualificationScope === BOUNDED_CAPABILITY_QUALIFICATION_SCOPE
    && releaseBinding.launchMode === 'golden-bootstrap'
    && releaseBinding.fullResearchQualificationEligible === false
    && releaseBinding.genericContentCanaryVerified === true
    && Boolean(releaseBinding.globalGoldenQualificationAuthorityHash)
    && globalGoldenPreparationAuthorityVerification.valid === true;
  if (releaseBindingValid
    && !productionQualificationRelease && !boundedGoldenQualificationRelease) {
    qualificationBlockers.push(
      'autonomous_research_release_qualification_scope_not_eligible',
    );
  }
  if (campaignReleaseAuthority?.status !== 'current_completed_release'
    || campaignReleaseAuthority?.campaignStatus !== 'completed'
    || campaignReleaseAuthority?.packageNodeStatus !== 'completed'
    || !SHA256.test(String(campaignReleaseAuthority?.campaignReleaseBundleHash || ''))
    || campaignReleaseAuthority?.releaseBundle?.researchReport?.promotionEligibility?.status
      !== 'research_promotion_ready'
    || !releaseBindingValid) {
    qualificationBlockers.push('autonomous_research_current_promotable_release_required');
  }
  const qualificationReady = fullResearchQualificationInspection?.kind === 'FullResearchQualificationInspection'
    && fullResearchQualificationInspection?.status === 'full_research_qualification_verified'
    && fullResearchQualificationInspection?.ready === true
    && fullResearchQualificationInspection?.receiptAccepted === true
    && fullResearchQualificationInspection?.qualificationSignatureVerified === true
    && fullResearchQualificationInspection?.qualificationTimeWindowVerified === true
    && fullResearchQualificationInspection?.releasePointerVerified === true
    && fullResearchQualificationInspection?.independentVerifierVerified === true
    && SHA256.test(String(
      fullResearchQualificationInspection?.externalVerificationRequestHash || '',
    ))
    && SHA256.test(String(fullResearchQualificationInspection?.qualificationReceiptHash || ''))
    && fullResearchQualificationInspection?.campaignId === campaignReleaseAuthority?.campaignId
    && fullResearchQualificationInspection?.paperId === proposal?.paperId
    && fullResearchQualificationInspection?.campaignReleaseBundleHash
      === campaignReleaseAuthority?.campaignReleaseBundleHash
    && fullResearchQualificationInspection?.proposalHash === expectedProposalHash
    && fullResearchQualificationInspection?.policyAuthorizationHash
      === expectedPolicyAuthorizationHash
    && fullResearchQualificationInspection?.seedBindingHash === expectedSeedBindingHash
    && fullResearchQualificationInspection?.qualificationScope
      === releaseBinding?.qualificationScope
    && fullResearchQualificationInspection?.fullDomainVerificationReady === true;
  if (!qualificationReady) {
    qualificationBlockers.push('autonomous_research_external_full_research_qualification_required');
  }
  const independentHypothesisPriorArtReady =
    fullResearchQualificationInspection?.independentHypothesisPriorArtReviewVerified === true
    && SHA256.test(String(
      fullResearchQualificationInspection?.independentHypothesisPriorArtReceiptHash || '',
    ));
  if (!independentHypothesisPriorArtReady) {
    qualificationBlockers.push(
      'autonomous_research_independent_hypothesis_prior_art_qualification_required',
    );
  }
  const uniqueQualificationBlockers = Object.freeze([...new Set(qualificationBlockers)]);
  const launchReady = uniqueLaunchBlockers.length === 0;
  const qualificationRequestEligible = launchReady
    && !uniqueQualificationBlockers.includes('autonomous_research_current_promotable_release_required')
    && (productionQualificationRelease || boundedGoldenQualificationRelease);
  const campaignFullyQualified = qualificationRequestEligible
    && productionQualificationRelease
    && qualificationReady && uniqueQualificationBlockers.length === 0;
  const boundedGoldenCapabilityQualificationVerified = qualificationRequestEligible
    && boundedGoldenQualificationRelease
    && qualificationReady && uniqueQualificationBlockers.length === 0;
  const fullAutomaticResearchWritingReady = campaignFullyQualified;
  const payload = {
    version: 1,
    kind: 'AutonomousResearchQualificationEligibility',
    status: fullAutomaticResearchWritingReady
      ? 'autonomous_research_full_qualification_verified'
      : qualificationRequestEligible
        ? 'autonomous_research_eligible_for_external_qualification'
        : launchReady
          ? 'autonomous_research_launch_ready_qualification_pending'
          : 'autonomous_research_launch_blocked',
    autonomousExecutionLaunchReady: launchReady,
    qualificationRequestEligible,
    campaignFullyQualified,
    boundedGoldenCapabilityQualificationVerified,
    fullAutomaticResearchWritingReady,
    launchBlockers: uniqueLaunchBlockers,
    qualificationBlockers: uniqueQualificationBlockers,
    externalTrust: Object.freeze({
      selfSignedQualificationAccepted: false,
      externalReleaseAttestorRequired: true,
      providerPrincipalIndependenceAttestationRequired: false,
      freshEphemeralAuthorReviewerSessionsRequired: true,
      authorContextInheritanceForbidden: true,
      frozenArtifactReviewRequired: true,
    }),
    claims: Object.freeze({
      universalResearchValidityClaimed: false,
      scientificNoveltyClaimed: false,
      independentHypothesisPriorArtQualificationRequired: true,
      naturalLanguageToLeanEquivalenceMachineProven: false,
      operatorApprovalClaimed: false,
    }),
  };
  return Object.freeze({
    ...payload,
    autonomousResearchQualificationEligibilityHash:
      hashRecord('AutonomousResearchQualificationEligibility', payload),
  });
}
