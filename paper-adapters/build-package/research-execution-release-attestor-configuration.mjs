import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  RESEARCH_EXECUTION_RELEASE_ATTESTATION_MAXIMUM_LIFETIME_MS,
  RESEARCH_EXECUTION_RELEASE_ATTESTOR_ROLE,
} from '../../paper-domain/automation/campaign-release-execution-attestation-contract.mjs';
import {
  assertResearchExecutionReleaseSignerBackendPort,
  RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS,
} from '../../paper-ports/research-execution-release-signer-backend-port.mjs';
import {
  createExternalKmsReleaseSignerBackend,
  RESEARCH_EXECUTION_RELEASE_SIGNER_PROBE_ROLE,
} from './research-execution-release-signer-command-backend.mjs';
import {
  verifyResearchExecutionReleaseKmsHardwareAttestationBundle,
} from './research-execution-release-kms-hardware-attestation.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  openPinnedRegularFileSync,
  samePinnedFileIdentity,
} from '../runtime/pinned-file-reader.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';

const DEFAULT_CONFIG_NAME = 'RESEARCH_EXECUTION_RELEASE_ATTESTOR.json';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const SAFE_ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9 ._():-]{0,159}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const LOCAL_CONFIGURATION_KEYS = Object.freeze([
  'algorithm', 'attestationLifetimeSeconds', 'effectiveFrom', 'expiresAt',
  'keyId', 'kind', 'organization', 'privateKeyPath', 'revoked', 'role',
  'status', 'subjectId', 'version',
]);
const LOCAL_CONFIGURATION_KEYS_WITH_VERSION = Object.freeze([
  ...LOCAL_CONFIGURATION_KEYS,
  'keyVersion',
]);
const EXTERNAL_CONFIGURATION_KEYS = Object.freeze([
  'attestationLifetimeSeconds', 'backend', 'kind', 'status', 'trustSet',
  'version',
]);
const EXTERNAL_CONFIGURATION_V3_KEYS = Object.freeze([
  ...EXTERNAL_CONFIGURATION_KEYS,
  'hardwareAuthorityAttestation',
]);
const TRUST_SET_KEYS = Object.freeze(['keys', 'kind', 'version']);
const TRUST_KEY_KEYS = Object.freeze([
  'algorithm', 'effectiveFrom', 'expiresAt', 'keyId', 'keyVersion',
  'organization', 'publicKeyPath', 'revokedAt', 'role', 'status', 'subjectId',
]);
const COMMAND_KEYS = Object.freeze([
  'args', 'credentialRoot', 'environmentAllowlist', 'executable',
  'principalId', 'protocol', 'serviceId', 'timeoutMs',
]);
const EXTERNAL_BACKEND_KEYS = Object.freeze([
  'activeKeyId', 'activeKeyVersion', 'algorithm', 'backendId',
  'backendVersion', 'externalSignerProcess', 'hardwareProtected', 'kind',
  'privateKeyExportable', 'probeAttestor', 'probeCommand', 'signerCommand',
]);
const EXTERNAL_BACKEND_V3_KEYS = Object.freeze([
  ...EXTERNAL_BACKEND_KEYS,
  'credentialGenerationIdentityHash', 'keyResourceIdentityHash', 'kmsProvider',
  'providerAccountIdentityHash',
]);
const DEDICATED_UID_BACKEND_KEYS = Object.freeze([
  ...EXTERNAL_BACKEND_KEYS,
  'assuranceProfile',
  'threatBoundary',
]);
const HARDWARE_AUTHORITY_ATTESTATION_KEYS = Object.freeze([
  'bundlePath', 'challengeHash', 'signerKeyIds', 'trustStoreHash',
]);

function readIntegrityRegularFile(candidate, {
  maximumBytes,
  privateFile = false,
  errorCode,
} = {}) {
  let pinned = null;
  try {
    const requested = path.resolve(candidate);
    const resolved = fs.realpathSync(requested);
    if (resolved !== requested) throw new Error(errorCode);
    pinned = openPinnedRegularFileSync(requested, { errorCode });
    const stat = pinned.opened;
    const currentUid = BigInt(
      typeof process.getuid === 'function' ? process.getuid() : Number(stat.uid),
    );
    if (stat.nlink !== 1n || stat.size < 1n || stat.size > BigInt(maximumBytes)
      || (privateFile
        ? stat.uid !== currentUid || (stat.mode & 0o077n) !== 0n
        : (stat.uid !== 0n && stat.uid !== currentUid)
          || (stat.mode & 0o022n) !== 0n)) {
      throw new Error(errorCode);
    }
    const bytes = fs.readFileSync(pinned.descriptor);
    const after = fs.fstatSync(pinned.descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(requested, { bigint: true });
    if (BigInt(bytes.length) !== stat.size
      || !samePinnedFileIdentity(stat, after)
      || !samePinnedFileIdentity(after, pathAfter)) {
      throw new Error(errorCode);
    }
    return Object.freeze({
      path: requested,
      bytes,
      fileHash: hashBytes(bytes),
    });
  } catch {
    return null;
  } finally {
    if (pinned?.descriptor !== undefined) fs.closeSync(pinned.descriptor);
  }
}

function privateOwnedRegularFile(candidate, maximumBytes) {
  return readIntegrityRegularFile(candidate, {
    maximumBytes,
    privateFile: true,
    errorCode: 'research_execution_release_attestor_private_file_invalid',
  });
}

function integrityPublicKeyFile(candidate) {
  const read = readIntegrityRegularFile(String(candidate || ''), {
    maximumBytes: 64 * 1024,
    privateFile: false,
    errorCode: 'research_execution_release_attestor_integrity_file_invalid',
  });
  if (!read) {
    throw new Error('research_execution_release_attestor_integrity_file_invalid');
  }
  return read;
}

function canonicalTimestamp(value) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? timestamp : null;
}

function organizationIdentity(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
    : null;
}

function resolveRelative(candidate, configPath) {
  return path.isAbsolute(String(candidate || ''))
    ? path.resolve(String(candidate))
    : path.resolve(path.dirname(configPath), String(candidate || ''));
}

function configurationDisclosesPrivateKey(value) {
  if (typeof value === 'string') return /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/.test(value);
  if (Array.isArray(value)) return value.some(configurationDisclosesPrivateKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => (
    /^(?:privateKey|privateKeyPath|privateKeyPem|privateKeyMaterial)$/i.test(key)
      || configurationDisclosesPrivateKey(item)
  ));
}

function publicSigner(value, { configPath, role, requireExplicitVersion = true }) {
  const keyVersion = requireExplicitVersion ? value?.keyVersion : value?.keyVersion || 'legacy-v1';
  if (!hasExactObjectKeys(value, TRUST_KEY_KEYS)
    || !SAFE_ID.test(String(value.keyId || ''))
    || !SAFE_VERSION.test(String(keyVersion || ''))
    || !SAFE_ID.test(String(value.subjectId || ''))
    || !SAFE_ORGANIZATION.test(String(value.organization || ''))
    || value.algorithm !== 'ed25519' || value.role !== role) {
    throw new Error('research_execution_release_attestor_trusted_signer_invalid');
  }
  const publicKeyFile = integrityPublicKeyFile(
    resolveRelative(value.publicKeyPath, configPath),
  );
  const publicKeyText = publicKeyFile.bytes.toString('utf8');
  if (/PRIVATE KEY/.test(publicKeyText)) {
    throw new Error('research_execution_release_attestor_public_key_invalid');
  }
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(publicKeyText);
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('wrong algorithm');
  } catch { throw new Error('research_execution_release_attestor_public_key_invalid'); }
  return Object.freeze({
    signer: Object.freeze({
      keyId: String(value.keyId),
      keyVersion: String(keyVersion),
      subjectId: String(value.subjectId),
      organization: String(value.organization),
      role,
      algorithm: 'ed25519',
    }),
    publicKey,
    publicKeySpkiHash: hashBytes(publicKey.export({ type: 'spki', format: 'der' })),
  });
}

function trustWindow(value, { permittedStatus }) {
  const effectiveFrom = canonicalTimestamp(value?.effectiveFrom);
  const expiresAt = canonicalTimestamp(value?.expiresAt);
  const revokedAt = value?.revokedAt === null || value?.revokedAt === undefined
    ? null : canonicalTimestamp(value.revokedAt);
  if (!permittedStatus.includes(value?.status)
    || effectiveFrom === null || expiresAt === null || effectiveFrom >= expiresAt
    || (value?.revokedAt !== null && value?.revokedAt !== undefined && revokedAt === null)) {
    throw new Error('research_execution_release_attestor_trust_key_window_invalid');
  }
  return Object.freeze({
    status: value.status,
    effectiveFrom: new Date(effectiveFrom).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    revokedAt: revokedAt === null ? null : new Date(revokedAt).toISOString(),
  });
}

function trustKey(value, configPath) {
  return Object.freeze({
    ...publicSigner(value, {
      configPath,
      role: RESEARCH_EXECUTION_RELEASE_ATTESTOR_ROLE,
      requireExplicitVersion: true,
    }),
    ...trustWindow(value, { permittedStatus: ['active', 'retiring'] }),
  });
}

function probeAttestor(value, configPath) {
  const parsed = publicSigner(value, {
    configPath,
    role: RESEARCH_EXECUTION_RELEASE_SIGNER_PROBE_ROLE,
    requireExplicitVersion: true,
  });
  const window = trustWindow(value, { permittedStatus: ['active'] });
  if (window.revokedAt !== null) {
    throw new Error('research_execution_release_attestor_probe_attestor_revoked');
  }
  return Object.freeze({ ...parsed, ...window });
}

function publicTrustKey(key) {
  return Object.freeze({
    ...key.signer,
    status: key.status,
    publicKeySpkiHash: key.publicKeySpkiHash,
    effectiveFrom: key.effectiveFrom,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt,
  });
}

function hardwareAuthorityAttestation(value, configPath) {
  const signerKeyIds = [...new Set((Array.isArray(value?.signerKeyIds)
    ? value.signerKeyIds : []).map(String))].sort();
  const expectedTrustStoreHash = String(value?.trustStoreHash || '').toLowerCase();
  const challengeHash = String(value?.challengeHash || '').toLowerCase();
  if (!hasExactObjectKeys(value, HARDWARE_AUTHORITY_ATTESTATION_KEYS)
    || signerKeyIds.length < 1 || signerKeyIds.length > 4
    || signerKeyIds.some((keyId) => !SAFE_ID.test(keyId))
    || JSON.stringify(signerKeyIds) !== JSON.stringify(value.signerKeyIds)
    || !SHA256.test(expectedTrustStoreHash)
    || !SHA256.test(challengeHash)) {
    throw new Error(
      'research_execution_release_attestor_kms_hardware_authority_configuration_invalid',
    );
  }
  const file = readIntegrityRegularFile(
    resolveRelative(value.bundlePath, configPath),
    {
      maximumBytes: 1024 * 1024,
      privateFile: false,
      errorCode:
        'research_execution_release_attestor_kms_hardware_authority_file_invalid',
    },
  );
  if (!file) {
    throw new Error(
      'research_execution_release_attestor_kms_hardware_authority_file_invalid',
    );
  }
  let bundle = null;
  try { bundle = JSON.parse(file.bytes.toString('utf8')); } catch { bundle = null; }
  if (!verifyResearchExecutionReleaseKmsHardwareAttestationBundle(bundle)
    || bundle.trustStoreHash !== expectedTrustStoreHash
    || bundle.subject?.challengeHash !== challengeHash
    || JSON.stringify(bundle.signerKeyIds) !== JSON.stringify(signerKeyIds)) {
    throw new Error(
      'research_execution_release_attestor_kms_hardware_authority_bundle_invalid',
    );
  }
  return Object.freeze({
    bundle,
    bundlePath: file.path,
    bundleFileHash: file.fileHash,
    trustStoreHash: expectedTrustStoreHash,
    signerKeyIds: Object.freeze(signerKeyIds),
    challengeHash,
  });
}

function localFileConfiguration(value, { requested, lifetimeMs }) {
  const privateKeyCandidate = String(value.privateKeyPath || '');
  const privateKeyPath = path.isAbsolute(privateKeyCandidate)
    ? path.resolve(privateKeyCandidate)
    : path.resolve(path.dirname(requested), privateKeyCandidate);
  const privateKeyFile = privateOwnedRegularFile(privateKeyPath, 64 * 1024);
  const privateKeyPem = privateKeyFile?.bytes.toString('utf8') || null;
  const effectiveFrom = canonicalTimestamp(String(value.effectiveFrom || ''));
  const expiresAt = canonicalTimestamp(String(value.expiresAt || ''));
  const keyVersion = String(value.keyVersion || 'legacy-v1');
  if (!privateKeyPem || !/-----BEGIN PRIVATE KEY-----/.test(privateKeyPem)
    || !SAFE_ID.test(String(value.keyId || '')) || !SAFE_VERSION.test(keyVersion)
    || !SAFE_ID.test(String(value.subjectId || ''))
    || !SAFE_ORGANIZATION.test(String(value.organization || ''))
    || value.algorithm !== 'ed25519' || value.role !== RESEARCH_EXECUTION_RELEASE_ATTESTOR_ROLE
    || value.status !== 'active' || value.revoked === true
    || effectiveFrom === null || expiresAt === null || expiresAt <= effectiveFrom
    || !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 60_000
    || lifetimeMs > RESEARCH_EXECUTION_RELEASE_ATTESTATION_MAXIMUM_LIFETIME_MS) {
    throw new Error('research_execution_release_attestor_configuration_material_invalid');
  }
  let privateKey;
  let publicKey;
  try {
    privateKey = crypto.createPrivateKey(privateKeyPem);
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
    publicKey = crypto.createPublicKey(privateKey);
  } catch { throw new Error('research_execution_release_attestor_private_key_invalid'); }
  const key = Object.freeze({
    signer: Object.freeze({
      keyId: String(value.keyId),
      keyVersion,
      subjectId: String(value.subjectId),
      organization: String(value.organization),
      role: RESEARCH_EXECUTION_RELEASE_ATTESTOR_ROLE,
      algorithm: 'ed25519',
    }),
    publicKey,
    publicKeySpkiHash: hashBytes(publicKey.export({ type: 'spki', format: 'der' })),
    status: 'active',
    effectiveFrom: new Date(effectiveFrom).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    revokedAt: null,
  });
  const commandIdentityHash = hashRecord('ResearchExecutionReleaseLocalFileSignerIdentity', {
    keyId: key.signer.keyId,
    keyVersion: key.signer.keyVersion,
    publicKeySpkiHash: key.publicKeySpkiHash,
  });
  const trustSetHash = hashRecord('ResearchExecutionReleaseAttestorTrustSet', {
    version: 1,
    keys: [publicTrustKey(key)],
  });
  const descriptorPayload = {
    version: 1,
    kind: 'ResearchExecutionReleaseSignerBackendDescriptor',
    backendKind: RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS.LOCAL_FILE,
    backendId: `local-file:${key.signer.keyId}`,
    backendVersion: key.signer.keyVersion,
    algorithm: 'ed25519',
    hardwareProtected: false,
    privateKeyExportable: true,
    externalSignerProcess: false,
    productionEligible: false,
    activeKeyId: key.signer.keyId,
    activeKeyVersion: key.signer.keyVersion,
    activePublicKeySpkiHash: key.publicKeySpkiHash,
    trustSetHash,
    commandIdentityHash,
    probeCommandIdentityHash: null,
    probeAttestorPublicKeySpkiHash: null,
    credentialMaterialReadByMainProcess: true,
  };
  const descriptor = Object.freeze({
    ...descriptorPayload,
    researchExecutionReleaseSignerBackendDescriptorHash: hashRecord(
      'ResearchExecutionReleaseSignerBackendDescriptor',
      descriptorPayload,
    ),
  });
  const backendPort = assertResearchExecutionReleaseSignerBackendPort(Object.freeze({
    version: 1,
    kind: 'ResearchExecutionReleaseSignerBackendPort',
    describeBackend: () => descriptor,
    probeBackend: () => Object.freeze({ verified: false, attestation: null }),
    signDigest({ signingPayloadHash, keyId, keyVersion: requestedVersion } = {}) {
      if (!SHA256.test(String(signingPayloadHash || ''))
        || keyId !== key.signer.keyId || requestedVersion !== key.signer.keyVersion) {
        throw new Error('research_execution_release_attestor_signing_request_invalid');
      }
      return crypto.sign(null, Buffer.from(signingPayloadHash, 'utf8'), privateKey).toString('base64');
    },
  }));
  return Object.freeze({
    lifetimeMs,
    trustedKeys: Object.freeze([key]),
    activeKey: key,
    backendPort,
    probeAttestor: null,
    trustSetVersion: 1,
  });
}

function externalConfiguration(value, options) {
  if (configurationDisclosesPrivateKey(value)) {
    throw new Error('research_execution_release_attestor_private_key_disclosure_forbidden');
  }
  const { requested, lifetimeMs } = options;
  const version3 = value.version === 3;
  const externalKms = value.backend?.kind === 'external-kms-command';
  const backendKeys = value.backend?.kind === 'dedicated-uid-command'
    ? DEDICATED_UID_BACKEND_KEYS
    : version3 ? EXTERNAL_BACKEND_V3_KEYS : EXTERNAL_BACKEND_KEYS;
  const configurationKeys = version3
    ? EXTERNAL_CONFIGURATION_V3_KEYS : EXTERNAL_CONFIGURATION_KEYS;
  if (!hasExactObjectKeys(value, configurationKeys)
    || !hasExactObjectKeys(value.trustSet, TRUST_SET_KEYS)
    || !hasExactObjectKeys(value.backend, backendKeys)
    || !hasExactObjectKeys(value.backend?.signerCommand, COMMAND_KEYS)
    || !hasExactObjectKeys(value.backend?.probeCommand, COMMAND_KEYS)
    || !hasExactObjectKeys(value.backend?.probeAttestor, TRUST_KEY_KEYS)
    || value.status !== 'active' || !value.trustSet
    || (version3 && !externalKms)
    || value.trustSet.version !== 1
    || value.trustSet.kind !== 'ResearchExecutionReleaseAttestorTrustSet'
    || !Array.isArray(value.trustSet.keys) || value.trustSet.keys.length < 1
    || value.trustSet.keys.length > 32 || !Number.isSafeInteger(lifetimeMs)
    || lifetimeMs < 60_000
    || lifetimeMs > RESEARCH_EXECUTION_RELEASE_ATTESTATION_MAXIMUM_LIFETIME_MS) {
    throw new Error('research_execution_release_attestor_configuration_material_invalid');
  }
  const trustedKeys = value.trustSet.keys.map((key) => trustKey(key, requested))
    .sort((left, right) => `${left.signer.keyId}:${left.signer.keyVersion}`
      .localeCompare(`${right.signer.keyId}:${right.signer.keyVersion}`));
  const tuples = trustedKeys.map((key) => `${key.signer.keyId}:${key.signer.keyVersion}`);
  const spkiHashes = trustedKeys.map((key) => key.publicKeySpkiHash);
  if (new Set(tuples).size !== tuples.length || new Set(spkiHashes).size !== spkiHashes.length) {
    throw new Error('research_execution_release_attestor_trust_set_key_identity_collision');
  }
  const activeKeys = trustedKeys.filter((key) => key.status === 'active' && key.revokedAt === null);
  if (activeKeys.length !== 1) {
    throw new Error('research_execution_release_attestor_exactly_one_active_key_required');
  }
  const activeKey = activeKeys[0];
  const trustSetHash = hashRecord('ResearchExecutionReleaseAttestorTrustSet', {
    version: 1,
    keys: trustedKeys.map(publicTrustKey),
  });
  const independentProbeAttestor = probeAttestor(value.backend?.probeAttestor, requested);
  if (independentProbeAttestor.signer.subjectId === activeKey.signer.subjectId
    || organizationIdentity(independentProbeAttestor.signer.organization)
      === organizationIdentity(activeKey.signer.organization)) {
    throw new Error('research_execution_release_attestor_independent_backend_probe_required');
  }
  const backendPort = createExternalKmsReleaseSignerBackend({
    backendValue: value.backend,
    configurationVersion: value.version,
    configPath: requested,
    environment: options.environment,
    spawnSyncImpl: options.spawnSyncImpl,
    randomBytesImpl: options.randomBytesImpl,
    activeKey,
    trustedKeys,
    trustSetHash,
    probeAttestor: independentProbeAttestor,
  });
  const kmsHardwareAuthorityAttestation = version3
    ? hardwareAuthorityAttestation(value.hardwareAuthorityAttestation, requested)
    : null;
  return Object.freeze({
    configurationVersion: value.version,
    lifetimeMs,
    trustedKeys: Object.freeze(trustedKeys),
    activeKey,
    backendPort,
    probeAttestor: independentProbeAttestor,
    kmsHardwareAuthorityAttestation,
    trustSetVersion: 1,
  });
}

function stableBlocker(error) {
  const message = String(error?.message || '');
  return /^research_execution_release_attestor_[a-z0-9_:-]{1,240}$/.test(message)
    ? message : 'research_execution_release_attestor_config_invalid';
}

export function inspectProvisionedReleaseAttestorConfigurationHeader({
  runtimeRoot,
  configPath = null,
  environment = process.env,
} = {}) {
  const requested = configPath || environment.HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG
    || (runtimeRoot ? path.join(runtimeRoot, 'trust', DEFAULT_CONFIG_NAME) : null);
  if (!requested) {
    return Object.freeze({
      configurationVersion: null,
      backendKind: null,
      configurationFileHash: null,
      blocker: 'research_execution_release_attestor_config_path_missing',
    });
  }
  const configFile = privateOwnedRegularFile(requested, 256 * 1024);
  if (!configFile) {
    return Object.freeze({
      configurationVersion: null,
      backendKind: null,
      configurationFileHash: null,
      blocker: 'research_execution_release_attestor_config_not_private_regular_file',
    });
  }
  let value = null;
  try { value = JSON.parse(configFile.bytes.toString('utf8')); } catch { value = null; }
  if (!value || value.kind !== 'ResearchExecutionReleaseAttestorConfiguration') {
    return Object.freeze({
      configurationVersion: null,
      backendKind: null,
      configurationFileHash: configFile.fileHash,
      blocker: 'research_execution_release_attestor_config_invalid',
    });
  }
  return Object.freeze({
    configurationVersion:
      Number.isSafeInteger(value.version) ? value.version : null,
    backendKind: typeof value.backend?.kind === 'string'
      ? value.backend.kind : value.version === 1 ? 'local-file' : null,
    configurationFileHash: configFile.fileHash,
    blocker: null,
  });
}

export function readProvisionedReleaseAttestorConfiguration({
  runtimeRoot,
  configPath = null,
  expectedConfigurationHash = null,
  requiredConfigurationVersion = null,
  requiredBackendKind = null,
  environment = process.env,
  spawnSyncImpl = spawnSync,
  randomBytesImpl = crypto.randomBytes,
} = {}) {
  const requested = configPath || environment.HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG
    || (runtimeRoot ? path.join(runtimeRoot, 'trust', DEFAULT_CONFIG_NAME) : null);
  if (!requested) {
    return { configuration: null, blocker: 'research_execution_release_attestor_config_path_missing' };
  }
  const configuredExpectedHash = expectedConfigurationHash
    ?? environment.HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG_HASH
    ?? null;
  const normalizedExpectedHash = configuredExpectedHash === null
    ? null : String(configuredExpectedHash || '').toLowerCase();
  if (normalizedExpectedHash !== null && !SHA256.test(normalizedExpectedHash)) {
    return {
      configuration: null,
      blocker: 'research_execution_release_attestor_config_pin_mismatch',
    };
  }
  const configFile = privateOwnedRegularFile(requested, 256 * 1024);
  if (!configFile) {
    return {
      configuration: null,
      blocker: 'research_execution_release_attestor_config_not_private_regular_file',
    };
  }
  const text = configFile.bytes.toString('utf8');
  let value = null;
  try { value = JSON.parse(text); } catch { value = null; }
  if (!value || ![1, 2, 3].includes(value.version)
    || value.kind !== 'ResearchExecutionReleaseAttestorConfiguration'
    || (value.version === 1
      && !hasExactObjectKeys(value, LOCAL_CONFIGURATION_KEYS)
      && !hasExactObjectKeys(value, LOCAL_CONFIGURATION_KEYS_WITH_VERSION))) {
    return { configuration: null, blocker: 'research_execution_release_attestor_config_invalid' };
  }
  if ((requiredConfigurationVersion !== null
      && value.version !== requiredConfigurationVersion)
    || (requiredBackendKind !== null
      && value.backend?.kind !== requiredBackendKind)) {
    return {
      configuration: null,
      blocker:
        'research_execution_release_attestor_external_kms_v3_configuration_required',
    };
  }
  const lifetimeMs = Number(value.attestationLifetimeSeconds) * 1000;
  try {
    const resolved = path.resolve(requested);
    const parsed = value.version === 1
      ? localFileConfiguration(value, { requested: resolved, lifetimeMs })
      : externalConfiguration(value, {
        requested: resolved,
        lifetimeMs,
        environment,
        spawnSyncImpl,
        randomBytesImpl,
      });
    const publicKeys = Object.freeze(parsed.trustedKeys.map(publicTrustKey));
    const descriptor = parsed.backendPort.describeBackend();
    const publicProbeAttestor = parsed.probeAttestor
      ? Object.freeze({
        ...parsed.probeAttestor.signer,
        status: parsed.probeAttestor.status,
        publicKeySpkiHash: parsed.probeAttestor.publicKeySpkiHash,
        effectiveFrom: parsed.probeAttestor.effectiveFrom,
        expiresAt: parsed.probeAttestor.expiresAt,
        revokedAt: parsed.probeAttestor.revokedAt,
      }) : null;
    const trustSetHash = hashRecord('ResearchExecutionReleaseAttestorTrustSet', {
      version: parsed.trustSetVersion,
      keys: publicKeys,
    });
    const kmsHardwareAuthorityIdentity = value.version === 3
      ? {
        kmsHardwareAuthorityPolicy: {
          verificationPolicy:
            'pinned-independent-kms-control-plane-ed25519-v1',
          bundlePath:
            parsed.kmsHardwareAuthorityAttestation?.bundlePath || null,
          trustStoreHash:
            parsed.kmsHardwareAuthorityAttestation?.trustStoreHash || null,
          signerKeyIds:
            parsed.kmsHardwareAuthorityAttestation?.signerKeyIds || null,
          challengeHash:
            parsed.kmsHardwareAuthorityAttestation?.challengeHash || null,
        },
      } : {
        kmsHardwareAuthorityAttestationBundleHash:
          parsed.kmsHardwareAuthorityAttestation?.bundle?.bundleHash || null,
        kmsHardwareAuthorityAttestationBundleFileHash:
          parsed.kmsHardwareAuthorityAttestation?.bundleFileHash || null,
        kmsHardwareAuthorityTrustStoreHash:
          parsed.kmsHardwareAuthorityAttestation?.trustStoreHash || null,
      };
    const configurationIdentityHash = hashRecord(
      'ResearchExecutionReleaseAttestorConfigurationIdentity',
      {
        version: value.version,
        lifetimeMs: parsed.lifetimeMs,
        trustSetVersion: parsed.trustSetVersion,
        trustSetHash,
        backendDescriptorHash:
          descriptor.researchExecutionReleaseSignerBackendDescriptorHash,
        probeAttestor: publicProbeAttestor,
        ...kmsHardwareAuthorityIdentity,
      },
    );
    if (normalizedExpectedHash !== null
      && normalizedExpectedHash !== configurationIdentityHash) {
      return {
        configuration: null,
        blocker: 'research_execution_release_attestor_config_pin_mismatch',
      };
    }
    return {
      configuration: Object.freeze({
        ...parsed,
        publicKeys,
        trustSetHash,
        configurationFileHash: configFile.fileHash,
        configurationIdentityHash,
        configurationIdentityProfile: value.version === 3
          ? 'stable-kms-authority-policy-and-rotating-bundle-v3'
          : 'exact-resolved-configuration-v1',
        configurationPinned:
          normalizedExpectedHash !== null
          && normalizedExpectedHash === configurationIdentityHash,
      }),
      blocker: null,
    };
  } catch (error) {
    return { configuration: null, blocker: stableBlocker(error) };
  }
}
