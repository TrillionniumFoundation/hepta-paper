import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE } from '../../paper-domain/automation/full-research-qualification-contract.mjs';
import { restrictedChildEnvironment } from './bounded-child-process.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const SAFE_ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9 ._():-]{0,159}$/;
const ENVIRONMENT_KEY = /^[A-Z_][A-Z0-9_]{0,127}$/;
const MAXIMUM_CONFIG_BYTES = 256 * 1024;
const MAXIMUM_PROTOCOL_BYTES = 16 * 1024 * 1024;
const INDEPENDENT_VERIFIER_ROLE = 'external_qualification_independent_verifier';
const MAXIMUM_CREDENTIAL_FILES = 10_000;
const MAXIMUM_CREDENTIAL_BYTES = 256 * 1024 * 1024;
const QUALIFICATION_COST_AUTHORITIES = new Set([
  'operator_declared_worst_case_usd',
  'externally_operated_zero_cost',
]);
const CONFIGURATION_KEYS = Object.freeze([
  'kind', 'maximumQualificationCostUsd', 'qualificationCostAuthority', 'qualifier',
  'status', 'trustedSignerTrustSet', 'verifier', 'verifierAttestor', 'version',
]);
const COMMAND_KEYS = Object.freeze([
  'args', 'credentialRoot', 'environmentAllowlist', 'executable', 'principalId',
  'protocol', 'serviceId', 'timeoutMs',
]);
const SIGNER_KEYS = Object.freeze([
  'algorithm', 'effectiveFrom', 'expiresAt', 'keyId', 'keyVersion', 'organization',
  'publicKeyPath', 'revokedAt', 'role', 'status', 'subjectId',
]);
const TRUST_SET_KEYS = Object.freeze(['keys', 'kind', 'version']);

function exactKeys(value, expected) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function canonicalTimestamp(value) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp : null;
}

function organizationIdentity(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
    : null;
}

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

function directoryContentsIdentity(root) {
  const rootUid = Number(fs.statSync(root).uid);
  const entries = [];
  const regularFileContentHashes = new Set();
  let files = 0;
  let bytes = 0;
  const visit = (directory, relativeRoot = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.posix.join(relativeRoot, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || Number(stat.uid) !== rootUid
        || (stat.mode & 0o077) !== 0) {
        throw new Error('external_qualification_credential_root_contents_invalid');
      }
      if (stat.isDirectory()) {
        entries.push(Object.freeze({
          path: `${relative}/`,
          mode: stat.mode & 0o777,
          uid: Number(stat.uid),
        }));
        visit(absolute, relative);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1 || stat.size < 1) {
          throw new Error('external_qualification_credential_root_contents_invalid');
        }
        files += 1;
        bytes += stat.size;
        if (files > MAXIMUM_CREDENTIAL_FILES || bytes > MAXIMUM_CREDENTIAL_BYTES) {
          throw new Error('external_qualification_credential_root_contents_too_large');
        }
        const entry = Object.freeze({
          path: relative,
          mode: stat.mode & 0o777,
          uid: Number(stat.uid),
          linkCount: Number(stat.nlink),
          bytes: stat.size,
          contentHash: fileContentHash(absolute),
        });
        entries.push(entry);
        regularFileContentHashes.add(entry.contentHash);
      } else {
        throw new Error('external_qualification_credential_root_contents_invalid');
      }
    }
  };
  visit(root);
  if (files < 1 || bytes < 1) {
    throw new Error('external_qualification_credential_root_contents_invalid');
  }
  return Object.freeze({
    contentsIdentityHash: hashRecord('ExternalQualificationCredentialRootContentsIdentity', {
      entries,
      fileCount: files,
      totalBytes: bytes,
    }),
    regularFileContentHashes: Object.freeze([...regularFileContentHashes].sort()),
  });
}

function existingArgumentResourceIdentities(args, configPath) {
  return Object.freeze(args.flatMap((argument, index) => {
    const candidate = path.isAbsolute(argument)
      ? path.resolve(argument) : path.resolve(path.dirname(configPath), argument);
    if (!fs.existsSync(candidate)) return [];
    const resolved = fs.realpathSync(candidate);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return [];
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

function executableOnPath(program, environment) {
  for (const directory of String(environment.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(directory, program);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return fs.realpathSync(candidate);
    } catch { /* continue */ }
  }
  throw new Error('external_qualification_interpreter_not_found');
}

function interpreterIdentity(executable, environment) {
  const descriptor = fs.openSync(executable, 'r');
  const buffer = Buffer.alloc(4096);
  let count;
  try { count = fs.readSync(descriptor, buffer, 0, buffer.length, 0); }
  finally { fs.closeSync(descriptor); }
  const firstLine = buffer.subarray(0, count).toString('utf8').split(/\r?\n/, 1)[0];
  if (!firstLine.startsWith('#!')) return null;
  const words = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error('external_qualification_interpreter_invalid');
  const launcher = fs.realpathSync(words[0]);
  const executables = [launcher];
  if (path.basename(launcher) === 'env') {
    const program = words.find((word, index) => index > 0 && !word.startsWith('-'));
    if (!program) throw new Error('external_qualification_interpreter_invalid');
    executables.push(executableOnPath(program, environment));
  }
  const payload = Object.freeze(executables.map((candidate) => {
    const stat = fs.statSync(candidate);
    return Object.freeze({
      realpath: candidate,
      device: String(stat.dev),
      inode: String(stat.ino),
      contentHash: fileContentHash(candidate),
    });
  }));
  return hashRecord('ExternalQualificationInterpreterIdentity', payload);
}

function childEnvironmentFor(command, environment) {
  return restrictedChildEnvironment({
    source: environment,
    allowedKeys: command.environmentAllowlist,
    overrides: {
      HEPTA_EXTERNAL_QUALIFICATION_PRINCIPAL_ID: command.principalId,
      HEPTA_EXTERNAL_QUALIFICATION_CREDENTIAL_ROOT: command.credentialRoot,
    },
  });
}

function childEnvironmentIdentity(command, environment) {
  return hashRecord('ExternalQualificationChildEnvironmentIdentity',
    childEnvironmentFor(command, environment));
}

function credentialRootIdentity(candidate) {
  const requested = path.resolve(String(candidate || ''));
  const resolved = fs.realpathSync(requested);
  const stat = fs.statSync(resolved);
  if (requested !== resolved || !stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error('external_qualification_credential_root_invalid');
  }
  const contents = directoryContentsIdentity(resolved);
  const identity = Object.freeze({
    realpath: resolved,
    device: String(stat.dev),
    inode: String(stat.ino),
    uid: Number(stat.uid),
    mode: Number(stat.mode & 0o777),
    contentsIdentityHash: contents.contentsIdentityHash,
  });
  return Object.freeze({
    ...identity,
    regularFileContentHashes: contents.regularFileContentHashes,
    credentialRootIdentityHash:
      hashRecord('ExternalQualificationCredentialRootIdentity', identity),
  });
}

function integrityFile(candidate, { executable = false, maximumBytes = MAXIMUM_CONFIG_BYTES } = {}) {
  const requested = path.resolve(String(candidate || ''));
  const resolved = fs.realpathSync(requested);
  const stat = fs.statSync(resolved);
  if ((!executable && requested !== resolved) || !stat.isFile()
    || stat.size < 1 || stat.size > maximumBytes
    || (stat.mode & 0o022) !== 0 || (executable && (stat.mode & 0o111) === 0)) {
    throw new Error('external_qualification_integrity_file_invalid');
  }
  return resolved;
}

function relativeToConfig(candidate, configPath) {
  const supplied = String(candidate || '');
  return path.isAbsolute(supplied)
    ? path.resolve(supplied)
    : path.resolve(path.dirname(configPath), supplied);
}

function commandConfiguration(value, label, configPath, environment) {
  if (!exactKeys(value, COMMAND_KEYS)
    || value.protocol !== 'external-qualification-json-stdio-v1'
    || !SAFE_ID.test(String(value.serviceId || ''))
    || !SAFE_ID.test(String(value.principalId || ''))
    || !Array.isArray(value.args) || value.args.length > 64
    || value.args.some((item) => typeof item !== 'string' || item.length > 4096)
    || !Array.isArray(value.environmentAllowlist || [])
    || value.environmentAllowlist.some((key) => !ENVIRONMENT_KEY.test(String(key)))
    || !Number.isSafeInteger(Number(value.timeoutMs))
    || Number(value.timeoutMs) < 1000 || Number(value.timeoutMs) > 300_000) {
    throw new Error(`external_qualification_${label}_configuration_invalid`);
  }
  const executable = integrityFile(relativeToConfig(value.executable, configPath), {
    executable: true,
    maximumBytes: 1024 * 1024 * 1024,
  });
  const executableStat = fs.statSync(executable);
  const credentialRoot = credentialRootIdentity(
    relativeToConfig(value.credentialRoot, configPath),
  );
  const command = Object.freeze({
    serviceId: String(value.serviceId),
    principalId: String(value.principalId),
    protocol: value.protocol,
    configurationDirectory: path.dirname(configPath),
    executable,
    executableContentHash: fileContentHash(executable),
    executableDevice: String(executableStat.dev),
    executableInode: String(executableStat.ino),
    credentialRoot: credentialRoot.realpath,
    credentialRootIdentityHash: credentialRoot.credentialRootIdentityHash,
    credentialRootContentsIdentityHash: credentialRoot.contentsIdentityHash,
    credentialRootRegularFileContentHashes: credentialRoot.regularFileContentHashes,
    credentialUid: credentialRoot.uid,
    args: Object.freeze([...value.args]),
    environmentAllowlist: Object.freeze([...new Set(value.environmentAllowlist || [])]),
    timeoutMs: Number(value.timeoutMs),
  });
  const effectiveEnvironment = childEnvironmentFor(command, environment);
  const runtimeIdentity = Object.freeze({
    interpreterIdentityHash: interpreterIdentity(executable, effectiveEnvironment),
    childEnvironmentIdentityHash: childEnvironmentIdentity(command, environment),
    argumentResourceIdentities: existingArgumentResourceIdentities(command.args, configPath),
  });
  return Object.freeze({
    ...command,
    ...runtimeIdentity,
    commandIdentityHash: hashRecord('ExternalQualificationProcessCommandIdentity', {
      ...command,
      ...runtimeIdentity,
    }),
  });
}

function publicSignerConfiguration(value, {
  role,
  label,
  configPath,
  permittedStatuses = ['active', 'retiring'],
  revocationPermitted = false,
  organizationRequired = false,
}) {
  const effectiveFrom = canonicalTimestamp(value?.effectiveFrom);
  const expiresAt = canonicalTimestamp(value?.expiresAt);
  const revokedAt = value?.revokedAt === null ? null : canonicalTimestamp(value?.revokedAt);
  if (!exactKeys(value, SIGNER_KEYS)
    || !SAFE_ID.test(String(value.keyId || ''))
    || !SAFE_VERSION.test(String(value.keyVersion || ''))
    || !SAFE_ID.test(String(value.subjectId || ''))
    || (value.organization !== null && typeof value.organization !== 'string')
    || (organizationRequired && !SAFE_ORGANIZATION.test(String(value.organization || '')))
    || value.algorithm !== 'ed25519' || value.role !== role
    || !permittedStatuses.includes(value.status)
    || (!revocationPermitted && value.revokedAt !== null)
    || (value.revokedAt !== null && revokedAt === null)
    || effectiveFrom === null || expiresAt === null
    || expiresAt <= effectiveFrom) {
    throw new Error(`external_qualification_${label}_invalid`);
  }
  const publicKeyPath = integrityFile(
    relativeToConfig(value.publicKeyPath, configPath),
    { maximumBytes: 64 * 1024 },
  );
  const publicKeyPem = fs.readFileSync(publicKeyPath, 'utf8');
  let publicKey;
  try {
    if (!/-----BEGIN PUBLIC KEY-----/.test(publicKeyPem)
      || /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/.test(publicKeyPem)) {
      throw new Error('private key forbidden');
    }
    publicKey = crypto.createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
  } catch { throw new Error(`external_qualification_${label}_public_key_invalid`); }
  return Object.freeze({
    signer: Object.freeze({
      keyId: String(value.keyId),
      keyVersion: String(value.keyVersion),
      subjectId: String(value.subjectId),
      organization: value.organization === null ? null : String(value.organization),
      role: value.role,
      algorithm: value.algorithm,
      status: value.status,
      effectiveFrom: new Date(effectiveFrom).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      revokedAt: revokedAt === null ? null : new Date(revokedAt).toISOString(),
    }),
    publicKey,
    publicKeyContentHash: fileContentHash(publicKeyPath),
    publicKeySpkiHash: hashBytes(publicKey.export({ type: 'spki', format: 'der' })),
  });
}

function publicTrustKey(key) {
  return Object.freeze({
    ...key.signer,
    publicKeySpkiHash: key.publicKeySpkiHash,
  });
}

function trustedSignerTrustSet(value, configPath) {
  if (!exactKeys(value, TRUST_SET_KEYS)
    || value.version !== 1
    || value.kind !== 'ResearchExecutionReleaseAttestorTrustSet'
    || !Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 32) {
    throw new Error('external_qualification_trusted_signer_trust_set_invalid');
  }
  const keys = value.keys.map((key) => publicSignerConfiguration(key, {
    role: FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE,
    label: 'trusted_signer',
    configPath,
    revocationPermitted: true,
    organizationRequired: true,
  })).sort((left, right) => (
    `${left.signer.keyId}:${left.signer.keyVersion}`
      .localeCompare(`${right.signer.keyId}:${right.signer.keyVersion}`)
  ));
  const tuples = keys.map((key) => `${key.signer.keyId}:${key.signer.keyVersion}`);
  const spkiHashes = keys.map((key) => key.publicKeySpkiHash);
  if (new Set(tuples).size !== tuples.length || new Set(spkiHashes).size !== spkiHashes.length) {
    throw new Error('external_qualification_trusted_signer_trust_set_identity_collision');
  }
  const active = keys.filter((key) => key.signer.status === 'active'
    && key.signer.revokedAt === null);
  if (active.length !== 1) {
    throw new Error('external_qualification_exactly_one_active_trusted_signer_required');
  }
  const publicKeys = Object.freeze(keys.map(publicTrustKey));
  return Object.freeze({
    version: 1,
    keys: Object.freeze(keys),
    publicKeys,
    activeKey: active[0],
    trustSetHash: hashRecord('ResearchExecutionReleaseAttestorTrustSet', {
      version: 1,
      keys: publicKeys,
    }),
  });
}

export function readExternalResearchQualificationProcessConfiguration({ configPath, environment }) {
  const requested = configPath || environment.HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG;
  if (!requested) throw new Error('external_qualification_configuration_path_required');
  const resolvedConfigPath = integrityFile(requested);
  let value;
  try { value = JSON.parse(fs.readFileSync(resolvedConfigPath, 'utf8')); }
  catch { throw new Error('external_qualification_configuration_json_invalid'); }
  if (!exactKeys(value, CONFIGURATION_KEYS)
    || value?.version !== 3
    || value?.kind !== 'ExternalResearchQualificationProcessConfiguration'
    || value?.status !== 'active'
    || typeof value.maximumQualificationCostUsd !== 'number'
    || !Number.isFinite(value.maximumQualificationCostUsd)
    || value.maximumQualificationCostUsd < 0
    || value.maximumQualificationCostUsd > 1_000
    || !QUALIFICATION_COST_AUTHORITIES.has(value.qualificationCostAuthority)
    || (value.qualificationCostAuthority === 'operator_declared_worst_case_usd'
      && value.maximumQualificationCostUsd <= 0)
    || (value.qualificationCostAuthority === 'externally_operated_zero_cost'
      && value.maximumQualificationCostUsd !== 0)) {
    throw new Error('external_qualification_configuration_invalid');
  }
  const qualifier = commandConfiguration(
    value.qualifier,
    'qualifier',
    resolvedConfigPath,
    environment,
  );
  const verifier = commandConfiguration(
    value.verifier,
    'verifier',
    resolvedConfigPath,
    environment,
  );
  if (qualifier.serviceId === verifier.serviceId
    || qualifier.principalId === verifier.principalId
    || qualifier.commandIdentityHash === verifier.commandIdentityHash
    || qualifier.executable === verifier.executable
    || qualifier.executableContentHash === verifier.executableContentHash
    || (qualifier.executableDevice === verifier.executableDevice
      && qualifier.executableInode === verifier.executableInode)
    || qualifier.credentialRoot === verifier.credentialRoot
    || qualifier.credentialRootIdentityHash === verifier.credentialRootIdentityHash
    || qualifier.credentialRootRegularFileContentHashes.some((contentHash) => (
      verifier.credentialRootRegularFileContentHashes.includes(contentHash)
    ))) {
    throw new Error('external_qualification_independent_verifier_required');
  }
  const trusted = trustedSignerTrustSet(value.trustedSignerTrustSet, resolvedConfigPath);
  const verifierAttestor = publicSignerConfiguration(value.verifierAttestor, {
    role: INDEPENDENT_VERIFIER_ROLE,
    label: 'verifier_attestor',
    configPath: resolvedConfigPath,
    organizationRequired: true,
  });
  if (trusted.keys.some((key) => (
    key.signer.keyId === verifierAttestor.signer.keyId
      || key.signer.subjectId === verifierAttestor.signer.subjectId
      || key.publicKeySpkiHash === verifierAttestor.publicKeySpkiHash
  ))) {
    throw new Error('external_qualification_independent_verifier_attestor_required');
  }
  const verifierOrganization = organizationIdentity(verifierAttestor.signer.organization);
  if (!verifierOrganization || trusted.keys.some((key) => (
    organizationIdentity(key.signer.organization) === verifierOrganization
  ))) {
    throw new Error('external_qualification_independent_verifier_organization_required');
  }
  const trustIdentityPayload = Object.freeze({
    trustedSignerTrustSetVersion: trusted.version,
    trustedSignerTrustSetHash: trusted.trustSetHash,
    trustedSigners: trusted.publicKeys,
    verifierAttestor: verifierAttestor.signer,
    verifierAttestorPublicKeySpkiHash: verifierAttestor.publicKeySpkiHash,
  });
  const trustIdentityHash = hashRecord(
    'ExternalResearchQualificationTrustIdentity',
    trustIdentityPayload,
  );
  const configurationIdentityPayload = Object.freeze({
    qualifierCommandIdentityHash: qualifier.commandIdentityHash,
    verifierCommandIdentityHash: verifier.commandIdentityHash,
    maximumQualificationCostUsd: value.maximumQualificationCostUsd,
    qualificationCostAuthority: value.qualificationCostAuthority,
    trustIdentityHash,
  });
  const configurationIdentityHash = hashRecord(
    'ExternalResearchQualificationConfigurationIdentity',
    configurationIdentityPayload,
  );
  return Object.freeze({
    configPath: resolvedConfigPath,
    qualifier,
    verifier,
    trustedSignerTrustSetVersion: trusted.version,
    trustedSignerTrustSetHash: trusted.trustSetHash,
    trustedSignerKeys: trusted.keys,
    trustedSigners: trusted.publicKeys,
    trustedSigner: trusted.activeKey.signer,
    publicKey: trusted.activeKey.publicKey,
    trustedSignerPublicKeySpkiHash: trusted.activeKey.publicKeySpkiHash,
    verifierAttestor: verifierAttestor.signer,
    verifierPublicKey: verifierAttestor.publicKey,
    verifierAttestorPublicKeySpkiHash: verifierAttestor.publicKeySpkiHash,
    maximumQualificationCostUsd: value.maximumQualificationCostUsd,
    qualificationCostAuthority: value.qualificationCostAuthority,
    trustIdentityHash,
    configurationIdentityHash,
    clientServiceIdentityHash: hashRecord('ExternalResearchQualificationClientServiceIdentity', {
      configurationIdentityHash,
      commandIdentityHash: qualifier.commandIdentityHash,
      serviceId: qualifier.serviceId,
      principalId: qualifier.principalId,
    }),
    verifierServiceIdentityHash: hashRecord('ExternalResearchQualificationVerifierServiceIdentity', {
      configurationIdentityHash,
      commandIdentityHash: verifier.commandIdentityHash,
      serviceId: verifier.serviceId,
      principalId: verifier.principalId,
      trustIdentityHash,
    }),
  });
}

function parseProtocolResponse(result, failure) {
  if (result?.error || result?.timedOut || result?.aborted || result?.exitCode !== 0
    || result?.outputTruncated || result?.stdoutBytes < 2
    || result?.stdoutBytes > MAXIMUM_PROTOCOL_BYTES) throw new Error(failure);
  try {
    const parsed = JSON.parse(result.stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    return parsed;
  } catch { throw new Error(`${failure}_response_invalid`); }
}

export async function invokeExternalResearchQualificationProcess(command, payload, {
  cwd, environment, runProcess, signal = null, timeoutMs = null,
}) {
  const executable = fs.realpathSync(command.executable);
  const executableStat = fs.statSync(executable);
  const credential = credentialRootIdentity(command.credentialRoot);
  const effectiveEnvironment = childEnvironmentFor(command, environment);
  const argumentResources = existingArgumentResourceIdentities(
    command.args,
    path.join(command.configurationDirectory, 'configuration.json'),
  );
  if (executable !== command.executable
    || String(executableStat.dev) !== command.executableDevice
    || String(executableStat.ino) !== command.executableInode
    || fileContentHash(executable) !== command.executableContentHash
    || credential.credentialRootIdentityHash !== command.credentialRootIdentityHash
    || credential.contentsIdentityHash !== command.credentialRootContentsIdentityHash
    || JSON.stringify(credential.regularFileContentHashes)
      !== JSON.stringify(command.credentialRootRegularFileContentHashes)
    || childEnvironmentIdentity(command, environment) !== command.childEnvironmentIdentityHash
    || interpreterIdentity(executable, effectiveEnvironment) !== command.interpreterIdentityHash
    || hashRecord('ExternalQualificationArgumentResourceIdentities', argumentResources)
      !== hashRecord(
        'ExternalQualificationArgumentResourceIdentities',
        command.argumentResourceIdentities,
      )) {
    throw new Error('external_qualification_process_identity_changed');
  }
  const result = await runProcess({
    executable: command.executable,
    args: command.args,
    cwd,
    env: effectiveEnvironment,
    stdin: `${JSON.stringify(payload)}\n`,
    timeoutMs: Math.max(1, Math.min(
      command.timeoutMs,
      timeoutMs !== null && timeoutMs !== undefined
        && Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? Number(timeoutMs) : command.timeoutMs,
    )),
    signal,
    maximumCapturedBytes: MAXIMUM_PROTOCOL_BYTES,
  });
  return parseProtocolResponse(result, 'external_qualification_process_failed');
}
