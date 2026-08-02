import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CONFIG_SECTION,
  CONFIG_VERSION,
  DEFAULT_MAXIMUM_CONTEXT_BYTES,
  DEFAULT_MAXIMUM_FILE_COUNT,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  SAFE_AGENT_ID,
  SAFE_AUTH_PROFILE_ID,
  SAFE_CONFIGURED_VALUE,
  SAFE_ROLE,
  SAFE_THINKING,
  assertSafeString,
  canonicalAbsoluteDirectory,
  canonicalAbsoluteRegularFile,
  runtimeError,
} from './codex-openclaw-managed-runtime-common.mjs';

function atomicPrivateWrite(destination, content) {
  const parent = path.dirname(destination);
  const temporary = path.join(
    parent,
    `.${path.basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0),
    PRIVATE_FILE_MODE,
  );
  try {
    fs.writeSync(descriptor, content, null, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, destination);
  fs.chmodSync(destination, PRIVATE_FILE_MODE);
  const parentDescriptor = fs.openSync(parent, fs.constants.O_RDONLY);
  try { fs.fsyncSync(parentDescriptor); } finally { fs.closeSync(parentDescriptor); }
}
function resolveOpenClawBinary(candidate, environment = process.env) {
  const requested = String(candidate || '').trim();
  const candidates = requested.includes(path.sep)
    ? [path.resolve(requested)]
    : String(environment.PATH || '').split(path.delimiter).filter(Boolean)
      .map((directory) => path.resolve(directory, requested));
  for (const executable of candidates) {
    try {
      const resolved = fs.realpathSync(executable);
      const stat = fs.statSync(resolved);
      fs.accessSync(resolved, fs.constants.X_OK);
      if (stat.isFile()) return resolved;
    } catch { /* continue searching PATH */ }
  }
  throw runtimeError('codex_openclaw_managed_openclaw_binary_invalid');
}

export function provisionCodexOpenClawManagedHome({
  home,
  agentId,
  authProfileId,
  model,
  openclawBinary,
  openclawConfigPath = process.env.OPENCLAW_CONFIG_PATH
    || path.join(os.homedir(), '.openclaw', 'openclaw.json'),
  openclawStateDir = process.env.OPENCLAW_STATE_DIR
    || path.dirname(openclawConfigPath),
  principalRole,
  thinking = 'adaptive',
  maximumContextBytes = DEFAULT_MAXIMUM_CONTEXT_BYTES,
  maximumFileCount = DEFAULT_MAXIMUM_FILE_COUNT,
  force = false,
} = {}) {
  const requestedHome = path.resolve(String(home || ''));
  if (!path.isAbsolute(String(home || '')) || requestedHome === path.parse(requestedHome).root) {
    throw runtimeError('codex_openclaw_managed_provision_home_invalid');
  }
  const safeAgent = assertSafeString(
    agentId,
    SAFE_AGENT_ID,
    'codex_openclaw_managed_agent_id_invalid',
  );
  const safeModel = assertSafeString(
    model,
    SAFE_CONFIGURED_VALUE,
    'codex_openclaw_managed_model_invalid',
  );
  const safeRole = assertSafeString(
    principalRole,
    SAFE_ROLE,
    'codex_openclaw_managed_principal_role_invalid',
  );
  const safeAuthProfileId = assertSafeString(
    authProfileId,
    SAFE_AUTH_PROFILE_ID,
    'codex_openclaw_managed_auth_profile_id_invalid',
  );
  const safeThinking = String(thinking || '').trim().toLowerCase();
  if (!SAFE_THINKING.has(safeThinking)) {
    throw runtimeError('codex_openclaw_managed_thinking_invalid');
  }
  const resolvedOpenClawBinary = resolveOpenClawBinary(openclawBinary);
  const resolvedOpenClawStateDir = canonicalAbsoluteDirectory(
    openclawStateDir,
    'codex_openclaw_managed_openclaw_state_dir_invalid',
  );
  const resolvedOpenClawConfigPath = canonicalAbsoluteRegularFile(
    openclawConfigPath,
    'codex_openclaw_managed_openclaw_config_path_invalid',
  );
  if (path.dirname(resolvedOpenClawConfigPath) !== resolvedOpenClawStateDir) {
    throw runtimeError('codex_openclaw_managed_openclaw_source_mismatch');
  }
  fs.mkdirSync(requestedHome, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  fs.chmodSync(requestedHome, PRIVATE_DIRECTORY_MODE);
  const configPath = path.join(requestedHome, 'config.toml');
  const content = [
    `model = ${JSON.stringify(safeModel)}`,
    '',
    `[${CONFIG_SECTION}]`,
    `version = ${CONFIG_VERSION}`,
    'managed_auth = true',
    `agent_id = ${JSON.stringify(safeAgent)}`,
    `principal_role = ${JSON.stringify(safeRole)}`,
    `auth_profile_id = ${JSON.stringify(safeAuthProfileId)}`,
    `openclaw_binary = ${JSON.stringify(resolvedOpenClawBinary)}`,
    `openclaw_config_path = ${JSON.stringify(resolvedOpenClawConfigPath)}`,
    `openclaw_state_dir = ${JSON.stringify(resolvedOpenClawStateDir)}`,
    `thinking = ${JSON.stringify(safeThinking)}`,
    `maximum_context_bytes = ${Number(maximumContextBytes)}`,
    `maximum_file_count = ${Number(maximumFileCount)}`,
    '',
  ].join('\n');
  if (fs.existsSync(configPath)) {
    const existing = fs.readFileSync(configPath, 'utf8');
    if (existing === content) {
      fs.chmodSync(configPath, PRIVATE_FILE_MODE);
      return Object.freeze({ home: requestedHome, configPath, changed: false });
    }
    if (!force) throw runtimeError('codex_openclaw_managed_config_exists');
  }
  atomicPrivateWrite(configPath, content);
  return Object.freeze({ home: requestedHome, configPath, changed: true });
}
