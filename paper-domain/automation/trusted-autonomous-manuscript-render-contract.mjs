import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAgentExecutionReceipt,
  verifyAgentWorkspacePostimageBinding,
} from '../evidence/agent-execution-receipt-contract.mjs';
import {
  buildEvidenceBoundManuscriptIrDraft,
  evidenceBoundManuscriptIrDraftHash,
} from '../research/evidence-bound-manuscript-ir.mjs';
import {
  EVIDENCE_ENTAILMENT_CONTRACT_PATH,
  verifyEvidenceEntailmentContract,
} from '../research/evidence-entailment-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SUBSTANTIVE_PROSE_MINIMUM_TOKENS = 8;
const SUBSTANTIVE_PROSE_MINIMUM_SECTIONS = 2;
const SUBSTANTIVE_PROSE_MAXIMUM_SYSTEM_SEED_EDIT_RATIO = 0.2;

export const AGENT_AUTHORED_MANUSCRIPT_MODE =
  'agent-authored-evidence-bound-ir-v1';
export const MINIMAL_MANUSCRIPT_MODE =
  'minimal-report-evidence-bound-ir-v1';

function sha(value) {
  const candidate = String(value || '').toLowerCase();
  return SHA256.test(candidate) ? candidate : null;
}

function substantiveTokens(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) || [];
}

function boundedTokenEditDistance(left, right, maximum) {
  if (Math.abs(left.length - right.length) > maximum) return maximum + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = current[0];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1]
        + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        substitution,
      );
      rowMinimum = Math.min(rowMinimum, current[rightIndex]);
    }
    if (rowMinimum > maximum) return maximum + 1;
    previous = current;
  }
  return previous[right.length];
}

function claimBoundBlocks(draft) {
  return (draft?.sections || []).flatMap((section) => (
    (section?.blocks || [])
      .filter((block) => block?.type === 'prose' || block?.type === 'citation')
      .map((block) => Object.freeze({
        sectionId: String(section.sectionId || ''),
        blockId: String(block.blockId || ''),
        tokens: Object.freeze(substantiveTokens(block.text)),
      }))
  ));
}

function containsTokenSequence(tokens, sequence) {
  if (!sequence.length || sequence.length > tokens.length) return false;
  return tokens.some((token, start) => token === sequence[0]
    && start + sequence.length <= tokens.length
    && sequence.every((expected, offset) => tokens[start + offset] === expected));
}

function nearSystemSeedBlock(tokens, systemSeedBlocks) {
  return systemSeedBlocks.find((seedBlock) => {
    if (containsTokenSequence(tokens, seedBlock.tokens)) return true;
    const maximumDistance = Math.max(1, Math.ceil(
      seedBlock.tokens.length * SUBSTANTIVE_PROSE_MAXIMUM_SYSTEM_SEED_EDIT_RATIO,
    ));
    return boundedTokenEditDistance(tokens, seedBlock.tokens, maximumDistance)
      <= maximumDistance;
  }) || null;
}

function canonicalDraft(value) {
  try {
    const rebuilt = buildEvidenceBoundManuscriptIrDraft(value || {});
    return evidenceBoundManuscriptIrDraftHash(rebuilt)
      === evidenceBoundManuscriptIrDraftHash(value)
      ? rebuilt
      : null;
  } catch {
    return null;
  }
}

export function inspectAutonomousManuscriptSubstantiveAgentProse({
  draft,
  systemSeedDraft,
} = {}) {
  const blockers = [];
  const canonicalAgentDraft = canonicalDraft(draft);
  const canonicalSystemSeedDraft = canonicalDraft(systemSeedDraft);
  if (!canonicalAgentDraft) {
    blockers.push('autonomous_manuscript_ir_agent_draft_invalid');
  }
  if (!canonicalSystemSeedDraft) {
    blockers.push('autonomous_manuscript_ir_system_seed_draft_invalid');
  }
  if (canonicalAgentDraft && canonicalSystemSeedDraft
    && canonicalAgentDraft.paperId !== canonicalSystemSeedDraft.paperId) {
    blockers.push('autonomous_manuscript_ir_system_seed_paper_mismatch');
  }
  if (canonicalAgentDraft && canonicalSystemSeedDraft
    && JSON.stringify(canonicalAgentDraft) === JSON.stringify(canonicalSystemSeedDraft)) {
    blockers.push('autonomous_manuscript_ir_system_seed_draft_retained');
  }
  const inspectedDraft = canonicalAgentDraft || draft;
  const inspectedSystemSeedDraft = canonicalSystemSeedDraft || systemSeedDraft;
  const systemSeedBlocks = claimBoundBlocks(inspectedSystemSeedDraft);
  const sectionInspections = (inspectedDraft?.sections || []).flatMap((section) => {
    const blocks = (section?.blocks || []).filter((block) => (
      block?.type === 'prose' || block?.type === 'citation'
    ));
    if (!blocks.length) return [];
    const blockInspections = blocks.map((block) => {
      const blockId = String(block.blockId || 'unknown');
      const tokens = substantiveTokens(block.text);
      const blockBlockers = [];
      if (tokens.length < SUBSTANTIVE_PROSE_MINIMUM_TOKENS) {
        blockBlockers.push(`autonomous_manuscript_ir_agent_prose_too_short:${blockId}`);
      }
      const nearSeed = nearSystemSeedBlock(tokens, systemSeedBlocks);
      if (nearSeed) {
        blockBlockers.push(
          `autonomous_manuscript_ir_system_seed_prose_retained:${blockId}:${nearSeed.blockId}`,
        );
      }
      blockers.push(...blockBlockers);
      return Object.freeze({
        blockId,
        substantivelyRewritten: blockBlockers.length === 0,
        tokenCount: tokens.length,
        blockers: Object.freeze(blockBlockers),
      });
    });
    const sectionId = String(section.sectionId || 'unknown');
    const substantivelyRewritten = blockInspections.every((block) => (
      block.substantivelyRewritten
    ));
    if (!substantivelyRewritten) {
      blockers.push(`autonomous_manuscript_ir_section_not_substantively_rewritten:${sectionId}`);
    }
    return [Object.freeze({
      sectionId,
      claimBoundBlockCount: blockInspections.length,
      substantivelyRewritten,
      blocks: Object.freeze(blockInspections),
    })];
  });
  const substantivelyRewrittenSectionCount = sectionInspections.filter((section) => (
    section.substantivelyRewritten
  )).length;
  const claimBoundBlockCount = sectionInspections.reduce((count, section) => (
    count + section.claimBoundBlockCount
  ), 0);
  const substantivelyRewrittenBlockCount = sectionInspections.reduce((count, section) => (
    count + section.blocks.filter((block) => block.substantivelyRewritten).length
  ), 0);
  if (sectionInspections.length < SUBSTANTIVE_PROSE_MINIMUM_SECTIONS
    || substantivelyRewrittenSectionCount < SUBSTANTIVE_PROSE_MINIMUM_SECTIONS
    || claimBoundBlockCount < SUBSTANTIVE_PROSE_MINIMUM_SECTIONS
    || substantivelyRewrittenBlockCount < SUBSTANTIVE_PROSE_MINIMUM_SECTIONS) {
    blockers.push('autonomous_manuscript_ir_multiple_substantive_agent_sections_required');
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const payload = {
    version: 2,
    kind: 'AutonomousManuscriptSubstantiveAgentProseInspection',
    status: uniqueBlockers.length
      ? 'autonomous_manuscript_substantive_agent_prose_blocked'
      : 'autonomous_manuscript_substantive_agent_prose_verified',
    valid: uniqueBlockers.length === 0,
    systemSeedDraftHash: hashRecord('AutonomousManuscriptSystemSeedDraft', systemSeedDraft),
    agentDraftHash: hashRecord('AutonomousManuscriptAgentDraft', draft),
    claimBoundSectionCount: sectionInspections.length,
    substantivelyRewrittenSectionCount,
    claimBoundBlockCount,
    substantivelyRewrittenBlockCount,
    sections: Object.freeze(sectionInspections),
    blockers: uniqueBlockers,
  };
  return Object.freeze({
    ...payload,
    autonomousManuscriptSubstantiveAgentProseInspectionHash:
      hashRecord('AutonomousManuscriptSubstantiveAgentProseInspection', payload),
  });
}

export function verifyAutonomousManuscriptSubstantiveAgentProseInspection(
  inspection,
  { draft, systemSeedDraft } = {},
) {
  const rebuilt = inspectAutonomousManuscriptSubstantiveAgentProse({
    draft,
    systemSeedDraft,
  });
  const blockers = [];
  if (JSON.stringify(inspection) !== JSON.stringify(rebuilt)) {
    blockers.push('autonomous_manuscript_substantive_agent_prose_inspection_not_canonical');
  }
  if (rebuilt.valid !== true
    || rebuilt.claimBoundSectionCount < SUBSTANTIVE_PROSE_MINIMUM_SECTIONS
    || rebuilt.substantivelyRewrittenSectionCount < SUBSTANTIVE_PROSE_MINIMUM_SECTIONS
    || rebuilt.claimBoundBlockCount < SUBSTANTIVE_PROSE_MINIMUM_SECTIONS
    || rebuilt.substantivelyRewrittenBlockCount < SUBSTANTIVE_PROSE_MINIMUM_SECTIONS) {
    blockers.push('autonomous_manuscript_substantive_agent_prose_inspection_not_verified');
  }
  return Object.freeze({
    valid: blockers.length === 0,
    inspection: rebuilt,
    blockers: Object.freeze(blockers),
  });
}

export function verifyTrustedAutonomousManuscriptRenderReceipt(receipt, {
  paperId = null,
  campaignId = null,
  manuscriptPath = null,
  manuscriptHash = null,
  evidenceBoundManuscriptIrHash = null,
  manuscriptIrFileHash = null,
  agentAuthoredSourceDraftHash = null,
  agentAuthoredSourceDraftFileHash = null,
  venueProfileSelectionHash = null,
  venueRequirementIrHash = null,
  venueTemplateAssetHash = null,
  venueTemplateAssetPath = null,
  submissionMetadataReceiptHash = null,
  evidenceEntailmentContractHash = null,
  evidenceEntailmentContractFileHash = null,
  agentExecutionReceipt = null,
  requireAgentAuthored = false,
  requireExternalSubmission = false,
  requireEvidenceEntailment = false,
  requireReadableProof = false,
} = {}) {
  const blockers = [];
  const {
    trustedAutonomousManuscriptRenderReceiptHash: claimedHash,
    ...payload
  } = receipt || {};
  if (receipt?.version !== 6
    || receipt?.kind !== 'TrustedAutonomousManuscriptRenderReceipt'
    || receipt?.status !== 'trusted_autonomous_manuscript_rendered'
    || !sha(claimedHash)
    || hashRecord('TrustedAutonomousManuscriptRenderReceipt', payload) !== claimedHash) {
    blockers.push('trusted_autonomous_manuscript_render_receipt_invalid');
  }
  if (!sha(receipt?.manuscriptHash)
    || !sha(receipt?.evidenceBoundManuscriptIrHash)
    || !sha(receipt?.manuscriptIrFileHash)
    || receipt?.manuscriptIrPath !== 'AUTONOMOUS_MANUSCRIPT_IR.json'
    || receipt?.sectionModel !== 'evidence-bound-manuscript-ir-v1'
    || receipt?.unboundScientificProseAccepted !== false
    || receipt?.externalActionPerformed !== false) {
    blockers.push('trusted_autonomous_manuscript_render_evidence_invalid');
  }
  for (const [actual, expected, blocker] of [
    [receipt?.paperId, paperId, 'trusted_autonomous_manuscript_render_paper_mismatch'],
    [receipt?.campaignId, campaignId, 'trusted_autonomous_manuscript_render_campaign_mismatch'],
    [receipt?.manuscriptPath, manuscriptPath, 'trusted_autonomous_manuscript_render_path_mismatch'],
    [receipt?.manuscriptHash, manuscriptHash, 'trusted_autonomous_manuscript_render_source_mismatch'],
    [receipt?.evidenceBoundManuscriptIrHash, evidenceBoundManuscriptIrHash,
      'trusted_autonomous_manuscript_render_ir_mismatch'],
    [receipt?.manuscriptIrFileHash, manuscriptIrFileHash,
      'trusted_autonomous_manuscript_render_ir_file_mismatch'],
    [receipt?.agentAuthoredSourceDraftHash, agentAuthoredSourceDraftHash,
      'trusted_autonomous_manuscript_render_source_draft_mismatch'],
    [receipt?.agentAuthoredSourceDraftFileHash, agentAuthoredSourceDraftFileHash,
      'trusted_autonomous_manuscript_render_source_draft_file_mismatch'],
    [receipt?.venueProfileSelectionHash, venueProfileSelectionHash,
      'trusted_autonomous_manuscript_render_venue_profile_mismatch'],
    [receipt?.venueRequirementIrHash, venueRequirementIrHash,
      'trusted_autonomous_manuscript_render_venue_requirement_mismatch'],
    [receipt?.venueTemplateAssetHash, venueTemplateAssetHash,
      'trusted_autonomous_manuscript_render_venue_template_hash_mismatch'],
    [receipt?.venueTemplateAssetPath, venueTemplateAssetPath,
      'trusted_autonomous_manuscript_render_venue_template_path_mismatch'],
    [receipt?.submissionMetadataReceiptHash, submissionMetadataReceiptHash,
      'trusted_autonomous_manuscript_render_submission_metadata_mismatch'],
    [receipt?.evidenceEntailmentContractHash, evidenceEntailmentContractHash,
      'trusted_autonomous_manuscript_render_entailment_contract_mismatch'],
    [receipt?.evidenceEntailmentContractFileHash, evidenceEntailmentContractFileHash,
      'trusted_autonomous_manuscript_render_entailment_file_mismatch'],
  ]) {
    if (expected !== null && expected !== undefined && actual !== expected) blockers.push(blocker);
  }
  const agentMode = receipt?.manuscriptProductionMode === AGENT_AUTHORED_MANUSCRIPT_MODE;
  const minimalMode = receipt?.manuscriptProductionMode === MINIMAL_MANUSCRIPT_MODE;
  if ((!agentMode && !minimalMode)
    || receipt?.requireAgentAuthoredProse !== agentMode) {
    blockers.push('trusted_autonomous_manuscript_render_mode_invalid');
  }
  const substantiveProof = agentMode
    ? verifyAutonomousManuscriptSubstantiveAgentProseInspection(
      receipt?.substantiveAgentProseInspection,
      {
        draft: receipt?.agentAuthoredSourceDraft,
        systemSeedDraft: receipt?.systemSeedManuscriptIrDraft,
      },
    ) : null;
  const recomputedInspection = substantiveProof?.inspection || null;
  const recomputedAgentDraftHash = receipt?.agentAuthoredSourceDraft
    ? evidenceBoundManuscriptIrDraftHash(receipt.agentAuthoredSourceDraft) : null;
  const minimalAgentDraft = minimalMode && receipt?.agentAuthoredSourceDraft !== null
    && receipt?.agentAuthoredSourceDraft !== undefined;
  if (agentMode && (receipt?.requireAgentAuthoredProse !== true
    || receipt?.agentAuthoredRenderedProseAccepted !== true
    || receipt?.substantiveAgentProseVerified !== true
    || substantiveProof?.valid !== true
    || receipt?.substantiveAgentProseInspectionHash
      !== recomputedInspection?.autonomousManuscriptSubstantiveAgentProseInspectionHash
    || receipt?.systemSeedManuscriptIrDraftHash !== recomputedInspection?.systemSeedDraftHash
    || receipt?.substantivelyRewrittenSectionCount
      !== recomputedInspection?.substantivelyRewrittenSectionCount
    || receipt?.substantivelyRewrittenBlockCount
      !== recomputedInspection?.substantivelyRewrittenBlockCount
    || receipt?.agentAuthoredSourceDraftHash !== recomputedAgentDraftHash
    || !sha(receipt?.agentAuthoredRenderedProseReceiptHash)
    || !sha(receipt?.substantiveAgentProseInspectionHash)
    || !sha(receipt?.systemSeedManuscriptIrDraftHash)
    || !sha(receipt?.agentAuthoredSourceDraftHash)
    || !sha(receipt?.agentAuthoredSourceDraftFileHash)
    || !sha(receipt?.agentWorkspacePostimageBindingHash))) {
    blockers.push('trusted_autonomous_manuscript_substantive_agent_proof_invalid');
  }
  if (minimalMode && (receipt?.substantiveAgentProseVerified !== false
    || receipt?.substantiveAgentProseInspection !== null
    || receipt?.substantiveAgentProseInspectionHash !== null
    || receipt?.systemSeedManuscriptIrDraftHash !== null
    || receipt?.substantivelyRewrittenSectionCount !== 0
    || receipt?.substantivelyRewrittenBlockCount !== 0
    || (minimalAgentDraft && (
      receipt?.agentAuthoredRenderedProseAccepted !== true
      || canonicalDraft(receipt?.agentAuthoredSourceDraft) === null
      || canonicalDraft(receipt?.systemSeedManuscriptIrDraft) === null
      || receipt?.agentAuthoredSourceDraftHash !== recomputedAgentDraftHash
      || !sha(receipt?.agentAuthoredRenderedProseReceiptHash)
      || !sha(receipt?.agentAuthoredSourceDraftHash)
      || !sha(receipt?.agentAuthoredSourceDraftFileHash)
      || !sha(receipt?.agentWorkspacePostimageBindingHash)
    ))
    || (!minimalAgentDraft && (
      receipt?.agentAuthoredRenderedProseAccepted !== false
      || receipt?.agentAuthoredRenderedProseReceiptHash !== null
      || receipt?.agentAuthoredSourceDraftHash !== null
      || receipt?.agentAuthoredSourceDraftFileHash !== null
      || receipt?.agentWorkspacePostimageBindingHash !== null
      || receipt?.systemSeedManuscriptIrDraft !== null
    )))) {
    blockers.push('trusted_autonomous_manuscript_minimal_mode_proof_invalid');
  }
  if (requireAgentAuthored && !agentMode) {
    blockers.push('trusted_autonomous_manuscript_agent_authorship_required');
  }
  const agentExecutionProofRequired = agentMode || minimalAgentDraft;
  if (agentExecutionReceipt && agentExecutionProofRequired) {
    const postimageBinding = agentExecutionReceipt.agentWorkspacePostimageBinding || null;
    if (!verifyAgentExecutionReceipt(agentExecutionReceipt)
      || agentExecutionReceipt.agentExecutionReceiptHash
        !== receipt?.agentAuthoredRenderedProseReceiptHash
      || postimageBinding?.agentWorkspacePostimageBindingHash
        !== receipt?.agentWorkspacePostimageBindingHash
      || !verifyAgentWorkspacePostimageBinding(postimageBinding, {
        requiredPath: 'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json',
        requiredHash: receipt?.agentAuthoredSourceDraftFileHash,
      })) {
      blockers.push('trusted_autonomous_manuscript_agent_execution_proof_invalid');
    }
  } else if (agentExecutionProofRequired) {
    blockers.push('trusted_autonomous_manuscript_agent_execution_receipt_required');
  }
  if (requireExternalSubmission && (!sha(receipt?.venueProfileSelectionHash)
    || !sha(receipt?.submissionMetadataReceiptHash))) {
    blockers.push('trusted_autonomous_manuscript_submission_authority_required');
  }
  if (venueRequirementIrHash !== null && venueRequirementIrHash !== undefined
    && (!sha(receipt?.venueRequirementIrHash)
      || !sha(receipt?.venueRequirementIrFileHash)
      || receipt?.venueRequirementIrPath !== 'AUTONOMOUS_VENUE_REQUIREMENT_IR.json'
      || !sha(receipt?.venueTemplateAssetHash)
      || receipt?.venueTemplateAssetFileHash !== receipt?.venueTemplateAssetHash
      || receipt?.venueTemplateAssetApplicationMode !== 'latex-preamble-input-v1'
      || !String(receipt?.venueTemplateAssetPath || '').startsWith('venue-assets/')
      || typeof receipt?.anonymousReviewApplied !== 'boolean')) {
    blockers.push('trusted_autonomous_manuscript_venue_requirement_proof_invalid');
  }
  const entailmentDeclared = Boolean(receipt?.evidenceEntailmentContract
    || receipt?.evidenceEntailmentContractHash
    || receipt?.evidenceEntailmentContractFileHash
    || receipt?.evidenceEntailmentContractPath);
  const entailmentVerification = entailmentDeclared
    ? verifyEvidenceEntailmentContract(receipt?.evidenceEntailmentContract, {
      paperId: receipt?.paperId,
      evidenceBoundManuscriptIrHash: receipt?.evidenceBoundManuscriptIrHash,
    }) : null;
  if ((requireEvidenceEntailment || entailmentDeclared) && (
    entailmentVerification?.valid !== true
    || receipt?.evidenceEntailmentContractHash
      !== receipt?.evidenceEntailmentContract?.evidenceEntailmentContractHash
    || receipt?.evidenceEntailmentContractPath !== EVIDENCE_ENTAILMENT_CONTRACT_PATH
    || !sha(receipt?.evidenceEntailmentContractFileHash)
    || receipt?.typedEvidenceEntailmentBlockCount
      !== receipt?.evidenceEntailmentContract?.blockCount
    || receipt?.typedEvidenceSourceDocumentCount
      !== receipt?.evidenceEntailmentContract?.sourceEvidenceDocumentCount
    || receipt?.machineEvidenceVerificationScope
      !== 'typed-provenance-and-source-fields'
    || receipt?.untypedRenderedBlockCount !== 0
  )) {
    blockers.push('trusted_autonomous_manuscript_evidence_entailment_invalid');
  }
  const readableProofDeclared = receipt?.productionReadableProofExplanationReady === true
    || Boolean(receipt?.formalReadableProofExplanationBundleHash)
    || Boolean(receipt?.formalReadableProofExplanationHash)
    || Boolean(receipt?.formalReadableProofExplanationDagHash);
  if (readableProofDeclared && (
    receipt?.productionReadableProofExplanationReady !== true
    || !sha(receipt?.formalReadableProofExplanationBundleHash)
    || !sha(receipt?.formalReadableProofExplanationHash)
    || !sha(receipt?.formalReadableProofExplanationDagHash)
  )) {
    blockers.push('trusted_autonomous_manuscript_readable_proof_binding_invalid');
  }
  if (requireReadableProof && receipt?.productionReadableProofExplanationReady !== true) {
    blockers.push('trusted_autonomous_manuscript_readable_proof_required');
  }
  return Object.freeze({
    valid: blockers.length === 0,
    status: blockers.length
      ? 'trusted_autonomous_manuscript_render_verification_blocked'
      : 'trusted_autonomous_manuscript_render_verification_verified',
    agentAuthored: agentMode && blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}
