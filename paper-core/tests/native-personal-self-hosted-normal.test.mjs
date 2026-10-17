import assert from 'node:assert/strict';
import path from 'node:path';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { recordPersonalDatabaseAntiRollback, createPersonalDatabaseBackup, restoreDrillPersonalDatabase } from '../../paper-adapters/persistence/personal-local-database-readiness.mjs';
import { before, after, test } from 'node:test';
import { resolveHeptaPaperCommand } from '../src/command-registry.mjs';
import { createNormalQualificationFixtureV1 } from './support/native-qualification-normal-fixture-v1.mjs';
const name = 'personal-self-hosted-readiness';
let fixture;
before(() => { fixture = createNormalQualificationFixtureV1([name]); });
after(() => { fixture?.close(); });
const args = values => ['operator', name, ...(values.length ? ['--', ...values] : [])];
async function pair(values, additions = {}) {
  const before = fixture.snapshot(fixture.root), node = await fixture.run('node', args(values), additions), native = await fixture.run('native', args(values), additions);
  assert.equal(native.status, node.status, `${values}: ${native.stderr} / ${node.stderr}`);
  assert.equal(native.stdout.endsWith('\n'), node.stdout.endsWith('\n'));
  // Keep raw process stderr in the observation; this exact incidental Node
  // SQLite diagnostic is distinct from the command's error/report contract.
  const incumbentStderr = node.stderr.replace(/^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/u, '');
  assert.equal(native.stderr, incumbentStderr);
  if (node.stdout) assert.deepEqual(JSON.parse(native.stdout), JSON.parse(node.stdout));
  else assert.equal(native.stdout, node.stdout);
  assert.deepEqual(fixture.snapshot(fixture.root), before); return JSON.parse(node.stdout || 'null');
}
test('normal_personal_complete_grammar_error_and_help_before_unknown_copied_root', async () => {
  const { booleanFlags, valueFlags } = resolveHeptaPaperCommand('operator', name).forwardedArgumentSchema;
  const cases = [['unexpected'], ['--'], ['--=x'], ['--unknown'], ['--cpu-receipt=x'], ['-'], ['-h']];
  for (const key of booleanFlags) cases.push([`--${key}=true`], [`--${key}=`], [`--${key}`, `--${key}`]);
  for (const key of valueFlags) cases.push([`--${key}`], [`--${key}=`], [`--${key}`, ''], [`--${key}`, '--help'], [`--${key}=one`, `--${key}=two`]);
  for (const value of cases) {
    const node = await fixture.run('node', args(value)), native = await fixture.run('native', args(value)), unknown = await fixture.run('native', args(value), {}, fixture.unknown);
    assert.equal(node.status, 2); assert.equal(native.status, 2); assert.equal(unknown.status, 2);
    assert.equal(native.stdout, ''); assert.equal(unknown.stdout, '');
    assert.deepEqual(JSON.parse(native.stderr), JSON.parse(node.stderr)); assert.deepEqual(JSON.parse(unknown.stderr), JSON.parse(node.stderr));
  }
  for (const value of [['--help'], ['--help', '--now=invalid'], ['--help', '--root=missing']]) {
    const expected = await pair(value), unknown = await fixture.run('native', args(value), {}, fixture.unknown);
    assert.equal(unknown.status, 0); assert.deepEqual(JSON.parse(unknown.stdout), expected);
  }
});
test('normal_personal_copied_frontend_full_reports_paths_env_flags_and_passive_dates', async () => {
  for (const now of ['0', '1999-12-31T23:59:59.999Z', 'Thu, 01 Oct 2026 00:00:00 GMT', '2026-10-01T01:02:03.123456+02:30']) {
    const report = await pair([`--now=${now}`]); assert.equal(report.externalActionsPerformed, false);
  }
  for (const value of [['--require-ready'], ['--json'], ['--gpu-enabled'], ['--gpu-enabled', '--gpu-receipt=missing'], ['--root=missing'], ['--runtime-root=relative-runtime'], ['--root=relative-runtime', '--runtime-root=missing-runtime']]) await pair(['--now=2026-10-02T00:00:00.000Z', ...value]);
  for (const additions of [{ HEPTA_WORKSPACE_ROOT: 'relative-runtime' }, { HEPTA_PAPER_RUNTIME_ROOT: 'relative-runtime' }, { HEPTA_PERSONAL_GPU_ENABLED: 'true', HEPTA_PERSONAL_GPU_RECEIPT: 'missing' }, { HEPTA_PERSONAL_GPU_DISABLED_REASON: 'actual operator explanation' }, { HEPTA_PERSONAL_CPU_RECEIPT: 'missing', HEPTA_FORMAL_OPERATIONAL_RECEIPT: 'missing' }]) await pair(['--now=2026-10-02T00:00:00.000Z'], additions);
  const unknown = await fixture.run('native', args(['--now=2026-10-02T00:00:00.000Z']), {}, fixture.unknown);
  assert.equal(unknown.status, 1); assert.match(unknown.stderr, /native_workspace_root_required/u);
  const explicit = await fixture.run('native', args(['--now=2026-10-02T00:00:00.000Z']), { HEPTA_PAPER_WORKSPACE_ROOT: fixture.root }, fixture.unknown);
  const normal = await fixture.run('node', args(['--now=2026-10-02T00:00:00.000Z']));
  assert.equal(explicit.status, normal.status); assert.deepEqual(JSON.parse(explicit.stdout), JSON.parse(normal.stdout));
});

test('normal_personal_actual_local_database_backup_restore_full_value_and_retry', async () => {
  // Independent local data fixture through the original store/mutation APIs.
  // It is not an actor, oracle, external signature or production receipt.
  const runtimeRoot = path.join(fixture.root, 'relative-runtime');
  const store = createDefaultPaperStore({ root: fixture.root, runtimeRoot, dbPath: path.join(runtimeRoot, 'hepta-paper.sqlite'), targetVersion: 25 });
  store.close();
  await recordPersonalDatabaseAntiRollback({ runtimeRoot });
  const backup = await createPersonalDatabaseBackup({ runtimeRoot });
  await restoreDrillPersonalDatabase({ runtimeRoot, backupPath: backup.backupPath });
  const values = ['--now=2026-10-02T00:00:00.000Z', '--runtime-root=relative-runtime'];
  const report = await pair(values);
  for (const key of ['database-inventory-and-schema', 'database-restore-drill', 'online-anti-rollback']) assert.equal(report.controlResults[key].status, 'verified');
  assert.equal(report.personalSelfHostedProductionReady, false);
  assert.equal(report.externalActionsPerformed, false);
  assert.deepEqual(await pair(values), report);
});
test('normal_personal_default_actual_clock_hashes_and_unknown_interrupt_fresh_retry', async () => {
  const fixed = '--now=2026-10-02T00:00:00.000Z';
  for (const engine of ['node', 'native']) {
    const before = fixture.snapshot(fixture.root), observed = await fixture.run(engine, args([]));
    assert.equal(observed.status, 0);
    const report = JSON.parse(observed.stdout), milliseconds = Date.parse(report.observedAt);
    assert.equal(new Date(milliseconds).toISOString(), report.observedAt);
    assert.ok(milliseconds >= observed.beganAt && milliseconds <= observed.endedAt);
    // Full values and all hashes are independently reproduced by the opposite
    // ordinary frontend at the genuinely observed system-clock timestamp.
    const replay = await fixture.run(engine === 'node' ? 'native' : 'node', args([`--now=${report.observedAt}`]));
    assert.equal(replay.status, observed.status);
    assert.deepEqual(JSON.parse(replay.stdout), report);
    assert.deepEqual(fixture.snapshot(fixture.root), before);
  }
  const expected = await pair([fixed]);
  for (const engine of ['node', 'native']) for (const signal of ['SIGTERM', 'SIGKILL']) {
    const before = fixture.snapshot(fixture.root);
    const interrupted = await fixture.run(engine, args([fixed]), {}, fixture.binary, signal);
    // This is a real interrupt at an explicitly unknown execution point, not a
    // claim about a particular SQLite backup or durable commit phase.
    assert.equal(interrupted.signal, signal); assert.equal(interrupted.status, null);
    assert.deepEqual(fixture.snapshot(fixture.root), before);
    const retry = await fixture.run(engine, args([fixed]));
    assert.equal(retry.status, 0); assert.deepEqual(JSON.parse(retry.stdout), expected);
    assert.deepEqual(fixture.snapshot(fixture.root), before);
  }
});
