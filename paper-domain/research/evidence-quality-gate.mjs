import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { evaluateClaimContractReadiness } from './claim-contract-readiness-policy.mjs';
import { verifyTrustedLedgerReceipt } from '../evidence/trusted-ledger-receipt.mjs';

export function buildEvidenceQualityGate({
  paperTask,
  claimRegistry,
  evidenceIntake,
  nativeWorkerReceipts = [],
  receiptLedger = null,
  experimentEvidenceBindings = [],
  formalCertificateIntakes = [],
} = {}) {
  const claimContractReadiness = evaluateClaimContractReadiness({ claimRegistry });
  const workerLedgerVerifications = nativeWorkerReceipts.map((receipt) => verifyTrustedLedgerReceipt({
    receipt,
    ledgerReceiptId: receipt?.ledgerReceiptId,
    receiptLedger,
    expectedKinds: ['NativeResearchWorkerExecutionReceipt'],
    expectedStatuses: ['native_research_worker_execution_verified'],
    expectedStreams: ['jobs'],
    expectedWriterKinds: ['native-research-worker'],
  }));
  const verifiedWorkerClaims = new Set(nativeWorkerReceipts.filter((receipt, index) => (
    ['native_research_worker_receipt_verified', 'native_research_worker_execution_verified'].includes(receipt.status)
    && Boolean(receipt.nativeResearchWorkerExecutionReceiptHash)
    && Boolean(receipt.sourceSnapshotHash)
    && workerLedgerVerifications[index]?.status === 'trusted_ledger_receipt_verified'
  )).flatMap((receipt) => receipt.claimIds || []));
  const verifiedNativeFormalClaims = new Set(nativeWorkerReceipts.filter((receipt, index) => (
    receipt?.workerType === 'formal_verifier_lake'
    && receipt?.status === 'native_research_worker_execution_verified'
    && receipt?.academicEvidenceEligible === true
    && workerLedgerVerifications[index]?.status === 'trusted_ledger_receipt_verified'
    && receipt?.result?.status === 'formal_claim_verified'
    && receipt?.result?.replayReceipt?.status === 'formal_claim_replay_verified'
    && Boolean(receipt?.result?.formalCertificateReplayReceiptHash)
  )).flatMap((receipt) => receipt.claimIds || []));
  const verifiedExperimentClaims = new Set(experimentEvidenceBindings.filter((binding) => (
    binding?.status === 'experiment_evidence_binding_verified'
    && binding?.trustedLedgerReceiptsVerified === true
    && (binding?.artifactSourcesVerified === true || binding?.rawArtifactSourcesVerified === true)
  )).flatMap((binding) => binding.claimIds || []));
  const verifiedFormalClaims = new Set([
    ...verifiedNativeFormalClaims,
    ...formalCertificateIntakes.filter((intake) => (
    intake?.status === 'formal_certificate_intake_verified'
    && intake?.trustedLedgerReceiptsVerified === true
    && intake?.artifactSourcesVerified === true
    )).flatMap((intake) => (intake.claimBindings || []).map((binding) => binding.claimId)),
  ]);
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
      || /(?:formal|proof|theorem)/.test(planKind);
    const formalCertificateRequired = /(?:formal|proof|theorem)/.test(planKind);
    const experimentBindingRequired = /(?:experiment|empirical|reproduc)/.test(planKind);
    const evidenceRequired = claim?.verificationPlan?.requiresEvidence !== false;
    const workerVerified = verifiedWorkerClaims.has(claim.claimId);
    const formalCertificateVerified = verifiedFormalClaims.has(claim.claimId);
    const experimentBindingVerified = verifiedExperimentClaims.has(claim.claimId);
    const evidenceVerified = evidenceClaims.has(claim.claimId) || verifiedNativeFormalClaims.has(claim.claimId);
    return {
      claimId: claim.claimId,
      verificationKind: planKind || 'evidence',
      workerRequired,
      evidenceRequired,
      workerVerified,
      evidenceVerified,
      formalCertificateRequired,
      experimentBindingRequired,
      formalCertificateVerified,
      experimentBindingVerified,
      covered: (!workerRequired || workerVerified)
        && (!formalCertificateRequired || formalCertificateVerified)
        && (!experimentBindingRequired || experimentBindingVerified)
        && (!evidenceRequired || evidenceVerified),
    };
  });
  const coveredClaimIds = claimCoverageResults.filter((item) => item.covered).map((item) => item.claimId);
  const missingClaimIds = (claimRegistry?.claims || []).map((claim) => claim.claimId).filter((id) => !coveredClaimIds.includes(id));
  const registeredClaimIds = new Set((claimRegistry?.claims || []).map((claim) => claim.claimId));
  const unregisteredWorkerClaimIds = [...verifiedWorkerClaims].filter((id) => !registeredClaimIds.has(id));
  const unregisteredExperimentClaimIds = [...verifiedExperimentClaims].filter((id) => !registeredClaimIds.has(id));
  const unregisteredEvidenceClaimIds = [...evidenceClaims].filter((id) => !registeredClaimIds.has(id));
  const evidenceIntakeRequired = (claimRegistry?.claims || []).some((claim) => claim?.verificationPlan?.requiresEvidence !== false);
  const blockers = [
    ...(claimRegistry?.status === 'claim_graph_valid' ? [] : ['claim_graph_not_valid']),
    ...(claimContractReadiness.status === 'claim_contract_readiness_ready' ? [] : claimContractReadiness.blockers),
    ...(!evidenceIntakeRequired || evidenceIntake?.status === 'evidence_intake_ready' ? [] : ['evidence_intake_not_verified']),
    ...missingClaimIds.map((id) => `claim_evidence_coverage_missing:${id}`),
    ...unregisteredWorkerClaimIds.map((id) => `worker_claim_not_registered_in_manuscript:${id}`),
    ...unregisteredExperimentClaimIds.map((id) => `experiment_claim_not_registered_in_manuscript:${id}`),
    ...unregisteredEvidenceClaimIds.map((id) => `evidence_claim_not_registered_in_manuscript:${id}`),
  ];
  const record = { version: 6, kind: 'EvidenceQualityGate', paperId: paperTask?.paperId || null, status: blockers.length ? 'evidence_quality_blocked' : 'evidence_quality_ready', evidenceIntakeRequired, claimContractReadiness, claimCoverageResults, coveredClaimIds, missingClaimIds, unregisteredWorkerClaimIds, unregisteredExperimentClaimIds, unregisteredEvidenceClaimIds, workerLedgerVerifications, verifiedNativeFormalClaimIds: [...verifiedNativeFormalClaims].sort(), verifiedFormalClaimIds: [...verifiedFormalClaims].sort(), verifiedExperimentClaimIds: [...verifiedExperimentClaims].sort(), blockers: [...new Set(blockers)] };
  return { ...record, evidenceQualityGateHash: hashRecord('EvidenceQualityGate', record) };
}
