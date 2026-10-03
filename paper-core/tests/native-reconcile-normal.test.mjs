import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { createNormalQualificationFixtureV1 } from './support/native-qualification-normal-fixture-v1.mjs';
import { resolveHeptaPaperCommand } from '../src/command-registry.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

// Both normal frontends run their actual system clocks. For fixed inputs well
// away from timing thresholds, reproduce only the independently observed clock
// fields through the incumbent hash owner. No fake product clock/preloader.
let fixture;
const args = values => ['operator', 'reconcile', '--', ...values];
const observations = [];
before(() => { fixture = createNormalQualificationFixtureV1(['reconcile']); });
after(() => {
  // Real reports/effects remain in the owning test stdout, not an acceptance
  // receipt or writer/authority qualification.
  process.stdout.write(`# reconcile-observations ${JSON.stringify(observations)}\n`);
  fixture?.close();
});
function setup(runtime, legacy = false) {
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const database = path.join(runtime, 'hepta-paper.sqlite');
  const store = createDefaultPaperStore({ root: fixture.root, runtimeRoot: runtime, dbPath: database, targetVersion: 25 });
  const clock = { now: () => new Date('2026-01-01T00:00:00.000Z'), nowIso: () => '2026-01-01T00:00:00.000Z' };
  const campaignStore = createSqliteCampaignStore({ store, clock });
  campaignStore.createCampaign({ campaignId: legacy ? 'legacy-campaign' : 'normal-campaign', paperId: 'actual-paper',
    ...(legacy ? {} : { terminalSiblingSettlementPolicyVersion: 1 }),
    nodes: [{ nodeId: 'actual:running', kind: 'agent', dependencies: [] }, { nodeId: 'actual:queued', kind: 'agent', dependencies: [] }] });
  const result = store.execute(`UPDATE campaign_nodes SET status='running',lease_owner='expired-author',lease_expires_at='2026-01-02T00:00:00.000Z',attempt_id='actual-attempt',lease_generation=2,node_revision=3 WHERE node_id='actual:running'; ${legacy ? "UPDATE paper_campaigns SET status='failed',stop_reason='historic-terminal' WHERE campaign_id='legacy-campaign';" : ''}`);
  assert.equal(result.ok, true); store.close();
  return database;
}
function verifyClock(observed, legacy) {
  const report = JSON.parse(observed.stdout), at = Date.parse(report.plannedAt);
  assert.ok(at >= observed.beganAt && at <= observed.endedAt);
  assert.equal(new Date(at).toISOString(), report.plannedAt);
  if (!legacy) {
    const sampled = Date.parse(report.noProgressCutoff) + 1_800_000;
    assert.ok(sampled >= observed.beganAt && sampled <= observed.endedAt);
  }
  const payload = { ...report }, key = legacy ? 'settlementPlanHash' : 'reconciliationPlanHash'; delete payload[key];
  assert.equal(report[key], hashRecord(legacy ? 'LegacyTerminalActiveResidueSettlementPlan' : 'AutomationRuntimeReconciliationPlan', payload));
  return report;
}
async function pair(values, additions, database, legacy = false) {
  const initialMain = fixture.pin(database);
  const node = await fixture.run('node', args(values), additions);
  const nodePhysical = fixture.snapshot(path.dirname(database));
  assert.equal(node.status, 0, node.stderr);
  assert.deepEqual(fixture.pin(database), initialMain);
  const native = await fixture.run('native', args(values), additions);
  const nativePhysical = fixture.snapshot(path.dirname(database));
  assert.equal(native.status, 0, native.stderr);
  assert.deepEqual(fixture.pin(database), initialMain);
  const nodeReport = verifyClock(node, legacy), nativeReport = verifyClock(native, legacy);
  const expected = { ...nodeReport, plannedAt: nativeReport.plannedAt };
  const key = legacy ? 'settlementPlanHash' : 'reconciliationPlanHash';
  if (!legacy) expected.noProgressCutoff = nativeReport.noProgressCutoff;
  delete expected[key]; expected[key] = hashRecord(legacy ? 'LegacyTerminalActiveResidueSettlementPlan' : 'AutomationRuntimeReconciliationPlan', expected);
  assert.deepEqual(nativeReport, expected);
  observations.push({ values, additions, node, native, nodePhysical, nativePhysical });
  return nativeReport;
}
test('normal_reconcile_original_closed_grammar_refuses_before_unknown_copied_root', async () => {
  const { booleanFlags, valueFlags } = resolveHeptaPaperCommand('operator', 'reconcile').forwardedArgumentSchema;
  const cases = [['unexpected'], ['--'], ['--help'], ['--json'], ['--execute'], ['--database=missing'], ['--at=2026-01-01'], ['--unknown'], ['-'], ['-h']];
  for (const key of booleanFlags) cases.push([`--${key}=true`], [`--${key}=`], [`--${key}`, `--${key}`]);
  for (const key of valueFlags) cases.push([`--${key}`], [`--${key}=`], [`--${key}`, ''], [`--${key}`, '--help'], [`--${key}=one`, `--${key}=two`]);
  for (const value of cases) {
    const node = await fixture.run('node', args(value)), native = await fixture.run('native', args(value)), unknown = await fixture.run('native', args(value), {}, fixture.unknown);
    for (const actual of [node, native, unknown]) { assert.equal(actual.status, 2); assert.equal(actual.stdout, ''); }
    assert.deepEqual(JSON.parse(native.stderr), JSON.parse(node.stderr)); assert.deepEqual(JSON.parse(unknown.stderr), JSON.parse(node.stderr));
  }
});
test('normal_reconcile_actual_default_relative_absolute_two_modes_and_retry', async () => {
  const standardRuntime = path.join(fixture.root, 'relative-runtime', 'standard');
  const legacyRuntime = path.join(fixture.root, 'relative-runtime', 'legacy');
  const defaultRuntime = path.resolve(fixture.root, '..', 'hepta-paper-runtime/native-runtime');
  const standard = setup(standardRuntime), legacy = setup(legacyRuntime, true), defaultDatabase = setup(defaultRuntime);
  for (const env of [{}, { HEPTA_PAPER_RUNTIME_ROOT: '' }]) await pair([], env, defaultDatabase);
  for (const selected of ['relative-runtime/standard', standardRuntime, 'relative-runtime/./standard']) {
    const env = { HEPTA_PAPER_RUNTIME_ROOT: selected };
    await pair([], env, standard); await pair(['--campaign-id=normal-campaign'], env, standard);
  }
  const legacyArgs = ['--legacy-terminal-active-residue', '--campaign-id', 'legacy-campaign'];
  const report = await pair(legacyArgs, { HEPTA_PAPER_RUNTIME_ROOT: 'relative-runtime/legacy' }, legacy, true);
  assert.equal(report.workersStarted, false); assert.equal(report.externalActionPerformed, false);
  await pair(legacyArgs, { HEPTA_PAPER_RUNTIME_ROOT: legacyRuntime }, legacy, true);
});
test('normal_reconcile_missing_scope_unknown_copy_and_alias_refuse_without_mutation', async () => {
  const runtime = path.join(fixture.root, 'relative-runtime', 'standard'), database = path.join(runtime, 'hepta-paper.sqlite');
  for (const values of [['--campaign-id=missing'], ['--campaign-id=bad id'], ['--legacy-terminal-active-residue'], ['--legacy-terminal-active-residue', '--campaign-id=normal-campaign']]) {
    const before = fixture.pin(database);
    const node = await fixture.run('node', args(values), { HEPTA_PAPER_RUNTIME_ROOT: runtime });
    const native = await fixture.run('native', args(values), { HEPTA_PAPER_RUNTIME_ROOT: runtime });
    assert.equal(node.status, 1); assert.equal(native.status, 1); assert.equal(node.stdout, ''); assert.equal(native.stdout, '');
    const codes = [...node.stderr.matchAll(/(?:automation_runtime_reconciliation|legacy_terminal_active_residue)_[a-z_]+/gu)].map(m => m[0]);
    assert.ok(codes.length); assert.ok(codes.some(code => native.stderr.includes(code)), native.stderr);
    assert.deepEqual(fixture.pin(database), before);
  }
  const missing = 'actual-missing-runtime';
  for (const engine of ['node', 'native']) {
    const observed = await fixture.run(engine, args([]), { HEPTA_PAPER_RUNTIME_ROOT: missing });
    assert.equal(observed.status, 1); assert.match(observed.stderr, /Read-only paper store missing/u); assert.equal(fs.existsSync(path.join(fixture.root, missing)), false);
  }
  const unknown = await fixture.run('native', args([]), { HEPTA_PAPER_RUNTIME_ROOT: runtime }, fixture.unknown);
  assert.equal(unknown.status, 1); assert.match(unknown.stderr, /native_workspace_root_required/u);
  const explicit = await fixture.run('native', args([]), { HEPTA_PAPER_WORKSPACE_ROOT: fixture.root, HEPTA_PAPER_RUNTIME_ROOT: runtime }, fixture.unknown);
  assert.equal(explicit.status, 0); verifyClock(explicit, false);
  const originalMain = fixture.pin(database);
  const alias = path.join(runtime, 'alias.sqlite'); fs.symlinkSync(database, alias);
  // No --database flag exists in this route. A runtime-dir alias is a bounded
  // native refusal extension, rather than claimed universal Node alias parity.
  const aliasedRuntime = path.join(fixture.root, 'relative-runtime', 'alias'); fs.symlinkSync(runtime, aliasedRuntime);
  const refused = await fixture.run('native', args([]), { HEPTA_PAPER_RUNTIME_ROOT: aliasedRuntime });
  assert.equal(refused.status, 1); assert.equal(refused.stdout, ''); assert.deepEqual(fixture.pin(database), originalMain);
});
test('normal_reconcile_actual_unknown_entry_term_kill_same_namespace_fresh_retry', async () => {
  const runtime = path.join(fixture.root, 'relative-runtime', 'standard'), database = path.join(runtime, 'hepta-paper.sqlite');
  for (const engine of ['node', 'native']) for (const signal of ['SIGTERM', 'SIGKILL']) {
    const before = fixture.snapshot(runtime);
    const interrupted = await fixture.run(engine, args([]), { HEPTA_PAPER_RUNTIME_ROOT: runtime }, fixture.binary, signal);
    assert.equal(interrupted.signal, signal); assert.equal(interrupted.status, null); assert.deepEqual(fixture.snapshot(runtime), before);
    const retry = await fixture.run(engine, args([]), { HEPTA_PAPER_RUNTIME_ROOT: runtime });
    assert.equal(retry.status, 0); verifyClock(retry, false);
    assert.equal(fixture.pin(database).sha256, before.find(row => row.path === 'hepta-paper.sqlite').pin.sha256);
  }
});
