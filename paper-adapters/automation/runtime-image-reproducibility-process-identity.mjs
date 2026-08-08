import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import {
  matchesRuntimeImageReproducibilityCanonicalBuild,
} from '../../paper-domain/automation/runtime-image-reproducibility-build-policy.mjs';
import { restrictedChildEnvironment } from './bounded-child-process.mjs';
import {
  createProcessFileContentHasher,
  inspectProcessExecutableFileIdentity,
  processExecutableFileIdentityMatches,
  processInterpreterIdentityHash,
} from './process-executable-identity.mjs';

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

const fileContentHash = createProcessFileContentHasher();

function interpreterIdentity(executable, environment) {
  return processInterpreterIdentityHash({
    executable,
    environment,
    fileContentHash,
    hashDomain: 'RuntimeReproducibilityInterpreterIdentity',
    invalidInterpreterError: 'runtime_reproducibility_interpreter_invalid',
    interpreterNotFoundError: 'runtime_reproducibility_interpreter_not_found',
  });
}

function integrityFile(candidate, {
  executable = false,
  maximumBytes = MAXIMUM_CONFIG_BYTES,
  singleLink = false,
} = {}) {
  const requested = path.resolve(String(candidate || ''));
  const resolved = fs.realpathSync(requested);
  const stat = fs.lstatSync(resolved);
  if ((!executable && requested !== resolved) || !stat.isFile() || stat.isSymbolicLink()
    || stat.size < 1 || stat.size > maximumBytes || (stat.mode & 0o022) !== 0
    || (singleLink && stat.nlink !== 1)
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
      || /^(?:DOCKER|BUILDKIT|BUILDX)_/.test(String(key))
      || key === 'HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH')
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
  const executableIdentity = inspectProcessExecutableFileIdentity({
    executable,
    fileContentHash,
    stat,
  });
  const base = Object.freeze({
    serviceId: String(value.serviceId),
    principalId: String(value.principalId),
    protocol: PROTOCOL,
    configurationDirectory: path.dirname(configPath),
    executable,
    executableContentHash: executableIdentity.contentHash,
    executableDevice: executableIdentity.device,
    executableInode: executableIdentity.inode,
    executableUid: executableIdentity.uid,
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
  expectedConfigurationHash = null,
  environment = process.env,
} = {}) {
  const requested = configPath || environment.HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG;
  if (!requested) throw new Error('runtime_reproducibility_configuration_path_required');
  const configuredExpectedHash = expectedConfigurationHash
    ?? environment.HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH
    ?? null;
  const normalizedExpectedHash = configuredExpectedHash === null
    ? null : String(configuredExpectedHash || '').toLowerCase();
  if (normalizedExpectedHash !== null && !SHA256.test(normalizedExpectedHash)) {
    throw new Error('runtime_reproducibility_configuration_pin_mismatch');
  }
  const resolvedConfigPath = integrityFile(requested, { singleLink: true });
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
  const configurationIdentityHash = hashRecord(
    'RuntimeImageReproducibilityProcessConfigurationIdentity',
    payload,
  );
  if (normalizedExpectedHash !== null
    && normalizedExpectedHash !== configurationIdentityHash) {
    throw new Error('runtime_reproducibility_configuration_pin_mismatch');
  }
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
    configurationIdentityHash,
    configurationPinned: normalizedExpectedHash !== null,
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
  if (executable !== command.executable
    || !processExecutableFileIdentityMatches({
      executable,
      stat,
      fileContentHash,
      includeUid: true,
      expected: {
        contentHash: command.executableContentHash,
        device: command.executableDevice,
        inode: command.executableInode,
        uid: command.executableUid,
      },
    })
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
