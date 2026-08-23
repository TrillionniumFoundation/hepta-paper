import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { assertExecutionServices, createExecutionContext } from '../../paper-application/execution-context.mjs';
import {
  createDefaultPaperStore,
  createReadOnlyPaperStore,
  openExistingWritablePaperStore,
} from '../../paper-adapters/persistence/store-provider.mjs';
import { bootstrapAutomationContext } from '../../paper-composition/bootstrap/automation-context-bootstrap.mjs';
import { bootstrapBatchInventoryContext } from '../../paper-composition/bootstrap/batch-inventory-context-bootstrap.mjs';
import {
  bootstrapBatchContext,
  bootstrapSubmissionContext,
} from '../../paper-composition/bootstrap/capability-scoped-bootstrap.mjs';
import { bootstrapSubmissionHandoffContext } from '../../paper-composition/bootstrap/submission-handoff-context-bootstrap.mjs';
import {
  convergeAutonomousSubmissionHandoff,
} from '../../paper-composition/bootstrap/autonomous-submission-handoff-migration-composition.mjs';
import { bootstrapLegacyPaperExecutionContext } from '../../paper-composition/compat/legacy-context-bootstrap.mjs';
import {
  composeCampaignWorkerExecution,
  preflightCampaignFormalRuntime,
  resolveCampaignWorkerModelConfiguration,
} from '../../paper-composition/automation/campaign-worker-composition.mjs';
import { executePaperCampaignCommand }
  from '../../paper-composition/automation/paper-campaign-command-composition.mjs';
import {
  inspectAutomationStoreOperationalIntegrity,
  inspectFullResearchQualification,
} from '../../paper-composition/automation/automation-status-inspection.mjs';
import { defaultPaperRuntimeRoot, resolveWorkspaceLayout } from '../../paper-adapters/runtime/workspace-layout.mjs';
import { relativeModuleSpecifiers } from '../verification/javascript-module-specifiers.mjs';
import {
  REQUIRED_SCOPED_SCHEMA_VERSIONS,
} from '../../paper-domain/automation/scoped-schema-version-contract.mjs';

const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const latestScopedSchemaVersion = REQUIRED_SCOPED_SCHEMA_VERSIONS.at(-1);

function relativeImportReachability(entry) {
  const pending = [path.resolve(entry)];
  const reached = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const specifier of relativeModuleSpecifiers(source)) {
      const candidate = path.resolve(path.dirname(file), specifier);
      const resolved = path.extname(candidate) ? candidate : `${candidate}.mjs`;
      if (fs.existsSync(resolved)) pending.push(resolved);
    }
  }
  return [...reached];
}

function temporaryRoots(t, prefix) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'assets');
  const runtimeRoot = path.join(parent, 'runtime');
  fs.mkdirSync(root, { recursive: true });
  return { root, runtimeRoot };
}

function closeContext(context) {
  context?.services?.persistenceSession?.close?.();
}

function testHandoffMutationCoordinator() {
  const coveredDatabaseRoles = Object.freeze(['submission-handoff']);
  return Object.freeze({
    implemented: true,
    coveredDatabaseRoles,
    executeMutation() {
      throw new Error('composition_context_test_handoff_mutation_unexpected');
    },
    recoverPendingMutations() { return Object.freeze([]); },
    inspectStatus() {
      return Object.freeze({
        status: 'externally_fenced_sqlite_mutation_coordinator_ready',
        implemented: true,
        coveredDatabaseRoles,
        blockers: Object.freeze([]),
      });
    },
  });
}

function bootstrapTestAutomationContext(options) {
  return bootstrapAutomationContext({
    ...options,
    submissionHandoffMutationCoordinator: testHandoffMutationCoordinator(),
  });
}

function migrateStore(roots, { targetVersion = latestScopedSchemaVersion } = {}) {
  const store = createDefaultPaperStore({ ...roots, targetVersion });
  const dbPath = store.dbPath;
  if (targetVersion === latestScopedSchemaVersion) {
    convergeAutonomousSubmissionHandoff({
      nativeStore: store,
      runtimeRoot: roots.runtimeRoot,
    });
  }
  store.close();
  return dbPath;
}

function storeSnapshot(dbPath) {
  const directory = path.dirname(dbPath);
  return Object.freeze(Object.fromEntries(fs.readdirSync(directory).sort().map((name) => {
    const candidate = path.join(directory, name);
    return [name, fs.statSync(candidate).isFile()
      ? crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')
      : '<directory>'];
  })));
}

function schemaVersion(roots) {
  const store = createReadOnlyPaperStore({ ...roots, immutable: true });
  try {
    const result = store.query('SELECT coalesce(max(version),0) AS version FROM schema_migrations;');
    assert.equal(result.ok, true);
    return Number(result.rows[0]?.version || 0);
  } finally { store.close(); }
}

function runCampaignCli(roots, extraArguments = []) {
  return spawnSync(process.execPath, [
    path.join(workspaceRoot, 'paper-core', 'bin', 'paper-campaign.mjs'),
    '--root', roots.root,
    '--runtime-root', roots.runtimeRoot,
    ...extraArguments,
  ], { cwd: workspaceRoot, encoding: 'utf8', timeout: 30_000 });
}

function runStoreCli(roots, command = 'migrate') {
  return spawnSync(process.execPath, [
    path.join(workspaceRoot, 'paper-core', 'bin', 'hepta-store.mjs'),
    command,
  ], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HEPTA_PAPER_ASSET_ROOT: roots.root,
      HEPTA_PAPER_RUNTIME_ROOT: roots.runtimeRoot,
    },
  });
}

function runWorkspaceCommand(roots, relativeCommand, extraArguments = []) {
  return spawnSync(process.execPath, [
    path.join(workspaceRoot, relativeCommand),
    ...extraArguments,
  ], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HEPTA_PAPER_ASSET_ROOT: roots.root,
      HEPTA_PAPER_RUNTIME_ROOT: roots.runtimeRoot,
    },
  });
}

function assertNoRawStoreReachable(value, seen = new Set()) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return;
  seen.add(value);
  assert.equal(typeof value.query === 'function' && typeof value.execute === 'function', false, `raw StorePort reachable at ${value.kind || 'service object'}`);
  for (const nested of Object.values(value)) assertNoRawStoreReachable(nested, seen);
}

test('execution contexts require an explicit service profile instead of falling back to legacy authority', () => {
  assert.throws(() => createExecutionContext({
    root: '/asset-root',
    runtimeRoot: '/runtime-root',
    mode: 'fixture',
  }), /Unknown ExecutionContext service profile: undefined/);
  assert.throws(
    () => assertExecutionServices({ services: {} }),
    /Unknown ExecutionContext service profile: undefined/,
  );
});

test('automation bootstrap exposes only automation persistence and no submission authority or delivery capability', (t) => {
  const { root, runtimeRoot } = temporaryRoots(t, 'hepta-automation-context-');
  migrateStore({ root, runtimeRoot });
  const context = bootstrapTestAutomationContext({
    root,
    runtimeRoot,
    mode: 'paper-campaign',
    execute: true,
    serviceOverrides: {
      submissionDeliveryStore: { kind: 'must-not-leak' },
      submissionExecutorDescriptor: { kind: 'must-not-leak' },
      executorResponseVerifier: () => ({ status: 'must-not-leak' }),
      providerCapabilityVerifier: () => ({ status: 'must-not-leak' }),
      authorityVerifier: { kind: 'must-not-leak' },
      campaignReleaseAuthorityRepository: { kind: 'must-not-leak' },
    },
  });
  t.after(() => closeContext(context));
  assert.equal(context.serviceProfile, 'automation');
  assert.equal(context.capabilities.includes('automation-coordination'), true);
  assert.equal(context.services.experimentRegistryAuthorityVerifier.kind, 'ExperimentRegistryAuthorityVerifierPort');
  assert.equal(context.services.experimentRegistryAuthorityVerifier.version, 1);
  assert.equal(context.capabilities.some((capability) => capability.startsWith('submission-')), false);
  assert.equal(Object.hasOwn(context.services, 'store'), false);
  assert.equal(context.safety.rawStoreExposed, false);
  assertNoRawStoreReachable(context.services);
  for (const name of [
    'authorityVerifier',
    'campaignReleaseAuthorityRepository',
    'executorResponseVerifier',
    'paperStageAdapters',
    'providerCapabilityVerifier',
    'submissionDeliveryStore',
    'submissionExecutorDescriptor',
  ]) assert.equal(Object.hasOwn(context.services, name), false, name);
  assert.equal(assertExecutionServices(context), context.services);
  const bootstrapSource = fs.readFileSync(path.join(workspaceRoot, 'paper-composition', 'bootstrap', 'automation-context-bootstrap.mjs'), 'utf8');
  const campaignExecutionBootstrapSource = fs.readFileSync(path.join(workspaceRoot, 'paper-composition', 'bootstrap', 'campaign-execution-context-bootstrap.mjs'), 'utf8');
  const campaignCommandCompositionSource = fs.readFileSync(path.join(workspaceRoot, 'paper-composition', 'automation', 'paper-campaign-command-composition.mjs'), 'utf8');
  const scopedBootstrapSource = fs.readFileSync(path.join(workspaceRoot, 'paper-composition', 'bootstrap', 'capability-scoped-bootstrap.mjs'), 'utf8');
  const campaignSource = fs.readFileSync(path.join(workspaceRoot, 'paper-core', 'bin', 'paper-campaign.mjs'), 'utf8');
  assert.equal(bootstrapSource.includes('paper-adapters/submission'), false);
  assert.equal(scopedBootstrapSource.includes('paperStageAdapters'), false);
  assert.equal(scopedBootstrapSource.includes('legacyRegistry'), false);
  assert.equal(campaignSource.includes("automation/paper-campaign-command-composition.mjs'"), true);
  assert.equal(campaignCommandCompositionSource.includes("bootstrap/campaign-execution-context-bootstrap.mjs'"), true);
  assert.equal(campaignExecutionBootstrapSource.includes("./automation-context-bootstrap.mjs'"), true);
  assert.equal(campaignSource.includes("bootstrap/service-bootstrap.mjs'"), false);
  const reachable = relativeImportReachability(path.join(workspaceRoot, 'paper-composition', 'bootstrap', 'automation-context-bootstrap.mjs'));
  assert.deepEqual(reachable.filter((file) => file.includes(`${path.sep}paper-adapters${path.sep}submission${path.sep}`)), []);
});

test('mutable scoped bootstrap rejects direct and symlinked runtime-root overlap before opening persistence', (t) => {
  const directParent = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-layout-overlap-direct-'));
  t.after(() => fs.rmSync(directParent, { recursive: true, force: true }));
  const directRoot = path.join(directParent, 'assets');
  const nestedRuntime = path.join(directRoot, 'runtime');
  fs.mkdirSync(directRoot, { recursive: true });
  assert.throws(() => bootstrapTestAutomationContext({
    root: directRoot,
    runtimeRoot: nestedRuntime,
    execute: true,
  }), /workspace_layout_not_physically_decoupled:.*assetRoot:runtimeRoot/);
  assert.equal(fs.existsSync(nestedRuntime), false);
  assert.throws(() => bootstrapBatchInventoryContext({
    root: directRoot,
    runtimeRoot: nestedRuntime,
    execute: false,
    writeReport: true,
    readOnly: true,
    allowMissingReadOnlyStore: true,
  }), /workspace_layout_not_physically_decoupled:.*assetRoot:runtimeRoot/);
  assert.equal(fs.existsSync(nestedRuntime), false);
  for (const rejected of [
    runStoreCli({ root: directRoot, runtimeRoot: nestedRuntime }, 'migrate'),
    runWorkspaceCommand(
      { root: directRoot, runtimeRoot: nestedRuntime },
      'paper-core/bin/automation-reconcile.mjs',
      ['--execute'],
    ),
    runWorkspaceCommand(
      { root: directRoot, runtimeRoot: nestedRuntime },
      'paper-core/bin/quarantine-stale-latest.mjs',
    ),
  ]) {
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /workspace_layout_not_physically_decoupled/);
    assert.equal(fs.existsSync(nestedRuntime), false);
  }

  const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-layout-overlap-alias-'));
  t.after(() => fs.rmSync(aliasParent, { recursive: true, force: true }));
  const aliasRoot = path.join(aliasParent, 'assets');
  const internalRuntime = path.join(aliasRoot, 'internal-runtime');
  const runtimeAlias = path.join(aliasParent, 'runtime-alias');
  fs.mkdirSync(internalRuntime, { recursive: true });
  fs.symlinkSync(internalRuntime, runtimeAlias, 'dir');
  assert.throws(() => bootstrapTestAutomationContext({
    root: aliasRoot,
    runtimeRoot: runtimeAlias,
    execute: true,
  }), /workspace_layout_not_physically_decoupled:.*assetRoot:runtimeRoot/);
  assert.throws(() => bootstrapBatchInventoryContext({
    root: aliasRoot,
    runtimeRoot: runtimeAlias,
    execute: false,
    writeReport: true,
    readOnly: true,
    allowMissingReadOnlyStore: true,
  }), /workspace_layout_not_physically_decoupled:.*assetRoot:runtimeRoot/);
  assert.deepEqual(fs.readdirSync(internalRuntime), []);
});

test('execution contexts validate service overrides and factory products at the composition boundary', (t) => {
  const roots = temporaryRoots(t, 'hepta-invalid-context-service-');
  const store = createDefaultPaperStore({
    ...roots,
    targetVersion: latestScopedSchemaVersion,
  });
  convergeAutonomousSubmissionHandoff({
    nativeStore: store,
    runtimeRoot: roots.runtimeRoot,
  });
  t.after(() => store.close());
  for (const forbiddenOverride of [
    'experimentRegistryAuthorityVerifier',
    'operatorDatasetHarnessAuthorityVerifier',
    'independentPdfRebuildVerifier',
    'independentPdfRebuildWorkerRunner',
    'researchExecutionReleaseAttestor',
    'releasePackager',
  ]) {
    assert.throws(
      () => bootstrapTestAutomationContext({
        ...roots,
        execute: true,
        serviceOverrides: { store, [forbiddenOverride]: () => ({ verified: true }) },
      }),
      new RegExp(`automation_${forbiddenOverride}_override_forbidden`),
    );
  }
  assert.throws(
    () => bootstrapTestAutomationContext({
      ...roots,
      execute: true,
      serviceOverrides: { store, campaignStore: { version: 2 } },
    }),
    /automation_mutable_campaignStore_override_forbidden/,
  );
  assert.throws(
    () => bootstrapTestAutomationContext({
      ...roots,
      execute: true,
      serviceOverrides: { store, workspaceRegistry: {} },
    }),
    /automation_mutable_workspaceRegistry_override_forbidden/,
  );

  const context = bootstrapTestAutomationContext({
    ...roots,
    execute: true,
    serviceOverrides: { store, artifactRepositoryFactory: () => ({ kind: 'invalid-artifact-repository' }) },
  });
  assert.throws(
    () => context.services.artifactRepositoryFactory(roots.root),
    /ArtifactRepository\.writeBytes is required/,
  );
});

test('workspace decoupling uses real paths and rejects every source, asset, runtime, or legacy overlap', (t) => {
  if (!process.env.HEPTA_PAPER_RUNTIME_ROOT) {
    assert.equal(
      defaultPaperRuntimeRoot(),
      path.join(path.dirname(workspaceRoot), 'hepta-paper-runtime', 'native-runtime'),
    );
    const defaultLayout = resolveWorkspaceLayout();
    assert.equal(defaultLayout.physicallyDecoupled, true);
    assert.deepEqual(defaultLayout.decouplingBlockers, []);
  }
  const external = temporaryRoots(t, 'hepta-decoupled-layout-');
  const externalLayout = resolveWorkspaceLayout({
    assetRoot: external.root,
    runtimeRoot: external.runtimeRoot,
    legacyRoot: path.join(path.dirname(external.root), 'legacy'),
  });
  assert.equal(externalLayout.physicallyDecoupled, true);
  assert.deepEqual(externalLayout.decouplingBlockers, []);

  const nestedRuntime = path.join(workspaceRoot, '.hepta-missing-runtime-overlap-test');
  assert.equal(fs.existsSync(nestedRuntime), false);
  const nestedLayout = resolveWorkspaceLayout({
    assetRoot: external.root,
    runtimeRoot: nestedRuntime,
    legacyRoot: path.join(path.dirname(external.root), 'legacy'),
  });
  assert.equal(nestedLayout.physicallyDecoupled, false);
  assert.ok(nestedLayout.decouplingBlockers.includes('workspace_layout_paths_overlap:workspaceRoot:runtimeRoot'));

  const rejected = runWorkspaceCommand(
    { root: external.root, runtimeRoot: nestedRuntime },
    'paper-core/bin/workspace-status.mjs',
    ['--require-decoupled'],
  );
  assert.equal(rejected.status, 2, rejected.stderr);
  assert.equal(JSON.parse(rejected.stdout).status, 'hepta_workspace_paths_overlap');

  const linkedRuntime = external.runtimeRoot;
  fs.symlinkSync(nestedRuntime, linkedRuntime, 'dir');
  const linkedLayout = resolveWorkspaceLayout({
    assetRoot: external.root,
    runtimeRoot: linkedRuntime,
    legacyRoot: path.join(path.dirname(external.root), 'legacy'),
  });
  assert.equal(linkedLayout.physicallyDecoupled, false);
  assert.ok(linkedLayout.decouplingBlockers.includes('workspace_layout_paths_overlap:workspaceRoot:runtimeRoot'));

  fs.unlinkSync(linkedRuntime);
  const cycleRuntime = path.join(path.dirname(linkedRuntime), 'runtime-cycle');
  fs.symlinkSync(cycleRuntime, linkedRuntime, 'dir');
  fs.symlinkSync(linkedRuntime, cycleRuntime, 'dir');
  const cyclicLayout = resolveWorkspaceLayout({
    assetRoot: external.root,
    runtimeRoot: linkedRuntime,
    legacyRoot: path.join(path.dirname(external.root), 'legacy'),
  });
  assert.equal(cyclicLayout.physicallyDecoupled, false);
  assert.ok(cyclicLayout.decouplingBlockers.includes('workspace_layout_path_resolution_failed:runtimeRoot'));

  const nonDirectory = path.join(path.dirname(linkedRuntime), 'not-a-directory');
  fs.writeFileSync(nonDirectory, 'not-a-directory');
  const nonDirectoryLayout = resolveWorkspaceLayout({
    assetRoot: external.root,
    runtimeRoot: path.join(nonDirectory, 'runtime'),
    legacyRoot: path.join(path.dirname(external.root), 'legacy'),
  });
  assert.equal(nonDirectoryLayout.physicallyDecoupled, false);
  assert.ok(nonDirectoryLayout.decouplingBlockers.includes('workspace_layout_path_resolution_failed:runtimeRoot'));

  const danglingBridge = path.join(path.dirname(linkedRuntime), 'dangling-bridge');
  fs.symlinkSync(path.join(nestedRuntime, 'child'), danglingBridge, 'dir');
  const traversalRuntime = path.join(path.dirname(linkedRuntime), 'traversal-runtime');
  fs.symlinkSync('dangling-bridge/../runtime', traversalRuntime, 'dir');
  const traversalLayout = resolveWorkspaceLayout({
    assetRoot: external.root,
    runtimeRoot: traversalRuntime,
    legacyRoot: path.join(path.dirname(external.root), 'legacy'),
  });
  assert.equal(traversalLayout.physicallyDecoupled, false);
  assert.ok(traversalLayout.decouplingBlockers.includes('workspace_layout_path_resolution_failed:runtimeRoot'));

  const physicalParent = path.join(path.dirname(linkedRuntime), 'physical-parent');
  const parentAlias = path.join(path.dirname(linkedRuntime), 'parent-alias');
  fs.mkdirSync(physicalParent);
  fs.symlinkSync(physicalParent, parentAlias, 'dir');
  fs.symlinkSync(
    path.relative(physicalParent, nestedRuntime),
    path.join(physicalParent, 'runtime-link'),
    'dir',
  );
  const aliasedParentLayout = resolveWorkspaceLayout({
    assetRoot: external.root,
    runtimeRoot: path.join(parentAlias, 'runtime-link'),
    legacyRoot: path.join(path.dirname(external.root), 'legacy'),
  });
  assert.equal(aliasedParentLayout.physicallyDecoupled, false);
  assert.ok(aliasedParentLayout.decouplingBlockers.includes('workspace_layout_paths_overlap:workspaceRoot:runtimeRoot'));

  const consumerAlias = path.join(path.dirname(linkedRuntime), 'consumer-alias');
  fs.symlinkSync(path.join(workspaceRoot, 'paper-core'), consumerAlias, 'dir');
  const consumerResolvedRuntime = path.join(path.dirname(linkedRuntime), 'consumer-runtime');
  const consumerLayout = resolveWorkspaceLayout({
    assetRoot: external.root,
    runtimeRoot: `${consumerAlias}${path.sep}..${path.sep}${path.basename(consumerResolvedRuntime)}`,
    legacyRoot: path.join(path.dirname(external.root), 'legacy'),
  });
  assert.equal(consumerLayout.runtimeRoot, consumerResolvedRuntime);
  assert.equal(consumerLayout.realPaths.runtimeRoot, consumerResolvedRuntime);
  assert.equal(consumerLayout.physicallyDecoupled, true);
  assert.deepEqual(consumerLayout.decouplingBlockers, []);

  const filesystemRootLayout = resolveWorkspaceLayout({
    assetRoot: external.root,
    runtimeRoot: path.parse(workspaceRoot).root,
    legacyRoot: path.join(path.dirname(external.root), 'legacy'),
  });
  assert.equal(filesystemRootLayout.physicallyDecoupled, false);
  assert.ok(filesystemRootLayout.decouplingBlockers.includes('workspace_layout_paths_overlap:workspaceRoot:runtimeRoot'));

  const filesystemRootAlias = path.join(path.dirname(linkedRuntime), 'filesystem-root-alias');
  fs.symlinkSync(path.parse(workspaceRoot).root, filesystemRootAlias, 'dir');
  const filesystemRootAliasLayout = resolveWorkspaceLayout({
    assetRoot: external.root,
    runtimeRoot: filesystemRootAlias,
    legacyRoot: path.join(path.dirname(external.root), 'legacy'),
  });
  assert.equal(filesystemRootAliasLayout.physicallyDecoupled, false);
  assert.ok(filesystemRootAliasLayout.decouplingBlockers.includes('workspace_layout_paths_overlap:workspaceRoot:runtimeRoot'));
});

test('batch inventory bootstrap is a minimal read/report context with no stage or campaign mutation capability', (t) => {
  const roots = temporaryRoots(t, 'hepta-batch-inventory-context-');
  const context = bootstrapBatchInventoryContext({
    ...roots,
    mode: 'inventory',
    execute: false,
    readOnly: true,
    allowMissingReadOnlyStore: true,
  });
  t.after(() => closeContext(context));
  assert.equal(context.serviceProfile, 'inventory');
  assert.equal(context.capabilities.includes('inventory-read'), true);
  assert.equal(context.services.persistenceSession.available(), false);
  assertNoRawStoreReachable(context.services);
  for (const name of [
    'campaignStore',
    'campaignReleaseAuthorityRepository',
    'journalPolicy',
    'paperStageAdapters',
    'stageExecution',
    'submissionDeliveryStore',
    'workflowStateStore',
  ]) assert.equal(Object.hasOwn(context.services, name), false, name);
  assert.equal(assertExecutionServices(context), context.services);
  assert.equal(fs.existsSync(roots.runtimeRoot), false);
});

test('submission bootstrap owns delivery persistence and submission policies', (t) => {
  const { root, runtimeRoot } = temporaryRoots(t, 'hepta-submission-context-');
  migrateStore({ root, runtimeRoot });
  const context = bootstrapSubmissionContext({ root, runtimeRoot, execute: true });
  t.after(() => closeContext(context));
  assert.equal(context.serviceProfile, 'submission');
  assert.equal(context.capabilities.includes('submission-delivery'), true);
  assert.equal(context.services.submissionDeliveryStore.kind, 'SqliteSubmissionDeliveryStore');
  assert.equal(Object.hasOwn(context.services, 'store'), false);
  assertNoRawStoreReachable(context.services);
  assert.equal(Object.hasOwn(context.services, 'stageExecution'), false);
  assert.equal(Object.hasOwn(context.services, 'journalPolicy'), false);
  assert.equal(Object.hasOwn(context.services, 'paperStageAdapters'), false);
  assert.equal(assertExecutionServices(context), context.services);
});

test('submission handoff bootstrap exposes only a read-only release query capability', (t) => {
  const roots = temporaryRoots(t, 'hepta-submission-handoff-context-');
  const dbPath = migrateStore(roots);
  const before = storeSnapshot(dbPath);
  const context = bootstrapSubmissionHandoffContext(roots);
  assert.equal(context.serviceProfile, 'handoff');
  assert.deepEqual(context.capabilities, ['submission-release-read']);
  assert.deepEqual(Object.keys(context.services).sort(), [
    'campaignReleaseQuery',
    'persistenceSession',
    'schemaVersion',
  ]);
  assert.deepEqual(Object.keys(context.services.campaignReleaseQuery).sort(), [
    'getCurrentRelease',
    'kind',
    'version',
  ]);
  assert.equal(context.services.campaignReleaseQuery.getCurrentRelease({ campaignId: 'missing' }), null);
  assert.equal(Object.hasOwn(context.services.campaignReleaseQuery, 'promoteCompletedRelease'), false);
  assert.equal(Object.hasOwn(context.services.campaignReleaseQuery, 'execute'), false);
  assert.equal(Object.hasOwn(context.services, 'submissionDeliveryStore'), false);
  assert.equal(Object.hasOwn(context.services, 'stageExecution'), false);
  assert.equal(Object.hasOwn(context.services, 'receiptLedger'), false);
  assertNoRawStoreReachable(context.services);
  const reachable = relativeImportReachability(path.join(workspaceRoot, 'paper-core', 'bin', 'paper-submission-handoff.mjs'));
  assert.ok(reachable.some((file) => file.endsWith(`${path.sep}sqlite-campaign-release-query-repository.mjs`)));
  assert.deepEqual(reachable.filter((file) => file.endsWith(`${path.sep}sqlite-campaign-release-authority-repository.mjs`)), []);
  closeContext(context);
  const after = storeSnapshot(dbPath);
  assert.equal(after[path.basename(dbPath)], before[path.basename(dbPath)]);
  assert.equal(fs.existsSync(`${dbPath}-wal`) ? fs.statSync(`${dbPath}-wal`).size : 0, 0);

  assert.throws(() => bootstrapSubmissionHandoffContext({
    ...roots,
    serviceOverrides: {
      campaignReleaseAuthorityRepository: {
        version: 1,
        getCurrentRelease() { return null; },
        promoteCompletedRelease() { return null; },
      },
    },
  }), /submission_handoff_authority_repository_override_forbidden/);

  assert.throws(() => bootstrapSubmissionHandoffContext({
    ...roots,
    serviceOverrides: {
      campaignReleaseQuery: {
        version: 1,
        getCurrentRelease() { return null; },
        promoteCompletedRelease() { return null; },
      },
    },
  }), /CampaignReleaseQueryPort\.promoteCompletedRelease is forbidden/);

  const writableStore = openExistingWritablePaperStore(roots);
  t.after(() => writableStore.close());
  assert.throws(() => bootstrapSubmissionHandoffContext({
    ...roots,
    serviceOverrides: { store: writableStore },
  }), /submission_handoff_read_only_store_required/);
});

test('batch bootstrap selects submission capability by mode and execute flag', (t) => {
  const inventoryRoots = temporaryRoots(t, 'hepta-inventory-context-');
  const inventory = bootstrapBatchContext({
    ...inventoryRoots,
    mode: 'inventory',
    execute: false,
    readOnly: true,
    allowMissingReadOnlyStore: true,
  });
  t.after(() => closeContext(inventory));
  assert.equal(inventory.serviceProfile, 'batch');
  assert.equal(Object.hasOwn(inventory.services, 'store'), false);
  assert.equal(inventory.services.persistenceSession.available(), false);
  assert.equal(inventory.services.schemaVersion.status, 'scoped_schema_gate_unavailable_read_only_store');
  assert.equal(Object.hasOwn(inventory.services, 'submissionDeliveryStore'), false);
  assert.equal(Object.hasOwn(inventory.services, 'submissionExecutorDescriptor'), false);
  assert.equal(Object.hasOwn(inventory.services, 'stageExecution'), false);
  assert.equal(Object.hasOwn(inventory.services, 'journalPolicy'), false);
  assert.equal(Object.hasOwn(inventory.services, 'paperStageAdapters'), false);
  assert.equal(Object.hasOwn(inventory.services, 'workflowStateStore'), false);
  assert.equal(fs.existsSync(inventoryRoots.runtimeRoot), false);

  const dryRunRoots = temporaryRoots(t, 'hepta-submission-dry-run-context-');
  const dryRun = bootstrapBatchContext({
    ...dryRunRoots,
    mode: 'local-dry-run',
    execute: false,
    readOnly: true,
    allowMissingReadOnlyStore: true,
  });
  t.after(() => closeContext(dryRun));
  assert.equal(dryRun.serviceProfile, 'batch');
  assert.equal(dryRun.capabilities.includes('submission-policy'), true);
  assert.equal(dryRun.capabilities.includes('submission-delivery'), false);
  assert.equal(Object.hasOwn(dryRun.services, 'stageExecution'), false);
  assert.equal(Object.hasOwn(dryRun.services, 'journalPolicy'), false);
  assert.equal(Object.hasOwn(dryRun.services, 'paperStageAdapters'), false);
  assert.equal(Object.hasOwn(dryRun.services, 'workflowStateStore'), false);
  assert.equal(Object.hasOwn(dryRun.services, 'submissionDeliveryStore'), false);
  assert.equal(fs.existsSync(dryRunRoots.runtimeRoot), false);

  const reviewedRoots = temporaryRoots(t, 'hepta-reviewed-submit-context-');
  migrateStore(reviewedRoots);
  const reviewed = bootstrapBatchContext({ ...reviewedRoots, mode: 'reviewed-submit', execute: true });
  t.after(() => closeContext(reviewed));
  assert.equal(reviewed.serviceProfile, 'submission');
  assert.equal(reviewed.capabilities.includes('submission-delivery'), true);
  assert.equal(reviewed.services.submissionDeliveryStore.kind, 'SqliteSubmissionDeliveryStore');
});

test('legacy bootstrap remains an explicit full-service compatibility facade', (t) => {
  const { root, runtimeRoot } = temporaryRoots(t, 'hepta-legacy-context-');
  migrateStore({ root, runtimeRoot });
  const context = bootstrapLegacyPaperExecutionContext({ root, runtimeRoot, mode: 'legacy-compatibility-test' });
  t.after(() => closeContext(context));
  assert.equal(context.serviceProfile, 'legacy');
  assert.deepEqual(context.capabilities, ['legacy-full-service-facade']);
  assert.equal(context.services.submissionDeliveryStore.kind, 'SqliteSubmissionDeliveryStore');
  assert.equal(context.services.nativeResearchWorkerJobReceiptStore.kind, 'SqliteJobReceiptStore');
  assert.equal(typeof context.services.paperStageAdapters.runLatexBuildAdapter, 'function');
  assert.equal(context.services.workflowStateStore.kind, 'SqliteWorkflowStateStore');
  assert.equal(context.safety.rawStoreExposed, true);
});

test('workflow_states is composed only for the explicit legacy compatibility projection', (t) => {
  const roots = temporaryRoots(t, 'hepta-legacy-workflow-projection-');
  migrateStore(roots);
  const context = bootstrapBatchContext({
    ...roots,
    mode: 'local-build',
    execute: true,
    options: { legacyWorkflowProjection: true },
  });
  t.after(() => closeContext(context));
  assert.equal(context.services.workflowStateStore.kind, 'SqliteWorkflowStateStore');
  assert.equal(Object.hasOwn(context.services, 'paperStageAdapters'), false);
});

test('uninitialized writable roots fail closed without creating a database', (t) => {
  const roots = temporaryRoots(t, 'hepta-uninitialized-scoped-root-');
  assert.throws(() => bootstrapTestAutomationContext({ ...roots, execute: true }), /Read-only paper store missing/);
  assert.throws(() => bootstrapBatchContext({ ...roots, mode: 'local-build', execute: true }), /Read-only paper store missing/);
  assert.throws(() => bootstrapSubmissionContext({ ...roots, execute: true }), /Read-only paper store missing/);
  assert.throws(() => bootstrapLegacyPaperExecutionContext({ ...roots, mode: 'legacy-uninitialized' }), /paper_store_not_initialized/);
  assert.equal(fs.existsSync(roots.runtimeRoot), false);
});

test('campaign CLI plans without a store but writable execution requires migration and handoff authority', (t) => {
  const roots = temporaryRoots(t, 'hepta-campaign-cli-schema-');
  const planned = runCampaignCli(roots);
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(JSON.parse(planned.stdout).status, 'paper_campaigns_planned');
  assert.equal(fs.existsSync(roots.runtimeRoot), false);

  const uninitializedExecution = runCampaignCli(roots, ['--execute']);
  assert.notEqual(uninitializedExecution.status, 0);
  assert.match(uninitializedExecution.stderr, /Read-only paper store missing/);
  assert.equal(fs.existsSync(roots.runtimeRoot), false);

  const dbPath = migrateStore(roots, { targetVersion: 20 });
  const before = storeSnapshot(dbPath);
  const oldSchemaExecution = runCampaignCli(roots, ['--execute']);
  assert.notEqual(oldSchemaExecution.status, 0);
  assert.match(oldSchemaExecution.stderr, /scoped_schema_migration_21_required/);
  assert.deepEqual(storeSnapshot(dbPath), before);

  migrateStore(roots);
  const initializedExecution = runCampaignCli(roots, ['--execute']);
  assert.notEqual(initializedExecution.status, 0);
  assert.match(initializedExecution.stderr,
    /autonomous_submission_handoff_external_mutation_coordinator_required/);

  const localOnlyExecution = runCampaignCli(roots, [
    '--execute', '--local-only', '--mode', 'local-review-loop',
  ]);
  assert.equal(localOnlyExecution.status, 0, localOnlyExecution.stderr);
  assert.equal(
    JSON.parse(localOnlyExecution.stdout).status,
    'paper_campaign_worker_idle',
  );

  const unsafeLocalOnlyExecution = runCampaignCli(roots, [
    '--execute', '--local-only', '--mode', 'reviewed-submit',
  ]);
  assert.notEqual(unsafeLocalOnlyExecution.status, 0);
  assert.match(unsafeLocalOnlyExecution.stderr, /paper_campaign_local_only_mode_invalid/);

  const paperId = 'local-golden-resource-preflight';
  const draftRoot = path.join(roots.root, 'drafts', paperId);
  fs.mkdirSync(draftRoot, { recursive: true });
  fs.writeFileSync(path.join(draftRoot, 'main.tex'), '\\documentclass{article}\\begin{document}seed\\end{document}\n');
  const mismatchedResourceExecution = runCampaignCli(roots, [
    '--execute', '--inline', '--local-only', '--mode', 'local-review-loop',
    '--paper', paperId, '--agent-slots', '2',
  ]);
  assert.notEqual(mismatchedResourceExecution.status, 0);
  assert.match(mismatchedResourceExecution.stderr, /resource_limit_configuration_mismatch:agent/);
  const store = createReadOnlyPaperStore(roots);
  try {
    const rows = store.query(`SELECT count(*) AS count FROM paper_campaigns WHERE paper_id='${paperId}';`).rows;
    assert.equal(Number(rows[0]?.count || 0), 0);
  } finally { store.close(); }
});

test('campaign command composition covers plan and fail-closed authority branches in one process', async (t) => {
  const roots = temporaryRoots(t, 'hepta-campaign-command-authority-');
  const planned = await executePaperCampaignCommand({ ...roots, options: {} });
  assert.equal(planned.status, 'paper_campaigns_planned');
  await assert.rejects(
    executePaperCampaignCommand(),
    /paper_campaign_command_roots_required/,
  );
  await assert.rejects(
    executePaperCampaignCommand({
      root: '/unused-assets',
      runtimeRoot: '/unused-runtime',
      options: { 'local-only': true },
    }),
    /paper_campaign_local_only_mode_invalid/,
  );
  await assert.rejects(
    executePaperCampaignCommand({
      root: '/unused-assets',
      runtimeRoot: '/unused-runtime',
      options: { 'campaign-id': 'campaign', 'run-id': 'run' },
    }),
    /--campaign-id and --run-id cannot be combined/,
  );
  for (const [options, expected] of [
    [{ 'dataset-license': ['broken'] }, /--dataset-license must use name=SPDX syntax/],
    [{
      'dataset-license': ['sample=MIT', 'sample=Apache-2.0'],
    }, /duplicate --dataset-license name/],
    [{ 'dataset-license': ['unknown=MIT'] }, /dataset metadata references an unknown mount/],
  ]) {
    await assert.rejects(
      executePaperCampaignCommand({ ...roots, options }),
      expected,
    );
  }
});

test('scoped writable roots reject schema 20 read-only and leave database bytes unchanged', (t) => {
  const roots = temporaryRoots(t, 'hepta-scoped-schema-gate-');
  const dbPath = migrateStore(roots, { targetVersion: 20 });
  const before = storeSnapshot(dbPath);
  assert.equal(schemaVersion(roots), 20);
  assert.throws(() => bootstrapTestAutomationContext({ ...roots, execute: true }), /scoped_schema_migration_21_required/);
  assert.throws(() => bootstrapBatchContext({ ...roots, mode: 'local-build', execute: true }), /scoped_schema_migration_21_required/);
  assert.throws(() => bootstrapSubmissionContext({ ...roots, execute: true }), /scoped_schema_migration_21_required/);
  for (const command of [
    'paper-core/bin/runtime-hygiene.mjs',
    'paper-core/bin/workspace-lineage-backfill.mjs',
  ]) {
    const rejected = runWorkspaceCommand(roots, command, ['--execute']);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /scoped_schema_migration_21_required/);
  }
  assert.equal(schemaVersion(roots), 20);
  assert.deepEqual(storeSnapshot(dbPath), before);

  migrateStore(roots);
  for (const createContext of [
    () => bootstrapTestAutomationContext({ ...roots, execute: true }),
    () => bootstrapBatchContext({ ...roots, mode: 'local-build', execute: true }),
    () => bootstrapSubmissionContext({ ...roots, execute: true }),
  ]) {
    const context = createContext();
    assert.equal(context.services.schemaVersion.status, 'scoped_schema_version_verified');
    closeContext(context);
  }
});

test('offline migration rejects outstanding job, campaign, and submission leases without changing schema or bytes', (t) => {
  const roots = temporaryRoots(t, 'hepta-offline-migration-leases-');
  const dbPath = migrateStore(roots, { targetVersion: 20 });
  const store = openExistingWritablePaperStore(roots);
  const seeded = store.execute(`
INSERT INTO jobs(job_id,deduplication_key,kind,status,spec_json,lease_owner,lease_expires_at,created_at,updated_at)
VALUES('job-live','job-live','research','running','{}','worker-a','2099-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
INSERT INTO paper_campaigns(campaign_id,paper_id,status,max_rounds,spec_json,created_at,updated_at)
VALUES('campaign-live','paper-live','running',1,'{}','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
INSERT INTO campaign_nodes(node_id,campaign_id,kind,status,dependencies_json,spec_json,lease_owner,lease_expires_at,created_at,updated_at)
VALUES('node-live','campaign-live','draft','running','[]','{}','worker-b','2099-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
INSERT INTO submission_outbox(message_id,paper_id,dispatch_hash,provider,account_id,nonce,status,payload_json,created_at,updated_at,claimed_by,lease_token,lease_expires_at)
VALUES('message-live','paper-live','dispatch-live','provider','account','nonce-live','in_flight','{}','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','worker-c','lease-c','2099-01-01T00:00:00.000Z');
`);
  assert.equal(seeded.ok, true, seeded.error);
  assert.equal(store.checkpoint({ mode: 'TRUNCATE' }).ok, true);
  store.close();
  const before = storeSnapshot(dbPath);

  const rejectedMigration = runStoreCli(roots);
  assert.notEqual(rejectedMigration.status, 0);
  assert.match(rejectedMigration.stderr, /store_offline_migration_live_leases_present:jobs=1,campaigns=1,submissions=1/);
  assert.equal(schemaVersion(roots), 20);
  assert.deepEqual(storeSnapshot(dbPath), before);

  const drained = openExistingWritablePaperStore(roots);
  assert.equal(drained.execute(`
UPDATE jobs SET status='queued',lease_owner=NULL,lease_expires_at=NULL WHERE job_id='job-live';
UPDATE campaign_nodes SET status='queued',lease_owner=NULL,lease_expires_at=NULL WHERE node_id='node-live';
UPDATE submission_outbox SET status='pending',claimed_by=NULL,lease_token=NULL,lease_expires_at=NULL WHERE message_id='message-live';
`).ok, true);
  drained.close();
  const migrated = runStoreCli(roots);
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.equal(schemaVersion(roots), latestScopedSchemaVersion);
});

test('offline migration rejects an active WAL before opening the database for upgrade', (t) => {
  const roots = temporaryRoots(t, 'hepta-offline-migration-active-wal-');
  const dbPath = migrateStore(roots, { targetVersion: 20 });
  const activeStore = openExistingWritablePaperStore(roots);
  t.after(() => { try { activeStore.close(); } catch { /* already closed */ } });
  const before = storeSnapshot(dbPath);
  const rejectedMigration = runStoreCli(roots);
  assert.notEqual(rejectedMigration.status, 0);
  assert.match(rejectedMigration.stderr, /store_offline_migration_active_wal_present/);
  assert.deepEqual(storeSnapshot(dbPath), before);
  activeStore.close();
  const migrated = runStoreCli(roots);
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.equal(schemaVersion(roots), latestScopedSchemaVersion);
});

test('campaign worker model composition resolves author and reviewer models from environment without CLI flags', () => {
  assert.deepEqual(resolveCampaignWorkerModelConfiguration({
    options: {},
    environment: {
      HEPTA_RESEARCH_AUTHOR_MODEL: 'author-model-from-env',
      HEPTA_FORMAL_REVIEW_MODEL: 'reviewer-model-from-env',
    },
  }), {
    researchAuthorModel: 'author-model-from-env',
    formalReviewModel: 'reviewer-model-from-env',
  });
  assert.deepEqual(resolveCampaignWorkerModelConfiguration({
    options: { model: 'author-cli', 'formal-review-model': 'reviewer-cli' },
    environment: {
      HEPTA_RESEARCH_AUTHOR_MODEL: 'author-env',
      HEPTA_FORMAL_REVIEW_MODEL: 'reviewer-env',
    },
  }), {
    researchAuthorModel: 'author-cli',
    formalReviewModel: 'reviewer-cli',
  });
});

test('executing a formal campaign preflights the pinned Lean runtime before agent composition', () => {
  const plans = [{ nodes: [{ kind: 'writer' }, { kind: 'formal-verify' }] }];
  assert.throws(() => composeCampaignWorkerExecution({
    plans,
    runtimeRoot: '/fixture/runtime',
    campaignExecutionContext: {},
    services: {},
  }), /campaign_formal_execution_intent_required/);
  assert.equal(preflightCampaignFormalRuntime({ plans }), null);
  assert.equal(preflightCampaignFormalRuntime({
    executionRequested: true,
    plans: [{ nodes: [{ kind: 'writer' }] }],
  }), null);
  assert.throws(() => preflightCampaignFormalRuntime({
    executionRequested: true,
    plans,
    environment: {},
  }), /campaign_formal_runtime_preflight_failed:formal_pinned_elan_home_absolute_required/);
  const ready = Object.freeze({
    status: 'formal_pinned_lake_resolved',
    leanExecutable: '/pinned/lean',
    lakeExecutable: '/pinned/lake',
    blockers: Object.freeze([]),
  });
  assert.equal(preflightCampaignFormalRuntime({
    executionRequested: true,
    plans,
    environment: { ELAN_HOME: '/pinned/elan' },
    resolvePinnedRuntime: ({ environment }) => {
      assert.equal(environment.ELAN_HOME, '/pinned/elan');
      return ready;
    },
  }), ready);
});

function automationStatusTestStore({
  quickCheck = 'ok',
  failedCountName = null,
  omitCampaignNodeLeaseColumn = false,
  countForSql = () => 0,
} = {}) {
  const columns = {
    paper_campaigns: ['campaign_id', 'status', 'updated_at'],
    campaign_nodes: ['node_id', 'campaign_id', 'status', ...(omitCampaignNodeLeaseColumn ? [] : ['lease_expires_at'])],
    campaign_events: ['event_id', 'campaign_id', 'kind'],
    automation_resource_leases: ['lease_id', 'expires_at'],
    automation_resource_waiters: ['waiter_id', 'expires_at'],
  };
  return {
    query(sql) {
      if (sql === 'PRAGMA quick_check;') return { ok: true, rows: [{ quick_check: quickCheck }] };
      const tableInfo = sql.match(/^PRAGMA table_info\('([^']+)'\);$/);
      if (tableInfo) return { ok: true, rows: (columns[tableInfo[1]] || []).map((name) => ({ name })) };
      if (failedCountName && sql.includes(failedCountName)) return { ok: false, error: 'injected query failure' };
      return { ok: true, rows: [{ count: countForSql(sql) }] };
    },
  };
}

test('automation status operational inspection verifies quick-check, required schema, and every count query', () => {
  const ready = inspectAutomationStoreOperationalIntegrity({
    store: automationStatusTestStore(),
    now: new Date('2026-07-15T00:00:00.000Z'),
  });
  assert.equal(ready.status, 'automation_store_operational_integrity_verified');
  assert.equal(ready.queryReady, true);
  assert.equal(ready.degraded, false);
  assert.deepEqual(ready.blockers, []);

  const queryFailure = inspectAutomationStoreOperationalIntegrity({
    store: automationStatusTestStore({ failedCountName: 'FROM automation_resource_waiters' }),
    now: new Date('2026-07-15T00:00:00.000Z'),
  });
  assert.equal(queryFailure.queryReady, false);
  assert.equal(queryFailure.degraded, true);
  assert.equal(queryFailure.expiredWaiterCount, null);
  assert.ok(queryFailure.blockers.includes('automation_store_operational_query_failed:expiredWaiterCount'));

  const corruptOrIncomplete = inspectAutomationStoreOperationalIntegrity({
    store: automationStatusTestStore({ quickCheck: 'database disk image is malformed', omitCampaignNodeLeaseColumn: true }),
    now: new Date('2026-07-15T00:00:00.000Z'),
  });
  assert.equal(corruptOrIncomplete.queryReady, false);
  assert.ok(corruptOrIncomplete.blockers.includes('automation_store_quick_check_failed'));
  assert.ok(corruptOrIncomplete.blockers.includes(
    'automation_store_required_columns_missing:campaign_nodes:lease_expires_at',
  ));
});

test('automation status preserves legacy terminal queued evidence without hiding actionable residue', () => {
  const policyCount = (sql) => {
    if (sql.includes("json_extract(c.spec_json,'$.terminalSiblingSettlementPolicyVersion')=1")) return 0;
    if (sql.includes("json_extract(c.spec_json,'$.terminalSiblingSettlementPolicyVersion')=0")) return 2538;
    if (sql.includes('AND NOT (json_type')) return 0;
    if (sql.includes("n.status='queued' AND c.status IN")) return 2538;
    return 0;
  };
  const preserved = inspectAutomationStoreOperationalIntegrity({
    store: automationStatusTestStore({ countForSql: policyCount }),
    now: new Date('2026-08-02T00:00:00.000Z'),
  });
  assert.equal(preserved.terminalCampaignQueuedNodeCount, 2538);
  assert.equal(preserved.reconcilableTerminalCampaignQueuedNodeCount, 0);
  assert.equal(preserved.preservedLegacyTerminalCampaignQueuedNodeCount, 2538);
  assert.equal(preserved.invalidTerminalCampaignSettlementPolicyQueuedNodeCount, 0);
  assert.equal(preserved.status, 'automation_store_operational_integrity_verified');
  assert.equal(preserved.degraded, false);

  const reconcilable = inspectAutomationStoreOperationalIntegrity({
    store: automationStatusTestStore({
      countForSql: (sql) => (
        sql.includes("json_extract(c.spec_json,'$.terminalSiblingSettlementPolicyVersion')=1") ? 1 : 0
      ),
    }),
    now: new Date('2026-08-02T00:00:00.000Z'),
  });
  assert.equal(reconcilable.reconcilableTerminalCampaignQueuedNodeCount, 1);
  assert.equal(reconcilable.status, 'automation_store_operational_integrity_degraded');
  assert.equal(reconcilable.degraded, true);

  const invalidPolicy = inspectAutomationStoreOperationalIntegrity({
    store: automationStatusTestStore({
      countForSql: (sql) => (sql.includes('AND NOT (json_type') ? 1 : 0),
    }),
    now: new Date('2026-08-02T00:00:00.000Z'),
  });
  assert.equal(invalidPolicy.invalidTerminalCampaignSettlementPolicyQueuedNodeCount, 1);
  assert.equal(invalidPolicy.status, 'automation_store_operational_integrity_degraded');
  assert.equal(invalidPolicy.degraded, true);
});

test('automation status classifies terminal settlement policy with SQLite JSON semantics', (t) => {
  const { root, runtimeRoot } = temporaryRoots(t, 'hepta-operational-integrity-policy-');
  const store = createDefaultPaperStore({ root, runtimeRoot });
  t.after(() => store.close());
  const policies = [
    ['missing', '{}'],
    ['legacy-zero', '{"terminalSiblingSettlementPolicyVersion":0}'],
    ['reconcilable-one', '{"terminalSiblingSettlementPolicyVersion":1}'],
    ['integer-two', '{"terminalSiblingSettlementPolicyVersion":2}'],
    ['text-zero', '{"terminalSiblingSettlementPolicyVersion":"0"}'],
    ['real-one', '{"terminalSiblingSettlementPolicyVersion":1.0}'],
    ['boolean-false', '{"terminalSiblingSettlementPolicyVersion":false}'],
    ['json-null', '{"terminalSiblingSettlementPolicyVersion":null}'],
    ['object', '{"terminalSiblingSettlementPolicyVersion":{}}'],
    ['array', '{"terminalSiblingSettlementPolicyVersion":[]}'],
  ];
  const createdAt = '2026-08-02T00:00:00.000Z';
  for (const [id, specJson] of policies) {
    assert.equal(store.execute(`INSERT INTO paper_campaigns(
      campaign_id,paper_id,status,revision,current_round,max_rounds,spec_json,
      created_at,updated_at
    ) VALUES(
      'policy-${id}','paper-${id}','failed',1,0,1,'${specJson}',
      '${createdAt}','${createdAt}'
    );`).ok, true);
    assert.equal(store.execute(`INSERT INTO campaign_nodes(
      node_id,campaign_id,kind,status,dependencies_json,spec_json,created_at,updated_at
    ) VALUES(
      'policy-${id}:node','policy-${id}','agent','queued','[]','{}',
      '${createdAt}','${createdAt}'
    );`).ok, true);
  }

  const classified = inspectAutomationStoreOperationalIntegrity({
    store,
    now: new Date(createdAt),
  });
  assert.equal(classified.queryReady, true);
  assert.equal(classified.terminalCampaignQueuedNodeCount, 10);
  assert.equal(classified.preservedLegacyTerminalCampaignQueuedNodeCount, 2);
  assert.equal(classified.reconcilableTerminalCampaignQueuedNodeCount, 1);
  assert.equal(classified.invalidTerminalCampaignSettlementPolicyQueuedNodeCount, 7);
  assert.equal(classified.status, 'automation_store_operational_integrity_degraded');

  assert.equal(store.execute(`UPDATE campaign_nodes SET status='skipped'
    WHERE campaign_id NOT IN ('policy-missing','policy-legacy-zero');`).ok, true);
  const preservedOnly = inspectAutomationStoreOperationalIntegrity({
    store,
    now: new Date(createdAt),
  });
  assert.equal(preservedOnly.terminalCampaignQueuedNodeCount, 2);
  assert.equal(preservedOnly.preservedLegacyTerminalCampaignQueuedNodeCount, 2);
  assert.equal(preservedOnly.reconcilableTerminalCampaignQueuedNodeCount, 0);
  assert.equal(preservedOnly.invalidTerminalCampaignSettlementPolicyQueuedNodeCount, 0);
  assert.equal(preservedOnly.status, 'automation_store_operational_integrity_verified');
  assert.equal(preservedOnly.degraded, false);

  assert.equal(store.execute(`UPDATE paper_campaigns SET spec_json='{'
    WHERE campaign_id='policy-missing';`).ok, true);
  const malformed = inspectAutomationStoreOperationalIntegrity({
    store,
    now: new Date(createdAt),
  });
  assert.equal(malformed.status, 'automation_store_operational_integrity_blocked');
  assert.equal(malformed.queryReady, false);
  assert.equal(malformed.degraded, true);
  assert.ok(malformed.blockers.includes(
    'automation_store_operational_query_failed:reconcilableTerminalCampaignQueuedNodeCount',
  ));
  assert.ok(malformed.blockers.includes(
    'automation_store_operational_query_failed:preservedLegacyTerminalCampaignQueuedNodeCount',
  ));
  assert.ok(malformed.blockers.includes(
    'automation_store_operational_query_failed:invalidTerminalCampaignSettlementPolicyQueuedNodeCount',
  ));
});

test('full research qualification remains fail-closed without a verified golden micro-campaign receipt', () => {
  const missing = inspectFullResearchQualification();
  assert.equal(missing.ready, false);
  assert.equal(missing.receiptAccepted, false);
  assert.deepEqual(missing.blockers, ['golden_micro_campaign_qualification_receipt_missing']);
  assert.ok(missing.requiredBindings.includes('code_worktree_identity'));
  assert.ok(missing.requiredBindings.includes('formal_reviewer_provider_canary'));
  assert.ok(missing.requiredBindings.includes('independent_hypothesis_prior_art_qualification'));

  const unverified = inspectFullResearchQualification({ qualificationReceipt: { claimed: 'qualified' } });
  assert.equal(unverified.ready, false);
  assert.ok(unverified.blockers.includes('golden_micro_campaign_qualification_receipt_shape_invalid'));
  assert.ok(unverified.blockers.includes('golden_micro_campaign_qualification_receipt_hash_invalid'));
  assert.ok(unverified.blockers.includes('golden_micro_campaign_release_authority_verifier_required'));
});
