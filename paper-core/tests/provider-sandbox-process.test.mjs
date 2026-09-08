import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  inspectProviderSandboxCompanion, runProviderSandboxProcess, assertProviderSandboxResponseClaims,
} from '../../paper-adapters/submission/provider-sandbox-process.mjs';

// Local process controls only. No fixture is provisioned into the canonical
// external integration, and no test signs an actual provider or release receipt.
const root = fileURLToPath(new URL('../../', import.meta.url));
const companionFixture = path.join(root, 'paper-core/tests/fixtures/provider-sandbox-companion.mjs');
const operatorTemplate = path.join(root, 'paper-core/tests/fixtures/provider-operator-project');
const operatorCompanions = path.join(root, 'paper-core/tests/fixtures/provider-operator-companions');
const digest = `sha256:${'a'.repeat(64)}`;
const request = (paperId = 'case:valid') => ({
  environment: 'provider_sandbox',
  liveActionAllowed: false,
  provider: 'sandbox-provider',
  accountId: 'sandbox-account',
  paperId,
  dispatchAuthorizationHash: digest,
  packageHash: digest,
});
const valid = {
  externalActionPerformed: false,
  providerReceipt: { sandbox: true },
  dispatchAuthorizationHash: digest,
};

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function setup(t, mode = 'case:valid') {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-process-control-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const companionEntry = path.join(parent, 'control.mjs');
  const runtimeRoot = path.join(parent, 'runtime');
  fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  fs.copyFileSync(companionFixture, companionEntry);
  return {
    parent,
    companionEntry,
    runtimeRoot,
    run: (overrides = {}) => runProviderSandboxProcess({
      companionEntry,
      runtimeRoot,
      request: request(mode),
      ...overrides,
    }),
  };
}

test('process control returns a parsed response but does not grant qualification', (t) => {
  const fixture = setup(t);
  assert.deepEqual(fixture.run(), valid);
  assert.equal(fs.statSync(path.join(fixture.runtimeRoot, 'provider-request.json')).mode & 0o777, 0o600);
  assertProviderSandboxResponseClaims(valid, digest);
});

test('process control strips inherited credentials, Node options and proxies', (t) => {
  const fields = ['HEPTA_TEST_PRIVATE_CANARY', 'NODE_OPTIONS', 'HTTPS_PROXY', 'AWS_SECRET_ACCESS_KEY'];
  const original = new Map(fields.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const key of fields) {
    process.env[key] = key === 'NODE_OPTIONS'
      ? '--import=/this-test-module-must-not-be-inherited.mjs'
      : 'test-only-private-canary';
  }
  const fixture = setup(t, 'case:environment');
  const response = fixture.run();
  assert.deepEqual(response.keys, ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR']);
  assert.equal(response.home, fixture.runtimeRoot);
  assert.equal(response.temporary, fixture.runtimeRoot);
  assert.equal(response.cwd, fixture.runtimeRoot);
});

test('process control does not echo private child diagnostics in failure objects', (t) => {
  const fixture = setup(t, 'case:private-diagnostic');
  assert.throws(() => fixture.run(), (error) => {
    assert.equal(error.code, 'provider_sandbox_companion_failed');
    assert.equal(error.cause, undefined);
    assert.equal(String(error.stack).includes('test-only-private-diagnostic'), false);
    return true;
  });
});

test('process control times out a direct child even if it ignores SIGTERM', (t) => {
  const fixture = setup(t, 'case:timeout');
  assert.throws(() => fixture.run({ timeoutMs: 150 }), { code: 'provider_sandbox_companion_timeout' });
});

test('process control rejects excessive captured output', (t) => {
  const fixture = setup(t, 'case:excessive-output');
  assert.throws(() => fixture.run(), { code: 'provider_sandbox_companion_failed' });
});

for (const [name, mode, code] of [
  ['malformed', 'case:malformed', 'response_malformed'],
  ['scalar', 'case:scalar', 'response_malformed'],
  ['array root', 'case:array-root', 'response_malformed'],
  ['duplicate flag', 'case:duplicate-flag', 'response_duplicate_key'],
  ['escaped duplicate', 'case:escaped-duplicate', 'response_duplicate_key'],
  ['nested duplicate', 'case:nested-duplicate', 'response_duplicate_key'],
  ['nonfinite', 'case:nonfinite', 'response_nonfinite'],
  ['depth', 'case:depth', 'response_structure_limit'],
  ['token limit', 'case:token-limit', 'response_structure_limit'],
  ['byte limit', 'case:byte-limit', 'response_unsafe'],
]) {
  test(`process control rejects ${name} response before consumption`, (t) => {
    const fixture = setup(t, mode);
    assert.throws(() => fixture.run(), { code: `provider_sandbox_${code}` });
  });
}

test('response scanner accepts escaped strings and keys at different object levels', (t) => {
  const value = { a: [{ key: 1 }, { key: 2 }], key: 0, s: '"[]{}\\key\\u0011', n: -1.5e12 };
  assert.deepEqual(setup(t, 'case:escaped-response').run(), value);
});

test('process control rejects invalid UTF-8 without replacement decoding', (t) => {
  const fixture = setup(t, 'case:invalid-utf8');
  assert.throws(() => fixture.run(), { code: 'provider_sandbox_response_malformed' });
});

for (const [name, mode, code] of [
  ['missing', 'case:missing', 'response_missing'],
  ['symlink', 'case:symlink', 'response_unreadable'],
  ['hardlink', 'case:hardlink', 'request_unsafe'],
  ['FIFO', 'case:fifo', 'response_unsafe'],
  ['request mutation', 'case:request-mutation', 'request_changed'],
  ['source mutation', 'case:source-mutation', 'companion_changed'],
]) {
  test(`process control rejects ${name} artifact`, (t) => {
    assert.throws(() => setup(t, mode).run(), { code: `provider_sandbox_${code}` });
  });
}

test('invalid request/timeout and reused paths fail without starting the child', (t) => {
  const fixture = setup(t, 'case:executed-marker');
  let getterCalls = 0;
  const accessor = Object.defineProperty(request(), 'provider', {
    enumerable: true,
    get() { getterCalls += 1; return 'not permitted'; },
  });
  for (const value of [
    null,
    [],
    { ...request(), credential: 'test-only-secret' },
    { ...request(), liveActionAllowed: true },
    { ...request(), environment: 'production' },
    { ...request(), provider: '' },
    { ...request(), paperId: 'x'.repeat(2049) },
    accessor,
  ]) {
    assert.throws(
      () => fixture.run({ request: value }),
      /provider_sandbox_(request_invalid|live_action_forbidden)/,
    );
    assert.deepEqual(fs.readdirSync(fixture.runtimeRoot), []);
  }
  assert.equal(getterCalls, 0);
  for (const timeoutMs of [0, -1, 10001, Infinity, '1']) {
    assert.throws(() => fixture.run({ timeoutMs }), { code: 'provider_sandbox_timeout_invalid' });
  }
  const output = path.join(fixture.runtimeRoot, 'provider-response.json');
  fs.writeFileSync(output, 'preserve');
  assert.throws(() => fixture.run(), { code: 'provider_sandbox_response_already_exists' });
  assert.equal(fs.readFileSync(output, 'utf8'), 'preserve');
  fs.unlinkSync(output);
  const input = path.join(fixture.runtimeRoot, 'provider-request.json');
  fs.writeFileSync(input, 'preserve');
  assert.throws(() => fixture.run(), { code: 'provider_sandbox_request_write_failed' });
  assert.equal(fs.readFileSync(input, 'utf8'), 'preserve');
  assert.equal(fs.existsSync(path.join(fixture.runtimeRoot, 'executed')), false);
});

test('companion inspection rejects missing, aliased and oversized source', (t) => {
  const fixture = setup(t);
  assert.throws(
    () => inspectProviderSandboxCompanion(path.join(fixture.parent, 'absent')),
    { code: 'provider_sandbox_companion_missing' },
  );
  const link = path.join(fixture.parent, 'alias');
  fs.symlinkSync(fixture.companionEntry, link);
  assert.throws(
    () => inspectProviderSandboxCompanion(link),
    { code: 'provider_sandbox_companion_unsafe' },
  );
  fs.writeFileSync(fixture.companionEntry, 'x'.repeat(1024 * 1024 + 1));
  assert.throws(
    () => inspectProviderSandboxCompanion(fixture.companionEntry),
    { code: 'provider_sandbox_companion_unsafe' },
  );
});

test('sandbox declarations must be explicit and bind the dispatch before promotion', () => {
  for (const value of [
    null,
    {},
    { ...valid, externalActionPerformed: true },
    { ...valid, externalActionPerformed: 0 },
    { ...valid, providerReceipt: { sandbox: false } },
    { ...valid, dispatchAuthorizationHash: 'other' },
  ]) {
    assert.throws(
      () => assertProviderSandboxResponseClaims(value, digest),
      { code: 'provider_sandbox_response_claims_invalid' },
    );
  }
});

for (const mode of ['unsafe', 'downstream', 'environment']) {
  const badClaims = mode === 'unsafe';
  const behavior = badClaims
    ? 'rejects unsafe declarations'
    : mode === 'environment'
      ? 'strips operator credentials'
      : 'retains downstream verification';
  test(`unchanged operator entrypoint with test ports ${behavior} before signing`, (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-operator-control-'));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const project = path.join(parent, 'project');
    const runtime = path.join(parent, 'runtime');
    const temporary = path.join(parent, 'tmp');
    fs.cpSync(operatorTemplate, project, { recursive: true });
    fs.mkdirSync(temporary);
    const trace = path.join(parent, 'trace');
    fs.writeFileSync(trace, '');

    copyFile(
      path.join(root, 'paper-core/bin/run-real-paper-provider-sandbox.mjs'),
      path.join(project, 'paper-core/bin/run-real-paper-provider-sandbox.mjs'),
    );
    copyFile(
      path.join(root, 'workflow-kernel/record-hash.mjs'),
      path.join(project, 'workflow-kernel/record-hash.mjs'),
    );
    copyFile(
      path.join(root, 'paper-composition/bootstrap/provider-sandbox-process-composition.mjs'),
      path.join(project, 'paper-composition/bootstrap/provider-sandbox-process-composition.mjs'),
    );
    for (const name of [
      'provider-sandbox-process.mjs',
      'provider-sandbox-request-repository.mjs',
    ]) {
      copyFile(
        path.join(root, 'paper-adapters/submission', name),
        path.join(project, 'paper-adapters/submission', name),
      );
    }

    const priorDir = path.join(runtime, 'pilots/probe');
    fs.mkdirSync(priorDir, { recursive: true });
    fs.writeFileSync(
      path.join(priorDir, 'REAL_PAPER_END_TO_END_PILOT_RECEIPT.json'),
      JSON.stringify({
        realPaperEndToEndPilotReceiptHash: digest,
        mainTexHash: digest,
        blockers: ['local-control-only'],
      }),
    );
    const companion = path.join(parent, 'hepta-paper-provider-sandbox/provider-sandbox.mjs');
    copyFile(path.join(operatorCompanions, `${mode}.mjs`), companion);

    const result = spawnSync(
      process.execPath,
      [path.join(project, 'paper-core/bin/run-real-paper-provider-sandbox.mjs'), 'probe'],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          PATH: '/usr/bin:/bin',
          TMPDIR: temporary,
          HOME: parent,
          HEPTA_TEST_TRACE_PATH: trace,
          HEPTA_TEST_RUNTIME_ROOT: runtime,
          HEPTA_TEST_PRIVATE_CANARY: 'test-only-operator-private-diagnostic',
        },
      },
    );
    assert.notEqual(result.status, 0);
    assert.equal(result.stderr.includes('test-only-operator-private-diagnostic'), false);
    assert.ok(
      result.stderr.includes(badClaims
        ? 'provider_sandbox_response_claims_invalid'
        : 'fixture_stop_at_delivery'),
      result.stderr,
    );
    const lines = fs.readFileSync(trace, 'utf8').trim().split('\n');
    assert.equal(lines.includes('delivery-verification'), !badClaims);
    assert.equal(lines.includes('SIGNING_MUST_NOT_BE_REACHED'), false);
    assert.equal(lines.filter((line) => line === 'session-close').length, 1);
    assert.deepEqual(fs.readdirSync(temporary), []);
    assert.equal(
      fs.existsSync(path.join(priorDir, 'REAL_PAPER_PROVIDER_SANDBOX_RECEIPT.json')),
      false,
    );
  });
}
