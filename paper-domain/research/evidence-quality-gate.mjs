import { hashPaperRecord } from '../../paper-core/src/paper-contract-primitives.mjs';

export function buildEvidenceQualityGate({ paperTask, claimRegistry, evidenceIntake, nativeWorkerReceipts = [] } = {}) {
  const verifiedWorkerClaims = new Set(nativeWorkerReceipts.filter((receipt) => receipt.academicEvidenceEligible === true).flatMap((receipt) => receipt.claimIds || []));
  const evidenceClaims = new Set((evidenceIntake?.items || []).flatMap((item) => item.hash ? item.claimIds : []));
  const coveredClaimIds = (claimRegistry?.claims || []).map((claim) => claim.claimId).filter((id) => verifiedWorkerClaims.has(id) && evidenceClaims.has(id));
  const missingClaimIds = (claimRegistry?.claims || []).map((claim) => claim.claimId).filter((id) => !coveredClaimIds.includes(id));
  const record = { version: 1, kind: 'EvidenceQualityGate', paperId: paperTask?.paperId || null, status: missingClaimIds.length ? 'evidence_quality_blocked' : 'evidence_quality_ready', coveredClaimIds, missingClaimIds };
  return { ...record, evidenceQualityGateHash: hashPaperRecord('EvidenceQualityGate', record) };
}

