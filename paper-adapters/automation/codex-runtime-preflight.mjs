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
  inspectCodexRuntimeConfiguration,
} from './codex-runtime-configuration-inspector.mjs';
import {
  openClawManagedFailureExecutorBinding,
} from './codex-openclaw-managed-failure-execution-binding.mjs';
import {
  buildManagedWorkspaceSnapshot,
  buildOpenClawManagedExecutionMetadata,
} from './codex-openclaw-managed-workspace-repository.mjs';
import {
  failCodexModelAvailabilityCanary,
} from './codex-model-availability-canary-failure.mjs';

// Container-isolated Codex runtimes need a short Docker startup/cleanup window
// around the same read-only checks. Fifteen seconds remains bounded while
// avoiding false postflight failures under ordinary local daemon contention.
const PREFLIGHT_TIMEOUT_MS = 15000;
const MANAGED_LOGIN_PREFLIGHT_TIMEOUT_MS = 60000;
const MODEL_CANARY_TIMEOUT_MS = 120000;
const MODEL_CANARY_RESPONSE_PREFIX = 'HEPTA_CODEX_CANARY_RESPONSE';
const CODEX_CREDENTIAL_MATERIAL_PATHS = Object.freeze(['auth.json']);
const READ_ONLY_PREFLIGHT_ATTEMPTS = 2;
const MODEL_CANARY_EXECUTION_ROLE = 'model-availability-canary';
const MODEL_CANARY_PRINCIPAL_ID = 'hepta-model-availability-canary';

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
  const {
    managedConfiguration,
    managedOpenClawRuntime,
    model: normalizedSelectedModel,
    modelSelectionSource,
  } = inspectCodexRuntimeConfiguration({
    source: configBytes.toString('utf8'),
    errorPrefix,
    explicitModel,
  });
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
      ? managedConfiguration.gatewayTransport
        ? 'openclaw_gateway_direct_rpc'
        : 'openclaw_user_locked_codex_app_server'
      : 'codex_cli',
    authenticationAuthorityMode: managedOpenClawRuntime
      ? managedConfiguration.gatewayTransport
        ? 'openclaw_current_agent_gateway_oauth'
        : 'openclaw_user_locked_profile_fail_closed'
      : 'codex_home',
    managedRuntimeEvidenceRequired: managedOpenClawRuntime,
    openClawManagedConfigurationHash: managedOpenClawRuntime
      ? hashBytes(configBytes) : null,
    openClawManagedRuntimeProvenanceHash: managedOpenClawRuntime
      ? managedConfiguration.openClawManagedRuntimeProvenanceHash : null,
    openClawManagedAuthProfileIdentityHash:
      managedConfiguration.openClawManagedAuthProfileIdentityHash,
    openClawManagedGatewayRouteIdentityHash:
      managedConfiguration.openClawManagedGatewayRouteIdentityHash,
    openClawManagedAuthBindingMode:
      managedConfiguration.openClawManagedAuthBindingMode,
    openClawManagedAuthSourceIdentityHash:
      managedConfiguration.openClawManagedAuthSourceIdentityHash,
    openClawManagedAgentId: managedOpenClawRuntime
      ? managedConfiguration.agentId : null,
    openClawManagedPrincipalRole: managedOpenClawRuntime
      ? managedConfiguration.principalRole : null,
    openClawManagedMaximumContextBytes: managedOpenClawRuntime
      ? managedConfiguration.maximumContextBytes : null,
    openClawManagedMaximumFileCount: managedOpenClawRuntime
      ? managedConfiguration.maximumFileCount : null,
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
  beforeModelInvocation = null,
} = {}) {
  const runtime = preflightCodexRuntime({
    codexBinary,
    codexHome,
    model,
    errorPrefix,
    spawnSyncImpl,
    environment,
  });
  const challenge = Object.freeze({
    nonce: crypto.randomBytes(16).toString('hex'),
    left: crypto.randomInt(100000, 900000),
    right: crypto.randomInt(100000, 900000),
  });
  const expectedResponse = `${MODEL_CANARY_RESPONSE_PREFIX}:${challenge.left + challenge.right}`;
  const canaryInstructions = [
    `HEPTA_CODEX_MODEL_CANARY_CHALLENGE ${challenge.nonce}.`,
    `Add decimal integers ${challenge.left} and ${challenge.right}.`,
    `Return exactly one line using prefix ${MODEL_CANARY_RESPONSE_PREFIX}, then a colon, then the decimal sum.`,
    'Do not repeat the challenge, operands, or instructions. Do not use tools or read files.',
  ].join(' ');
  let workspace;
  try {
    const temporaryRoot = fs.realpathSync(os.tmpdir());
    workspace = fs.mkdtempSync(path.join(temporaryRoot, 'hepta-codex-model-canary-'));
    fs.chmodSync(workspace, 0o700);
  } catch (cause) {
    let effectiveCause = cause;
    if (workspace) {
      try {
        fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 2 });
      } catch (cleanupCause) {
        effectiveCause = cleanupCause;
      }
    }
    failCodexModelAvailabilityCanary(errorPrefix, { runtime, cause: effectiveCause });
  }
  let prompt = canaryInstructions;
  let failureExecutorBinding = null;
  let result;
  let failureInput = null;
  let sideEffectGateFailure = null;
  try {
    const managedRuntimeExpected = runtime.managedRuntimeEvidenceRequired === true;
    const environmentOverrides = { CODEX_HOME: runtime.codexHome };
    if (managedRuntimeExpected) {
      prompt = [
        buildOpenClawManagedExecutionMetadata({
          role: MODEL_CANARY_EXECUTION_ROLE,
          sandbox: 'read-only',
          workspaceMutationPolicy: null,
        }),
        canaryInstructions,
      ].join('\n');
      const failureSourceSnapshot = buildManagedWorkspaceSnapshot({
        workspace,
        maximumContextBytes: runtime.openClawManagedMaximumContextBytes,
        maximumFileCount: runtime.openClawManagedMaximumFileCount,
      });
      failureExecutorBinding = openClawManagedFailureExecutorBinding({
        capabilityReceipt: runtime,
        agentId: runtime.openClawManagedAgentId,
        executionInvocationId: `codex-exec:${crypto.randomUUID()}`,
        executionRole: MODEL_CANARY_EXECUTION_ROLE,
        principalId: MODEL_CANARY_PRINCIPAL_ID,
        principalRole: runtime.openClawManagedPrincipalRole,
        originalPromptHash: hashBytes(prompt),
        sandbox: 'read-only',
        workspace,
        sourceSnapshot: failureSourceSnapshot,
      });
      Object.assign(environmentOverrides, {
        HEPTA_AUTOMATION_ROLE: MODEL_CANARY_EXECUTION_ROLE,
        HEPTA_CODEX_OPENCLAW_MANAGED_TIMEOUT_MS:
          String(MODEL_CANARY_TIMEOUT_MS - PREFLIGHT_TIMEOUT_MS),
        ...failureExecutorBinding.environmentOverrides,
      });
    }
    const childEnv = restrictedChildEnvironment({
      source: environment,
      allowedKeys: ['CODEX_HOME'],
      overrides: environmentOverrides,
    });
    const args = [
      'exec',
      '--ephemeral',
      '--color', 'never',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--cd', workspace,
      '-',
    ];
    if (runtime.modelSelectionSource === 'explicit_override') {
      args.splice(1, 0, '--model', runtime.model);
    }
    if (beforeModelInvocation !== null) {
      try {
        if (typeof beforeModelInvocation !== 'function') {
          throw new Error(`${errorPrefix}_model_live_canary_side_effect_gate_invalid`);
        }
        const gateResult = beforeModelInvocation({
          action: 'codex_model_availability_canary',
        });
        if (gateResult && typeof gateResult.then === 'function') {
          throw new Error(`${errorPrefix}_model_live_canary_side_effect_gate_async_invalid`);
        }
      } catch (cause) {
        sideEffectGateFailure = cause;
      }
    }
    if (!sideEffectGateFailure) {
      try {
        result = spawnSyncImpl(runtime.codexBinary, args, {
          cwd: workspace,
          // Preserve the restricted environment while allowing Node's coverage
          // runner to attach its own child-process instrumentation metadata.
          env: { ...childEnv },
          input: prompt,
          encoding: 'utf8',
          timeout: MODEL_CANARY_TIMEOUT_MS,
          maxBuffer: 512 * 1024,
          windowsHide: true,
        });
      } catch (cause) {
        failureInput = { cause };
      }
    }
    const response = String(result?.stdout || '').trim();
    if (!sideEffectGateFailure && !failureInput
      && (result?.error || result?.status !== 0
      || result?.signal !== null || response !== expectedResponse)) {
      failureInput = { result };
    }
  } catch (cause) {
    failureInput = { cause };
  } finally {
    try {
      fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 2 });
    } catch (cause) {
      failureInput = { cause };
    }
  }
  if (sideEffectGateFailure) throw sideEffectGateFailure;
  if (failureInput) {
    failCodexModelAvailabilityCanary(errorPrefix, {
      runtime,
      failureExecutorBinding,
      ...failureInput,
    });
  }
  const response = String(result?.stdout || '').trim();
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
    openClawManagedAuthProfileIdentityHash:
      runtime.openClawManagedAuthProfileIdentityHash || null,
    openClawManagedGatewayRouteIdentityHash:
      runtime.openClawManagedGatewayRouteIdentityHash || null,
    openClawManagedAuthBindingMode:
      runtime.openClawManagedAuthBindingMode || null,
    openClawManagedAuthSourceIdentityHash:
      runtime.openClawManagedAuthSourceIdentityHash || null,
    openClawManagedRuntimeProvenanceHash:
      runtime.openClawManagedRuntimeProvenanceHash || null,
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
