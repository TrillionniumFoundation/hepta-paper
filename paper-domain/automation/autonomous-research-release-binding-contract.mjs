import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  deepFreezeJsonValue,
  isDeeplyFrozenJsonValue,
} from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { verifyAutonomousResearchAgendaProductionReceipt } from './autonomous-research-agenda-production-contract.mjs';
import { verifyAutonomousResearchCapabilityScopeManifest } from './autonomous-research-capability-scope-manifest.mjs';
import {
  AGENT_AUTHORED_MANUSCRIPT_MODE,
  verifyTrustedAutonomousManuscriptRenderReceipt,
} from './trusted-autonomous-manuscript-render-contract.mjs';
import { verifyAutonomousVenueProfileSelection } from './autonomous-venue-profile-contract.mjs';
import { verifyAutonomousSubmissionMetadataReceipt } from './autonomous-submission-metadata-contract.mjs';
import {
  autonomousVenueReleaseBindingFields,
  verifyAutonomousVenueReleaseBinding,
} from './autonomous-venue-release-binding.mjs';
import {
  campaignTrustedAutonomousManuscriptAuthorshipReceipt,
  inspectAutonomousManuscriptReleaseProof,
} from './autonomous-manuscript-release-proof-contract.mjs';
import {
  assertAutonomousResearchProductionProfilePreparation,
  verifyAutonomousResearchProductionPriorArtAuthority,
} from './autonomous-research-production-profile-contract.mjs';
import { verifyAutonomousResearchExternalCapabilityTrustInspection } from './autonomous-research-external-capability-trust-contract.mjs';
import {
  buildAutonomousResearchReleaseReviewerEvidence,
  verifyAutonomousResearchReleaseReviewerBindingFields,
} from './autonomous-research-release-reviewer-evidence-contract.mjs';
import {
  createAutonomousResearchGlobalGoldenQualificationAuthority,
  verifyAutonomousResearchGlobalGoldenQualificationAuthority,
} from './autonomous-research-global-golden-qualification-authority-contract.mjs';
import {
  autonomousResearchRecursiveReleaseBindingFields,
  inspectAutonomousResearchRecursiveReleaseSource,
  verifyAutonomousResearchRecursiveReleaseBinding,
} from './autonomous-research-recursive-release-closure.mjs';
export {
  createAutonomousResearchGlobalGoldenQualificationAuthority,
  verifyAutonomousResearchGlobalGoldenQualificationAuthority,
};
const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const verifiedImmutableReleaseBindings = new WeakMap();
export const PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE =
  'production-agent-authored-manuscript-v1';
export const BOUNDED_CAPABILITY_QUALIFICATION_SCOPE =
  'bounded-capability-only-v1';
function validHash(value) {
  return SHA256.test(String(value || ''));
}
function validPreparationRecord(preparation) {
  const {
    autonomousResearchLoopPreparationReportHash: claimedHash,
    ...payload
  } = preparation || {};
  return preparation?.version === 1
    && preparation?.kind === 'AutonomousResearchLoopPreparationReport'
    && validHash(claimedHash)
    && hashRecord('AutonomousResearchLoopPreparationReport', payload) === claimedHash;
}
export function inspectAutonomousResearchGlobalGoldenQualificationAuthority({
  campaign,
  campaignReleaseAuthority,
  preparation = null,
} = {}) {
  const blockers = [];
  const plan = campaign?.spec || null;
  const persistedPreparation = plan?.autonomousResearchPreparation || null;
  const effectivePreparation = preparation || persistedPreparation;
  const { campaignPlanHash: claimedPlanHash, ...planPayload } = plan || {};
  if (!plan || !SHA256.test(String(claimedPlanHash || ''))
    || hashRecord('PaperCampaignPlan', planPayload) !== claimedPlanHash
    || !validPreparationRecord(persistedPreparation)
    || !validPreparationRecord(effectivePreparation)
    || effectivePreparation?.autonomousResearchLoopPreparationReportHash
      !== persistedPreparation?.autonomousResearchLoopPreparationReportHash) {
    blockers.push('autonomous_research_global_golden_campaign_plan_invalid');
  }
  let expectedAuthority = null;
  try {
    expectedAuthority = createAutonomousResearchGlobalGoldenQualificationAuthority({
      campaignId: campaign?.campaignId,
      paperId: campaign?.paperId,
      campaignPlanHash: claimedPlanHash,
      preparation: effectivePreparation,
      machineIntake: plan?.autonomousResearchMachineIntake || null,
      machineIntakeAdmission: plan?.autonomousResearchMachineIntakeAdmission || null,
    });
  } catch {
    blockers.push('autonomous_research_global_golden_machine_intake_authority_invalid');
  }
  if (!expectedAuthority) {
    blockers.push('autonomous_research_global_golden_recurring_machine_intake_required');
  }
  const releaseBundle = campaignReleaseAuthority?.releaseBundle || null;
  const releaseBinding = releaseBundle?.autonomousResearchReleaseBinding || null;
  const releaseBindingInspection = verifyAutonomousResearchReleaseBinding(
    releaseBinding,
    {
      campaignId: campaign?.campaignId,
      paperId: campaign?.paperId,
      campaignPlanHash: claimedPlanHash,
      launchMode: 'golden-bootstrap',
      globalGoldenQualificationAuthorityHash:
        expectedAuthority?.autonomousResearchGlobalGoldenQualificationAuthorityHash,
    },
  );
  if (campaign?.status !== 'completed'
    || campaignReleaseAuthority?.status !== 'current_completed_release'
    || campaignReleaseAuthority?.campaignStatus !== 'completed'
    || campaignReleaseAuthority?.packageNodeStatus !== 'completed'
    || campaignReleaseAuthority?.campaignId !== campaign?.campaignId
    || campaignReleaseAuthority?.paperId !== campaign?.paperId
    || !SHA256.test(String(campaignReleaseAuthority?.campaignReleaseBundleHash || ''))
    || releaseBundle?.campaignReleaseBundleHash
      !== campaignReleaseAuthority?.campaignReleaseBundleHash
    || releaseBundle?.campaignPlanHash !== claimedPlanHash
    || releaseBundle?.autonomousResearchReleaseBindingHash
      !== releaseBinding?.autonomousResearchReleaseBindingHash
    || releaseBindingInspection.valid !== true
    || releaseBinding?.genericContentCanaryVerified !== true
    || releaseBinding?.globalGoldenQualificationAuthorityHash
      !== expectedAuthority?.autonomousResearchGlobalGoldenQualificationAuthorityHash) {
    blockers.push('autonomous_research_global_golden_current_release_authority_mismatch');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchGlobalGoldenQualificationAuthorityInspection',
    status: blockers.length
      ? 'autonomous_research_global_golden_qualification_authority_blocked'
      : 'autonomous_research_global_golden_qualification_authority_verified',
    ready: blockers.length === 0,
    campaignId: campaign?.campaignId || null,
    paperId: campaign?.paperId || null,
    campaignPlanHash: claimedPlanHash || null,
    campaignReleaseBundleHash:
      campaignReleaseAuthority?.campaignReleaseBundleHash || null,
    globalGoldenQualificationAuthorityHash:
      expectedAuthority?.autonomousResearchGlobalGoldenQualificationAuthorityHash || null,
    authority: blockers.length ? null : expectedAuthority,
    blockers: Object.freeze([...new Set([
      ...blockers,
      ...releaseBindingInspection.blockers,
    ])]),
  });
  return Object.freeze({
    ...payload,
    autonomousResearchGlobalGoldenQualificationAuthorityInspectionHash: hashRecord(
      'AutonomousResearchGlobalGoldenQualificationAuthorityInspection',
      payload,
    ),
  });
}
export function createAutonomousResearchReleaseBinding({
  campaignId,
  paperId,
  campaignPlanHash,
  preparation,
  machineIntake = null,
  machineIntakeAdmission = null,
  manuscriptPath = null,
  renderedManuscriptHash = null,
  evidenceBoundManuscriptIrHash = null,
  manuscriptIrFileHash = null,
  agentAuthoredSourceDraft = null,
  agentAuthoredSourceDraftFileHash = null,
  trustedAutonomousManuscriptResult = null,
  refereeConvergenceDecision = null,
  reviewerEvidenceAuthority = null,
  researchReport = null,
  experimentIrExecutionAuthorityReceipt = null,
  experimentReplayReceipt = null,
} = {}) {
  if (!preparation) return null;
  assertAutonomousResearchProductionProfilePreparation(preparation);
  const globalGoldenQualificationAuthority =
    createAutonomousResearchGlobalGoldenQualificationAuthority({
      campaignId,
      paperId,
      campaignPlanHash,
      preparation,
      machineIntake,
      machineIntakeAdmission,
    });
  const capabilityScopeManifest = preparation?.capabilityScopeManifest || null;
  const agendaReceipt = preparation?.researchAgendaProducerReceipt || null;
  const externalCapabilityTrustInspection = preparation?.externalCapabilityTrustInspection || null;
  const externalCapabilityTrustReady =
    verifyAutonomousResearchExternalCapabilityTrustInspection(
      externalCapabilityTrustInspection,
    ) && externalCapabilityTrustInspection?.ready === true;
  const priorArtEvidenceReceipt = preparation?.priorArtReceipt || null;
  const priorArtAuthorityVerificationBundle = preparation?.priorArtAuthorityVerificationBundle;
  const priorArtAuthorityTrustConfiguration = preparation?.priorArtAuthorityTrustConfiguration;
  const priorArtAuthorityReady = verifyAutonomousResearchProductionPriorArtAuthority({
    priorArtReceipt: priorArtEvidenceReceipt,
    authorityBundle: priorArtAuthorityVerificationBundle,
    trustConfiguration: priorArtAuthorityTrustConfiguration,
    externalCapabilityTrustInspection,
    researchAgendaIr: preparation?.researchAgendaIr || null,
  });
  const capabilityScopeValid = verifyAutonomousResearchCapabilityScopeManifest(
    capabilityScopeManifest,
  );
  const agendaVerification = verifyAutonomousResearchAgendaProductionReceipt(agendaReceipt);
  const genericProductionRequested = preparation?.launchMode === 'production-run'
    && capabilityScopeValid
    && capabilityScopeManifest.genericDeclaredCapability === true;
  const genericGoldenCanaryRequested = preparation?.launchMode === 'golden-bootstrap'
    && capabilityScopeValid
    && capabilityScopeManifest.genericDeclaredCapability === true;
  const venueProfileSelection = preparation?.venueProfileSelection || null;
  const submissionMetadataReceipt = preparation?.submissionMetadataReceipt || null;
  const authorityObservedAt = preparation?.observedAt || preparation?.createdAt || null;
  const venueProfileValid = venueProfileSelection
    ? verifyAutonomousVenueProfileSelection(venueProfileSelection, {
      authorityObservedAt,
    }) : false;
  const submissionMetadataValid = submissionMetadataReceipt
    ? verifyAutonomousSubmissionMetadataReceipt(submissionMetadataReceipt, {
      paperId,
      protocolFamily: preparation?.proposal?.protocolFamily,
      authorityObservedAt,
    }) : false;
  const sourceDraftHash = agentAuthoredSourceDraft
    ? hashBytes(Buffer.from(JSON.stringify(agentAuthoredSourceDraft), 'utf8')) : null;
  const externalSubmissionRequested = genericProductionRequested
    && capabilityScopeManifest.venueMode === 'submission-enabled-v1';
  const recursiveReleaseSource = inspectAutonomousResearchRecursiveReleaseSource({
    campaignId,
    paperId,
    campaignPlanHash,
    preparation,
    agendaReceipt,
    priorArtEvidenceReceipt,
    venueProfileSelection,
    venueProfileValid,
    externalSubmissionRequested,
    researchReport,
    experimentIrExecutionAuthorityReceipt,
    experimentReplayReceipt,
  });
  const recursiveClosureSourceReady = recursiveReleaseSource.ready;
  const { venueRequirementIr } = recursiveReleaseSource;
  const manuscriptProof = inspectAutonomousManuscriptReleaseProof(
    trustedAutonomousManuscriptResult, {
    paperId,
    campaignId,
    manuscriptPath,
    renderedManuscriptHash,
    evidenceBoundManuscriptIrHash,
    manuscriptIrFileHash,
    agentAuthoredSourceDraftHash: sourceDraftHash,
    agentAuthoredSourceDraftFileHash,
    venueProfileSelectionHash:
      venueProfileSelection?.autonomousVenueProfileSelectionReceiptHash || null,
    venueRequirementIrHash: recursiveClosureSourceReady
      ? venueRequirementIr?.venueRequirementIrHash || null : null,
    venueTemplateAssetHash: recursiveClosureSourceReady
      ? venueProfileSelection?.venueTemplateAsset?.templateAssetHash || null : null,
    venueTemplateAssetPath: recursiveClosureSourceReady
      ? venueProfileSelection?.venueTemplateAsset?.relativePath || null : null,
    submissionMetadataReceiptHash:
      submissionMetadataReceipt?.autonomousSubmissionMetadataReceiptHash || null,
    requireExternalSubmission: externalSubmissionRequested,
  }, {
    requireAgentAuthored: genericProductionRequested || genericGoldenCanaryRequested,
  });
  const agendaBound = agendaVerification.valid
    && agendaReceipt.paperId === paperId
    && agendaReceipt.selectedObjective === preparation?.proposal?.objective
    && agendaReceipt.selectedProtocolFamily === preparation?.proposal?.protocolFamily;
  const productionEligible = genericProductionRequested
    && capabilityScopeManifest.agendaMode === 'machine-generated'
    && capabilityScopeManifest.manuscriptMode === AGENT_AUTHORED_MANUSCRIPT_MODE
    && agendaBound
    && priorArtAuthorityReady
    && (!externalSubmissionRequested || (venueProfileValid && submissionMetadataValid))
    && manuscriptProof.valid;
  const genericContentCanaryVerified = capabilityScopeValid
    && capabilityScopeManifest.genericDeclaredCapability === true
    && externalCapabilityTrustReady
    && capabilityScopeManifest.agendaMode === 'machine-generated'
    && capabilityScopeManifest.manuscriptMode === AGENT_AUTHORED_MANUSCRIPT_MODE
    && agendaBound
    && (!genericProductionRequested || priorArtAuthorityReady)
    && manuscriptProof.valid;
  if (genericProductionRequested && !productionEligible) {
    throw new Error('autonomous_research_agent_authored_release_proof_required');
  }
  if (externalSubmissionRequested && !recursiveClosureSourceReady) {
    throw new Error('autonomous_research_recursive_submission_closure_source_required');
  }
  if (trustedAutonomousManuscriptResult && !manuscriptProof.valid) {
    throw new Error('autonomous_research_manuscript_release_proof_invalid');
  }
  const renderReceipt = manuscriptProof.valid ? manuscriptProof.receipt : null;
  if (recursiveClosureSourceReady && (
    renderReceipt?.venueRequirementIrHash !== venueRequirementIr.venueRequirementIrHash
    || !validHash(renderReceipt?.venueRequirementIrFileHash)
    || renderReceipt?.venueRequirementIrPath !== 'AUTONOMOUS_VENUE_REQUIREMENT_IR.json'
    || renderReceipt?.anonymousReviewApplied !== venueRequirementIr.anonymousReview
    || renderReceipt?.venueTemplateAssetHash
      !== venueProfileSelection?.venueTemplateAsset?.templateAssetHash
    || renderReceipt?.venueTemplateAssetFileHash
      !== venueProfileSelection?.venueTemplateAsset?.templateAssetHash
    || renderReceipt?.venueTemplateAssetPath
      !== venueProfileSelection?.venueTemplateAsset?.relativePath
    || renderReceipt?.venueTemplateAssetApplicationMode !== 'latex-preamble-input-v1'
  )) {
    throw new Error('autonomous_research_venue_render_closure_required');
  }
  const runtimePrincipalBinding = preparation?.runtimePrincipalBinding || null;
  const reviewerEvidence = productionEligible
    ? buildAutonomousResearchReleaseReviewerEvidence({
      campaignId,
      paperId,
      campaignPlanHash,
      expectedManuscriptHash: renderReceipt?.manuscriptHash || null,
      refereeConvergenceDecision,
      runtimePrincipalBinding,
      reviewerEvidenceAuthority,
    }) : null;
  const payload = {
    version: recursiveClosureSourceReady ? 4 : 3,
    kind: 'AutonomousResearchReleaseBinding',
    campaignId: String(campaignId || ''),
    paperId: String(paperId || ''),
    campaignPlanHash: String(campaignPlanHash || ''),
    launchMode: preparation?.launchMode || null,
    proposalHash: preparation?.proposal?.machineProposedScientificClaimSetHash || null,
    policyAuthorizationHash:
      preparation?.policyAuthorization?.autonomousResearchPolicyAuthorizationHash || null,
    seedBindingHash: preparation?.seedBinding?.autonomousResearchSeedBindingHash || null,
    capabilityScopeManifestHash:
      capabilityScopeValid
        ? capabilityScopeManifest.autonomousResearchCapabilityScopeManifestHash : null,
    capabilityScopeManifest: capabilityScopeValid ? capabilityScopeManifest : null,
    externalCapabilityTrustInspectionHash: externalCapabilityTrustReady
      ? externalCapabilityTrustInspection
        .autonomousResearchExternalCapabilityTrustInspectionHash : null,
    externalCapabilityTrustInspection: externalCapabilityTrustReady
      ? externalCapabilityTrustInspection : null,
    researchAgendaProductionReceiptHash:
      agendaBound ? agendaReceipt.autonomousResearchAgendaProductionReceiptHash : null,
    researchAgendaProductionReceipt: agendaBound ? agendaReceipt : null,
    priorArtEvidenceReceiptHash: priorArtAuthorityReady
      ? priorArtEvidenceReceipt.priorArtEvidenceReceiptHash : null,
    priorArtEvidenceReceipt: priorArtAuthorityReady ? priorArtEvidenceReceipt : null,
    priorArtAuthorityVerificationBundleHash: priorArtAuthorityReady
      ? priorArtAuthorityVerificationBundle
        .priorArtRetrievalAuthorityVerificationBundleHash : null,
    priorArtAuthorityVerificationBundle: priorArtAuthorityReady
      ? priorArtAuthorityVerificationBundle : null,
    priorArtAuthorityTrustConfigurationHash: priorArtAuthorityReady
      ? priorArtAuthorityTrustConfiguration.priorArtAuthorityTrustConfigurationHash : null,
    priorArtAuthorityTrustConfiguration: priorArtAuthorityReady ? priorArtAuthorityTrustConfiguration : null,
    ...autonomousResearchRecursiveReleaseBindingFields({
      source: recursiveReleaseSource,
      proposal: preparation.proposal,
    }),
    proposalObjective: preparation?.proposal?.objective || null,
    proposalProtocolFamily: preparation?.proposal?.protocolFamily || null,
    manuscriptProductionMode:
      renderReceipt?.manuscriptProductionMode
      || capabilityScopeManifest?.manuscriptMode || null,
    qualificationScope: productionEligible
      ? PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE
      : BOUNDED_CAPABILITY_QUALIFICATION_SCOPE,
    fullResearchQualificationEligible: productionEligible,
    genericContentCanaryVerified,
    externalSubmissionEligible: productionEligible
      && capabilityScopeManifest?.venueMode === 'submission-enabled-v1',
    ...autonomousVenueReleaseBindingFields({
      venueProfileSelection,
      venueProfileValid,
      submissionMetadataReceipt,
      submissionMetadataValid,
    }),
    manuscriptPath: renderReceipt?.manuscriptPath || manuscriptPath || null,
    renderedManuscriptHash: renderReceipt?.manuscriptHash || null,
    evidenceBoundManuscriptIrHash:
      renderReceipt?.evidenceBoundManuscriptIrHash || null,
    manuscriptIrFileHash: renderReceipt?.manuscriptIrFileHash || null,
    trustedAutonomousManuscriptRenderReceiptHash:
      renderReceipt?.trustedAutonomousManuscriptRenderReceiptHash || null,
    trustedAutonomousManuscriptRenderReceipt: renderReceipt,
    manuscriptRenderNodeId: manuscriptProof.valid
      ? String(trustedAutonomousManuscriptResult.nodeId || '') : null,
    manuscriptRenderAttemptId: manuscriptProof.valid
      ? String(trustedAutonomousManuscriptResult.attemptId || '') : null,
    manuscriptRenderLeaseGeneration: manuscriptProof.valid
      ? Number(trustedAutonomousManuscriptResult.leaseGeneration || 0) : null,
    manuscriptRenderNodeResultHash: manuscriptProof.valid
      ? trustedAutonomousManuscriptResult.resultHash : null,
    manuscriptRenderNodeResult: manuscriptProof.valid
      ? manuscriptProof.result : null,
    campaignTrustedAutonomousManuscriptResultHash: manuscriptProof.valid
      ? manuscriptProof.result.campaignTrustedAutonomousManuscriptResultHash : null,
    agentExecutionReceiptHash:
      renderReceipt?.agentAuthoredRenderedProseReceiptHash || null,
    isolatedAgentMergeReceiptHash: manuscriptProof.valid
      ? campaignTrustedAutonomousManuscriptAuthorshipReceipt(manuscriptProof.result)
        ?.isolatedAgentMergeReceiptHash || null
      : null,
    agentAuthoredSourceDraftHash: renderReceipt?.agentAuthoredSourceDraftHash || null,
    agentAuthoredSourceDraftFileHash:
      renderReceipt?.agentAuthoredSourceDraftFileHash || null,
    agentAuthoredSourceDraft: manuscriptProof.valid ? agentAuthoredSourceDraft : null,
    agentWorkspacePostimageBindingHash:
      renderReceipt?.agentWorkspacePostimageBindingHash || null,
    runtimePrincipalBindingHash:
      runtimePrincipalBinding?.runtimePrincipalBindingHash || null,
    runtimePrincipalBinding,
    releaseReviewerEvidenceHash: reviewerEvidence
      ?.autonomousResearchReleaseReviewerEvidenceHash || null,
    releaseReviewerEvidence: reviewerEvidence,
    globalGoldenQualificationAuthorityHash:
      globalGoldenQualificationAuthority
        ?.autonomousResearchGlobalGoldenQualificationAuthorityHash || null,
    globalGoldenQualificationAuthority,
  };
  if (!payload.campaignId || !payload.paperId
    || !['golden-bootstrap', 'production-run'].includes(payload.launchMode)
    || !['campaignPlanHash', 'proposalHash', 'policyAuthorizationHash', 'seedBindingHash']
      .every((field) => SHA256.test(String(payload[field] || '')))) {
    throw new Error('autonomous_research_release_binding_input_invalid');
  }
  return deepFreezeJsonValue({
    ...payload,
    autonomousResearchReleaseBindingHash:
      hashRecord('AutonomousResearchReleaseBinding', payload),
  });
}

export function verifyAutonomousResearchReleaseBinding(binding, expected = {}) {
  let expectationHash = null;
  try {
    expectationHash = hashRecord(
      'AutonomousResearchReleaseBindingVerificationExpectation',
      expected,
    );
  } catch { /* verify without caching malformed expectations */ }
  const cached = expectationHash
    ? verifiedImmutableReleaseBindings.get(binding)?.get(expectationHash)
    : null;
  if (cached) return cached;
  const blockers = [];
  const { autonomousResearchReleaseBindingHash: claimedHash, ...payload } = binding || {};
  if (![3, 4].includes(binding?.version) || binding?.kind !== 'AutonomousResearchReleaseBinding'
    || !SHA256.test(String(claimedHash || ''))
    || hashRecord('AutonomousResearchReleaseBinding', payload) !== claimedHash) {
    blockers.push('autonomous_research_release_binding_record_invalid');
  }
  for (const field of [
    'campaignId', 'paperId', 'campaignPlanHash', 'launchMode', 'proposalHash',
    'policyAuthorizationHash', 'seedBindingHash',
    'globalGoldenQualificationAuthorityHash',
    'capabilityScopeManifestHash', 'researchAgendaProductionReceiptHash',
    'priorArtEvidenceReceiptHash', 'priorArtAuthorityVerificationBundleHash',
    'priorArtAuthorityTrustConfigurationHash',
    'externalCapabilityTrustInspectionHash',
    'manuscriptProductionMode', 'qualificationScope',
    'fullResearchQualificationEligible', 'externalSubmissionEligible',
    'genericContentCanaryVerified',
    'manuscriptPath', 'renderedManuscriptHash', 'evidenceBoundManuscriptIrHash',
    'manuscriptIrFileHash', 'trustedAutonomousManuscriptRenderReceiptHash',
    'agentExecutionReceiptHash', 'agentAuthoredSourceDraftHash',
    'isolatedAgentMergeReceiptHash',
    'agentAuthoredSourceDraftFileHash', 'agentWorkspacePostimageBindingHash',
    'venueProfileSelectionHash', 'submissionMetadataReceiptHash',
    'venueProfileRankingReceiptHash', 'venueSelectorConfigurationHash',
    'venueAuthorityConfigurationHash',
    'submissionMetadataAuthorityConfigurationHash',
    'proposalObjective', 'proposalProtocolFamily',
    'runtimePrincipalBindingHash', 'releaseReviewerEvidenceHash',
    'researchAgendaIrHash', 'researchAgendaClaimBindingReceiptHash',
    'priorArtClaimAlignmentReceiptHash', 'venueRequirementIrHash',
    'experimentIrExecutionAuthorityReceiptHash', 'experimentReplayReceiptHash',
    'researchReportHash', 'proposalClaimToTheoremBindingHash', 'experimentRegistryHash',
  ]) {
    if (expected[field] !== undefined && binding?.[field] !== expected[field]) {
      blockers.push(`autonomous_research_release_binding_${field}_mismatch`);
    }
  }
  const renderReceipt = binding?.trustedAutonomousManuscriptRenderReceipt || null;
  const capabilityManifest = binding?.capabilityScopeManifest || null;
  const agendaReceipt = binding?.researchAgendaProductionReceipt || null;
  const externalCapabilityTrustInspection = binding?.externalCapabilityTrustInspection || null;
  const capabilityManifestValid = capabilityManifest
    ? verifyAutonomousResearchCapabilityScopeManifest(capabilityManifest) : false;
  const agendaReceiptVerification = agendaReceipt
    ? verifyAutonomousResearchAgendaProductionReceipt(agendaReceipt) : null;
  const externalCapabilityTrustReady =
    verifyAutonomousResearchExternalCapabilityTrustInspection(
      externalCapabilityTrustInspection,
    ) && externalCapabilityTrustInspection?.ready === true
    && externalCapabilityTrustInspection
      .autonomousResearchExternalCapabilityTrustInspectionHash
        === binding?.externalCapabilityTrustInspectionHash;
  const priorArtAuthorityReady = verifyAutonomousResearchProductionPriorArtAuthority({
    priorArtReceipt: binding?.priorArtEvidenceReceipt,
    authorityBundle: binding?.priorArtAuthorityVerificationBundle,
    trustConfiguration: binding?.priorArtAuthorityTrustConfiguration,
    externalCapabilityTrustInspection,
    researchAgendaIr: binding?.researchAgendaIr || null,
  })
    && binding?.priorArtEvidenceReceiptHash
      === binding?.priorArtEvidenceReceipt?.priorArtEvidenceReceiptHash
    && binding?.priorArtAuthorityVerificationBundleHash
      === binding?.priorArtAuthorityVerificationBundle
        ?.priorArtRetrievalAuthorityVerificationBundleHash
    && binding?.priorArtAuthorityTrustConfigurationHash
      === binding?.priorArtAuthorityTrustConfiguration?.priorArtAuthorityTrustConfigurationHash;
  const productionScope = binding?.qualificationScope
    === PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE;
  const boundedScope = binding?.qualificationScope
    === BOUNDED_CAPABILITY_QUALIFICATION_SCOPE;
  const requiresGenericContentProof = productionScope
    || binding?.genericContentCanaryVerified === true;
  const recursiveClosureSource = binding?.version === 4;
  const recursiveResearchClosureValid = !recursiveClosureSource
    || verifyAutonomousResearchRecursiveReleaseBinding(binding, { agendaReceipt });
  const renderVerification = renderReceipt
    ? verifyTrustedAutonomousManuscriptRenderReceipt(renderReceipt, {
      paperId: binding?.paperId,
      campaignId: binding?.campaignId,
      manuscriptPath: binding?.manuscriptPath,
      manuscriptHash: binding?.renderedManuscriptHash,
      evidenceBoundManuscriptIrHash: binding?.evidenceBoundManuscriptIrHash,
      manuscriptIrFileHash: binding?.manuscriptIrFileHash,
      agentAuthoredSourceDraftHash: binding?.agentAuthoredSourceDraftHash,
      agentAuthoredSourceDraftFileHash: binding?.agentAuthoredSourceDraftFileHash,
      venueProfileSelectionHash: binding?.venueProfileSelectionHash,
      venueRequirementIrHash: recursiveClosureSource
        ? binding?.venueRequirementIrHash : null,
      venueTemplateAssetHash: recursiveClosureSource
        ? binding?.venueProfileSelection?.venueTemplateAsset?.templateAssetHash : null,
      venueTemplateAssetPath: recursiveClosureSource
        ? binding?.venueProfileSelection?.venueTemplateAsset?.relativePath : null,
      submissionMetadataReceiptHash: binding?.submissionMetadataReceiptHash,
      agentExecutionReceipt: binding?.manuscriptRenderNodeResult?.agentExecutionReceipt || null,
      requireAgentAuthored: requiresGenericContentProof,
      requireExternalSubmission: binding?.externalSubmissionEligible === true,
    }) : null;
  const boundNodeProof = binding?.manuscriptRenderNodeResult
    ? inspectAutonomousManuscriptReleaseProof({
      nodeId: binding.manuscriptRenderNodeId,
      attemptId: binding.manuscriptRenderAttemptId,
      leaseGeneration: binding.manuscriptRenderLeaseGeneration,
      resultHash: binding.manuscriptRenderNodeResultHash,
      result: binding.manuscriptRenderNodeResult,
    }, {
      paperId: binding.paperId,
      campaignId: binding.campaignId,
      manuscriptPath: binding.manuscriptPath,
      renderedManuscriptHash: binding.renderedManuscriptHash,
      evidenceBoundManuscriptIrHash: binding.evidenceBoundManuscriptIrHash,
      manuscriptIrFileHash: binding.manuscriptIrFileHash,
      agentAuthoredSourceDraftHash: binding.agentAuthoredSourceDraftHash,
      agentAuthoredSourceDraftFileHash: binding.agentAuthoredSourceDraftFileHash,
      venueProfileSelectionHash: binding.venueProfileSelectionHash,
      venueRequirementIrHash: recursiveClosureSource
        ? binding.venueRequirementIrHash : null,
      venueTemplateAssetHash: recursiveClosureSource
        ? binding?.venueProfileSelection?.venueTemplateAsset?.templateAssetHash : null,
      venueTemplateAssetPath: recursiveClosureSource
        ? binding?.venueProfileSelection?.venueTemplateAsset?.relativePath : null,
      submissionMetadataReceiptHash: binding.submissionMetadataReceiptHash,
      requireExternalSubmission: binding.externalSubmissionEligible === true,
    }, { requireAgentAuthored: requiresGenericContentProof }) : null;
  if ((!productionScope && !boundedScope)
    || binding?.fullResearchQualificationEligible !== productionScope
    || (productionScope && binding?.genericContentCanaryVerified !== true)
    || (productionScope && binding?.launchMode !== 'production-run')
    || (binding?.launchMode === 'production-run' && !productionScope)
    || (binding?.externalSubmissionEligible === true && !productionScope)) {
    blockers.push('autonomous_research_release_binding_qualification_scope_invalid');
  }
  if (recursiveClosureSource && (
    !productionScope
    || binding?.externalSubmissionEligible !== true
    || !recursiveResearchClosureValid
    || renderReceipt?.anonymousReviewApplied
      !== binding?.venueRequirementIr?.anonymousReview
  )) {
    blockers.push('autonomous_research_release_binding_recursive_closure_source_invalid');
  }
  const reviewerEvidenceBindingValid = verifyAutonomousResearchReleaseReviewerBindingFields(
    binding,
    { productionScope },
  );
  if (productionScope && !reviewerEvidenceBindingValid) {
    blockers.push('autonomous_research_release_binding_reviewer_evidence_invalid');
  }
  if (!productionScope && !reviewerEvidenceBindingValid) {
    blockers.push('autonomous_research_release_binding_optional_reviewer_evidence_invalid');
  }
  if (requiresGenericContentProof && (!['production-run', 'golden-bootstrap']
    .includes(binding?.launchMode)
    || binding?.manuscriptProductionMode !== AGENT_AUTHORED_MANUSCRIPT_MODE
    || !capabilityManifestValid
    || capabilityManifest?.genericDeclaredCapability !== true
    || capabilityManifest?.agendaMode !== 'machine-generated'
    || capabilityManifest?.manuscriptMode !== AGENT_AUTHORED_MANUSCRIPT_MODE
    || !externalCapabilityTrustReady
    || (productionScope && !priorArtAuthorityReady)
    || capabilityManifest?.autonomousResearchCapabilityScopeManifestHash
      !== binding?.capabilityScopeManifestHash
    || !agendaReceiptVerification?.valid
    || agendaReceipt?.autonomousResearchAgendaProductionReceiptHash
      !== binding?.researchAgendaProductionReceiptHash
    || agendaReceipt?.paperId !== binding?.paperId
    || agendaReceipt?.selectedObjective !== binding?.proposalObjective
    || agendaReceipt?.selectedProtocolFamily !== binding?.proposalProtocolFamily
    || !capabilityManifest?.empiricalFamilies?.includes(binding?.proposalProtocolFamily)
    || !renderVerification?.valid
    || binding?.trustedAutonomousManuscriptRenderReceiptHash
      !== renderReceipt?.trustedAutonomousManuscriptRenderReceiptHash
    || binding?.agentExecutionReceiptHash
      !== renderReceipt?.agentAuthoredRenderedProseReceiptHash
    || binding?.isolatedAgentMergeReceiptHash
      !== binding?.manuscriptRenderNodeResult?.agentExecutionReceipt
        ?.isolatedAgentMergeReceiptHash
    || binding?.agentAuthoredSourceDraftHash !== renderReceipt?.agentAuthoredSourceDraftHash
    || binding?.agentAuthoredSourceDraftFileHash
      !== renderReceipt?.agentAuthoredSourceDraftFileHash
    || binding?.agentWorkspacePostimageBindingHash
      !== renderReceipt?.agentWorkspacePostimageBindingHash
    || !validHash(binding?.manuscriptRenderNodeResultHash)
    || !validHash(binding?.campaignTrustedAutonomousManuscriptResultHash)
    || !boundNodeProof?.valid
    || boundNodeProof?.receipt?.trustedAutonomousManuscriptRenderReceiptHash
      !== binding?.trustedAutonomousManuscriptRenderReceiptHash
    || boundNodeProof?.result?.campaignTrustedAutonomousManuscriptResultHash
      !== binding?.campaignTrustedAutonomousManuscriptResultHash
    || !binding?.manuscriptRenderNodeId
    || !binding?.manuscriptRenderAttemptId
    || !Number.isSafeInteger(binding?.manuscriptRenderLeaseGeneration)
    || binding.manuscriptRenderLeaseGeneration < 1)) {
    blockers.push('autonomous_research_release_binding_agent_authored_proof_invalid');
  }
  if (renderReceipt && (!renderVerification?.valid
    || binding?.trustedAutonomousManuscriptRenderReceiptHash
      !== renderReceipt.trustedAutonomousManuscriptRenderReceiptHash)) {
    blockers.push('autonomous_research_release_binding_render_receipt_invalid');
  }
  if (binding?.manuscriptRenderNodeResult && !boundNodeProof?.valid) {
    blockers.push('autonomous_research_release_binding_render_node_proof_invalid');
  }
  if (capabilityManifest && (!capabilityManifestValid
    || capabilityManifest.autonomousResearchCapabilityScopeManifestHash
      !== binding?.capabilityScopeManifestHash)) {
    blockers.push('autonomous_research_release_binding_capability_manifest_invalid');
  }
  if (agendaReceipt && (!agendaReceiptVerification?.valid
    || agendaReceipt.autonomousResearchAgendaProductionReceiptHash
      !== binding?.researchAgendaProductionReceiptHash
    || agendaReceipt.paperId !== binding?.paperId
    || agendaReceipt.selectedObjective !== binding?.proposalObjective
    || agendaReceipt.selectedProtocolFamily !== binding?.proposalProtocolFamily)) {
    blockers.push('autonomous_research_release_binding_agenda_receipt_invalid');
  }
  if ((binding?.externalCapabilityTrustInspection
      || binding?.externalCapabilityTrustInspectionHash)
    && !externalCapabilityTrustReady) {
    blockers.push('autonomous_research_release_binding_external_capability_trust_invalid');
  }
  if (productionScope && !priorArtAuthorityReady) {
    blockers.push('autonomous_research_release_binding_prior_art_authority_invalid');
  }
  const sourceDraftHash = binding?.agentAuthoredSourceDraft
    ? hashBytes(Buffer.from(JSON.stringify(binding.agentAuthoredSourceDraft), 'utf8')) : null;
  if (requiresGenericContentProof
    && (sourceDraftHash !== binding?.agentAuthoredSourceDraftHash
    || !validHash(binding?.agentAuthoredSourceDraftFileHash))) {
    blockers.push('autonomous_research_release_binding_source_draft_invalid');
  }
  if (binding?.externalSubmissionEligible === true
    && !verifyAutonomousVenueReleaseBinding(binding, renderReceipt, {
      authorityObservedAt: expected.authorityObservedAt
        || binding?.venueProfileSelection?.selectedAt || null,
    })) {
    blockers.push('autonomous_research_release_binding_submission_authority_invalid');
  }
  if (!['campaignPlanHash', 'proposalHash', 'policyAuthorizationHash', 'seedBindingHash']
    .every((field) => SHA256.test(String(binding?.[field] || '')))) {
    blockers.push('autonomous_research_release_binding_hash_fields_invalid');
  }
  const globalAuthority = binding?.globalGoldenQualificationAuthority || null;
  if (Boolean(globalAuthority)
      !== Boolean(binding?.globalGoldenQualificationAuthorityHash)
    || (globalAuthority && (
      verifyAutonomousResearchGlobalGoldenQualificationAuthority(globalAuthority, {
        campaignId: binding.campaignId,
        paperId: binding.paperId,
        campaignPlanHash: binding.campaignPlanHash,
        launchMode: binding.launchMode,
      }).valid !== true
      || binding.globalGoldenQualificationAuthorityHash
        !== globalAuthority.autonomousResearchGlobalGoldenQualificationAuthorityHash
    ))) {
    blockers.push('autonomous_research_release_binding_global_golden_authority_invalid');
  }
  const result = Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
  });
  if (expectationHash && binding && typeof binding === 'object'
    && isDeeplyFrozenJsonValue(binding)) {
    const bindingCache = verifiedImmutableReleaseBindings.get(binding) || new Map();
    bindingCache.set(expectationHash, result);
    verifiedImmutableReleaseBindings.set(binding, bindingCache);
  }
  return result;
}
