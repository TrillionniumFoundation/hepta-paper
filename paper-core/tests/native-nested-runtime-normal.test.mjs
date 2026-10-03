import assert from 'node:assert/strict';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { resolveHeptaPaperCommand } from '../src/command-registry.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { createNormalQualificationFixtureV1 } from './support/native-qualification-normal-fixture-v1.mjs';
const name = 'nested-runtime-platform-qualification'; let fixture;
before(() => { fixture = createNormalQualificationFixtureV1([name]); });
after(() => { fixture?.close(); });
const args = values => ['operator', name, ...(values.length ? ['--', ...values] : [])];
function timeless(observation) {
  const report = JSON.parse(observation.stdout), millis = Date.parse(report.verifiedAt);
  assert.equal(new Date(millis).toISOString(), report.verifiedAt);
  assert.ok(millis >= observation.beganAt && millis <= observation.endedAt);
  const { nestedRuntimePlatformQualificationVerificationReportHash, ...payload } = report;
  assert.equal(nestedRuntimePlatformQualificationVerificationReportHash, hashRecord('NestedRuntimePlatformQualificationVerificationReport', payload));
  // Both real clocks and their entire original hashes are validated before
  // comparing the otherwise complete values at one common observation instant.
  return { ...payload, verifiedAt: '<independently-validated-system-clock>' };
}
async function pair(values, additions = {}) {
  const before = fixture.snapshot(fixture.root), node = await fixture.run('node', args(values), additions), native = await fixture.run('native', args(values), additions);
  assert.equal(native.status, node.status, `${values}: ${native.stderr} / ${node.stderr}`);
  assert.equal(native.stderr, node.stderr); assert.equal(native.stdout.endsWith('\n'), node.stdout.endsWith('\n'));
  if (values.includes('--help')) assert.equal(native.stdout, node.stdout); else assert.deepEqual(timeless(native), timeless(node));
  assert.deepEqual(fixture.snapshot(fixture.root), before); return node;
}
test('normal_nested_full_registry_grammar_and_text_help_before_unknown_copied_root', async () => {
  const { booleanFlags, valueFlags } = resolveHeptaPaperCommand('operator', name).forwardedArgumentSchema;
  const cases = [['unexpected'], ['--'], ['--=x'], ['--unknown'], ['--authority-independence-content-hash=x'], ['--json'], ['-h']];
  for (const key of booleanFlags) cases.push([`--${key}=true`], [`--${key}`, `--${key}`]);
  for (const key of valueFlags) cases.push([`--${key}`], [`--${key}=`], [`--${key}`, ''], [`--${key}`, '--help'], [`--${key}=a`, `--${key}=b`]);
  for (const value of cases) {
    const node = await fixture.run('node', args(value));
    for (const executable of [fixture.binary, fixture.unknown]) {
      const native = await fixture.run('native', args(value), {}, executable);
      assert.equal(native.status, 2); assert.equal(node.status, 2); assert.equal(native.stdout, '');
      assert.deepEqual(JSON.parse(native.stderr), JSON.parse(node.stderr));
    }
  }
  await pair(['--help']);
  const unknown = await fixture.run('native', args(['--help']), {}, fixture.unknown);
  assert.equal(unknown.status, 0); assert.equal(unknown.stdout, (await fixture.run('node', args(['--help']))).stdout);
});
test('normal_nested_copied_paths_environment_pins_authority_refusal_and_fresh_retry', async () => {
  await pair([]); await pair(['--config=missing']);
  const setup = await fixture.runOracle('nested-runtime-qualification-v1.mjs', { operation: 'fixture', scenario: 'valid', now: new Date().toISOString() });
  assert.equal(setup.status, 0, setup.stderr); const record = JSON.parse(setup.stdout);
  // Ephemeral independent signing fixtures prove this pinned verifier's local
  // input domain only. They do not qualify an actual account or Kubernetes host.
  const request = record.request, environment = {};
  const fields = { config: ['HEPTA_NESTED_RUNTIME_QUALIFICATION_CONFIG', 'configPath'], 'config-content-hash': ['HEPTA_NESTED_RUNTIME_QUALIFICATION_CONFIG_SHA256', 'expectedConfigContentHash'], 'qualification-content-hash': ['HEPTA_NESTED_RUNTIME_QUALIFICATION_RECEIPT_SHA256', 'expectedQualificationBundleContentHash'], 'conformance-content-hash': ['HEPTA_NESTED_RUNTIME_CONFORMANCE_RECEIPT_SHA256', 'expectedConformanceBundleContentHash'], 'pod-uid': ['HEPTA_NESTED_RUNTIME_POD_UID', 'podUid'], 'plan-hash': ['HEPTA_NESTED_RUNTIME_PLAN_HASH', 'planHash'], 'profile-id': ['HEPTA_NESTED_RUNTIME_PROFILE_ID', 'profileId'], 'runtime-class-name': ['HEPTA_NESTED_RUNTIME_CLASS_NAME', 'runtimeClassName'], 'parent-pod-cpu-millis': ['HEPTA_NESTED_RUNTIME_PARENT_POD_CPU_MILLIS', 'parentPodCpuMillis'], 'parent-pod-memory-bytes': ['HEPTA_NESTED_RUNTIME_PARENT_POD_MEMORY_BYTES', 'parentPodMemoryBytes'], 'parent-pod-pids': ['HEPTA_NESTED_RUNTIME_PARENT_POD_PIDS', 'parentPodPids'], 'qualification-key-id': ['HEPTA_NESTED_RUNTIME_QUALIFICATION_KEY_ID', 'qualificationKeyId'], 'qualification-subject-id': ['HEPTA_NESTED_RUNTIME_QUALIFICATION_SUBJECT_ID', 'qualificationSubjectId'], 'qualification-public-key-spki-hash': ['HEPTA_NESTED_RUNTIME_QUALIFICATION_PUBLIC_KEY_SPKI_SHA256', 'qualificationPublicKeySpkiHash'], 'conformance-key-id': ['HEPTA_NESTED_RUNTIME_CONFORMANCE_KEY_ID', 'conformanceKeyId'], 'conformance-subject-id': ['HEPTA_NESTED_RUNTIME_CONFORMANCE_SUBJECT_ID', 'conformanceSubjectId'], 'conformance-public-key-spki-hash': ['HEPTA_NESTED_RUNTIME_CONFORMANCE_PUBLIC_KEY_SPKI_SHA256', 'conformancePublicKeySpkiHash'] };
  for (const [env, field] of Object.values(fields)) environment[env] = String(request[field]);
  environment.HEPTA_NESTED_RUNTIME_AUTHORITY_INDEPENDENCE_RECEIPT_SHA256 = request.expectedAuthorityIndependenceBundleContentHash;
  assert.equal(JSON.parse((await pair([], environment)).stdout).ready, true);
  const flags = Object.entries(fields).map(([key, [, field]]) => `--${key}=${request[field]}`);
  assert.equal(JSON.parse((await pair(flags, { HEPTA_NESTED_RUNTIME_AUTHORITY_INDEPENDENCE_RECEIPT_SHA256: request.expectedAuthorityIndependenceBundleContentHash })).stdout).ready, true);
  environment.HEPTA_NESTED_RUNTIME_QUALIFICATION_CONFIG = path.relative(fixture.root, request.configPath);
  assert.equal(JSON.parse((await pair([], environment)).stdout).ready, true);
  for (const key of Object.keys(fields)) assert.equal(JSON.parse((await pair([`--${key}=invalid-current-binding`], environment)).stdout).ready, false, key);
  const expected = timeless(await pair([], environment));
  for (const engine of ['node', 'native']) for (const signal of ['SIGTERM', 'SIGKILL']) {
    const before = fixture.snapshot(fixture.root), interrupted = await fixture.run(engine, args([]), environment, fixture.binary, signal);
    assert.equal(interrupted.signal, signal); assert.equal(interrupted.status, null); assert.deepEqual(fixture.snapshot(fixture.root), before);
    const retry = await fixture.run(engine, args([]), environment); assert.equal(retry.status, 0); assert.deepEqual(timeless(retry), expected);
    assert.deepEqual(fixture.snapshot(fixture.root), before);
  }
  const unknown = await fixture.run('native', args([]), environment, fixture.unknown); assert.equal(unknown.status, 1); assert.match(unknown.stderr, /native_workspace_root_required/u);
});
