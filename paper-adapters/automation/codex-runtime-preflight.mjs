import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  CODEX_MODEL_AVAILABILITY_CANARY_MAXIMUM_AGE_MS,
} from '../../paper-domain/automation/full-research-qualification-contract.mjs';
import { restrictedChildEnvironment } from './bounded-child-process.mjs';
import {
  openClawModelRuntimeProvenance,
} from './codex-openclaw-managed-configuration.mjs';

// Container-isolated Codex runtimes need a short Docker startup/cleanup window
// around the same read-only checks. Fifteen seconds remains bounded while
// avoiding false postflight failures under ordinary local daemon contention.
const PREFLIGHT_TIMEOUT_MS = 15000;
const MANAGED_LOGIN_PREFLIGHT_TIMEOUT_MS = 60000;
const MODEL_CANARY_TIMEOUT_MS = 120000;
const MODEL_CANARY_RESPONSE_PREFIX = 'HEPTA_CODEX_CANARY_RESPONSE';
const CODEX_CREDENTIAL_MATERIAL_PATHS = Object.freeze(['auth.json']);
const READ_ONLY_PREFLIGHT_ATTEMPTS = 2;

function fail(code) {
  const error = new Error(code);
  error.retryable = false;
  throw error;
}

function code(prefix, suffix) {
  return `${prefix}_${suffix}`;
}

function configuredModelFromCodexConfig(source, prefix) {
  const topLevel = String(source || '').split(/^\s*\[/m, 1)[0];
  const match = topLevel.match(/^\s*model\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/m);
  if (!match) fail(code(prefix, 'model_required_in_config'));
  let model;
  try {
    model = match[1].startsWith('"')
      ? JSON.parse(match[1])
      : match[1].slice(1, -1);
  } catch {
    fail(code(prefix, 'model_invalid_in_config'));
  }
  const selected = String(model || '').trim();
  if (!selected) fail(code(prefix, 'model_invalid_in_config'));
  return selected;
}

function managedOpenClawRuntimeConfiguration(source, prefix) {
  const text = String(source || '');
  const header = /^\s*\[hepta_openclaw_managed\]\s*$/m.exec(text);
  if (!header) {
    return Object.freeze({
      requested: false,
      openClawManagedAuthProfileIdentityHash: null,
      openClawManagedAuthSourceIdentityHash: null,
    });
  }
  const remainder = text.slice(header.index + header[0].length);
  const nextSectionIndex = remainder.search(/^\s*\[[A-Za-z0-9_.-]+\]\s*$/m);
  const section = nextSectionIndex < 0
    ? remainder : remainder.slice(0, nextSectionIndex);
  if (!/^\s*version\s*=\s*4\s*(?:#.*)?$/m.test(section)
    || !/^\s*managed_auth\s*=\s*true\s*(?:#.*)?$/m.test(section)) {
    fail(code(prefix, 'openclaw_managed_config_invalid'));
  }
  const managedString = (name) => {
    const match = section.match(new RegExp(
      `^\\s*${name}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')\\s*(?:#.*)?$`,
      'm',
    ));
    try {
      return match?.[1]?.startsWith('"')
        ? JSON.parse(match[1]) : match?.[1]?.slice(1, -1);
    } catch {
      fail(code(prefix, 'openclaw_managed_config_invalid'));
    }
    return null;
  };
  const authProfileId = managedString('auth_profile_id');
  const agentId = managedString('agent_id');
  const openclawBinary = managedString('openclaw_binary');
  const openclawConfigPath = managedString('openclaw_config_path');
  const openclawStateDir = managedString('openclaw_state_dir');
  if (!/^openai:[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,247}$/.test(
    String(authProfileId || ''),
  )
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(String(agentId || ''))
    || !path.isAbsolute(String(openclawBinary || ''))
    || !path.isAbsolute(String(openclawConfigPath || ''))
    || !path.isAbsolute(String(openclawStateDir || ''))
    || path.resolve(openclawConfigPath) !== openclawConfigPath
    || path.resolve(openclawStateDir) !== openclawStateDir
    || path.dirname(openclawConfigPath) !== openclawStateDir) {
    fail(code(prefix, 'openclaw_managed_config_invalid'));
  }
  let runtimeProvenance;
  try {
    const resolvedOpenClawBinary = fs.realpathSync(openclawBinary);
    const binaryStat = fs.statSync(resolvedOpenClawBinary);
    fs.accessSync(resolvedOpenClawBinary, fs.constants.X_OK);
    if (!binaryStat.isFile()) throw new Error('runtime binary is not a file');
    runtimeProvenance = openClawModelRuntimeProvenance(
      resolvedOpenClawBinary,
    );
  } catch {
    fail(code(prefix, 'openclaw_managed_runtime_provenance_invalid'));
  }
  return Object.freeze({
    requested: true,
    openClawManagedRuntimeProvenanceHash:
      runtimeProvenance.openClawManagedRuntimeProvenanceHash,
    openClawManagedAuthProfileIdentityHash:
      hashRecord('OpenClawManagedAuthProfileIdentity', {
        provider: 'openai',
        authProfileId,
      }),
    openClawManagedAuthSourceIdentityHash:
      hashRecord('OpenClawManagedAuthSourceIdentity', {
        agentId,
        openclawConfigPath,
        openclawStateDir,
      }),
  });
}

function statIdentity(stat) {
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: Number(stat.mode & 0o777n),
    uid: String(stat.uid),
    gid: String(stat.gid),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

function credentialRootFilesystemIdentity(stat) {
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: Number(stat.mode & 0o777n),
    uid: String(stat.uid),
    gid: String(stat.gid),
  });
}

function safeRealDirectory(candidate, prefix) {
  if (!candidate) fail(code(prefix, 'home_required'));
  const requested = path.resolve(String(candidate));
  let resolved;
  let stat;
  try {
    const linkStat = fs.lstatSync(requested, { bigint: true });
    if (linkStat.isSymbolicLink()) fail(code(prefix, 'home_invalid'));
    resolved = fs.realpathSync(requested);
    if (resolved !== requested) fail(code(prefix, 'home_invalid'));
    stat = fs.statSync(resolved, { bigint: true });
  } catch (error) {
    if (error?.message === code(prefix, 'home_invalid')) throw error;
    fail(code(prefix, 'home_invalid'));
  }
  if (!stat.isDirectory()) fail(code(prefix, 'home_invalid'));
  return Object.freeze({ resolved, stat });
}

function assertPrivateOwner(stat, errorCode) {
  const mode = Number(stat.mode & 0o777n);
  if ((mode & 0o077) !== 0) fail(errorCode);
  if (typeof process.getuid === 'function' && Number(stat.uid) !== process.getuid()) fail(errorCode);
}

function resolveExecutable(candidate, environment, prefix) {
  const requested = String(candidate || '').trim();
  if (!requested) fail(code(prefix, 'binary_required'));
  const candidates = requested.includes(path.sep)
    ? [path.resolve(requested)]
    : String(environment.PATH || '').split(path.delimiter).filter(Boolean)
      .map((entry) => path.resolve(entry, requested));
  for (const item of candidates) {
    try {
      const resolved = fs.realpathSync(item);
      const stat = fs.statSync(resolved, { bigint: true });
      fs.accessSync(resolved, fs.constants.X_OK);
      if (stat.isFile()) return Object.freeze({ resolved, stat });
    } catch { /* keep searching PATH */ }
  }
  fail(code(prefix, 'binary_unavailable'));
}

function runCheck(spawnSyncImpl, executable, args, {
  cwd,
  env,
  timeoutMs = PREFLIGHT_TIMEOUT_MS,
}) {
  let result;
  try {
    result = spawnSyncImpl(executable, args, {
      cwd,
      // Node's coverage runner adds NODE_V8_COVERAGE while normalizing child
      // process options. Keep the exact restricted allowlist, but give spawn a
      // fresh mutable container so instrumentation cannot make the preflight
      // fail before the executable is launched.
      env: { ...env },
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
  } catch { return Object.freeze({ ok: false, stdout: '', stderr: '' }); }
  return Object.freeze({
    ok: !result?.error && result?.status === 0 && result?.signal === null,
    stdout: String(result?.stdout || ''),
    stderr: String(result?.stderr || ''),
  });
}

function runReadOnlyPreflightCheck(spawnSyncImpl, executable, args, options) {
  let result = null;
  for (let attempt = 0; attempt < READ_ONLY_PREFLIGHT_ATTEMPTS; attempt += 1) {
    result = runCheck(spawnSyncImpl, executable, args, options);
    if (result.ok) break;
  }
  return result;
}

function credentialMaterialIdentity(root, relativePath, prefix) {
  const requested = path.join(root.resolved, relativePath);
  let linkStat;
  try {
    linkStat = fs.lstatSync(requested, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return Object.freeze({ relativePath, status: 'credential_material_absent' });
    }
    fail(code(prefix, 'credential_material_invalid'));
  }
  if (!linkStat.isFile() || linkStat.isSymbolicLink()) {
    fail(code(prefix, 'credential_material_invalid'));
  }
  let resolved;
  let stat;
  try {
    resolved = fs.realpathSync(requested);
    stat = fs.statSync(requested, { bigint: true });
  } catch {
    fail(code(prefix, 'credential_material_invalid'));
  }
  if (resolved !== requested || !stat.isFile()
    || stat.dev !== linkStat.dev || stat.ino !== linkStat.ino) {
    fail(code(prefix, 'credential_material_invalid'));
  }
  assertPrivateOwner(stat, code(prefix, 'credential_material_permissions_invalid'));
  if (stat.nlink !== 1n) fail(code(prefix, 'credential_material_links_invalid'));
  return Object.freeze({
    relativePath,
    status: 'credential_material_present',
    canonicalPathHash: hashBytes(resolved),
    filesystemIdentity: Object.freeze({
      ...statIdentity(stat),
      linkCount: String(stat.nlink),
    }),
  });
}

function credentialMaterialIdentities(root, prefix) {
  return Object.freeze(CODEX_CREDENTIAL_MATERIAL_PATHS.map(
    (relativePath) => credentialMaterialIdentity(root, relativePath, prefix),
  ));
}

function rootIdentity(
  root,
  prefix,
  credentialMaterial = credentialMaterialIdentities(root, prefix),
) {
  return hashRecord('CodexCredentialRootIdentity', {
    canonicalPathHash: hashBytes(root.resolved),
    // Codex legitimately creates and rotates non-credential cache/session
    // entries in its home. Directory size and timestamps therefore describe
    // runtime activity, not credential identity. Bind the stable directory
    // object, owner and permissions while credential/config files remain
    // independently content- and inode-bound below.
    filesystemIdentity: credentialRootFilesystemIdentity(root.stat),
    credentialMaterialIdentities: credentialMaterial,
  });
}

export function inspectCodexCredentialRootIdentity({ codexHome, errorPrefix = 'codex' } = {}) {
  const root = safeRealDirectory(codexHome, errorPrefix);
  assertPrivateOwner(root.stat, code(errorPrefix, 'home_permissions_invalid'));
  return Object.freeze({
    codexHome: root.resolved,
    credentialRootIdentityHash: rootIdentity(root, errorPrefix),
  });
}

/**
 * Read-only Codex runtime preflight. It never opens tokens, cookies or auth
 * files; only non-secret filesystem metadata for known credential material is
 * bound into the credential-root identity.
 */
function inspectCodexRuntime({
  codexBinary = 'codex',
  codexHome,
  model,
  errorPrefix = 'codex',
  spawnSyncImpl = spawnSync,
  environment = process.env,
  readinessRequired = true,
} = {}) {
  const explicitModel = String(model || '').trim();
  const root = safeRealDirectory(codexHome, errorPrefix);
  assertPrivateOwner(root.stat, code(errorPrefix, 'home_permissions_invalid'));
  const configPath = path.join(root.resolved, 'config.toml');
  let configStat;
  try {
    const linkStat = fs.lstatSync(configPath, { bigint: true });
    configStat = fs.statSync(configPath, { bigint: true });
    if (!linkStat.isFile() || linkStat.isSymbolicLink() || !configStat.isFile()) {
      fail(code(errorPrefix, 'config_invalid'));
    }
  } catch (error) {
    if (error?.message === code(errorPrefix, 'config_invalid')) throw error;
    fail(code(errorPrefix, 'config_required'));
  }
  assertPrivateOwner(configStat, code(errorPrefix, 'config_permissions_invalid'));
  const configBytes = fs.readFileSync(configPath);
  const managedConfiguration = managedOpenClawRuntimeConfiguration(
    configBytes.toString('utf8'),
    errorPrefix,
  );
  const managedOpenClawRuntime = managedConfiguration.requested;
  const selectedModel = explicitModel
    || configuredModelFromCodexConfig(configBytes.toString('utf8'), errorPrefix);
  const normalizedSelectedModel = managedOpenClawRuntime
    ? String(selectedModel).replace(/^openai\//, '')
    : selectedModel;
  const modelSelectionSource = explicitModel
    ? 'explicit_override' : 'codex_home_config';
  const credentialMaterialBeforeChecks = credentialMaterialIdentities(root, errorPrefix);
  const credentialMaterialIdentityBeforeChecks = hashRecord(
    'CodexCredentialMaterialIdentitySet',
    credentialMaterialBeforeChecks,
  );
  const binary = resolveExecutable(codexBinary, environment, errorPrefix);
  const childEnv = restrictedChildEnvironment({
    source: environment,
    allowedKeys: ['CODEX_HOME'],
    overrides: { CODEX_HOME: root.resolved },
  });
  const versionCheck = runReadOnlyPreflightCheck(spawnSyncImpl, binary.resolved, ['--version'], {
    cwd: root.resolved,
    env: childEnv,
  });
  const codexVersion = versionCheck.stdout.trim().split(/\r?\n/)[0]?.slice(0, 200) || '';
  if (!versionCheck.ok || !/\bcodex(?:-cli)?\b/i.test(codexVersion)) {
    fail(code(errorPrefix, 'version_unverified'));
  }
  if (managedOpenClawRuntime
    ) {
    const versionRuntimeIdentity = codexVersion.match(
      /^codex-openclaw-managed\s+3\s+bridge=[a-f0-9]{16}\s+runtime=([a-f0-9]{16})\b/,
    )?.[1] || null;
    const expectedRuntimeIdentity = managedConfiguration
      .openClawManagedRuntimeProvenanceHash.slice(7, 23);
    if (versionRuntimeIdentity !== expectedRuntimeIdentity) {
      fail(code(errorPrefix, 'openclaw_managed_runtime_required'));
    }
  }
  if (readinessRequired) {
    const commandCheck = runReadOnlyPreflightCheck(
      spawnSyncImpl,
      binary.resolved,
      ['exec', '--help'],
      { cwd: root.resolved, env: childEnv },
    );
    if (!commandCheck.ok || !/(?:^|\s)--model(?:\s|,|$)/m.test(
      `${commandCheck.stdout}\n${commandCheck.stderr}`,
    )) {
      fail(code(errorPrefix, 'model_option_unavailable'));
    }
    const loginCheck = runReadOnlyPreflightCheck(
      spawnSyncImpl,
      binary.resolved,
      ['login', 'status'],
      {
        cwd: root.resolved,
        env: childEnv,
        timeoutMs: managedOpenClawRuntime
          ? MANAGED_LOGIN_PREFLIGHT_TIMEOUT_MS : PREFLIGHT_TIMEOUT_MS,
      },
    );
    const loginStatus = `${loginCheck.stdout}\n${loginCheck.stderr}`;
    if (!loginCheck.ok || /\bnot\s+logged\s+in\b/i.test(loginStatus)
      || !/(?:\blogged\s+in\b|\bauthenticated\b)/i.test(loginStatus)) {
      fail(code(errorPrefix, 'authentication_required'));
    }
    if (managedOpenClawRuntime
      && !/^Logged in using OpenClaw-managed ChatGPT authentication\s*$/m.test(
        loginCheck.stdout,
      )) {
      fail(code(errorPrefix, 'openclaw_managed_identity_unverified'));
    }
  }
  const credentialMaterialAfterChecks = credentialMaterialIdentities(root, errorPrefix);
  if (managedOpenClawRuntime && credentialMaterialAfterChecks.some(
    (entry) => entry.status !== 'credential_material_absent',
  )) {
    fail(code(errorPrefix, 'openclaw_managed_credential_export_forbidden'));
  }
  const credentialMaterialIdentityAfterChecks = hashRecord(
    'CodexCredentialMaterialIdentitySet',
    credentialMaterialAfterChecks,
  );
  if (credentialMaterialIdentityAfterChecks !== credentialMaterialIdentityBeforeChecks) {
    fail(code(errorPrefix, 'credential_material_changed_during_preflight'));
  }
  const credentialRootIdentityHash = rootIdentity(
    root,
    errorPrefix,
    credentialMaterialAfterChecks,
  );
  const codexBinaryIdentityHash = hashRecord('CodexExecutableIdentity', {
    contentHash: hashBytes(fs.readFileSync(binary.resolved)),
    filesystemIdentity: statIdentity(binary.stat),
    versionHash: hashBytes(codexVersion),
  });
  const credentialConfigIdentityHash = hashRecord('CodexCredentialConfigIdentity', {
    credentialRootIdentityHash,
    configRelativePath: 'config.toml',
    configFilesystemIdentity: statIdentity(configStat),
    configContentHash: hashBytes(configBytes),
  });
  return Object.freeze({
    codexBinary: binary.resolved,
    codexHome: root.resolved,
    model: normalizedSelectedModel,
    modelSelectionSource,
    codexVersion,
    codexBinaryIdentityHash,
    credentialRootIdentityHash,
    credentialConfigIdentityHash,
    ...(readinessRequired ? {
      authenticationStatus: 'codex_authentication_verified',
      modelOptionVerified: true,
    } : {}),
    executionTransport: managedOpenClawRuntime
      ? 'openclaw_user_locked_codex_app_server' : 'codex_cli',
    authenticationAuthorityMode: managedOpenClawRuntime
      ? 'openclaw_user_locked_profile_fail_closed' : 'codex_home',
    managedRuntimeEvidenceRequired: managedOpenClawRuntime,
    openClawManagedConfigurationHash: managedOpenClawRuntime
      ? hashBytes(configBytes) : null,
    openClawManagedRuntimeProvenanceHash: managedOpenClawRuntime
      ? managedConfiguration.openClawManagedRuntimeProvenanceHash : null,
    openClawManagedAuthProfileIdentityHash:
      managedConfiguration.openClawManagedAuthProfileIdentityHash,
    openClawManagedAuthSourceIdentityHash:
      managedConfiguration.openClawManagedAuthSourceIdentityHash,
  });
}

/**
 * Static post-execution identity inspection. The full readiness admission is
 * deliberately not repeated here: command help and managed login status are
 * operational probes, while the completed managed execution evidence already
 * binds the profile, source, model and cleanup used by the actual turn.
 */
export function inspectCodexRuntimeIdentity(options = {}) {
  return inspectCodexRuntime({ ...options, readinessRequired: false });
}

export function preflightCodexRuntime(options = {}) {
  return inspectCodexRuntime({ ...options, readinessRequired: true });
}

/**
 * Explicit live provider check. Unlike the filesystem/authentication preflight,
 * this performs one external model invocation and must only be called from an
 * operator-selected canary surface.
 */
export function probeCodexModelAvailability({
  codexBinary = 'codex',
  codexHome,
  model,
  errorPrefix = 'codex',
  spawnSyncImpl = spawnSync,
  environment = process.env,
  clock = { now: () => new Date() },
} = {}) {
  const runtime = preflightCodexRuntime({
    codexBinary,
    codexHome,
    model,
    errorPrefix,
    spawnSyncImpl,
    environment,
  });
  const childEnv = restrictedChildEnvironment({
    source: environment,
    allowedKeys: ['CODEX_HOME'],
    overrides: { CODEX_HOME: runtime.codexHome },
  });
  const challenge = Object.freeze({
    nonce: crypto.randomBytes(16).toString('hex'),
    left: crypto.randomInt(100000, 900000),
    right: crypto.randomInt(100000, 900000),
  });
  const expectedResponse = `${MODEL_CANARY_RESPONSE_PREFIX}:${challenge.left + challenge.right}`;
  const prompt = [
    `HEPTA_CODEX_MODEL_CANARY_CHALLENGE ${challenge.nonce}.`,
    `Add decimal integers ${challenge.left} and ${challenge.right}.`,
    `Return exactly one line using prefix ${MODEL_CANARY_RESPONSE_PREFIX}, then a colon, then the decimal sum.`,
    'Do not repeat the challenge, operands, or instructions. Do not use tools or read files.',
  ].join(' ');
  let result;
  try {
    const args = [
      'exec',
      '--ephemeral',
      '--color', 'never',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--cd', os.tmpdir(),
      '-',
    ];
    if (runtime.modelSelectionSource === 'explicit_override') {
      args.splice(1, 0, '--model', runtime.model);
    }
    result = spawnSyncImpl(runtime.codexBinary, args, {
      cwd: os.tmpdir(),
      // Preserve the restricted environment while allowing Node's coverage
      // runner to attach its own child-process instrumentation metadata.
      env: { ...childEnv },
      input: prompt,
      encoding: 'utf8',
      timeout: MODEL_CANARY_TIMEOUT_MS,
      maxBuffer: 512 * 1024,
      windowsHide: true,
    });
  } catch { fail(code(errorPrefix, 'model_live_canary_failed')); }
  const response = String(result?.stdout || '').trim();
  if (result?.error || result?.status !== 0 || result?.signal !== null || response !== expectedResponse) {
    fail(code(errorPrefix, 'model_live_canary_failed'));
  }
  const observed = clock?.now ? clock.now() : null;
  const observedAt = observed instanceof Date ? observed : new Date(observed);
  if (!Number.isFinite(observedAt.getTime())) {
    fail(code(errorPrefix, 'model_live_canary_clock_invalid'));
  }
  const payload = {
    version: 1,
    kind: 'CodexModelAvailabilityCanaryReceipt',
    status: 'codex_model_live_canary_verified',
    provider: 'openai',
    model: runtime.model,
    modelSelectionSource: runtime.modelSelectionSource,
    codexVersion: runtime.codexVersion,
    codexBinaryIdentityHash: runtime.codexBinaryIdentityHash,
    credentialRootIdentityHash: runtime.credentialRootIdentityHash,
    credentialConfigIdentityHash: runtime.credentialConfigIdentityHash,
    authenticationStatus: runtime.authenticationStatus,
    selectedModelExecutionCanaryVerified: true,
    challengeHash: hashRecord('CodexModelAvailabilityChallenge', challenge),
    responseHash: hashBytes(response),
    observedAt: observedAt.toISOString(),
    expiresAt: new Date(
      observedAt.getTime() + CODEX_MODEL_AVAILABILITY_CANARY_MAXIMUM_AGE_MS,
    ).toISOString(),
    externalActionPerformed: true,
    externalActionScope: 'single_read_only_ephemeral_model_canary',
  };
  return Object.freeze({
    ...payload,
    codexModelAvailabilityCanaryReceiptHash: hashRecord('CodexModelAvailabilityCanaryReceipt', payload),
  });
}
