import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createProviderSandboxRequestFile } from './provider-sandbox-request-repository.mjs';

const MAX_BYTES = 64 * 1024;
const REQUEST_FIELDS = Object.freeze(['environment', 'liveActionAllowed', 'provider',
  'accountId', 'paperId', 'dispatchAuthorizationHash', 'packageHash']);
const identityFields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'];

function fail(code) {
  throw Object.assign(new Error(`provider_sandbox_${code}`), { code: `provider_sandbox_${code}` });
}

function readCaptured(file, maximum, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximum)) fail(`${label}_unsafe`);
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(file, { bigint: true });
    if (length !== Number(before.size) || identityFields.some((key) => before[key] !== after[key]
      || before[key] !== named[key])) fail(`${label}_changed`);
    return bytes.subarray(0, length);
  } catch (error) {
    if (String(error.code).startsWith('provider_sandbox_')) throw error;
    fail(`${label}_${error.code === 'ENOENT' ? 'missing' : 'unreadable'}`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function inspectProviderSandboxCompanion(entry) {
  if (typeof entry !== 'string' || entry.length > 4096 || !path.isAbsolute(entry)) fail('companion_path_invalid');
  try {
    const stat = fs.lstatSync(entry);
    if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(entry) !== entry) fail('companion_unsafe');
  } catch (error) {
    if (String(error.code).startsWith('provider_sandbox_')) throw error;
    fail(`companion_${error.code === 'ENOENT' ? 'missing' : 'unreadable'}`);
  }
  const bytes = readCaptured(entry, 1024 * 1024, 'companion');
  return Object.freeze({ path: entry, sha256: createHash('sha256').update(bytes).digest('hex') });
}

function requestBytes(request) {
  if (!request || typeof request !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(request))) fail('request_invalid');
  const descriptors = Object.getOwnPropertyDescriptors(request);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== REQUEST_FIELDS.length || keys.some((key) => !REQUEST_FIELDS.includes(key))) fail('request_invalid');
  const values = {};
  for (const key of REQUEST_FIELDS) {
    const property = descriptors[key];
    if (!property || !Object.hasOwn(property, 'value') || !property.enumerable) fail('request_invalid');
    values[key] = property.value;
  }
  if (values.environment !== 'provider_sandbox' || values.liveActionAllowed !== false) fail('live_action_forbidden');
  for (const key of REQUEST_FIELDS.filter((name) => name !== 'liveActionAllowed')) {
    if (typeof values[key] !== 'string' || !values[key].length || values[key].length > 2048
      || values[key].includes('\0')) fail('request_invalid');
  }
  return Buffer.from(JSON.stringify(values), 'utf8');
}

function parseResponse(bytes) {
  let source;
  let response;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    response = JSON.parse(source);
  } catch { fail('response_malformed'); }
  // JSON.parse establishes grammar. Scan the same bounded bytes to reject
  // duplicate decoded keys and enforce nesting/token limits before consumption.
  const frames = [];
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g;
  let count = 0;
  for (const [token] of source.matchAll(tokens)) {
    if (++count > 8192) fail('response_structure_limit');
    if (token === '{' || token === '[') {
      frames.push(token === '{' ? { keys: new Set(), keyExpected: true } : null);
      if (frames.length > 32) fail('response_structure_limit');
    } else if (token === '}' || token === ']') frames.pop();
    else {
      const frame = frames.at(-1);
      if (frame && token === ',') frame.keyExpected = true;
      else if (frame && token === ':') frame.keyExpected = false;
      else if (frame?.keyExpected && token.startsWith('"')) {
        const key = JSON.parse(token);
        if (frame.keys.has(key)) fail('response_duplicate_key');
        frame.keys.add(key);
      } else if (/^-?[0-9]/.test(token) && !Number.isFinite(Number(token))) fail('response_nonfinite');
    }
  }
  if (!response || typeof response !== 'object' || Array.isArray(response)) fail('response_malformed');
  return response;
}

// This bounds a direct diagnostic child, not descendants, kernel isolation,
// network access, disk writes, companion authenticity or external authority.
export function runProviderSandboxProcess({ companionEntry, runtimeRoot, request, timeoutMs = 10000 }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) fail('timeout_invalid');
  const bytes = requestBytes(request);
  const companion = inspectProviderSandboxCompanion(companionEntry);
  const { input, output, rootIdentity } = createProviderSandboxRequestFile({ runtimeRoot, bytes });
  const result = spawnSync(process.execPath, [companionEntry, input, output], {
    cwd: runtimeRoot, encoding: 'utf8', shell: false, timeout: timeoutMs,
    killSignal: 'SIGKILL', maxBuffer: MAX_BYTES,
    env: { PATH: '/usr/bin:/bin', HOME: runtimeRoot, TMPDIR: runtimeRoot,
      LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
  });
  // Raw child stdout/stderr and OS error objects never enter diagnostic errors.
  if (result.error?.code === 'ETIMEDOUT') fail('companion_timeout');
  if (result.error || result.signal || result.status !== 0) fail('companion_failed');
  let currentRoot;
  let canonicalRoot;
  try {
    currentRoot = fs.lstatSync(runtimeRoot, { bigint: true });
    canonicalRoot = fs.realpathSync(runtimeRoot);
  }
  catch { fail('runtime_changed'); }
  if (currentRoot.dev !== rootIdentity.dev || currentRoot.ino !== rootIdentity.ino
    || !currentRoot.isDirectory() || canonicalRoot !== runtimeRoot) fail('runtime_changed');
  if (inspectProviderSandboxCompanion(companionEntry).sha256 !== companion.sha256) fail('companion_changed');
  if (!readCaptured(input, MAX_BYTES, 'request').equals(bytes)) fail('request_changed');
  return parseResponse(readCaptured(output, MAX_BYTES, 'response'));
}

export function assertProviderSandboxResponseClaims(response, dispatchAuthorizationHash) {
  if (!response || response.externalActionPerformed !== false
    || response.providerReceipt?.sandbox !== true
    || typeof dispatchAuthorizationHash !== 'string'
    || response.dispatchAuthorizationHash !== dispatchAuthorizationHash) fail('response_claims_invalid');
  // Claims are necessary consistency checks, not independently verified facts.
  // The delivery/evidence verifier must still reject incomplete or untrusted receipts.
}
