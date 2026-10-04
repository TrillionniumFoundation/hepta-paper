import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createNormalQualificationFixtureV1 } from './support/native-qualification-normal-fixture-v1.mjs';
import { resolveHeptaPaperCommand } from '../src/command-registry.mjs';
import { buildPersonalGpuOperationalReceipt, verifyPersonalGpuOperationalReceipt } from '../../paper-domain/research/personal-gpu-operational-gate-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
let fixture;
const observations = [];
const args = values => ['operator', 'personal-gpu-operational-gate', '--', ...values];
before(() => { fixture = createNormalQualificationFixtureV1(['personal-gpu-operational-gate']); });
after(() => { process.stdout.write(`# personal-gpu-normal-observations ${JSON.stringify(observations)}\n`); fixture?.close(); });
const h = label => hashRecord('PersonalGpuNormalFixture', { label });
// Valid wire claims are protocol fixtures, not actual GPU, Docker, scientific,
// independent hardware or release/canary execution evidence.
function report(mode, gpuModel = 'NVIDIA GeForce RTX 4060') {
  const fixed = { createdAtEpochMs: 1750000000000, workspaceCommit: '0123456789abcdef0123456789abcdef01234567' };
  if (mode === 'blocked') return buildPersonalGpuOperationalReceipt({ ...fixed, blockers: ['fixture_blocked'] });
  const deepLearning = { status: 'personal_deep_learning_gpu_verified_non_promotable', originalReceiptHash: h('dl'), replayReceiptHash: h('replay'), sameDeviceReplayHash: h('same'), cpuOracleHash: h('cpu'), cpuOracleStatus: 'process_isolated_deep_learning_cpu_oracle_verified', hiddenEvaluationHash: h('hidden'), hiddenEvaluationStatus: 'deep_learning_hidden_evaluation_recorded', modelIrHash: h('model'), datasetManifestHash: h('dataset'), checkpointManifestHash: h('checkpoint'), deterministicReplay: true, errorBudgetHash: h('budget') };
  return buildPersonalGpuOperationalReceipt({ ...fixed,
    gpu: { gpuUuid: 'GPU-a33875b7-7eb7-679e-df08-19227d3decee', gpuModel, computeCapability: '8.9', driverVersion: '580.173.02', memoryMiB: 8188 },
    runtime: { image: 'hepta/python-gpu:0.15.0', imageDigest: h('image'), dockerDigestBound: true, networkDisabled: true, singleDevicePinned: true },
    pde: { status: 'canonical_pde_poisson_2d_gpu_scientifically_verified_non_promotable', receiptHash: h('pde'), cpuOracleStatus: 'process_isolated_pde_poisson_2d_cpu_oracle_verified', cpuOracleHash: h('pde-cpu'), scientificChecksPassed: true },
    deepLearning, ir: { modelHash: deepLearning.modelIrHash, datasetHash: deepLearning.datasetManifestHash, checkpointHash: deepLearning.checkpointManifestHash, modelExecutableCodeEmbedded: false, checkpointExecutablePayloadAllowed: false, pickleAllowed: false },
  });
}
function write(file, value, raw = null) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, raw ?? `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.chmodSync(file, 0o600);
}
async function exact(values, selected, expectedExit) {
  const before = fixture.snapshot(selected);
  const node = await fixture.run('node', args(values)); const native = await fixture.run('native', args(values));
  assert.equal(node.status, expectedExit, node.stderr); assert.equal(native.status, node.status, native.stderr);
  assert.equal(native.stdout, node.stdout); assert.equal(native.stderr, node.stderr); assert.deepEqual(fixture.snapshot(selected), before);
  observations.push({ values, node, native, effects: 'selected full raw/metadata namespace unchanged', syntheticReceiptProtocolOnly: true });
  return JSON.parse(native.stdout);
}
function fallback(value, observed) {
  assert.equal(verifyPersonalGpuOperationalReceipt(value), true);
  assert.ok(value.createdAtEpochMs >= observed.beganAt && value.createdAtEpochMs <= observed.endedAt);
  assert.equal(value.personalProductionReady, false); assert.equal(value.releaseBoundary.releasePromotionEligible, false);
  assert.equal(value.externalActionPerformed, false); assert.equal(value.networkActionPerformed, false);
  const { createdAtEpochMs, personalGpuOperationalReceiptHash, ...stable } = value;
  void createdAtEpochMs; void personalGpuOperationalReceiptHash; return stable;
}
test('normal_personal_gpu_original_closed_grammar_and_help_precede_unknown_copied_root', async () => {
  const schema = resolveHeptaPaperCommand('operator', 'personal-gpu-operational-gate').forwardedArgumentSchema;
  const cases = [['--'], ['--=x'], ['-h'], ['positional'], ['--json'], ['--execute'], ['--help', '--unknown']];
  for (const key of schema.booleanFlags) cases.push([`--${key}=true`], [`--${key}`, `--${key}`]);
  for (const key of schema.valueFlags) cases.push([`--${key}`], [`--${key}=`], [`--${key}`, ''], [`--${key}`, '--help'], [`--${key}=one`, `--${key}=two`]);
  for (const values of cases) {
    const node = await fixture.run('node', args(values)), native = await fixture.run('native', args(values)), unknown = await fixture.run('native', args(values), {}, fixture.unknown);
    for (const result of [node, native, unknown]) { assert.equal(result.status, 2); assert.equal(result.stdout, ''); }
    assert.deepEqual(JSON.parse(native.stderr), JSON.parse(node.stderr)); assert.deepEqual(JSON.parse(unknown.stderr), JSON.parse(node.stderr));
  }
  for (const values of [['--help'], ['--write', '--root=missing', '--deadline-ms=not-a-number', '--help']]) {
    const node = await fixture.run('node', args(values)), native = await fixture.run('native', args(values), {}, fixture.unknown);
    assert.equal(node.status, 0); assert.equal(native.status, 0); assert.equal(native.stdout, node.stdout); assert.equal(native.stderr, node.stderr);
  }
  const noCheck = await fixture.run('native', args(['--write']), {}, fixture.unknown);
  assert.equal(noCheck.status, 1); assert.equal(noCheck.stdout, ''); assert.match(noCheck.stderr, /GPU execution is not ported/u);
});
test('normal_personal_gpu_copied_default_and_relative_paths_ready_blocked_utf16_wire_and_successful_write_are_readonly', async () => {
  const runtime = path.join(fixture.root, 'relative-runtime'); const receipt = path.join(runtime, 'gpu-personal/personal-gpu-operational-receipt.json');
  for (const mode of ['ready', 'blocked']) {
    write(receipt, report(mode));
    for (const values of [
      ['--check', '--runtime-root=relative-runtime'],
      ['--check', '--runtime-root', runtime, '--write'],
      ['--check', '--receipt=relative-runtime/gpu-personal/personal-gpu-operational-receipt.json', '--root=missing-ignored-provenance', '--output-root=never-created', '--run-id=invalid/run', '--deadline-ms=NaN', '--write'],
    ]) await exact(values, runtime, mode === 'ready' ? 0 : 2);
    const before = fixture.snapshot(runtime);
    const node = await fixture.run('node', args(['--check']), { HEPTA_PAPER_RUNTIME_ROOT: 'relative-runtime' });
    const native = await fixture.run('native', args(['--check']), { HEPTA_PAPER_RUNTIME_ROOT: 'relative-runtime' });
    assert.equal(native.stdout, node.stdout); assert.equal(native.status, node.status); assert.deepEqual(fixture.snapshot(runtime), before);
  }
  const defaultReceipt = path.join(path.dirname(fixture.root), 'hepta-paper-runtime/native-runtime/gpu-personal/personal-gpu-operational-receipt.json'); write(defaultReceipt, report('ready')); await exact(['--check'], path.dirname(defaultReceipt), 0);
  for (const model of ['模型𐀀', '\ud800', 'GPU\u0000name']) { write(receipt, report('ready', model)); await exact(['--check', '--runtime-root=relative-runtime'], runtime, 0); }
  const unknown = await fixture.run('native', args(['--check']), {}, fixture.unknown); assert.equal(unknown.status, 1); assert.equal(unknown.stdout, ''); assert.match(unknown.stderr, /native_workspace_root_required/u);
  const explicit = await fixture.run('native', args(['--check', '--runtime-root=relative-runtime']), { HEPTA_PAPER_WORKSPACE_ROOT: fixture.root }, fixture.unknown); assert.equal(explicit.status, 0);
});
test('normal_personal_gpu_failed_check_write_publishes_only_the_fallback_and_same_namespace_retry_matches_node', async () => {
  for (const scenario of ['missing', 'missing-parent', 'invalid-json', 'invalid-json-space', 'invalid-json-nested', 'wrong-order']) {
    const roots = { node: path.join(fixture.root, `fallback-node-${scenario}`), native: path.join(fixture.root, `fallback-native-${scenario}`) }; const results = {};
    for (const engine of ['node', 'native']) {
      const receipt = path.join(roots[engine], 'receipt.json'); if (scenario !== 'missing-parent') fs.mkdirSync(roots[engine], { mode: 0o700 });
      if (!['missing', 'missing-parent'].includes(scenario)) write(receipt, null, scenario === 'invalid-json' ? '{' : scenario === 'invalid-json-space' ? '{ \n\t' : scenario === 'invalid-json-nested' ? '{"模型𐀀": {' : JSON.stringify(Object.fromEntries(Object.entries(report('blocked')).reverse())));
      const result = await fixture.run(engine, args(['--check', '--write', '--receipt', receipt])); assert.equal(result.status, 2, result.stderr); assert.equal(result.stderr, '');
      const value = JSON.parse(result.stdout); results[engine] = fallback(value, result);
      assert.equal(fs.readFileSync(receipt, 'utf8'), result.stdout); assert.equal(fs.statSync(receipt).mode & 0o777, 0o400); assert.deepEqual(fs.readdirSync(roots[engine]), ['receipt.json']);
      const pin = fixture.pin(receipt); const again = await fixture.run(engine, args(['--check', '--write', '--receipt', receipt])); assert.equal(again.status, 2); assert.equal(again.stdout, result.stdout); assert.deepEqual(fixture.pin(receipt), pin);
      observations.push({ engine, scenario, result, again, fallbackClockAndHashIndependentlyVerified: true, effects: 'exact fallback bytes mode0400; retry does not rewrite', authority: false });
    }
    assert.deepEqual(results.native, results.node);
  }
});
test('normal_personal_gpu_alias_fifo_hardlink_bounds_and_failed_publication_preserve_unknown_inputs_then_fresh_retry', async () => {
  const root = path.join(fixture.root, 'bounds'); fs.mkdirSync(root, { mode: 0o700 }); const receipt = path.join(root, 'receipt.json');
  for (const kind of ['symlink', 'hardlink', 'fifo', 'oversized']) {
    write(receipt, report('ready')); const bytes = fs.readFileSync(receipt);
    if (kind === 'symlink') { fs.renameSync(receipt, `${receipt}.held`); fs.symlinkSync(`${receipt}.held`, receipt); }
    if (kind === 'hardlink') fs.linkSync(receipt, `${receipt}.held`);
    if (kind === 'fifo') { fs.unlinkSync(receipt); assert.equal(spawnSync('/usr/bin/mkfifo', [receipt], { timeout: 5000 }).status, 0); }
    if (kind === 'oversized') { const fd = fs.openSync(receipt, 'w'); fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1); fs.closeSync(fd); }
    const fifoIdentity = () => { const s = fs.lstatSync(receipt, { bigint: true }); return ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(s[key])]); };
    const before = kind === 'fifo' ? fifoIdentity() : fixture.snapshot(root);
    const native = await fixture.run('native', args(['--check', '--receipt', receipt])); assert.equal(native.status, 2, native.stderr); fallback(JSON.parse(native.stdout), native);
    if (kind === 'fifo') assert.deepEqual(fifoIdentity(), before); else assert.deepEqual(fixture.snapshot(root), before);
    const writeAttempt = await fixture.run('native', args(['--check', '--write', '--receipt', receipt]));
    assert.equal(writeAttempt.status, 2, writeAttempt.stderr); fallback(JSON.parse(writeAttempt.stdout), writeAttempt);
    if (kind === 'fifo') assert.deepEqual(fifoIdentity(), before); else assert.deepEqual(fixture.snapshot(root), before);
    observations.push({kind, writeAttempt, nativeSafetyBoundary: 'read refusal cannot mint writable absence; unknown leaf retained', nodeWriteCompatibilityClaimed: false});
    fs.unlinkSync(receipt); if (['symlink', 'hardlink'].includes(kind)) fs.unlinkSync(`${receipt}.held`); write(receipt, null, bytes); await exact(['--check', '--receipt', receipt], root, 0);
  }
  const denied = path.join(root, 'unsafe-parent'); fs.mkdirSync(denied, { mode: 0o755 }); const absent = path.join(denied, 'receipt.json'); const before = fixture.snapshot(denied);
  const node = await fixture.run('node', args(['--check', '--write', '--receipt', absent])); const native = await fixture.run('native', args(['--check', '--write', '--receipt', absent]));
  assert.equal(node.status, 2); assert.equal(native.status, 2); assert.deepEqual(fallback(JSON.parse(native.stdout), native), fallback(JSON.parse(node.stdout), node)); assert.deepEqual(fixture.snapshot(denied), before);
});
test('normal_personal_gpu_unknown_entry_term_kill_preserves_receipt_and_fresh_same_namespace_check', async () => {
  const receipt = path.join(fixture.root, 'interrupt/receipt.json'); write(receipt, report('ready'));
  for (const engine of ['node', 'native']) for (const signal of ['SIGTERM', 'SIGKILL']) {
    const before = fixture.snapshot(path.dirname(receipt)); const interrupted = await fixture.run(engine, args(['--check', '--receipt', receipt]), {}, fixture.binary, signal);
    assert.equal(interrupted.status, null); assert.equal(interrupted.signal, signal); assert.deepEqual(fixture.snapshot(path.dirname(receipt)), before); await exact(['--check', '--receipt', receipt], path.dirname(receipt), 0);
    observations.push({ engine, signal, interrupted, scope: 'unknown entry; no read/publication-phase/cooperative cleanup claim', authority: false });
  }
});
