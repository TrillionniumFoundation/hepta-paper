import {
  runNativeResearchWorkers,
  verifyNativeResearchWorkerExecutionReport,
} from '../research-verify/worker-runtime.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  proposalLineageReviewBlockers,
  validCampaignFormalAgentReceipt,
  verifyTheoremSpecificationNodeResult,
} from './campaign-formal-verification-evidence.mjs';
import {
  createFormalProofSearchPlan,
  createTypedTheoremObligationBundle,
  verifyFormalProofSearchAttempts,
  verifyFormalProofSearchPlan,
  verifyTypedTheoremObligationBundle,
} from '../../paper-domain/research/typed-theorem-proof-search-contract.mjs';
import {
  verifyFormalProofSearchOperationReceipt,
} from '../research-verify/formal-proof-search-operations-executor.mjs';
import {
  createTypedTheoremDependencyGraph,
  verifyTypedTheoremDependencyGraph,
} from '../../paper-domain/research/typed-theorem-dependency-graph.mjs';
import {
  verifyFormalTheoremDependencyGraphOperationReceipt,
} from '../research-verify/formal-theorem-dependency-graph-operations-executor.mjs';
import {
  buildFormalTheoremDependencyReadableProofBundle,
} from '../research-verify/formal-theorem-dependency-readable-proof.mjs';

export async function runFencedFormalNativeResearchWorkers({
  assertExternalSideEffectReady = null,
  campaignId,
  paperId,
  nodeId,
  attemptId,
  runWorkers = runNativeResearchWorkers,
  workerInput,
} = {}) {
  const request = Object.freeze({
    action: 'campaign_formal_native_worker_execute',
    campaignId,
    paperId,
    nodeId,
    attemptId,
    theoremSpecificationHash:
      workerInput?.theoremSpecification?.theoremSpecificationHash || null,
    formalReviewEnvelopeHash:
      workerInput?.formalReviewEnvelope?.formalReviewEnvelopeHash || null,
    paperTaskKey: workerInput?.paperTask?.taskKey || null,
    workerTypes: workerInput?.workerTypes || [],
    dynamicFormalExecutionAuthorityHash:
      workerInput?.dynamicFormalExecutionAuthority
        ?.dynamicFormalExecutionAuthorityHash || null,
  });
  if (assertExternalSideEffectReady?.run) {
    return assertExternalSideEffectReady.run(
      request,
      ({ externalActionId }) => runWorkers({
        ...workerInput,
        externalActionId,
        idempotencyKey: externalActionId,
      }),
    );
  }
  if (assertExternalSideEffectReady) {
    await assertExternalSideEffectReady(request);
    assertExternalSideEffectReady.assertCurrent?.(request);
    await assertExternalSideEffectReady.markStarted?.(request);
  }
  return runWorkers(workerInput);
}

export async function verifyCampaignFormalResearch({
  campaign,
  input,
  paperTask,
  workspace,
  runtimeRoot,
  authoritativeResearchNode,
  authoritativeTheoremSpecification,
  theoremSpecificationDependencyNodes,
  campaignEvidenceContext,
  campaignResearchSourceSnapshot,
  theoremSpecification,
  formalAuthorReceipts,
  formalReviewAgentReceipt,
  formalVerificationIteration,
  formalRepairHistory,
  typedTheoremObligationBundle,
  formalProofSearchPlan,
  formalProofSearchCandidate,
  formalProofSearchOperationReceipt,
  typedTheoremDependencyGraph,
  formalTheoremDependencyGraphOperationReceipt,
  formalProofSearchAttempts,
  formalReviewEnvelope,
  nativeResearchWorkerJobReceiptStore,
  artifactRepositoryFactory,
  trustedFormalSandboxRuntime,
  dynamicFormalExecutionAuthority = null,
  dynamicFormalExecutionEnvironment = process.env,
  assertExternalSideEffectReady,
  executionSignal,
} = {}) {
  const specificationNode = theoremSpecificationDependencyNodes.length === 1
    ? theoremSpecificationDependencyNodes[0]
    : null;
  const candidateAuthorReceipts = Array.isArray(formalAuthorReceipts)
    ? formalAuthorReceipts : [];
  const candidateRepairHistory = Array.isArray(formalRepairHistory)
    ? formalRepairHistory : [];
  let expectedTypedObligationBundle = null;
  let expectedProofSearchPlan = null;
  let expectedTheoremDependencyGraph = null;
  try {
    expectedTypedObligationBundle = createTypedTheoremObligationBundle(
      authoritativeTheoremSpecification,
    );
    expectedProofSearchPlan = createFormalProofSearchPlan(expectedTypedObligationBundle);
    expectedTheoremDependencyGraph = createTypedTheoremDependencyGraph({
      theoremSpecification: authoritativeTheoremSpecification,
      bundle: expectedTypedObligationBundle,
    });
  } catch { /* recorded below as a fail-closed blocker */ }
  const obligationVerification = verifyTypedTheoremObligationBundle(
    typedTheoremObligationBundle,
    { theoremSpecification: authoritativeTheoremSpecification },
  );
  const proofSearchPlanVerification = verifyFormalProofSearchPlan(
    formalProofSearchPlan,
    { bundle: expectedTypedObligationBundle },
  );
  const proofSearchAttemptVerification = verifyFormalProofSearchAttempts(
    formalProofSearchAttempts,
    { plan: expectedProofSearchPlan, expectedCount: formalVerificationIteration },
  );
  const expectedProofSearchCandidate = expectedProofSearchPlan
    ?.candidates?.[formalVerificationIteration] || null;
  const semanticReviewOnlyAllowed = Boolean(expectedTypedObligationBundle?.obligations?.length)
    && expectedTypedObligationBundle.obligations.every((obligation) => (
      obligation.typedTheoremDsl?.machineSearchEligible !== true
    ));
  const dynamicFormalRequired = expectedTypedObligationBundle?.obligations?.some((obligation) => (
    obligation.typedTheoremDsl?.allowedImports?.some((moduleName) => (
      moduleName === 'Mathlib' || moduleName.startsWith('Mathlib.')
    )) === true
  )) === true;
  const multiTheorem = expectedTheoremDependencyGraph?.nodeCount > 1;
  const operationVerification = multiTheorem
    ? Object.freeze({ valid: true, blockers: Object.freeze([]) })
    : verifyFormalProofSearchOperationReceipt(
      formalProofSearchOperationReceipt,
      {
        bundle: expectedTypedObligationBundle,
        plan: expectedProofSearchPlan,
        candidate: expectedProofSearchCandidate,
        allowSemanticReviewOnly: semanticReviewOnlyAllowed,
        expectedDynamicFormalExecutionAuthority: dynamicFormalExecutionAuthority,
      },
    );
  const dependencyGraphVerification = verifyTypedTheoremDependencyGraph(
    typedTheoremDependencyGraph,
    {
      theoremSpecification: authoritativeTheoremSpecification,
      bundle: expectedTypedObligationBundle,
    },
  );
  const dependencyGraphOperationVerification = multiTheorem
    ? verifyFormalTheoremDependencyGraphOperationReceipt(
      formalTheoremDependencyGraphOperationReceipt,
      {
        graph: expectedTheoremDependencyGraph,
        candidate: expectedProofSearchCandidate,
        expectedDynamicFormalExecutionAuthority: dynamicFormalExecutionAuthority,
      },
    ) : Object.freeze({ valid: true, blockers: Object.freeze([]) });
  const previousOperationBlockers = (Array.isArray(formalProofSearchAttempts)
    ? formalProofSearchAttempts : []).flatMap((attempt, index) => {
    const verification = multiTheorem
      ? verifyFormalTheoremDependencyGraphOperationReceipt(
        attempt?.formalProofSearchOperationReceipt,
        {
          graph: expectedTheoremDependencyGraph,
          candidate: expectedProofSearchPlan?.candidates?.[index],
          expectedDynamicFormalExecutionAuthority: dynamicFormalExecutionAuthority,
        },
      )
      : verifyFormalProofSearchOperationReceipt(attempt?.formalProofSearchOperationReceipt, {
        bundle: expectedTypedObligationBundle,
        plan: expectedProofSearchPlan,
        candidate: expectedProofSearchPlan?.candidates?.[index],
        allowSemanticReviewOnly: semanticReviewOnlyAllowed,
        expectedDynamicFormalExecutionAuthority: dynamicFormalExecutionAuthority,
      });
    return verification.blockers.map((blocker) => `attempt_${index}:${blocker}`);
  });
  const candidateEvidenceBlockers = [
    ...(theoremSpecification?.theoremSpecificationHash
      === authoritativeTheoremSpecification?.theoremSpecificationHash
      ? [] : ['campaign_formal_candidate_theorem_specification_mismatch']),
    ...verifyTheoremSpecificationNodeResult(
      specificationNode,
      authoritativeTheoremSpecification,
    ),
    ...(!Number.isSafeInteger(formalVerificationIteration)
      || formalVerificationIteration < 0
      || formalVerificationIteration >= Number(expectedProofSearchPlan?.candidateCount || 0)
      ? ['campaign_formal_candidate_iteration_invalid'] : []),
    ...(!Array.isArray(formalAuthorReceipts)
      || candidateAuthorReceipts.length !== formalVerificationIteration + 1
      || candidateAuthorReceipts.some((receipt) => !validCampaignFormalAgentReceipt(receipt))
      ? ['campaign_formal_candidate_author_receipts_invalid'] : []),
    ...(!validCampaignFormalAgentReceipt(formalReviewAgentReceipt)
      ? ['campaign_formal_candidate_review_agent_receipt_invalid'] : []),
    ...(formalReviewEnvelope?.theoremSpecificationHash
      !== authoritativeTheoremSpecification?.theoremSpecificationHash
      ? ['campaign_formal_candidate_review_specification_mismatch'] : []),
    ...(formalReviewEnvelope?.authorAgentReceiptHash
      !== candidateAuthorReceipts.at(-1)?.agentExecutionReceiptHash
      ? ['campaign_formal_candidate_review_author_mismatch'] : []),
    ...(formalReviewEnvelope?.reviewAgentReceiptHash
      !== formalReviewAgentReceipt?.agentExecutionReceiptHash
      ? ['campaign_formal_candidate_review_receipt_mismatch'] : []),
    ...proposalLineageReviewBlockers(
      authoritativeTheoremSpecification,
      formalReviewEnvelope,
    ),
    ...(!Array.isArray(formalRepairHistory)
      || candidateRepairHistory.length !== formalVerificationIteration
      || candidateRepairHistory.some((entry, index) => entry?.iteration !== index
        || entry?.authorAgentReceiptHash
          !== candidateAuthorReceipts[index]?.agentExecutionReceiptHash
        || !entry?.reviewAgentReceiptHash || !entry?.formalReviewEnvelopeHash)
      ? ['campaign_formal_candidate_repair_history_invalid'] : []),
    ...obligationVerification.blockers.map((blocker) => (
      `campaign_formal_typed_obligation:${blocker}`
    )),
    ...proofSearchPlanVerification.blockers.map((blocker) => (
      `campaign_formal_proof_search_plan:${blocker}`
    )),
    ...proofSearchAttemptVerification.blockers.map((blocker) => (
      `campaign_formal_proof_search_attempt:${blocker}`
    )),
    ...operationVerification.blockers.map((blocker) => (
      `campaign_formal_proof_search_operation:${blocker}`
    )),
    ...dependencyGraphVerification.blockers.map((blocker) => (
      `campaign_formal_theorem_dependency_graph:${blocker}`
    )),
    ...dependencyGraphOperationVerification.blockers.map((blocker) => (
      `campaign_formal_theorem_dependency_graph_operation:${blocker}`
    )),
    ...previousOperationBlockers.map((blocker) => (
      `campaign_formal_proof_search_operation:${blocker}`
    )),
    ...(!expectedTypedObligationBundle || !expectedProofSearchPlan
      ? ['campaign_formal_proof_search_authority_rebuild_failed'] : []),
    ...(dynamicFormalRequired && !dynamicFormalExecutionAuthority
      ? ['campaign_formal_dynamic_execution_authority_missing'] : []),
    ...(JSON.stringify(formalProofSearchCandidate)
      !== JSON.stringify(expectedProofSearchCandidate)
      ? ['campaign_formal_proof_search_candidate_invalid'] : []),
    ...((Array.isArray(formalProofSearchAttempts) ? formalProofSearchAttempts : [])
      .some((attempt, index) => (
        attempt?.authorAgentReceiptHash
          !== candidateAuthorReceipts[index]?.agentExecutionReceiptHash
        || attempt?.reviewAgentReceiptHash
          !== candidateRepairHistory[index]?.reviewAgentReceiptHash
        || attempt?.formalReviewEnvelopeHash
          !== candidateRepairHistory[index]?.formalReviewEnvelopeHash
      )) ? ['campaign_formal_proof_search_attempt_lineage_invalid'] : []),
  ];
  const formalCampaignEvidenceContext = Object.freeze({
    ...campaignEvidenceContext,
    verificationIteration: formalVerificationIteration,
  });
  const nativeResearchWorkerExecution = await runFencedFormalNativeResearchWorkers({
    assertExternalSideEffectReady,
    campaignId: campaign.campaignId,
    paperId: campaign.paperId,
    nodeId: authoritativeResearchNode.nodeId,
    attemptId: authoritativeResearchNode.attemptId,
    workerInput: {
      root: workspace,
      sourceRoot: workspace,
      runtimeRoot,
      paperTask,
      execute: true,
      jobReceiptStore: nativeResearchWorkerJobReceiptStore,
      artifactRepositoryFactory,
      formalReviewEnvelope,
      theoremSpecification: authoritativeTheoremSpecification,
      campaignEvidenceContext: formalCampaignEvidenceContext,
      workerTypes: ['formal_verifier_lake'],
      trustedFormalSandboxRuntime,
      dynamicFormalExecutionAuthority: dynamicFormalRequired
        ? dynamicFormalExecutionAuthority : null,
      dynamicFormalExecutionEnvironment,
    },
  });
  const workerVerification = verifyNativeResearchWorkerExecutionReport(
    nativeResearchWorkerExecution,
    {
      paperId: paperTask.paperId,
      taskKey: paperTask.taskKey,
      requireFormalWorkers: true,
      theoremSpecificationHash:
        authoritativeTheoremSpecification.theoremSpecificationHash,
      dynamicFormalExecutionAuthorityHash: dynamicFormalRequired
        ? dynamicFormalExecutionAuthority?.dynamicFormalExecutionAuthorityHash || null
        : null,
    },
  );
  const theoremDependencyReadableProofBundles = Object.freeze(
    nativeResearchWorkerExecution.workerReceipts.map((receipt) => (
      receipt.result?.readableProofExplanationBundle
        ? buildFormalTheoremDependencyReadableProofBundle({
          graph: expectedTheoremDependencyGraph,
          readableProofBundle: receipt.result.readableProofExplanationBundle,
        }) : null
    )).filter(Boolean),
  );
  if (executionSignal?.aborted) {
    throw new Error('campaign_research_verification_cancelled');
  }
  const blockers = [
    ...candidateEvidenceBlockers,
    ...workerVerification.blockers,
    ...(expectedTheoremDependencyGraph?.nodeCount > 1
      && (!theoremDependencyReadableProofBundles.length
        || theoremDependencyReadableProofBundles.some((item) => (
          item.status !== 'formal_theorem_dependency_readable_proof_verified'
        )))
      ? ['campaign_formal_theorem_dependency_readable_proof_invalid'] : []),
  ];
  const authorAgentReceiptHashes = candidateAuthorReceipts
    .map((receipt) => receipt.agentExecutionReceiptHash);
  const payload = {
    version: 1,
    kind: 'CampaignFormalVerificationReceipt',
    status: blockers.length
      ? 'campaign_formal_verification_blocked'
      : 'campaign_formal_verification_completed',
    campaignId: campaign.campaignId,
    paperId: campaign.paperId,
    campaignResearchVerificationInputHash: input.campaignResearchVerificationInputHash,
    formalNodeId: campaignResearchSourceSnapshot.researchNodeId,
    formalAttemptId: campaignResearchSourceSnapshot.researchAttemptId,
    formalLeaseGeneration: campaignResearchSourceSnapshot.researchLeaseGeneration,
    theoremSpecificationNodeId: specificationNode?.nodeId || null,
    theoremSpecificationAttemptId: specificationNode?.attemptId || null,
    theoremSpecificationLeaseGeneration: specificationNode?.leaseGeneration || null,
    theoremSpecificationNodeResultHash: specificationNode?.resultSha256 || null,
    theoremSpecificationFinalizationReceiptHash:
      specificationNode?.result?.theoremSpecificationFinalizationReceiptHash || null,
    theoremSpecificationHash: authoritativeTheoremSpecification.theoremSpecificationHash,
    theoremSpecificationClaimHashes: Object.freeze(authoritativeTheoremSpecification.claims
      .map((claim) => claim.theoremSpecificationClaimHash)),
    formalVerificationIteration,
    formalRepairCount: formalVerificationIteration,
    formalRepairHistory: Object.freeze(candidateRepairHistory
      .map((entry) => Object.freeze({ ...entry }))),
    typedTheoremObligationBundleHash:
      expectedTypedObligationBundle?.typedTheoremObligationBundleHash || null,
    typedTheoremObligationBundle: expectedTypedObligationBundle,
    typedTheoremDependencyGraphHash:
      expectedTheoremDependencyGraph?.typedTheoremDependencyGraphHash || null,
    typedTheoremDependencyGraph: expectedTheoremDependencyGraph,
    formalProofSearchPlanHash: expectedProofSearchPlan?.formalProofSearchPlanHash || null,
    formalProofSearchPlan: expectedProofSearchPlan,
    formalProofSearchCandidateId: expectedProofSearchCandidate?.candidateId || null,
    formalProofSearchOperationReceiptHash:
      formalProofSearchOperationReceipt?.formalProofSearchOperationReceiptHash || null,
    formalProofSearchOperationReceipt,
    formalTheoremDependencyGraphOperationReceiptHash:
      formalTheoremDependencyGraphOperationReceipt
        ?.formalTheoremDependencyGraphOperationReceiptHash || null,
    formalTheoremDependencyGraphOperationReceipt,
    formalProofSearchAttempts: Object.freeze([
      ...(Array.isArray(formalProofSearchAttempts) ? formalProofSearchAttempts : []),
    ]),
    formalAuthorAgentReceiptHash: authorAgentReceiptHashes.at(-1) || null,
    formalAuthorAgentReceiptHashes: Object.freeze(authorAgentReceiptHashes),
    formalAuthorAgentReceipts: Object.freeze([...candidateAuthorReceipts]),
    formalReviewAgentReceiptHash:
      formalReviewAgentReceipt?.agentExecutionReceiptHash || null,
    formalReviewAgentReceipt,
    formalReviewEnvelopeHash:
      formalReviewEnvelope?.formalSemanticReviewEnvelopeHash || null,
    formalReviewEnvelope,
    proposalClaimToTheoremBindingHash:
      formalReviewEnvelope?.proposalClaimToTheoremBindingHash || null,
    proposalClaimToTheoremBinding:
      formalReviewEnvelope?.proposalClaimToTheoremBinding || null,
    formalClaimUniverseHash: authoritativeTheoremSpecification.formalClaimUniverseHash,
    canonicalClaimRegistryHash: formalReviewEnvelope?.canonicalClaimRegistryHash || null,
    nativeResearchWorkerExecutionReportHash:
      nativeResearchWorkerExecution.nativeResearchWorkerExecutionReportHash,
    dynamicFormalExecutionAuthority: dynamicFormalRequired
      ? dynamicFormalExecutionAuthority : null,
    formalWorkerReceiptHashes: Object.freeze(nativeResearchWorkerExecution.workerReceipts
      .map((receipt) => receipt.nativeResearchWorkerExecutionReceiptHash)
      .filter(Boolean)),
    formalReplayReceiptHashes: Object.freeze(nativeResearchWorkerExecution.workerReceipts
      .map((receipt) => receipt.result?.formalCertificateReplayReceiptHash)
      .filter(Boolean)),
    formalReadableProofExplanationBundleHashes: Object.freeze(
      nativeResearchWorkerExecution.workerReceipts
        .map((receipt) => receipt.result?.formalReadableProofExplanationBundleHash)
        .filter(Boolean),
    ),
    productionReadableProofExplanationReady:
      nativeResearchWorkerExecution.workerReceipts.length > 0
      && nativeResearchWorkerExecution.workerReceipts.every((receipt) => (
        receipt.result?.productionReadableProofExplanationReady === true
      )),
    formalTheoremDependencyReadableProofBundleHashes: Object.freeze(
      theoremDependencyReadableProofBundles.map((item) => (
        item.formalTheoremDependencyReadableProofBundleHash
      )),
    ),
    formalTheoremDependencyReadableProofBundles:
      theoremDependencyReadableProofBundles,
    verifiedSourceMerkleHash: campaignResearchSourceSnapshot.verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash:
      campaignResearchSourceSnapshot.verifiedSourceWorkspaceManifestHash,
    campaignFormalSourceSnapshotHash:
      campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash,
    campaignFormalSourceSnapshot: campaignResearchSourceSnapshot,
    nativeResearchWorkerExecution,
    blockers: Object.freeze(blockers),
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    campaignFormalVerificationReceiptHash:
      hashRecord('CampaignFormalVerificationReceipt', payload),
  });
}
