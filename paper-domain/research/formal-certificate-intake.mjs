import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashPaperRecord } from '../contracts/primitives.mjs';
import { computeReceiptHash } from '../evidence/receipt-hash-policy.mjs';
import { formalVerifierDescriptor } from './formal-verifier-registry.mjs';
import { verifyTrustedLedgerReceipt } from '../evidence/trusted-ledger-receipt.mjs';
import { createProofObligationContracts } from './theorem-specification.mjs';
import {
  buildFormalClaimBindingsManifest,
  buildFormalExecutionContract,
  buildFormalSourceManifest,
} from './formal-certificate-evidence-contracts.mjs';
import {
  embeddedFormalArtifactReceiptValid,
  embeddedFormalEvidenceBlockers,
} from './formal-certificate-embedded-evidence-verifier.mjs';

export {
  buildFormalClaimBindingsManifest,
  buildFormalExecutionContract,
  buildFormalSourceManifest,
} from './formal-certificate-evidence-contracts.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/i;
const INTAKE_V3_KEYS = Object.freeze([
  'adapterReceiptHash', 'artifactSourcesVerified', 'blockers', 'campaignId',
  'certificate', 'certificateHash', 'certificateLedgerReceiptId',
  'certificateWriteReceiptHash',
  'claimBindings', 'claimBindingsHash', 'claimBindingsManifest', 'command',
  'executionContract', 'executionContractHash', 'executionLedgerReceiptId',
  'executionReceipt', 'executionReceiptHash', 'extension', 'externalActionPerformed',
  'formalVerifierRegistryHash', 'genericFormalCertificateIntakeHash',
  'isolationPolicyHash', 'isolationReceiptHash', 'kind',
  'nativeFormalClosureBinding', 'nativeFormalClosureBindingHash', 'paperId',
  'researchSourceSnapshotHash', 'sourceManifest', 'sourceManifestHash',
  'sourceRecords', 'status', 'toolchainHash', 'trustedLedgerReceiptsVerified',
  'trustedNativeFormalReceiptVerified', 'verifierKind', 'version',
]);
const validHash = (value) => HASH.test(String(value || ''));
const validId = (value) => typeof value === 'string' && value.trim() === value && value.length > 0;
const sourceExtension = (value) => {
  const leaf = String(value || '').replace(/\\/g, '/').split('/').pop() || '';
  const index = leaf.lastIndexOf('.');
  return index > 0 ? leaf.slice(index).toLowerCase() : '';
};

function canonicalClosureClaimBindings(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const bindings = value.map((item) => ({
    claimId: validId(item?.claimId) ? item.claimId : null,
    obligationId: validId(item?.obligationId) ? item.obligationId : null,
    statementHash: validHash(item?.statementHash) ? String(item.statementHash).toLowerCase() : null,
  }));
  if (bindings.some((binding) => Object.values(binding).some((item) => item === null))) return null;
  const keys = bindings.map((binding) => `${binding.claimId}\u0000${binding.obligationId}`);
  if (new Set(keys).size !== keys.length) return null;
  return bindings.sort((left, right) => (
    left.claimId.localeCompare(right.claimId)
      || left.obligationId.localeCompare(right.obligationId)
  ));
}

export function formalClosureClaimBindingsFromProposalBinding(proposalBinding) {
  const entries = Array.isArray(proposalBinding?.entries) ? proposalBinding.entries : [];
  if (!entries.length) return Object.freeze([]);
  const bindings = [];
  try {
    for (const entry of entries) {
      if (!validId(entry?.theoremClaimId) || !validId(entry?.theoremStatement)
        || !validId(entry?.scientificClaimKey)) return Object.freeze([]);
      const statementHash = hashBytes(Buffer.from(entry.theoremStatement, 'utf8'));
      const obligations = createProofObligationContracts({
        claimKey: entry.scientificClaimKey,
        proofObligations: entry.proofObligations,
      });
      for (const obligation of obligations) {
        bindings.push(Object.freeze({
          claimId: entry.theoremClaimId,
          obligationId: obligation.obligationId,
          statementHash,
        }));
      }
    }
  } catch {
    return Object.freeze([]);
  }
  const canonical = canonicalClosureClaimBindings(bindings);
  return Object.freeze((canonical || []).map((binding) => Object.freeze(binding)));
}

function formalReplayReceiptValid(replay) {
  const { formalCertificateReplayReceiptHash: claimedHash, ...payload } = replay || {};
  return replay?.version === 1
    && replay?.kind === 'FormalCertificateReplayReceipt'
    && replay?.status === 'formal_claim_replay_verified'
    && validHash(claimedHash)
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
    ].every(validHash)
    && replay?.externalActionPerformed === false;
}

function nativeFormalReceipt(nativeResearchWorkerExecution) {
  const receipts = Array.isArray(nativeResearchWorkerExecution?.workerReceipts)
    ? nativeResearchWorkerExecution.workerReceipts : [];
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
    nativeResearchWorkerTaskKey: nativeResearchWorkerExecution?.taskKey || null,
    nativeResearchWorkerExecutionReportHash:
      nativeResearchWorkerExecution?.nativeResearchWorkerExecutionReportHash || null,
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
    ? nativeResearchWorkerExecution.workerReceipts : [];
  const receipt = nativeFormalReceipt(nativeResearchWorkerExecution);
  const entries = Array.isArray(proposalBinding?.entries) ? proposalBinding.entries : [];
  const expectedClaimIds = entries.map((entry) => entry?.theoremClaimId || null);
  const expectedSpecificationClaimHashes = entries
    .map((entry) => entry?.theoremSpecificationClaimHash || null);
  const canonicalExpectedBindings = canonicalClosureClaimBindings(expectedClaimBindings);
  const receiptHashes = receipts.map((item) => (
    item?.nativeResearchWorkerExecutionReceiptHash || null
  ));
  if (nativeResearchWorkerExecution?.version !== 1
    || nativeResearchWorkerExecution?.kind !== 'NativeResearchWorkerExecutionReport'
    || nativeResearchWorkerExecution?.status !== 'native_research_workers_verified'
    || !validHash(claimedReportHash)
    || hashPaperRecord('NativeResearchWorkerExecutionReport', reportPayload)
      !== claimedReportHash
    || nativeResearchWorkerExecution?.paperId !== paperId
    || nativeResearchWorkerExecution?.taskKey !== taskKey
    || nativeResearchWorkerExecution?.executeRequested !== true
    || JSON.stringify(nativeResearchWorkerExecution?.workerTypeFilter)
      !== JSON.stringify(['formal_verifier_lake'])
    || nativeResearchWorkerExecution?.theoremSpecificationHash
      !== proposalBinding?.theoremSpecificationHash
    || JSON.stringify(nativeResearchWorkerExecution?.theoremSpecificationClaimHashes)
      !== JSON.stringify(expectedSpecificationClaimHashes)
    || receipts.length !== 1
    || Number(nativeResearchWorkerExecution?.plannedResearchWorkerCount) !== receipts.length
    || Number(nativeResearchWorkerExecution?.executedResearchWorkerCount) !== receipts.length
    || Number(nativeResearchWorkerExecution?.verifiedAcademicEvidenceWorkerCount)
      !== receipts.length
    || JSON.stringify(nativeResearchWorkerExecution?.workerReceiptHashes)
      !== JSON.stringify(receiptHashes)
    || !Array.isArray(nativeResearchWorkerExecution?.blockers)
    || nativeResearchWorkerExecution.blockers.length) {
    blockers.push('native_formal_execution_report_invalid');
  }
  const proposalClaimBindings = canonicalClosureClaimBindings(
    formalClosureClaimBindingsFromProposalBinding(proposalBinding),
  );
  if (!validId(paperId) || !validId(campaignId) || !validId(taskKey)
    || !validHash(researchSourceSnapshotHash) || !entries.length
    || !canonicalExpectedBindings || !proposalClaimBindings
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
    || receipt?.resultHash !== hashPaperRecord('NativeResearchWorkerResult', result)
    || receipt?.paperId !== paperId
    || receipt?.taskKey !== nativeResearchWorkerExecution?.taskKey
    || receipt?.planHash !== nativeResearchWorkerExecution?.planHash
    || receipt?.engineHash !== nativeResearchWorkerExecution?.engineHash
    || receipt?.theoremSpecificationHash !== proposalBinding?.theoremSpecificationHash
    || JSON.stringify(receipt?.claimIds) !== JSON.stringify(expectedClaimIds)
    || receipt?.status !== 'native_research_worker_execution_verified'
    || receipt?.academicEvidenceEligible !== true
    || receipt?.sourceMutationDetected !== false
    || !validHash(receipt?.sourceSnapshotHash)
    || !validHash(receipt?.sourceMerkleHashBefore)
    || receipt?.sourceMerkleHashBefore !== receipt?.sourceMerkleHashAfter
    || !Array.isArray(receipt?.blockers) || receipt.blockers.length) {
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
    || !validHash(claimedClaimBindingHash)
    || hashRecord('FormalClaimBindingReport', claimBindingPayload)
      !== claimedClaimBindingHash
    || !Array.isArray(claimBindingReport?.blockers)
    || claimBindingReport.blockers.length) {
    blockers.push('native_formal_claim_binding_report_invalid');
  }
  const observedBindings = Array.isArray(claimBindingReport?.bindings)
    ? claimBindingReport.bindings : [];
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
      blockers.push(`native_formal_claim_binding_mismatch:${entry?.theoremClaimId || 'missing'}`);
    }
  }
  const binding = nativeFormalClosureBindingFromExecution(
    nativeResearchWorkerExecution,
    { paperId, campaignId, researchSourceSnapshotHash },
  );
  if (!binding || !validHash(binding.nativeFormalClosureBindingHash)) {
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


export function verifyGenericFormalCertificateIntakeClosureBinding(intake, {
  paperId = null,
  campaignId = null,
  researchSourceSnapshotHash = null,
  taskKey = null,
  expectedClaimBindings = [],
  proposalBinding = null,
  nativeResearchWorkerExecution = null,
  requireNativeFormalLedgerTrust = false,
  trustedNativeFormalReceiptHashes = [],
} = {}) {
  const blockers = [];
  const { genericFormalCertificateIntakeHash: claimedHash, ...payload } = intake || {};
  if (!hasExactObjectKeys(intake, INTAKE_V3_KEYS)
    || intake?.version !== 3
    || intake?.kind !== 'GenericFormalCertificateIntake'
    || intake?.status !== 'formal_certificate_intake_verified'
    || !validHash(claimedHash)
    || hashRecord('GenericFormalCertificateIntake', payload) !== claimedHash) {
    blockers.push('formal_certificate_intake_record_invalid');
  }
  if (!validId(paperId) || intake?.paperId !== paperId) {
    blockers.push('formal_certificate_intake_paper_mismatch');
  }
  if (!validId(campaignId) || intake?.campaignId !== campaignId) {
    blockers.push('formal_certificate_intake_campaign_mismatch');
  }
  if (!validHash(researchSourceSnapshotHash)
    || intake?.researchSourceSnapshotHash !== researchSourceSnapshotHash) {
    blockers.push('formal_certificate_intake_research_source_snapshot_mismatch');
  }
  const observedBindings = canonicalClosureClaimBindings(intake?.claimBindings);
  const expectedBindings = canonicalClosureClaimBindings(expectedClaimBindings);
  if (!observedBindings || !expectedBindings
    || JSON.stringify(observedBindings) !== JSON.stringify(expectedBindings)) {
    blockers.push('formal_certificate_intake_claim_binding_mismatch');
  }
  blockers.push(...embeddedFormalEvidenceBlockers(intake));
  const nativeVerification = verifyNativeFormalResearchClosureBinding(
    nativeResearchWorkerExecution,
    {
      paperId,
      campaignId,
      researchSourceSnapshotHash,
      taskKey,
      proposalBinding,
      expectedClaimBindings,
    },
  );
  if (!nativeVerification.valid
    || JSON.stringify(intake?.nativeFormalClosureBinding)
      !== JSON.stringify(nativeVerification.binding)
    || intake?.nativeFormalClosureBindingHash
      !== nativeVerification.binding?.nativeFormalClosureBindingHash) {
    blockers.push('formal_certificate_intake_native_formal_anchor_invalid');
  }
  if (requireNativeFormalLedgerTrust === true
    && (!nativeVerification.receipt
      || !trustedNativeFormalReceiptHashes.includes(
        nativeVerification.receipt.nativeResearchWorkerExecutionReceiptHash,
      ))) {
    blockers.push('formal_certificate_intake_native_formal_ledger_trust_required');
  }
  if (intake?.trustedLedgerReceiptsVerified !== true
    || intake?.artifactSourcesVerified !== true
    || intake?.trustedNativeFormalReceiptVerified !== true
    || !Array.isArray(intake?.blockers) || intake.blockers.length
    || intake?.externalActionPerformed !== false) {
    blockers.push('formal_certificate_intake_build_time_evidence_invalid');
  }
  const uniqueBlockers = Object.freeze([...new Set([
    ...blockers,
    ...nativeVerification.blockers.map((blocker) => `native:${blocker}`),
  ])]);
  return Object.freeze({
    valid: uniqueBlockers.length === 0,
    status: uniqueBlockers.length
      ? 'formal_certificate_intake_closure_binding_blocked'
      : 'formal_certificate_intake_closure_binding_verified',
    genericFormalCertificateIntakeHash: claimedHash || null,
    paperId: uniqueBlockers.length ? null : intake.paperId,
    campaignId: uniqueBlockers.length ? null : intake.campaignId,
    researchSourceSnapshotHash: uniqueBlockers.length
      ? null : intake.researchSourceSnapshotHash,
    claimBindings: uniqueBlockers.length ? Object.freeze([]) : Object.freeze(observedBindings),
    nativeFormalClosureBinding: uniqueBlockers.length
      ? null : nativeVerification.binding,
    blockers: uniqueBlockers,
  });
}


export function buildGenericFormalCertificateIntake({
  paperId = null,
  campaignId = null,
  researchSourceSnapshotHash = null,
  verifierKind,
  certificate = null,
  sourceRecords = [],
  claimBindings = [],
  executionReceipt = null,
  verifierRegistry = null,
  receiptLedger = null,
  artifactVerifier = null,
} = {}, {
  expectedPaperId = null,
  expectedCampaignId = null,
  expectedResearchSourceSnapshotHash = null,
  expectedClaimBindings = [],
  expectedTaskKey = null,
  expectedProposalBinding = null,
  nativeResearchWorkerExecution = null,
} = {}) {
  const blockers = [];
  const descriptor = formalVerifierDescriptor(verifierKind);
  const sourceManifest = buildFormalSourceManifest({ verifierKind: descriptor?.kind || verifierKind, sourceRecords });
  const claimBindingsManifest = buildFormalClaimBindingsManifest({ claimBindings });
  if (!descriptor) blockers.push('formal_verifier_kind_unknown');
  const registryEntry = verifierRegistry?.verifiers?.find((item) => item?.kind === descriptor?.kind) || null;
  if (verifierRegistry?.status !== 'formal_verifier_registry_ready' || registryEntry?.status !== 'formal_verifier_registered') {
    blockers.push('formal_verifier_adapter_not_registered');
  }
  if (certificate?.kind !== descriptor?.certificateKind) blockers.push('formal_certificate_kind_mismatch');
  if (!validHash(certificate?.certificateHash)) blockers.push('formal_certificate_hash_invalid');
  if (!validHash(certificate?.toolchainHash)) blockers.push('formal_toolchain_hash_invalid');
  if (!Array.isArray(sourceRecords) || !sourceRecords.length) blockers.push('formal_certificate_source_records_missing');
  for (const [index, source] of sourceRecords.entries()) {
    if (sourceExtension(source?.path) !== descriptor?.extension) blockers.push(`formal_source_extension_invalid:${index}`);
    if (!validHash(source?.hash)) blockers.push(`formal_source_hash_invalid:${index}`);
    if (!validHash(source?.sourceReadReceiptHash)) blockers.push(`formal_source_read_receipt_hash_invalid:${index}`);
  }
  if (!Array.isArray(claimBindings) || !claimBindings.length) blockers.push('formal_claim_bindings_missing');
  for (const [index, binding] of claimBindings.entries()) {
    if (!binding?.claimId || !binding?.obligationId || !validHash(binding?.statementHash)) blockers.push(`formal_claim_binding_invalid:${index}`);
  }
  const observedClosureBindings = canonicalClosureClaimBindings(claimBindings);
  const expectedClosureBindings = canonicalClosureClaimBindings(expectedClaimBindings);
  if (!validId(paperId) || !validId(expectedPaperId) || paperId !== expectedPaperId
    || executionReceipt?.paperId !== paperId) {
    blockers.push('formal_evidence_paper_lineage_mismatch');
  }
  if (!validId(campaignId) || !validId(expectedCampaignId) || campaignId !== expectedCampaignId
    || executionReceipt?.campaignId !== campaignId) {
    blockers.push('formal_evidence_campaign_lineage_mismatch');
  }
  if (!validHash(researchSourceSnapshotHash)
    || !validHash(expectedResearchSourceSnapshotHash)
    || researchSourceSnapshotHash !== expectedResearchSourceSnapshotHash
    || executionReceipt?.researchSourceSnapshotHash !== researchSourceSnapshotHash) {
    blockers.push('formal_evidence_research_source_snapshot_lineage_mismatch');
  }
  if (!observedClosureBindings || !expectedClosureBindings
    || JSON.stringify(observedClosureBindings) !== JSON.stringify(expectedClosureBindings)) {
    blockers.push('formal_evidence_current_claim_bindings_mismatch');
  }
  const executionContract = buildFormalExecutionContract({
    verifierKind: descriptor?.kind || verifierKind,
    command: descriptor?.command,
    certificateHash: certificate?.certificateHash,
    toolchainHash: certificate?.toolchainHash,
    sourceManifestHash: sourceManifest.formalSourceManifestHash,
    claimBindingsHash: claimBindingsManifest.formalClaimBindingsHash,
    certificateWriteReceiptHash: certificate?.artifactWriteReceipt?.writeReceiptHash,
    adapterReceiptHash: registryEntry?.adapterReceiptHash,
  });
  if (executionReceipt?.status !== 'formal_verifier_execution_verified') blockers.push('formal_execution_receipt_not_verified');
  if (executionReceipt?.verifierKind !== descriptor?.kind) blockers.push('formal_execution_verifier_kind_mismatch');
  if (!validHash(executionReceipt?.receiptHash)
    || computeReceiptHash(executionReceipt) !== executionReceipt?.receiptHash) {
    blockers.push('formal_execution_receipt_hash_invalid');
  }
  if (executionReceipt?.certificateHash !== certificate?.certificateHash) blockers.push('formal_execution_certificate_hash_mismatch');
  if (executionReceipt?.toolchainHash !== certificate?.toolchainHash) blockers.push('formal_execution_toolchain_hash_mismatch');
  if (executionReceipt?.command !== descriptor?.command) blockers.push('formal_execution_command_mismatch');
  if (executionReceipt?.adapterReceiptHash !== registryEntry?.adapterReceiptHash) blockers.push('formal_execution_adapter_receipt_mismatch');
  if (executionReceipt?.certificateWriteReceiptHash !== certificate?.artifactWriteReceipt?.writeReceiptHash) blockers.push('formal_execution_certificate_receipt_mismatch');
  if (executionReceipt?.sourceManifestHash !== sourceManifest.formalSourceManifestHash) blockers.push('formal_execution_source_manifest_mismatch');
  if (executionReceipt?.claimBindingsHash !== claimBindingsManifest.formalClaimBindingsHash) blockers.push('formal_execution_claim_bindings_mismatch');
  if (executionReceipt?.executionContractHash !== executionContract.formalExecutionContractHash) blockers.push('formal_execution_contract_mismatch');
  if (executionReceipt?.isolationPolicyHash !== executionContract.isolationPolicyHash) blockers.push('formal_execution_isolation_policy_mismatch');
  if (!validHash(executionReceipt?.isolationReceiptHash)) blockers.push('formal_execution_isolation_receipt_hash_invalid');
  if (executionReceipt?.networkPolicy !== 'none' || executionReceipt?.secretAccessPerformed !== false || executionReceipt?.sourceMutationDetected !== false || executionReceipt?.externalActionPerformed !== false || executionReceipt?.providerCallPerformed !== false || executionReceipt?.commitPerformed !== false) blockers.push('formal_execution_isolation_claim_invalid');
  if (executionReceipt?.isolation?.kernelNetworkIsolationVerified !== true || executionReceipt?.isolation?.sourceReadOnlyVerified !== true || executionReceipt?.isolation?.ephemeralWorkRootVerified !== true || executionReceipt?.isolation?.separateOutputRootVerified !== true) blockers.push('formal_execution_isolation_not_verified');
  if (!validHash(executionReceipt?.sourceMerkleHashBefore) || executionReceipt?.sourceMerkleHashBefore !== executionReceipt?.sourceMerkleHashAfter) blockers.push('formal_execution_source_integrity_invalid');
  if (Number(executionReceipt?.exitCode) !== 0) blockers.push('formal_execution_exit_code_invalid');
  if (!validHash(executionReceipt?.stdoutHash) || !validHash(executionReceipt?.stderrHash)) blockers.push('formal_execution_output_hash_invalid');
  if (!executionReceipt?.runnerId || !validHash(executionReceipt?.runnerDescriptorHash)) blockers.push('formal_execution_runner_identity_missing');
  const executionLedger = verifyTrustedLedgerReceipt({ receipt: executionReceipt, ledgerReceiptId: executionReceipt?.ledgerReceiptId, receiptLedger, expectedKinds: ['FormalVerifierExecutionReceipt'], expectedStatuses: ['formal_verifier_execution_verified'], expectedStreams: ['formal-verifier-executions'], expectedWriterKinds: ['formal-verifier-runner'] });
  blockers.push(...executionLedger.blockers.map((item) => `formal_execution:${item}`));
  const certificateWriteReceipt = certificate?.artifactWriteReceipt || null;
  const certificateLedger = verifyTrustedLedgerReceipt({ receipt: certificateWriteReceipt, ledgerReceiptId: certificate?.ledgerReceiptId, receiptLedger, expectedKinds: ['ArtifactWriteReceipt'], expectedStreams: ['artifact-writes'], expectedWriterKinds: ['content-addressed-repository'] });
  blockers.push(...certificateLedger.blockers.map((item) => `formal_certificate:${item}`));
  if (certificate?.ledgerReceiptId !== certificateWriteReceipt?.ledgerReceiptId) {
    blockers.push('formal_certificate_artifact_ledger_identity_mismatch');
  }
  if (certificateWriteReceipt?.hash !== certificate?.certificateHash) blockers.push('formal_certificate_artifact_hash_mismatch');
  if (!embeddedFormalArtifactReceiptValid(certificateWriteReceipt, {
    path: certificateWriteReceipt?.path,
    hash: certificate?.certificateHash,
  })) blockers.push('formal_certificate_artifact_receipt_invalid');
  const sourceLedgerVerifications = (Array.isArray(sourceRecords) ? sourceRecords : []).map((source) => {
    const verification = verifyTrustedLedgerReceipt({ receipt: source?.artifactWriteReceipt, ledgerReceiptId: source?.ledgerReceiptId, receiptLedger, expectedKinds: ['ArtifactWriteReceipt'], expectedStreams: ['artifact-writes'], expectedWriterKinds: ['content-addressed-repository'] });
    blockers.push(...verification.blockers.map((item) => `formal_source:${item}`));
    if (source?.ledgerReceiptId !== source?.artifactWriteReceipt?.ledgerReceiptId) {
      blockers.push('formal_source_artifact_ledger_identity_mismatch');
    }
    if (source?.artifactWriteReceipt?.hash !== source?.hash) blockers.push('formal_source_artifact_hash_mismatch');
    if (source?.artifactWriteReceipt?.path !== source?.path) blockers.push('formal_source_artifact_path_mismatch');
    if (!embeddedFormalArtifactReceiptValid(source?.artifactWriteReceipt, {
      path: source?.path,
      hash: source?.hash,
    })) blockers.push('formal_source_artifact_receipt_invalid');
    return verification;
  });
  const executionSourceHashes = [...new Set((executionReceipt?.sourceHashes || []).map(String))].sort();
  const sourceHashes = [...new Set((Array.isArray(sourceRecords) ? sourceRecords : []).map((item) => String(item?.hash || '')))].sort();
  if (executionSourceHashes.length !== sourceHashes.length || executionSourceHashes.some((value, index) => value !== sourceHashes[index])) blockers.push('formal_execution_source_hashes_mismatch');
  const artifactSources = [
    { label: 'certificate', receipt: certificateWriteReceipt },
    ...(Array.isArray(sourceRecords) ? sourceRecords : []).map((item, index) => ({ label: `source:${index}`, receipt: item?.artifactWriteReceipt })),
  ].map(({ label, receipt }) => ({ label, verification: typeof artifactVerifier === 'function' ? artifactVerifier({ receipt }) : { status: 'artifact_write_receipt_source_blocked', blockers: ['artifact_source_verifier_required'] } }));
  for (const item of artifactSources) blockers.push(...(item.verification.blockers || []).map((blocker) => `formal_${item.label}:${blocker}`));
  const nativeFormalVerification = verifyNativeFormalResearchClosureBinding(
    nativeResearchWorkerExecution,
    {
      paperId: expectedPaperId,
      campaignId: expectedCampaignId,
      researchSourceSnapshotHash: expectedResearchSourceSnapshotHash,
      taskKey: expectedTaskKey,
      proposalBinding: expectedProposalBinding,
      expectedClaimBindings,
    },
  );
  blockers.push(...nativeFormalVerification.blockers.map((blocker) => (
    `native_formal:${blocker}`
  )));
  const currentNativeFormalReceipt = nativeFormalReceipt(
    nativeResearchWorkerExecution,
  );
  const nativeFormalLedger = verifyTrustedLedgerReceipt({
    receipt: currentNativeFormalReceipt,
    ledgerReceiptId: currentNativeFormalReceipt?.ledgerReceiptId,
    receiptLedger,
    expectedKinds: ['NativeResearchWorkerExecutionReceipt'],
    expectedStatuses: ['native_research_worker_execution_verified'],
    expectedStreams: ['jobs'],
    expectedWriterKinds: ['native-research-worker'],
  });
  blockers.push(...nativeFormalLedger.blockers.map((item) => (
    `native_formal:${item}`
  )));
  const trustedLedgerReceiptsVerified = [
    executionLedger,
    certificateLedger,
    ...sourceLedgerVerifications,
  ].every((item) => item.status === 'trusted_ledger_receipt_verified');
  const artifactSourcesVerified = artifactSources.every((item) => (
    item.verification.status === 'artifact_write_receipt_source_verified'
  ));
  const payload = {
    version: 3,
    kind: 'GenericFormalCertificateIntake',
    status: blockers.length ? 'formal_certificate_intake_blocked' : 'formal_certificate_intake_verified',
    paperId: validId(paperId) ? paperId : null,
    campaignId: validId(campaignId) ? campaignId : null,
    researchSourceSnapshotHash: validHash(researchSourceSnapshotHash)
      ? String(researchSourceSnapshotHash).toLowerCase() : null,
    verifierKind: descriptor?.kind || verifierKind || null,
    command: descriptor?.command || null,
    extension: descriptor?.extension || null,
    certificateHash: certificate?.certificateHash || null,
    certificate: certificate ? Object.freeze({
      kind: certificate.kind || null,
      certificateHash: certificate.certificateHash || null,
      toolchainHash: certificate.toolchainHash || null,
      artifactWriteReceipt: certificate.artifactWriteReceipt || null,
      ledgerReceiptId: certificate.ledgerReceiptId || null,
    }) : null,
    toolchainHash: certificate?.toolchainHash || null,
    executionReceipt: executionReceipt || null,
    executionReceiptHash: executionReceipt?.receiptHash || null,
    formalVerifierRegistryHash: verifierRegistry?.formalVerifierRegistryHash || null,
    adapterReceiptHash: registryEntry?.adapterReceiptHash || null,
    certificateWriteReceiptHash: certificateWriteReceipt?.writeReceiptHash || null,
    sourceManifestHash: sourceManifest.formalSourceManifestHash,
    sourceManifest,
    claimBindingsHash: claimBindingsManifest.formalClaimBindingsHash,
    claimBindingsManifest,
    executionContractHash: executionContract.formalExecutionContractHash,
    executionContract,
    isolationPolicyHash: executionContract.isolationPolicyHash,
    isolationReceiptHash: executionReceipt?.isolationReceiptHash || null,
    executionLedgerReceiptId: executionReceipt?.ledgerReceiptId || null,
    certificateLedgerReceiptId: certificate?.ledgerReceiptId || null,
    trustedLedgerReceiptsVerified,
    trustedNativeFormalReceiptVerified:
      nativeFormalLedger.status === 'trusted_ledger_receipt_verified',
    artifactSourcesVerified,
    nativeFormalClosureBinding: nativeFormalVerification.binding,
    nativeFormalClosureBindingHash:
      nativeFormalVerification.binding?.nativeFormalClosureBindingHash || null,
    sourceRecords: (Array.isArray(sourceRecords) ? sourceRecords : []).map((item) => Object.freeze({
      path: item.path,
      hash: item.hash,
      sourceReadReceiptHash: item.sourceReadReceiptHash || null,
      artifactWriteReceipt: item.artifactWriteReceipt || null,
      ledgerReceiptId: item.ledgerReceiptId || null,
    })),
    claimBindings: (Array.isArray(claimBindings) ? claimBindings : []).map((item) => ({ claimId: item.claimId, obligationId: item.obligationId, statementHash: item.statementHash })),
    blockers: [...new Set(blockers)],
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, genericFormalCertificateIntakeHash: hashRecord('GenericFormalCertificateIntake', payload) });
}
