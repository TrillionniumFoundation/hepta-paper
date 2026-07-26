import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { computeReceiptHash } from '../evidence/receipt-hash-policy.mjs';
import { verifyTrustedLedgerReceipt } from '../evidence/trusted-ledger-receipt.mjs';
import {
  buildFormalClaimBindingsManifest,
  buildFormalExecutionContract,
  buildFormalSourceManifest,
} from './formal-certificate-evidence-contracts.mjs';
import {
  embeddedFormalArtifactReceiptValid,
} from './formal-certificate-embedded-evidence-verifier.mjs';
import {
  canonicalFormalClosureClaimBindings,
  formalCertificateSourceExtension,
  validFormalCertificateHash,
  validFormalCertificateId,
} from './formal-certificate-intake-primitives.mjs';
import {
  nativeFormalReceipt,
  verifyNativeFormalResearchClosureBinding,
} from './formal-certificate-native-closure.mjs';
import { formalVerifierDescriptor } from './formal-verifier-registry.mjs';

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
  const sourceManifest = buildFormalSourceManifest({
    verifierKind: descriptor?.kind || verifierKind,
    sourceRecords,
  });
  const claimBindingsManifest = buildFormalClaimBindingsManifest({
    claimBindings,
  });
  if (!descriptor) blockers.push('formal_verifier_kind_unknown');
  const registryEntry = verifierRegistry?.verifiers?.find(
    (item) => item?.kind === descriptor?.kind,
  ) || null;
  if (verifierRegistry?.status !== 'formal_verifier_registry_ready'
    || registryEntry?.status !== 'formal_verifier_registered') {
    blockers.push('formal_verifier_adapter_not_registered');
  }
  if (certificate?.kind !== descriptor?.certificateKind) {
    blockers.push('formal_certificate_kind_mismatch');
  }
  if (!validFormalCertificateHash(certificate?.certificateHash)) {
    blockers.push('formal_certificate_hash_invalid');
  }
  if (!validFormalCertificateHash(certificate?.toolchainHash)) {
    blockers.push('formal_toolchain_hash_invalid');
  }
  if (!Array.isArray(sourceRecords) || !sourceRecords.length) {
    blockers.push('formal_certificate_source_records_missing');
  }
  for (const [index, source] of sourceRecords.entries()) {
    if (formalCertificateSourceExtension(source?.path)
      !== descriptor?.extension) {
      blockers.push(`formal_source_extension_invalid:${index}`);
    }
    if (!validFormalCertificateHash(source?.hash)) {
      blockers.push(`formal_source_hash_invalid:${index}`);
    }
    if (!validFormalCertificateHash(source?.sourceReadReceiptHash)) {
      blockers.push(`formal_source_read_receipt_hash_invalid:${index}`);
    }
  }
  if (!Array.isArray(claimBindings) || !claimBindings.length) {
    blockers.push('formal_claim_bindings_missing');
  }
  for (const [index, binding] of claimBindings.entries()) {
    if (!binding?.claimId
      || !binding?.obligationId
      || !validFormalCertificateHash(binding?.statementHash)) {
      blockers.push(`formal_claim_binding_invalid:${index}`);
    }
  }
  const observedClosureBindings = canonicalFormalClosureClaimBindings(
    claimBindings,
  );
  const expectedClosureBindings = canonicalFormalClosureClaimBindings(
    expectedClaimBindings,
  );
  if (!validFormalCertificateId(paperId)
    || !validFormalCertificateId(expectedPaperId)
    || paperId !== expectedPaperId
    || executionReceipt?.paperId !== paperId) {
    blockers.push('formal_evidence_paper_lineage_mismatch');
  }
  if (!validFormalCertificateId(campaignId)
    || !validFormalCertificateId(expectedCampaignId)
    || campaignId !== expectedCampaignId
    || executionReceipt?.campaignId !== campaignId) {
    blockers.push('formal_evidence_campaign_lineage_mismatch');
  }
  if (!validFormalCertificateHash(researchSourceSnapshotHash)
    || !validFormalCertificateHash(expectedResearchSourceSnapshotHash)
    || researchSourceSnapshotHash !== expectedResearchSourceSnapshotHash
    || executionReceipt?.researchSourceSnapshotHash
      !== researchSourceSnapshotHash) {
    blockers.push('formal_evidence_research_source_snapshot_lineage_mismatch');
  }
  if (!observedClosureBindings
    || !expectedClosureBindings
    || JSON.stringify(observedClosureBindings)
      !== JSON.stringify(expectedClosureBindings)) {
    blockers.push('formal_evidence_current_claim_bindings_mismatch');
  }
  const executionContract = buildFormalExecutionContract({
    verifierKind: descriptor?.kind || verifierKind,
    command: descriptor?.command,
    certificateHash: certificate?.certificateHash,
    toolchainHash: certificate?.toolchainHash,
    sourceManifestHash: sourceManifest.formalSourceManifestHash,
    claimBindingsHash: claimBindingsManifest.formalClaimBindingsHash,
    certificateWriteReceiptHash:
      certificate?.artifactWriteReceipt?.writeReceiptHash,
    adapterReceiptHash: registryEntry?.adapterReceiptHash,
  });
  if (executionReceipt?.status !== 'formal_verifier_execution_verified') {
    blockers.push('formal_execution_receipt_not_verified');
  }
  if (executionReceipt?.verifierKind !== descriptor?.kind) {
    blockers.push('formal_execution_verifier_kind_mismatch');
  }
  if (!validFormalCertificateHash(executionReceipt?.receiptHash)
    || computeReceiptHash(executionReceipt) !== executionReceipt?.receiptHash) {
    blockers.push('formal_execution_receipt_hash_invalid');
  }
  if (executionReceipt?.certificateHash !== certificate?.certificateHash) {
    blockers.push('formal_execution_certificate_hash_mismatch');
  }
  if (executionReceipt?.toolchainHash !== certificate?.toolchainHash) {
    blockers.push('formal_execution_toolchain_hash_mismatch');
  }
  if (executionReceipt?.command !== descriptor?.command) {
    blockers.push('formal_execution_command_mismatch');
  }
  if (executionReceipt?.adapterReceiptHash !== registryEntry?.adapterReceiptHash) {
    blockers.push('formal_execution_adapter_receipt_mismatch');
  }
  if (executionReceipt?.certificateWriteReceiptHash
    !== certificate?.artifactWriteReceipt?.writeReceiptHash) {
    blockers.push('formal_execution_certificate_receipt_mismatch');
  }
  if (executionReceipt?.sourceManifestHash
    !== sourceManifest.formalSourceManifestHash) {
    blockers.push('formal_execution_source_manifest_mismatch');
  }
  if (executionReceipt?.claimBindingsHash
    !== claimBindingsManifest.formalClaimBindingsHash) {
    blockers.push('formal_execution_claim_bindings_mismatch');
  }
  if (executionReceipt?.executionContractHash
    !== executionContract.formalExecutionContractHash) {
    blockers.push('formal_execution_contract_mismatch');
  }
  if (executionReceipt?.isolationPolicyHash
    !== executionContract.isolationPolicyHash) {
    blockers.push('formal_execution_isolation_policy_mismatch');
  }
  if (!validFormalCertificateHash(executionReceipt?.isolationReceiptHash)) {
    blockers.push('formal_execution_isolation_receipt_hash_invalid');
  }
  if (executionReceipt?.networkPolicy !== 'none'
    || executionReceipt?.secretAccessPerformed !== false
    || executionReceipt?.sourceMutationDetected !== false
    || executionReceipt?.externalActionPerformed !== false
    || executionReceipt?.providerCallPerformed !== false
    || executionReceipt?.commitPerformed !== false) {
    blockers.push('formal_execution_isolation_claim_invalid');
  }
  if (executionReceipt?.isolation?.kernelNetworkIsolationVerified !== true
    || executionReceipt?.isolation?.sourceReadOnlyVerified !== true
    || executionReceipt?.isolation?.ephemeralWorkRootVerified !== true
    || executionReceipt?.isolation?.separateOutputRootVerified !== true) {
    blockers.push('formal_execution_isolation_not_verified');
  }
  if (!validFormalCertificateHash(executionReceipt?.sourceMerkleHashBefore)
    || executionReceipt?.sourceMerkleHashBefore
      !== executionReceipt?.sourceMerkleHashAfter) {
    blockers.push('formal_execution_source_integrity_invalid');
  }
  if (Number(executionReceipt?.exitCode) !== 0) {
    blockers.push('formal_execution_exit_code_invalid');
  }
  if (!validFormalCertificateHash(executionReceipt?.stdoutHash)
    || !validFormalCertificateHash(executionReceipt?.stderrHash)) {
    blockers.push('formal_execution_output_hash_invalid');
  }
  if (!executionReceipt?.runnerId
    || !validFormalCertificateHash(executionReceipt?.runnerDescriptorHash)) {
    blockers.push('formal_execution_runner_identity_missing');
  }
  const executionLedger = verifyTrustedLedgerReceipt({
    receipt: executionReceipt,
    ledgerReceiptId: executionReceipt?.ledgerReceiptId,
    receiptLedger,
    expectedKinds: ['FormalVerifierExecutionReceipt'],
    expectedStatuses: ['formal_verifier_execution_verified'],
    expectedStreams: ['formal-verifier-executions'],
    expectedWriterKinds: ['formal-verifier-runner'],
  });
  blockers.push(...executionLedger.blockers.map(
    (item) => `formal_execution:${item}`,
  ));
  const certificateWriteReceipt = certificate?.artifactWriteReceipt || null;
  const certificateLedger = verifyTrustedLedgerReceipt({
    receipt: certificateWriteReceipt,
    ledgerReceiptId: certificate?.ledgerReceiptId,
    receiptLedger,
    expectedKinds: ['ArtifactWriteReceipt'],
    expectedStreams: ['artifact-writes'],
    expectedWriterKinds: ['content-addressed-repository'],
  });
  blockers.push(...certificateLedger.blockers.map(
    (item) => `formal_certificate:${item}`,
  ));
  if (certificate?.ledgerReceiptId
    !== certificateWriteReceipt?.ledgerReceiptId) {
    blockers.push('formal_certificate_artifact_ledger_identity_mismatch');
  }
  if (certificateWriteReceipt?.hash !== certificate?.certificateHash) {
    blockers.push('formal_certificate_artifact_hash_mismatch');
  }
  if (!embeddedFormalArtifactReceiptValid(certificateWriteReceipt, {
    path: certificateWriteReceipt?.path,
    hash: certificate?.certificateHash,
  })) {
    blockers.push('formal_certificate_artifact_receipt_invalid');
  }
  const sourceLedgerVerifications = (
    Array.isArray(sourceRecords) ? sourceRecords : []
  ).map((source) => {
    const verification = verifyTrustedLedgerReceipt({
      receipt: source?.artifactWriteReceipt,
      ledgerReceiptId: source?.ledgerReceiptId,
      receiptLedger,
      expectedKinds: ['ArtifactWriteReceipt'],
      expectedStreams: ['artifact-writes'],
      expectedWriterKinds: ['content-addressed-repository'],
    });
    blockers.push(...verification.blockers.map(
      (item) => `formal_source:${item}`,
    ));
    if (source?.ledgerReceiptId
      !== source?.artifactWriteReceipt?.ledgerReceiptId) {
      blockers.push('formal_source_artifact_ledger_identity_mismatch');
    }
    if (source?.artifactWriteReceipt?.hash !== source?.hash) {
      blockers.push('formal_source_artifact_hash_mismatch');
    }
    if (source?.artifactWriteReceipt?.path !== source?.path) {
      blockers.push('formal_source_artifact_path_mismatch');
    }
    if (!embeddedFormalArtifactReceiptValid(source?.artifactWriteReceipt, {
      path: source?.path,
      hash: source?.hash,
    })) {
      blockers.push('formal_source_artifact_receipt_invalid');
    }
    return verification;
  });
  const executionSourceHashes = [...new Set(
    (executionReceipt?.sourceHashes || []).map(String),
  )].sort();
  const sourceHashes = [...new Set((
    Array.isArray(sourceRecords) ? sourceRecords : []
  ).map((item) => String(item?.hash || '')))].sort();
  if (executionSourceHashes.length !== sourceHashes.length
    || executionSourceHashes.some(
      (value, index) => value !== sourceHashes[index],
    )) {
    blockers.push('formal_execution_source_hashes_mismatch');
  }
  const artifactSources = [
    { label: 'certificate', receipt: certificateWriteReceipt },
    ...(Array.isArray(sourceRecords) ? sourceRecords : []).map(
      (item, index) => ({
        label: `source:${index}`,
        receipt: item?.artifactWriteReceipt,
      }),
    ),
  ].map(({ label, receipt }) => ({
    label,
    verification: typeof artifactVerifier === 'function'
      ? artifactVerifier({ receipt })
      : {
        status: 'artifact_write_receipt_source_blocked',
        blockers: ['artifact_source_verifier_required'],
      },
  }));
  for (const item of artifactSources) {
    blockers.push(...(item.verification.blockers || []).map(
      (blocker) => `formal_${item.label}:${blocker}`,
    ));
  }
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
  blockers.push(...nativeFormalVerification.blockers.map(
    (blocker) => `native_formal:${blocker}`,
  ));
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
  blockers.push(...nativeFormalLedger.blockers.map(
    (item) => `native_formal:${item}`,
  ));
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
    status: blockers.length
      ? 'formal_certificate_intake_blocked'
      : 'formal_certificate_intake_verified',
    paperId: validFormalCertificateId(paperId) ? paperId : null,
    campaignId: validFormalCertificateId(campaignId) ? campaignId : null,
    researchSourceSnapshotHash:
      validFormalCertificateHash(researchSourceSnapshotHash)
        ? String(researchSourceSnapshotHash).toLowerCase()
        : null,
    verifierKind: descriptor?.kind || verifierKind || null,
    command: descriptor?.command || null,
    extension: descriptor?.extension || null,
    certificateHash: certificate?.certificateHash || null,
    certificate: certificate
      ? Object.freeze({
        kind: certificate.kind || null,
        certificateHash: certificate.certificateHash || null,
        toolchainHash: certificate.toolchainHash || null,
        artifactWriteReceipt: certificate.artifactWriteReceipt || null,
        ledgerReceiptId: certificate.ledgerReceiptId || null,
      })
      : null,
    toolchainHash: certificate?.toolchainHash || null,
    executionReceipt: executionReceipt || null,
    executionReceiptHash: executionReceipt?.receiptHash || null,
    formalVerifierRegistryHash:
      verifierRegistry?.formalVerifierRegistryHash || null,
    adapterReceiptHash: registryEntry?.adapterReceiptHash || null,
    certificateWriteReceiptHash:
      certificateWriteReceipt?.writeReceiptHash || null,
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
    sourceRecords: (
      Array.isArray(sourceRecords) ? sourceRecords : []
    ).map((item) => Object.freeze({
      path: item.path,
      hash: item.hash,
      sourceReadReceiptHash: item.sourceReadReceiptHash || null,
      artifactWriteReceipt: item.artifactWriteReceipt || null,
      ledgerReceiptId: item.ledgerReceiptId || null,
    })),
    claimBindings: (
      Array.isArray(claimBindings) ? claimBindings : []
    ).map((item) => ({
      claimId: item.claimId,
      obligationId: item.obligationId,
      statementHash: item.statementHash,
    })),
    blockers: [...new Set(blockers)],
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    genericFormalCertificateIntakeHash:
      hashRecord('GenericFormalCertificateIntake', payload),
  });
}
