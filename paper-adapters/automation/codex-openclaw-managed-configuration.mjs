import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

import {
  CONFIG_SECTION,
  CONFIG_VERSION,
  DEFAULT_MAXIMUM_CONTEXT_BYTES,
  DEFAULT_MAXIMUM_FILE_COUNT,
  SAFE_AGENT_ID,
  SAFE_AUTH_PROFILE_ID,
  SAFE_CONFIGURED_VALUE,
  SAFE_ROLE,
  SAFE_THINKING,
  assertSafeString,
  canonicalAbsoluteDirectory,
  canonicalAbsoluteRegularFile,
  openClawManagedAuthProfileIdentityHash,
  openClawManagedAuthSourceIdentityHash,
  runtimeError,
  sha256,
} from './codex-openclaw-managed-runtime-common.mjs';

export const OPENCLAW_MODEL_RUNTIME_PACKAGE_EXPORTS = Object.freeze([
  Object.freeze({
    locationProperty: 'agentCommandRuntimePath',
    packageName: 'openclaw',
    packageExport: './plugin-sdk/agent-runtime',
    requiredExports: Object.freeze(['agentCommand', 'ensureAuthProfileStore']),
  }),
  Object.freeze({
    locationProperty: 'configRuntimePath',
    packageName: 'openclaw',
    packageExport: './plugin-sdk/config-runtime',
    requiredExports: Object.freeze(['loadConfig']),
  }),
  Object.freeze({
    locationProperty: 'agentHarnessRuntimePath',
    packageName: 'openclaw',
    packageExport: './plugin-sdk/agent-harness-runtime',
    requiredExports: Object.freeze([
      'resolveAgentDir',
      'disposeRegisteredAgentHarnesses',
    ]),
  }),
  Object.freeze({
    locationProperty: 'sessionStoreRuntimePath',
    packageName: 'openclaw',
    packageExport: './plugin-sdk/session-store-runtime',
    requiredExports: Object.freeze([
      'resolveStorePath',
      'resolveSessionFilePath',
      'upsertSessionEntry',
      'updateSessionStore',
      'getSessionEntry',
    ]),
  }),
]);

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RUNTIME_PROVENANCE_KEYS = Object.freeze([
  'kind',
  'moduleBindings',
  'openClawManagedRuntimeProvenanceHash',
  'packageManifestContentHash',
  'packageName',
  'packageRootPathHash',
  'version',
]);
const RUNTIME_MODULE_BINDING_KEYS = Object.freeze([
  'ordinal',
  'packageExport',
  'packageName',
  'requiredExports',
  'runtimeFileContentHash',
  'runtimeFilePathHash',
  'runtimeRole',
]);
const SINGLE_ATTEMPT_RETRY_POLICY_KEYS = Object.freeze([
  'base', 'max', 'min', 'perProfile',
]);

function exactKeys(value, expected) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort())
      === JSON.stringify([...expected].sort()));
}

export function verifyOpenClawManagedSingleAttemptPolicy(configuration, agentId) {
  const matches = Array.isArray(configuration?.agents?.list)
    ? configuration.agents.list.filter((entry) => entry?.id === agentId)
    : [];
  const policy = matches.length === 1 ? matches[0].runRetries : null;
  return exactKeys(policy, SINGLE_ATTEMPT_RETRY_POLICY_KEYS)
    && policy.base === 1
    && policy.perProfile === 0
    && policy.min === 1
    && policy.max === 1;
}

export function assertOpenClawManagedSingleAttemptPolicy({
  openclawConfigPath,
  agentId,
} = {}) {
  try {
    const requested = path.resolve(String(openclawConfigPath || ''));
    const linkStat = fs.lstatSync(requested);
    const stat = fs.statSync(requested);
    if (linkStat.isSymbolicLink() || !linkStat.isFile() || !stat.isFile()
      || fs.realpathSync(requested) !== requested
      || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new Error('openclaw config is not private and canonical');
    }
    const configuration = JSON.parse(fs.readFileSync(requested, 'utf8'));
    if (!verifyOpenClawManagedSingleAttemptPolicy(configuration, agentId)) {
      throw new Error('single-attempt policy is absent');
    }
    return true;
  } catch {
    throw runtimeError('codex_openclaw_managed_single_attempt_policy_required');
  }
}

function runtimeModuleBinding(descriptor, located, ordinal) {
  const runtimePath = located[descriptor.locationProperty];
  return Object.freeze({
    ordinal,
    packageName: descriptor.packageName,
    packageExport: descriptor.packageExport,
    runtimeRole: descriptor.locationProperty,
    requiredExports: Object.freeze([...descriptor.requiredExports]),
    runtimeFilePathHash: sha256(runtimePath),
    runtimeFileContentHash: sha256(fs.readFileSync(runtimePath)),
  });
}

export function verifyOpenClawModelRuntimeProvenance(provenance, {
  expectedProvenanceHash = null,
} = {}) {
  if (!exactKeys(provenance, RUNTIME_PROVENANCE_KEYS)
    || provenance.version !== 1
    || provenance.kind !== 'OpenClawManagedCodexRuntimeProvenance'
    || provenance.packageName !== 'openclaw'
    || !SHA256.test(String(provenance.packageRootPathHash || ''))
    || !SHA256.test(String(provenance.packageManifestContentHash || ''))
    || !Array.isArray(provenance.moduleBindings)
    || provenance.moduleBindings.length
      !== OPENCLAW_MODEL_RUNTIME_PACKAGE_EXPORTS.length) return false;
  for (const [index, descriptor]
    of OPENCLAW_MODEL_RUNTIME_PACKAGE_EXPORTS.entries()) {
    const binding = provenance.moduleBindings[index];
    if (!exactKeys(binding, RUNTIME_MODULE_BINDING_KEYS)
      || binding.ordinal !== index + 1
      || binding.packageName !== descriptor.packageName
      || binding.packageExport !== descriptor.packageExport
      || binding.runtimeRole !== descriptor.locationProperty
      || JSON.stringify(binding.requiredExports)
        !== JSON.stringify(descriptor.requiredExports)
      || !SHA256.test(String(binding.runtimeFilePathHash || ''))
      || !SHA256.test(String(binding.runtimeFileContentHash || ''))) return false;
  }
  const {
    openClawManagedRuntimeProvenanceHash: claimedHash,
    ...payload
  } = provenance;
  return claimedHash === hashRecord(
    'OpenClawManagedCodexRuntimeProvenance',
    payload,
  ) && (expectedProvenanceHash === null
    || (SHA256.test(String(expectedProvenanceHash || ''))
      && claimedHash === expectedProvenanceHash));
}

function runtimeProvenanceAtLocation(located) {
  const payload = {
    version: 1,
    kind: 'OpenClawManagedCodexRuntimeProvenance',
    packageName: 'openclaw',
    packageRootPathHash: sha256(located.packageRoot),
    packageManifestContentHash:
      sha256(fs.readFileSync(located.packageManifestPath)),
    moduleBindings: Object.freeze(
      OPENCLAW_MODEL_RUNTIME_PACKAGE_EXPORTS.map(
        (descriptor, index) => runtimeModuleBinding(
          descriptor,
          located,
          index + 1,
        ),
      ),
    ),
  };
  return Object.freeze({
    ...payload,
    openClawManagedRuntimeProvenanceHash: hashRecord(
      'OpenClawManagedCodexRuntimeProvenance',
      payload,
    ),
  });
}

function resolveOpenClawPackageRuntimePaths({ manifest, packagePath, packageRoot }) {
  const packageRequire = createRequire(packagePath);
  return Object.fromEntries(OPENCLAW_MODEL_RUNTIME_PACKAGE_EXPORTS.map((descriptor) => {
    const declaration = manifest.exports?.[descriptor.packageExport];
    const declaredTarget = typeof declaration === 'string'
      ? declaration
      : declaration?.default;
    if (typeof declaredTarget !== 'string' || !declaredTarget.startsWith('./')) {
      throw new Error('OpenClaw runtime package export is unavailable');
    }
    const packageSpecifier = `${descriptor.packageName}/${descriptor.packageExport.slice(2)}`;
    const resolved = packageRequire.resolve(packageSpecifier);
    const expected = path.resolve(packageRoot, declaredTarget);
    const canonical = fs.realpathSync(resolved);
    const relative = path.relative(packageRoot, canonical);
    const linkStat = fs.lstatSync(resolved);
    if (path.resolve(resolved) !== expected
      || canonical !== expected
      || !relative
      || relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
      || !linkStat.isFile()
      || linkStat.isSymbolicLink()) {
      throw new Error('OpenClaw runtime package export is invalid');
    }
    return [descriptor.locationProperty, canonical];
  }));
}

function configuredHome(environment = process.env) {
  const candidate = String(environment.CODEX_HOME || '').trim();
  if (!candidate || !path.isAbsolute(candidate)) {
    throw runtimeError('codex_openclaw_managed_home_required');
  }
  let resolved;
  let stat;
  try {
    resolved = fs.realpathSync(candidate);
    stat = fs.statSync(resolved);
  } catch {
    throw runtimeError('codex_openclaw_managed_home_invalid');
  }
  if (resolved !== path.resolve(candidate) || !stat.isDirectory()) {
    throw runtimeError('codex_openclaw_managed_home_invalid');
  }
  return resolved;
}

function unquoteTomlValue(raw) {
  const value = String(raw || '').trim();
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch {
      throw runtimeError('codex_openclaw_managed_config_invalid');
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

function parseManagedConfig(source) {
  const topLevel = {};
  const section = {};
  let current = topLevel;
  for (const rawLine of String(source || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sectionMatch) {
      current = sectionMatch[1] === CONFIG_SECTION ? section : {};
      continue;
    }
    const assignment = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/);
    if (!assignment) throw runtimeError('codex_openclaw_managed_config_invalid');
    current[assignment[1]] = unquoteTomlValue(assignment[2]);
  }
  return { topLevel, section };
}

function regularPrivateConfig(configPath) {
  let linkStat;
  let stat;
  try {
    linkStat = fs.lstatSync(configPath);
    stat = fs.statSync(configPath);
  } catch {
    throw runtimeError('codex_openclaw_managed_config_required');
  }
  if (!linkStat.isFile() || linkStat.isSymbolicLink() || !stat.isFile()
    || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw runtimeError('codex_openclaw_managed_config_invalid');
  }
}

export function readCodexOpenClawManagedConfiguration({
  environment = process.env,
} = {}) {
  const home = configuredHome(environment);
  const configPath = path.join(home, 'config.toml');
  regularPrivateConfig(configPath);
  const configBytes = fs.readFileSync(configPath);
  const { topLevel, section } = parseManagedConfig(configBytes.toString('utf8'));
  const model = assertSafeString(
    topLevel.model,
    SAFE_CONFIGURED_VALUE,
    'codex_openclaw_managed_model_invalid',
  );
  const agentId = assertSafeString(
    section.agent_id,
    SAFE_AGENT_ID,
    'codex_openclaw_managed_agent_id_invalid',
  );
  const principalRole = assertSafeString(
    section.principal_role,
    SAFE_ROLE,
    'codex_openclaw_managed_principal_role_invalid',
  );
  const authProfileId = assertSafeString(
    section.auth_profile_id,
    SAFE_AUTH_PROFILE_ID,
    'codex_openclaw_managed_auth_profile_id_invalid',
  );
  const thinking = String(section.thinking || 'adaptive').trim().toLowerCase();
  if (!SAFE_THINKING.has(thinking)) {
    throw runtimeError('codex_openclaw_managed_thinking_invalid');
  }
  if (Number(section.version) !== CONFIG_VERSION || section.managed_auth !== true) {
    throw runtimeError('codex_openclaw_managed_config_version_invalid');
  }
  const openclawStateDir = canonicalAbsoluteDirectory(
    section.openclaw_state_dir,
    'codex_openclaw_managed_openclaw_state_dir_invalid',
  );
  const openclawConfigPath = canonicalAbsoluteRegularFile(
    section.openclaw_config_path,
    'codex_openclaw_managed_openclaw_config_path_invalid',
  );
  if (path.dirname(openclawConfigPath) !== openclawStateDir) {
    throw runtimeError('codex_openclaw_managed_openclaw_source_mismatch');
  }
  assertOpenClawManagedSingleAttemptPolicy({ openclawConfigPath, agentId });
  const requestedBinary = String(section.openclaw_binary || '').trim();
  if (!requestedBinary || !path.isAbsolute(requestedBinary)) {
    throw runtimeError('codex_openclaw_managed_openclaw_binary_invalid');
  }
  let openclawBinary;
  let binaryStat;
  try {
    openclawBinary = fs.realpathSync(requestedBinary);
    binaryStat = fs.statSync(openclawBinary);
    fs.accessSync(openclawBinary, fs.constants.X_OK);
  } catch {
    throw runtimeError('codex_openclaw_managed_openclaw_binary_invalid');
  }
  if (!binaryStat.isFile()) {
    throw runtimeError('codex_openclaw_managed_openclaw_binary_invalid');
  }
  const maximumContextBytes = Number(
    section.maximum_context_bytes || DEFAULT_MAXIMUM_CONTEXT_BYTES,
  );
  const maximumFileCount = Number(
    section.maximum_file_count || DEFAULT_MAXIMUM_FILE_COUNT,
  );
  if (!Number.isInteger(maximumContextBytes)
    || maximumContextBytes < 4096
    || maximumContextBytes > 4 * 1024 * 1024
    || !Number.isInteger(maximumFileCount)
    || maximumFileCount < 1
    || maximumFileCount > 256) {
    throw runtimeError('codex_openclaw_managed_context_limits_invalid');
  }
  return Object.freeze({
    version: CONFIG_VERSION,
    home,
    configPath,
    model,
    agentId,
    principalRole,
    authProfileId,
    openClawManagedAuthProfileIdentityHash:
      openClawManagedAuthProfileIdentityHash(authProfileId),
    openClawManagedAuthSourceIdentityHash:
      openClawManagedAuthSourceIdentityHash({
        agentId,
        openclawConfigPath,
        openclawStateDir,
      }),
    thinking,
    openclawBinary,
    openclawConfigPath,
    openclawStateDir,
    maximumContextBytes,
    maximumFileCount,
    configurationHash: sha256(configBytes),
  });
}

export function openClawModelRuntimeLocation(openclawBinary) {
  let current = path.dirname(openclawBinary);
  for (let depth = 0; depth < 8; depth += 1) {
    const packagePath = path.join(current, 'package.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      if (manifest?.name === 'openclaw') {
        const runtimePaths = resolveOpenClawPackageRuntimePaths({
          manifest,
          packagePath,
          packageRoot: current,
        });
        return Object.freeze({
          packageRoot: current,
          packageManifestPath: packagePath,
          ...runtimePaths,
        });
      }
    } catch { /* continue toward the package root */ }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw runtimeError('codex_openclaw_managed_model_runtime_unavailable');
}

export function openClawModelRuntimeProvenance(openclawBinary) {
  let provenance;
  try {
    provenance = runtimeProvenanceAtLocation(
      openClawModelRuntimeLocation(openclawBinary),
    );
  } catch (error) {
    if (error?.code === 'codex_openclaw_managed_model_runtime_unavailable') {
      throw error;
    }
    throw runtimeError('codex_openclaw_managed_model_runtime_provenance_invalid');
  }
  if (!verifyOpenClawModelRuntimeProvenance(provenance)) {
    throw runtimeError('codex_openclaw_managed_model_runtime_provenance_invalid');
  }
  return provenance;
}

export async function loadOpenClawModelRuntime(configuration) {
  const requestedConfigPath = process.env.OPENCLAW_CONFIG_PATH?.trim();
  const requestedStateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if ((requestedConfigPath && path.resolve(requestedConfigPath)
      !== configuration.openclawConfigPath)
    || (requestedStateDir && path.resolve(requestedStateDir)
      !== configuration.openclawStateDir)) {
    throw runtimeError('codex_openclaw_managed_openclaw_source_conflict');
  }
  process.env.OPENCLAW_CONFIG_PATH = configuration.openclawConfigPath;
  process.env.OPENCLAW_STATE_DIR = configuration.openclawStateDir;
  // OpenClaw's sessions.json cache and writer queue are process-local. This
  // executable coordinates managed writers across processes below, so every
  // lock holder must load the store from disk rather than reusing a cache
  // populated before it acquired the lock.
  process.env.OPENCLAW_SESSION_CACHE_TTL_MS = '0';
  const located = openClawModelRuntimeLocation(configuration.openclawBinary);
  const runtimeProvenanceBefore = runtimeProvenanceAtLocation(located);
  if (!verifyOpenClawModelRuntimeProvenance(runtimeProvenanceBefore)) {
    throw runtimeError('codex_openclaw_managed_model_runtime_provenance_invalid');
  }
  const [
    agentCommandRuntime,
    configRuntime,
    agentHarnessRuntime,
    sessionStoreRuntime,
  ] = await Promise.all([
    import(pathToFileURL(located.agentCommandRuntimePath).href),
    import(pathToFileURL(located.configRuntimePath).href),
    import(pathToFileURL(located.agentHarnessRuntimePath).href),
    import(pathToFileURL(located.sessionStoreRuntimePath).href),
  ]);
  const runtimeModules = {
    agentCommandRuntimePath: agentCommandRuntime,
    configRuntimePath: configRuntime,
    agentHarnessRuntimePath: agentHarnessRuntime,
    sessionStoreRuntimePath: sessionStoreRuntime,
  };
  if (OPENCLAW_MODEL_RUNTIME_PACKAGE_EXPORTS.some((descriptor) => (
    descriptor.requiredExports.some((name) => (
      typeof runtimeModules[descriptor.locationProperty]?.[name] !== 'function'
    ))
  ))) {
    throw runtimeError('codex_openclaw_managed_model_runtime_invalid');
  }
  let runtimeProvenance;
  try {
    runtimeProvenance = runtimeProvenanceAtLocation(located);
  } catch {
    throw runtimeError('codex_openclaw_managed_model_runtime_changed_during_load');
  }
  if (!verifyOpenClawModelRuntimeProvenance(runtimeProvenance, {
    expectedProvenanceHash:
      runtimeProvenanceBefore.openClawManagedRuntimeProvenanceHash,
  })) {
    throw runtimeError('codex_openclaw_managed_model_runtime_changed_during_load');
  }
  let cfg;
  let agentDir;
  let sessionStorePath;
  try {
    cfg = configRuntime.loadConfig();
    if (!verifyOpenClawManagedSingleAttemptPolicy(cfg, configuration.agentId)) {
      throw new Error('single-attempt policy changed during runtime load');
    }
    const requestedAgentDir = agentHarnessRuntime.resolveAgentDir(
      cfg,
      configuration.agentId,
    );
    agentDir = fs.realpathSync(requestedAgentDir);
    const expectedAgentDir = path.join(
      configuration.openclawStateDir,
      'agents',
      configuration.agentId,
      'agent',
    );
    if (agentDir !== path.resolve(requestedAgentDir)
      || agentDir !== expectedAgentDir
      || !fs.statSync(agentDir).isDirectory()) {
      throw new Error('agent directory is not canonical');
    }
    sessionStorePath = path.resolve(sessionStoreRuntime.resolveStorePath(
      undefined,
      { agentId: configuration.agentId },
    ));
    const expectedSessionsDir = path.join(
      configuration.openclawStateDir,
      'agents',
      configuration.agentId,
      'sessions',
    );
    const expectedSessionStorePath = path.join(
      expectedSessionsDir,
      'sessions.json',
    );
    if (sessionStorePath !== expectedSessionStorePath
      || fs.realpathSync(expectedSessionsDir) !== expectedSessionsDir
      || !fs.statSync(expectedSessionsDir).isDirectory()
      || (fs.existsSync(sessionStorePath)
        && (fs.realpathSync(sessionStorePath) !== expectedSessionStorePath
          || !fs.statSync(sessionStorePath).isFile()))) {
      throw new Error('session store is not canonical');
    }
  } catch {
    throw runtimeError('codex_openclaw_managed_agent_runtime_invalid');
  }
  const silentRuntime = Object.freeze({
    log() {},
    error() {},
    exit(code) {
      if (Number(code) !== 0) {
        throw runtimeError('codex_openclaw_managed_agent_command_failed');
      }
    },
  });
  return Object.freeze({
    cfg,
    agentDir,
    sessionStorePath,
    sessionsDir: path.dirname(sessionStorePath),
    internalRunsDir: path.join(
      configuration.openclawStateDir,
      'internal-agent-runs',
    ),
    agentCommand: agentCommandRuntime.agentCommand,
    ensureAuthProfileStore: agentCommandRuntime.ensureAuthProfileStore,
    disposeRegisteredAgentHarnesses:
      agentHarnessRuntime.disposeRegisteredAgentHarnesses,
    getSessionEntry: sessionStoreRuntime.getSessionEntry,
    resolveSessionFilePath: sessionStoreRuntime.resolveSessionFilePath,
    upsertSessionEntry: sessionStoreRuntime.upsertSessionEntry,
    updateSessionStore: sessionStoreRuntime.updateSessionStore,
    silentRuntime,
    packageRoot: located.packageRoot,
    runtimeProvenance,
  });
}
