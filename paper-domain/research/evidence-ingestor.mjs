import { hashPaperRecord } from '../../paper-core/src/paper-contract-primitives.mjs';

export function buildEvidenceIntake({ paperTask, evidenceItems = [] } = {}) {
  const items = evidenceItems.map((item, index) => ({
    evidenceId: String(item.id || `evidence-${index + 1}`),
    claimIds: Array.isArray(item.claimIds) ? item.claimIds.map(String).sort() : [],
    path: item.path || item.sourceLocator || null,
    hash: item.hash || item.evidenceRefs?.find((ref) => ref.hash)?.hash || null,
    provenance: item.provenance || item.kind || 'candidate',
  }));
  const blockers = items.flatMap((item) => [
    ...(!item.path ? [`${item.evidenceId}:path_required`] : []),
    ...(!item.hash ? [`${item.evidenceId}:hash_required`] : []),
  ]);
  const record = { version: 1, kind: 'EvidenceIntake', paperId: paperTask?.paperId || null, status: blockers.length ? 'evidence_intake_blocked' : 'evidence_intake_ready', items, blockers };
  return { ...record, evidenceIntakeHash: hashPaperRecord('EvidenceIntake', record) };
}
