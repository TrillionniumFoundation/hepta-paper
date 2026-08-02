import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { restrictedChildEnvironment } from '../automation/bounded-child-process.mjs';
import {
  assertResearchExecutionReleaseSignerBackendPort,
  RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS,
  researchExecutionReleaseSignerBackendDescriptorHash,
} from '../../paper-ports/research-execution-release-signer-backend-port.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const ENVIRONMENT_KEY = /^[A-Z_][A-Z0-9_]{0,127}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const SIGNATURE = /^[A-Za-z0-9+/]{80,120}={0,2}$/;
const MAXIMUM_PROTOCOL_BYTES = 1024 * 1024;
const MAXIMUM_PROBE_LIFETIME_MS = 5 * 60 * 1000;
const SIGNER_PROTOCOL_V1 = 'hepta-release-signer-json-stdio-v1';
const SIGNER_PROTOCOL_V2 = 'hepta-release-signer-json-stdio-v2';
const RESERVED_COMMAND_ENVIRONMENT_KEYS = new Set([
  'HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG',
  'HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG_HASH',
]);

export const RESEARCH_EXECUTION_RELEASE_SIGNER_PROBE_ROLE =
  'research_execution_release_signer_backend_probe_attestor';

function fileContentHash(candidate) {
  const descriptor = fs.openSync(candidate, 'r');
  try {
    return fileDescriptorContentHash(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function fileDescriptorContentHash(descriptor) {
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  let count;
  do {
    count = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
    if (count > 0) {
      digest.update(buffer.subarray(0, count));
      offset += count;
    }
  } while (count > 0);
  return `sha256:${digest.digest('hex')}`;
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

function integrityExecutable(candidate) {
  const requested = path.resolve(String(candidate || ''));
  const resolved = fs.realpathSync(requested);
  const stat = fs.lstatSync(resolved);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (requested !== resolved || !stat.isFile() || stat.isSymbolicLink()
    || stat.nlink !== 1 || (stat.uid !== 0 && stat.uid !== currentUid) || stat.size < 1
    || stat.size > 1024 * 1024 * 1024 || (stat.mode & 0o022) !== 0
    || (stat.mode & 0o111) === 0) {
    throw new Error('research_execution_release_attestor_integrity_file_invalid');
  }
  return resolved;
}

function credentialRootIdentity(candidate) {
  const requested = path.resolve(String(candidate || ''));
  const resolved = fs.realpathSync(requested);
  const stat = fs.statSync(resolved);
  if (requested !== resolved || !stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error('research_execution_release_attestor_backend_credential_root_invalid');
  }
  const payload = Object.freeze({
    realpath: resolved,
    device: String(stat.dev),
    inode: String(stat.ino),
    uid: Number(stat.uid),
    mode: Number(stat.mode & 0o777),
  });
  return Object.freeze({
    ...payload,
    identityHash: hashRecord('ResearchExecutionReleaseSignerCredentialRootIdentity', payload),
  });
}

function childEnvironment(command, environment) {
  return restrictedChildEnvironment({
    source: environment,
    allowedKeys: command.environmentAllowlist,
    overrides: {
      HEPTA_RELEASE_SIGNER_SERVICE_ID: command.serviceId,
      HEPTA_RELEASE_SIGNER_PRINCIPAL_ID: command.principalId,
      HEPTA_RELEASE_SIGNER_CREDENTIAL_ROOT: command.credentialRoot,
    },
  });
}

function externalCommand(value, { configPath, environment, protocol, label }) {
  if (!value || value.protocol !== protocol
    || !SAFE_ID.test(String(value.serviceId || ''))
    || !SAFE_ID.test(String(value.principalId || ''))
    || !Array.isArray(value.args) || value.args.length > 64
    || value.args.some((item) => typeof item !== 'string' || item.length > 4096)
    || !Array.isArray(value.environmentAllowlist || [])
    || value.environmentAllowlist.some((key) => !ENVIRONMENT_KEY.test(String(key)))
    || value.environmentAllowlist.some((key) => (
      RESERVED_COMMAND_ENVIRONMENT_KEYS.has(String(key))
    ))
    || !Number.isSafeInteger(Number(value.timeoutMs))
    || Number(value.timeoutMs) < 1000 || Number(value.timeoutMs) > 300_000) {
    throw new Error(`research_execution_release_attestor_${label}_configuration_invalid`);
  }
  const executable = integrityExecutable(resolveRelative(value.executable, configPath));
  const stat = fs.statSync(executable);
  const credential = credentialRootIdentity(resolveRelative(value.credentialRoot, configPath));
  const base = Object.freeze({
    serviceId: String(value.serviceId),
    principalId: String(value.principalId),
    protocol,
    executable,
    executableContentHash: fileContentHash(executable),
    executableDevice: String(stat.dev),
    executableInode: String(stat.ino),
    credentialRoot: credential.realpath,
    credentialRootIdentityHash: credential.identityHash,
    args: Object.freeze([...value.args]),
    environmentAllowlist: Object.freeze([...new Set(value.environmentAllowlist)]),
    timeoutMs: Number(value.timeoutMs),
    configurationDirectory: path.dirname(configPath),
  });
  const childEnvironmentIdentityHash = hashRecord(
    'ResearchExecutionReleaseSignerChildEnvironmentIdentity',
    childEnvironment(base, environment),
  );
  return Object.freeze({
    ...base,
    childEnvironmentIdentityHash,
    commandIdentityHash: hashRecord('ResearchExecutionReleaseSignerCommandIdentity', {
      ...base,
      childEnvironmentIdentityHash,
    }),
  });
}

function openPinnedCommand(command, environment) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      command.executable,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const stat = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(command.executable);
    const credential = credentialRootIdentity(command.credentialRoot);
    const environmentHash = hashRecord(
      'ResearchExecutionReleaseSignerChildEnvironmentIdentity',
      childEnvironment(command, environment),
    );
    if (!stat.isFile() || pathStat.isSymbolicLink()
      || stat.nlink !== 1
      || String(stat.dev) !== command.executableDevice
      || String(stat.ino) !== command.executableInode
      || String(pathStat.dev) !== command.executableDevice
      || String(pathStat.ino) !== command.executableInode
      || fileDescriptorContentHash(descriptor) !== command.executableContentHash
      || credential.identityHash !== command.credentialRootIdentityHash
      || environmentHash !== command.childEnvironmentIdentityHash) {
      throw new Error('identity changed');
    }
    return descriptor;
  } catch {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw new Error('research_execution_release_attestor_backend_command_identity_changed');
  }
}

function invokeCommand(command, request, {
  environment,
  spawnSyncImpl,
  maximumWaitMs = null,
}) {
  const descriptor = openPinnedCommand(command, environment);
  let result;
  try {
    const timeoutMs = maximumWaitMs === null
      ? command.timeoutMs
      : Math.max(1, Math.min(command.timeoutMs, Math.floor(maximumWaitMs)));
    result = spawnSyncImpl('/proc/self/fd/3', command.args, {
      cwd: command.configurationDirectory,
      env: { ...childEnvironment(command, environment) },
      input: `${JSON.stringify(request)}\n`,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: MAXIMUM_PROTOCOL_BYTES,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe', descriptor],
    });
  } finally {
    fs.closeSync(descriptor);
  }
  if (result?.error || result?.signal || result?.status !== 0
    || Buffer.byteLength(String(result?.stdout || ''), 'utf8') > MAXIMUM_PROTOCOL_BYTES) {
    throw new Error('research_execution_release_attestor_backend_command_failed');
  }
  try {
    const response = JSON.parse(String(result.stdout || ''));
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('shape');
    return response;
  } catch { throw new Error('research_execution_release_attestor_backend_response_invalid'); }
}

function finalizeDescriptor(payload) {
  const descriptor = Object.freeze({
    ...payload,
    researchExecutionReleaseSignerBackendDescriptorHash: hashRecord(
      'ResearchExecutionReleaseSignerBackendDescriptor',
      payload,
    ),
  });
  if (researchExecutionReleaseSignerBackendDescriptorHash(descriptor)
    !== descriptor.researchExecutionReleaseSignerBackendDescriptorHash) {
    throw new Error('research_execution_release_attestor_backend_descriptor_hash_invalid');
  }
  return descriptor;
}

function verifyProbe(response, { challengeHash, inspectedAt, descriptor, probeAttestor, activeKey }) {
  const {
    signature: _signature,
    researchExecutionReleaseSignerBackendProbeAttestationHash: _hash,
    ...payload
  } = response || {};
  const probedAt = canonicalTimestamp(response?.probedAt);
  const expiresAt = canonicalTimestamp(response?.expiresAt);
  const inspectedAtMs = inspectedAt instanceof Date ? inspectedAt.getTime() : Date.parse(inspectedAt);
  const probeEffectiveFrom = Date.parse(probeAttestor.effectiveFrom);
  const probeExpiresAt = Date.parse(probeAttestor.expiresAt);
  if (!response || response.version !== 1
    || response.kind !== 'ResearchExecutionReleaseSignerBackendProbeAttestation'
    || response.status !== 'research_execution_release_signer_backend_probe_verified'
    || response.backendDescriptorHash !== descriptor.researchExecutionReleaseSignerBackendDescriptorHash
    || response.backendId !== descriptor.backendId || response.backendVersion !== descriptor.backendVersion
    || response.activeKeyId !== activeKey.signer.keyId
    || response.activeKeyVersion !== activeKey.signer.keyVersion
    || response.activePublicKeySpkiHash !== activeKey.publicKeySpkiHash
    || response.algorithm !== 'ed25519' || response.challengeHash !== challengeHash
    || response.backendReachable !== true
    || response.hardwareProtected !== descriptor.hardwareProtected
    || response.privateKeyExportable !== descriptor.privateKeyExportable
    || response.externalSignerProcess !== descriptor.externalSignerProcess
    || response.externalActionPerformed !== true
    || response.externalActionScope !== 'single_read_only_release_signer_backend_challenge'
    || response.signer?.keyId !== probeAttestor.signer.keyId
    || response.signer?.keyVersion !== probeAttestor.signer.keyVersion
    || response.signer?.subjectId !== probeAttestor.signer.subjectId
    || response.signer?.organization !== probeAttestor.signer.organization
    || response.signer?.role !== RESEARCH_EXECUTION_RELEASE_SIGNER_PROBE_ROLE
    || response.signer?.algorithm !== 'ed25519'
    || probedAt === null || expiresAt === null || !Number.isFinite(inspectedAtMs)
    || probedAt > inspectedAtMs || inspectedAtMs >= expiresAt || expiresAt <= probedAt
    || expiresAt - probedAt > MAXIMUM_PROBE_LIFETIME_MS
    || probedAt < probeEffectiveFrom || inspectedAtMs >= probeExpiresAt
    || probeAttestor.revokedAt !== null
    || !SIGNATURE.test(String(response.signature || ''))
    || hashRecord('ResearchExecutionReleaseSignerBackendProbeAttestation', {
      ...payload,
      signature: response.signature,
    }) !== response.researchExecutionReleaseSignerBackendProbeAttestationHash) return false;
  try {
    return crypto.verify(
      null,
      Buffer.from(hashRecord(
        'ResearchExecutionReleaseSignerBackendProbeAttestationSigningPayload',
        payload,
      ), 'utf8'),
      probeAttestor.publicKey,
      Buffer.from(response.signature, 'base64'),
    );
  } catch { return false; }
}

export function createExternalKmsReleaseSignerBackend({
  backendValue,
  configurationVersion,
  configPath,
  environment,
  spawnSyncImpl,
  randomBytesImpl,
  activeKey,
  trustedKeys,
  trustSetHash,
  probeAttestor,
}) {
  const externalKms = backendValue?.kind === 'external-kms-command';
  const dedicatedUid = backendValue?.kind === 'dedicated-uid-command';
  const kmsIdentityValues = [
    backendValue?.kmsProvider,
    backendValue?.providerAccountIdentityHash,
    backendValue?.keyResourceIdentityHash,
    backendValue?.credentialGenerationIdentityHash,
  ];
  const kmsIdentityDeclared = kmsIdentityValues.some((value) => value !== undefined);
  const kmsIdentityValid = SAFE_ID.test(String(backendValue?.kmsProvider || ''))
    && SHA256.test(String(backendValue?.providerAccountIdentityHash || ''))
    && SHA256.test(String(backendValue?.keyResourceIdentityHash || ''))
    && SHA256.test(String(backendValue?.credentialGenerationIdentityHash || ''));
  if (!backendValue || (!externalKms && !dedicatedUid)
    || !SAFE_ID.test(String(backendValue.backendId || ''))
    || !SAFE_VERSION.test(String(backendValue.backendVersion || ''))
    || backendValue.algorithm !== 'ed25519'
    || backendValue.externalSignerProcess !== true
    || (externalKms && (backendValue.hardwareProtected !== true
      || backendValue.privateKeyExportable !== false))
    || (externalKms && kmsIdentityDeclared && !kmsIdentityValid)
    || (dedicatedUid && (backendValue.hardwareProtected !== false
      || backendValue.privateKeyExportable !== true
      || backendValue.assuranceProfile !== 'dedicated-host-uid-unix-socket-v1'
      || backendValue.threatBoundary !== 'research-runtime-uid'))
    || backendValue.activeKeyId !== activeKey.signer.keyId
    || backendValue.activeKeyVersion !== activeKey.signer.keyVersion
    || (externalKms && (
      backendValue.signerCommand?.args?.length !== 0
      || backendValue.probeCommand?.args?.length !== 0
      || backendValue.signerCommand?.environmentAllowlist?.length !== 0
      || backendValue.probeCommand?.environmentAllowlist?.length !== 0
    ))
    || !SHA256.test(String(trustSetHash || ''))) {
    throw new Error('research_execution_release_attestor_backend_descriptor_invalid');
  }
  const signerCommand = externalCommand(backendValue.signerCommand, {
    configPath,
    environment,
    protocol: configurationVersion === 3 ? SIGNER_PROTOCOL_V2 : SIGNER_PROTOCOL_V1,
    label: 'signer_command',
  });
  const probeCommand = externalCommand(backendValue.probeCommand, {
    configPath,
    environment,
    protocol: 'hepta-release-signer-probe-json-stdio-v1',
    label: 'probe_command',
  });
  if (signerCommand.serviceId === probeCommand.serviceId
    || signerCommand.principalId === probeCommand.principalId
    || signerCommand.commandIdentityHash === probeCommand.commandIdentityHash
    || (externalKms
      && signerCommand.executableContentHash === probeCommand.executableContentHash)
    || signerCommand.credentialRootIdentityHash === probeCommand.credentialRootIdentityHash
    || trustedKeys.some((key) => key.publicKeySpkiHash === probeAttestor.publicKeySpkiHash)) {
    throw new Error('research_execution_release_attestor_independent_backend_probe_required');
  }
  const descriptor = finalizeDescriptor({
    version: 1,
    kind: 'ResearchExecutionReleaseSignerBackendDescriptor',
    backendKind: externalKms
      ? RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS.EXTERNAL_KMS_COMMAND
      : RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS.DEDICATED_UID_COMMAND,
    backendId: String(backendValue.backendId),
    backendVersion: String(backendValue.backendVersion),
    algorithm: 'ed25519',
    hardwareProtected: backendValue.hardwareProtected,
    privateKeyExportable: backendValue.privateKeyExportable,
    externalSignerProcess: true,
    productionEligible: true,
    assuranceProfile: externalKms
      ? kmsIdentityValid
        ? 'external-hardware-kms-control-plane-bindable-v2'
        : 'operator-declared-external-hardware-kms-nonexportable-v1'
      : backendValue.assuranceProfile,
    threatBoundary: externalKms ? 'external-kms-control-plane' : backendValue.threatBoundary,
    ...(externalKms && kmsIdentityValid ? {
      kmsProvider: String(backendValue.kmsProvider),
      providerAccountIdentityHash:
        String(backendValue.providerAccountIdentityHash).toLowerCase(),
      keyResourceIdentityHash:
        String(backendValue.keyResourceIdentityHash).toLowerCase(),
      credentialGenerationIdentityHash:
        String(backendValue.credentialGenerationIdentityHash).toLowerCase(),
    } : {}),
    activeKeyId: activeKey.signer.keyId,
    activeKeyVersion: activeKey.signer.keyVersion,
    activePublicKeySpkiHash: activeKey.publicKeySpkiHash,
    trustSetHash,
    commandIdentityHash: signerCommand.commandIdentityHash,
    probeCommandIdentityHash: probeCommand.commandIdentityHash,
    probeAttestorPublicKeySpkiHash: probeAttestor.publicKeySpkiHash,
    credentialMaterialReadByMainProcess: false,
  });
  return assertResearchExecutionReleaseSignerBackendPort(Object.freeze({
    version: 1,
    kind: 'ResearchExecutionReleaseSignerBackendPort',
    describeBackend: () => descriptor,
    probeBackend({ inspectedAt } = {}) {
      const challenge = randomBytesImpl(32).toString('base64');
      const challengeHash = hashBytes(Buffer.from(challenge, 'utf8'));
      const response = invokeCommand(probeCommand, {
        version: 1,
        kind: 'ResearchExecutionReleaseSignerBackendProbeRequest',
        protocol: probeCommand.protocol,
        backendDescriptorHash: descriptor.researchExecutionReleaseSignerBackendDescriptorHash,
        backendId: descriptor.backendId,
        backendVersion: descriptor.backendVersion,
        activeKeyId: activeKey.signer.keyId,
        activeKeyVersion: activeKey.signer.keyVersion,
        activePublicKeySpkiHash: activeKey.publicKeySpkiHash,
        algorithm: 'ed25519',
        challenge,
        challengeHash,
      }, { environment, spawnSyncImpl });
      const verified = verifyProbe(response, {
        challengeHash, inspectedAt, descriptor, probeAttestor, activeKey,
      });
      return Object.freeze({ verified, attestation: verified ? response : null });
    },
    signDigest({
      signingPayloadHash,
      keyId,
      keyVersion,
      authorizationExpiresAt = null,
      maximumWaitMs = null,
    } = {}) {
      const deadline = canonicalTimestamp(authorizationExpiresAt);
      const deadlineProtocol = signerCommand.protocol === SIGNER_PROTOCOL_V2;
      if (!SHA256.test(String(signingPayloadHash || ''))
        || keyId !== activeKey.signer.keyId || keyVersion !== activeKey.signer.keyVersion
        || (deadlineProtocol && (deadline === null
          || !Number.isFinite(Number(maximumWaitMs))
          || Number(maximumWaitMs) < 1))) {
        throw new Error('research_execution_release_attestor_signing_request_invalid');
      }
      const requestNonce = randomBytesImpl(32).toString('base64');
      const requestNonceHash = hashBytes(Buffer.from(requestNonce, 'utf8'));
      const response = invokeCommand(signerCommand, {
        version: deadlineProtocol ? 2 : 1,
        kind: 'ResearchExecutionReleaseSignerRequest',
        protocol: signerCommand.protocol,
        operation: 'sign-sha256-identity',
        backendDescriptorHash: descriptor.researchExecutionReleaseSignerBackendDescriptorHash,
        backendId: descriptor.backendId,
        backendVersion: descriptor.backendVersion,
        keyId,
        keyVersion,
        algorithm: 'ed25519',
        signingPayloadHash,
        requestNonce,
        requestNonceHash,
        ...(deadlineProtocol ? { authorizationExpiresAt } : {}),
      }, {
        environment,
        spawnSyncImpl,
        maximumWaitMs: deadlineProtocol ? Number(maximumWaitMs) : null,
      });
      const { researchExecutionReleaseSignerResponseHash: responseHash, ...payload } = response || {};
      const signedAt = deadlineProtocol ? canonicalTimestamp(response?.signedAt) : null;
      if (response?.version !== (deadlineProtocol ? 2 : 1)
        || response?.kind !== 'ResearchExecutionReleaseSignerResponse'
        || response?.status !== 'research_execution_release_digest_signed'
        || response?.backendDescriptorHash !== descriptor.researchExecutionReleaseSignerBackendDescriptorHash
        || response?.backendId !== descriptor.backendId || response?.backendVersion !== descriptor.backendVersion
        || response?.keyId !== keyId || response?.keyVersion !== keyVersion
        || response?.algorithm !== 'ed25519' || response?.signingPayloadHash !== signingPayloadHash
        || response?.requestNonceHash !== requestNonceHash
        || (deadlineProtocol && (
          response.authorizationExpiresAt !== authorizationExpiresAt
          || signedAt === null || signedAt >= deadline
        ))
        || !SIGNATURE.test(String(response?.signature || ''))
        || hashRecord('ResearchExecutionReleaseSignerResponse', payload) !== responseHash) {
        throw new Error('research_execution_release_attestor_backend_signing_response_invalid');
      }
      try {
        if (!crypto.verify(null, Buffer.from(signingPayloadHash, 'utf8'), activeKey.publicKey,
          Buffer.from(response.signature, 'base64'))) throw new Error('signature invalid');
      } catch { throw new Error('research_execution_release_attestor_backend_signature_invalid'); }
      return response.signature;
    },
  }));
}
