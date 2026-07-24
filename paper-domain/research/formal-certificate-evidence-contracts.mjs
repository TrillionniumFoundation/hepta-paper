import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function buildFormalSourceManifest({
  verifierKind,
  sourceRecords = [],
} = {}) {
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
  return Object.freeze({
    ...payload,
    formalSourceManifestHash: hashRecord('FormalSourceManifest', payload),
  });
}

export function buildFormalClaimBindingsManifest({ claimBindings = [] } = {}) {
  const payload = {
    version: 1,
    kind: 'FormalClaimBindingsManifest',
    bindings: (Array.isArray(claimBindings) ? claimBindings : []).map((item) => ({
      claimId: item?.claimId || null,
      obligationId: item?.obligationId || null,
      statementHash: item?.statementHash || null,
    })).sort((left, right) => (
      `${left.claimId}:${left.obligationId}`
        .localeCompare(`${right.claimId}:${right.obligationId}`)
    )),
  };
  return Object.freeze({
    ...payload,
    formalClaimBindingsHash: hashRecord('FormalClaimBindingsManifest', payload),
  });
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
  return Object.freeze({
    ...payload,
    formalExecutionContractHash: hashRecord('FormalExecutionContract', payload),
  });
}
