#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const validator = path.join(root, 'docs/rust/tools/strict_json_schema.py');
const requestSchema = path.join(
  root,
  'docs/provider-sandbox/schemas/provider-technical-sandbox-request-v1.schema.json',
);
const responseSchema = path.join(
  root,
  'docs/provider-sandbox/schemas/provider-technical-sandbox-response-v1.schema.json',
);
const maximumBytes = 64 * 1024;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function requiredAbsoluteEnvironment(name) {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value) || path.resolve(value) !== value) {
    fail(`provider_vector_${name.toLowerCase()}_invalid`);
  }
  return value;
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function readBoundedRegular(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(maximumBytes)) {
    fail('provider_vector_file_unsafe');
  }
  const before = fs.statSync(file, { bigint: true });
  const bytes = fs.readFileSync(file);
  const after = fs.statSync(file, { bigint: true });
  for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink']) {
    if (before[key] !== after[key] || before[key] !== stat[key]) {
      fail('provider_vector_file_changed');
    }
  }
  return bytes;
}

function readJson(file) {
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readBoundedRegular(file)));
  } catch (error) {
    if (String(error.code).startsWith('provider_vector_')) throw error;
    fail('provider_vector_json_invalid');
  }
  return value;
}

function validateSchema(schema, instance, expectedStatus) {
  const result = spawnSync(
    'python3',
    [validator, '--schema', schema, '--instance', instance],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        PYTHONDONTWRITEBYTECODE: '1',
      },
    },
  );
  if (result.error || result.signal || result.status !== expectedStatus) {
    fail('provider_vector_schema_disposition_invalid');
  }
}

function minimalEnvironment(runtimeDirectory) {
  return {
    PATH: '/usr/bin:/bin',
    HOME: runtimeDirectory,
    TMPDIR: runtimeDirectory,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  };
}

function runCompanion(companion, requestPath, responsePath, runtimeDirectory) {
  return spawnSync(process.execPath, [companion, requestPath, responsePath], {
    cwd: runtimeDirectory,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: maximumBytes,
    env: minimalEnvironment(runtimeDirectory),
    shell: false,
    windowsHide: true,
  });
}

function writeRequest(file, request) {
  const bytes = Buffer.from(`${JSON.stringify(request)}\n`, 'utf8');
  if (bytes.length > maximumBytes) fail('provider_vector_request_too_large');
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
}

function assertSuccessfulResponse(response, expected) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    fail('provider_vector_response_invalid');
  }
  const receipt = response.providerReceipt;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    fail('provider_vector_receipt_invalid');
  }
  const observed = {
    exitCode: 0,
    responseKind: response.kind,
    responseStatus: response.status,
    companionVersion: response.companionVersion,
    sandbox: receipt.sandbox,
    credentialsObserved: receipt.credentialsObserved,
    networkActionPerformed: receipt.networkActionPerformed,
    externalActionPerformed: response.externalActionPerformed,
    productionEligible: response.productionEligible,
    externalAuthorityClaimed: response.externalAuthorityClaimed,
  };
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    fail('provider_vector_response_disposition_mismatch');
  }
  for (const value of [
    receipt.externalActionPerformed,
    receipt.productionEligible,
    receipt.externalAuthorityClaimed,
  ]) {
    if (value !== false) fail('provider_vector_receipt_authority_escalation');
  }
}

function positiveAttempt(companion, vector, runtimeRoot, label) {
  const directory = path.join(runtimeRoot, `${vector.vectorId}-${label}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  const requestPath = path.join(directory, 'request.json');
  const responsePath = path.join(directory, 'response.json');
  writeRequest(requestPath, vector.request);
  validateSchema(requestSchema, requestPath, 0);
  const result = runCompanion(companion, requestPath, responsePath, directory);
  if (result.error || result.signal || result.status !== vector.expected.exitCode) {
    fail('provider_vector_positive_execution_failed');
  }
  if (result.stdout !== '' || result.stderr !== '') {
    fail('provider_vector_positive_diagnostics_unexpected');
  }
  validateSchema(responseSchema, responsePath, 0);
  const responseBytes = readBoundedRegular(responsePath);
  assertSuccessfulResponse(readJson(responsePath), vector.expected);
  return {
    requestSha256: sha256(readBoundedRegular(requestPath)),
    responseSha256: sha256(responseBytes),
    responseBytes: responseBytes.length,
    bytes: responseBytes,
  };
}

function mutate(request, operation) {
  const candidate = structuredClone(request);
  switch (operation) {
    case 'set_live_action_true':
      candidate.liveActionAllowed = true;
      break;
    case 'set_production_environment':
      candidate.environment = 'production';
      break;
    case 'append_terminal_lf_to_package_hash':
      candidate.packageHash = `${candidate.packageHash}\n`;
      break;
    case 'add_unknown_field':
      candidate.credential = 'forbidden';
      break;
    case 'remove_account_id':
      delete candidate.accountId;
      break;
    default:
      fail('provider_vector_mutation_unknown');
  }
  return candidate;
}

function negativeAttempt(companion, baseRequest, mutation, runtimeRoot) {
  const directory = path.join(runtimeRoot, mutation.mutationId);
  fs.mkdirSync(directory, { mode: 0o700 });
  const requestPath = path.join(directory, 'request.json');
  const responsePath = path.join(directory, 'response.json');
  writeRequest(requestPath, mutate(baseRequest, mutation.operation));
  validateSchema(requestSchema, requestPath, 1);
  const result = runCompanion(companion, requestPath, responsePath, directory);
  if (result.error || result.signal || result.status === 0) {
    fail('provider_vector_negative_execution_succeeded');
  }
  if (fs.existsSync(responsePath) !== mutation.responseFileExpected) {
    fail('provider_vector_negative_response_disposition_invalid');
  }
  const diagnostics = `${result.stdout}${result.stderr}`;
  if (!diagnostics.includes(mutation.expectedError)) {
    fail('provider_vector_negative_error_mismatch');
  }
  return {
    operation: mutation.operation,
    exitCode: result.status,
    expectedError: mutation.expectedError,
    responseFileCreated: fs.existsSync(responsePath),
    requestSha256: sha256(readBoundedRegular(requestPath)),
  };
}

function main() {
  const companion = requiredAbsoluteEnvironment('PROVIDER_COMPANION');
  const vectorsPath = requiredAbsoluteEnvironment('PROVIDER_VECTORS');
  const evidencePath = requiredAbsoluteEnvironment('PROVIDER_VECTOR_EVIDENCE');
  const runtimeRoot = requiredAbsoluteEnvironment('PROVIDER_VECTOR_RUNTIME');
  if (fs.realpathSync(companion) !== companion) fail('provider_vector_companion_not_canonical');
  const companionBefore = readBoundedRegular(companion);
  const vectors = readJson(vectorsPath);
  if (!Array.isArray(vectors.vectors) || vectors.vectors.length === 0
    || vectors.vectors.length > 64
    || !Array.isArray(vectors.mutations) || vectors.mutations.length < 4
    || vectors.mutations.length > 32) {
    fail('provider_vector_set_invalid');
  }
  const vectorIds = vectors.vectors.map((vector) => vector.vectorId);
  const mutationIds = vectors.mutations.map((mutation) => mutation.mutationId);
  if (new Set(vectorIds).size !== vectorIds.length
    || new Set(mutationIds).size !== mutationIds.length) {
    fail('provider_vector_identity_duplicate');
  }
  if (fs.existsSync(runtimeRoot)) fail('provider_vector_runtime_exists');
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });

  const positive = vectors.vectors.map((vector) => {
    const first = positiveAttempt(companion, vector, runtimeRoot, 'first');
    const second = positiveAttempt(companion, vector, runtimeRoot, 'second');
    if (!first.bytes.equals(second.bytes)) fail('provider_vector_response_nondeterministic');
    return {
      vectorId: vector.vectorId,
      requestSha256: first.requestSha256,
      responseSha256: first.responseSha256,
      responseBytes: first.responseBytes,
      deterministicReplay: true,
      externalActionPerformed: false,
      productionAuthorized: false,
    };
  });
  const baseRequest = vectors.vectors[0].request;
  const negative = vectors.mutations.map((mutation) => (
    negativeAttempt(companion, baseRequest, mutation, runtimeRoot)
  ));
  const companionAfter = readBoundedRegular(companion);
  if (!companionBefore.equals(companionAfter)) fail('provider_vector_companion_changed');

  const body = {
    schemaVersion: 1,
    kind: 'ProviderExternalConformanceResultV1',
    status: 'credential_free_conformance_complete_non_authorizing',
    companionSha256: sha256(companionAfter),
    vectorSetSha256: sha256(readBoundedRegular(vectorsPath)),
    positive,
    negative,
    credentialsObserved: false,
    externalActionPerformed: false,
    providerAuthorized: false,
    releaseAuthorized: false,
    submissionAuthorized: false,
    productionAuthorized: false,
    externalAuthorityClaimed: false,
  };
  const bytes = Buffer.from(`${JSON.stringify(body, null, 2)}\n`, 'utf8');
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(evidencePath, bytes, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    status: body.status,
    positive: positive.length,
    negative: negative.length,
    companionSha256: body.companionSha256,
    productionAuthorized: false,
  })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.code || 'provider_vector_runner_failed'}\n`);
  process.exitCode = 1;
}
