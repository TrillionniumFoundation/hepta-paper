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

const PREFLIGHT_TIMEOUT_MS = 5000;
const MODEL_CANARY_TIMEOUT_MS = 120000;
const MODEL_CANARY_RESPONSE_PREFIX = 'HEPTA_CODEX_CANARY_RESPONSE';

function fail(code) {
  const error = new Error(code);
  error.retryable = false;
  throw error;
}

function code(prefix, suffix) {
  return `${prefix}_${suffix}`;
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

function runCheck(spawnSyncImpl, executable, args, { cwd, env }) {
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
      timeout: PREFLIGHT_TIMEOUT_MS,
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

function rootIdentity(root) {
  return hashRecord('CodexCredentialRootIdentity', {
    canonicalPathHash: hashBytes(root.resolved),
    filesystemIdentity: statIdentity(root.stat),
  });
}

export function inspectCodexCredentialRootIdentity({ codexHome, errorPrefix = 'codex' } = {}) {
  const root = safeRealDirectory(codexHome, errorPrefix);
  assertPrivateOwner(root.stat, code(errorPrefix, 'home_permissions_invalid'));
  return Object.freeze({ codexHome: root.resolved, credentialRootIdentityHash: rootIdentity(root) });
}

/** Read-only Codex runtime preflight. It never opens tokens, cookies or auth files. */
export function preflightCodexRuntime({
  codexBinary = 'codex',
  codexHome,
  model,
  errorPrefix = 'codex',
  spawnSyncImpl = spawnSync,
  environment = process.env,
} = {}) {
  const selectedModel = String(model || '').trim();
  if (!selectedModel) fail(code(errorPrefix, 'model_required'));
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
  const binary = resolveExecutable(codexBinary, environment, errorPrefix);
  const childEnv = restrictedChildEnvironment({
    source: environment,
    allowedKeys: ['CODEX_HOME'],
    overrides: { CODEX_HOME: root.resolved },
  });
  const versionCheck = runCheck(spawnSyncImpl, binary.resolved, ['--version'], {
    cwd: root.resolved,
    env: childEnv,
  });
  const codexVersion = versionCheck.stdout.trim().split(/\r?\n/)[0]?.slice(0, 200) || '';
  if (!versionCheck.ok || !/\bcodex(?:-cli)?\b/i.test(codexVersion)) {
    fail(code(errorPrefix, 'version_unverified'));
  }
  const commandCheck = runCheck(spawnSyncImpl, binary.resolved, ['exec', '--help'], {
    cwd: root.resolved,
    env: childEnv,
  });
  if (!commandCheck.ok || !/(?:^|\s)--model(?:\s|,|$)/m.test(`${commandCheck.stdout}\n${commandCheck.stderr}`)) {
    fail(code(errorPrefix, 'model_option_unavailable'));
  }
  const loginCheck = runCheck(spawnSyncImpl, binary.resolved, ['login', 'status'], {
    cwd: root.resolved,
    env: childEnv,
  });
  const loginStatus = `${loginCheck.stdout}\n${loginCheck.stderr}`;
  if (!loginCheck.ok || /\bnot\s+logged\s+in\b/i.test(loginStatus)
    || !/(?:\blogged\s+in\b|\bauthenticated\b)/i.test(loginStatus)) {
    fail(code(errorPrefix, 'authentication_required'));
  }
  const credentialRootIdentityHash = rootIdentity(root);
  const codexBinaryIdentityHash = hashRecord('CodexExecutableIdentity', {
    contentHash: hashBytes(fs.readFileSync(binary.resolved)),
    filesystemIdentity: statIdentity(binary.stat),
    versionHash: hashBytes(codexVersion),
  });
  const credentialConfigIdentityHash = hashRecord('CodexCredentialConfigIdentity', {
    credentialRootIdentityHash,
    configRelativePath: 'config.toml',
    configFilesystemIdentity: statIdentity(configStat),
    configContentHash: hashBytes(fs.readFileSync(configPath)),
  });
  return Object.freeze({
    codexBinary: binary.resolved,
    codexHome: root.resolved,
    model: selectedModel,
    codexVersion,
    codexBinaryIdentityHash,
    credentialRootIdentityHash,
    credentialConfigIdentityHash,
    authenticationStatus: 'codex_authentication_verified',
    modelOptionVerified: true,
  });
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
    result = spawnSyncImpl(runtime.codexBinary, [
      'exec',
      '--model', runtime.model,
      '--ephemeral',
      '--color', 'never',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--cd', os.tmpdir(),
      '-',
    ], {
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
