import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hashPaperRecord } from '../contracts/primitives.mjs';
import { computeReceiptHash } from '../evidence/receipt-hash-policy.mjs';
import {
  canonicalFormalClosureClaimBindings,
  formalClosureClaimBindingsFromProposalBinding,
  validFormalCertificateHash,
  validFormalCertificateId,
} from './formal-certificate-intake-primitives.mjs';

function formalReplayReceiptValid(replay) {
  const {
    formalCertificateReplayReceiptHash: claimedHash,
    ...payload
  } = replay || {};
  return replay?.version === 1
    && replay?.kind === 'FormalCertificateReplayReceipt'
    && replay?.status === 'formal_claim_replay_verified'
    && validFormalCertificateHash(claimedHash)
    && hashRecord('FormalCertificateReplayReceipt', payload) === claimedHash
    && Array.isArray(replay?.blockers) && replay.blockers.length === 0
    && [
      replay?.originalCertificateBundleHash,
      replay?.rerunCertificateBundleHash,
      replay?.projectManifestHash,
      replay?.systemAuditHash,
      replay?.toolchainHash,
      replay?.formalProjectClosureHash,
      replay?.leanReadableProofPrintAuditSetHash,
    ].every(validFormalCertificateHash)
    && replay?.externalActionPerformed === false;
}

export function nativeFormalReceipt(nativeResearchWorkerExecution) {
  const receipts = Array.isArray(nativeResearchWorkerExecution?.workerReceipts)
    ? nativeResearchWorkerExecution.workerReceipts
    : [];
  const formalReceipts = receipts.filter((receipt) => (
    receipt?.workerType === 'formal_verifier_lake'
  ));
  return formalReceipts.length === 1 ? formalReceipts[0] : null;
}

export function nativeFormalClosureBindingFromExecution(
  nativeResearchWorkerExecution,
  {
    paperId = null,
    campaignId = null,
    researchSourceSnapshotHash = null,
  } = {},
) {
  const receipt = nativeFormalReceipt(nativeResearchWorkerExecution);
  if (!receipt) return null;
  const result = receipt.result || null;
  const replay = result?.replayReceipt || null;
  const claimBindingReport = result?.claimBindingReport || null;
  const payload = {
    version: 1,
    kind: 'NativeFormalClosureBinding',
    paperId: paperId || null,
    campaignId: campaignId || null,
    researchSourceSnapshotHash: researchSourceSnapshotHash || null,
    nativeResearchWorkerTaskKey:
      nativeResearchWorkerExecution?.taskKey || null,
    nativeResearchWorkerExecutionReportHash:
      nativeResearchWorkerExecution?.nativeResearchWorkerExecutionReportHash
      || null,
    nativeResearchWorkerExecutionReceiptHash:
      receipt.nativeResearchWorkerExecutionReceiptHash || null,
    nativeResearchWorkerResultHash: receipt.resultHash || null,
    theoremSpecificationHash:
      nativeResearchWorkerExecution?.theoremSpecificationHash || null,
    theoremSpecificationClaimHashes: Object.freeze([
      ...(nativeResearchWorkerExecution?.theoremSpecificationClaimHashes || []),
    ]),
    claimIds: Object.freeze([...(receipt.claimIds || [])]),
    formalClaimBindingHash: claimBindingReport?.formalClaimBindingHash || null,
    formalCertificateReplayReceiptHash:
      replay?.formalCertificateReplayReceiptHash || null,
    workerSourceSnapshotHash: receipt.sourceSnapshotHash || null,
    workerSourceMerkleHashBefore: receipt.sourceMerkleHashBefore || null,
    workerSourceMerkleHashAfter: receipt.sourceMerkleHashAfter || null,
    replayProjectManifestHash: replay?.projectManifestHash || null,
    replayFormalProjectClosureHash: replay?.formalProjectClosureHash || null,
    replayToolchainHash: replay?.toolchainHash || null,
    replayLeanReadableProofPrintAuditSetHash:
      replay?.leanReadableProofPrintAuditSetHash || null,
  };
  return Object.freeze({
    ...payload,
    nativeFormalClosureBindingHash:
      hashRecord('NativeFormalClosureBinding', payload),
  });
}

export function verifyNativeFormalResearchClosureBinding(
  nativeResearchWorkerExecution,
  {
    paperId = null,
    campaignId = null,
    researchSourceSnapshotHash = null,
    taskKey = null,
    proposalBinding = null,
    expectedClaimBindings = [],
  } = {},
) {
  const blockers = [];
  const {
    nativeResearchWorkerExecutionReportHash: claimedReportHash,
    ...reportPayload
  } = nativeResearchWorkerExecution || {};
  const receipts = Array.isArray(nativeResearchWorkerExecution?.workerReceipts)
    ? nativeResearchWorkerExecution.workerReceipts
    : [];
  const receipt = nativeFormalReceipt(nativeResearchWorkerExecution);
  const entries = Array.isArray(proposalBinding?.entries)
    ? proposalBinding.entries
    : [];
  const expectedClaimIds = entries.map(
    (entry) => entry?.theoremClaimId || null,
  );
  const expectedSpecificationClaimHashes = entries.map(
    (entry) => entry?.theoremSpecificationClaimHash || null,
  );
  const canonicalExpectedBindings = canonicalFormalClosureClaimBindings(
    expectedClaimBindings,
  );
  const receiptHashes = receipts.map((item) => (
    item?.nativeResearchWorkerExecutionReceiptHash || null
  ));
  if (nativeResearchWorkerExecution?.version !== 1
    || nativeResearchWorkerExecution?.kind
      !== 'NativeResearchWorkerExecutionReport'
    || nativeResearchWorkerExecution?.status
      !== 'native_research_workers_verified'
    || !validFormalCertificateHash(claimedReportHash)
    || hashPaperRecord(
      'NativeResearchWorkerExecutionReport',
      reportPayload,
    ) !== claimedReportHash
    || nativeResearchWorkerExecution?.paperId !== paperId
    || nativeResearchWorkerExecution?.taskKey !== taskKey
    || nativeResearchWorkerExecution?.executeRequested !== true
    || JSON.stringify(nativeResearchWorkerExecution?.workerTypeFilter)
      !== JSON.stringify(['formal_verifier_lake'])
    || nativeResearchWorkerExecution?.theoremSpecificationHash
      !== proposalBinding?.theoremSpecificationHash
    || JSON.stringify(
      nativeResearchWorkerExecution?.theoremSpecificationClaimHashes,
    ) !== JSON.stringify(expectedSpecificationClaimHashes)
    || receipts.length !== 1
    || Number(nativeResearchWorkerExecution?.plannedResearchWorkerCount)
      !== receipts.length
    || Number(nativeResearchWorkerExecution?.executedResearchWorkerCount)
      !== receipts.length
    || Number(
      nativeResearchWorkerExecution?.verifiedAcademicEvidenceWorkerCount,
    ) !== receipts.length
    || JSON.stringify(nativeResearchWorkerExecution?.workerReceiptHashes)
      !== JSON.stringify(receiptHashes)
    || !Array.isArray(nativeResearchWorkerExecution?.blockers)
    || nativeResearchWorkerExecution.blockers.length) {
    blockers.push('native_formal_execution_report_invalid');
  }
  const proposalClaimBindings = canonicalFormalClosureClaimBindings(
    formalClosureClaimBindingsFromProposalBinding(proposalBinding),
  );
  if (!validFormalCertificateId(paperId)
    || !validFormalCertificateId(campaignId)
    || !validFormalCertificateId(taskKey)
    || !validFormalCertificateHash(researchSourceSnapshotHash)
    || !entries.length
    || !canonicalExpectedBindings
    || !proposalClaimBindings
    || JSON.stringify(canonicalExpectedBindings)
      !== JSON.stringify(proposalClaimBindings)) {
    blockers.push('native_formal_current_closure_context_invalid');
  }
  const result = receipt?.result || null;
  const replay = result?.replayReceipt || null;
  const claimBindingReport = result?.claimBindingReport || null;
  const {
    formalClaimBindingHash: claimedClaimBindingHash,
    ...claimBindingPayload
  } = claimBindingReport || {};
  if (!receipt
    || receipt?.version !== 1
    || receipt?.kind !== 'NativeResearchWorkerExecutionReceipt'
    || computeReceiptHash(receipt)
      !== receipt?.nativeResearchWorkerExecutionReceiptHash
    || receipt?.resultHash
      !== hashPaperRecord('NativeResearchWorkerResult', result)
    || receipt?.paperId !== paperId
    || receipt?.taskKey !== nativeResearchWorkerExecution?.taskKey
    || receipt?.planHash !== nativeResearchWorkerExecution?.planHash
    || receipt?.engineHash !== nativeResearchWorkerExecution?.engineHash
    || receipt?.theoremSpecificationHash
      !== proposalBinding?.theoremSpecificationHash
    || JSON.stringify(receipt?.claimIds) !== JSON.stringify(expectedClaimIds)
    || receipt?.status !== 'native_research_worker_execution_verified'
    || receipt?.academicEvidenceEligible !== true
    || receipt?.sourceMutationDetected !== false
    || !validFormalCertificateHash(receipt?.sourceSnapshotHash)
    || !validFormalCertificateHash(receipt?.sourceMerkleHashBefore)
    || receipt?.sourceMerkleHashBefore !== receipt?.sourceMerkleHashAfter
    || !Array.isArray(receipt?.blockers)
    || receipt.blockers.length) {
    blockers.push('native_formal_execution_receipt_invalid');
  }
  if (result?.status !== 'formal_claim_verified'
    || !formalReplayReceiptValid(replay)
    || result?.formalCertificateReplayReceiptHash
      !== replay?.formalCertificateReplayReceiptHash) {
    blockers.push('native_formal_replay_invalid');
  }
  if (claimBindingReport?.version !== 1
    || claimBindingReport?.kind !== 'FormalClaimBindingReport'
    || claimBindingReport?.status !== 'formal_claim_binding_verified'
    || !validFormalCertificateHash(claimedClaimBindingHash)
    || hashRecord('FormalClaimBindingReport', claimBindingPayload)
      !== claimedClaimBindingHash
    || !Array.isArray(claimBindingReport?.blockers)
    || claimBindingReport.blockers.length) {
    blockers.push('native_formal_claim_binding_report_invalid');
  }
  const observedBindings = Array.isArray(claimBindingReport?.bindings)
    ? claimBindingReport.bindings
    : [];
  if (observedBindings.length !== entries.length) {
    blockers.push('native_formal_claim_binding_count_mismatch');
  }
  for (const entry of entries) {
    const binding = observedBindings.find((item) => (
      item?.claimId === entry?.theoremClaimId
    ));
    const expectedObligationIds = (canonicalExpectedBindings || [])
      .filter((item) => item.claimId === entry?.theoremClaimId)
      .map((item) => item.obligationId)
      .sort();
    const boundObligationIds = (binding?.proofObligationContracts || [])
      .map((contract) => contract?.obligationId || null)
      .sort();
    const expectedObligations = [...(entry?.proofObligations || [])].sort();
    if (!binding || binding.valid !== true
      || JSON.stringify(binding?.expectedObligations)
        !== JSON.stringify(expectedObligations)
      || JSON.stringify(boundObligationIds)
        !== JSON.stringify(expectedObligationIds)
      || JSON.stringify(binding?.verifiedObligations)
        !== JSON.stringify(expectedObligationIds)) {
      blockers.push(
        `native_formal_claim_binding_mismatch:${entry?.theoremClaimId || 'missing'}`,
      );
    }
  }
  const binding = nativeFormalClosureBindingFromExecution(
    nativeResearchWorkerExecution,
    { paperId, campaignId, researchSourceSnapshotHash },
  );
  if (!binding
    || !validFormalCertificateHash(binding.nativeFormalClosureBindingHash)) {
    blockers.push('native_formal_closure_binding_invalid');
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    valid: uniqueBlockers.length === 0,
    status: uniqueBlockers.length
      ? 'native_formal_research_closure_binding_blocked'
      : 'native_formal_research_closure_binding_verified',
    binding: uniqueBlockers.length ? null : binding,
    receipt: uniqueBlockers.length ? null : receipt,
    blockers: uniqueBlockers,
  });
}
