import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function buildEvidenceQualityGate({ paperTask, claimRegistry, evidenceIntake, nativeWorkerReceipts = [] } = {}) {
  const verifiedWorkerClaims = new Set(nativeWorkerReceipts.filter((receipt) => (
    ['native_research_worker_receipt_verified', 'native_research_worker_execution_verified'].includes(receipt.status)
    && Boolean(receipt.receiptHash || receipt.nativeResearchWorkerExecutionReceiptHash)
    && Boolean(receipt.sourceSnapshotHash)
  )).flatMap((receipt) => receipt.claimIds || []));
  const evidenceClaims = new Set((evidenceIntake?.items || []).flatMap((item) => (
    item.verificationStatus === 'evidence_artifact_verified'
      && item.verifiedHash === item.hash
      && item.provenanceReceiptHash
      ? item.claimIds
      : []
  )));
  const coveredClaimIds = (claimRegistry?.claims || []).map((claim) => claim.claimId).filter((id) => verifiedWorkerClaims.has(id) && evidenceClaims.has(id));
  const missingClaimIds = (claimRegistry?.claims || []).map((claim) => claim.claimId).filter((id) => !coveredClaimIds.includes(id));
  const blockers = [
    ...(claimRegistry?.status === 'claim_graph_valid' ? [] : ['claim_graph_not_valid']),
    ...(evidenceIntake?.status === 'evidence_intake_ready' ? [] : ['evidence_intake_not_verified']),
    ...missingClaimIds.map((id) => `claim_evidence_coverage_missing:${id}`),
  ];
  const record = { version: 2, kind: 'EvidenceQualityGate', paperId: paperTask?.paperId || null, status: blockers.length ? 'evidence_quality_blocked' : 'evidence_quality_ready', coveredClaimIds, missingClaimIds, blockers };
  return { ...record, evidenceQualityGateHash: hashRecord('EvidenceQualityGate', record) };
}
