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
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const DEFAULT_CONFIG_NAME = 'RESEARCH_EXECUTION_RELEASE_ATTESTOR.json';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const SAFE_ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9 ._():-]{0,159}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/i;

function privateOwnedRegularFile(candidate, maximumBytes) {
  try {
    const requested = path.resolve(candidate);
    const stat = fs.lstatSync(requested);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== currentUid
      || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > maximumBytes
      || fs.realpathSync(requested) !== requested) return null;
    return fs.readFileSync(requested, 'utf8');
  } catch { return null; }
}

function integrityPublicKeyFile(candidate) {
  const requested = path.resolve(String(candidate || ''));
  const resolved = fs.realpathSync(requested);
  const stat = fs.statSync(resolved);
  if (requested !== resolved || !stat.isFile() || stat.size < 1 || stat.size > 64 * 1024
    || (stat.mode & 0o022) !== 0) {
    throw new Error('research_execution_release_attestor_integrity_file_invalid');
  }
  return resolved;
}

function canonicalTimestamp(value) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? timestamp : null;
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
  if (!value || !SAFE_ID.test(String(value.keyId || ''))
    || !SAFE_VERSION.test(String(keyVersion || ''))
    || !SAFE_ID.test(String(value.subjectId || ''))
    || !SAFE_ORGANIZATION.test(String(value.organization || ''))
    || value.algorithm !== 'ed25519' || value.role !== role) {
    throw new Error('research_execution_release_attestor_trusted_signer_invalid');
  }
  const publicKeyPath = integrityPublicKeyFile(resolveRelative(value.publicKeyPath, configPath));
  const publicKeyText = fs.readFileSync(publicKeyPath, 'utf8');
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

function localFileConfiguration(value, { requested, lifetimeMs }) {
  const privateKeyCandidate = String(value.privateKeyPath || '');
  const privateKeyPath = path.isAbsolute(privateKeyCandidate)
    ? path.resolve(privateKeyCandidate)
    : path.resolve(path.dirname(requested), privateKeyCandidate);
  const privateKeyPem = privateOwnedRegularFile(privateKeyPath, 64 * 1024);
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
  if (value.status !== 'active' || !value.trustSet
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
  const backendPort = createExternalKmsReleaseSignerBackend({
    backendValue: value.backend,
    configPath: requested,
    environment: options.environment,
    spawnSyncImpl: options.spawnSyncImpl,
    randomBytesImpl: options.randomBytesImpl,
    activeKey,
    trustedKeys,
    trustSetHash,
    probeAttestor: independentProbeAttestor,
  });
  return Object.freeze({
    lifetimeMs,
    trustedKeys: Object.freeze(trustedKeys),
    activeKey,
    backendPort,
    probeAttestor: independentProbeAttestor,
    trustSetVersion: 1,
  });
}

function stableBlocker(error) {
  const message = String(error?.message || '');
  return /^research_execution_release_attestor_[a-z0-9_:-]{1,240}$/.test(message)
    ? message : 'research_execution_release_attestor_config_invalid';
}

export function readProvisionedReleaseAttestorConfiguration({
  runtimeRoot,
  configPath = null,
  environment = process.env,
  spawnSyncImpl = spawnSync,
  randomBytesImpl = crypto.randomBytes,
} = {}) {
  const requested = configPath || environment.HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG
    || (runtimeRoot ? path.join(runtimeRoot, 'trust', DEFAULT_CONFIG_NAME) : null);
  if (!requested) {
    return { configuration: null, blocker: 'research_execution_release_attestor_config_path_missing' };
  }
  const text = privateOwnedRegularFile(requested, 256 * 1024);
  if (!text) {
    return {
      configuration: null,
      blocker: 'research_execution_release_attestor_config_not_private_regular_file',
    };
  }
  let value = null;
  try { value = JSON.parse(text); } catch { value = null; }
  if (!value || ![1, 2].includes(value.version)
    || value.kind !== 'ResearchExecutionReleaseAttestorConfiguration') {
    return { configuration: null, blocker: 'research_execution_release_attestor_config_invalid' };
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
    return {
      configuration: Object.freeze({
        ...parsed,
        publicKeys,
        trustSetHash: hashRecord('ResearchExecutionReleaseAttestorTrustSet', {
          version: parsed.trustSetVersion,
          keys: publicKeys,
        }),
      }),
      blocker: null,
    };
  } catch (error) {
    return { configuration: null, blocker: stableBlocker(error) };
  }
}
