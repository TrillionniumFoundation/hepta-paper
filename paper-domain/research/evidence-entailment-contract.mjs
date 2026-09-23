import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  evidenceEntailmentSourceFact,
  verifyEvidenceEntailmentSourceDocument,
} from './evidence-entailment-source-document.mjs';

export const EVIDENCE_ENTAILMENT_CONTRACT_PATH =
  'AUTONOMOUS_MANUSCRIPT_ENTAILMENT.json';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const CONTRACT_KEYS = Object.freeze([
  'allRenderedBlocksCovered',
  'blockCoverageHash',
  'blockCount',
  'blockers',
  'claims',
  'evidenceBoundManuscriptIrHash',
  'kind',
  'machineSemanticEntailmentEstablished',
  'machineVerificationScope',
  'paperId',
  'predicateCoverageMode',
  'sourceManuscriptIr',
  'sourceEvidenceDocumentCount',
  'sourceEvidenceDocuments',
  'sourceEvidenceDocumentSetHash',
  'status',
  'untypedRenderedBlockCount',
  'version',
]);
const CLAIM_KEYS = Object.freeze([
  'blockId',
  'blockType',
  'claimClass',
  'claimId',
  'evidencePredicates',
  'evidenceRefs',
  'kind',
  'manuscriptIrBlockHash',
  'predicateMode',
  'renderedSentence',
  'renderedSentenceHash',
  'sectionId',
  'typedEvidenceEntailmentClaimHash',
  'version',
  'workIds',
]);
const PREDICATE_KEYS = Object.freeze([
  'actualValue',
  'denominator',
  'evidenceHash',
  'evidenceKind',
  'expectedValue',
  'fieldPath',
  'kind',
  'operator',
  'predicateId',
  'predicateType',
  'satisfied',
  'sourceDocumentHash',
  'sourceFactHash',
  'unit',
  'valueType',
  'typedEvidenceFieldPredicateHash',
  'version',
]);
const CLAIM_CLASS_EVIDENCE_KINDS = Object.freeze({
  interpretation: new Set([
    'empirical_assertion_authority', 'empirical_assertion_authority_entry',
    'empirical_claim_lineage', 'empirical_manuscript_claim',
    'empirical_original_analysis', 'empirical_original_artifact',
    'empirical_replay_analysis', 'empirical_replay_artifact',
    'formal_support_authority', 'formal_verification', 'formal_kernel_replay',
  ]),
  limitation: new Set([
    'policy_authorization', 'prior_art', 'proposal', 'proposal_claim_record',
    'seed_bundle', 'empirical_claim_lineage', 'empirical_assertion_authority',
    'empirical_original_analysis', 'empirical_replay_analysis',
    'formal_support_authority', 'formal_verification', 'formal_kernel_replay',
  ]),
  method: new Set([
    'proposal', 'proposal_claim_record', 'policy_authorization', 'seed_bundle',
    'empirical_analysis_protocol', 'empirical_original_execution',
    'empirical_replay_execution',
  ]),
  related_work: new Set(['prior_art']),
  reproducibility: new Set([
    'seed_bundle', 'empirical_assertion_authority',
    'empirical_original_execution', 'empirical_original_artifact',
    'empirical_replay_execution', 'empirical_replay_artifact',
    'formal_verification', 'formal_kernel_replay',
  ]),
  scope: new Set([
    'proposal', 'proposal_claim_record', 'policy_authorization', 'seed_bundle',
  ]),
});

export function evidenceEntailmentClaimClassesForEvidenceKind(value) {
  const kind = safeId(value);
  if (!kind) return Object.freeze([]);
  return Object.freeze(Object.entries(CLAIM_CLASS_EVIDENCE_KINDS)
    .filter(([, evidenceKinds]) => evidenceKinds.has(kind))
    .map(([claimClass]) => claimClass)
    .sort());
}

function sha(value) {
  const candidate = String(value || '').toLowerCase();
  return SHA256.test(candidate) ? candidate : null;
}

function safeId(value) {
  const candidate = String(value || '').trim();
  return SAFE_ID.test(candidate) ? candidate : null;
}

function sourceIrHashValid(ir) {
  const { evidenceBoundManuscriptIrHash: claimedHash, ...payload } = ir || {};
  const sections = Array.isArray(ir?.sections) ? ir.sections : [];
  const blocks = sections.flatMap((section) => (
    Array.isArray(section?.blocks) ? section.blocks : []
  ));
  const blockHashesValid = blocks.every((block) => {
    const { manuscriptIrBlockHash: blockHash, ...blockPayload } = block || {};
    return Boolean(sha(blockHash)
      && hashRecord('EvidenceBoundManuscriptIRBlock', blockPayload) === blockHash);
  });
  const bindings = Array.isArray(ir?.authorityBindings) ? ir.authorityBindings : [];
  const bindingRowsValid = bindings.length > 0 && bindings.every((binding) => (
    safeId(binding?.kind) && sha(binding?.hash)
  ));
  const bindingKeys = bindings.map((binding) => `${binding.kind}:${binding.hash}`);
  return Boolean(sha(claimedHash)
    && hashRecord('EvidenceBoundManuscriptIR', payload) === claimedHash
    && ir?.status === 'evidence_bound_manuscript_ir_verified'
    && Array.isArray(ir?.blockers) && ir.blockers.length === 0
    && sections.length >= 3
    && ir?.sectionCount === sections.length
    && ir?.blockCount === blocks.length
    && blockHashesValid
    && bindingRowsValid
    && new Set(bindingKeys).size === bindingKeys.length
    && ir?.authorityBindingSetHash
      === hashRecord('EvidenceBoundManuscriptIRAuthorityBindings', bindings));
}

function canonicalBindingRows(ir) {
  return (Array.isArray(ir?.authorityBindings) ? ir.authorityBindings : []).map(
    (binding, index) => Object.freeze({
      index,
      kind: safeId(binding?.kind),
      hash: sha(binding?.hash),
    }),
  );
}

function predicateFor({
  blockId,
  evidenceHash,
  binding,
  evidenceOrdinal,
  fact,
  factOrdinal,
  sourceDocument,
}) {
  const payload = {
    version: 2,
    kind: 'TypedEvidenceFieldPredicate',
    predicateId: `${String(blockId).slice(0, 128)}:evidence:${
      evidenceOrdinal + 1}:field:${factOrdinal + 1}`,
    evidenceKind: binding.kind,
    evidenceHash,
    sourceDocumentHash: sourceDocument.sourceDocumentHash,
    sourceFactHash: fact.sourceFactHash,
    fieldPath: fact.fieldPath,
    predicateType: 'typed_source_document_field_predicate',
    operator: fact.operator,
    expectedValue: fact.value,
    actualValue: fact.value,
    valueType: fact.valueType,
    unit: fact.unit,
    denominator: fact.denominator,
    satisfied: binding.hash === evidenceHash,
  };
  return Object.freeze({
    ...payload,
    typedEvidenceFieldPredicateHash:
      hashRecord('TypedEvidenceFieldPredicate', payload),
  });
}

function claimFor({ section, block, bindingsByHash, documentsByBinding, blockers }) {
  const evidenceRefs = Array.isArray(block?.evidenceRefs)
    ? Object.freeze(block.evidenceRefs.map(String)) : Object.freeze([]);
  const blockType = block?.type === 'citation' ? 'citation' : 'prose';
  const claimClass = blockType === 'citation' ? 'related_work' : block.claimClass;
  const allowedEvidenceKinds = CLAIM_CLASS_EVIDENCE_KINDS[claimClass] || new Set();
  const evidencePredicates = evidenceRefs.flatMap((evidenceHash, evidenceOrdinal) => {
    const candidates = bindingsByHash.get(evidenceHash) || [];
    const binding = candidates.find((candidate) => (
      allowedEvidenceKinds.has(candidate.kind)
    )) || candidates[0] || null;
    if (!binding) {
      blockers.push(`evidence_entailment_authority_field_missing:${block.blockId}:${evidenceHash}`);
      return [];
    }
    if (!allowedEvidenceKinds.has(binding.kind)) {
      blockers.push(`evidence_entailment_evidence_kind_not_allowed:${
        block.blockId}:${claimClass}:${binding.kind}`);
    }
    const sourceDocument = documentsByBinding.get(`${binding.kind}:${evidenceHash}`) || null;
    if (!sourceDocument) {
      blockers.push(`evidence_entailment_source_document_missing:${
        block.blockId}:${binding.kind}:${evidenceHash}`);
      return [];
    }
    return sourceDocument.facts.map((fact, factOrdinal) => predicateFor({
      blockId: block.blockId,
      evidenceHash,
      binding,
      evidenceOrdinal,
      fact,
      factOrdinal,
      sourceDocument,
    }));
  });
  if (!evidenceRefs.length) blockers.push(`evidence_entailment_evidence_required:${block.blockId}`);
  if (evidenceRefs.some((evidenceHash) => !evidencePredicates.some((predicate) => (
    predicate.evidenceHash === evidenceHash
  ))) || evidencePredicates.some((predicate) => predicate.satisfied !== true)) {
    blockers.push(`evidence_entailment_predicate_coverage_invalid:${block.blockId}`);
  }
  const renderedSentence = String(block?.text || '').normalize('NFKC')
    .replace(/\s+/g, ' ').trim();
  if (!renderedSentence) blockers.push(`evidence_entailment_sentence_required:${block.blockId}`);
  const payload = {
    version: 2,
    kind: 'TypedEvidenceEntailmentClaim',
    claimId: `manuscript-block:${block.blockId}`,
    sectionId: section.sectionId,
    blockId: block.blockId,
    blockType,
    claimClass,
    renderedSentence,
    renderedSentenceHash: hashBytes(Buffer.from(renderedSentence, 'utf8')),
    manuscriptIrBlockHash: block.manuscriptIrBlockHash,
    evidenceRefs,
    predicateMode: 'all-source-fields',
    evidencePredicates: Object.freeze(evidencePredicates),
    workIds: Object.freeze(blockType === 'citation' ? [...block.workIds] : []),
  };
  return Object.freeze({
    ...payload,
    typedEvidenceEntailmentClaimHash:
      hashRecord('TypedEvidenceEntailmentClaim', payload),
  });
}

export function buildEvidenceEntailmentContract({
  manuscriptIr,
  sourceEvidenceDocuments = [],
} = {}) {
  const blockers = [];
  if (!sourceIrHashValid(manuscriptIr)) {
    blockers.push('evidence_entailment_source_ir_invalid');
  }
  const bindings = canonicalBindingRows(manuscriptIr);
  if (bindings.some((binding) => !binding.kind || !binding.hash)) {
    blockers.push('evidence_entailment_authority_binding_invalid');
  }
  const bindingsByHash = new Map();
  for (const binding of bindings) {
    if (binding.kind && binding.hash) {
      const candidates = bindingsByHash.get(binding.hash) || [];
      bindingsByHash.set(binding.hash, [...candidates, binding]);
    }
  }
  const documents = Array.isArray(sourceEvidenceDocuments)
    ? sourceEvidenceDocuments : [];
  if (!documents.length || documents.some((document) => (
    !verifyEvidenceEntailmentSourceDocument(document)
  ))) {
    blockers.push('evidence_entailment_source_documents_invalid');
  }
  const documentsByBinding = new Map();
  for (const document of documents) {
    const key = `${document?.evidenceKind}:${document?.evidenceHash}`;
    if (documentsByBinding.has(key)) {
      blockers.push(`evidence_entailment_source_document_duplicate:${key}`);
    } else {
      documentsByBinding.set(key, document);
    }
  }
  const renderedBlocks = (Array.isArray(manuscriptIr?.sections)
    ? manuscriptIr.sections : []).flatMap((section) => (
    (Array.isArray(section?.blocks) ? section.blocks : [])
      .filter((block) => block?.type !== 'slot')
      .map((block) => ({ section, block }))
  ));
  const claims = Object.freeze(renderedBlocks.map(({ section, block }) => claimFor({
    section,
    block,
    bindingsByHash,
    documentsByBinding,
    blockers,
  })));
  const claimIds = claims.map((claim) => claim.claimId);
  const blockIds = claims.map((claim) => claim.blockId);
  if (!claims.length) blockers.push('evidence_entailment_claims_required');
  if (new Set(claimIds).size !== claimIds.length
    || new Set(blockIds).size !== blockIds.length) {
    blockers.push('evidence_entailment_claim_coverage_duplicate');
  }
  const untypedRenderedBlockCount = renderedBlocks.length - claims.length;
  const allRenderedBlocksCovered = renderedBlocks.length > 0
    && claims.length === renderedBlocks.length
    && untypedRenderedBlockCount === 0
    && claims.every((claim) => claim.evidenceRefs.every((evidenceHash) => (
      claim.evidencePredicates.some((predicate) => predicate.evidenceHash === evidenceHash)
    )));
  if (!allRenderedBlocksCovered) blockers.push('evidence_entailment_rendered_block_coverage_invalid');
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const usedDocumentKeys = new Set(claims.flatMap((claim) => (
    claim.evidencePredicates.map((predicate) => (
      `${predicate.evidenceKind}:${predicate.evidenceHash}`
    ))
  )));
  const usedDocuments = Object.freeze([...documentsByBinding.entries()]
    .filter(([key]) => usedDocumentKeys.has(key))
    .map(([, document]) => document)
    .sort((left, right) => (
      `${left.evidenceKind}:${left.evidenceHash}`
        .localeCompare(`${right.evidenceKind}:${right.evidenceHash}`)
    )));
  const payload = {
    version: 2,
    kind: 'EvidenceEntailmentContract',
    status: uniqueBlockers.length
      ? 'evidence_entailment_contract_blocked'
      : 'evidence_entailment_contract_ready',
    paperId: manuscriptIr?.paperId || null,
    evidenceBoundManuscriptIrHash:
      manuscriptIr?.evidenceBoundManuscriptIrHash || null,
    sourceManuscriptIr: manuscriptIr || null,
    sourceEvidenceDocuments: usedDocuments,
    sourceEvidenceDocumentCount: usedDocuments.length,
    sourceEvidenceDocumentSetHash: hashRecord(
      'EvidenceEntailmentSourceDocumentSet',
      usedDocuments.map((document) => document.sourceDocumentHash),
    ),
    machineVerificationScope: 'typed-provenance-and-source-fields',
    machineSemanticEntailmentEstablished: false,
    predicateCoverageMode: 'all-evidence-refs-with-canonical-source-fields',
    blockCount: renderedBlocks.length,
    claims,
    allRenderedBlocksCovered,
    untypedRenderedBlockCount,
    blockCoverageHash: hashRecord('EvidenceEntailmentBlockCoverage', claims.map((claim) => ({
      claimId: claim.claimId,
      blockId: claim.blockId,
      manuscriptIrBlockHash: claim.manuscriptIrBlockHash,
      renderedSentenceHash: claim.renderedSentenceHash,
      evidenceRefs: claim.evidenceRefs,
      predicateHashes: claim.evidencePredicates.map((predicate) => (
        predicate.typedEvidenceFieldPredicateHash
      )),
    }))),
    blockers: uniqueBlockers,
  };
  return Object.freeze({
    ...payload,
    evidenceEntailmentContractHash:
      hashRecord('EvidenceEntailmentContract', payload),
  });
}

function predicateShapeValid(predicate, documentsByHash) {
  if (!hasExactObjectKeys(predicate, PREDICATE_KEYS)) return false;
  const { typedEvidenceFieldPredicateHash: claimedHash, ...payload } = predicate;
  const document = documentsByHash.get(predicate.sourceDocumentHash) || null;
  const fact = evidenceEntailmentSourceFact(document, predicate.sourceFactHash);
  return predicate.version === 2
    && predicate.kind === 'TypedEvidenceFieldPredicate'
    && Boolean(safeId(predicate.predicateId))
    && Boolean(safeId(predicate.evidenceKind))
    && Boolean(sha(predicate.evidenceHash))
    && Boolean(sha(predicate.sourceDocumentHash))
    && Boolean(sha(predicate.sourceFactHash))
    && document?.evidenceHash === predicate.evidenceHash
    && document?.evidenceKind === predicate.evidenceKind
    && predicate.fieldPath.startsWith('/')
    && predicate.predicateType === 'typed_source_document_field_predicate'
    && ['equals', 'array_length_equals'].includes(predicate.operator)
    && fact?.fieldPath === predicate.fieldPath
    && fact?.operator === predicate.operator
    && fact?.valueType === predicate.valueType
    && JSON.stringify(predicate.expectedValue) === JSON.stringify(fact?.value)
    && JSON.stringify(predicate.actualValue) === JSON.stringify(fact?.value)
    && JSON.stringify(predicate.unit) === JSON.stringify(fact?.unit)
    && JSON.stringify(predicate.denominator) === JSON.stringify(fact?.denominator)
    && predicate.satisfied === true
    && sha(claimedHash)
    && hashRecord('TypedEvidenceFieldPredicate', payload) === claimedHash;
}

function claimShapeValid(claim, documentsByHash) {
  if (!hasExactObjectKeys(claim, CLAIM_KEYS)) return false;
  const { typedEvidenceEntailmentClaimHash: claimedHash, ...payload } = claim;
  return claim.version === 2
    && claim.kind === 'TypedEvidenceEntailmentClaim'
    && Boolean(safeId(claim.claimId))
    && Boolean(safeId(claim.sectionId))
    && Boolean(safeId(claim.blockId))
    && ['prose', 'citation'].includes(claim.blockType)
    && Boolean(safeId(claim.claimClass))
    && Boolean(CLAIM_CLASS_EVIDENCE_KINDS[claim.claimClass])
    && claim.renderedSentenceHash
      === hashBytes(Buffer.from(String(claim.renderedSentence || ''), 'utf8'))
    && Boolean(sha(claim.manuscriptIrBlockHash))
    && claim.predicateMode === 'all-source-fields'
    && Array.isArray(claim.evidenceRefs) && claim.evidenceRefs.length > 0
    && Array.isArray(claim.evidencePredicates)
    && claim.evidencePredicates.length >= claim.evidenceRefs.length
    && claim.evidencePredicates.every((predicate) => (
      predicateShapeValid(predicate, documentsByHash)
    ))
    && claim.evidencePredicates.every((predicate) => (
      CLAIM_CLASS_EVIDENCE_KINDS[claim.claimClass].has(predicate.evidenceKind)
    ))
    && claim.evidenceRefs.every((evidenceHash) => claim.evidencePredicates.some((predicate) => (
      predicate.evidenceHash === evidenceHash
    )))
    && claim.evidencePredicates.every((predicate) => claim.evidenceRefs.includes(
      predicate.evidenceHash,
    ))
    && Array.isArray(claim.workIds)
    && sha(claimedHash)
    && hashRecord('TypedEvidenceEntailmentClaim', payload) === claimedHash;
}

export function verifyEvidenceEntailmentContract(contract, {
  evidenceBoundManuscriptIrHash = null,
  paperId = null,
} = {}) {
  const blockers = [];
  const { evidenceEntailmentContractHash: claimedHash, ...payload } = contract || {};
  if (!hasExactObjectKeys(payload, CONTRACT_KEYS)
    || !sha(claimedHash)
    || hashRecord('EvidenceEntailmentContract', payload) !== claimedHash) {
    blockers.push('evidence_entailment_contract_hash_invalid');
  }
  if (contract?.version !== 2 || contract?.kind !== 'EvidenceEntailmentContract') {
    blockers.push('evidence_entailment_contract_shape_invalid');
  }
  const documents = Array.isArray(contract?.sourceEvidenceDocuments)
    ? contract.sourceEvidenceDocuments : [];
  const documentsByHash = new Map(documents.map((document) => (
    [document?.sourceDocumentHash, document]
  )));
  if (!documents.length
    || documentsByHash.size !== documents.length
    || documents.some((document) => !verifyEvidenceEntailmentSourceDocument(document))
    || contract?.sourceEvidenceDocumentCount !== documents.length
    || contract?.sourceEvidenceDocumentSetHash !== hashRecord(
      'EvidenceEntailmentSourceDocumentSet',
      documents.map((document) => document.sourceDocumentHash),
    )) {
    blockers.push('evidence_entailment_source_document_set_invalid');
  }
  if (!Array.isArray(contract?.claims) || !contract.claims.every((claim) => (
    claimShapeValid(claim, documentsByHash)
  ))) {
    blockers.push('evidence_entailment_claim_shape_invalid');
  }
  let rebuilt = null;
  try {
    rebuilt = buildEvidenceEntailmentContract({
      manuscriptIr: contract?.sourceManuscriptIr,
      sourceEvidenceDocuments: documents,
    });
  } catch {
    blockers.push('evidence_entailment_contract_rebuild_failed');
  }
  if (!rebuilt || JSON.stringify(rebuilt) !== JSON.stringify(contract)) {
    blockers.push('evidence_entailment_contract_not_canonical');
  }
  if (paperId && contract?.paperId !== paperId) {
    blockers.push('evidence_entailment_contract_paper_mismatch');
  }
  if (evidenceBoundManuscriptIrHash
    && contract?.evidenceBoundManuscriptIrHash !== evidenceBoundManuscriptIrHash) {
    blockers.push('evidence_entailment_contract_ir_mismatch');
  }
  if (contract?.status !== 'evidence_entailment_contract_ready'
    || contract?.machineVerificationScope !== 'typed-provenance-and-source-fields'
    || contract?.machineSemanticEntailmentEstablished !== false
    || contract?.predicateCoverageMode
      !== 'all-evidence-refs-with-canonical-source-fields'
    || contract?.allRenderedBlocksCovered !== true
    || contract?.untypedRenderedBlockCount !== 0
    || contract?.blockCount !== contract?.claims?.length
    || contract?.blockers?.length) {
    blockers.push('evidence_entailment_contract_not_ready');
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    valid: uniqueBlockers.length === 0,
    status: uniqueBlockers.length
      ? 'evidence_entailment_contract_verification_blocked'
      : 'evidence_entailment_contract_verification_verified',
    evidenceEntailmentContractHash: claimedHash || null,
    blockCount: contract?.blockCount || 0,
    blockers: uniqueBlockers,
  });
}
