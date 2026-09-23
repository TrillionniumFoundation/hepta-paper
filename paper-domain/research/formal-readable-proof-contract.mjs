import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const NODE_KINDS = new Set(['formal_goal', 'proof_expression', 'declaration_reference', 'kernel_replay_closure']);

function node(kind, label, detail = null) {
  const payload = {
    version: 1,
    kind,
    label,
    labelHash: hashBytes(Buffer.from(label, 'utf8')),
    detail,
    detailHash: detail === null ? null : hashBytes(Buffer.from(detail, 'utf8')),
  };
  return Object.freeze({
    ...payload,
    nodeId: `proof-node:${hashRecord('FormalReadableProofExplanationNode', payload).slice(7)}`,
  });
}

function edge(from, to, relation) {
  const payload = { from, to, relation };
  return Object.freeze({
    ...payload,
    edgeHash: hashRecord('FormalReadableProofExplanationEdge', payload),
  });
}

function exactTypeSource(binding, declaration) {
  return binding?.formalClaimContract?.dynamicFormalClaimAuthority?.leanTypeSource
    || declaration?.normalizedType || null;
}

function claimExplanation({ audit, binding, declaration, certificateBundle, replayReceipt }) {
  const theoremTypeSource = exactTypeSource(binding, declaration);
  if (!theoremTypeSource || !SHA256.test(String(audit?.theoremTypeHash || ''))) return null;
  const goal = node(
    'formal_goal',
    `Exact Lean goal for ${audit.theoremName}`,
    theoremTypeSource,
  );
  const proof = node(
    'proof_expression',
    'Kernel-elaborated Lean declaration printout',
    audit.proofPrintText,
  );
  const references = audit.usedDeclarationCandidates.map((name) => node(
    'declaration_reference',
    `Referenced identifier in the elaborated declaration: ${name}`,
  ));
  const closure = node(
    'kernel_replay_closure',
    'The exact goal was accepted by the Lean kernel and accepted again in a fresh replay.',
    audit.axioms.length
      ? `Axiom audit: ${audit.axioms.join(', ')}` : 'Axiom audit: no axioms.',
  );
  const nodes = Object.freeze([goal, proof, ...references, closure]);
  const edges = Object.freeze([
    edge(goal.nodeId, proof.nodeId, 'elaborated_as'),
    ...references.map((reference) => edge(
      proof.nodeId, reference.nodeId, 'printed_reference',
    )),
    edge(proof.nodeId, closure.nodeId, 'kernel_and_replay_closed'),
  ]);
  const readableSteps = Object.freeze([
    `Goal: ${theoremTypeSource}`,
    `Lean elaborated and printed declaration ${audit.theoremName}.`,
    ...(references.length
      ? [`The printed proof expression references: ${audit.usedDeclarationCandidates.join(', ')}.`]
      : ['The printed proof expression exposes no additional declaration reference candidates.']),
    audit.axioms.length
      ? `The axiom audit reports: ${audit.axioms.join(', ')}.`
      : 'The axiom audit reports no axioms.',
    'A fresh isolated replay accepted the same source, exact theorem type, proof print audit, and dependency closure.',
  ]);
  const payload = {
    version: 1,
    kind: 'FormalReadableProofExplanation',
    status: 'formal_readable_proof_explanation_verified',
    claimId: audit.claimId,
    theoremName: audit.theoremName,
    theoremTypeSource,
    theoremTypeSourceHash: hashBytes(Buffer.from(theoremTypeSource, 'utf8')),
    theoremTypeHash: audit.theoremTypeHash,
    sourceFile: audit.sourceFile,
    sourceFileHash: audit.sourceFileHash,
    sourceStatementHash: audit.sourceStatementHash,
    proofPrintText: audit.proofPrintText,
    proofPrintTextHash: audit.proofPrintTextHash,
    proofPrintAuditHash: audit.leanProofPrintAuditHash,
    usedDeclarations: Object.freeze([...audit.usedDeclarationCandidates]),
    usedDeclarationSetHash: hashRecord(
      'FormalReadableProofUsedDeclarationSet', audit.usedDeclarationCandidates,
    ),
    axioms: Object.freeze([...audit.axioms]),
    axiomAuditPresent: audit.axiomAuditPresent,
    nodes,
    edges,
    explanationDagHash: hashRecord('FormalReadableProofExplanationDag', { nodes, edges }),
    readableSteps,
    readableStepsHash: hashRecord('FormalReadableProofReadableSteps', readableSteps),
    certificateBundleHash: certificateBundle.certificateBundleHash,
    replayReceiptHash: replayReceipt.formalCertificateReplayReceiptHash,
    machineVerificationScope:
      'exact-type-source-and-kernel-elaborated-declaration-reference-dag-v1',
    naturalLanguageDerivationMachineProven: false,
  };
  return Object.freeze({
    ...payload,
    formalReadableProofExplanationHash:
      hashRecord('FormalReadableProofExplanation', payload),
  });
}

function certificateHashValid(bundle) {
  const { certificateBundleHash: claimedHash, ...payload } = bundle || {};
  return SHA256.test(String(claimedHash || ''))
    && claimedHash === hashRecord('FormalCertificateBundle', payload);
}

function replayHashValid(receipt, certificateBundleHash) {
  const { formalCertificateReplayReceiptHash: claimedHash, ...payload } = receipt || {};
  return receipt?.status === 'formal_claim_replay_verified'
    && receipt?.originalCertificateBundleHash === certificateBundleHash
    && SHA256.test(String(claimedHash || ''))
    && claimedHash === hashRecord('FormalCertificateReplayReceipt', payload);
}

function declarationFor(bundle, theoremName, claimId) {
  const matches = (bundle?.claimBindingReport?.bindings || [])
    .filter((item) => item?.theoremName === theoremName && item?.claimId === claimId);
  if (matches.length !== 1 || matches[0].valid !== true) return null;
  return Object.freeze({
    name: theoremName,
    typeHash: matches[0].declarationTypeHash,
    sourceStatementHash: matches[0].sourceStatementHash,
    axioms: Object.freeze([...(matches[0].axioms || [])]),
    normalizedType: null,
  });
}

function proofAuditValid(value, { binding, declaration, sourceFileHash, executionReceiptHash }) {
  const { leanProofPrintAuditHash: claimedHash, ...payload } = value || {};
  return value?.version === 1 && value?.kind === 'LeanReadableProofPrintAudit'
    && value?.status === 'lean_readable_proof_print_verified'
    && value.claimId === binding?.claimId && value.theoremName === binding?.theoremName
    && value.sourceFile === binding?.sourceFile && value.theoremTypeHash === declaration?.typeHash
    && value.sourceStatementHash === declaration?.sourceStatementHash
    && value.sourceFileHash === sourceFileHash
    && value.executionReceiptHash === executionReceiptHash
    && value.proofPrintTextHash === hashBytes(Buffer.from(String(value.proofPrintText || ''), 'utf8'))
    && Array.isArray(value.printedIdentifiers)
    && Array.isArray(value.usedDeclarationCandidates)
    && Array.isArray(value.axioms) && value.axiomAuditPresent === true
    && JSON.stringify(value.axioms) === JSON.stringify([...(declaration?.axioms || [])].sort())
    && value.machineExtractionScope
      === 'lean-kernel-elaborated-declaration-pretty-print-reference-graph-v1'
    && claimedHash === hashRecord('LeanReadableProofPrintAudit', payload);
}

export function buildFormalReadableProofExplanationBundle({
  certificateBundle,
  replayReceipt,
} = {}) {
  const blockers = [];
  if (!certificateHashValid(certificateBundle)
    || certificateBundle?.status !== 'formal_claim_verified') {
    blockers.push('formal_readable_proof_certificate_invalid');
  }
  if (!replayHashValid(replayReceipt, certificateBundle?.certificateBundleHash)) {
    blockers.push('formal_readable_proof_replay_invalid');
  }
  const bindings = Array.isArray(certificateBundle?.claimBindings)
    ? certificateBundle.claimBindings : [];
  const audits = Array.isArray(certificateBundle?.leanReadableProofPrintAudits)
    ? certificateBundle.leanReadableProofPrintAudits : [];
  if (!bindings.length || audits.length !== bindings.length) {
    blockers.push('formal_readable_proof_audit_coverage_invalid');
  }
  const explanations = [];
  bindings.forEach((binding, index) => {
    const audit = audits[index];
    const declaration = declarationFor(
      certificateBundle, binding?.theoremName, binding?.claimId,
    );
    const sourceFile = (certificateBundle?.projectFiles || []).find((file) => (
      (file.projectPath ?? file.path) === binding?.sourceFile
    ));
    if (!proofAuditValid(audit, {
      binding,
      declaration,
      sourceFileHash: sourceFile?.hash || null,
      executionReceiptHash: certificateBundle?.executionReceiptHash || null,
    })) {
      blockers.push(`formal_readable_proof_audit_invalid:${binding?.claimId || index}`);
      return;
    }
    const explanation = claimExplanation({
      audit, binding, declaration, certificateBundle, replayReceipt,
    });
    if (!explanation) blockers.push(`formal_readable_proof_explanation_blocked:${binding?.claimId || index}`);
    else explanations.push(explanation);
  });
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const payload = {
    version: 1,
    kind: 'FormalReadableProofExplanationBundle',
    status: uniqueBlockers.length
      ? 'formal_readable_proof_explanation_bundle_blocked'
      : 'formal_readable_proof_explanation_bundle_verified',
    certificateBundleHash: certificateBundle?.certificateBundleHash || null,
    replayReceiptHash: replayReceipt?.formalCertificateReplayReceiptHash || null,
    proofPrintAuditSetHash: certificateBundle?.leanReadableProofPrintAuditSetHash || null,
    theoremCount: explanations.length,
    explanations: Object.freeze(explanations),
    explanationDependencyGraphHash: hashRecord(
      'FormalReadableProofExplanationDependencyGraph',
      explanations.map((explanation) => ({
        claimId: explanation.claimId,
        theoremName: explanation.theoremName,
        usedDeclarations: explanation.usedDeclarations,
        explanationDagHash: explanation.explanationDagHash,
      })),
    ),
    productionReadableProofReady: uniqueBlockers.length === 0,
    machineVerificationScope:
      'kernel-bound-readable-proof-projection-not-natural-language-equivalence-v1',
    limitations: Object.freeze([
      'The DAG is a deterministic readable projection of the kernel-elaborated declaration printout.',
      'Printed identifier references are not claimed to be a complete semantic proof-term dependency graph.',
      'Natural-language mathematical equivalence remains outside the Lean kernel proof.',
    ]),
    blockers: uniqueBlockers,
  };
  return Object.freeze({
    ...payload,
    formalReadableProofExplanationBundleHash:
      hashRecord('FormalReadableProofExplanationBundle', payload),
  });
}

function graphValid(explanation) {
  if (!Array.isArray(explanation?.nodes) || !Array.isArray(explanation?.edges)
    || explanation.nodes.length < 3 || !explanation.nodes.some((item) => item.kind === 'formal_goal')
    || !explanation.nodes.some((item) => item.kind === 'proof_expression')
    || !explanation.nodes.some((item) => item.kind === 'kernel_replay_closure')) return false;
  const ids = new Set();
  for (const item of explanation.nodes) {
    if (!NODE_KINDS.has(item?.kind) || ids.has(item?.nodeId)
      || item?.labelHash !== hashBytes(Buffer.from(String(item?.label || ''), 'utf8'))
      || item?.detailHash !== (item?.detail === null
        ? null : hashBytes(Buffer.from(String(item?.detail || ''), 'utf8')))) return false;
    const { nodeId, ...payload } = item;
    if (nodeId !== `proof-node:${hashRecord('FormalReadableProofExplanationNode', payload).slice(7)}`) return false;
    ids.add(nodeId);
  }
  return explanation.edges.every((item) => ids.has(item?.from) && ids.has(item?.to)
    && item?.edgeHash === hashRecord('FormalReadableProofExplanationEdge', {
      from: item.from, to: item.to, relation: item.relation,
    }));
}

export function verifyFormalReadableProofExplanationBundle(value, {
  certificateBundle,
  replayReceipt,
} = {}) {
  const blockers = [];
  const { formalReadableProofExplanationBundleHash: claimedHash, ...payload } = value || {};
  if (!value || value.version !== 1 || value.kind !== 'FormalReadableProofExplanationBundle'
    || value.status !== 'formal_readable_proof_explanation_bundle_verified'
    || value.productionReadableProofReady !== true
    || value.machineVerificationScope
      !== 'kernel-bound-readable-proof-projection-not-natural-language-equivalence-v1'
    || !Array.isArray(value.explanations) || !value.explanations.length
    || Number(value.theoremCount) !== value.explanations.length
    || (value.blockers || []).length
    || claimedHash !== hashRecord('FormalReadableProofExplanationBundle', payload)) {
    blockers.push('formal_readable_proof_explanation_bundle_shape_invalid');
  }
  for (const explanation of value?.explanations || []) {
    const { formalReadableProofExplanationHash: explanationHash, ...explanationPayload } = explanation;
    if (!graphValid(explanation)
      || !SHA256.test(String(explanation?.theoremTypeHash || ''))
      || !SHA256.test(String(explanation?.sourceFileHash || ''))
      || !SHA256.test(String(explanation?.sourceStatementHash || ''))
      || explanation?.theoremTypeSourceHash
        !== hashBytes(Buffer.from(String(explanation?.theoremTypeSource || ''), 'utf8'))
      || explanation?.proofPrintTextHash
        !== hashBytes(Buffer.from(String(explanation?.proofPrintText || ''), 'utf8'))
      || !Array.isArray(explanation?.usedDeclarations)
      || explanation?.usedDeclarationSetHash !== hashRecord(
        'FormalReadableProofUsedDeclarationSet', explanation?.usedDeclarations || [],
      )
      || !Array.isArray(explanation?.axioms) || explanation?.axiomAuditPresent !== true
      || explanation?.explanationDagHash !== hashRecord(
        'FormalReadableProofExplanationDag', {
          nodes: explanation?.nodes || [], edges: explanation?.edges || [],
        },
      )
      || !Array.isArray(explanation?.readableSteps)
      || explanation?.readableStepsHash !== hashRecord(
        'FormalReadableProofReadableSteps', explanation?.readableSteps || [],
      )
      || explanation?.certificateBundleHash !== value?.certificateBundleHash
      || explanation?.replayReceiptHash !== value?.replayReceiptHash
      || explanation.naturalLanguageDerivationMachineProven !== false
      || explanation.machineVerificationScope
        !== 'exact-type-source-and-kernel-elaborated-declaration-reference-dag-v1'
      || explanationHash !== hashRecord('FormalReadableProofExplanation', explanationPayload)) {
      blockers.push(`formal_readable_proof_explanation_invalid:${explanation?.claimId || 'missing'}`);
    }
  }
  const dependencyGraphHash = hashRecord(
    'FormalReadableProofExplanationDependencyGraph',
    (value?.explanations || []).map((explanation) => ({
      claimId: explanation.claimId,
      theoremName: explanation.theoremName,
      usedDeclarations: explanation.usedDeclarations,
      explanationDagHash: explanation.explanationDagHash,
    })),
  );
  if (value?.explanationDependencyGraphHash !== dependencyGraphHash
    || !SHA256.test(String(value?.certificateBundleHash || ''))
    || !SHA256.test(String(value?.replayReceiptHash || ''))
    || !SHA256.test(String(value?.proofPrintAuditSetHash || ''))) {
    blockers.push('formal_readable_proof_explanation_dependency_binding_invalid');
  }
  if (certificateBundle || replayReceipt) {
    const rebuilt = buildFormalReadableProofExplanationBundle({ certificateBundle, replayReceipt });
    if (rebuilt.status !== 'formal_readable_proof_explanation_bundle_verified'
      || JSON.stringify(rebuilt) !== JSON.stringify(value)) {
      blockers.push('formal_readable_proof_explanation_rebuild_mismatch');
    }
  }
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze([...new Set(blockers)]) });
}
