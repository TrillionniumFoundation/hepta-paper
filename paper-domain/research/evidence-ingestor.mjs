import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function buildEvidenceIntake({ paperTask, evidenceItems = [] } = {}) {
  const items = evidenceItems.map((item, index) => ({
    evidenceId: String(item.id || `evidence-${index + 1}`),
    claimIds: Array.isArray(item.claimIds) ? item.claimIds.map(String).sort() : [],
    path: item.path || item.sourceLocator || null,
    hash: item.hash || item.evidenceRefs?.find((ref) => ref.hash)?.hash || null,
    provenance: item.provenance || item.kind || 'candidate',
    verificationStatus: item.verificationStatus || 'unverified',
    verifiedHash: item.verifiedHash || null,
    provenanceReceiptHash: item.provenanceReceiptHash || null,
  }));
  const blockers = items.flatMap((item) => [
    ...(!item.path ? [`${item.evidenceId}:path_required`] : []),
    ...(!item.hash ? [`${item.evidenceId}:hash_required`] : []),
    ...(item.verificationStatus !== 'evidence_artifact_verified' ? [`${item.evidenceId}:verification_required`] : []),
    ...(item.verifiedHash !== item.hash ? [`${item.evidenceId}:verified_hash_mismatch`] : []),
    ...(!item.provenanceReceiptHash ? [`${item.evidenceId}:provenance_receipt_required`] : []),
  ]);
  const record = { version: 2, kind: 'EvidenceIntake', paperId: paperTask?.paperId || null, status: blockers.length ? 'evidence_intake_blocked' : 'evidence_intake_ready', items, blockers };
  return { ...record, evidenceIntakeHash: hashRecord('EvidenceIntake', record) };
}
