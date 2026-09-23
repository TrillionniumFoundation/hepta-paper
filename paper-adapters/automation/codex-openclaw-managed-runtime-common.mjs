import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  projectOpenClawManagedFailureCode,
} from './codex-openclaw-managed-failure-code.mjs';

export const CONFIG_SECTION = 'hepta_openclaw_managed';
export const CONFIG_VERSION = 4;
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const MAXIMUM_OPTIONAL_SNAPSHOT_FILE_BYTES = 512 * 1024;
export const DEFAULT_MAXIMUM_CONTEXT_BYTES = 900000;
export const DEFAULT_MAXIMUM_FILE_COUNT = 96;
export const MAXIMUM_MODEL_ATTEMPTS = 3;
export const OPENCLAW_MANAGED_EXECUTION_METADATA_PREFIX =
  'HEPTA_CODEX_EXECUTION_METADATA_V1:';
export const OPENCLAW_MANAGED_EXECUTION_EVIDENCE_FIELD =
  'heptaOpenClawManagedExecution';
export const SAFE_CONFIGURED_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/;
export const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const SAFE_AUTH_PROFILE_ID = /^openai:[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,247}$/;
export const SAFE_ROLE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const SAFE_THINKING = new Set([
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max',
]);
const BASE_ENVIRONMENT_KEYS = Object.freeze([
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'OPENCLAW_HOME',
  'OPENCLAW_CONFIG_PATH',
  'OPENCLAW_STATE_DIR',
  'OPENCLAW_PROFILE',
  'OPENCLAW_GATEWAY_URL',
]);

export function runtimeError(code, { retryable = false } = {}) {
  const safeCode = projectOpenClawManagedFailureCode(code);
  const error = new Error(safeCode);
  error.code = safeCode;
  error.retryable = retryable;
  return error;
}
export function assertSafeString(value, pattern, code) {
  const normalized = String(value || '').trim();
  if (!pattern.test(normalized)) throw runtimeError(code);
  return normalized;
}

export function safeEnvironment(source = process.env) {
  return Object.fromEntries(BASE_ENVIRONMENT_KEYS
    .filter((key) => source[key] !== undefined)
    .map((key) => [key, String(source[key])]));
}

export function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function openClawManagedAuthProfileIdentityHash(authProfileId) {
  return hashRecord('OpenClawManagedAuthProfileIdentity', {
    provider: 'openai',
    authProfileId,
  });
}

export function openClawManagedAuthSourceIdentityHash({
  agentId,
  openclawConfigPath,
  openclawStateDir,
} = {}) {
  return hashRecord('OpenClawManagedAuthSourceIdentity', {
    agentId,
    openclawConfigPath,
    openclawStateDir,
  });
}

export function canonicalAbsoluteDirectory(candidate, code) {
  const requested = String(candidate || '').trim();
  if (!requested || !path.isAbsolute(requested)) throw runtimeError(code);
  let resolved;
  let stat;
  try {
    resolved = fs.realpathSync(requested);
    stat = fs.statSync(resolved);
  } catch {
    throw runtimeError(code);
  }
  if (resolved !== path.resolve(requested) || !stat.isDirectory()
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw runtimeError(code);
  }
  return resolved;
}

export function canonicalAbsoluteRegularFile(candidate, code) {
  const requested = String(candidate || '').trim();
  if (!requested || !path.isAbsolute(requested)) throw runtimeError(code);
  let resolved;
  let linkStat;
  let stat;
  try {
    resolved = fs.realpathSync(requested);
    linkStat = fs.lstatSync(requested);
    stat = fs.statSync(resolved);
  } catch {
    throw runtimeError(code);
  }
  if (resolved !== path.resolve(requested) || linkStat.isSymbolicLink()
    || !linkStat.isFile() || !stat.isFile()
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw runtimeError(code);
  }
  return resolved;
}
export function modelAttemptTraceHash(attempts) {
  return hashRecord(
    'OpenClawManagedCodexAppServerAttemptTrace',
    { attempts },
  );
}
