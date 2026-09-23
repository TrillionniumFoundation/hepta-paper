import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { evaluateEvidenceConsumption } from '../evidence/evidence-consumption-policy.mjs';

export function buildEvidenceIntake({ paperTask, evidenceItems = [], nowMs = null, maximumAgeMs = null } = {}) {
  const items = evidenceItems.map((item, index) => ({
    evidenceId: String(item.id || `evidence-${index + 1}`),
    claimIds: Array.isArray(item.claimIds) ? item.claimIds.map(String).sort() : [],
    path: item.path || item.sourceLocator || null,
    hash: item.hash || item.evidenceRefs?.find((ref) => ref.hash)?.hash || null,
    provenance: item.provenance || item.kind || 'candidate',
    verificationStatus: item.verificationStatus || 'unverified',
    verifiedHash: item.verifiedHash || null,
    provenanceReceiptHash: item.provenanceReceiptHash || null,
    consumptionPolicy: evaluateEvidenceConsumption({
      reference: item.verificationReceipt || {
        kind: 'EvidenceArtifactVerificationReceipt',
        status: item.verificationStatus,
        hash: item.provenanceReceiptHash,
        createdAt: item.createdAt,
        claimIds: item.claimIds,
        path: item.path || item.sourceLocator,
      },
      expected: { kind: 'EvidenceArtifactVerificationReceipt', acceptedStatuses: ['evidence_artifact_verified'], hash: item.provenanceReceiptHash || undefined },
      nowMs,
      maximumAgeMs,
      requiredOutputs: item.requiredOutputs || [],
      availableOutputs: item.availableOutputs || item.outputs || [],
      claimId: item.claimId || null,
      sourceLocator: item.path || item.sourceLocator || null,
      resultClass: item.resultClass || null,
      acceptedResultClasses: item.acceptedResultClasses || ['positive', 'verified'],
      forbiddenSideEffects: item.forbiddenSideEffects || [],
      observedSideEffects: item.observedSideEffects || [],
      dependencyNodes: item.dependencyNodes || item.dependencyChain || [],
    }),
  }));
  const blockers = items.flatMap((item) => [
    ...(!item.path ? [`${item.evidenceId}:path_required`] : []),
    ...(!item.hash ? [`${item.evidenceId}:hash_required`] : []),
    ...(item.verificationStatus !== 'evidence_artifact_verified' ? [`${item.evidenceId}:verification_required`] : []),
    ...(item.verifiedHash !== item.hash ? [`${item.evidenceId}:verified_hash_mismatch`] : []),
    ...(!item.provenanceReceiptHash ? [`${item.evidenceId}:provenance_receipt_required`] : []),
    ...(item.consumptionPolicy.status !== 'evidence_consumption_ready' ? item.consumptionPolicy.blockers.map((blocker) => `${item.evidenceId}:${blocker}`) : []),
  ]);
  if (!items.length) blockers.push('evidence_intake_empty');
  const record = { version: 2, kind: 'EvidenceIntake', paperId: paperTask?.paperId || null, status: blockers.length ? 'evidence_intake_blocked' : 'evidence_intake_ready', items, blockers };
  return { ...record, evidenceIntakeHash: hashRecord('EvidenceIntake', record) };
}
