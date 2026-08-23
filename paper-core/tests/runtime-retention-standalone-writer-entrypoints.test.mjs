import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  createRuntimeRetentionPackageDeletionFenceRepository,
} from '../../paper-adapters/automation/runtime-retention-package-deletion-fence-repository.mjs';
import {
  createRuntimeRetentionPackageDeletionWriterBoundary,
} from '../../paper-adapters/automation/runtime-retention-package-deletion-writer-boundary.mjs';
import {
  withArtifactWriteContext,
} from '../../paper-adapters/artifacts/artifact-write-context.mjs';
import {
  createDefaultPaperStore,
  openExistingWritablePaperStore,
} from '../../paper-adapters/persistence/store-provider.mjs';
import {
  createSqliteReceiptLedger,
} from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import {
  repairMainTexRow,
  runPostRepairRechecks,
} from '../../paper-adapters/referee-revise/post-repair.mjs';
import {
  runWithScopedFoundationWriter,
} from '../../paper-composition/bootstrap/context-foundation-composition.mjs';
import {
  composeLegacyStagePorts,
} from '../../paper-composition/compat/legacy-stage-port-composition.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const PREPARED_AT = '2026-08-20T08:00:00.000Z';
const ABORTED_AT = '2026-08-20T08:01:00.000Z';
const TOKEN = 'standalone-writer-entrypoint-fence-token-000000000001';

function h(label) {
  return hashRecord('StandaloneWriterEntrypointTest', { label });
}

function fixture(t, label, packageName = `${label}-package`) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(
    os.tmpdir(),
    `hepta-standalone-writer-${label}-`,
  )));
  const root = path.join(base, 'assets');
  const runtimeRoot = path.join(base, 'runtime');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(runtimeRoot, 'packages'), { recursive: true });
  const packagePath = path.join(runtimeRoot, 'packages', packageName);
  fs.mkdirSync(packagePath);
  fs.writeFileSync(path.join(packagePath, 'marker.txt'), `${label}\n`);
  const store = createDefaultPaperStore({ root, runtimeRoot });
  store.close();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return Object.freeze({ base, packagePath, root, runtimeRoot });
}

function runStandaloneCommand(relativeCommand, roots, extraArguments = []) {
  return spawnSync(process.execPath, [
    path.resolve(relativeCommand),
    ...extraArguments,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEPTA_PAPER_ASSET_ROOT: roots.root,
      HEPTA_PAPER_RUNTIME_ROOT: roots.runtimeRoot,
    },
    timeout: 30_000,
  });
}

function prepareFence(runtimeRoot, packagePath, label) {
  const repository = createRuntimeRetentionPackageDeletionFenceRepository({
    runtimeRoot,
    randomToken: () => TOKEN,
  });
  const prepared = repository.prepare({
    packageLifecycleReceiptHash: h(`${label}:lifecycle`),
    packagePath,
    packageContentHash: h(`${label}:content`),
    deletionIntentHash: h(`${label}:intent`),
    recoveryBindingHash: h(`${label}:recovery`),
    authoritySnapshotHash: h(`${label}:authority`),
    operationId: `standalone:${label}`,
    transitionId: h(`${label}:prepared`),
    preparedAt: PREPARED_AT,
    expectedPreviousFenceHash: null,
    fenceToken: TOKEN,
  });
  return Object.freeze({ prepared, repository });
}

function abortFence(repository, prepared, label) {
  return repository.transition(prepared.handle, {
    expectedRecordHash:
      prepared.record.runtimeRetentionPackageDeletionFenceHash,
    status: 'aborted',
    transitionedAt: ABORTED_AT,
    transitionId: h(`${label}:aborted`),
    abortReasonHash: h(`${label}:rollback-verified`),
  });
}

test('standalone foundation writer rejects before store factory and filesystem callback, then resumes after abort', (t) => {
  const { packagePath, root, runtimeRoot } = fixture(t, 'foundation');
  const source = path.join(packagePath, 'marker.txt');
  const destination = path.join(packagePath, 'renamed.txt');
  const { prepared, repository } = prepareFence(
    runtimeRoot,
    packagePath,
    'foundation',
  );
  let factoryCalls = 0;
  let callbackCalls = 0;
  const run = () => runWithScopedFoundationWriter({
    root,
    runtimeRoot,
    writerId: 'standalone-foundation-test',
    rootKind: 'standalone-foundation-test',
    writerSelector: { packagePath },
    writableStoreFactory: () => {
      factoryCalls += 1;
      return openExistingWritablePaperStore({ root, runtimeRoot });
    },
  }, (services) => {
    callbackCalls += 1;
    assert.equal(Object.hasOwn(
      services,
      'packageDeletionWriterBoundary',
    ), false);
    assert.equal(Object.hasOwn(
      services,
      'packageDeletionWriterOperationId',
    ), false);
    const result = services.store.execute(
      "INSERT OR REPLACE INTO store_metadata(key,value,updated_at) VALUES('standalone-writer-test','allowed','2026-08-20T08:01:00.000Z');",
    );
    assert.equal(result.ok, true, result.error);
    fs.renameSync(source, destination);
    return 'completed';
  });

  assert.throws(run, /reachability_mutation_blocked/);
  assert.equal(factoryCalls, 0);
  assert.equal(callbackCalls, 0);
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(destination), false);

  abortFence(repository, prepared, 'foundation');
  assert.equal(run(), 'completed');
  assert.equal(factoryCalls, 1);
  assert.equal(callbackCalls, 1);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.existsSync(destination), true);
});

test('legacy package and post-repair ports keep raw adapters behind one writer scope', async (t) => {
  const { packagePath, runtimeRoot } = fixture(t, 'legacy');
  const { prepared, repository } = prepareFence(
    runtimeRoot,
    packagePath,
    'legacy',
  );
  const calls = [];
  const noop = async () => null;
  const store = Object.freeze({
    version: 3,
    kind: 'StandaloneWriterLegacyStoreFixture',
    readOnly: false,
    query: () => ({ ok: true, rows: [] }),
    execute: () => ({ ok: true }),
  });
  const registry = Object.freeze({
    runEmpiricalAnalysisAdapter: noop,
    runJournalManageAdapter: noop,
    runLatexBuildAdapter: noop,
    runPackageAdapter: async () => {
      calls.push('package');
      return 'packaged';
    },
    runRefereeReviewAdapter: noop,
    runRefereeReviseAdapter: async (options) => {
      calls.push('referee');
      assert.equal(typeof options.postRepairPackageAdapter, 'function');
      return options.postRepairPackageAdapter(options);
    },
    runResearchVerifyAdapter: noop,
    runSourceAdaptAdapter: noop,
    runVenueResolveAdapter: noop,
    buildFreshRefereePool: noop,
    buildFreshRefereeVerdict: noop,
    buildJournalConferenceRegistry: noop,
    buildJournalConferenceSystemPacket: noop,
    buildJournalRubricPacket: noop,
    buildJournalTargetProfile: noop,
    buildTargetSelectionPolicy: noop,
    buildVenueEvidenceGate: noop,
    buildVenueLifecyclePolicy: noop,
    buildVenueRubricManager: noop,
  });
  const boundary = createRuntimeRetentionPackageDeletionWriterBoundary({
    runtimeRoot,
  });
  const ports = composeLegacyStagePorts({
    registry,
    store,
    includeSubmission: false,
    runtimeRoot,
    packageDeletionWriterBoundary: boundary,
    packageDeletionWriterOperationId: 'store:legacy-writer-test',
  });
  const options = {
    execute: true,
    runtimeRoot,
    row: { task: { paperId: path.basename(packagePath) } },
  };

  await assert.rejects(
    ports.stageExecution.packageArtifacts(options),
    /reachability_mutation_blocked/,
  );
  await assert.rejects(
    ports.stageExecution.refereeRevise(options),
    /reachability_mutation_blocked/,
  );
  assert.deepEqual(calls, []);
  assert.equal(Object.hasOwn(
    ports.stageExecution,
    'packageDeletionWriterBoundary',
  ), false);

  abortFence(repository, prepared, 'legacy');
  assert.equal(await ports.stageExecution.packageArtifacts(options), 'packaged');
  assert.equal(await ports.stageExecution.refereeRevise(options), 'packaged');
  assert.deepEqual(calls, ['package', 'referee', 'package']);
});

test('runtime hygiene does not rename a package under an active fence and resumes after abort', (t) => {
  const { packagePath, root, runtimeRoot } = fixture(
    t,
    'runtime-hygiene',
    'migration_plugin_fixture',
  );
  const { prepared, repository } = prepareFence(
    runtimeRoot,
    packagePath,
    'runtime-hygiene',
  );
  const environment = {
    ...process.env,
    HEPTA_PAPER_ASSET_ROOT: root,
    HEPTA_PAPER_RUNTIME_ROOT: runtimeRoot,
  };
  const run = () => spawnSync(process.execPath, [
    'paper-core/bin/runtime-hygiene.mjs',
    '--execute',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: environment,
    timeout: 30_000,
  });

  const blocked = run();
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /reachability_mutation_blocked/);
  assert.equal(fs.existsSync(packagePath), true);
  const quarantineRoot = path.join(
    runtimeRoot,
    'quarantine',
    'pre-v0.5-runtime-evidence',
  );
  assert.equal(fs.existsSync(quarantineRoot), false);

  abortFence(repository, prepared, 'runtime-hygiene');
  const completed = run();
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  assert.equal(fs.existsSync(packagePath), false);
  assert.equal(fs.readdirSync(quarantineRoot).some((name) =>
    name.startsWith('runtime-migration_plugin_fixture-')), true);
});

test('post-repair rechecks exercise the real fail-closed adapters and persist their report', async (t) => {
  const { root, runtimeRoot } = fixture(t, 'post-repair-rechecks');
  const row = {
    task: {
      paperId: 'post-repair-rechecks',
      taskKey: 'post-repair-rechecks:task',
      title: 'Post-repair recheck fixture',
      paperType: 'systems',
      sourceWorkspace: 'missing-source-workspace',
      mainTex: 'missing-source-workspace/main.tex',
      registry: {},
    },
    state: { evidenceRefs: [] },
  };

  const blocked = await runPostRepairRechecks({ row, execute: false });
  assert.equal(blocked.status, 'post_repair_recheck_blocked');
  assert.deepEqual(blocked.blockers, [
    'post_repair_recheck_execute_required',
    'applied_patch_receipt_not_recorded',
    'runtime_root_required_for_post_repair_rechecks',
  ]);
  assert.equal(repairMainTexRow(row, { targetPath: 'README.md' }), row);

  const writes = [];
  let packageAdapterCalls = 0;
  const report = await withArtifactWriteContext({
    artifactRepositoryFactory: () => ({
      writeJson(candidate, value, options) {
        writes.push({ candidate, value, options });
        return { candidate, value, options };
      },
    }),
  }, () => runPostRepairRechecks({
    root,
    runtimeRoot,
    row,
    agentRepairPatchBundle: {
      targetPath: 'missing-source-workspace/repaired-main.tex',
    },
    appliedPatchReceipt: { status: 'applied_patch_receipt_recorded' },
    execute: true,
    packageAdapter: async () => {
      packageAdapterCalls += 1;
      return { status: 'package_ready', artifactPackage: { submitReady: true } };
    },
  }));

  assert.equal(report.status, 'post_repair_rechecks_blocked');
  assert.equal(report.mainTex, 'missing-source-workspace/repaired-main.tex');
  assert.equal(report.buildRecheck.status, 'build_recheck_blocked');
  assert.equal(report.packageRecheck.status, 'package_rewrite_blocked');
  assert.equal(report.researchRecheck.kind, 'PostRepairResearchRecheck');
  assert.equal(packageAdapterCalls, 0);
  assert.match(report.buildRecheck.buildRecheckHash, /^sha256:/);
  assert.match(report.packageRecheck.packageRecheckHash, /^sha256:/);
  assert.match(report.researchRecheck.researchRecheckHash, /^sha256:/);
  assert.match(report.postRepairRecheckReportHash, /^sha256:/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].value, report);
  assert.equal(writes[0].candidate, path.join(
    runtimeRoot,
    'referee-repair',
    row.task.paperId,
    'POST_REPAIR_RECHECKS.json',
  ));
});

test('automation reconciliation CLI plans and executes against a migrated store', (t) => {
  const roots = fixture(t, 'automation-reconcile-cli');
  const planned = runStandaloneCommand(
    'paper-core/bin/automation-reconcile.mjs',
    roots,
  );
  assert.equal(planned.status, 0, planned.stderr || planned.stdout);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.kind, 'AutomationRuntimeReconciliationPlan');
  assert.equal(plan.status, 'automation_runtime_reconciliation_clean');

  const executed = runStandaloneCommand(
    'paper-core/bin/automation-reconcile.mjs',
    roots,
    ['--execute'],
  );
  assert.equal(executed.status, 0, executed.stderr || executed.stdout);
  const receipt = JSON.parse(executed.stdout);
  assert.equal(receipt.kind, 'AutomationRuntimeReconciliationReceipt');
  assert.equal(receipt.status, 'automation_runtime_reconciled');
  assert.equal(receipt.after.status, 'automation_runtime_reconciliation_clean');

  const duplicateCampaignId = runStandaloneCommand(
    'paper-core/bin/automation-reconcile.mjs',
    roots,
    ['--campaign-id=one', '--campaign-id', 'two'],
  );
  assert.notEqual(duplicateCampaignId.status, 0);
  assert.match(
    duplicateCampaignId.stderr,
    /automation_runtime_reconciliation_campaign_id_duplicate/,
  );
});

test('workspace lineage backfill CLI plans and writes an execution receipt', (t) => {
  const roots = fixture(t, 'workspace-lineage-backfill-cli');
  const planned = runStandaloneCommand(
    'paper-core/bin/workspace-lineage-backfill.mjs',
    roots,
  );
  assert.equal(planned.status, 0, planned.stderr || planned.stdout);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.kind, 'WorkspaceLineageBackfillPlan');
  assert.equal(plan.status, 'workspace_lineage_backfill_ready');

  const executed = runStandaloneCommand(
    'paper-core/bin/workspace-lineage-backfill.mjs',
    roots,
    ['--execute'],
  );
  assert.equal(executed.status, 0, executed.stderr || executed.stdout);
  const receipt = JSON.parse(executed.stdout);
  assert.equal(receipt.kind, 'WorkspaceLineageBackfillReceipt');
  assert.equal(receipt.status, 'workspace_lineage_backfill_completed');
  assert.equal(receipt.workspaceCount, 0);
  assert.equal(fs.existsSync(path.join(
    roots.runtimeRoot,
    'workspace-lineage',
    'WORKSPACE_LINEAGE_BACKFILL_RECEIPT.json',
  )), true);
});

test('receipt-ledger integrity CLI scans and records a clean execution', (t) => {
  const roots = fixture(t, 'repair-receipt-ledger-cli');
  const store = openExistingWritablePaperStore(roots);
  try {
    const ledger = createSqliteReceiptLedger({
      store,
      clock: { nowIso: () => PREPARED_AT },
      writerIdentity: {
        writerId: 'standalone-writer-entrypoint-test',
        writerKind: 'test-fixture',
      },
    });
    ledger.record({
      version: 1,
      kind: 'StandaloneWriterEntrypointSeedReceipt',
      status: 'recorded',
      receiptHash: h('repair-receipt-ledger-cli:valid-receipt'),
    }, {
      stream: 'standalone-writer-entrypoint-test',
      environment: 'test',
      evidenceClass: 'fixture',
    });
  } finally {
    store.close();
  }
  const planned = runStandaloneCommand(
    'paper-core/bin/repair-receipt-ledger-integrity.mjs',
    roots,
  );
  assert.equal(planned.status, 0, planned.stderr || planned.stdout);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.kind, 'ReceiptLedgerIntegrityRepairPlan');
  assert.equal(plan.status, 'receipt_ledger_integrity_clean');
  assert.equal(plan.scannedReceiptCount, 1);
  assert.equal(plan.invalidReceiptCount, 0);

  const executed = runStandaloneCommand(
    'paper-core/bin/repair-receipt-ledger-integrity.mjs',
    roots,
    ['--execute'],
  );
  assert.equal(executed.status, 0, executed.stderr || executed.stdout);
  const report = JSON.parse(executed.stdout);
  assert.equal(report.status, 'receipt_ledger_integrity_repaired');
  assert.equal(report.invalidReceiptCount, 0);
  const receipts = fs.readdirSync(path.join(
    roots.runtimeRoot,
    'store-integrity',
  ));
  assert.equal(receipts.some((name) =>
    name.startsWith('RECEIPT_LEDGER_INTEGRITY_REPAIR_')), true);
});

test('production standalone writers and legacy post-repair retain their static guard wiring', () => {
  const source = (relative) => fs.readFileSync(path.resolve(relative), 'utf8');
  const guarded = new Map([
    ['paper-composition/automation/autonomous-research-supervisor-runtime-composition.mjs',
      'runWithScopedFoundationWriterAsync'],
    ['paper-core/bin/automation-reconcile.mjs',
      'runWithScopedFoundationWriter'],
    ['paper-core/bin/workspace-lineage-backfill.mjs',
      'runWithScopedFoundationWriter'],
    ['paper-core/bin/runtime-hygiene.mjs',
      'runWithScopedFoundationWriter'],
    ['paper-core/bin/repair-receipt-ledger-integrity.mjs',
      'runWithScopedFoundationWriter'],
    ['paper-core/bin/hepta-store.mjs',
      'runWithScopedFoundationWriterAsync'],
  ]);
  for (const [relative, binding] of guarded) {
    assert.match(source(relative), new RegExp(`\\b${binding}\\b`), relative);
  }
  for (const relative of [
    'paper-composition/automation/autonomous-research-supervisor-runtime-composition.mjs',
    'paper-core/bin/automation-reconcile.mjs',
    'paper-core/bin/workspace-lineage-backfill.mjs',
    'paper-core/bin/runtime-hygiene.mjs',
    'paper-core/bin/repair-receipt-ledger-integrity.mjs',
  ]) {
    assert.doesNotMatch(
      source(relative),
      /\bopenExistingWritablePaperStore\b/,
      relative,
    );
  }
  const runtimeHygiene = source('paper-core/bin/runtime-hygiene.mjs');
  assert.match(runtimeHygiene, /writerSelector[\s\S]*migration_plugin_fixture/);
  assert.match(runtimeHygiene, /runRuntimeHygiene[\s\S]*fs\.renameSync/);

  const postRepair = source('paper-adapters/referee-revise/post-repair.mjs');
  assert.doesNotMatch(postRepair, /\brunPackageAdapter\b/);
  assert.match(postRepair, /typeof packageAdapter === 'function'/);
  assert.match(postRepair, /post_repair_package_writer_required/);
  const legacyComposition = source(
    'paper-composition/compat/legacy-stage-port-composition.mjs',
  );
  assert.match(legacyComposition, /writerBoundary\.runAsync/);
  assert.match(legacyComposition, /postRepairPackageAdapter/);
});
