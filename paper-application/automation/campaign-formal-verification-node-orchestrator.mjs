import {
  buildCampaignAgentExecutionRequest,
  buildFormalProofRepairRequest,
  bindFormalProofSearchCandidateRequest,
} from './campaign-agent-policy.mjs';
import {
  requireVerifiedAgentReceipt,
  runNestedAgent,
} from './campaign-agent-execution-boundary.mjs';
import {
  createFormalProofSearchAttemptReceipt,
  createFormalProofSearchFailureCertificate,
  createFormalProofSearchPlan,
  createTypedTheoremObligationBundle,
} from '../../paper-domain/research/typed-theorem-proof-search-contract.mjs';
import {
  createTypedTheoremDependencyGraph,
} from '../../paper-domain/research/typed-theorem-dependency-graph.mjs';

function syntheticFormalNode(node, kind, iteration) {
  const suffix = `${kind}:${iteration}`;
  return Object.freeze({
    ...node,
    persistedNodeId: node.persistedNodeId || node.nodeId,
    nodeId: `${node.nodeId}:${suffix}`,
    attemptId: `${node.attemptId || 'direct'}:${suffix}`,
    kind,
    role: kind,
    dependencies: [],
  });
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
      claimBindings: (receipt.result?.claimBindingReport?.bindings || []).map((binding) => ({
        claimId: binding.claimId || null,
        theoremName: binding.theoremName || null,
        axioms: binding.axioms || [],
        issues: binding.issues || [],
      })),
    })),
  });
}

function blockedFormalResult(result, failureCertificate = null) {
  const error = new Error(`campaign_formal_verification_blocked:${(result?.blockers || []).join(',') || 'result_invalid'}`);
  error.retryable = false;
  error.receipt = failureCertificate || result || null;
  return error;
}

function proofSearchEvidenceMatches(result, {
  typedTheoremObligationBundle,
  formalProofSearchPlan,
  candidate,
  attemptCount,
  operationReceipt,
  dependencyGraph,
  dependencyGraphOperationReceipt,
} = {}) {
  return result?.typedTheoremObligationBundleHash
      === typedTheoremObligationBundle.typedTheoremObligationBundleHash
    && result?.formalProofSearchPlanHash === formalProofSearchPlan.formalProofSearchPlanHash
    && result?.formalProofSearchCandidateId === candidate.candidateId
    && (dependencyGraph?.nodeCount > 1
      || result?.formalProofSearchOperationReceiptHash
        === operationReceipt?.formalProofSearchOperationReceiptHash)
    && (dependencyGraph?.nodeCount <= 1
      || (result?.typedTheoremDependencyGraphHash
          === dependencyGraph?.typedTheoremDependencyGraphHash
        && result?.formalTheoremDependencyGraphOperationReceiptHash
          === dependencyGraphOperationReceipt
            ?.formalTheoremDependencyGraphOperationReceiptHash))
    && Array.isArray(result?.formalProofSearchAttempts)
    && result.formalProofSearchAttempts.length === attemptCount;
}

function operationReceiptHash(receipt) {
  return receipt?.formalProofSearchOperationReceiptHash
    || receipt?.formalTheoremDependencyGraphOperationReceiptHash
    || null;
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
  const typedTheoremObligationBundle = createTypedTheoremObligationBundle(
    theoremSpecification,
  );
  const formalProofSearchPlan = createFormalProofSearchPlan(
    typedTheoremObligationBundle,
  );
  const typedTheoremDependencyGraph = createTypedTheoremDependencyGraph({
    theoremSpecification,
    bundle: typedTheoremObligationBundle,
  });
  const authorReceipts = [];
  const repairHistory = [];
  const formalProofSearchAttempts = [];
  let authorNode = syntheticFormalNode(node, 'formal-author', 0);
  const initialAuthorRequest = bindFormalProofSearchCandidateRequest({
    request: buildCampaignAgentExecutionRequest({
      campaign,
      node: authorNode,
      workspace,
      manuscript,
      reviews: [],
      executionBudget,
      executionSignal,
    }),
    typedTheoremObligationBundle,
    formalProofSearchPlan,
    candidate: formalProofSearchPlan.candidates[0],
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

  for (let iteration = 0; iteration < formalProofSearchPlan.candidateCount; iteration += 1) {
    const formalPaperTaskKey = campaign.spec?.researchVerificationInput?.paperTask?.taskKey;
    if (formalPaperTaskKey) {
      primitives.agent.finalizeFormalWorkerPlan?.({
        workspace,
        paperId: campaign.paperId,
        taskKey: formalPaperTaskKey,
        theoremSpecification,
      });
    }
    const formalProofSearchCandidate = formalProofSearchPlan.candidates[iteration];
    const multiTheorem = typedTheoremDependencyGraph.nodeCount > 1;
    const formalProofSearchOperationReceipt = multiTheorem ? null
      : await primitives.agent.executeFormalProofSearchOperations({
        theoremSpecification,
        bundle: typedTheoremObligationBundle,
        plan: formalProofSearchPlan,
        candidate: formalProofSearchCandidate,
        workspace,
        signal: executionSignal,
      });
    const formalTheoremDependencyGraphOperationReceipt =
      multiTheorem
        ? await primitives.agent.executeFormalTheoremDependencyGraphOperations?.({
          theoremSpecification,
          bundle: typedTheoremObligationBundle,
          graph: typedTheoremDependencyGraph,
          candidate: formalProofSearchCandidate,
          workspace,
          signal: executionSignal,
        }) : null;
    if (multiTheorem
      && !formalTheoremDependencyGraphOperationReceipt) {
      throw blockedFormalResult({
        blockers: ['formal_theorem_dependency_graph_operations_required'],
      });
    }
    const requiredRefutation = multiTheorem
      ? formalTheoremDependencyGraphOperationReceipt.theoremOperationReceipts?.some((receipt) => (
        receipt.status === 'formal_theorem_dependency_operation_refuted'
          && typedTheoremDependencyGraph.nodes.find((item) => (
            item.claimId === receipt.claimId
          ))?.requiredForRelease === true
      ))
      : formalProofSearchOperationReceipt.status
        === 'formal_proof_search_counterexample_found';
    if (requiredRefutation) {
      throw blockedFormalResult({
        status: 'campaign_formal_verification_refuted',
        blockers: ['formal_proof_search_refuted_by_bounded_witness'],
      }, formalTheoremDependencyGraphOperationReceipt || formalProofSearchOperationReceipt);
    }
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
          typedTheoremObligationBundleHash:
            typedTheoremObligationBundle.typedTheoremObligationBundleHash,
          formalProofSearchPlanHash: formalProofSearchPlan.formalProofSearchPlanHash,
          formalProofSearchCandidate,
          formalProofSearchOperationReceiptHash:
            operationReceiptHash(
              formalProofSearchOperationReceipt
                || formalTheoremDependencyGraphOperationReceipt,
            ),
          typedTheoremDependencyGraphHash:
            typedTheoremDependencyGraph.typedTheoremDependencyGraphHash,
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
        typedTheoremObligationBundle,
        formalProofSearchPlan,
        formalProofSearchCandidate,
        formalProofSearchOperationReceipt,
        typedTheoremDependencyGraph,
        formalTheoremDependencyGraphOperationReceipt,
        formalProofSearchAttempts: Object.freeze([...formalProofSearchAttempts]),
        executionSignal,
      });
      if (result?.status === 'campaign_formal_verification_completed'
        && result?.nativeResearchWorkerExecutionReportHash
        && result?.campaignFormalVerificationReceiptHash
        && proofSearchEvidenceMatches(result, {
          typedTheoremObligationBundle,
          formalProofSearchPlan,
          candidate: formalProofSearchCandidate,
          attemptCount: iteration,
          operationReceipt: formalProofSearchOperationReceipt,
          dependencyGraph: typedTheoremDependencyGraph,
          dependencyGraphOperationReceipt: formalTheoremDependencyGraphOperationReceipt,
        })) return result;
    }
    const reportedBlockers = [
      ...(result?.blockers || []),
      ...(!result && formalReviewEnvelope.blockers ? formalReviewEnvelope.blockers : []),
    ];
    const candidateBlockers = Object.freeze(reportedBlockers.length
      ? reportedBlockers
      : ['formal_proof_search_candidate_evidence_invalid']);
    const proofSearchAttempt = createFormalProofSearchAttemptReceipt({
      plan: formalProofSearchPlan,
      candidate: formalProofSearchCandidate,
      authorAgentReceiptHash: currentAuthorReceipt.agentExecutionReceiptHash,
      reviewAgentReceiptHash: reviewReceipt.agentExecutionReceiptHash,
      formalReviewEnvelopeHash:
        formalReviewEnvelope.formalSemanticReviewEnvelopeHash,
      campaignFormalVerificationReceiptHash:
        result?.campaignFormalVerificationReceiptHash || null,
      formalProofSearchOperationReceipt:
        formalProofSearchOperationReceipt || formalTheoremDependencyGraphOperationReceipt,
      blockers: candidateBlockers,
    });
    formalProofSearchAttempts.push(proofSearchAttempt);
    if (iteration >= formalProofSearchPlan.candidateCount - 1) {
      const blockedResult = result || {
        status: 'campaign_formal_verification_blocked',
        blockers: formalReviewEnvelope.blockers || ['formal_semantic_review_envelope_invalid'],
        formalReviewEnvelope,
      };
      throw blockedFormalResult(
        blockedResult,
        createFormalProofSearchFailureCertificate({
          plan: formalProofSearchPlan,
          attempts: formalProofSearchAttempts,
        }),
      );
    }
    repairHistory.push(Object.freeze({
      iteration,
      authorAgentReceiptHash: currentAuthorReceipt.agentExecutionReceiptHash,
      reviewAgentReceiptHash: reviewReceipt.agentExecutionReceiptHash,
      formalReviewEnvelopeHash: formalReviewEnvelope.formalSemanticReviewEnvelopeHash || null,
      formalVerificationReceiptHash: result?.campaignFormalVerificationReceiptHash || null,
      formalProofSearchOperationReceiptHash:
        operationReceiptHash(
          formalProofSearchOperationReceipt || formalTheoremDependencyGraphOperationReceipt,
        ),
      blockers: Object.freeze([...(result?.blockers || formalReviewEnvelope.blockers || [])]),
    }));
    const repairIteration = iteration + 1;
    authorNode = syntheticFormalNode(node, 'formal-proof-repair', repairIteration);
    const repairRequest = bindFormalProofSearchCandidateRequest({
      request: buildFormalProofRepairRequest({
        campaign,
        workspace,
        manuscript,
        diagnostics: formalDiagnostics(result, formalReviewEnvelope),
        iteration: repairIteration,
        remainingTokenCount: Number(executionBudget.remainingTokenCount || 4096),
        signal: executionSignal,
      }),
      typedTheoremObligationBundle,
      formalProofSearchPlan,
      candidate: formalProofSearchPlan.candidates[repairIteration],
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
