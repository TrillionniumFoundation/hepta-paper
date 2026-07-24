import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyTheoremSpecification } from './theorem-specification.mjs';
import { verifyTypedTheoremObligationBundle } from './typed-theorem-proof-search-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const RESULT_STATUSES = new Set([
  'theorem_dependency_kernel_verified',
  'theorem_dependency_refuted',
  'theorem_dependency_search_exhausted',
  'theorem_dependency_semantic_review_only',
  'theorem_dependency_blocked_by_dependency',
]);
const GRAPH_KEYS = Object.freeze([
  'edgeCount', 'edges', 'graphSemanticHash', 'kind', 'limitations', 'nodeCount',
  'nodes', 'status', 'theoremSpecificationHash', 'topologicalOrder',
  'typedTheoremDependencyGraphHash', 'typedTheoremObligationBundleHash', 'version',
]);

function topologicalOrder(nodes) {
  const orderIndex = new Map(nodes.map((node, index) => [node.claimId, index]));
  const indegree = new Map(nodes.map((node) => [node.claimId, node.dependencyClaimIds.length]));
  const dependents = new Map(nodes.map((node) => [node.claimId, []]));
  for (const node of nodes) {
    for (const dependency of node.dependencyClaimIds) dependents.get(dependency).push(node.claimId);
  }
  const ready = nodes.filter((node) => indegree.get(node.claimId) === 0)
    .map((node) => node.claimId)
    .sort((left, right) => orderIndex.get(left) - orderIndex.get(right));
  const result = [];
  while (ready.length) {
    const claimId = ready.shift();
    result.push(claimId);
    for (const dependent of dependents.get(claimId)) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) {
        ready.push(dependent);
        ready.sort((left, right) => orderIndex.get(left) - orderIndex.get(right));
      }
    }
  }
  if (result.length !== nodes.length) throw new Error('typed_theorem_dependency_graph_cycle');
  return Object.freeze(result);
}

function graphNode(claim, obligation, claimIdByKey) {
  const dependencyClaimIds = claim.proofDependencyClaimKeys.map((claimKey) => {
    const claimId = claimIdByKey.get(claimKey);
    if (!claimId) throw new Error('typed_theorem_dependency_graph_dependency_missing');
    return claimId;
  });
  const machineSearchEligible = obligation.typedTheoremDsl?.machineSearchEligible === true;
  const payload = {
    version: 1,
    kind: 'TypedTheoremDependencyNode',
    claimId: claim.claimId,
    claimKey: claim.claimKey,
    theoremSpecificationClaimHash: claim.theoremSpecificationClaimHash,
    typedTheoremObligationHash: obligation.typedTheoremObligationHash,
    dependencyClaimKeys: Object.freeze([...claim.proofDependencyClaimKeys]),
    dependencyClaimIds: Object.freeze(dependencyClaimIds),
    releasePolicy: claim.releasePolicy,
    requiredForRelease: claim.releasePolicy === 'required',
    searchPolicy: machineSearchEligible
      ? 'bounded_machine_search_then_kernel'
      : 'semantic_review_only_then_external_kernel_candidate',
    machineSearchEligible,
    exactLeanTypeAuthority: obligation.goalAuthority === 'exact_dynamic_lean_type',
    leanDeclarationName: obligation.leanDeclarationName,
    leanTypeSourceHash: obligation.leanTypeSourceHash,
    leanNormalizedTypeHash: obligation.leanNormalizedTypeHash,
    typedTheoremDslHash: obligation.typedTheoremDslHash,
    typedTheoremDsl: obligation.typedTheoremDsl,
    dependencyImportPolicy:
      'only-kernel-verified-predecessor-declarations-from-this-graph',
  };
  return Object.freeze({
    ...payload,
    typedTheoremDependencyNodeHash: hashRecord('TypedTheoremDependencyNode', payload),
  });
}

export function createTypedTheoremDependencyGraph({ theoremSpecification, bundle } = {}) {
  if (!verifyTheoremSpecification(theoremSpecification).valid
    || !verifyTypedTheoremObligationBundle(bundle, { theoremSpecification }).valid) {
    throw new Error('typed_theorem_dependency_graph_authority_invalid');
  }
  const obligationByClaimId = new Map(bundle.obligations.map((item) => [item.claimId, item]));
  const claimIdByKey = new Map(theoremSpecification.claims.map((item) => [item.claimKey, item.claimId]));
  const nodes = Object.freeze(theoremSpecification.claims.map((claim) => {
    const obligation = obligationByClaimId.get(claim.claimId);
    if (!obligation || obligation.theoremSpecificationClaimHash
      !== claim.theoremSpecificationClaimHash) {
      throw new Error('typed_theorem_dependency_graph_obligation_missing');
    }
    return graphNode(claim, obligation, claimIdByKey);
  }));
  const order = topologicalOrder(nodes);
  const edges = Object.freeze(nodes.flatMap((node) => node.dependencyClaimIds.map((dependency) => {
    const payload = {
      fromClaimId: dependency,
      toClaimId: node.claimId,
      relation: 'kernel_verified_declaration_import',
    };
    return Object.freeze({
      ...payload,
      edgeHash: hashRecord('TypedTheoremDependencyEdge', payload),
    });
  })));
  const semantic = {
    nodes: nodes.map((node) => ({
      claimId: node.claimId,
      theoremSpecificationClaimHash: node.theoremSpecificationClaimHash,
      typedTheoremObligationHash: node.typedTheoremObligationHash,
      dependencyClaimIds: node.dependencyClaimIds,
      requiredForRelease: node.requiredForRelease,
      leanNormalizedTypeHash: node.leanNormalizedTypeHash,
      typedTheoremDslHash: node.typedTheoremDslHash,
    })),
    edges,
    topologicalOrder: order,
  };
  const payload = {
    version: 1,
    kind: 'TypedTheoremDependencyGraph',
    status: 'typed_theorem_dependency_graph_ready',
    theoremSpecificationHash: theoremSpecification.theoremSpecificationHash,
    typedTheoremObligationBundleHash: bundle.typedTheoremObligationBundleHash,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes,
    edges,
    topologicalOrder: order,
    graphSemanticHash: hashRecord('TypedTheoremDependencyGraphSemantic', semantic),
    limitations: Object.freeze({
      openWorldTheoremDiscoveryGuaranteed: false,
      dependencyCompletenessKernelInferred: false,
      naturalLanguageDependencySemanticsKernelProven: false,
    }),
  };
  return Object.freeze({
    ...payload,
    typedTheoremDependencyGraphHash: hashRecord('TypedTheoremDependencyGraph', payload),
  });
}

export function verifyTypedTheoremDependencyGraph(graph, { theoremSpecification, bundle } = {}) {
  const blockers = [];
  if (!hasExactObjectKeys(graph, GRAPH_KEYS)) blockers.push('typed_theorem_dependency_graph_shape_invalid');
  let rebuilt = null;
  try { rebuilt = createTypedTheoremDependencyGraph({ theoremSpecification, bundle }); }
  catch (error) { blockers.push(error?.message || 'typed_theorem_dependency_graph_rebuild_failed'); }
  if (!rebuilt || JSON.stringify(rebuilt) !== JSON.stringify(graph)) {
    blockers.push('typed_theorem_dependency_graph_not_canonical');
  }
  return Object.freeze({
    valid: blockers.length === 0,
    status: blockers.length
      ? 'typed_theorem_dependency_graph_blocked'
      : 'typed_theorem_dependency_graph_verified',
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

function resultOutcomeAllowed(node, status) {
  if (status === 'theorem_dependency_kernel_verified') return true;
  if (node.requiredForRelease) return false;
  return [
    'theorem_dependency_refuted',
    'theorem_dependency_search_exhausted',
    'theorem_dependency_semantic_review_only',
    'theorem_dependency_blocked_by_dependency',
  ].includes(status);
}

export function createTheoremDependencySearchReceipt({
  graph,
  claimId,
  dependencyReceipts = [],
  attemptReceipts = [],
  status,
  kernelVerificationReceiptHash = null,
  refutationReceiptHash = null,
  readableProofExplanationHash = null,
  blockers = [],
} = {}) {
  const node = graph?.nodes?.find((item) => item.claimId === claimId);
  if (!node || !RESULT_STATUSES.has(status)) {
    throw new Error('theorem_dependency_search_receipt_input_invalid');
  }
  const dependencies = Array.isArray(dependencyReceipts) ? dependencyReceipts : [];
  const expectedDependencyIds = node.dependencyClaimIds;
  const dependencyIdsMatch = JSON.stringify(dependencies.map((item) => item.claimId))
    === JSON.stringify(expectedDependencyIds);
  const dependencyVerified = dependencies.every((item) => (
    item.status === 'theorem_dependency_kernel_verified'
  ));
  if (!dependencyIdsMatch
    || (status === 'theorem_dependency_blocked_by_dependency'
      ? dependencyVerified
      : !dependencyVerified)) {
    throw new Error('theorem_dependency_search_unverified_dependency_import');
  }
  const attempts = Array.isArray(attemptReceipts) ? attemptReceipts : [];
  if (attempts.some((item) => !SHA256.test(String(
    item?.formalProofSearchAttemptReceiptHash
      || item?.formalProofSearchOperationReceiptHash
      || item,
  )))) throw new Error('theorem_dependency_search_attempt_invalid');
  const hashes = [kernelVerificationReceiptHash, refutationReceiptHash, readableProofExplanationHash]
    .filter((item) => item !== null);
  if (hashes.some((item) => !SHA256.test(String(item)))) {
    throw new Error('theorem_dependency_search_evidence_hash_invalid');
  }
  if ((status === 'theorem_dependency_kernel_verified') !== Boolean(kernelVerificationReceiptHash)
    || (status === 'theorem_dependency_refuted') !== Boolean(refutationReceiptHash)
    || (status === 'theorem_dependency_kernel_verified') !== Boolean(readableProofExplanationHash)) {
    throw new Error('theorem_dependency_search_evidence_status_mismatch');
  }
  const selectedBlockers = Object.freeze([...new Set((blockers || []).map(String))].sort());
  if ((status === 'theorem_dependency_kernel_verified') === Boolean(selectedBlockers.length)) {
    throw new Error('theorem_dependency_search_blocker_status_mismatch');
  }
  const payload = {
    version: 1,
    kind: 'TheoremDependencySearchReceipt',
    status,
    typedTheoremDependencyGraphHash: graph.typedTheoremDependencyGraphHash,
    graphSemanticHash: graph.graphSemanticHash,
    claimId: node.claimId,
    claimKey: node.claimKey,
    typedTheoremDependencyNodeHash: node.typedTheoremDependencyNodeHash,
    dependencyClaimIds: node.dependencyClaimIds,
    dependencyReceiptHashes: Object.freeze(dependencies.map((item) => (
      item.theoremDependencySearchReceiptHash
    ))),
    dependencyKernelEvidenceHashes: Object.freeze(dependencies
      .filter((item) => item.status === 'theorem_dependency_kernel_verified')
      .map((item) => item.kernelVerificationReceiptHash)),
    attemptReceiptHashes: Object.freeze(attempts.map((item) => (
      item?.formalProofSearchAttemptReceiptHash
        || item?.formalProofSearchOperationReceiptHash
        || item
    ))),
    kernelVerificationReceiptHash,
    refutationReceiptHash,
    readableProofExplanationHash,
    releaseDisposition: resultOutcomeAllowed(node, status)
      ? 'release_requirement_satisfied'
      : 'release_blocked',
    blockers: selectedBlockers,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    theoremDependencySearchReceiptHash:
      hashRecord('TheoremDependencySearchReceipt', payload),
  });
}

export function createTheoremDependencyGraphExecutionReceipt({ graph, theoremReceipts } = {}) {
  const receipts = Array.isArray(theoremReceipts) ? theoremReceipts : [];
  if (JSON.stringify(receipts.map((item) => item.claimId))
      !== JSON.stringify(graph?.topologicalOrder || [])) {
    throw new Error('theorem_dependency_graph_execution_order_invalid');
  }
  const byClaimId = new Map();
  for (const receipt of receipts) {
    const node = graph.nodes.find((item) => item.claimId === receipt.claimId);
    const dependencies = node.dependencyClaimIds.map((claimId) => byClaimId.get(claimId));
    const rebuilt = createTheoremDependencySearchReceipt({
      graph,
      claimId: receipt.claimId,
      dependencyReceipts: dependencies,
      attemptReceipts: receipt.attemptReceiptHashes,
      status: receipt.status,
      kernelVerificationReceiptHash: receipt.kernelVerificationReceiptHash,
      refutationReceiptHash: receipt.refutationReceiptHash,
      readableProofExplanationHash: receipt.readableProofExplanationHash,
      blockers: receipt.blockers,
    });
    if (JSON.stringify(rebuilt) !== JSON.stringify(receipt)) {
      throw new Error('theorem_dependency_graph_execution_receipt_invalid');
    }
    byClaimId.set(receipt.claimId, receipt);
  }
  const requiredFailures = receipts.filter((receipt) => (
    graph.nodes.find((node) => node.claimId === receipt.claimId)?.requiredForRelease
      && receipt.status !== 'theorem_dependency_kernel_verified'
  ));
  const payload = {
    version: 1,
    kind: 'TheoremDependencyGraphExecutionReceipt',
    status: requiredFailures.length
      ? 'theorem_dependency_graph_execution_blocked'
      : 'theorem_dependency_graph_execution_verified',
    typedTheoremDependencyGraphHash: graph.typedTheoremDependencyGraphHash,
    graphSemanticHash: graph.graphSemanticHash,
    topologicalOrder: graph.topologicalOrder,
    theoremReceiptHashes: Object.freeze(receipts.map((item) => (
      item.theoremDependencySearchReceiptHash
    ))),
    theoremReceipts: Object.freeze([...receipts]),
    requiredFailureClaimIds: Object.freeze(requiredFailures.map((item) => item.claimId)),
    releaseReady: requiredFailures.length === 0,
    blockers: Object.freeze(requiredFailures.map((item) => (
      `required_theorem_not_kernel_verified:${item.claimId}`
    ))),
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    theoremDependencyGraphExecutionReceiptHash:
      hashRecord('TheoremDependencyGraphExecutionReceipt', payload),
  });
}

export function createTheoremDependencyGraphReplayReceipt({ graph, executionReceipt } = {}) {
  const rebuiltExecution = createTheoremDependencyGraphExecutionReceipt({
    graph,
    theoremReceipts: executionReceipt?.theoremReceipts,
  });
  if (JSON.stringify(rebuiltExecution) !== JSON.stringify(executionReceipt)) {
    throw new Error('theorem_dependency_graph_replay_execution_invalid');
  }
  const payload = {
    version: 1,
    kind: 'TheoremDependencyGraphReplayReceipt',
    status: executionReceipt.releaseReady
      ? 'theorem_dependency_graph_replay_verified'
      : 'theorem_dependency_graph_replay_blocked',
    originalExecutionReceiptHash:
      executionReceipt.theoremDependencyGraphExecutionReceiptHash,
    typedTheoremDependencyGraphHash: graph.typedTheoremDependencyGraphHash,
    originalGraphSemanticHash: graph.graphSemanticHash,
    replayGraphSemanticHash: graph.graphSemanticHash,
    topologicalOrder: graph.topologicalOrder,
    theoremReceiptHashes: executionReceipt.theoremReceiptHashes,
    identityMatched: true,
    releaseReady: executionReceipt.releaseReady,
    blockers: executionReceipt.blockers,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    theoremDependencyGraphReplayReceiptHash:
      hashRecord('TheoremDependencyGraphReplayReceipt', payload),
  });
}

export function verifyTheoremDependencyGraphReplayReceipt(value, { graph, executionReceipt } = {}) {
  let rebuilt = null;
  try { rebuilt = createTheoremDependencyGraphReplayReceipt({ graph, executionReceipt }); }
  catch { return false; }
  return JSON.stringify(rebuilt) === JSON.stringify(value);
}

export async function executeTheoremDependencyGraph({ graph, searchTheorem } = {}) {
  if (typeof searchTheorem !== 'function') throw new Error('theorem_dependency_search_executor_required');
  const results = new Map();
  for (const claimId of graph.topologicalOrder) {
    const node = graph.nodes.find((item) => item.claimId === claimId);
    const dependencyReceipts = node.dependencyClaimIds.map((dependency) => results.get(dependency));
    let receipt;
    if (dependencyReceipts.some((item) => item?.status !== 'theorem_dependency_kernel_verified')) {
      receipt = createTheoremDependencySearchReceipt({
        graph,
        claimId,
        dependencyReceipts,
        status: 'theorem_dependency_blocked_by_dependency',
        blockers: ['theorem_dependency_predecessor_not_kernel_verified'],
      });
    } else {
      receipt = await searchTheorem({ node, dependencyReceipts });
    }
    results.set(claimId, receipt);
  }
  return createTheoremDependencyGraphExecutionReceipt({
    graph,
    theoremReceipts: graph.topologicalOrder.map((claimId) => results.get(claimId)),
  });
}
