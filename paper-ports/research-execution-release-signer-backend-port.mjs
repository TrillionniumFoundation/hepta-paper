import { hashRecord } from '../workflow-kernel/record-hash.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export const RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS = Object.freeze({
  DEDICATED_UID_COMMAND: 'dedicated-uid-command',
  EXTERNAL_KMS_COMMAND: 'external-kms-command',
  LOCAL_FILE: 'local-file',
});

export function researchExecutionReleaseSignerBackendProductionAssuranceReady(descriptor) {
  if (descriptor?.productionEligible !== true || descriptor?.externalSignerProcess !== true
    || descriptor?.credentialMaterialReadByMainProcess !== false) return false;
  if (descriptor.backendKind === RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS
    .EXTERNAL_KMS_COMMAND) {
    return descriptor.hardwareProtected === true && descriptor.privateKeyExportable === false;
  }
  return descriptor.backendKind === RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS
    .DEDICATED_UID_COMMAND
    && descriptor.hardwareProtected === false
    && descriptor.privateKeyExportable === true
    && descriptor.assuranceProfile === 'dedicated-host-uid-unix-socket-v1'
    && descriptor.threatBoundary === 'research-runtime-uid';
}

export function researchExecutionReleaseSignerBackendDescriptorHash(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return null;
  const { researchExecutionReleaseSignerBackendDescriptorHash: _hash, ...payload } = descriptor;
  return hashRecord('ResearchExecutionReleaseSignerBackendDescriptor', payload);
}

export function assertResearchExecutionReleaseSignerBackendDescriptor(descriptor) {
  const expectedHash = researchExecutionReleaseSignerBackendDescriptorHash(descriptor);
  const kmsIdentityFields = [
    descriptor?.kmsProvider,
    descriptor?.providerAccountIdentityHash,
    descriptor?.keyResourceIdentityHash,
    descriptor?.credentialGenerationIdentityHash,
  ];
  const kmsIdentityFieldCount = kmsIdentityFields
    .filter((value) => value !== undefined).length;
  if (!descriptor || descriptor.version !== 1
    || descriptor.kind !== 'ResearchExecutionReleaseSignerBackendDescriptor'
    || !Object.values(RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS)
      .includes(descriptor.backendKind)
    || !SAFE_ID.test(String(descriptor.backendId || ''))
    || !SAFE_VERSION.test(String(descriptor.backendVersion || ''))
    || descriptor.algorithm !== 'ed25519'
    || typeof descriptor.hardwareProtected !== 'boolean'
    || typeof descriptor.privateKeyExportable !== 'boolean'
    || typeof descriptor.externalSignerProcess !== 'boolean'
    || typeof descriptor.productionEligible !== 'boolean'
    || !SAFE_ID.test(String(descriptor.activeKeyId || ''))
    || !SAFE_VERSION.test(String(descriptor.activeKeyVersion || ''))
    || !SHA256.test(String(descriptor.activePublicKeySpkiHash || ''))
    || !SHA256.test(String(descriptor.trustSetHash || ''))
    || !SHA256.test(String(descriptor.commandIdentityHash || ''))
    || (descriptor.backendKind
      === RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS.EXTERNAL_KMS_COMMAND
      ? kmsIdentityFieldCount !== 0 && (
        kmsIdentityFieldCount !== kmsIdentityFields.length
        || !SAFE_ID.test(String(descriptor.kmsProvider || ''))
        || !SHA256.test(String(descriptor.providerAccountIdentityHash || ''))
        || !SHA256.test(String(descriptor.keyResourceIdentityHash || ''))
        || !SHA256.test(String(descriptor.credentialGenerationIdentityHash || ''))
      )
      : kmsIdentityFieldCount !== 0)
    || descriptor.researchExecutionReleaseSignerBackendDescriptorHash !== expectedHash) {
    throw new Error('ResearchExecutionReleaseSignerBackendDescriptor v1 is required');
  }
  if (descriptor.productionEligible === true
    && !researchExecutionReleaseSignerBackendProductionAssuranceReady(descriptor)) {
    throw new Error('research_execution_release_signer_backend_production_assurance_invalid');
  }
  return descriptor;
}

export function assertResearchExecutionReleaseSignerBackendPort(port) {
  if (!port || port.version !== 1
    || port.kind !== 'ResearchExecutionReleaseSignerBackendPort'
    || typeof port.describeBackend !== 'function'
    || typeof port.probeBackend !== 'function'
    || typeof port.signDigest !== 'function') {
    throw new Error('ResearchExecutionReleaseSignerBackendPort v1 is required');
  }
  assertResearchExecutionReleaseSignerBackendDescriptor(port.describeBackend());
  return port;
}
