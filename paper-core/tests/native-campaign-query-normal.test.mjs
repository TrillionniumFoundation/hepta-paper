import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { createNormalQualificationFixtureV1 } from './support/native-qualification-normal-fixture-v1.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { autonomousSubmissionHandoffDatabasePath, provisionAutonomousSubmissionHandoffStore } from '../../paper-adapters/persistence/autonomous-submission-handoff-store.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { sqlText } from '../../paper-ports/store-port.mjs';

let fixture;
const observations = [];
const args = values => ['operator', 'campaign', '--', ...values];
const quiet = { NODE_NO_WARNINGS: '1' };
before(() => { fixture = createNormalQualificationFixtureV1(['campaign']); });
after(() => {
  process.stdout.write(`# campaign-observations ${JSON.stringify(observations)}\n`);
  fixture?.close();
});
function setup(runtime, { handoff = true } = {}) {
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const database = path.join(runtime, 'hepta-paper.sqlite');
  const store = createDefaultPaperStore({ root: fixture.root, runtimeRoot: runtime, dbPath: database, targetVersion: 25 });
  const clock = { now: () => new Date('2026-01-01T00:00:00.000Z'), nowIso: () => '2026-01-01T00:00:00.000Z' };
  const campaigns = createSqliteCampaignStore({ store, clock });
  campaigns.createCampaign({ campaignId: 'actual-old', paperId: 'actual-paper', title: 'old', nodes: [
    { nodeId: 'actual-old:running', kind: 'author', dependencies: [], priority: 1 },
    { nodeId: 'actual-old:failed', kind: 'review', dependencies: [], priority: 2 },
    { nodeId: 'actual-old:queued', kind: 'review', dependencies: [], priority: 3 },
  ] });
  campaigns.createCampaign({ campaignId: 'actual-new', paperId: 'actual-paper', supersedesCampaignId: 'actual-old',
    metadata: { text: 'UTF16: \ud800 and 😀', numeric: 1e-7 },
    nodes: [{ nodeId: 'actual-new:ready', kind: 'revise', dependencies: [] }] });
  const prepared = { kind: 'actual_prepared_result', workspaceAttemptIntegration: { workspaceAttemptIntegrationDescriptorHash: 'sha256:' + '1'.repeat(64) } };
  const receiptPayload = { descriptorHash: prepared.workspaceAttemptIntegration.workspaceAttemptIntegrationDescriptorHash, status: 'integrated' };
  const receipt = { ...receiptPayload, workspaceAttemptIntegrationReceiptHash: hashRecord('WorkspaceAttemptIntegrationReceipt', receiptPayload) };
  const result = { kind: 'actual_result', status: 'done', receiptHash: 'actual:result', blockers: ['first'], usage: { tokens: 3 }, summary: { text: '\udfff' } };
  const failure = { message: 'actual failure', blockers: ['second'], stderrTail: '😀'.repeat(1100) + 'tail', receiptKind: 'actual_receipt', receiptStatus: 'failed' };
  const changed = store.execute(`
    UPDATE paper_campaigns SET status='paused',agent_call_count=2,priced_agent_call_count=1,cost_usd=9.5,current_review_round=0,max_rounds=0 WHERE campaign_id='actual-old';
    UPDATE paper_campaigns SET updated_at='2026-01-02T00:00:00.000Z' WHERE campaign_id='actual-new';
    UPDATE campaign_nodes SET status='running',role='author',attempt_count=1,result_json=${sqlText(JSON.stringify(result))},result_sha256='actual:node',prepared_result_json=${sqlText(JSON.stringify(prepared))},prepared_result_sha256=${sqlText(hashRecord('PaperCampaignNodeResult', prepared))},prepared_requires_integration=1,prepared_integration_key=${sqlText(receiptPayload.descriptorHash)},prepared_integration_receipt_json=${sqlText(JSON.stringify(receipt))},prepared_integration_receipt_sha256=${sqlText(receipt.workspaceAttemptIntegrationReceiptHash)} WHERE node_id='actual-old:running';
    UPDATE campaign_nodes SET status='failed_terminal',reviewer_id='independent-reviewer',failure_json=${sqlText(JSON.stringify(failure))},failure_sha256='actual:failure',failure_class='actual_failure' WHERE node_id='actual-old:failed';
  `);
  assert.equal(changed.ok, true, changed.error); store.close();
  if (handoff) provisionAutonomousSubmissionHandoffStore({ runtimeRoot: runtime });
  return database;
}
async function pair(values, additions, database) {
  const before = fixture.pin(database), handoff = autonomousSubmissionHandoffDatabasePath({ runtimeRoot: path.dirname(database) });
  const handoffBefore = fixture.pin(handoff);
  const node = await fixture.run('node', args(values), { ...quiet, ...additions });
  const nodePhysical = fixture.snapshot(path.dirname(database));
  assert.equal(node.status, 0, node.stderr); assert.equal(node.stderr, '');
  assert.deepEqual(fixture.pin(database), before);
  const native = await fixture.run('native', args(values), { ...quiet, ...additions });
  const nativePhysical = fixture.snapshot(path.dirname(database));
  assert.equal(native.status, 0, native.stderr); assert.equal(native.stderr, '');
  assert.equal(native.stdout, node.stdout);
  assert.deepEqual(fixture.pin(database), before);
  assert.deepEqual(fixture.pin(handoff), handoffBefore);
  observations.push({ values, additions, node, native, nodePhysical, nativePhysical });
  return JSON.parse(native.stdout);
}
test('normal_campaign_actual_strict_child_errors_help_and_full_legal_query_grammar_precede_io', async () => {
  const booleans = ['execute', 'inline', 'json', 'help', 'gpu', 'gpu-scientific', 'effective', 'details', 'retain-failed-workspaces', 'apply', 'apply-manuscript', 'local-only', 'write-queue', 'skip-quality-gates'];
  const values = ['root', 'runtime-root', 'mode', 'agent-provider', 'openclaw-agent', 'model', 'formal-review-provider', 'formal-review-model', 'formal-review-codex-binary', 'formal-review-codex-home', 'codex-home', 'codex-binary', 'ollama-model', 'concurrency', 'agent-slots', 'cpu-slots', 'gpu-slots', 'gpu-device-selector', 'gpu-scientific-deadline-ms', 'memory-mib', 'max-wall-ms', 'max-agent-calls', 'max-cpu-jobs', 'max-gpu-jobs', 'max-tokens', 'max-cost-usd', 'action', 'campaign-id', 'run-id', 'node-id', 'rounds', 'referees', 'minimum-revision-rounds', 'quality-profile', 'languages', 'metric-schema', 'benchmark-id', 'status', 'limit', 'before', 'kind', 'reason', 'parent-campaign-id', 'supersedes-campaign-id', 'recovery-of-campaign-id', 'worker-memory-mib', 'worker-cpu-seconds', 'package-lifecycle-receipt-hash', 'target', 'venue', 'from-venue'];
  const cases = [['unexpected'], ['--'], ['--unknown'], ['--=value'], ['--help='], ['--help', '--unknown'], ['-h']];
  for (const key of booleans) cases.push([`--${key}=true`], [`--${key}`, `--${key}`]);
  for (const key of values) cases.push([`--${key}`], [`--${key}=`], [`--${key}`, ''], [`--${key}`, '--help'], [`--${key}=one`, `--${key}=two`]);
  for (const selected of cases) {
    const node = await fixture.run('node', args(selected), quiet), native = await fixture.run('native', args(selected), quiet, fixture.unknown);
    for (const actual of [node, native]) { assert.equal(actual.status, 1); assert.equal(actual.stdout, ''); }
    const code = /^Error: (.*)$/mu.exec(node.stderr)?.[1]; assert.ok(code, node.stderr); assert.ok(native.stderr.includes(code), native.stderr);
  }
  const all = ['--help', ...booleans.filter(key => key !== 'help').map(key => `--${key}`), ...values.map(key => `--${key}=value`), '--paper=one', '--paper=two', '--dataset=one', '--dataset=two', '--dataset-license=one', '--dataset-authorization=one', '--dataset-harness=one'];
  const node = await fixture.run('node', args(all), quiet), native = await fixture.run('native', args(all), quiet, fixture.unknown);
  assert.equal(node.status, 0, node.stderr); assert.equal(native.status, 0, native.stderr); assert.equal(native.stdout, node.stdout); assert.equal(native.stderr, '');
});
test('normal_campaign_actual_business_tables_default_relative_absolute_summary_details_and_limits_match_raw_node', async () => {
  const runtime = path.join(fixture.root, 'relative-runtime', 'campaign');
  const database = setup(runtime), defaultRuntime = path.resolve(fixture.root, '..', 'hepta-paper-runtime/native-runtime'), defaultDatabase = setup(defaultRuntime);
  for (const env of [{}, { HEPTA_PAPER_RUNTIME_ROOT: '' }]) await pair(['--action=list'], env, defaultDatabase);
  for (const selected of ['relative-runtime/campaign', runtime, 'relative-runtime/./campaign']) {
    const env = { HEPTA_PAPER_RUNTIME_ROOT: selected };
    await pair(['--action=list'], env, database); await pair(['--action=list', '--effective', '--details'], env, database);
    await pair(['--action=status', '--campaign-id=actual-old'], env, database); await pair(['--action=status', '--campaign-id=actual-old', '--details'], env, database);
  }
  const env = { HEPTA_PAPER_RUNTIME_ROOT: runtime };
  for (const limit of ['0', '1', '0x2', 'Infinity', '-Infinity', ' ', '1001']) {
    await pair(['--action=list', `--limit=${limit}`], env, database);
    await pair(['--action=events', '--campaign-id=actual-old', `--limit=${limit}`], env, database);
  }
  await pair(['--action=events', '--campaign-id=actual-old', '--limit=NaN', '--details'], env, database);
  await pair(['--action=events', '--campaign-id=actual-old', '--before=2027', '--details'], env, database);
  const list = await pair(['--action=list', '--status=paused', '--details'], env, database);
  assert.equal(list.result.length, 1); assert.equal(list.result[0].costKnown, false); assert.equal(list.result[0].costUsd, null);
  const filtered = await pair(['--action=list', '--status=paused', '--limit=1', '--effective'], env, database);
  assert.deepEqual(filtered.result, []);
  await pair(['--action=status', '--campaign-id=missing', '--details'], env, database);
  await pair(['--action=status', '--details'], env, database);
  await pair(['--action=logs', '--campaign-id=actual-old', '--node-id=actual-old:running'], env, database);
  await pair(['--action=logs', '--campaign-id=actual-old', '--kind=review'], env, database);
  await pair(['--action=logs', '--campaign-id=actual-old', '--kind=review', '--node-id=actual-old:running'], env, database);
  await pair(['--action=logs', '--campaign-id=actual-old', '--kind=review', '--details'], env, database);
  await pair(['--action=list', '--runtime-root=relative-runtime/campaign', '--root=unused-assets'], {}, database);
  await pair(['--action=list', '--runtime-root', runtime], {}, database);
});
test('normal_campaign_business_refusals_schema_history_and_prepared_binding_preserve_actual_database', async () => {
  const runtime = path.join(fixture.root, 'relative-runtime', 'campaign'), database = path.join(runtime, 'hepta-paper.sqlite');
  const env = { ...quiet, HEPTA_PAPER_RUNTIME_ROOT: runtime };
  const cases = [
    { values: ['--action=status', '--campaign-id=missing'], code: "Cannot read properties of null (reading 'campaignId')" },
    { values: ['--action=logs', '--campaign-id=actual-old'], code: 'campaign node not found for log query' },
    { values: ['--action=list', '--local-only'], code: 'paper_campaign_local_only_mode_invalid' },
    { values: ['--action=list', '--campaign-id=one', '--run-id=two'], code: '--campaign-id and --run-id cannot be combined' },
    { values: ['--action=list', '--write-queue'], code: 'venue_migration_queue_persistence_requires_execute' },
    { values: ['--action=list', '--target=venue'], code: 'venue_migration_source_venue_required' },
    { values: ['--action=list', '--limit=NaN'], code: 'no such column: NaN' },
    { values: ['--action=list', '--limit=1.5'], code: 'datatype mismatch' },
  ];
  for (const { values, code } of cases) {
    const before = fixture.pin(database);
    for (const engine of ['node', 'native']) {
      const actual = await fixture.run(engine, args(values), env);
      assert.equal(actual.status, 1); assert.equal(actual.stdout, ''); assert.ok(actual.stderr.includes(code), actual.stderr);
      assert.deepEqual(fixture.pin(database), before);
    }
  }
  const badRuntime = path.join(fixture.root, 'relative-runtime', 'bad-campaign'), badDatabase = setup(badRuntime);
  const store = createDefaultPaperStore({ root: fixture.root, runtimeRoot: badRuntime, dbPath: badDatabase, targetVersion: 25 });
  assert.equal(store.execute("UPDATE campaign_nodes SET prepared_result_sha256='sha256:bad' WHERE node_id='actual-old:running'").ok, true); store.close();
  for (const engine of ['node', 'native']) {
    const before = fixture.pin(badDatabase), actual = await fixture.run(engine, args(['--action=status', '--campaign-id=actual-old']), { ...quiet, HEPTA_PAPER_RUNTIME_ROOT: badRuntime });
    assert.equal(actual.status, 1); assert.match(actual.stderr, /campaign_prepared_result_hash_invalid/u); assert.deepEqual(fixture.pin(badDatabase), before);
  }
  const schemaRuntime = path.join(fixture.root, 'relative-runtime', 'bad-schema'), schemaDatabase = setup(schemaRuntime);
  const schemaStore = createDefaultPaperStore({ root: fixture.root, runtimeRoot: schemaRuntime, dbPath: schemaDatabase, targetVersion: 25 });
  assert.equal(schemaStore.execute("UPDATE schema_migrations SET migration_sha256='sha256:bad' WHERE version=25").ok, true); schemaStore.close();
  for (const engine of ['node', 'native']) {
    const before = fixture.pin(schemaDatabase), actual = await fixture.run(engine, args(['--action=list']), { ...quiet, HEPTA_PAPER_RUNTIME_ROOT: schemaRuntime });
    assert.equal(actual.status, 1); assert.match(actual.stderr, /scoped_schema_migration_25_history_mismatch/u); assert.deepEqual(fixture.pin(schemaDatabase), before);
  }
});
test('normal_campaign_missing_store_unknown_copy_and_native_writer_alias_refusals_have_no_mutation', async () => {
  const runtime = path.join(fixture.root, 'relative-runtime', 'campaign'), database = path.join(runtime, 'hepta-paper.sqlite');
  for (const engine of ['node', 'native']) {
    const actual = await fixture.run(engine, args(['--action=list', '--runtime-root=actual-missing-runtime']), quiet);
    assert.equal(actual.status, 1); assert.match(actual.stderr, /Read-only paper store missing/u); assert.equal(fs.existsSync(path.join(fixture.root, 'actual-missing-runtime')), false);
  }
  // Native readonly isolation is an explicit finite extension: the original
  // Node bootstrap requires a separately provisioned submission-handoff DB.
  // Neither command grants a dispatch/signing capability here.
  const independentRuntime = path.join(fixture.root, 'relative-runtime', 'without-handoff');
  const independentDatabase = setup(independentRuntime, { handoff: false });
  const independentBefore = fixture.pin(independentDatabase);
  const legacy = await fixture.run('node', args(['--action=list', '--runtime-root', independentRuntime]), quiet);
  assert.equal(legacy.status, 1); assert.match(legacy.stderr, /autonomous_submission_handoff_offline_provisioning_required/u);
  const independent = await fixture.run('native', args(['--action=list', '--runtime-root', independentRuntime]), quiet);
  assert.equal(independent.status, 0, independent.stderr); assert.equal(independent.stderr, '');
  assert.deepEqual(fixture.pin(independentDatabase), independentBefore);
  assert.equal(fs.existsSync(autonomousSubmissionHandoffDatabasePath({ runtimeRoot: independentRuntime })), false);
  const before = fixture.pin(database);
  const unknown = await fixture.run('native', args(['--action=list', '--runtime-root', runtime]), quiet, fixture.unknown);
  assert.equal(unknown.status, 1); assert.match(unknown.stderr, /native_workspace_root_required/u);
  const relocated = await fixture.run('native', args(['--action=list', '--runtime-root', runtime]), { ...quiet, HEPTA_PAPER_WORKSPACE_ROOT: fixture.root }, fixture.unknown);
  assert.equal(relocated.status, 0, relocated.stderr);
  const writer = await fixture.run('native', args(['--action=list', '--apply', '--runtime-root', runtime]), quiet);
  assert.equal(writer.status, 1); assert.match(writer.stderr, /native_campaign_apply_authority_required/u);
  const alias = path.join(fixture.root, 'relative-runtime', 'campaign-alias'); fs.symlinkSync(runtime, alias);
  const refused = await fixture.run('native', args(['--action=list', '--runtime-root', alias]), quiet);
  assert.equal(refused.status, 1); assert.equal(refused.stdout, ''); assert.deepEqual(fixture.pin(database), before);
});
test('normal_campaign_actual_unknown_entry_term_kill_same_namespace_fresh_query', async () => {
  const runtime = path.join(fixture.root, 'relative-runtime', 'campaign'), database = path.join(runtime, 'hepta-paper.sqlite');
  for (const engine of ['node', 'native']) for (const signal of ['SIGTERM', 'SIGKILL']) {
    const before = fixture.snapshot(runtime);
    const interrupted = await fixture.run(engine, args(['--action=status', '--campaign-id=actual-old']), { ...quiet, HEPTA_PAPER_RUNTIME_ROOT: runtime }, fixture.binary, signal);
    assert.equal(interrupted.signal, signal); assert.equal(interrupted.status, null); assert.deepEqual(fixture.snapshot(runtime), before);
    const retry = await fixture.run(engine, args(['--action=status', '--campaign-id=actual-old']), { ...quiet, HEPTA_PAPER_RUNTIME_ROOT: runtime });
    assert.equal(retry.status, 0, retry.stderr); assert.equal(fixture.pin(database).sha256, before.find(row => row.path === 'hepta-paper.sqlite').pin.sha256);
  }
});
