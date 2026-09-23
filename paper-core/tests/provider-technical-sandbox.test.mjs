import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runTechnicalProviderSandbox } from '../../provider-sandbox/provider-sandbox.mjs';

const entry = fileURLToPath(new URL('../../provider-sandbox/provider-sandbox.mjs', import.meta.url));
const digest = `sha256:${'a'.repeat(64)}`;
const request = (overrides = {}) => ({
  environment: 'provider_sandbox',
  provider: 'technical-sandbox',
  accountId: 'no-account-authority',
  paperId: 'technical-sandbox-control',
  dispatchAuthorizationHash: digest,
  packageHash: digest,
  liveActionAllowed: false,
  ...overrides,
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-technical-sandbox-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    input: path.join(root, 'request.json'),
    output: path.join(root, 'response.json'),
  };
}

function execute(t, value = request()) {
  const selected = fixture(t);
  fs.writeFileSync(selected.input, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  const result = spawnSync(process.execPath, [entry, selected.input, selected.output], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: selected.root,
      TMPDIR: selected.root,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      HEPTA_TEST_PRIVATE_CANARY: 'must-not-be-consumed',
    },
  });
  return { ...selected, result };
}

test('technical companion emits deterministic bounded no-effect response', (t) => {
  const first = execute(t);
  assert.equal(first.result.status, 0, first.result.stderr);
  const firstBytes = fs.readFileSync(first.output);
  const response = JSON.parse(firstBytes);
  assert.equal(response.kind, 'ProviderTechnicalSandboxResponseV1');
  assert.equal(response.providerReceipt.kind, 'ProviderTechnicalSandboxReceiptV1');
  assert.equal(response.providerReceipt.sandbox, true);
  assert.equal(response.externalActionPerformed, false);
  assert.equal(response.providerReceipt.externalActionPerformed, false);
  assert.equal(response.providerReceipt.networkActionPerformed, false);
  assert.equal(response.providerReceipt.credentialsObserved, false);
  assert.equal(response.productionEligible, false);
  assert.equal(response.externalAuthorityClaimed, false);
  assert.equal(fs.statSync(first.output).mode & 0o777, 0o600);

  const second = execute(t);
  assert.equal(second.result.status, 0, second.result.stderr);
  assert.deepEqual(fs.readFileSync(second.output), firstBytes);
});

test('technical companion remains intentionally incomplete for external acceptance', (t) => {
  const selected = execute(t);
  assert.equal(selected.result.status, 0, selected.result.stderr);
  const response = JSON.parse(fs.readFileSync(selected.output));
  assert.match(response.status, /incomplete_for_external_acceptance/u);
  for (const forbidden of [
    'remoteSubmissionId',
    'authoritativeRemoteReceipt',
    'portalMutationReceipt',
    'externalAuthorityEvidence',
    'productionAuthorization',
  ]) assert.equal(Object.hasOwn(response, forbidden), false, forbidden);
});

test('library entry and CLI produce the same response bytes', (t) => {
  const direct = fixture(t);
  fs.writeFileSync(direct.input, JSON.stringify(request()), { mode: 0o600, flag: 'wx' });
  assert.equal(runTechnicalProviderSandbox([direct.input, direct.output]).status,
    'provider_technical_sandbox_completed');
  const cli = execute(t);
  assert.equal(cli.result.status, 0, cli.result.stderr);
  assert.deepEqual(fs.readFileSync(direct.output), fs.readFileSync(cli.output));
});

for (const [name, value, pattern] of [
  ['live action', request({ liveActionAllowed: true }), /live_action_forbidden/u],
  ['production environment', request({ environment: 'production' }), /live_action_forbidden/u],
  ['empty provider', request({ provider: '' }), /request_field_invalid/u],
  ['wrong package digest', request({ packageHash: 'not-a-digest' }), /package_hash_invalid/u],
  ['wrong dispatch digest', request({ dispatchAuthorizationHash: 'sha256:0' }), /dispatch_hash_invalid/u],
  ['unknown field', { ...request(), credential: 'forbidden' }, /request_invalid/u],
  ['missing field', (() => { const value = request(); delete value.accountId; return value; })(), /request_invalid/u],
]) {
  test(`technical companion rejects ${name} before output`, (t) => {
    const selected = fixture(t);
    fs.writeFileSync(selected.input, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    const result = spawnSync(process.execPath, [entry, selected.input, selected.output], {
      encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
    assert.equal(fs.existsSync(selected.output), false);
  });
}

test('technical companion rejects malformed, oversized and aliased input', (t) => {
  for (const [label, prepare, pattern] of [
    ['malformed', (f) => fs.writeFileSync(f.input, '{bad'), /request_malformed/u],
    ['oversized', (f) => fs.writeFileSync(f.input, ' '.repeat(64 * 1024 + 1)), /request_unsafe/u],
    ['symlink', (f) => { const real = path.join(f.root, 'real.json');
      fs.writeFileSync(real, JSON.stringify(request())); fs.symlinkSync(real, f.input); }, /request_unsafe|request_path/u],
  ]) {
    const selected = fixture(t);
    prepare(selected);
    const result = spawnSync(process.execPath, [entry, selected.input, selected.output], {
      encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' },
    });
    assert.notEqual(result.status, 0, label);
    assert.match(result.stderr, pattern, label);
    assert.equal(fs.existsSync(selected.output), false, label);
  }
});

test('technical companion never overwrites an existing response', (t) => {
  const selected = fixture(t);
  fs.writeFileSync(selected.input, JSON.stringify(request()), { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(selected.output, 'preserve', { mode: 0o600, flag: 'wx' });
  const result = spawnSync(process.execPath, [entry, selected.input, selected.output], {
    encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /response_write_failed/u);
  assert.equal(fs.readFileSync(selected.output, 'utf8'), 'preserve');
});

test('technical companion rejects path boundary misuse', (t) => {
  const selected = fixture(t);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-technical-sandbox-other-'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  fs.writeFileSync(selected.input, JSON.stringify(request()));
  for (const args of [
    [],
    [selected.input],
    [selected.input, selected.input],
    [selected.input, path.join(other, 'response.json')],
    ['relative.json', selected.output],
  ]) assert.throws(() => runTechnicalProviderSandbox(args));
});
