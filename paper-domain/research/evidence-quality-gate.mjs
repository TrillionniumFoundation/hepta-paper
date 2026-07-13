import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { evaluateClaimContractReadiness } from './claim-contract-readiness-policy.mjs';

export function buildEvidenceQualityGate({ paperTask, claimRegistry, evidenceIntake, nativeWorkerReceipts = [] } = {}) {
  const claimContractReadiness = evaluateClaimContractReadiness({ claimRegistry });
  const verifiedWorkerClaims = new Set(nativeWorkerReceipts.filter((receipt) => (
    ['native_research_worker_receipt_verified', 'native_research_worker_execution_verified'].includes(receipt.status)
    && Boolean(receipt.receiptHash || receipt.nativeResearchWorkerExecutionReceiptHash)
    && Boolean(receipt.sourceSnapshotHash)
  )).flatMap((receipt) => receipt.claimIds || []));
  const evidenceClaims = new Set((evidenceIntake?.items || []).flatMap((item) => (
    item.verificationStatus === 'evidence_artifact_verified'
      && item.verifiedHash === item.hash
      && item.provenanceReceiptHash
      && item.consumptionPolicy?.status === 'evidence_consumption_ready'
      ? item.claimIds
      : []
  )));
  const claimCoverageResults = (claimRegistry?.claims || []).map((claim) => {
    const planKind = String(claim?.verificationPlan?.kind || claim?.verificationPlan?.type || claim?.claimKind || claim?.riskClass || '').toLowerCase();
    const workerRequired = claim?.verificationPlan?.requiresWorker === true
      || /(?:formal|proof|theorem|experiment|empirical|reproduc)/.test(planKind);
    const evidenceRequired = claim?.verificationPlan?.requiresEvidence !== false;
    const workerVerified = verifiedWorkerClaims.has(claim.claimId);
    const evidenceVerified = evidenceClaims.has(claim.claimId);
    return {
      claimId: claim.claimId,
      verificationKind: planKind || 'evidence',
      workerRequired,
      evidenceRequired,
      workerVerified,
      evidenceVerified,
      covered: (!workerRequired || workerVerified) && (!evidenceRequired || evidenceVerified),
    };
  });
  const coveredClaimIds = claimCoverageResults.filter((item) => item.covered).map((item) => item.claimId);
  const missingClaimIds = (claimRegistry?.claims || []).map((claim) => claim.claimId).filter((id) => !coveredClaimIds.includes(id));
  const registeredClaimIds = new Set((claimRegistry?.claims || []).map((claim) => claim.claimId));
  const unregisteredWorkerClaimIds = [...verifiedWorkerClaims].filter((id) => !registeredClaimIds.has(id));
  const unregisteredEvidenceClaimIds = [...evidenceClaims].filter((id) => !registeredClaimIds.has(id));
  const blockers = [
    ...(claimRegistry?.status === 'claim_graph_valid' ? [] : ['claim_graph_not_valid']),
    ...(claimContractReadiness.status === 'claim_contract_readiness_ready' ? [] : claimContractReadiness.blockers),
    ...(evidenceIntake?.status === 'evidence_intake_ready' ? [] : ['evidence_intake_not_verified']),
    ...missingClaimIds.map((id) => `claim_evidence_coverage_missing:${id}`),
    ...unregisteredWorkerClaimIds.map((id) => `worker_claim_not_registered_in_manuscript:${id}`),
    ...unregisteredEvidenceClaimIds.map((id) => `evidence_claim_not_registered_in_manuscript:${id}`),
  ];
  const record = { version: 4, kind: 'EvidenceQualityGate', paperId: paperTask?.paperId || null, status: blockers.length ? 'evidence_quality_blocked' : 'evidence_quality_ready', claimContractReadiness, claimCoverageResults, coveredClaimIds, missingClaimIds, unregisteredWorkerClaimIds, unregisteredEvidenceClaimIds, blockers: [...new Set(blockers)] };
  return { ...record, evidenceQualityGateHash: hashRecord('EvidenceQualityGate', record) };
}
