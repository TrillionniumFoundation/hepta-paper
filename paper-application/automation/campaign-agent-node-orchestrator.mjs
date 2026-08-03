import {
  buildCampaignAgentExecutionRequest,
  extractCampaignAgentJson,
} from './campaign-agent-policy.mjs';
import {
  verifyApprovedFormalProposalWriterSeed,
  verifyFormalProposalWriterSurface,
} from './campaign-formal-proposal-writer.mjs';
import {
  campaignEmpiricalNodeClassification,
  isCampaignRefereeNode,
} from './campaign-node-execution-context.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { assertOutcomeBoundManuscriptMutationAllowed } from './campaign-confirmatory-lineage-policy.mjs';
import {
  collectCampaignManuscriptAgentExecutionReceipts,
} from './campaign-manuscript-agent-receipts.mjs';
import {
  agentExecutionUsageFields,
  attachSuccessfulAgentReceipt,
  requireVerifiedAgentReceipt,
} from './campaign-agent-execution-boundary.mjs';
import {
  inspectAutonomousResearchProductionProfilePreparation,
} from '../../paper-domain/automation/autonomous-research-production-profile-contract.mjs';
import {
  buildReviewerExecutionAuthorityContext,
  reviewerSemanticReviewHash,
} from '../../paper-domain/research/reviewer-semantic-evidence-contract.mjs';

export {
  executeCampaignFormalVerificationNode,
} from './campaign-formal-verification-node-orchestrator.mjs';

function completedEmpiricalOutcome(campaignNodes) {
  return (campaignNodes || []).some((candidate) => {
    const classification = campaignEmpiricalNodeClassification(candidate?.kind);
    return candidate?.status === 'completed'
      && (classification.primary || classification.reproduction || classification.revalidate);
  });
}

function blockedResult(result) {
  const error = new Error(`campaign_research_verification_blocked:${(result?.researchPromotionBlockers || []).join(',') || 'result_invalid'}`);
  error.retryable = false;
  error.receipt = result || null;
  return error;
}

const PERMANENT_TRUSTED_MANUSCRIPT_ERROR_PREFIXES = Object.freeze([
  'trusted_autonomous_manuscript_proposal_claim_binding_invalid',
  'trusted_autonomous_manuscript_claim_id_duplicate',
  'trusted_autonomous_manuscript_claims_missing',
  'trusted_autonomous_manuscript_empirical_claim_lineage_required',
  'trusted_autonomous_manuscript_empirical_claim_lineage_invalid',
  'trusted_autonomous_manuscript_empirical_claim_lineage_identity_invalid',
  'trusted_autonomous_manuscript_empirical_claim_lineage_binding_invalid',
  'trusted_autonomous_manuscript_empirical_claim_lineage_bijection_invalid',
]);
const PERMANENT_TRUSTED_MANUSCRIPT_ERROR_MARKERS = Object.freeze([
  'empirical_claim_universe_authority_claim_missing:',
  'empirical_claim_universe_authority_hash_mismatch:',
]);

export function trustedAutonomousManuscriptRenderFailureIsPermanent(value) {
  const message = String(value?.message || value || '');
  return PERMANENT_TRUSTED_MANUSCRIPT_ERROR_PREFIXES.some((prefix) => (
    message.startsWith(prefix)
  )) || (message.startsWith('trusted_autonomous_manuscript_render_verification_failed:')
    && PERMANENT_TRUSTED_MANUSCRIPT_ERROR_MARKERS.some((marker) => (
      message.includes(marker)
    )));
}

export function selectTrustedAutonomousManuscriptAuthorshipReceipt({
  renderReceipt,
  agentExecutionReceipts,
} = {}) {
  const expectedHash = renderReceipt?.agentAuthoredRenderedProseReceiptHash || null;
  const selected = (agentExecutionReceipts || []).find((candidate) => (
    candidate?.agentExecutionReceiptHash === expectedHash
  )) || null;
  if (!selected) {
    const error = new Error(
      'trusted_autonomous_manuscript_authorship_receipt_projection_invalid',
    );
    error.retryable = false;
    throw error;
  }
  return selected;
}

export async function executeCampaignResearchVerificationNode({
  primitives,
  campaign,
  node,
  context,
  workspace,
  manuscript,
  executionSignal,
  executionResources = null,
} = {}) {
  const result = await primitives.release.verifyResearch({
    campaign,
    node,
    campaignNodes: context.campaignNodes,
    workspace,
    manuscript,
    formalVerificationReceipt: context.formalVerificationNode?.result || null,
    executionSignal,
    assertExternalSideEffectReady:
      executionResources?.assertExternalSideEffectReady || null,
  });
  if (result?.status !== 'campaign_research_verification_completed'
    || !result?.researchReportHash
    || !result?.campaignResearchVerificationResultHash) throw blockedResult(result);
  return result;
}

export async function executeCampaignAgentNode({
  primitives,
  campaign,
  node,
  context,
  workspace,
  manuscript,
  executionBudget,
  executionSignal,
} = {}) {
  const productionProfileInspection =
    inspectAutonomousResearchProductionProfilePreparation(
      campaign?.spec?.autonomousResearchPreparation || null,
    );
  if (!productionProfileInspection.ready) {
    const error = new Error(
      `campaign_agent_production_profile_blocked:${productionProfileInspection.blockers.join(',')}`,
    );
    error.retryable = false;
    throw error;
  }
  const proposalSeedVerification = verifyApprovedFormalProposalWriterSeed({
    primitives, campaign, node, workspace,
  });
  const paperQualityProfiles = [
    campaign.spec.paperQualityProfile,
    ...(campaign.spec.paperQualityProfiles || []),
  ].filter(Boolean);
  const empiricalCampaign = paperQualityProfiles.includes('empirical_or_experiment')
    || Boolean(campaign.spec.benchmarkSelector);
  const needsEmpiricalAssertionAuthority = empiricalCampaign
    && (['manuscript-integrate', 'revise'].includes(node.kind) || isCampaignRefereeNode(node.kind));
  const empiricalAssertionAuthority = needsEmpiricalAssertionAuthority
    ? primitives.workspace.prepareEmpiricalAssertionAuthority({
      workspace,
      paperId: campaign.paperId,
      campaignId: campaign.campaignId,
      campaignNodes: context.campaignNodes,
    })
    : null;
  const empiricalOutcomeObserved = ['manuscript-integrate', 'revise'].includes(node.kind)
    && completedEmpiricalOutcome(context.campaignNodes);
  const autonomousManuscriptEvidenceRefBindings =
    ['manuscript-integrate', 'revise'].includes(node.kind)
      && campaign.spec.scientificClaimAuthority
        ?.claimAuthorityType === 'machine-policy-authorized'
      ? primitives.workspace.prepareAutonomousManuscriptEvidenceRefBindings({
        workspace,
        empiricalAssertionAuthority,
        formalVerificationReceipt: context.formalVerificationNode?.result || null,
      })
      : null;
  const independentReview = isCampaignRefereeNode(node.kind);
  const reviewerManuscriptHash = independentReview
    ? primitives.workspace.hashFile({ workspace, relative: manuscript }) : null;
  const reviewerExecutionAuthorityContext = independentReview
    && /^sha256:[0-9a-f]{64}$/.test(String(campaign?.spec?.campaignPlanHash || ''))
    ? buildReviewerExecutionAuthorityContext({
      campaignId: campaign.campaignId,
      campaignPlanHash: campaign.spec.campaignPlanHash,
      paperId: campaign.paperId,
      nodeId: node.nodeId,
      roundIndex: node.roundIndex,
      reviewAttemptId: node.attemptId,
      manuscriptHash: reviewerManuscriptHash,
    }) : null;
  const request = buildCampaignAgentExecutionRequest({
    campaign,
    node,
    workspace,
    manuscript,
    reviews: context.reviews,
    priorConvergence: context.priorConvergence,
    qualityGateBlockers: context.qualityGateBlockers,
    revisionMaterialization: context.revisionMaterialization,
    empiricalAssertionAuthority,
    autonomousManuscriptEvidenceRefBindings,
    reviewerExecutionAuthorityContext,
    empiricalOutcomeObserved,
    executionBudget,
    executionSignal,
  });
  const receipt = await primitives.agent.execute({
    principal: node.kind === 'formal-review'
      ? 'formal-review'
      : isCampaignRefereeNode(node.kind) ? 'independent-review' : 'default',
    request: proposalSeedVerification ? {
      ...request,
      context: {
        ...request.context,
        scientificClaimAuthorityVerificationReceiptHash:
          proposalSeedVerification.scientificClaimAuthorityVerificationReceiptHash
            || proposalSeedVerification.approvedProposalSeedVerificationReceiptHash,
        ...(proposalSeedVerification.approvedProposalSeedVerificationReceiptHash ? {
          approvedProposalSeedVerificationReceiptHash:
            proposalSeedVerification.approvedProposalSeedVerificationReceiptHash,
        } : {}),
      },
    } : request,
  });
  if (empiricalOutcomeObserved) {
    requireVerifiedAgentReceipt(receipt, 'outcome_bound_manuscript_revision');
    try {
      assertOutcomeBoundManuscriptMutationAllowed({
        changedPaths: receipt.changedPaths,
        manuscript,
      });
    } catch (error) {
      throw attachSuccessfulAgentReceipt(error, receipt);
    }
  }
  if (['manuscript-integrate', 'revise'].includes(node.kind)
    && campaign.spec.scientificClaimAuthority?.claimAuthorityType === 'machine-policy-authorized') {
    requireVerifiedAgentReceipt(receipt, 'trusted_autonomous_manuscript');
    const usageFields = agentExecutionUsageFields(receipt);
    const manuscriptProductionMode = campaign.spec.autonomousResearchPreparation
      ?.capabilityScopeManifest?.manuscriptMode
      || 'minimal-report-evidence-bound-ir-v1';
    const requireAgentAuthoredProse = manuscriptProductionMode
      === 'agent-authored-evidence-bound-ir-v1';
    try {
      const manuscriptAgentExecutionReceipts =
        collectCampaignManuscriptAgentExecutionReceipts(context.campaignNodes, receipt);
      const renderReceipt = primitives.workspace.renderTrustedAutonomousManuscript({
        workspace,
        manuscriptPath: manuscript,
        paperId: campaign.paperId,
        campaignId: campaign.campaignId,
        authority: empiricalAssertionAuthority,
        formalVerificationReceipt: context.formalVerificationNode?.result || null,
        agentExecutionReceipt: receipt,
        agentExecutionReceipts: manuscriptAgentExecutionReceipts,
        requireAgentAuthoredProse,
        manuscriptProductionMode: manuscriptProductionMode === 'agent-authored-evidence-bound-ir-v1'
          ? manuscriptProductionMode : 'minimal-report-evidence-bound-ir-v1',
      });
      const authorshipReceipt = selectTrustedAutonomousManuscriptAuthorshipReceipt({
        renderReceipt,
        agentExecutionReceipts: manuscriptAgentExecutionReceipts,
      });
      const changedPaths = Object.freeze([...new Set([
        ...(receipt.changedPaths || []),
        manuscript,
        renderReceipt.manuscriptIrPath,
        renderReceipt.evidenceEntailmentContractPath,
        ...(renderReceipt.presentationArtifacts || []).map((artifact) => artifact.path),
      ].filter(Boolean))].sort());
      const payload = {
        version: 1,
        kind: 'CampaignTrustedAutonomousManuscriptResult',
        status: 'campaign_trusted_autonomous_manuscript_completed',
        ...usageFields,
        authorshipAgentExecutionReceiptHash: authorshipReceipt.agentExecutionReceiptHash,
        authorshipAgentExecutionReceipt: authorshipReceipt,
        changedPaths,
        trustedAutonomousManuscriptRenderReceiptHash:
          renderReceipt.trustedAutonomousManuscriptRenderReceiptHash,
        trustedAutonomousManuscriptRenderReceipt: renderReceipt,
      };
      return Object.freeze({
        ...payload,
        campaignTrustedAutonomousManuscriptResultHash:
          hashRecord('CampaignTrustedAutonomousManuscriptResult', payload),
      });
    } catch (error) {
      if (trustedAutonomousManuscriptRenderFailureIsPermanent(error)) {
        error.retryable = false;
      }
      throw attachSuccessfulAgentReceipt(error, receipt);
    }
  }
  if (proposalSeedVerification) {
    requireVerifiedAgentReceipt(receipt, 'formal_proposal_writer');
    agentExecutionUsageFields(receipt);
    try {
      verifyFormalProposalWriterSurface({ primitives, campaign, workspace, manuscript });
    } catch (error) {
      throw attachSuccessfulAgentReceipt(error, receipt);
    }
  }
  if (node.kind === 'theorem-spec') {
    requireVerifiedAgentReceipt(receipt, 'theorem_specification');
    try {
      if (JSON.stringify(receipt.changedPaths || []) !== JSON.stringify(['THEOREM_SPEC_DRAFT.json'])) {
        const error = new Error('theorem_specification_agent_changed_paths_invalid');
        error.retryable = false;
        throw error;
      }
      const finalizationReceipt = primitives.workspace.finalizeTheoremSpecification({
        workspace,
        manuscriptPath: manuscript,
        paperId: campaign.paperId,
        campaignId: campaign.campaignId,
        scientificClaimAuthority: campaign.spec.scientificClaimAuthority || null,
        approvedProposalSeed: campaign.spec.approvedProposalSeed || null,
      });
      const {
        theoremSpecificationFinalizationReceiptHash: claimedFinalizationHash,
        ...finalizationPayload
      } = finalizationReceipt || {};
      if (!claimedFinalizationHash
        || hashRecord('TheoremSpecificationFinalizationReceipt', finalizationPayload) !== claimedFinalizationHash) {
        throw new Error('theorem_specification_finalization_receipt_invalid');
      }
      const theoremSpecification = primitives.workspace.readTheoremSpecification({
        workspace,
        manuscriptPath: manuscript,
        paperId: campaign.paperId,
        campaignId: campaign.campaignId,
        scientificClaimAuthority: campaign.spec.scientificClaimAuthority || null,
        approvedProposalSeed: campaign.spec.approvedProposalSeed || null,
      });
      const payload = {
        version: 1,
        kind: 'CampaignTheoremSpecificationResult',
        status: 'campaign_theorem_specification_completed',
        campaignId: campaign.campaignId,
        paperId: campaign.paperId,
        nodeId: node.nodeId,
        attemptId: node.attemptId || null,
        agentExecutionReceiptHash: receipt.agentExecutionReceiptHash,
        theoremSpecificationAgentReceipt: receipt,
        ...agentExecutionUsageFields(receipt),
        theoremSpecificationFinalizationReceiptHash: claimedFinalizationHash,
        theoremSpecificationFinalizationReceipt: finalizationReceipt,
        theoremSpecificationHash: theoremSpecification.theoremSpecificationHash,
        sourceManuscriptHash: theoremSpecification.sourceManuscriptHash,
        formalClaimUniverseHash: theoremSpecification.formalClaimUniverseHash,
        claimAuthorityType: theoremSpecification.claimAuthorityType,
        claimAuthorityBindingHash: theoremSpecification.claimAuthorityBindingHash,
        claimAuthorityBundleHash: theoremSpecification.claimAuthorityBundleHash,
        approvedProposalSeedBindingHash: theoremSpecification.approvedProposalSeedBindingHash,
        proposalSeedContractBundleHash: theoremSpecification.proposalSeedContractBundleHash,
        proposalClaimRecordHashes: Object.freeze(theoremSpecification.claims
          .map((claim) => claim.proposalClaimSource?.proposalClaimRecordHash).filter(Boolean)),
        claimCount: theoremSpecification.claimCount,
        externalActionPerformed: false,
      };
      return Object.freeze({
        ...payload,
        campaignTheoremSpecificationResultHash: hashRecord('CampaignTheoremSpecificationResult', payload),
      });
    } catch (error) {
      throw attachSuccessfulAgentReceipt(error, receipt);
    }
  }
  if (node.kind === 'formal-review') {
    requireVerifiedAgentReceipt(receipt, 'formal_review');
    agentExecutionUsageFields(receipt);
    try {
      return primitives.agent.buildFormalReviewEnvelope({
        campaign,
        node,
        authorNode: context.formalAuthorNode,
        receipt,
        workspace,
        manuscript,
      });
    } catch (error) {
      throw attachSuccessfulAgentReceipt(error, receipt);
    }
  }
  if (!isCampaignRefereeNode(node.kind)) return receipt;
  requireVerifiedAgentReceipt(receipt, 'campaign_referee');
  try {
    const parsed = receipt.structuredOutput || extractCampaignAgentJson(receipt.finalOutput) || {};
    const postReviewManuscriptHash = primitives.workspace.hashFile({
      workspace, relative: manuscript,
    });
    if (postReviewManuscriptHash !== reviewerManuscriptHash) {
      throw new Error('campaign_referee_manuscript_changed_during_review');
    }
    const semanticReviewerEvidence = Boolean(
      reviewerExecutionAuthorityContext && receipt.unsignedAgentExecutionReceipt,
    );
    return Object.freeze({
    reviewerId: node.spec?.role || node.role || node.kind,
    role: node.spec?.role || node.role || node.kind,
    verdict: parsed.verdict === 'accept' ? 'accept' : 'revise',
    score: Number(parsed.score || 0),
    criticalFindingCount: Number(parsed.criticalFindingCount || 0),
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    summary: parsed.summary || receipt.finalOutput.slice(-1000),
    reviewHash: semanticReviewerEvidence
      ? reviewerSemanticReviewHash({
        unsignedAgentExecutionReceipt: receipt.unsignedAgentExecutionReceipt,
      }) : receipt.agentExecutionReceiptHash,
    reviewPrincipalId: receipt.reviewPrincipalId
      || receipt.principalId || receipt.agentId || null,
    reviewPrincipalDescriptorHash: receipt.reviewPrincipalDescriptorHash || null,
    reviewerProviderAccountIdentityHash:
      receipt.reviewerProviderAccountIdentityHash || null,
    reviewerCredentialRootIdentityHash:
      receipt.reviewerCredentialRootIdentityHash || null,
    reviewerTrustDomainIdentityHash:
      receipt.reviewerTrustDomainIdentityHash || null,
    reviewerSignerIdentityHash: receipt.reviewerSignerIdentityHash || null,
    signedReviewerReceiptHash: receipt.signedReviewerReceiptHash || null,
    signedReviewerReceipt: receipt.signedReviewerReceipt || null,
    unsignedAgentExecutionReceiptHash:
      receipt.unsignedAgentExecutionReceiptHash || null,
    unsignedAgentExecutionReceipt:
      receipt.unsignedAgentExecutionReceipt || null,
    signatureVerificationReceiptHash:
      receipt.signatureVerificationReceiptHash || null,
    researchPrincipalPoolHash: receipt.researchPrincipalPoolHash || null,
    reviewEvidenceMode: receipt.reviewEvidenceMode || null,
    reviewAttemptId: reviewerExecutionAuthorityContext?.reviewAttemptId
      || node.attemptId || null,
    manuscriptHash: reviewerExecutionAuthorityContext?.manuscriptHash
      || reviewerManuscriptHash,
    childSessionId: receipt.childSessionId
      || receipt.sessionId || receipt.sessionKey || null,
    sessionKey: receipt.sessionKey || null,
    openClawRunId: receipt.openClawRunId || null,
    ...agentExecutionUsageFields(receipt),
    promptHash: receipt.promptHash || null,
    resolvedModel: receipt.resolvedModel || receipt.model || null,
    campaignId: reviewerExecutionAuthorityContext?.campaignId || null,
    campaignPlanHash: reviewerExecutionAuthorityContext?.campaignPlanHash || null,
    paperId: reviewerExecutionAuthorityContext?.paperId || null,
    nodeId: reviewerExecutionAuthorityContext?.nodeId || node.nodeId || null,
    roundIndex: reviewerExecutionAuthorityContext?.roundIndex
      || Number(node.roundIndex || 0),
      selectedExecutorId: receipt.selectedExecutorId || receipt.executorId || null,
    });
  } catch (error) {
    throw attachSuccessfulAgentReceipt(error, receipt);
  }
}
