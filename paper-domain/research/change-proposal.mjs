import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function buildResearchChangeProposal({ paperTask, patches = [], evidenceQualityGate } = {}) {
  const blockers = [];
  if (evidenceQualityGate?.status !== 'evidence_quality_ready') blockers.push('evidence_quality_gate_not_ready');
  for (const patch of patches) if (!patch.preimageHash || !patch.patchHash) blockers.push('patch_hash_binding_required');
  const record = {
    version: 1,
    kind: 'ResearchChangeProposal',
    paperId: paperTask?.paperId || null,
    status: blockers.length ? 'research_change_proposal_blocked' : 'research_change_proposal_ready',
    patches,
    sourceMutationPerformed: false,
    applyAuthority: 'repair_service_only',
    blockers: [...new Set(blockers)],
  };
  return { ...record, researchChangeProposalHash: hashRecord('ResearchChangeProposal', record) };
}
