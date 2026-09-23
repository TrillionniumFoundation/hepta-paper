import {
  verifyFormalReadableProofExplanationBundle,
} from '../../paper-domain/research/formal-readable-proof-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function explanationByClaimId(bundle) {
  const entries = Array.isArray(bundle?.explanations) ? bundle.explanations : [];
  const byId = new Map(entries.map((item) => [item.claimId, item]));
  return byId.size === entries.length ? byId : null;
}

export function buildFormalTheoremDependencyReadableProofBundle({
  graph,
  readableProofBundle,
} = {}) {
  const blockers = [];
  const readableVerification = verifyFormalReadableProofExplanationBundle(
    readableProofBundle,
  );
  blockers.push(...readableVerification.blockers.map((blocker) => (
    `readable_proof:${blocker}`
  )));
  const byClaimId = explanationByClaimId(readableProofBundle);
  if (!byClaimId || byClaimId.size !== graph?.nodeCount) {
    blockers.push('formal_theorem_dependency_readable_coverage_invalid');
  }
  const theoremProofs = [];
  for (const claimId of graph?.topologicalOrder || []) {
    const node = graph.nodes.find((item) => item.claimId === claimId);
    const explanation = byClaimId?.get(claimId);
    const dependencyProofs = node.dependencyClaimIds.map((dependency) => byClaimId?.get(dependency));
    const dependencyNames = dependencyProofs.map((item) => item?.theoremName).filter(Boolean);
    if (!explanation || explanation.theoremName !== node.leanDeclarationName
      || dependencyProofs.some((item) => !item)
      || dependencyNames.some((name) => !explanation.usedDeclarations.includes(name))) {
      blockers.push(`formal_theorem_dependency_readable_lineage_invalid:${claimId}`);
      continue;
    }
    const payload = {
      version: 1,
      kind: 'FormalTheoremDependencyReadableProof',
      claimId,
      theoremName: explanation.theoremName,
      typedTheoremDependencyNodeHash: node.typedTheoremDependencyNodeHash,
      formalReadableProofExplanationHash:
        explanation.formalReadableProofExplanationHash,
      explanationDagHash: explanation.explanationDagHash,
      dependencyClaimIds: node.dependencyClaimIds,
      dependencyTheoremNames: Object.freeze(dependencyNames),
      dependencyExplanationHashes: Object.freeze(dependencyProofs.map((item) => (
        item.formalReadableProofExplanationHash
      ))),
      readableStepsHash: explanation.readableStepsHash,
      dependencyReferencesMachineChecked: true,
    };
    theoremProofs.push(Object.freeze({
      ...payload,
      formalTheoremDependencyReadableProofHash:
        hashRecord('FormalTheoremDependencyReadableProof', payload),
    }));
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const payload = {
    version: 1,
    kind: 'FormalTheoremDependencyReadableProofBundle',
    status: uniqueBlockers.length
      ? 'formal_theorem_dependency_readable_proof_blocked'
      : 'formal_theorem_dependency_readable_proof_verified',
    typedTheoremDependencyGraphHash: graph?.typedTheoremDependencyGraphHash || null,
    graphSemanticHash: graph?.graphSemanticHash || null,
    formalReadableProofExplanationBundleHash:
      readableProofBundle?.formalReadableProofExplanationBundleHash || null,
    explanationDependencyGraphHash:
      readableProofBundle?.explanationDependencyGraphHash || null,
    topologicalOrder: graph?.topologicalOrder || Object.freeze([]),
    theoremProofCount: theoremProofs.length,
    theoremProofs: Object.freeze(theoremProofs),
    crossTheoremReadableDependencyGraphHash: hashRecord(
      'FormalTheoremReadableDependencyGraph',
      theoremProofs.map((item) => ({
        claimId: item.claimId,
        theoremName: item.theoremName,
        explanationDagHash: item.explanationDagHash,
        dependencyClaimIds: item.dependencyClaimIds,
        dependencyTheoremNames: item.dependencyTheoremNames,
      })),
    ),
    productionReadableDependencyProofReady: uniqueBlockers.length === 0,
    machineVerificationScope:
      'declared-theorem-dependency-to-kernel-readable-proof-reference-binding-v1',
    blockers: uniqueBlockers,
  };
  return Object.freeze({
    ...payload,
    formalTheoremDependencyReadableProofBundleHash:
      hashRecord('FormalTheoremDependencyReadableProofBundle', payload),
  });
}

export function verifyFormalTheoremDependencyReadableProofBundle(value, {
  graph,
  readableProofBundle,
} = {}) {
  let rebuilt = null;
  try {
    rebuilt = buildFormalTheoremDependencyReadableProofBundle({
      graph,
      readableProofBundle,
    });
  } catch { return false; }
  return rebuilt.status === 'formal_theorem_dependency_readable_proof_verified'
    && JSON.stringify(rebuilt) === JSON.stringify(value);
}
