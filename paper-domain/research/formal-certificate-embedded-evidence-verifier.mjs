import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { computeReceiptHash } from '../evidence/receipt-hash-policy.mjs';
import {
  buildFormalClaimBindingsManifest,
  buildFormalExecutionContract,
  buildFormalSourceManifest,
} from './formal-certificate-evidence-contracts.mjs';
import { formalVerifierDescriptor } from './formal-verifier-registry.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/i;
const CERTIFICATE_KEYS = Object.freeze([
  'artifactWriteReceipt', 'certificateHash', 'kind', 'ledgerReceiptId',
  'toolchainHash',
]);
const SOURCE_RECORD_KEYS = Object.freeze([
  'artifactWriteReceipt', 'hash', 'ledgerReceiptId', 'path',
  'sourceReadReceiptHash',
]);
const ARTIFACT_WRITE_RECEIPT_KEYS = Object.freeze([
  'atomic', 'bytes', 'casRoot', 'contentAddress', 'contentType', 'createdAt',
  'externalActionPerformed', 'hash', 'immutableObject', 'kind',
  'ledgerReceiptId', 'manifestHash', 'manifestPath', 'objectCreated', 'path',
  'repositoryId', 'role', 'scopeRoot', 'scopedWriteTargetIdentityHash',
  'version', 'writeReceiptHash',
]);
const validHash = (value) => HASH.test(String(value || ''));
const validId = (value) => (
  typeof value === 'string' && value.trim() === value && value.length > 0
);
const sourceExtension = (value) => {
  const leaf = String(value || '').replace(/\\/g, '/').split('/').pop() || '';
  const index = leaf.lastIndexOf('.');
  return index > 0 ? leaf.slice(index).toLowerCase() : '';
};

export function embeddedFormalArtifactReceiptValid(
  receipt,
  { path = null, hash = null } = {},
) {
  return hasExactObjectKeys(receipt, ARTIFACT_WRITE_RECEIPT_KEYS)
    && receipt?.version === 2
    && receipt?.kind === 'ArtifactWriteReceipt'
    && receipt?.path === path
    && receipt?.hash === hash
    && receipt?.contentAddress === hash
    && Number.isSafeInteger(Number(receipt?.bytes))
    && Number(receipt.bytes) > 0
    && validHash(receipt?.manifestHash)
    && validHash(receipt?.scopedWriteTargetIdentityHash)
    && validHash(receipt?.writeReceiptHash)
    && computeReceiptHash(receipt) === receipt.writeReceiptHash
    && validId(receipt?.ledgerReceiptId)
    && receipt?.immutableObject === true
    && receipt?.atomic === true
    && typeof receipt?.objectCreated === 'boolean'
    && receipt?.externalActionPerformed === false;
}

export function embeddedFormalEvidenceBlockers(intake) {
  const blockers = [];
  const descriptor = formalVerifierDescriptor(intake?.verifierKind);
  const certificate = intake?.certificate || null;
  const executionReceipt = intake?.executionReceipt || null;
  const sourceRecords = Array.isArray(intake?.sourceRecords)
    ? intake.sourceRecords : [];
  const sourceManifest = buildFormalSourceManifest({
    verifierKind: intake?.verifierKind,
    sourceRecords,
  });
  const claimBindingsManifest = buildFormalClaimBindingsManifest({
    claimBindings: intake?.claimBindings,
  });
  const executionContract = buildFormalExecutionContract({
    verifierKind: intake?.verifierKind,
    command: intake?.command,
    certificateHash: certificate?.certificateHash,
    toolchainHash: certificate?.toolchainHash,
    sourceManifestHash: sourceManifest.formalSourceManifestHash,
    claimBindingsHash: claimBindingsManifest.formalClaimBindingsHash,
    certificateWriteReceiptHash:
      certificate?.artifactWriteReceipt?.writeReceiptHash,
    adapterReceiptHash: intake?.adapterReceiptHash,
  });
  if (!descriptor
    || !hasExactObjectKeys(certificate, CERTIFICATE_KEYS)
    || certificate?.kind !== descriptor?.certificateKind
    || certificate?.certificateHash !== intake?.certificateHash
    || certificate?.toolchainHash !== intake?.toolchainHash
    || certificate?.ledgerReceiptId !== intake?.certificateLedgerReceiptId
    || certificate?.artifactWriteReceipt?.ledgerReceiptId
      !== certificate?.ledgerReceiptId
    || !embeddedFormalArtifactReceiptValid(certificate?.artifactWriteReceipt, {
      path: certificate?.artifactWriteReceipt?.path,
      hash: certificate?.certificateHash,
    })
    || certificate?.artifactWriteReceipt?.writeReceiptHash
      !== intake?.certificateWriteReceiptHash) {
    blockers.push('formal_certificate_intake_embedded_certificate_invalid');
  }
  if (!sourceRecords.length) {
    blockers.push('formal_certificate_intake_embedded_sources_missing');
  }
  for (const [index, source] of sourceRecords.entries()) {
    if (!hasExactObjectKeys(source, SOURCE_RECORD_KEYS)
      || sourceExtension(source?.path) !== descriptor?.extension
      || !validHash(source?.hash)
      || !validHash(source?.sourceReadReceiptHash)
      || source?.ledgerReceiptId !== source?.artifactWriteReceipt?.ledgerReceiptId
      || !embeddedFormalArtifactReceiptValid(source?.artifactWriteReceipt, {
        path: source?.path,
        hash: source?.hash,
      })) {
      blockers.push(`formal_certificate_intake_embedded_source_invalid:${index}`);
    }
  }
  if (JSON.stringify(intake?.sourceManifest) !== JSON.stringify(sourceManifest)
    || intake?.sourceManifestHash !== sourceManifest.formalSourceManifestHash
    || executionReceipt?.sourceManifestHash
      !== sourceManifest.formalSourceManifestHash) {
    blockers.push('formal_certificate_intake_embedded_source_manifest_invalid');
  }
  if (JSON.stringify(intake?.claimBindingsManifest)
      !== JSON.stringify(claimBindingsManifest)
    || intake?.claimBindingsHash
      !== claimBindingsManifest.formalClaimBindingsHash
    || executionReceipt?.claimBindingsHash
      !== claimBindingsManifest.formalClaimBindingsHash) {
    blockers.push('formal_certificate_intake_embedded_claim_manifest_invalid');
  }
  if (JSON.stringify(intake?.executionContract) !== JSON.stringify(executionContract)
    || intake?.executionContractHash
      !== executionContract.formalExecutionContractHash
    || intake?.isolationPolicyHash !== executionContract.isolationPolicyHash
    || executionReceipt?.executionContractHash
      !== executionContract.formalExecutionContractHash
    || executionReceipt?.isolationPolicyHash
      !== executionContract.isolationPolicyHash) {
    blockers.push('formal_certificate_intake_embedded_execution_contract_invalid');
  }
  const executionSourceHashes = [...new Set(
    (executionReceipt?.sourceHashes || []).map(String),
  )].sort();
  const embeddedSourceHashes = [...new Set(sourceRecords
    .map((source) => String(source?.hash || '')))].sort();
  if (executionReceipt?.version !== 1
    || executionReceipt?.kind !== 'FormalVerifierExecutionReceipt'
    || executionReceipt?.status !== 'formal_verifier_execution_verified'
    || executionReceipt?.receiptHash !== intake?.executionReceiptHash
    || computeReceiptHash(executionReceipt) !== executionReceipt?.receiptHash
    || executionReceipt?.ledgerReceiptId !== intake?.executionLedgerReceiptId
    || executionReceipt?.paperId !== intake?.paperId
    || executionReceipt?.campaignId !== intake?.campaignId
    || executionReceipt?.researchSourceSnapshotHash
      !== intake?.researchSourceSnapshotHash
    || executionReceipt?.verifierKind !== descriptor?.kind
    || executionReceipt?.command !== descriptor?.command
    || executionReceipt?.certificateHash !== certificate?.certificateHash
    || executionReceipt?.toolchainHash !== certificate?.toolchainHash
    || executionReceipt?.certificateWriteReceiptHash
      !== certificate?.artifactWriteReceipt?.writeReceiptHash
    || executionReceipt?.adapterReceiptHash !== intake?.adapterReceiptHash
    || executionReceipt?.isolationReceiptHash !== intake?.isolationReceiptHash
    || JSON.stringify(executionSourceHashes) !== JSON.stringify(embeddedSourceHashes)
    || executionReceipt?.networkPolicy !== 'none'
    || executionReceipt?.secretAccessPerformed !== false
    || executionReceipt?.sourceMutationDetected !== false
    || executionReceipt?.externalActionPerformed !== false
    || executionReceipt?.providerCallPerformed !== false
    || executionReceipt?.commitPerformed !== false
    || executionReceipt?.isolation?.kernelNetworkIsolationVerified !== true
    || executionReceipt?.isolation?.sourceReadOnlyVerified !== true
    || executionReceipt?.isolation?.ephemeralWorkRootVerified !== true
    || executionReceipt?.isolation?.separateOutputRootVerified !== true
    || !validHash(executionReceipt?.sourceMerkleHashBefore)
    || executionReceipt?.sourceMerkleHashBefore
      !== executionReceipt?.sourceMerkleHashAfter
    || Number(executionReceipt?.exitCode) !== 0
    || !validHash(executionReceipt?.stdoutHash)
    || !validHash(executionReceipt?.stderrHash)
    || !validId(executionReceipt?.runnerId)
    || !validHash(executionReceipt?.runnerDescriptorHash)) {
    blockers.push('formal_certificate_intake_embedded_execution_receipt_invalid');
  }
  return blockers;
}
