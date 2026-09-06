#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_TOKENS = 8192;
const MAX_DEPTH = 32;
const TEXT_FIELDS = Object.freeze([
  'environment',
  'provider',
  'accountId',
  'paperId',
  'dispatchAuthorizationHash',
  'packageHash',
]);
const REQUEST_FIELDS = Object.freeze([...TEXT_FIELDS, 'liveActionAllowed']);
const SORTED_REQUEST_FIELDS = Object.freeze([...REQUEST_FIELDS].sort());
const VERSION = 'provider-technical-sandbox-v1';
const OPAQUE_IDENTITY = /^sha256:[A-Za-z0-9._:-]{8,2041}$/u;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('provider_sandbox_nonfinite_value');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  fail('provider_sandbox_non_json_value');
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function validatePath(value, label) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_PATH_BYTES || !path.isAbsolute(value)) {
    fail(`provider_sandbox_${label}_path_invalid`);
  }
  const resolved = path.resolve(value);
  if (resolved !== value) fail(`provider_sandbox_${label}_path_invalid`);
  return resolved;
}

function parseStrictRequest(bytes) {
  let source;
  let value;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(source);
  } catch {
    fail('provider_sandbox_request_malformed');
  }
  const frames = [];
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/gu;
  let count = 0;
  for (const match of source.matchAll(tokens)) {
    const token = match[0];
    count += 1;
    if (count > MAX_TOKENS) fail('provider_sandbox_request_structure_limit');
    if (token === '{') {
      frames.push({ kind: 'object', keys: new Set(), keyExpected: true });
      if (frames.length > MAX_DEPTH) fail('provider_sandbox_request_structure_limit');
    } else if (token === '[') {
      frames.push({ kind: 'array' });
      if (frames.length > MAX_DEPTH) fail('provider_sandbox_request_structure_limit');
    } else if (token === '}' || token === ']') {
      frames.pop();
    } else {
      const frame = frames.at(-1);
      if (frame?.kind === 'object' && token === ',') frame.keyExpected = true;
      else if (frame?.kind === 'object' && token === ':') frame.keyExpected = false;
      else if (frame?.kind === 'object' && frame.keyExpected && token.startsWith('"')) {
        const key = JSON.parse(token);
        if (frame.keys.has(key)) fail('provider_sandbox_request_duplicate_key');
        frame.keys.add(key);
      }
    }
  }
  return value;
}

function readRequest(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_REQUEST_BYTES)) {
      fail('provider_sandbox_request_unsafe');
    }
    const raw = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < raw.length) {
      const count = fs.readSync(descriptor, raw, offset, raw.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(file, { bigint: true });
    if (offset !== Number(before.size)
      || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].some((key) => before[key] !== after[key]
        || before[key] !== named[key])) {
      fail('provider_sandbox_request_changed');
    }
    return parseStrictRequest(raw.subarray(0, offset));
  } catch (error) {
    if (String(error.code).startsWith('provider_sandbox_')) throw error;
    fail(error.code === 'ENOENT'
      ? 'provider_sandbox_request_missing'
      : 'provider_sandbox_request_unsafe');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.getPrototypeOf(request) !== Object.prototype) {
    fail('provider_sandbox_request_invalid');
  }
  const keys = Object.keys(request).sort();
  if (keys.length !== SORTED_REQUEST_FIELDS.length
    || keys.some((key, index) => key !== SORTED_REQUEST_FIELDS[index])) {
    fail('provider_sandbox_request_invalid');
  }
  if (request.environment !== 'provider_sandbox' || request.liveActionAllowed !== false) {
    fail('provider_sandbox_live_action_forbidden');
  }
  for (const key of TEXT_FIELDS) {
    if (typeof request[key] !== 'string' || request[key].length === 0
      || Buffer.byteLength(request[key]) > 2048 || request[key].includes('\0')) {
      fail(`provider_sandbox_request_field_invalid:${key}`);
    }
  }
  if (!OPAQUE_IDENTITY.test(request.packageHash)) {
    fail('provider_sandbox_package_hash_invalid');
  }
  if (!OPAQUE_IDENTITY.test(request.dispatchAuthorizationHash)) {
    fail('provider_sandbox_dispatch_hash_invalid');
  }
  return request;
}

function responseFor(request) {
  const requestHash = sha256(request);
  const receiptBody = {
    version: 1,
    kind: 'ProviderTechnicalSandboxReceiptV1',
    status: 'technical_sandbox_observation_only',
    companionVersion: VERSION,
    requestHash,
    dispatchAuthorizationHash: request.dispatchAuthorizationHash,
    packageHash: request.packageHash,
    sandbox: true,
    deterministic: true,
    credentialsObserved: false,
    networkActionPerformed: false,
    externalActionPerformed: false,
    productionEligible: false,
    externalAuthorityClaimed: false,
  };
  const providerReceipt = {
    ...receiptBody,
    providerReceiptHash: sha256(receiptBody),
  };
  const body = {
    version: 1,
    kind: 'ProviderTechnicalSandboxResponseV1',
    status: 'technical_sandbox_response_incomplete_for_external_acceptance',
    companionVersion: VERSION,
    requestHash,
    dispatchAuthorizationHash: request.dispatchAuthorizationHash,
    packageHash: request.packageHash,
    providerReceipt,
    externalActionPerformed: false,
    productionEligible: false,
    externalAuthorityClaimed: false,
  };
  return { ...body, responseHash: sha256(body) };
}

function writeExclusive(file, response) {
  let descriptor;
  try {
    descriptor = fs.openSync(file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600);
    const bytes = Buffer.from(`${canonical(response)}\n`, 'utf8');
    if (bytes.length > MAX_REQUEST_BYTES) fail('provider_sandbox_response_too_large');
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (String(error.code).startsWith('provider_sandbox_')) throw error;
    fail('provider_sandbox_response_write_failed');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function runTechnicalProviderSandbox(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.length !== 2) fail('provider_sandbox_usage');
  const input = validatePath(argv[0], 'request');
  const output = validatePath(argv[1], 'response');
  const directory = path.dirname(input);
  let canonicalDirectory;
  try {
    canonicalDirectory = fs.realpathSync(directory);
  } catch {
    fail('provider_sandbox_path_boundary_invalid');
  }
  if (canonicalDirectory !== directory || path.dirname(output) !== directory || input === output) {
    fail('provider_sandbox_path_boundary_invalid');
  }
  const request = validateRequest(readRequest(input));
  writeExclusive(output, responseFor(request));
  return Object.freeze({
    status: 'provider_technical_sandbox_completed',
    externalActionPerformed: false,
    productionAuthorized: false,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    runTechnicalProviderSandbox();
  } catch (error) {
    process.stderr.write(`${error.code || 'provider_sandbox_failed'}\n`);
    process.exitCode = 1;
  }
}
