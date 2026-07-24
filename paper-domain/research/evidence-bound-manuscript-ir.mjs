import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAgentExecutionReceipt,
  verifyAgentWorkspacePostimageBinding,
} from '../evidence/agent-execution-receipt-contract.mjs';
import {
  verifyPriorArtEvidenceReceipt,
} from './prior-art-evidence-contract.mjs';

export const EVIDENCE_BOUND_MANUSCRIPT_IR_DRAFT_PATH = 'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json';
export const EVIDENCE_BOUND_MANUSCRIPT_IR_PATH = 'AUTONOMOUS_MANUSCRIPT_IR.json';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const CLAIM_CLASSES = new Set([
  'interpretation', 'limitation', 'method', 'related_work', 'reproducibility', 'scope',
]);
const SLOT_TYPES = Object.freeze([
  'empirical_claims',
  'formal_support',
  'empirical_results',
]);
const DRAFT_KEYS = Object.freeze(['kind', 'paperId', 'sections', 'title', 'version']);
const SECTION_KEYS = Object.freeze(['blocks', 'heading', 'sectionId']);
const PROSE_KEYS = Object.freeze(['blockId', 'claimClass', 'evidenceRefs', 'text', 'type']);
const CITATION_KEYS = Object.freeze(['blockId', 'evidenceRefs', 'text', 'type', 'workIds']);
const SLOT_KEYS = Object.freeze(['blockId', 'slot', 'type']);
const AUTHORITY_BINDING_KEYS = Object.freeze(['hash', 'kind']);

function canonicalHash(value) {
  const candidate = String(value || '').toLowerCase();
  return SHA256.test(candidate) ? candidate : null;
}

function canonicalId(value) {
  const candidate = String(value || '').trim();
  return SAFE_ID.test(candidate) ? candidate : null;
}

function normalizedText(value, maximum = 16_000) {
  const text = String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  return text && text.length <= maximum ? text : null;
}

function uniqueHashes(values) {
  if (!Array.isArray(values) || !values.length || values.length > 64) return null;
  const hashes = values.map(canonicalHash);
  if (hashes.some((hash) => !hash) || new Set(hashes).size !== hashes.length) return null;
  return Object.freeze([...hashes].sort());
}

function uniqueIds(values, maximum = 128) {
  if (!Array.isArray(values) || !values.length || values.length > maximum) return null;
  const ids = values.map(canonicalId);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return null;
  return Object.freeze(ids);
}

function canonicalBlock(value) {
  const type = String(value?.type || '');
  const blockId = canonicalId(value?.blockId);
  if (!blockId) return null;
  if (type === 'slot') {
    if (!hasExactObjectKeys(value, SLOT_KEYS) || !SLOT_TYPES.includes(value.slot)) return null;
    return Object.freeze({ type, blockId, slot: value.slot });
  }
  if (type === 'prose') {
    const text = normalizedText(value.text);
    const evidenceRefs = uniqueHashes(value.evidenceRefs);
    if (!hasExactObjectKeys(value, PROSE_KEYS) || !CLAIM_CLASSES.has(value.claimClass)
      || !text || !evidenceRefs) return null;
    return Object.freeze({
      type,
      blockId,
      claimClass: value.claimClass,
      text,
      evidenceRefs,
    });
  }
  if (type === 'citation') {
    const text = normalizedText(value.text);
    const evidenceRefs = uniqueHashes(value.evidenceRefs);
    const workIds = uniqueIds(value.workIds);
    if (!hasExactObjectKeys(value, CITATION_KEYS) || !text || !evidenceRefs || !workIds) return null;
    return Object.freeze({ type, blockId, text, workIds, evidenceRefs });
  }
  return null;
}

function canonicalSection(value) {
  if (!hasExactObjectKeys(value, SECTION_KEYS)) return null;
  const sectionId = canonicalId(value.sectionId);
  const heading = normalizedText(value.heading, 300);
  const blocks = Array.isArray(value.blocks) && value.blocks.length <= 128
    ? value.blocks.map(canonicalBlock) : [];
  if (!sectionId || !heading || !blocks.length || blocks.some((block) => !block)) return null;
  return Object.freeze({ sectionId, heading, blocks: Object.freeze(blocks) });
}

function canonicalDraft(value) {
  const blockers = [];
  if (!hasExactObjectKeys(value, DRAFT_KEYS)
    || value?.version !== 1 || value?.kind !== 'EvidenceBoundManuscriptIRDraft') {
    blockers.push('evidence_bound_manuscript_ir_draft_shape_invalid');
  }
  const paperId = canonicalId(value?.paperId);
  const title = normalizedText(value?.title, 500);
  const sections = Array.isArray(value?.sections) && value.sections.length >= 3
    && value.sections.length <= 32 ? value.sections.map(canonicalSection) : [];
  if (!paperId) blockers.push('evidence_bound_manuscript_ir_paper_id_invalid');
  if (!title) blockers.push('evidence_bound_manuscript_ir_title_invalid');
  if (!sections.length || sections.some((section) => !section)) {
    blockers.push('evidence_bound_manuscript_ir_sections_invalid');
  }
  const validSections = sections.filter(Boolean);
  const sectionIds = validSections.map((section) => section.sectionId);
  const blockIds = validSections.flatMap((section) => section.blocks.map((block) => block.blockId));
  const slots = validSections.flatMap((section) => section.blocks
    .filter((block) => block.type === 'slot').map((block) => block.slot));
  if (new Set(sectionIds).size !== sectionIds.length) {
    blockers.push('evidence_bound_manuscript_ir_section_ids_duplicate');
  }
  if (new Set(blockIds).size !== blockIds.length) {
    blockers.push('evidence_bound_manuscript_ir_block_ids_duplicate');
  }
  for (const requiredSlot of SLOT_TYPES) {
    if (slots.filter((slot) => slot === requiredSlot).length !== 1) {
      blockers.push(`evidence_bound_manuscript_ir_${requiredSlot}_slot_invalid`);
    }
  }
  if (!validSections.some((section) => section.blocks
    .some((block) => block.type === 'prose' && block.claimClass === 'limitation'))) {
    blockers.push('evidence_bound_manuscript_ir_limitations_required');
  }
  return Object.freeze({
    paperId,
    title,
    sections: Object.freeze(validSections),
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

function canonicalAuthorityBindings(values) {
  if (!Array.isArray(values) || !values.length || values.length > 512) return null;
  const bindings = values.map((value) => {
    if (!hasExactObjectKeys(value, AUTHORITY_BINDING_KEYS)) return null;
    const kind = canonicalId(value.kind);
    const hash = canonicalHash(value.hash);
    return kind && hash ? Object.freeze({ kind, hash }) : null;
  });
  if (bindings.some((binding) => !binding)) return null;
  const keys = bindings.map((binding) => `${binding.kind}:${binding.hash}`);
  if (new Set(keys).size !== keys.length) return null;
  return Object.freeze([...bindings].sort((left, right) => (
    left.kind.localeCompare(right.kind) || left.hash.localeCompare(right.hash)
  )));
}

function agentReceiptVerification(receipt) {
  if (!receipt) return Object.freeze({ valid: true, receiptHash: null });
  return Object.freeze({
    valid: verifyAgentExecutionReceipt(receipt),
    receiptHash: receipt.agentExecutionReceiptHash || null,
  });
}

function canonicalAuthorship({ agentExecutionReceipt, sourceDraftHash } = {}) {
  const receiptVerification = agentReceiptVerification(agentExecutionReceipt);
  if (!receiptVerification.valid) return null;
  const changedPaths = Array.isArray(agentExecutionReceipt?.changedPaths)
    ? agentExecutionReceipt.changedPaths.map(String) : [];
  const agentModifiedDraft = changedPaths.includes(EVIDENCE_BOUND_MANUSCRIPT_IR_DRAFT_PATH);
  const postimageBinding = agentExecutionReceipt?.agentWorkspacePostimageBinding || null;
  if (agentModifiedDraft && !verifyAgentWorkspacePostimageBinding(postimageBinding, {
    requiredPath: EVIDENCE_BOUND_MANUSCRIPT_IR_DRAFT_PATH,
    requiredHash: sourceDraftHash,
  })) return null;
  return Object.freeze({
    mode: agentModifiedDraft ? 'agent-authored-evidence-bound-prose' : 'system-seeded-evidence-bound-prose',
    agentModifiedDraft,
    agentExecutionReceiptHash: receiptVerification.receiptHash,
    principalId: agentExecutionReceipt?.agentId || agentExecutionReceipt?.principalId || null,
    model: agentExecutionReceipt?.resolvedModel || agentExecutionReceipt?.model || null,
    promptHash: agentExecutionReceipt?.promptHash || null,
    sourceDraftHash,
    agentWorkspacePostimageBindingHash:
      postimageBinding?.agentWorkspacePostimageBindingHash || null,
  });
}

function evidenceReferenceBlockers(sections, authorityBindings, priorArtReceipt) {
  const blockers = [];
  const allowed = new Set(authorityBindings.map((binding) => binding.hash));
  const priorArtVerification = priorArtReceipt
    ? verifyPriorArtEvidenceReceipt(priorArtReceipt) : null;
  const works = new Map((priorArtReceipt?.works || []).map((work) => [work.workId, work]));
  for (const block of sections.flatMap((section) => section.blocks)) {
    if (block.type === 'slot') continue;
    for (const hash of block.evidenceRefs) {
      if (!allowed.has(hash)) blockers.push(`evidence_bound_manuscript_ir_unknown_evidence:${block.blockId}`);
    }
    if (block.type !== 'citation') continue;
    if (!priorArtVerification?.ready) {
      blockers.push(`evidence_bound_manuscript_ir_verified_prior_art_required:${block.blockId}`);
      continue;
    }
    for (const workId of block.workIds) {
      const work = works.get(workId);
      if (!work || !block.evidenceRefs.includes(work.priorArtWorkRecordHash)
        || !block.evidenceRefs.includes(priorArtReceipt.priorArtEvidenceReceiptHash)) {
        blockers.push(`evidence_bound_manuscript_ir_citation_binding_invalid:${block.blockId}:${workId}`);
      }
    }
  }
  return blockers;
}

function canonicalSectionsWithHashes(sections) {
  return Object.freeze(sections.map((section) => Object.freeze({
    ...section,
    blocks: Object.freeze(section.blocks.map((block) => Object.freeze({
      ...block,
      manuscriptIrBlockHash: hashRecord('EvidenceBoundManuscriptIRBlock', block),
    }))),
  })));
}

export function buildEvidenceBoundManuscriptIrDraft({
  paperId,
  title,
  sections,
} = {}) {
  const source = { version: 1, kind: 'EvidenceBoundManuscriptIRDraft', paperId, title, sections };
  const canonical = canonicalDraft(source);
  if (canonical.blockers.length) {
    throw new Error(`evidence_bound_manuscript_ir_draft_invalid:${canonical.blockers.join(',')}`);
  }
  return Object.freeze({
    version: 1,
    kind: 'EvidenceBoundManuscriptIRDraft',
    paperId: canonical.paperId,
    title: canonical.title,
    sections: canonical.sections,
  });
}

export function finalizeEvidenceBoundManuscriptIr({
  draft,
  authorityBindings,
  priorArtReceipt = null,
  agentExecutionReceipt = null,
} = {}) {
  const canonical = canonicalDraft(draft);
  const bindings = canonicalAuthorityBindings(authorityBindings);
  const sourceDraftHash = hashBytes(Buffer.from(JSON.stringify(draft || null), 'utf8'));
  const authorship = canonicalAuthorship({ agentExecutionReceipt, sourceDraftHash });
  const blockers = [...canonical.blockers];
  if (!bindings) blockers.push('evidence_bound_manuscript_ir_authority_bindings_invalid');
  if (!authorship) blockers.push('evidence_bound_manuscript_ir_agent_receipt_invalid');
  if (bindings) blockers.push(...evidenceReferenceBlockers(
    canonical.sections,
    bindings,
    priorArtReceipt,
  ));
  const sections = canonicalSectionsWithHashes(canonical.sections);
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const payload = {
    version: 1,
    kind: 'EvidenceBoundManuscriptIR',
    status: uniqueBlockers.length
      ? 'evidence_bound_manuscript_ir_blocked'
      : 'evidence_bound_manuscript_ir_verified',
    paperId: canonical.paperId,
    title: canonical.title,
    sections,
    sectionCount: sections.length,
    blockCount: sections.reduce((count, section) => count + section.blocks.length, 0),
    authorityBindings: bindings || Object.freeze([]),
    authorityBindingSetHash: bindings
      ? hashRecord('EvidenceBoundManuscriptIRAuthorityBindings', bindings) : null,
    priorArtEvidenceReceiptHash: priorArtReceipt?.priorArtEvidenceReceiptHash || null,
    authorship,
    sourceDraftHash,
    unboundScientificProseAccepted: false,
    openWorldNoveltyClaimed: false,
    blockers: uniqueBlockers,
  };
  return Object.freeze({
    ...payload,
    evidenceBoundManuscriptIrHash: hashRecord('EvidenceBoundManuscriptIR', payload),
  });
}

export function verifyEvidenceBoundManuscriptIr(ir, {
  paperId = null,
  authorityBindings = null,
  priorArtReceipt = null,
  agentExecutionReceipt = null,
  requireAgentAuthoredProse = false,
} = {}) {
  const blockers = [];
  const { evidenceBoundManuscriptIrHash: claimedHash, ...payload } = ir || {};
  if (!canonicalHash(claimedHash)
    || hashRecord('EvidenceBoundManuscriptIR', payload) !== claimedHash) {
    blockers.push('evidence_bound_manuscript_ir_hash_invalid');
  }
  const draft = ir ? {
    version: 1,
    kind: 'EvidenceBoundManuscriptIRDraft',
    paperId: ir.paperId,
    title: ir.title,
    sections: (ir.sections || []).map((section) => ({
      sectionId: section.sectionId,
      heading: section.heading,
      blocks: (section.blocks || []).map(({ manuscriptIrBlockHash: _hash, ...block }) => block),
    })),
  } : null;
  const expectedBindings = authorityBindings || ir?.authorityBindings || [];
  const rebuilt = finalizeEvidenceBoundManuscriptIr({
    draft,
    authorityBindings: expectedBindings,
    priorArtReceipt,
    agentExecutionReceipt,
  });
  if (JSON.stringify(rebuilt) !== JSON.stringify(ir)) {
    blockers.push('evidence_bound_manuscript_ir_not_canonical');
  }
  if (paperId && ir?.paperId !== paperId) blockers.push('evidence_bound_manuscript_ir_paper_mismatch');
  if (requireAgentAuthoredProse && ir?.authorship?.agentModifiedDraft !== true) {
    blockers.push('evidence_bound_manuscript_ir_agent_authorship_required');
  }
  if (ir?.status !== 'evidence_bound_manuscript_ir_verified' || ir?.blockers?.length) {
    blockers.push('evidence_bound_manuscript_ir_not_verified');
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    valid: uniqueBlockers.length === 0,
    status: uniqueBlockers.length
      ? 'evidence_bound_manuscript_ir_verification_blocked'
      : 'evidence_bound_manuscript_ir_verification_verified',
    evidenceBoundManuscriptIrHash: claimedHash || null,
    blockers: uniqueBlockers,
  });
}

export function latexEscapeEvidenceBoundText(value) {
  return String(value || '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([#$%&_{}])/g, '\\$1')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}');
}

function citationIdentity(work) {
  return work.identifiers.doi || work.identifiers.arxiv
    || work.identifiers.openAlex || work.identifiers.url;
}

export function evidenceBoundManuscriptBlockBody(block, { priorArtReceipt = null } = {}) {
  if (block?.type === 'prose') return latexEscapeEvidenceBoundText(block.text);
  if (block?.type !== 'citation') throw new Error('evidence_bound_manuscript_ir_block_not_renderable');
  const works = new Map((priorArtReceipt?.works || []).map((work) => [work.workId, work]));
  const citations = block.workIds.map((workId) => {
    const work = works.get(workId);
    if (!work) throw new Error(`evidence_bound_manuscript_ir_citation_work_missing:${workId}`);
    const authors = work.authors.join(', ');
    const year = work.year === null ? 'n.d.' : String(work.year);
    return `${authors} (${year}), ${work.title}; ${citationIdentity(work)}`;
  });
  return `${latexEscapeEvidenceBoundText(block.text)} `
    + citations.map((citation) => `[${latexEscapeEvidenceBoundText(citation)}]`).join(' ');
}

export function evidenceBoundManuscriptMarkerDeclaration(block) {
  if (!block?.manuscriptIrBlockHash || !canonicalHash(block.manuscriptIrBlockHash)) {
    throw new Error('evidence_bound_manuscript_ir_block_hash_required');
  }
  return Object.freeze({
    version: 1,
    blockId: block.blockId,
    blockHash: block.manuscriptIrBlockHash,
  });
}

export function evidenceBoundManuscriptMarkerDeclarationValid(declaration, ir) {
  if (!declaration || declaration.version !== 1 || !canonicalId(declaration.blockId)
    || !canonicalHash(declaration.blockHash)) return false;
  const block = (ir?.sections || []).flatMap((section) => section.blocks || [])
    .find((candidate) => candidate.blockId === declaration.blockId);
  return Boolean(block && block.type !== 'slot'
    && block.manuscriptIrBlockHash === declaration.blockHash);
}

export function evidenceBoundManuscriptSectionHeadings(ir) {
  return Object.freeze((ir?.sections || []).map((section) => section.heading));
}
