import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import {
  matchesRuntimeImageReproducibilityCanonicalBuild,
} from '../../paper-domain/automation/runtime-image-reproducibility-build-policy.mjs';
import { restrictedChildEnvironment } from './bounded-child-process.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const ENVIRONMENT_KEY = /^[A-Z_][A-Z0-9_]{0,127}$/;
const PROTOCOL = 'runtime-image-reproducibility-json-stdio-v1';
const ROLE = 'runtime_image_reproducibility_external_verifier';
const MAXIMUM_CONFIG_BYTES = 256 * 1024;
const MAXIMUM_PROTOCOL_BYTES = 32 * 1024 * 1024;
const MAXIMUM_CREDENTIAL_FILES = 10_000;
const MAXIMUM_CREDENTIAL_BYTES = 256 * 1024 * 1024;
const CREDENTIAL_ROOT_USAGE = 'exclusive-private-principal-material-only-v1';
const VERIFICATION_COST_AUTHORITIES = new Set([
  'operator_declared_worst_case_usd',
  'externally_operated_zero_cost',
]);

function fileContentHash(candidate) {
  const descriptor = fs.openSync(candidate, 'r');
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) digest.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally { fs.closeSync(descriptor); }
  return `sha256:${digest.digest('hex')}`;
}

function integrityFile(candidate, { executable = false, maximumBytes = MAXIMUM_CONFIG_BYTES } = {}) {
  const requested = path.resolve(String(candidate || ''));
  const resolved = fs.realpathSync(requested);
  const stat = fs.lstatSync(resolved);
  if ((!executable && requested !== resolved) || !stat.isFile() || stat.isSymbolicLink()
    || stat.size < 1 || stat.size > maximumBytes || (stat.mode & 0o022) !== 0
    || (executable && (stat.mode & 0o111) === 0)) {
    throw new Error('runtime_reproducibility_integrity_file_invalid');
  }
  return resolved;
}

function relativeToConfig(candidate, configPath) {
  return path.isAbsolute(String(candidate || ''))
    ? path.resolve(candidate) : path.resolve(path.dirname(configPath), String(candidate || ''));
}

function directoryContentsIdentity(root, expectedUid) {
  const entries = [];
  const materialEntries = [];
  let fileCount = 0;
  let totalBytes = 0;
  const visit = (directory, relativeRoot = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.posix.join(relativeRoot, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
        || Number(stat.uid) !== expectedUid) {
        throw new Error('runtime_reproducibility_credential_root_contents_invalid');
      }
      if (stat.isDirectory()) {
        entries.push(Object.freeze({
          path: `${relative}/`, mode: stat.mode & 0o777,
          uid: Number(stat.uid), nlink: Number(stat.nlink),
        }));
        visit(absolute, relative);
      } else if (stat.isFile()) {
        if (stat.size < 1 || stat.nlink !== 1) {
          throw new Error('runtime_reproducibility_credential_root_contents_invalid');
        }
        fileCount += 1;
        totalBytes += stat.size;
        if (fileCount > MAXIMUM_CREDENTIAL_FILES || totalBytes > MAXIMUM_CREDENTIAL_BYTES) {
          throw new Error('runtime_reproducibility_credential_root_contents_too_large');
        }
        const contentHash = fileContentHash(absolute);
        entries.push(Object.freeze({
          path: relative,
          mode: stat.mode & 0o777,
          uid: Number(stat.uid),
          nlink: Number(stat.nlink),
          bytes: stat.size,
          contentHash,
        }));
        materialEntries.push(Object.freeze({ bytes: stat.size, contentHash }));
      } else throw new Error('runtime_reproducibility_credential_root_contents_invalid');
    }
  };
  visit(root);
  if (fileCount < 1 || totalBytes < 1) {
    throw new Error('runtime_reproducibility_credential_root_contents_invalid');
  }
  materialEntries.sort((left, right) => (
    left.contentHash.localeCompare(right.contentHash) || left.bytes - right.bytes
  ));
  const materialContentHashes = Object.freeze(
    [...new Set(materialEntries.map((entry) => entry.contentHash))].sort(),
  );
  return Object.freeze({
    contentsIdentityHash: hashRecord('RuntimeReproducibilityCredentialRootContentsIdentity', {
      entries, fileCount, totalBytes,
    }),
    materialIdentityHash: hashRecord('RuntimeReproducibilityCredentialMaterialIdentity', {
      materialEntries, fileCount, totalBytes,
    }),
    materialContentHashes,
  });
}

function credentialRootIdentity(candidate) {
  const requested = path.resolve(String(candidate || ''));
  const resolved = fs.realpathSync(requested);
  const stat = fs.lstatSync(resolved);
  if (requested !== resolved || !stat.isDirectory() || stat.isSymbolicLink()
    || (stat.mode & 0o077) !== 0) {
    throw new Error('runtime_reproducibility_credential_root_invalid');
  }
  const contents = directoryContentsIdentity(resolved, Number(stat.uid));
  const payload = Object.freeze({
    realpath: resolved,
    device: String(stat.dev),
    inode: String(stat.ino),
    uid: Number(stat.uid),
    nlink: Number(stat.nlink),
    mode: Number(stat.mode & 0o777),
    contentsIdentityHash: contents.contentsIdentityHash,
    materialIdentityHash: contents.materialIdentityHash,
  });
  return Object.freeze({
    ...payload,
    materialContentHashes: contents.materialContentHashes,
    credentialRootIdentityHash: hashRecord('RuntimeReproducibilityCredentialRootIdentity', payload),
  });
}

function executableOnPath(program, environment) {
  for (const directory of String(environment.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(directory, program);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return fs.realpathSync(candidate);
    } catch { /* keep searching */ }
  }
  throw new Error('runtime_reproducibility_interpreter_not_found');
}

function interpreterIdentity(executable, environment) {
  const descriptor = fs.openSync(executable, 'r');
  const buffer = Buffer.alloc(4096);
  let bytes;
  try { bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0); }
  finally { fs.closeSync(descriptor); }
  const firstLine = buffer.subarray(0, bytes).toString('utf8').split(/\r?\n/, 1)[0];
  if (!firstLine.startsWith('#!')) return null;
  const words = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error('runtime_reproducibility_interpreter_invalid');
  const launcher = fs.realpathSync(words[0]);
  const executables = [launcher];
  if (path.basename(launcher) === 'env') {
    const program = words.find((word, index) => index > 0 && !word.startsWith('-'));
    if (!program) throw new Error('runtime_reproducibility_interpreter_invalid');
    executables.push(executableOnPath(program, environment));
  }
  return hashRecord('RuntimeReproducibilityInterpreterIdentity', executables.map((candidate) => {
    const stat = fs.statSync(candidate);
    return Object.freeze({
      realpath: candidate,
      device: String(stat.dev),
      inode: String(stat.ino),
      contentHash: fileContentHash(candidate),
    });
  }));
}

function childEnvironmentFor(command, environment) {
  return restrictedChildEnvironment({
    source: environment,
    allowedKeys: command.environmentAllowlist,
    overrides: {
      HEPTA_RUNTIME_REPRODUCIBILITY_PRINCIPAL_ID: command.principalId,
      HEPTA_RUNTIME_REPRODUCIBILITY_CREDENTIAL_ROOT: command.credentialRoot,
      HEPTA_RUNTIME_REPRODUCIBILITY_BACKEND_ID: command.backend.backendId,
    },
  });
}

function argumentResourceIdentities(args, configPath) {
  return Object.freeze(args.flatMap((argument, index) => {
    const candidate = path.isAbsolute(argument)
      ? path.resolve(argument) : path.resolve(path.dirname(configPath), argument);
    if (!fs.existsSync(candidate)) return [];
    const resolved = fs.realpathSync(candidate);
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) return [];
    return [Object.freeze({
      index,
      realpath: resolved,
      device: String(stat.dev),
      inode: String(stat.ino),
      mode: stat.mode & 0o777,
      bytes: stat.size,
      contentHash: fileContentHash(resolved),
    })];
  }));
}

function backendConfiguration(value, platform) {
  if (!exactKeys(value, [
    'backendId', 'buildkitVersion', 'endpointTlsSpkiHash', 'platform',
    'stateRootIdentityHash', 'workerId',
  ]) || !SAFE_ID.test(String(value.backendId || ''))
    || !SAFE_ID.test(String(value.workerId || ''))
    || !SAFE_ID.test(String(value.buildkitVersion || ''))
    || value.platform !== platform
    || !SHA256.test(String(value.endpointTlsSpkiHash || ''))
    || !SHA256.test(String(value.stateRootIdentityHash || ''))) {
    throw new Error('runtime_reproducibility_backend_identity_invalid');
  }
  const payload = Object.freeze({
    backendId: String(value.backendId),
    workerId: String(value.workerId),
    buildkitVersion: String(value.buildkitVersion),
    platform: value.platform,
    endpointTlsSpkiHash: value.endpointTlsSpkiHash,
    stateRootIdentityHash: value.stateRootIdentityHash,
  });
  return Object.freeze({
    ...payload,
    backendIdentityHash: hashRecord('RuntimeImageReproducibilityBackendIdentity', payload),
  });
}

function signerConfiguration(value, configPath) {
  const effectiveFrom = Date.parse(String(value?.effectiveFrom || ''));
  const expiresAt = Date.parse(String(value?.expiresAt || ''));
  if (!exactKeys(value, [
    'algorithm', 'effectiveFrom', 'expiresAt', 'keyId', 'keyVersion', 'organization',
    'publicKeyPath', 'revokedAt', 'role', 'status', 'subjectId',
  ]) || !SAFE_ID.test(String(value.keyId || ''))
    || !SAFE_ID.test(String(value.keyVersion || ''))
    || !SAFE_ID.test(String(value.subjectId || ''))
    || !SAFE_ID.test(String(value.organization || ''))
    || value.role !== ROLE || value.algorithm !== 'ed25519' || value.status !== 'active'
    || value.revokedAt !== null || !Number.isFinite(effectiveFrom)
    || !Number.isFinite(expiresAt) || expiresAt <= effectiveFrom) {
    throw new Error('runtime_reproducibility_verifier_attestor_invalid');
  }
  const publicKeyPath = integrityFile(relativeToConfig(value.publicKeyPath, configPath), {
    maximumBytes: 64 * 1024,
  });
  const publicKeyPem = fs.readFileSync(publicKeyPath, 'utf8');
  let publicKey;
  try {
    if (!/-----BEGIN PUBLIC KEY-----/.test(publicKeyPem)
      || /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/.test(publicKeyPem)) throw new Error('private');
    publicKey = crypto.createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('algorithm');
  } catch { throw new Error('runtime_reproducibility_verifier_public_key_invalid'); }
  return Object.freeze({
    signer: Object.freeze({
      keyId: String(value.keyId),
      keyVersion: String(value.keyVersion),
      subjectId: String(value.subjectId),
      organization: String(value.organization),
      role: ROLE,
      algorithm: 'ed25519',
      status: 'active',
      effectiveFrom: new Date(effectiveFrom).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      revokedAt: null,
    }),
    publicKey,
    publicKeySpkiHash: hashBytes(publicKey.export({ type: 'spki', format: 'der' })),
  });
}

function commandConfiguration(value, configPath, environment, platform) {
  if (!exactKeys(value, [
    'args', 'backend', 'credentialRoot', 'environmentAllowlist', 'executable',
    'principalId', 'protocol', 'serviceId', 'timeoutMs',
  ]) || !SAFE_ID.test(String(value.serviceId || ''))
    || !SAFE_ID.test(String(value.principalId || '')) || value.protocol !== PROTOCOL
    || !Array.isArray(value.args) || value.args.length > 64
    || value.args.some((item) => typeof item !== 'string' || item.length > 4096)
    || !Array.isArray(value.environmentAllowlist || [])
    || value.environmentAllowlist.some((key) => !ENVIRONMENT_KEY.test(String(key))
      || /^(?:DOCKER|BUILDKIT|BUILDX)_/.test(String(key)))
    || !Number.isSafeInteger(Number(value.timeoutMs))
    || Number(value.timeoutMs) < 1000 || Number(value.timeoutMs) > 4 * 60 * 60 * 1000) {
    throw new Error('runtime_reproducibility_verifier_command_invalid');
  }
  const executable = integrityFile(relativeToConfig(value.executable, configPath), {
    executable: true,
    maximumBytes: 1024 * 1024 * 1024,
  });
  const stat = fs.statSync(executable);
  const credential = credentialRootIdentity(relativeToConfig(value.credentialRoot, configPath));
  const backend = backendConfiguration(value.backend, platform);
  const base = Object.freeze({
    serviceId: String(value.serviceId),
    principalId: String(value.principalId),
    protocol: PROTOCOL,
    configurationDirectory: path.dirname(configPath),
    executable,
    executableContentHash: fileContentHash(executable),
    executableDevice: String(stat.dev),
    executableInode: String(stat.ino),
    executableUid: Number(stat.uid),
    credentialRoot: credential.realpath,
    credentialRootIdentityHash: credential.credentialRootIdentityHash,
    credentialRootContentsIdentityHash: credential.contentsIdentityHash,
    credentialMaterialIdentityHash: credential.materialIdentityHash,
    credentialMaterialContentHashes: credential.materialContentHashes,
    credentialRootUsage: CREDENTIAL_ROOT_USAGE,
    credentialUid: credential.uid,
    args: Object.freeze([...value.args]),
    environmentAllowlist: Object.freeze([...new Set(value.environmentAllowlist || [])]),
    timeoutMs: Number(value.timeoutMs),
    backend,
  });
  const effectiveEnvironment = childEnvironmentFor(base, environment);
  const runtime = Object.freeze({
    interpreterIdentityHash: interpreterIdentity(executable, effectiveEnvironment),
    childEnvironmentIdentityHash: hashRecord(
      'RuntimeReproducibilityChildEnvironmentIdentity',
      effectiveEnvironment,
    ),
    argumentResourceIdentities: argumentResourceIdentities(base.args, configPath),
  });
  return Object.freeze({
    ...base,
    ...runtime,
    commandIdentityHash: hashRecord('RuntimeReproducibilityProcessCommandIdentity', {
      ...base,
      ...runtime,
    }),
  });
}

function privateMaterialForbidden(value, key = '') {
  if (/private.*key/i.test(key)) return true;
  if (typeof value === 'string') return /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/.test(value);
  if (Array.isArray(value)) return value.some((item) => privateMaterialForbidden(item));
  return value && typeof value === 'object'
    ? Object.entries(value).some(([name, item]) => privateMaterialForbidden(item, name)) : false;
}

function canonicalOrganization(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function assertPairwiseIndependence(left, right) {
  const pairs = [
    ['serviceId', left.command.serviceId, right.command.serviceId],
    ['principalId', left.command.principalId, right.command.principalId],
    ['commandIdentity', left.command.commandIdentityHash, right.command.commandIdentityHash],
    ['executable', left.command.executable, right.command.executable],
    ['executableContent', left.command.executableContentHash, right.command.executableContentHash],
    ['credentialRoot', left.command.credentialRootIdentityHash, right.command.credentialRootIdentityHash],
    ['credentialContents', left.command.credentialRootContentsIdentityHash, right.command.credentialRootContentsIdentityHash],
    ['credentialMaterial', left.command.credentialMaterialIdentityHash,
      right.command.credentialMaterialIdentityHash],
    ['signerSubject', left.signer.signer.subjectId, right.signer.signer.subjectId],
    ['signerOrganization', canonicalOrganization(left.signer.signer.organization),
      canonicalOrganization(right.signer.signer.organization)],
    ['signerSpki', left.signer.publicKeySpkiHash, right.signer.publicKeySpkiHash],
    ['backend', left.command.backend.backendIdentityHash, right.command.backend.backendIdentityHash],
    ['backendId', left.command.backend.backendId, right.command.backend.backendId],
    ['workerId', left.command.backend.workerId, right.command.backend.workerId],
    ['stateRoot', left.command.backend.stateRootIdentityHash, right.command.backend.stateRootIdentityHash],
    ['endpointSpki', left.command.backend.endpointTlsSpkiHash, right.command.backend.endpointTlsSpkiHash],
  ];
  const rightCredentialMaterial = new Set(right.command.credentialMaterialContentHashes);
  const sharedCredentialMaterial = left.command.credentialMaterialContentHashes
    .some((contentHash) => rightCredentialMaterial.has(contentHash));
  if (pairs.some(([, a, b]) => a === b) || sharedCredentialMaterial) {
    throw new Error('runtime_reproducibility_independent_verifiers_required');
  }
}

export function readRuntimeImageReproducibilityProcessConfiguration({
  configPath = null,
  environment = process.env,
} = {}) {
  const requested = configPath || environment.HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG;
  if (!requested) throw new Error('runtime_reproducibility_configuration_path_required');
  const resolvedConfigPath = integrityFile(requested);
  let value;
  try { value = JSON.parse(fs.readFileSync(resolvedConfigPath, 'utf8')); }
  catch { throw new Error('runtime_reproducibility_configuration_json_invalid'); }
  if (!exactKeys(value, [
    'buildArgs', 'kind', 'maximumReceiptAgeMs', 'platform', 'sourceDateEpoch',
    'maximumVerificationCostUsd', 'status', 'verificationCostAuthority', 'verifiers', 'version',
  ]) || value?.version !== 1 || value?.kind !== 'RuntimeImageReproducibilityProcessConfiguration'
    || value?.status !== 'active'
    || !Number.isSafeInteger(Number(value.maximumReceiptAgeMs))
    || Number(value.maximumReceiptAgeMs) < 60_000
    || Number(value.maximumReceiptAgeMs) > 24 * 60 * 60 * 1000
    || typeof value.maximumVerificationCostUsd !== 'number'
    || !Number.isFinite(value.maximumVerificationCostUsd)
    || value.maximumVerificationCostUsd < 0 || value.maximumVerificationCostUsd > 1_000_000
    || !VERIFICATION_COST_AUTHORITIES.has(value.verificationCostAuthority)
    || (value.verificationCostAuthority === 'operator_declared_worst_case_usd'
      && value.maximumVerificationCostUsd <= 0)
    || (value.verificationCostAuthority === 'externally_operated_zero_cost'
      && value.maximumVerificationCostUsd !== 0)
    || !Array.isArray(value.verifiers) || value.verifiers.length !== 2
    || value.verifiers.some((item) => !exactKeys(item, ['attestor', 'command']))
    || privateMaterialForbidden(value)) {
    throw new Error('runtime_reproducibility_configuration_invalid');
  }
  const buildArgs = value.buildArgs || {};
  if (!buildArgs || typeof buildArgs !== 'object' || Array.isArray(buildArgs)
    || Object.getPrototypeOf(buildArgs) !== Object.prototype
    || Object.entries(buildArgs).some(([key, item]) => !ENVIRONMENT_KEY.test(key)
      || typeof item !== 'string' || item.length > 4096)) {
    throw new Error('runtime_reproducibility_build_args_invalid');
  }
  if (!matchesRuntimeImageReproducibilityCanonicalBuild({
    platform: value.platform,
    sourceDateEpoch: Number(value.sourceDateEpoch),
    buildArgs,
  })) throw new Error('runtime_reproducibility_canonical_build_configuration_drift');
  const verifiers = Object.freeze(value.verifiers.map((item) => Object.freeze({
    command: commandConfiguration(item.command, resolvedConfigPath, environment, value.platform),
    signer: signerConfiguration(item.attestor, resolvedConfigPath),
  })));
  if (verifiers.some((item) => item.command.timeoutMs >= Number(value.maximumReceiptAgeMs))) {
    throw new Error('runtime_reproducibility_verifier_timeout_exceeds_receipt_window');
  }
  const maximumVerifierTimeoutMs = Math.max(
    ...verifiers.map((item) => item.command.timeoutMs),
  );
  const minimumRefreshLeadMs = maximumVerifierTimeoutMs + 60_000;
  if (minimumRefreshLeadMs >= Number(value.maximumReceiptAgeMs)) {
    throw new Error('runtime_reproducibility_verifier_timeout_exceeds_receipt_window');
  }
  assertPairwiseIndependence(verifiers[0], verifiers[1]);
  const publicVerifiers = Object.freeze(verifiers.map((item) => Object.freeze({
    serviceId: item.command.serviceId,
    principalId: item.command.principalId,
    commandIdentityHash: item.command.commandIdentityHash,
    serviceIdentityHash: hashRecord('RuntimeImageReproducibilityVerifierServiceIdentity', {
      serviceId: item.command.serviceId,
      principalId: item.command.principalId,
      commandIdentityHash: item.command.commandIdentityHash,
      backendIdentityHash: item.command.backend.backendIdentityHash,
      signerPublicKeySpkiHash: item.signer.publicKeySpkiHash,
    }),
    credentialRootIdentityHash: item.command.credentialRootIdentityHash,
    credentialMaterialIdentityHash: item.command.credentialMaterialIdentityHash,
    credentialRootUsage: item.command.credentialRootUsage,
    executableContentHash: item.command.executableContentHash,
    backend: item.command.backend,
    signer: item.signer.signer,
    signerPublicKeySpkiHash: item.signer.publicKeySpkiHash,
  })));
  const trustIdentityHash = hashRecord('RuntimeImageReproducibilityTrustIdentity', publicVerifiers);
  const payload = Object.freeze({
    platform: value.platform,
    sourceDateEpoch: Number(value.sourceDateEpoch),
    buildArgs: Object.freeze(Object.fromEntries(Object.entries(buildArgs).sort())),
    maximumReceiptAgeMs: Number(value.maximumReceiptAgeMs),
    maximumVerificationCostUsd: value.maximumVerificationCostUsd,
    verificationCostAuthority: value.verificationCostAuthority,
    maximumVerifierTimeoutMs,
    minimumRefreshLeadMs,
    trustIdentityHash,
    verifiers: publicVerifiers,
  });
  return Object.freeze({
    configPath: resolvedConfigPath,
    platform: payload.platform,
    sourceDateEpoch: payload.sourceDateEpoch,
    buildArgs: payload.buildArgs,
    maximumReceiptAgeMs: payload.maximumReceiptAgeMs,
    maximumVerificationCostUsd: payload.maximumVerificationCostUsd,
    verificationCostAuthority: payload.verificationCostAuthority,
    maximumVerifierTimeoutMs: payload.maximumVerifierTimeoutMs,
    minimumRefreshLeadMs: payload.minimumRefreshLeadMs,
    trustIdentityHash: payload.trustIdentityHash,
    verifierTrust: publicVerifiers,
    verifiers,
    configurationIdentityHash: hashRecord(
      'RuntimeImageReproducibilityProcessConfigurationIdentity',
      payload,
    ),
    privateSigningKeyLoaded: false,
  });
}

function parseResponse(result) {
  if (result?.error || result?.timedOut || result?.aborted || result?.exitCode !== 0
    || result?.outputTruncated || result?.stdoutBytes < 2
    || result?.stdoutBytes > MAXIMUM_PROTOCOL_BYTES) {
    throw new Error('runtime_reproducibility_external_verifier_failed');
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    return parsed;
  } catch { throw new Error('runtime_reproducibility_external_verifier_response_invalid'); }
}

export async function invokeRuntimeImageReproducibilityVerifier(command, payload, {
  cwd,
  environment = process.env,
  runProcess,
  signal = null,
} = {}) {
  const executable = fs.realpathSync(command.executable);
  const stat = fs.statSync(executable);
  const credential = credentialRootIdentity(command.credentialRoot);
  const effectiveEnvironment = childEnvironmentFor(command, environment);
  const resources = argumentResourceIdentities(
    command.args,
    path.join(command.configurationDirectory, 'configuration.json'),
  );
  if (executable !== command.executable || String(stat.dev) !== command.executableDevice
    || String(stat.ino) !== command.executableInode
    || Number(stat.uid) !== command.executableUid
    || fileContentHash(executable) !== command.executableContentHash
    || credential.credentialRootIdentityHash !== command.credentialRootIdentityHash
    || credential.contentsIdentityHash !== command.credentialRootContentsIdentityHash
    || credential.materialIdentityHash !== command.credentialMaterialIdentityHash
    || hashRecord('RuntimeReproducibilityCredentialMaterialContentHashes',
      credential.materialContentHashes)
      !== hashRecord('RuntimeReproducibilityCredentialMaterialContentHashes',
        command.credentialMaterialContentHashes)
    || interpreterIdentity(executable, effectiveEnvironment) !== command.interpreterIdentityHash
    || hashRecord('RuntimeReproducibilityChildEnvironmentIdentity', effectiveEnvironment)
      !== command.childEnvironmentIdentityHash
    || hashRecord('RuntimeReproducibilityArgumentResourceIdentities', resources)
      !== hashRecord(
        'RuntimeReproducibilityArgumentResourceIdentities',
        command.argumentResourceIdentities,
      )) {
    throw new Error('runtime_reproducibility_external_verifier_identity_changed');
  }
  const result = await runProcess({
    executable: command.executable,
    args: command.args,
    cwd,
    env: effectiveEnvironment,
    stdin: `${JSON.stringify(payload)}\n`,
    timeoutMs: command.timeoutMs,
    signal,
    maximumCapturedBytes: MAXIMUM_PROTOCOL_BYTES,
  });
  return parseResponse(result);
}

export const RUNTIME_IMAGE_REPRODUCIBILITY_VERIFIER_ROLE = ROLE;
