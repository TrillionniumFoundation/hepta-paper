import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runTechnicalProviderSandbox } from '../../provider-sandbox/provider-sandbox.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const validator = path.join(root, 'docs/rust/tools/strict_json_schema.py');
const requestSchema = path.join(root,
  'docs/provider-sandbox/schemas/provider-technical-sandbox-request-v1.schema.json');
const responseSchema = path.join(root,
  'docs/provider-sandbox/schemas/provider-technical-sandbox-response-v1.schema.json');
const digest = `sha256:${'a'.repeat(64)}`;

function validate(schema, instance) {
  return spawnSync('python3', [validator, '--schema', schema, '--instance', instance], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
  });
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-technical-schema-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requestPath = path.join(directory, 'request.json');
  const responsePath = path.join(directory, 'response.json');
  const request = {
    environment: 'provider_sandbox',
    provider: 'technical-sandbox',
    accountId: 'no-account-authority',
    paperId: 'schema-control',
    dispatchAuthorizationHash: digest,
    packageHash: 'sha256:sandbox-package',
    liveActionAllowed: false,
  };
  fs.writeFileSync(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600, flag: 'wx' });
  return { directory, requestPath, responsePath, request };
}

test('runtime request and generated response satisfy the committed closed schemas', (t) => {
  const value = fixture(t);
  const requestResult = validate(requestSchema, value.requestPath);
  assert.equal(requestResult.status, 0, `${requestResult.stdout}\n${requestResult.stderr}`);
  runTechnicalProviderSandbox([value.requestPath, value.responsePath]);
  const responseResult = validate(responseSchema, value.responsePath);
  assert.equal(responseResult.status, 0, `${responseResult.stdout}\n${responseResult.stderr}`);
});

test('runtime rejects every request the closed request schema rejects in the shared policy surface', (t) => {
  const cases = [
    { ...fixture(t).request, liveActionAllowed: true },
    { ...fixture(t).request, environment: 'production' },
    { ...fixture(t).request, packageHash: 'invalid' },
    { ...fixture(t).request, extra: false },
  ];
  for (const [index, request] of cases.entries()) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `provider-schema-invalid-${index}-`));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const input = path.join(directory, 'request.json');
    const output = path.join(directory, 'response.json');
    fs.writeFileSync(input, JSON.stringify(request), { mode: 0o600, flag: 'wx' });
    assert.notEqual(validate(requestSchema, input).status, 0);
    assert.throws(() => runTechnicalProviderSandbox([input, output]));
    assert.equal(fs.existsSync(output), false);
  }
});

test('closed response schema rejects authority escalation and unknown fields', (t) => {
  const value = fixture(t);
  runTechnicalProviderSandbox([value.requestPath, value.responsePath]);
  const valid = JSON.parse(fs.readFileSync(value.responsePath, 'utf8'));
  for (const [index, mutate] of [
    (response) => { response.externalActionPerformed = true; },
    (response) => { response.productionEligible = true; },
    (response) => { response.externalAuthorityClaimed = true; },
    (response) => { response.providerReceipt.networkActionPerformed = true; },
    (response) => { response.unexpected = false; },
  ].entries()) {
    const candidate = structuredClone(valid);
    mutate(candidate);
    const file = path.join(value.directory, `invalid-response-${index}.json`);
    fs.writeFileSync(file, JSON.stringify(candidate));
    const result = validate(responseSchema, file);
    assert.notEqual(result.status, 0, `${index}:${result.stdout}:${result.stderr}`);
  }
});

test('schema and runtime preserve the existing bounded opaque sha256 identity domain', (t) => {
  const value = fixture(t);
  value.request.packageHash = 'sha256:sandbox-package';
  value.request.dispatchAuthorizationHash = 'sha256:dispatch-control';
  fs.rmSync(value.requestPath);
  fs.writeFileSync(value.requestPath, JSON.stringify(value.request), { mode: 0o600, flag: 'wx' });
  assert.equal(validate(requestSchema, value.requestPath).status, 0);
  assert.doesNotThrow(() => runTechnicalProviderSandbox([value.requestPath, value.responsePath]));
  assert.equal(validate(responseSchema, value.responsePath).status, 0);
});


test('schema and runtime both reject terminal controls in opaque identities', (t) => {
  const base = fixture(t).request;
  for (const [index, suffix] of ['\n', '\r', '\r\n', '\u2028', '\u2029'].entries()) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `provider-schema-terminal-${index}-`));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const input = path.join(directory, 'request.json');
    const output = path.join(directory, 'response.json');
    const request = { ...base, packageHash: `${base.packageHash}${suffix}` };
    fs.writeFileSync(input, JSON.stringify(request), { mode: 0o600, flag: 'wx' });
    assert.notEqual(validate(requestSchema, input).status, 0, JSON.stringify(suffix));
    assert.throws(() => runTechnicalProviderSandbox([input, output]));
    assert.equal(fs.existsSync(output), false);
  }
});

test('opaque identity boundary accepts the exact ASCII maximum and rejects one-byte overrun', (t) => {
  const base = fixture(t).request;
  const exact = `sha256:${'a'.repeat(2041)}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-schema-maximum-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const validInput = path.join(directory, 'valid.json');
  const validOutput = path.join(directory, 'valid-response.json');
  fs.writeFileSync(validInput, JSON.stringify({ ...base, packageHash: exact }),
    { mode: 0o600, flag: 'wx' });
  assert.equal(validate(requestSchema, validInput).status, 0);
  assert.doesNotThrow(() => runTechnicalProviderSandbox([validInput, validOutput]));
  assert.equal(validate(responseSchema, validOutput).status, 0);

  const invalidInput = path.join(directory, 'invalid.json');
  const invalidOutput = path.join(directory, 'invalid-response.json');
  fs.writeFileSync(invalidInput, JSON.stringify({ ...base, packageHash: `${exact}a` }),
    { mode: 0o600, flag: 'wx' });
  assert.notEqual(validate(requestSchema, invalidInput).status, 0);
  assert.throws(() => runTechnicalProviderSandbox([invalidInput, invalidOutput]));
  assert.equal(fs.existsSync(invalidOutput), false);
});
