import { hashRecord } from '../workflow-kernel/record-hash.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export const RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS = Object.freeze({
  EXTERNAL_KMS_COMMAND: 'external-kms-command',
  LOCAL_FILE: 'local-file',
});

export function researchExecutionReleaseSignerBackendDescriptorHash(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return null;
  const { researchExecutionReleaseSignerBackendDescriptorHash: _hash, ...payload } = descriptor;
  return hashRecord('ResearchExecutionReleaseSignerBackendDescriptor', payload);
}

export function assertResearchExecutionReleaseSignerBackendDescriptor(descriptor) {
  const expectedHash = researchExecutionReleaseSignerBackendDescriptorHash(descriptor);
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
    || descriptor.researchExecutionReleaseSignerBackendDescriptorHash !== expectedHash) {
    throw new Error('ResearchExecutionReleaseSignerBackendDescriptor v1 is required');
  }
  if (descriptor.productionEligible === true
    && (descriptor.backendKind !== RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS.EXTERNAL_KMS_COMMAND
      || descriptor.hardwareProtected !== true
      || descriptor.privateKeyExportable !== false
      || descriptor.externalSignerProcess !== true)) {
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
