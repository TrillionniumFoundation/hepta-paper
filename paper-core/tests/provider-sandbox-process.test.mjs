import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  inspectProviderSandboxCompanion, runProviderSandboxProcess, assertProviderSandboxResponseClaims,
} from '../../paper-adapters/submission/provider-sandbox-process.mjs';

// Local process controls only. No fixture is provisioned into the canonical
// external integration, and no test signs an actual provider or release receipt.
const root = fileURLToPath(new URL('../../', import.meta.url));
const digest = `sha256:${'a'.repeat(64)}`;
const request = () => ({ environment: 'provider_sandbox', liveActionAllowed: false,
  provider: 'sandbox-provider', accountId: 'sandbox-account', paperId: 'process-control',
  dispatchAuthorizationHash: digest, packageHash: digest });
const valid = { externalActionPerformed: false, providerReceipt: { sandbox: true },
  dispatchAuthorizationHash: digest };

function setup(t, program) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-process-control-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const companionEntry = path.join(parent, 'control.mjs');
  const runtimeRoot = path.join(parent, 'runtime');
  fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  fs.writeFileSync(companionEntry, program);
  return { parent, companionEntry, runtimeRoot,
    run: (overrides = {}) => runProviderSandboxProcess({ companionEntry, runtimeRoot,
      request: request(), ...overrides }) };
}
const emit = (value) => `import fs from 'node:fs'; fs.writeFileSync(process.argv[3], ${JSON.stringify(value)});`;

test('process control returns a parsed response but does not grant qualification', (t) => {
  const fixture = setup(t, emit(JSON.stringify(valid)));
  assert.deepEqual(fixture.run(), valid);
  assert.equal(fs.statSync(path.join(fixture.runtimeRoot, 'provider-request.json')).mode & 0o777, 0o600);
  assertProviderSandboxResponseClaims(valid, digest);
});

test('process control strips inherited credentials, Node options and proxies', (t) => {
  const fields = ['HEPTA_TEST_PRIVATE_CANARY', 'NODE_OPTIONS', 'HTTPS_PROXY', 'AWS_SECRET_ACCESS_KEY'];
  const original = new Map(fields.map((key) => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of original) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  for (const key of fields) process.env[key] = key === 'NODE_OPTIONS'
    ? '--import=/this-test-module-must-not-be-inherited.mjs' : 'test-only-private-canary';
  const fixture = setup(t, `import fs from 'node:fs';
    fs.writeFileSync(process.argv[3], JSON.stringify({ keys: Object.keys(process.env).sort(),
      home: process.env.HOME, temporary: process.env.TMPDIR, cwd: process.cwd() }));`);
  const response = fixture.run();
  assert.deepEqual(response.keys, ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR']);
  assert.equal(response.home, fixture.runtimeRoot);
  assert.equal(response.temporary, fixture.runtimeRoot);
  assert.equal(response.cwd, fixture.runtimeRoot);
});

test('process control does not echo private child diagnostics in failure objects', (t) => {
  const fixture = setup(t, "process.stderr.write('test-only-private-diagnostic'); process.exit(17);");
  assert.throws(() => fixture.run(), (error) => {
    assert.equal(error.code, 'provider_sandbox_companion_failed');
    assert.equal(error.cause, undefined);
    assert.equal(String(error.stack).includes('test-only-private-diagnostic'), false);
    return true;
  });
});

test('process control times out a direct child even if it ignores SIGTERM', (t) => {
  const fixture = setup(t, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
  assert.throws(() => fixture.run({ timeoutMs: 150 }), { code: 'provider_sandbox_companion_timeout' });
});

test('process control rejects excessive captured output', (t) => {
  const fixture = setup(t, "process.stdout.write('x'.repeat(256 * 1024)); setInterval(() => {}, 1000);");
  assert.throws(() => fixture.run(), { code: 'provider_sandbox_companion_failed' });
});

for (const [name, raw, code] of [
  ['malformed', '{bad', 'response_malformed'],
  ['scalar', 'false', 'response_malformed'],
  ['array root', '[]', 'response_malformed'],
  ['duplicate flag', '{"externalActionPerformed":true,"externalActionPerformed":false}', 'response_duplicate_key'],
  ['escaped duplicate', '{"key":1,"k\\u0065y":2}', 'response_duplicate_key'],
  ['nested duplicate', '{"nested":{"k":1,"k":2}}', 'response_duplicate_key'],
  ['nonfinite', '{"n":1e999}', 'response_nonfinite'],
  ['depth', '{"nested":' + '['.repeat(32) + '0' + ']'.repeat(32) + '}', 'response_structure_limit'],
  ['token limit', '{"many":[' + Array(5000).fill('0').join(',') + ']}', 'response_structure_limit'],
  ['byte limit', 'x'.repeat(65537), 'response_unsafe'],
]) {
  test(`process control rejects ${name} response before consumption`, (t) => {
    const fixture = setup(t, emit(raw));
    assert.throws(() => fixture.run(), { code: `provider_sandbox_${code}` });
  });
}

test('response scanner accepts escaped strings and keys at different object levels', (t) => {
  const value = { a: [{ key: 1 }, { key: 2 }], key: 0, s: '"[]{}\\key\\u0011', n: -1.5e12 };
  assert.deepEqual(setup(t, emit(JSON.stringify(value))).run(), value);
});

test('process control rejects invalid UTF-8 without replacement decoding', (t) => {
  const fixture = setup(t, "import fs from 'node:fs'; fs.writeFileSync(process.argv[3], Buffer.from([123,34,120,34,58,34,255,34,125]));");
  assert.throws(() => fixture.run(), { code: 'provider_sandbox_response_malformed' });
});

for (const [mode, program, code] of [
  ['missing', 'process.exit(0);', 'response_missing'],
  ['symlink', "import fs from 'node:fs';fs.symlinkSync(process.argv[2],process.argv[3]);", 'response_unreadable'],
  ['hardlink', "import fs from 'node:fs';fs.linkSync(process.argv[2],process.argv[3]);", 'request_unsafe'],
  ['FIFO', "import {spawnSync} from 'node:child_process';spawnSync('/usr/bin/mkfifo',[process.argv[3]]);", 'response_unsafe'],
  ['request mutation', emit('{}') + "fs.appendFileSync(process.argv[2], ' ');", 'request_changed'],
  ['source mutation', emit('{}') + "fs.appendFileSync(process.argv[1], '\\n// mutated');", 'companion_changed'],
]) {
  test(`process control rejects ${mode} artifact`, (t) => {
    assert.throws(() => setup(t, program).run(), { code: `provider_sandbox_${code}` });
  });
}

test('invalid request/timeout and reused paths fail without starting the child', (t) => {
  const fixture = setup(t, "import fs from 'node:fs'; fs.writeFileSync('executed','bad');");
  let getterCalls = 0;
  const accessor = Object.defineProperty(request(), 'provider', { enumerable: true,
    get() { getterCalls += 1; return 'not permitted'; } });
  for (const value of [null, [], { ...request(), credential: 'test-only-secret' },
    { ...request(), liveActionAllowed: true }, { ...request(), environment: 'production' },
    { ...request(), provider: '' }, { ...request(), paperId: 'x'.repeat(2049) }, accessor]) {
    assert.throws(() => fixture.run({ request: value }), /provider_sandbox_(request_invalid|live_action_forbidden)/);
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
  const fixture = setup(t, 'void 0;');
  assert.throws(() => inspectProviderSandboxCompanion(path.join(fixture.parent, 'absent')), { code: 'provider_sandbox_companion_missing' });
  const link = path.join(fixture.parent, 'alias');fs.symlinkSync(fixture.companionEntry, link);
  assert.throws(() => inspectProviderSandboxCompanion(link), { code: 'provider_sandbox_companion_unsafe' });
  fs.writeFileSync(fixture.companionEntry, 'x'.repeat(1024 * 1024 + 1));
  assert.throws(() => inspectProviderSandboxCompanion(fixture.companionEntry), { code: 'provider_sandbox_companion_unsafe' });
});

test('sandbox declarations must be explicit and bind the dispatch before promotion', () => {
  for (const value of [null, {}, { ...valid, externalActionPerformed: true },
    { ...valid, externalActionPerformed: 0 }, { ...valid, providerReceipt: { sandbox: false } },
    { ...valid, dispatchAuthorizationHash: 'other' }]) {
    assert.throws(() => assertProviderSandboxResponseClaims(value, digest), { code: 'provider_sandbox_response_claims_invalid' });
  }
});

for (const mode of ['unsafe', 'downstream', 'environment']) {
  const badClaims = mode === 'unsafe';
  test(`unchanged operator entrypoint with test ports ${badClaims ? 'rejects unsafe declarations' : mode === 'environment' ? 'strips operator credentials' : 'retains downstream verification'} before signing`, (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-operator-control-'));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const project = path.join(parent, 'project');
    const runtime = path.join(parent, 'runtime');
    const temporary = path.join(parent, 'tmp');fs.mkdirSync(temporary);
    const trace = path.join(parent, 'trace');fs.writeFileSync(trace, '');
    const put = (name, source) => { const file = path.join(project, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, source); };
    put('paper-core/bin/run-real-paper-provider-sandbox.mjs',
      fs.readFileSync(path.join(root, 'paper-core/bin/run-real-paper-provider-sandbox.mjs')));
    const log = `import fs from 'node:fs';const log = (value) => fs.appendFileSync(${JSON.stringify(trace)}, value+'\\n');`;
    put('paper-core/src/workspace-layout.mjs', `export const defaultPaperRuntimeRoot=()=>${JSON.stringify(runtime)};`);
    put('paper-core/src/code-provenance.mjs', 'export const currentCodeProvenance=()=>({});');
    put('workflow-kernel/record-hash.mjs', `export {hashRecord} from ${JSON.stringify(pathToFileURL(path.join(root, 'workflow-kernel/record-hash.mjs')).href)};`);
    put('paper-core/bin/release-integrity-signing.mjs', log + "export function signReleasePayload(){ log('SIGNING_MUST_NOT_BE_REACHED');throw Error('test_signing_forbidden'); }");
    put('paper-composition/bootstrap/operator-persistence-composition.mjs', log +
      "export function createDefaultPaperStore({runtimeRoot}){fs.mkdirSync(runtimeRoot,{recursive:true});return {close(){log('bootstrap-close');}};}");
    put('paper-composition/bootstrap/capability-scoped-bootstrap.mjs', log + `
      export function bootstrapSubmissionContext(){return {services:{persistenceSession:{close(){log('session-close');}},
        submissionDeliveryStore:{enqueue(){log('enqueue');return {message_id:1};},recordResponse(){log('delivery-verification');throw Error('fixture_stop_at_delivery');}}}};}`);
    put('paper-composition/bootstrap/provider-sandbox-process-composition.mjs',
      `export * from ${JSON.stringify(pathToFileURL(path.join(root, 'paper-adapters/submission/provider-sandbox-process.mjs')).href)};`);
    const priorDir = path.join(runtime, 'pilots/probe');fs.mkdirSync(priorDir, {recursive:true});
    fs.writeFileSync(path.join(priorDir, 'REAL_PAPER_END_TO_END_PILOT_RECEIPT.json'),
      JSON.stringify({realPaperEndToEndPilotReceiptHash:digest,mainTexHash:digest,blockers:['local-control-only']}));
    const companion = path.join(parent, 'hepta-paper-provider-sandbox/provider-sandbox.mjs');
    fs.mkdirSync(path.dirname(companion));
    fs.writeFileSync(companion, `import fs from 'node:fs';
      if (${JSON.stringify(mode)} === 'environment' && process.env.HEPTA_TEST_PRIVATE_CANARY) {
        process.stderr.write(process.env.HEPTA_TEST_PRIVATE_CANARY);process.exit(17);
      }
      const req=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
      fs.writeFileSync(process.argv[3],JSON.stringify({dispatchAuthorizationHash:req.dispatchAuthorizationHash,
        providerReceipt:{sandbox:true},externalActionPerformed:${badClaims}}));`);
    const result = spawnSync(process.execPath, [path.join(project, 'paper-core/bin/run-real-paper-provider-sandbox.mjs'), 'probe'], {
      encoding:'utf8',timeout:10000,env:{PATH:'/usr/bin:/bin',TMPDIR:temporary,HOME:parent,
        HEPTA_TEST_PRIVATE_CANARY:'test-only-operator-private-diagnostic'},
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stderr.includes('test-only-operator-private-diagnostic'), false);
    assert.ok(result.stderr.includes(badClaims ? 'provider_sandbox_response_claims_invalid' : 'fixture_stop_at_delivery'), result.stderr);
    const lines=fs.readFileSync(trace,'utf8').trim().split('\n');
    assert.equal(lines.includes('delivery-verification'), !badClaims);
    assert.equal(lines.includes('SIGNING_MUST_NOT_BE_REACHED'), false);
    assert.equal(lines.filter((line)=>line==='session-close').length,1);
    assert.deepEqual(fs.readdirSync(temporary),[]);
    assert.equal(fs.existsSync(path.join(priorDir,'REAL_PAPER_PROVIDER_SANDBOX_RECEIPT.json')),false);
  });
}
