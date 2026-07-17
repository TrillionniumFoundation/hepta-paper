import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { formalVerifierDescriptor } from './formal-verifier-registry.mjs';
import { verifyTrustedLedgerReceipt } from '../evidence/trusted-ledger-receipt.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/i;
const validHash = (value) => HASH.test(String(value || ''));
const sourceExtension = (value) => {
  const leaf = String(value || '').replace(/\\/g, '/').split('/').pop() || '';
  const index = leaf.lastIndexOf('.');
  return index > 0 ? leaf.slice(index).toLowerCase() : '';
};

export function buildFormalSourceManifest({ verifierKind, sourceRecords = [] } = {}) {
  const payload = {
    version: 1,
    kind: 'FormalSourceManifest',
    verifierKind: verifierKind || null,
    sources: (Array.isArray(sourceRecords) ? sourceRecords : []).map((item) => ({
      path: item?.path || null,
      hash: item?.hash || null,
      manifestHash: item?.artifactWriteReceipt?.manifestHash || null,
      writeReceiptHash: item?.artifactWriteReceipt?.writeReceiptHash || null,
    })).sort((left, right) => String(left.path).localeCompare(String(right.path))),
  };
  return Object.freeze({ ...payload, formalSourceManifestHash: hashRecord('FormalSourceManifest', payload) });
}

export function buildFormalClaimBindingsManifest({ claimBindings = [] } = {}) {
  const payload = {
    version: 1,
    kind: 'FormalClaimBindingsManifest',
    bindings: (Array.isArray(claimBindings) ? claimBindings : []).map((item) => ({
      claimId: item?.claimId || null,
      obligationId: item?.obligationId || null,
      statementHash: item?.statementHash || null,
    })).sort((left, right) => `${left.claimId}:${left.obligationId}`.localeCompare(`${right.claimId}:${right.obligationId}`)),
  };
  return Object.freeze({ ...payload, formalClaimBindingsHash: hashRecord('FormalClaimBindingsManifest', payload) });
}

export function buildFormalExecutionContract({
  verifierKind,
  command,
  certificateHash,
  toolchainHash,
  sourceManifestHash,
  claimBindingsHash,
  certificateWriteReceiptHash,
  adapterReceiptHash,
} = {}) {
  const isolationPolicy = {
    networkPolicy: 'none',
    secretsAllowed: false,
    sourceMutationAllowed: false,
    externalActionsAllowed: false,
    providerCallsAllowed: false,
    commitsAllowed: false,
    sourceReadOnlyRequired: true,
    ephemeralWorkRootRequired: true,
    separateOutputRootRequired: true,
  };
  const payload = {
    version: 1,
    kind: 'FormalExecutionContract',
    verifierKind: verifierKind || null,
    command: command || null,
    certificateHash: certificateHash || null,
    toolchainHash: toolchainHash || null,
    sourceManifestHash: sourceManifestHash || null,
    claimBindingsHash: claimBindingsHash || null,
    certificateWriteReceiptHash: certificateWriteReceiptHash || null,
    adapterReceiptHash: adapterReceiptHash || null,
    isolationPolicy,
    isolationPolicyHash: hashRecord('FormalIsolationPolicy', isolationPolicy),
  };
  return Object.freeze({ ...payload, formalExecutionContractHash: hashRecord('FormalExecutionContract', payload) });
}

export function buildGenericFormalCertificateIntake({
  verifierKind,
  certificate = null,
  sourceRecords = [],
  claimBindings = [],
  executionReceipt = null,
  verifierRegistry = null,
  receiptLedger = null,
  artifactVerifier = null,
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
  }
  if (!Array.isArray(claimBindings) || !claimBindings.length) blockers.push('formal_claim_bindings_missing');
  for (const [index, binding] of claimBindings.entries()) {
    if (!binding?.claimId || !binding?.obligationId || !validHash(binding?.statementHash)) blockers.push(`formal_claim_binding_invalid:${index}`);
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
  if (!validHash(executionReceipt?.receiptHash)) blockers.push('formal_execution_receipt_hash_invalid');
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
  if (certificateWriteReceipt?.hash !== certificate?.certificateHash) blockers.push('formal_certificate_artifact_hash_mismatch');
  const sourceLedgerVerifications = (Array.isArray(sourceRecords) ? sourceRecords : []).map((source) => {
    const verification = verifyTrustedLedgerReceipt({ receipt: source?.artifactWriteReceipt, ledgerReceiptId: source?.ledgerReceiptId, receiptLedger, expectedKinds: ['ArtifactWriteReceipt'], expectedStreams: ['artifact-writes'], expectedWriterKinds: ['content-addressed-repository'] });
    blockers.push(...verification.blockers.map((item) => `formal_source:${item}`));
    if (source?.artifactWriteReceipt?.hash !== source?.hash) blockers.push('formal_source_artifact_hash_mismatch');
    if (source?.artifactWriteReceipt?.path !== source?.path) blockers.push('formal_source_artifact_path_mismatch');
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
  const payload = {
    version: 1,
    kind: 'GenericFormalCertificateIntake',
    status: blockers.length ? 'formal_certificate_intake_blocked' : 'formal_certificate_intake_verified',
    verifierKind: descriptor?.kind || verifierKind || null,
    command: descriptor?.command || null,
    extension: descriptor?.extension || null,
    certificateHash: certificate?.certificateHash || null,
    toolchainHash: certificate?.toolchainHash || null,
    executionReceiptHash: executionReceipt?.receiptHash || null,
    formalVerifierRegistryHash: verifierRegistry?.formalVerifierRegistryHash || null,
    adapterReceiptHash: registryEntry?.adapterReceiptHash || null,
    certificateWriteReceiptHash: certificateWriteReceipt?.writeReceiptHash || null,
    sourceManifestHash: sourceManifest.formalSourceManifestHash,
    claimBindingsHash: claimBindingsManifest.formalClaimBindingsHash,
    executionContractHash: executionContract.formalExecutionContractHash,
    isolationPolicyHash: executionContract.isolationPolicyHash,
    isolationReceiptHash: executionReceipt?.isolationReceiptHash || null,
    executionLedgerReceiptId: executionReceipt?.ledgerReceiptId || null,
    certificateLedgerReceiptId: certificate?.ledgerReceiptId || null,
    trustedLedgerReceiptsVerified: [executionLedger, certificateLedger, ...sourceLedgerVerifications].every((item) => item.status === 'trusted_ledger_receipt_verified'),
    artifactSourcesVerified: artifactSources.every((item) => item.verification.status === 'artifact_write_receipt_source_verified'),
    sourceRecords: (Array.isArray(sourceRecords) ? sourceRecords : []).map((item) => ({ path: item.path, hash: item.hash, ledgerReceiptId: item.ledgerReceiptId || null })),
    claimBindings: (Array.isArray(claimBindings) ? claimBindings : []).map((item) => ({ claimId: item.claimId, obligationId: item.obligationId, statementHash: item.statementHash })),
    blockers: [...new Set(blockers)],
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, genericFormalCertificateIntakeHash: hashRecord('GenericFormalCertificateIntake', payload) });
}
