import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  normalizeLocalReleaseAttestorSocketPolicy,
  requestLocalReleaseAttestor,
  startLocalReleaseAttestorServer,
} from './local-release-attestor-socket.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const SAFE_ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9 ._():-]{0,159}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAXIMUM_CONFIGURATION_BYTES = 128 * 1024;
const MAXIMUM_KEY_BYTES = 64 * 1024;
const RELEASE_ROLE = 'research_execution_release_attestor';
const PROBE_ROLE = 'research_execution_release_signer_backend_probe_attestor';

function exactRecord(value, expectedKeys, errorCode) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\n') !== [...expectedKeys].sort().join('\n')) {
    throw new Error(errorCode);
  }
  return value;
}

function regularFile(candidate, maximumBytes, { privateOwnerUid = null } = {}) {
  const selected = path.resolve(String(candidate || ''));
  const stat = fs.lstatSync(selected);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.size < 1 || stat.size > maximumBytes || (stat.mode & 0o022) !== 0
    || (privateOwnerUid !== null
      && (stat.uid !== privateOwnerUid || (stat.mode & 0o077) !== 0))) {
    throw new Error('local_release_attestor_file_invalid');
  }
  return Object.freeze({ path: selected, text: fs.readFileSync(selected, 'utf8') });
}

function publicKeyHash(publicKey) {
  return hashBytes(publicKey.export({ type: 'spki', format: 'der' }));
}

function signerMetadata(value, role) {
  exactRecord(value, [
    'keyId',
    'keyVersion',
    'organization',
    'privateKeyPath',
    'publicKeySpkiHash',
    'subjectId',
  ], 'local_release_attestor_signer_metadata_invalid');
  if (!SAFE_ID.test(String(value?.keyId || ''))
    || !SAFE_VERSION.test(String(value?.keyVersion || ''))
    || !SAFE_ID.test(String(value?.subjectId || ''))
    || !SAFE_ORGANIZATION.test(String(value?.organization || ''))) {
    throw new Error('local_release_attestor_signer_metadata_invalid');
  }
  return Object.freeze({
    keyId: String(value.keyId),
    keyVersion: String(value.keyVersion),
    subjectId: String(value.subjectId),
    organization: String(value.organization),
    role,
    algorithm: 'ed25519',
  });
}

function privateSigner(value, role, privateKeyOwnerUid) {
  const privateKeyFile = regularFile(value?.privateKeyPath, MAXIMUM_KEY_BYTES, {
    privateOwnerUid: privateKeyOwnerUid,
  });
  let privateKey;
  let publicKey;
  try {
    privateKey = crypto.createPrivateKey(privateKeyFile.text);
    publicKey = crypto.createPublicKey(privateKey);
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('algorithm');
  } catch {
    throw new Error('local_release_attestor_private_key_invalid');
  }
  const expectedPublicKeySpkiHash = String(value?.publicKeySpkiHash || '').toLowerCase();
  if (!SHA256.test(expectedPublicKeySpkiHash)
    || publicKeyHash(publicKey) !== expectedPublicKeySpkiHash) {
    throw new Error('local_release_attestor_public_key_pin_mismatch');
  }
  return Object.freeze({
    privateKey,
    publicKey,
    publicKeySpkiHash: expectedPublicKeySpkiHash,
    signer: signerMetadata(value, role),
  });
}

function pinnedPublicKey(value) {
  exactRecord(value, [
    'publicKeyPath',
    'publicKeySpkiHash',
  ], 'local_release_attestor_public_key_invalid');
  const publicKeyFile = regularFile(value?.publicKeyPath, MAXIMUM_KEY_BYTES);
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(publicKeyFile.text);
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('algorithm');
  } catch {
    throw new Error('local_release_attestor_public_key_invalid');
  }
  const expectedPublicKeySpkiHash = String(value?.publicKeySpkiHash || '').toLowerCase();
  if (!SHA256.test(expectedPublicKeySpkiHash)
    || publicKeyHash(publicKey) !== expectedPublicKeySpkiHash) {
    throw new Error('local_release_attestor_public_key_pin_mismatch');
  }
  return Object.freeze({ publicKey, publicKeySpkiHash: expectedPublicKeySpkiHash });
}

export function readLocalReleaseAttestorDaemonConfiguration({
  configurationPath,
  privateKeyOwnerUid = typeof process.getuid === 'function'
    ? process.getuid() : null,
} = {}) {
  if (!Number.isSafeInteger(privateKeyOwnerUid) || privateKeyOwnerUid < 0) {
    throw new Error('local_release_attestor_private_key_owner_uid_invalid');
  }
  const file = regularFile(configurationPath, MAXIMUM_CONFIGURATION_BYTES);
  let value;
  try { value = JSON.parse(file.text); }
  catch { throw new Error('local_release_attestor_configuration_invalid'); }
  if (value?.version === 1) {
    throw new Error('local_release_attestor_configuration_v2_required');
  }
  if (!value || value.version !== 2
    || value.kind !== 'LocalResearchExecutionReleaseAttestorDaemonConfiguration'
    || !['signer', 'probe'].includes(value.mode)
    || !SAFE_ID.test(String(value.backendId || ''))
    || !SAFE_ID.test(String(value.backendVersion || ''))
    || !path.isAbsolute(String(value.socketPath || ''))) {
    throw new Error('local_release_attestor_configuration_invalid');
  }
  if (!Object.hasOwn(value, 'socketPolicy')) {
    throw new Error('local_release_attestor_socket_policy_required');
  }
  exactRecord(value, value.mode === 'signer' ? [
    'authority',
    'backendId',
    'backendVersion',
    'kind',
    'mode',
    'socketPath',
    'socketPolicy',
    'version',
  ] : [
    'authority',
    'backendId',
    'backendVersion',
    'kind',
    'mode',
    'signerKeyId',
    'signerKeyVersion',
    'signerPublicKey',
    'signerSocketPath',
    'socketPath',
    'socketPolicy',
    'version',
  ], 'local_release_attestor_configuration_invalid');
  if (value.mode === 'probe'
    && (!SAFE_ID.test(String(value.signerKeyId || ''))
      || !SAFE_VERSION.test(String(value.signerKeyVersion || '')))) {
    throw new Error('local_release_attestor_configuration_invalid');
  }
  const socketPolicy = normalizeLocalReleaseAttestorSocketPolicy(value.socketPolicy);
  const authority = privateSigner(
    value.authority,
    value.mode === 'signer' ? RELEASE_ROLE : PROBE_ROLE,
    privateKeyOwnerUid,
  );
  const configurationFileHash = hashBytes(Buffer.from(file.text, 'utf8'));
  if (value.mode === 'signer') {
    return Object.freeze({
      ...value,
      socketPolicy,
      configurationPath: file.path,
      configurationFileHash,
      authority,
    });
  }
  if (!path.isAbsolute(String(value.signerSocketPath || ''))) {
    throw new Error('local_release_attestor_configuration_invalid');
  }
  return Object.freeze({
    ...value,
    socketPolicy,
    configurationPath: file.path,
    configurationFileHash,
    authority,
    signerPublicKey: pinnedPublicKey(value.signerPublicKey),
  });
}

export function preflightLocalReleaseAttestorDaemonConfigurationPair({
  signerConfigurationPath,
  probeConfigurationPath,
  signerPrivateKeyOwnerUid,
  probePrivateKeyOwnerUid,
} = {}) {
  const signer = readLocalReleaseAttestorDaemonConfiguration({
    configurationPath: signerConfigurationPath,
    privateKeyOwnerUid: signerPrivateKeyOwnerUid,
  });
  const probe = readLocalReleaseAttestorDaemonConfiguration({
    configurationPath: probeConfigurationPath,
    privateKeyOwnerUid: probePrivateKeyOwnerUid,
  });
  if (signer.mode !== 'signer' || probe.mode !== 'probe'
    || probe.backendId !== signer.backendId
    || probe.backendVersion !== signer.backendVersion
    || probe.signerSocketPath !== signer.socketPath
    || probe.signerKeyId !== signer.authority.signer.keyId
    || probe.signerKeyVersion !== signer.authority.signer.keyVersion
    || probe.signerPublicKey.publicKeySpkiHash !== signer.authority.publicKeySpkiHash) {
    throw new Error('local_release_attestor_configuration_pair_invalid');
  }
  const receipt = {
    version: 2,
    kind: 'LocalReleaseAttestorDeploymentConfigurationPreflightReceipt',
    status: 'local_release_attestor_deployment_configuration_preflight_passed',
    backendId: signer.backendId,
    backendVersion: signer.backendVersion,
    signerConfigurationFileHash: signer.configurationFileHash,
    probeConfigurationFileHash: probe.configurationFileHash,
    signerSocketPolicy: signer.socketPolicy,
    probeSocketPolicy: probe.socketPolicy,
  };
  return Object.freeze({
    ...receipt,
    localReleaseAttestorDeploymentConfigurationPreflightReceiptHash: hashRecord(
      'LocalReleaseAttestorDeploymentConfigurationPreflightReceipt',
      receipt,
    ),
  });
}

function signerResponse(configuration, request) {
  if (request?.version !== 1 || request?.kind !== 'ResearchExecutionReleaseSignerRequest'
    || request?.protocol !== 'hepta-release-signer-json-stdio-v1'
    || request?.operation !== 'sign-sha256-identity'
    || request?.backendId !== configuration.backendId
    || request?.backendVersion !== configuration.backendVersion
    || request?.keyId !== configuration.authority.signer.keyId
    || request?.keyVersion !== configuration.authority.signer.keyVersion
    || request?.algorithm !== 'ed25519'
    || !SHA256.test(String(request?.backendDescriptorHash || ''))
    || !SHA256.test(String(request?.signingPayloadHash || ''))
    || !SHA256.test(String(request?.requestNonceHash || ''))) {
    throw new Error('local_release_attestor_signing_request_invalid');
  }
  const signature = crypto.sign(
    null,
    Buffer.from(request.signingPayloadHash, 'utf8'),
    configuration.authority.privateKey,
  ).toString('base64');
  const payload = {
    version: 1,
    kind: 'ResearchExecutionReleaseSignerResponse',
    status: 'research_execution_release_digest_signed',
    backendDescriptorHash: request.backendDescriptorHash,
    backendId: configuration.backendId,
    backendVersion: configuration.backendVersion,
    keyId: configuration.authority.signer.keyId,
    keyVersion: configuration.authority.signer.keyVersion,
    algorithm: 'ed25519',
    signingPayloadHash: request.signingPayloadHash,
    requestNonceHash: request.requestNonceHash,
    signature,
  };
  return Object.freeze({
    ...payload,
    researchExecutionReleaseSignerResponseHash:
      hashRecord('ResearchExecutionReleaseSignerResponse', payload),
  });
}

async function proveSignerReachable(configuration, request) {
  const signingPayloadHash = hashRecord('LocalReleaseAttestorProbeSigningPayload', {
    backendDescriptorHash: request.backendDescriptorHash,
    challengeHash: request.challengeHash,
    activeKeyId: request.activeKeyId,
    activeKeyVersion: request.activeKeyVersion,
  });
  const requestNonce = crypto.randomBytes(32).toString('base64');
  const signerReceipt = await requestLocalReleaseAttestor({
    socketPath: configuration.signerSocketPath,
    request: {
      version: 1,
      kind: 'ResearchExecutionReleaseSignerRequest',
      protocol: 'hepta-release-signer-json-stdio-v1',
      operation: 'sign-sha256-identity',
      backendDescriptorHash: request.backendDescriptorHash,
      backendId: configuration.backendId,
      backendVersion: configuration.backendVersion,
      keyId: request.activeKeyId,
      keyVersion: request.activeKeyVersion,
      algorithm: 'ed25519',
      signingPayloadHash,
      requestNonce,
      requestNonceHash: hashBytes(Buffer.from(requestNonce, 'utf8')),
    },
  });
  try {
    return signerReceipt?.signingPayloadHash === signingPayloadHash
      && signerReceipt?.keyId === request.activeKeyId
      && signerReceipt?.keyVersion === request.activeKeyVersion
      && crypto.verify(
        null,
        Buffer.from(signingPayloadHash, 'utf8'),
        configuration.signerPublicKey.publicKey,
        Buffer.from(String(signerReceipt?.signature || ''), 'base64'),
      );
  } catch { return false; }
}

async function probeResponse(configuration, request) {
  if (request?.version !== 1
    || request?.kind !== 'ResearchExecutionReleaseSignerBackendProbeRequest'
    || request?.protocol !== 'hepta-release-signer-probe-json-stdio-v1'
    || request?.backendId !== configuration.backendId
    || request?.backendVersion !== configuration.backendVersion
    || request?.activeKeyId !== configuration.signerKeyId
    || request?.activeKeyVersion !== configuration.signerKeyVersion
    || request?.activePublicKeySpkiHash
      !== configuration.signerPublicKey.publicKeySpkiHash
    || request?.algorithm !== 'ed25519'
    || !SHA256.test(String(request?.backendDescriptorHash || ''))
    || !SHA256.test(String(request?.challengeHash || ''))
    || hashBytes(Buffer.from(String(request?.challenge || ''), 'utf8'))
      !== request.challengeHash) {
    throw new Error('local_release_attestor_probe_request_invalid');
  }
  if (!await proveSignerReachable(configuration, request)) {
    throw new Error('local_release_attestor_signer_unreachable');
  }
  const probedAtMs = Date.now() - 1000;
  const payload = {
    version: 1,
    kind: 'ResearchExecutionReleaseSignerBackendProbeAttestation',
    status: 'research_execution_release_signer_backend_probe_verified',
    backendDescriptorHash: request.backendDescriptorHash,
    backendId: configuration.backendId,
    backendVersion: configuration.backendVersion,
    activeKeyId: request.activeKeyId,
    activeKeyVersion: request.activeKeyVersion,
    activePublicKeySpkiHash: request.activePublicKeySpkiHash,
    algorithm: 'ed25519',
    challengeHash: request.challengeHash,
    backendReachable: true,
    hardwareProtected: false,
    privateKeyExportable: true,
    externalSignerProcess: true,
    probedAt: new Date(probedAtMs).toISOString(),
    expiresAt: new Date(probedAtMs + 4 * 60 * 1000).toISOString(),
    externalActionPerformed: true,
    externalActionScope: 'single_read_only_release_signer_backend_challenge',
    signer: configuration.authority.signer,
  };
  const signature = crypto.sign(
    null,
    Buffer.from(hashRecord(
      'ResearchExecutionReleaseSignerBackendProbeAttestationSigningPayload',
      payload,
    ), 'utf8'),
    configuration.authority.privateKey,
  ).toString('base64');
  const signed = { ...payload, signature };
  return Object.freeze({
    ...signed,
    researchExecutionReleaseSignerBackendProbeAttestationHash: hashRecord(
      'ResearchExecutionReleaseSignerBackendProbeAttestation',
      signed,
    ),
  });
}

export async function startLocalReleaseAttestorDaemon({
  configurationPath,
} = {}) {
  const configuration = readLocalReleaseAttestorDaemonConfiguration({
    configurationPath,
  });
  const listener = await startLocalReleaseAttestorServer({
    socketPath: configuration.socketPath,
    socketPolicy: configuration.socketPolicy,
    handleRequest: configuration.mode === 'signer'
      ? (request) => signerResponse(configuration, request)
      : (request) => probeResponse(configuration, request),
  });
  return Object.freeze({ configuration, listener });
}
