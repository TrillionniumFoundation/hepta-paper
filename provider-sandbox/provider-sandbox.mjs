#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 4096;
const TEXT_FIELDS = Object.freeze([
  'environment',
  'provider',
  'accountId',
  'paperId',
  'dispatchAuthorizationHash',
  'packageHash',
]);
const REQUEST_FIELDS = Object.freeze([...TEXT_FIELDS, 'liveActionAllowed']);
const VERSION = 'provider-technical-sandbox-v1';

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
  return path.resolve(value);
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
    if (offset !== Number(before.size)
      || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].some((key) => before[key] !== after[key])) {
      fail('provider_sandbox_request_changed');
    }
    let request;
    try {
      request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, offset)));
    } catch {
      fail('provider_sandbox_request_malformed');
    }
    return request;
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
  if (keys.length !== REQUEST_FIELDS.length
    || keys.some((key, index) => key !== [...REQUEST_FIELDS].sort()[index])) {
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
  if (!/^sha256:[0-9a-f]{64}$/u.test(request.packageHash)) {
    fail('provider_sandbox_package_hash_invalid');
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(request.dispatchAuthorizationHash)) {
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
  if (path.dirname(input) !== path.dirname(output) || input === output) {
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

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    runTechnicalProviderSandbox();
  } catch (error) {
    process.stderr.write(`${error.code || 'provider_sandbox_failed'}\n`);
    process.exitCode = 1;
  }
}
