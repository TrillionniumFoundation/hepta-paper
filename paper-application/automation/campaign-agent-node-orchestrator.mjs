import {
  buildCampaignAgentExecutionRequest,
  buildFormalProofRepairRequest,
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
import { verifyAgentExecutionReceipt } from '../../paper-domain/evidence/agent-execution-receipt-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { assertOutcomeBoundManuscriptMutationAllowed } from './campaign-confirmatory-lineage-policy.mjs';

const MAX_FORMAL_PROOF_REPAIR_ITERATIONS = 2;

function completedEmpiricalOutcome(campaignNodes) {
  return (campaignNodes || []).some((candidate) => {
    const classification = campaignEmpiricalNodeClassification(candidate?.kind);
    return candidate?.status === 'completed'
      && (classification.primary || classification.reproduction || classification.revalidate);
  });
}

function requireVerifiedAgentReceipt(receipt, label) {
  if (!verifyAgentExecutionReceipt(receipt)) {
    const error = new Error(`${label}_agent_execution_receipt_invalid`);
    error.retryable = false;
    error.receipt = receipt || null;
    throw error;
  }
  return receipt;
}

function syntheticFormalNode(node, kind, iteration) {
  const suffix = `${kind}:${iteration}`;
  return Object.freeze({
    ...node,
    nodeId: `${node.nodeId}:${suffix}`,
    attemptId: `${node.attemptId || 'direct'}:${suffix}`,
    kind,
    role: kind,
    dependencies: [],
  });
}

async function runNestedAgent({
  primitives,
  executionResources,
  executionBudget,
  executionSignal,
  principal,
  request,
} = {}) {
  const operation = ({
    remainingTokenCount = Number(executionBudget?.remainingTokenCount || 8192),
    signal = executionSignal,
  } = {}) => primitives.agent.execute({
    principal,
    request: {
      ...request,
      outputTokenBudget: Math.min(
        Number(request.outputTokenBudget || remainingTokenCount),
        Number(remainingTokenCount || request.outputTokenBudget || 8192),
      ),
      signal,
    },
  });
  return executionResources?.runNestedAgent
    ? executionResources.runNestedAgent(operation)
    : operation();
}

function formalDiagnostics(result, reviewEnvelope = null) {
  return JSON.stringify({
    reviewBlockers: reviewEnvelope?.blockers || [],
    verificationBlockers: result?.blockers || [],
    workers: (result?.nativeResearchWorkerExecution?.workerReceipts || []).map((receipt) => ({
      workerId: receipt.workerId || null,
      blockers: receipt.blockers || [],
      resultBlockers: receipt.result?.blockers || [],
      status: receipt.result?.status || receipt.status || null,
    })),
  });
}

function blockedResult(result) {
  const error = new Error(`campaign_research_verification_blocked:${(result?.researchPromotionBlockers || []).join(',') || 'result_invalid'}`);
  error.retryable = false;
  error.receipt = result || null;
  return error;
}

function blockedFormalResult(result) {
  const error = new Error(`campaign_formal_verification_blocked:${(result?.blockers || []).join(',') || 'result_invalid'}`);
  error.retryable = false;
  error.receipt = result || null;
  return error;
}

export async function executeCampaignFormalVerificationNode({
  primitives,
  campaign,
  node,
  context,
  workspace,
  manuscript,
  executionBudget = {},
  executionSignal,
  executionResources = null,
} = {}) {
  const theoremSpecification = primitives.workspace.readTheoremSpecification({
    workspace,
    manuscriptPath: manuscript,
    paperId: campaign.paperId,
    campaignId: campaign.campaignId,
    scientificClaimAuthority: campaign.spec.scientificClaimAuthority || null,
    approvedProposalSeed: campaign.spec.approvedProposalSeed || null,
  });
  const authorReceipts = [];
  const repairHistory = [];
  let authorNode = syntheticFormalNode(node, 'formal-author', 0);
  const initialAuthorRequest = buildCampaignAgentExecutionRequest({
    campaign,
    node: authorNode,
    workspace,
    manuscript,
    reviews: [],
    executionBudget,
    executionSignal,
  });
  const initialAuthorReceipt = requireVerifiedAgentReceipt(await runNestedAgent({
    primitives,
    executionResources,
    executionBudget,
    executionSignal,
    principal: 'default',
    request: {
      ...initialAuthorRequest,
      context: {
        ...initialAuthorRequest.context,
        theoremSpecificationHash: theoremSpecification.theoremSpecificationHash,
      },
    },
  }), 'formal_author');
  authorReceipts.push(initialAuthorReceipt);
  let currentAuthorReceipt = initialAuthorReceipt;

  for (let iteration = 0; iteration <= MAX_FORMAL_PROOF_REPAIR_ITERATIONS; iteration += 1) {
    const reviewNode = syntheticFormalNode(node, 'formal-review', iteration);
    const reviewRequest = buildCampaignAgentExecutionRequest({
      campaign,
      node: reviewNode,
      workspace,
      manuscript,
      reviews: [],
      executionBudget,
      executionSignal,
    });
    const reviewReceipt = requireVerifiedAgentReceipt(await runNestedAgent({
      primitives,
      executionResources,
      executionBudget,
      executionSignal,
      principal: 'formal-review',
      request: {
        ...reviewRequest,
        context: {
          ...reviewRequest.context,
          theoremSpecificationHash: theoremSpecification.theoremSpecificationHash,
          formalAuthorAgentReceiptHash: currentAuthorReceipt.agentExecutionReceiptHash,
          formalVerificationIteration: iteration,
        },
      },
    }), 'formal_review');
    const formalReviewEnvelope = primitives.agent.buildFormalReviewEnvelope({
      campaign,
      node: reviewNode,
      authorNode: { ...authorNode, result: currentAuthorReceipt },
      receipt: reviewReceipt,
      workspace,
      manuscript,
    });
    let result = null;
    if (formalReviewEnvelope.status === 'formal_semantic_review_envelope_verified') {
      result = await primitives.release.verifyFormal({
        campaign,
        node,
        campaignNodes: context.campaignNodes,
        workspace,
        manuscript,
        theoremSpecification,
        formalAuthorReceipts: Object.freeze([...authorReceipts]),
        formalReviewAgentReceipt: reviewReceipt,
        formalReviewEnvelope,
        formalVerificationIteration: iteration,
        formalRepairHistory: Object.freeze([...repairHistory]),
        executionSignal,
      });
      if (result?.status === 'campaign_formal_verification_completed'
        && result?.nativeResearchWorkerExecutionReportHash
        && result?.campaignFormalVerificationReceiptHash) return result;
    }
    if (iteration >= MAX_FORMAL_PROOF_REPAIR_ITERATIONS) {
      throw blockedFormalResult(result || {
        status: 'campaign_formal_verification_blocked',
        blockers: formalReviewEnvelope.blockers || ['formal_semantic_review_envelope_invalid'],
        formalReviewEnvelope,
      });
    }
    repairHistory.push(Object.freeze({
      iteration,
      authorAgentReceiptHash: currentAuthorReceipt.agentExecutionReceiptHash,
      reviewAgentReceiptHash: reviewReceipt.agentExecutionReceiptHash,
      formalReviewEnvelopeHash: formalReviewEnvelope.formalSemanticReviewEnvelopeHash || null,
      formalVerificationReceiptHash: result?.campaignFormalVerificationReceiptHash || null,
      blockers: Object.freeze([...(result?.blockers || formalReviewEnvelope.blockers || [])]),
    }));
    const repairIteration = iteration + 1;
    authorNode = syntheticFormalNode(node, 'formal-proof-repair', repairIteration);
    const repairRequest = buildFormalProofRepairRequest({
      campaign,
      workspace,
      manuscript,
      diagnostics: formalDiagnostics(result, formalReviewEnvelope),
      iteration: repairIteration,
      remainingTokenCount: Number(executionBudget.remainingTokenCount || 4096),
      signal: executionSignal,
    });
    const repairReceipt = requireVerifiedAgentReceipt(await runNestedAgent({
      primitives,
      executionResources,
      executionBudget,
      executionSignal,
      principal: 'default',
      request: {
        ...repairRequest,
        context: {
          ...repairRequest.context,
          theoremSpecificationHash: theoremSpecification.theoremSpecificationHash,
          formalVerificationIteration: repairIteration,
        },
      },
    }), 'formal_proof_repair');
    authorReceipts.push(repairReceipt);
    currentAuthorReceipt = repairReceipt;
  }
  throw blockedFormalResult({ blockers: ['formal_candidate_iteration_invariant_failed'] });
}

export async function executeCampaignResearchVerificationNode({
  primitives,
  campaign,
  node,
  context,
  workspace,
  manuscript,
  executionSignal,
} = {}) {
  const result = await primitives.release.verifyResearch({
    campaign,
    node,
    campaignNodes: context.campaignNodes,
    workspace,
    manuscript,
    formalVerificationReceipt: context.formalVerificationNode?.result || null,
    executionSignal,
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
    assertOutcomeBoundManuscriptMutationAllowed({ changedPaths: receipt.changedPaths, manuscript });
  }
  if (['manuscript-integrate', 'revise'].includes(node.kind)
    && campaign.spec.scientificClaimAuthority?.claimAuthorityType === 'machine-policy-authorized') {
    const renderReceipt = primitives.workspace.renderTrustedAutonomousManuscript({
      workspace,
      manuscriptPath: manuscript,
      paperId: campaign.paperId,
      campaignId: campaign.campaignId,
      authority: empiricalAssertionAuthority,
    });
    const changedPaths = Object.freeze([...new Set([
      ...(receipt.changedPaths || []),
      manuscript,
      ...(renderReceipt.presentationArtifacts || []).map((artifact) => artifact.path),
    ])].sort());
    const payload = {
      version: 1,
      kind: 'CampaignTrustedAutonomousManuscriptResult',
      status: 'campaign_trusted_autonomous_manuscript_completed',
      agentExecutionReceiptHash: receipt.agentExecutionReceiptHash,
      agentExecutionReceipt: receipt,
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
  }
  if (proposalSeedVerification) {
    requireVerifiedAgentReceipt(receipt, 'formal_proposal_writer');
    verifyFormalProposalWriterSurface({ primitives, campaign, workspace, manuscript });
  }
  if (node.kind === 'theorem-spec') {
    requireVerifiedAgentReceipt(receipt, 'theorem_specification');
    if (JSON.stringify(receipt.changedPaths || []) !== JSON.stringify(['THEOREM_SPEC_DRAFT.json'])) {
      const error = new Error('theorem_specification_agent_changed_paths_invalid');
      error.retryable = false;
      error.receipt = receipt;
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
  }
  if (node.kind === 'formal-review') {
    return primitives.agent.buildFormalReviewEnvelope({
      campaign,
      node,
      authorNode: context.formalAuthorNode,
      receipt,
      workspace,
      manuscript,
    });
  }
  if (!isCampaignRefereeNode(node.kind)) return receipt;
  const parsed = receipt.structuredOutput || extractCampaignAgentJson(receipt.finalOutput) || {};
  return Object.freeze({
    reviewerId: node.spec?.role || node.role || node.kind,
    role: node.spec?.role || node.role || node.kind,
    verdict: parsed.verdict === 'accept' ? 'accept' : 'revise',
    score: Number(parsed.score || 0),
    criticalFindingCount: Number(parsed.criticalFindingCount || 0),
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    summary: parsed.summary || receipt.finalOutput.slice(-1000),
    reviewHash: receipt.agentExecutionReceiptHash,
    reviewPrincipalId: receipt.principalId || receipt.agentId || null,
    reviewAttemptId: node.attemptId || null,
    manuscriptHash: primitives.workspace.hashFile({ workspace, relative: manuscript }),
    childSessionId: receipt.sessionId || receipt.sessionKey || null,
    sessionKey: receipt.sessionKey || null,
    openClawRunId: receipt.openClawRunId || null,
    usage: receipt.usage || null,
    promptHash: receipt.promptHash || null,
    resolvedModel: receipt.resolvedModel || receipt.model || null,
    selectedExecutorId: receipt.selectedExecutorId || receipt.executorId || null,
  });
}
