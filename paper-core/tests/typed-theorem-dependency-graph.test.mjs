import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';

import {
  createFormalTheoremDependencyGraphOperationsExecutor,
  verifyFormalTheoremDependencyGraphOperationReceipt,
} from '../../paper-adapters/research-verify/formal-theorem-dependency-graph-operations-executor.mjs';
import {
  executeCampaignFormalVerificationNode,
} from '../../paper-application/automation/campaign-formal-verification-node-orchestrator.mjs';
import {
  buildCampaignResearchVerificationInput,
} from '../../paper-domain/automation/campaign-research-contract.mjs';
import {
  createFormalProofSearchPlan,
  createTypedTheoremObligationBundle,
} from '../../paper-domain/research/typed-theorem-proof-search-contract.mjs';
import {
  createTheoremDependencyGraphExecutionReceipt,
  createTheoremDependencyGraphReplayReceipt,
  createTheoremDependencySearchReceipt,
  createTypedTheoremDependencyGraph,
  verifyTheoremDependencyGraphReplayReceipt,
  verifyTypedTheoremDependencyGraph,
} from '../../paper-domain/research/typed-theorem-dependency-graph.mjs';
import { leanTypeIdentity } from '../../paper-domain/research/lean-type-identity.mjs';
import {
  PRODUCTION_LEAN_RUNTIME_LAYOUTS,
  PRODUCTION_LEAN_TOOLCHAIN,
} from '../../paper-domain/research/formal-verifier-policy.mjs';
import { createTheoremSpecification } from '../../paper-domain/research/theorem-specification.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  trustedProductionLakeOrSkip,
} from './support/trusted-production-lake-preflight.mjs';

const digest = (label) => hashRecord('TypedTheoremDependencyGraphFixture', { label });

function deterministicGraphExecutor({ closeTactics }) {
  let executionOrdinal = 0;
  return createFormalTheoremDependencyGraphOperationsExecutor({
    resolvePinnedRuntime() {
      return Object.freeze({
        status: 'formal_pinned_lake_resolved',
        executable: '/fixture/pinned/lake',
        blockers: Object.freeze([]),
      });
    },
    workerRunnerFactory() {
      return Object.freeze({
        async run() {
          executionOrdinal += 1;
          const ok = closeTactics === true;
          return Object.freeze({
            ok,
            exitCode: ok ? 0 : 1,
            signal: null,
            stdout: ok ? 'closed' : '',
            stderr: ok ? '' : 'open goals',
            blockers: Object.freeze([]),
            runnerId: 'deterministic-formal-graph-runner-v1',
            backend: 'fixture-isolated-process',
            runtimeIdentityHash: digest('runtime'),
            runtimeExecutableSnapshotHash:
              PRODUCTION_LEAN_RUNTIME_LAYOUTS[PRODUCTION_LEAN_TOOLCHAIN]
                .lakeExecutableHash,
            containerImageDigest: null,
            executionProcessIdentityHash: digest(`process:${executionOrdinal}`),
            isolation: Object.freeze({ immutableWorkRootVerified: false }),
          });
        },
      });
    },
  });
}

function rehashGraphOperation(receipt, mutate) {
  const changed = structuredClone(receipt);
  mutate(changed);
  delete changed.formalTheoremDependencyGraphOperationReceiptHash;
  changed.formalTheoremDependencyGraphOperationReceiptHash =
    hashRecord('FormalTheoremDependencyGraphOperationReceipt', changed);
  return changed;
}

function rehashGraphNodeOperation(receipt, index, mutate) {
  const changed = structuredClone(receipt);
  const nodeReceipt = changed.theoremOperationReceipts[index];
  mutate(nodeReceipt);
  delete nodeReceipt.formalTheoremDependencyOperationReceiptHash;
  nodeReceipt.formalTheoremDependencyOperationReceiptHash =
    hashRecord('FormalTheoremDependencyOperationReceipt', nodeReceipt);
  changed.theoremOperationReceiptHashes[index] =
    nodeReceipt.formalTheoremDependencyOperationReceiptHash;
  delete changed.formalTheoremDependencyGraphOperationReceiptHash;
  changed.formalTheoremDependencyGraphOperationReceiptHash =
    hashRecord('FormalTheoremDependencyGraphOperationReceipt', changed);
  return changed;
}

function agentReceipt(role, ordinal) {
  const payload = {
    status: 'agent_execution_completed',
    providerMode: 'openclaw:detached-child-session',
    executorId: 'multi-theorem-orchestrator-fixture-v1',
    agentId: `${role}-${ordinal}`,
    agentCapabilityProfileHash: digest(`capability:${role}:${ordinal}`),
    openClawAgentConfigurationHash: digest(`agent-config:${role}:${ordinal}`),
    openClawGatewayConfigurationHash: digest('gateway-config'),
    resolvedModel: 'fixture-model',
    role,
    changedPaths: [],
    structuredOutput: null,
    finalOutput: '',
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload),
  });
}

function claim({
  claimKey,
  theoremName,
  leanTypeSource = '∀ n : Nat, n = n',
  dependencies = [],
  allowedImports = ['Init'],
  manuscriptIntent = 'existing',
  ordinal,
  authorityBindingHash,
  authorityBundleHash,
}) {
  const statement = `Authorized ${claimKey} formal statement.`;
  const assumptions = ['Only the exact typed domain is in scope.'];
  const quantifiers = ['Only the exact Lean binders are quantified.'];
  const negativeBoundaries = ['No empirical or causal conclusion follows.'];
  const proofObligations = ['Close the exact generated Lean proposition without axioms.'];
  return {
    claimKey,
    title: claimKey,
    statement,
    assumptions,
    quantifiers,
    negativeBoundaries,
    proofObligations,
    proofDependencyClaimKeys: dependencies,
    evidenceObligations: [],
    manuscriptIntent,
    manuscriptSource: {
      path: 'main.tex',
      byteStart: ordinal * 10,
      byteEnd: (ordinal * 10) + 5,
      contentHash: digest('manuscript'),
      formalClaimUniverseEntryHash: digest(`universe:${claimKey}`),
    },
    proposalClaimSource: {
      claimAuthorityType: 'machine-policy-authorized',
      claimAuthorityBindingHash: authorityBindingHash,
      claimAuthorityBundleHash: authorityBundleHash,
      proposalClaimId: `proposal-${claimKey}`,
      proposalClaimText: statement,
      scientificClaimKey: claimKey,
      assumptions,
      quantifiers,
      negativeBoundaries,
      proofObligations,
      proposalClaimTextHash: hashBytes(Buffer.from(statement, 'utf8')),
      proposalClaimRecordHash: digest(`proposal:${claimKey}`),
      proposalSeedContractBundleHash: null,
      approvedProposalSeedBindingHash: null,
      dynamicFormalClaimSeedHash: digest(`seed:${claimKey}`),
      leanDeclarationName: theoremName,
      leanTypeSource,
      leanTypeSourceHash: hashBytes(Buffer.from(leanTypeSource, 'utf8')),
      leanNormalizedTypeHash: leanTypeIdentity(leanTypeSource).normalizedTypeHash,
      allowedImports,
      formalClaimCapabilityScopeManifestHash: digest(`scope:${claimKey}`),
      formalClaimGeneratorReceiptHash: digest(`generator:${claimKey}`),
    },
  };
}

function graphAuthority({ claims = null } = {}) {
  const authorityBindingHash = claims?.[0]?.proposalClaimSource?.claimAuthorityBindingHash
    || digest('authority-binding');
  const authorityBundleHash = claims?.[0]?.proposalClaimSource?.claimAuthorityBundleHash
    || digest('authority-bundle');
  const selectedClaims = claims || [
    claim({
      claimKey: 'shared-lemma', theoremName: 'graphSharedLemma', dependencies: [], ordinal: 1,
      authorityBindingHash, authorityBundleHash,
    }),
    claim({
      claimKey: 'theorem-one', theoremName: 'graphTheoremOne', dependencies: ['shared-lemma'], ordinal: 2,
      authorityBindingHash, authorityBundleHash,
    }),
    claim({
      claimKey: 'theorem-two', theoremName: 'graphTheoremTwo', dependencies: ['shared-lemma'], ordinal: 3,
      authorityBindingHash, authorityBundleHash,
    }),
  ];
  const theoremSpecification = createTheoremSpecification({
    paperId: 'dependency-graph-paper',
    campaignId: 'dependency-graph-campaign',
    sourceManuscriptPath: 'main.tex',
    sourceManuscriptHash: digest('manuscript'),
    formalClaimUniverseHash: digest('universe'),
    claimAuthorityType: 'machine-policy-authorized',
    claimAuthorityBindingHash: authorityBindingHash,
    claimAuthorityBundleHash: authorityBundleHash,
    claims: selectedClaims,
  });
  const bundle = createTypedTheoremObligationBundle(theoremSpecification);
  const graph = createTypedTheoremDependencyGraph({ theoremSpecification, bundle });
  return { theoremSpecification, bundle, graph };
}

function verifiedReceipt(graph, claimId, dependencies) {
  return createTheoremDependencySearchReceipt({
    graph,
    claimId,
    dependencyReceipts: dependencies,
    attemptReceipts: [digest(`attempt:${claimId}`)],
    status: 'theorem_dependency_kernel_verified',
    kernelVerificationReceiptHash: digest(`kernel:${claimId}`),
    readableProofExplanationHash: digest(`readable:${claimId}`),
  });
}

test('canonical graph topologically binds a shared lemma and two dependent theorems', () => {
  const { theoremSpecification, bundle, graph } = graphAuthority();
  assert.equal(graph.nodeCount, 3);
  assert.equal(graph.edgeCount, 2);
  assert.deepEqual(graph.nodes.map((node) => node.releasePolicy), [
    'required', 'required', 'required',
  ]);
  assert.deepEqual(graph.topologicalOrder, theoremSpecification.claims.map((item) => item.claimId));
  assert.equal(verifyTypedTheoremDependencyGraph(graph, { theoremSpecification, bundle }).valid, true);
  assert.deepEqual(graph.nodes[1].dependencyClaimIds, [graph.nodes[0].claimId]);
  assert.deepEqual(graph.nodes[2].dependencyClaimIds, [graph.nodes[0].claimId]);
});

test('missing dependencies and cycles fail before a graph can become authority', () => {
  const authorityBindingHash = digest('authority-binding');
  const authorityBundleHash = digest('authority-bundle');
  const base = { authorityBindingHash, authorityBundleHash };
  assert.throws(() => graphAuthority({ claims: [
    claim({ claimKey: 'missing', theoremName: 'missing', dependencies: ['absent'], ordinal: 1, ...base }),
  ] }), /theorem_specification_claim_proof_dependency_missing/);
  assert.throws(() => graphAuthority({ claims: [
    claim({ claimKey: 'left', theoremName: 'left', dependencies: ['right'], ordinal: 1, ...base }),
    claim({ claimKey: 'right', theoremName: 'right', dependencies: ['left'], ordinal: 2, ...base }),
  ] }), /theorem_specification_claim_proof_dependency_cycle/);
});

test('dependency edge and exact type tamper remain blocked after attacker rehashes the wrapper', () => {
  const { theoremSpecification, bundle, graph } = graphAuthority();
  const tampered = structuredClone(graph);
  tampered.nodes[1].dependencyClaimIds = [];
  const semantic = {
    nodes: tampered.nodes.map((node) => ({
      claimId: node.claimId,
      theoremSpecificationClaimHash: node.theoremSpecificationClaimHash,
      typedTheoremObligationHash: node.typedTheoremObligationHash,
      dependencyClaimIds: node.dependencyClaimIds,
      requiredForRelease: node.requiredForRelease,
      leanNormalizedTypeHash: node.leanNormalizedTypeHash,
      typedTheoremDslHash: node.typedTheoremDslHash,
    })),
    edges: tampered.edges,
    topologicalOrder: tampered.topologicalOrder,
  };
  tampered.graphSemanticHash = hashRecord('TypedTheoremDependencyGraphSemantic', semantic);
  delete tampered.typedTheoremDependencyGraphHash;
  tampered.typedTheoremDependencyGraphHash = hashRecord('TypedTheoremDependencyGraph', tampered);
  assert.equal(verifyTypedTheoremDependencyGraph(tampered, {
    theoremSpecification, bundle,
  }).valid, false);
});

test('required partial failure blocks release and prevents downstream dependency import', () => {
  const { graph } = graphAuthority();
  const failedLemma = createTheoremDependencySearchReceipt({
    graph,
    claimId: graph.nodes[0].claimId,
    status: 'theorem_dependency_search_exhausted',
    attemptReceipts: [digest('failed-attempt')],
    blockers: ['bounded_search_exhausted'],
  });
  const blockedOne = createTheoremDependencySearchReceipt({
    graph,
    claimId: graph.nodes[1].claimId,
    dependencyReceipts: [failedLemma],
    status: 'theorem_dependency_blocked_by_dependency',
    blockers: ['theorem_dependency_predecessor_not_kernel_verified'],
  });
  const blockedTwo = createTheoremDependencySearchReceipt({
    graph,
    claimId: graph.nodes[2].claimId,
    dependencyReceipts: [failedLemma],
    status: 'theorem_dependency_blocked_by_dependency',
    blockers: ['theorem_dependency_predecessor_not_kernel_verified'],
  });
  const execution = createTheoremDependencyGraphExecutionReceipt({
    graph, theoremReceipts: [failedLemma, blockedOne, blockedTwo],
  });
  assert.equal(execution.releaseReady, false);
  assert.deepEqual(execution.requiredFailureClaimIds, graph.topologicalOrder);
  assert.throws(() => createTheoremDependencySearchReceipt({
    graph,
    claimId: graph.nodes[1].claimId,
    dependencyReceipts: [failedLemma],
    status: 'theorem_dependency_kernel_verified',
    kernelVerificationReceiptHash: digest('forged-kernel'),
    readableProofExplanationHash: digest('forged-readable'),
  }), /theorem_dependency_search_unverified_dependency_import/);
});

test('whole-graph replay binds identity, topological order, and theorem receipt order', () => {
  const { graph } = graphAuthority();
  const lemma = verifiedReceipt(graph, graph.nodes[0].claimId, []);
  const theoremOne = verifiedReceipt(graph, graph.nodes[1].claimId, [lemma]);
  const theoremTwo = verifiedReceipt(graph, graph.nodes[2].claimId, [lemma]);
  const execution = createTheoremDependencyGraphExecutionReceipt({
    graph, theoremReceipts: [lemma, theoremOne, theoremTwo],
  });
  const replay = createTheoremDependencyGraphReplayReceipt({ graph, executionReceipt: execution });
  assert.equal(replay.status, 'theorem_dependency_graph_replay_verified');
  assert.equal(replay.originalGraphSemanticHash, replay.replayGraphSemanticHash);
  assert.equal(verifyTheoremDependencyGraphReplayReceipt(replay, { graph, executionReceipt: execution }), true);
  assert.throws(() => createTheoremDependencyGraphExecutionReceipt({
    graph, theoremReceipts: [lemma, theoremTwo, theoremOne],
  }), /theorem_dependency_graph_execution_order_invalid/);
  const identityTamper = structuredClone(replay);
  identityTamper.replayGraphSemanticHash = digest('wrong-semantic-identity');
  delete identityTamper.theoremDependencyGraphReplayReceiptHash;
  identityTamper.theoremDependencyGraphReplayReceiptHash =
    hashRecord('TheoremDependencyGraphReplayReceipt', identityTamper);
  assert.equal(verifyTheoremDependencyGraphReplayReceipt(identityTamper, {
    graph, executionReceipt: execution,
  }), false);
});

test('production formal orchestrator selects graph executor before the single-obligation executor', async () => {
  const { theoremSpecification } = graphAuthority();
  let singleCalls = 0;
  let graphCalls = 0;
  let agentCalls = 0;
  let workerPlanFinalizerCalls = 0;
  const graphOperationReceipt = Object.freeze({
    version: 1,
    kind: 'FormalTheoremDependencyGraphOperationReceipt',
    status: 'formal_theorem_dependency_graph_operations_verified',
    theoremOperationReceipts: Object.freeze([]),
    formalTheoremDependencyGraphOperationReceiptHash: digest('graph-operation'),
  });
  const result = await executeCampaignFormalVerificationNode({
    primitives: {
      workspace: {
        readTheoremSpecification() { return theoremSpecification; },
      },
      agent: {
        finalizeFormalWorkerPlan(input) {
          workerPlanFinalizerCalls += 1;
          assert.equal(input.workspace, '/tmp/unused');
          assert.equal(input.paperId, 'dependency-graph-paper');
          assert.equal(input.taskKey, 'paper_factory:dependency-graph-paper');
          assert.equal(input.theoremSpecification, theoremSpecification);
        },
        async execute() {
          const role = agentCalls === 0 ? 'formal-author' : 'formal-review';
          agentCalls += 1;
          return agentReceipt(role, agentCalls);
        },
        buildFormalReviewEnvelope() {
          return Object.freeze({
            status: 'formal_semantic_review_envelope_verified',
            blockers: Object.freeze([]),
            formalSemanticReviewEnvelopeHash: digest('review-envelope'),
          });
        },
        executeFormalProofSearchOperations() {
          singleCalls += 1;
          throw new Error('single_obligation_executor_must_not_run_for_multi_theorem_graph');
        },
        executeFormalTheoremDependencyGraphOperations(input) {
          graphCalls += 1;
          assert.equal(input.graph.nodeCount, 3);
          return graphOperationReceipt;
        },
      },
      release: {
        verifyFormal(input) {
          const payload = {
            status: 'campaign_formal_verification_completed',
            nativeResearchWorkerExecutionReportHash: digest('worker-report'),
            campaignFormalVerificationReceiptHash: digest('campaign-formal-receipt'),
            typedTheoremObligationBundleHash:
              input.typedTheoremObligationBundle.typedTheoremObligationBundleHash,
            formalProofSearchPlanHash: input.formalProofSearchPlan.formalProofSearchPlanHash,
            formalProofSearchCandidateId: input.formalProofSearchCandidate.candidateId,
            formalProofSearchOperationReceiptHash: null,
            typedTheoremDependencyGraphHash:
              input.typedTheoremDependencyGraph.typedTheoremDependencyGraphHash,
            formalTheoremDependencyGraphOperationReceiptHash:
              input.formalTheoremDependencyGraphOperationReceipt
                .formalTheoremDependencyGraphOperationReceiptHash,
            formalProofSearchAttempts: input.formalProofSearchAttempts,
            blockers: Object.freeze([]),
          };
          return Object.freeze(payload);
        },
      },
    },
    campaign: {
      campaignId: 'dependency-graph-campaign',
      paperId: 'dependency-graph-paper',
      spec: {
        sourceWorkspace: '/tmp/unused',
        datasetMounts: [],
        researchVerificationInput: buildCampaignResearchVerificationInput({
          paperId: 'dependency-graph-paper',
          paperTask: {
            paperId: 'dependency-graph-paper',
            taskKey: 'paper_factory:dependency-graph-paper',
            semanticIdentityHash: digest('dependency-graph-paper-task'),
          },
          paperState: { evidenceRefs: [] },
        }),
      },
    },
    node: {
      nodeId: 'dependency-graph:formal',
      kind: 'formal-verify',
      role: 'formal-verification',
      attemptId: 'attempt-1',
      leaseGeneration: 1,
      dependencies: [],
    },
    context: { campaignNodes: [] },
    workspace: '/tmp/unused',
    manuscript: 'main.tex',
    executionBudget: { remainingTokenCount: 50_000, remainingWallTimeMs: 60_000 },
  });
  assert.equal(result.status, 'campaign_formal_verification_completed');
  assert.equal(singleCalls, 0);
  assert.equal(graphCalls, 1);
  assert.equal(agentCalls, 2);
  assert.equal(workerPlanFinalizerCalls, 1);
});

test('operation verifier recomputes graph summaries and every terminal node state after rehash', async () => {
  const verifiedAuthority = graphAuthority();
  const verifiedPlan = createFormalProofSearchPlan(verifiedAuthority.bundle);
  const verified = await deterministicGraphExecutor({ closeTactics: true }).execute({
    ...verifiedAuthority,
    candidate: verifiedPlan.candidates[0],
  });
  assert.equal(verifyFormalTheoremDependencyGraphOperationReceipt(verified, {
    graph: verifiedAuthority.graph,
    candidate: verifiedPlan.candidates[0],
  }).valid, true);

  const forgedStatus = rehashGraphOperation(verified, (receipt) => {
    receipt.status = 'formal_theorem_dependency_graph_operations_partial';
  });
  assert.equal(verifyFormalTheoremDependencyGraphOperationReceipt(forgedStatus, {
    graph: verifiedAuthority.graph,
    candidate: verifiedPlan.candidates[0],
  }).valid, false);
  const forgedReplaySummary = rehashGraphOperation(verified, (receipt) => {
    receipt.freshReplayComplete = false;
  });
  assert.equal(verifyFormalTheoremDependencyGraphOperationReceipt(forgedReplaySummary, {
    graph: verifiedAuthority.graph,
    candidate: verifiedPlan.candidates[0],
  }).valid, false);
  const forgedVerifiedNode = rehashGraphNodeOperation(verified, 0, (receipt) => {
    receipt.status = 'formal_theorem_dependency_operation_search_exhausted';
    receipt.blockers = ['formal_theorem_dependency_no_replayed_kernel_candidate'];
    receipt.kernelVerifiedBeforeDownstreamImport = false;
  });
  assert.equal(verifyFormalTheoremDependencyGraphOperationReceipt(forgedVerifiedNode, {
    graph: verifiedAuthority.graph,
    candidate: verifiedPlan.candidates[0],
  }).valid, false);

  const exhausted = await deterministicGraphExecutor({ closeTactics: false }).execute({
    ...verifiedAuthority,
    candidate: verifiedPlan.candidates[0],
  });
  assert.deepEqual(exhausted.theoremOperationReceipts.map((item) => item.status), [
    'formal_theorem_dependency_operation_search_exhausted',
    'formal_theorem_dependency_operation_blocked_by_dependency',
    'formal_theorem_dependency_operation_blocked_by_dependency',
  ]);
  assert.equal(verifyFormalTheoremDependencyGraphOperationReceipt(exhausted, {
    graph: verifiedAuthority.graph,
    candidate: verifiedPlan.candidates[0],
  }).valid, true);
  for (const index of [0, 1]) {
    const forged = rehashGraphNodeOperation(exhausted, index, (receipt) => {
      receipt.status = 'formal_theorem_dependency_operation_semantic_review_only';
      receipt.blockers = ['typed_theorem_dsl_machine_search_not_available'];
      receipt.semanticReviewOnly = true;
    });
    assert.equal(verifyFormalTheoremDependencyGraphOperationReceipt(forged, {
      graph: verifiedAuthority.graph,
      candidate: verifiedPlan.candidates[0],
    }).valid, false);
  }

  const genericSpecification = createTheoremSpecification({
    paperId: 'semantic-only-paper',
    campaignId: 'semantic-only-campaign',
    sourceManuscriptPath: 'main.tex',
    sourceManuscriptHash: digest('semantic-manuscript'),
    formalClaimUniverseHash: digest('semantic-universe'),
    claims: [{
      claimKey: 'semantic-only',
      title: 'Semantic-only theorem',
      statement: 'The author proposes a generic formalization.',
      assumptions: ['No exact Lean type authority is supplied.'],
      quantifiers: ['The prose scope is reviewed independently.'],
      negativeBoundaries: ['Kernel closure is not machine semantic equivalence.'],
      proofObligations: ['Review the proposed formalization.'],
      proofDependencyClaimKeys: [],
      evidenceObligations: [],
      manuscriptIntent: 'existing',
      manuscriptSource: {
        path: 'main.tex', byteStart: 0, byteEnd: 5,
        contentHash: digest('semantic-manuscript'),
        formalClaimUniverseEntryHash: digest('semantic-entry'),
      },
    }],
  });
  const genericBundle = createTypedTheoremObligationBundle(genericSpecification);
  const genericGraph = createTypedTheoremDependencyGraph({
    theoremSpecification: genericSpecification,
    bundle: genericBundle,
  });
  const genericPlan = createFormalProofSearchPlan(genericBundle);
  const semanticOnly = await deterministicGraphExecutor({ closeTactics: true }).execute({
    theoremSpecification: genericSpecification,
    bundle: genericBundle,
    graph: genericGraph,
    candidate: genericPlan.candidates[0],
  });
  assert.equal(
    semanticOnly.theoremOperationReceipts[0].status,
    'formal_theorem_dependency_operation_semantic_review_only',
  );
  assert.equal(verifyFormalTheoremDependencyGraphOperationReceipt(semanticOnly, {
    graph: genericGraph,
    candidate: genericPlan.candidates[0],
  }).valid, true);
  const forgedSemantic = rehashGraphNodeOperation(semanticOnly, 0, (receipt) => {
    receipt.status = 'formal_theorem_dependency_operation_refuted';
    receipt.blockers = ['formal_proof_search_refuted_by_bounded_witness'];
    receipt.semanticReviewOnly = false;
  });
  assert.equal(verifyFormalTheoremDependencyGraphOperationReceipt(forgedSemantic, {
    graph: genericGraph,
    candidate: genericPlan.candidates[0],
  }).valid, false);

  const authorityBindingHash = digest('refuted-authority-binding');
  const authorityBundleHash = digest('refuted-authority-bundle');
  const refutedAuthority = graphAuthority({ claims: [claim({
    claimKey: 'false-finite-claim',
    theoremName: 'falseFiniteClaim',
    leanTypeSource: '∀ n : Nat, n = 0',
    dependencies: [],
    ordinal: 1,
    authorityBindingHash,
    authorityBundleHash,
  })] });
  const refutedPlan = createFormalProofSearchPlan(refutedAuthority.bundle);
  const refuted = await deterministicGraphExecutor({ closeTactics: true }).execute({
    ...refutedAuthority,
    candidate: refutedPlan.candidates[2],
  });
  assert.equal(
    refuted.theoremOperationReceipts[0].status,
    'formal_theorem_dependency_operation_refuted',
  );
  assert.equal(verifyFormalTheoremDependencyGraphOperationReceipt(refuted, {
    graph: refutedAuthority.graph,
    candidate: refutedPlan.candidates[2],
  }).valid, true);
  const forgedRefuted = rehashGraphNodeOperation(refuted, 0, (receipt) => {
    receipt.status = 'formal_theorem_dependency_operation_search_exhausted';
    receipt.blockers = ['formal_theorem_dependency_no_replayed_kernel_candidate'];
  });
  assert.equal(verifyFormalTheoremDependencyGraphOperationReceipt(forgedRefuted, {
    graph: refutedAuthority.graph,
    candidate: refutedPlan.candidates[2],
  }).valid, false);
});

test('Real Mathlib dependency graphs fail closed before execution without build authority', async () => {
  const authorityBindingHash = digest('real-authority-binding');
  const authorityBundleHash = digest('real-authority-bundle');
  const { theoremSpecification, bundle, graph } = graphAuthority({
    claims: [
      claim({
        claimKey: 'real-shared',
        theoremName: 'realShared',
        leanTypeSource: '∀ x : Real, x = x',
        allowedImports: ['Mathlib'],
        dependencies: [],
        ordinal: 1,
        authorityBindingHash,
        authorityBundleHash,
      }),
      claim({
        claimKey: 'real-dependent',
        theoremName: 'realDependent',
        leanTypeSource: '∀ x : Real, x * 1 = x',
        allowedImports: ['Mathlib'],
        dependencies: ['real-shared'],
        ordinal: 2,
        authorityBindingHash,
        authorityBundleHash,
      }),
    ],
  });
  assert.equal(verifyTypedTheoremDependencyGraph(
    graph, { theoremSpecification, bundle },
  ).valid, true);
  const plan = createFormalProofSearchPlan(bundle);
  let runnerCalls = 0;
  await assert.rejects(createFormalTheoremDependencyGraphOperationsExecutor({
    workerRunnerFactory() {
      runnerCalls += 1;
      throw new Error('runner_must_not_be_reached');
    },
  }).execute({
    theoremSpecification,
    bundle,
    graph,
    candidate: plan.candidates[0],
  }), /dynamic_formal_execution_authority_required/);
  assert.equal(runnerCalls, 0);
});

test('real Docker Lean closes and separately replays shared-lemma imports with zero skip', {
  timeout: 4 * 60 * 1000,
}, async (t) => {
  const preflight = trustedProductionLakeOrSkip(t);
  if (!preflight) return;
  const { theoremSpecification, bundle, graph } = graphAuthority();
  const plan = createFormalProofSearchPlan(bundle);
  const receipt = await createFormalTheoremDependencyGraphOperationsExecutor({
    trustedSandboxRuntime: preflight.formalSandboxRuntime,
    timeoutMs: 120_000,
  }).execute({
    theoremSpecification,
    bundle,
    graph,
    candidate: plan.candidates[0],
  });
  assert.equal(receipt.status, 'formal_theorem_dependency_graph_operations_verified',
    JSON.stringify(receipt, null, 2));
  assert.equal(receipt.freshReplayComplete, true);
  assert.equal(receipt.theoremOperationReceipts.length, 3);
  assert.equal(receipt.theoremOperationReceipts[0].selectedTactic, 'rfl');
  assert.match(receipt.theoremOperationReceipts[1].selectedTactic, /graphSharedLemma n/);
  assert.match(receipt.theoremOperationReceipts[2].selectedTactic, /graphSharedLemma n/);
  assert.equal(receipt.theoremOperationReceipts.slice(1).every((item) => (
    item.importedDeclarationNames.includes('graphSharedLemma')
      && item.kernelVerifiedBeforeDownstreamImport === true
  )), true);
  assert.equal(verifyFormalTheoremDependencyGraphOperationReceipt(receipt, { graph }).valid, true);

  const dependencyTamper = structuredClone(receipt);
  dependencyTamper.theoremOperationReceipts[1].dependencyOperationReceiptHashes[0] =
    digest('wrong-dependency-receipt');
  const child = dependencyTamper.theoremOperationReceipts[1];
  delete child.formalTheoremDependencyOperationReceiptHash;
  child.formalTheoremDependencyOperationReceiptHash =
    hashRecord('FormalTheoremDependencyOperationReceipt', child);
  dependencyTamper.theoremOperationReceiptHashes[1] = child.formalTheoremDependencyOperationReceiptHash;
  delete dependencyTamper.formalTheoremDependencyGraphOperationReceiptHash;
  dependencyTamper.formalTheoremDependencyGraphOperationReceiptHash =
    hashRecord('FormalTheoremDependencyGraphOperationReceipt', dependencyTamper);
  assert.equal(verifyFormalTheoremDependencyGraphOperationReceipt(
    dependencyTamper, { graph },
  ).valid, false);
});
