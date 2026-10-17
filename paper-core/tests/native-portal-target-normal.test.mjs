import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { resolveHeptaPaperCommand } from '../src/command-registry.mjs';
import { createNormalQualificationFixtureV1 } from './support/native-qualification-normal-fixture-v1.mjs';
const name = 'portal-target-qualification'; let fixture;
before(() => { fixture = createNormalQualificationFixtureV1([name]); });
after(() => { fixture?.close(); });
const args = values => ['operator', name, ...(values.length ? ['--', ...values] : [])];
async function pair(values, additions = {}) {
  const before = fixture.snapshot(fixture.root), node = await fixture.run('node', args(values), additions), native = await fixture.run('native', args(values), additions);
  assert.equal(native.status, node.status, `${values}: ${native.stderr} / ${node.stderr}`);
  assert.equal(native.stderr, node.stderr); assert.equal(native.stdout.endsWith('\n'), node.stdout.endsWith('\n'));
  assert.deepEqual(JSON.parse(native.stdout), JSON.parse(node.stdout));
  assert.deepEqual(fixture.snapshot(fixture.root), before); return JSON.parse(node.stdout);
}
test('normal_portal_closed_registry_grammar_help_and_unknown_copied_layout', async () => {
  const { booleanFlags, valueFlags } = resolveHeptaPaperCommand('operator', name).forwardedArgumentSchema;
  const cases = [['unexpected'], ['--'], ['--unknown'], ['--json'], ['--qualification-level=production'], ['--target=tmlr'], ['--expected-route-hash=x']];
  for (const key of booleanFlags) cases.push([`--${key}=true`], [`--${key}`, `--${key}`]);
  for (const key of valueFlags) cases.push([`--${key}`], [`--${key}=`], [`--${key}`, ''], [`--${key}`, '--help'], [`--${key}=a`, `--${key}=b`]);
  for (const value of cases) {
    const node = await fixture.run('node', args(value)); assert.equal(node.status, 2);
    for (const executable of [fixture.binary, fixture.unknown]) {
      const native = await fixture.run('native', args(value), {}, executable); assert.equal(native.status, 2); assert.equal(native.stdout, '');
      assert.deepEqual(JSON.parse(native.stderr), JSON.parse(node.stderr));
    }
  }
  const help = await pair(['--help']);
  const unknown = await fixture.run('native', args(['--help']), {}, fixture.unknown); assert.equal(unknown.status, 0); assert.deepEqual(JSON.parse(unknown.stdout), help);
  const missing = await fixture.run('native', args([]), {}, fixture.unknown); assert.equal(missing.status, 1); assert.match(missing.stderr, /native_workspace_root_required/u);
});
test('normal_portal_status_preflight_full_reports_env_relative_paths_and_actual_import', async () => {
  await pair([]); await pair(['--require-ready']); await pair(['--action=preflight']);
  const setup = await fixture.runOracle('portal-target-qualification-v1.mjs', [{ operation: 'fixtures', now: new Date().toISOString() }]);
  assert.equal(setup.status, 0, setup.stderr); const original = JSON.parse(setup.stdout).results[0]; assert.equal(original.ok, true);
  const selected = original.value.find(row => row.label === 'initial');
  const directory = path.join(fixture.root, 'portal-fixture'); fs.mkdirSync(directory, { mode: 0o700 });
  for (const [name, text] of [['candidate.json', selected.candidateText], ['trust.json', selected.trustText]]) fs.writeFileSync(path.join(directory, name), text, { flag: 'wx', mode: 0o600 });
  const registry = path.join(directory, 'registry.json');
  const common = ['--registry=portal-fixture/registry.json', '--candidate=portal-fixture/candidate.json', `--candidate-hash=${selected.candidateHash}`, '--trust-store=portal-fixture/trust.json', `--trust-store-hash=${selected.trustHash}`];
  const planned = await pair(['--action=import-plan', ...common]); assert.equal(planned.safety.mutationPerformed, false);
  const execute = ['--action=import-execute', '--execute', `--plan-hash=${planned.planHash}`, ...common];
  const node = await fixture.run('node', args(execute)); assert.equal(node.status, 0, node.stderr); const nodeBytes = fs.readFileSync(registry), nodeReceipt = JSON.parse(node.stdout);
  assert.equal(nodeReceipt.externalActionPerformed, false); assert.equal(nodeReceipt.liveCommitPermitProduced, false); assert.equal(nodeReceipt.liveCommitPermitConsumed, false);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['candidate.json', 'registry.json', 'trust.json']);
  // Restore only this test-owned successful output to its genuinely absent
  // preimage. The native process independently recomputes and verifies the same
  // plan/pins through its ordinary frontend and original atomic writer.
  fs.unlinkSync(registry);
  const native = await fixture.run('native', args(execute)); assert.equal(native.status, 0, native.stderr);
  assert.deepEqual(JSON.parse(native.stdout), nodeReceipt); assert.deepEqual(fs.readFileSync(registry), nodeBytes);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['candidate.json', 'registry.json', 'trust.json']);
  const environment = { HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY: 'portal-fixture/registry.json', HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY_HASH: selected.candidateRegistryHash, HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE: 'portal-fixture/trust.json', HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE_HASH: selected.trustHash };
  assert.equal((await pair([], environment)).ready, true); await pair(['--require-ready'], environment);
  await pair(['--registry-hash=sha256:' + '0'.repeat(64)], environment);
  await pair(['--action=preflight'], environment);
  const expected = await pair([], environment);
  for (const engine of ['node', 'native']) for (const signal of ['SIGTERM', 'SIGKILL']) {
    const before = fixture.snapshot(fixture.root), interrupted = await fixture.run(engine, args([]), environment, fixture.binary, signal);
    assert.equal(interrupted.signal, signal); assert.equal(interrupted.status, null); assert.deepEqual(fixture.snapshot(fixture.root), before);
    const retry = await fixture.run(engine, args([]), environment); assert.equal(retry.status, 0); assert.deepEqual(JSON.parse(retry.stdout), expected);
    assert.deepEqual(fixture.snapshot(fixture.root), before);
  }
});
