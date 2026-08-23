import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildRuntimeRetentionPlan,
  buildRuntimeRetentionReachabilityManifest,
  executeRuntimeRetentionPlan,
  reconcileRuntimeRetentionIntents,
} from '../../paper-adapters/automation/runtime-retention.mjs';
import {
  listRuntimeRetentionEntries,
  retentionMemberHash,
  retentionMemberIdentity,
} from '../../paper-adapters/automation/runtime-retention-scope-repository.mjs';
import {
  removeAuthorizedSealedPackageTreeSync,
} from '../../paper-adapters/automation/runtime-retention-authorized-package-removal.mjs';
import { inspectPackageRecoveryTreeInventorySync }
  from '../../paper-adapters/automation/package-recovery-tree-inventory-repository.mjs';
import {
  retentionRemovalRecoveryBindingForIntent,
  retentionRemovalRecoveryStageName,
} from '../../paper-adapters/automation/runtime-retention-removal-recovery-contract.mjs';
import {
  assertRetentionRemovalLiveStageCapabilitySync,
  prepareRetentionRemovalRecoverySync,
}
  from '../../paper-adapters/automation/runtime-retention-removal-recovery-repository.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { issueRuntimeRetentionWriter } from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { createPackageRecoveryDeletionLeaseFixture }
  from './support/package-recovery-deletion-lease-fixture.mjs';

const GOVERNED_CATEGORIES = [
  'workspace-snapshots',
  'automation-artifacts',
  'packages',
  'artifact-cas',
];

const EVIDENCE_KINDS = Object.freeze({
  'workspace-snapshots': 'workspace_snapshot_superseded_recovery_verified',
  'automation-artifacts': 'artifact_unreachable_complete_inventory',
  packages: 'package_superseded_recovery_verified',
  'artifact-cas': 'cas_prefix_unreachable_complete_inventory',
});

function governedPolicies() {
  return Object.fromEntries(GOVERNED_CATEGORIES.map((category) => [category, {
    maxBytes: 0,
    maxAgeMs: 0,
    keepNewest: 0,
  }]));
}

function publishedPackageLeaseEvidenceBinding(packagePath) {
  let packageRecoveryTreeInventoryHash;
  try {
    packageRecoveryTreeInventoryHash =
      inspectPackageRecoveryTreeInventorySync({ packagePath })
        .inventory.packageRecoveryTreeInventoryHash;
  } catch {
    packageRecoveryTreeInventoryHash = hashRecord(
      'UnsafePackageRecoveryTreeInventoryFixture',
      { path: packagePath },
    );
  }
  return Object.freeze({
    packageLifecycleReceiptHash: hashRecord(
      'PackageLifecycleReceiptFixture',
      { path: packagePath },
    ),
    packageRetentionRecoveryReceiptHash: hashRecord(
      'PackageRetentionRecoveryReceiptFixture',
      { path: packagePath },
    ),
    packageRecoveryDeletionLeaseBindingHash: hashRecord(
      'PackageRecoveryDeletionLeaseBindingFixture',
      { path: packagePath },
    ),
    packageRecoveryTreeInventoryHash,
    packageRecoveryAuthoritySnapshotHash: hashRecord(
      'PackageRecoveryAuthoritySnapshotFixture',
      { path: packagePath },
    ),
    storageAuthorityId: 'fixture-storage-authority',
    storageObjectId: `fixture-object:${path.basename(packagePath)}`,
    storageObjectVersion: 'fixture-version-1',
    storageObjectBytesHash: hashRecord(
      'PackageRecoveryStorageObjectBytesFixture',
      { path: packagePath },
    ),
    retentionLockIdentityHash: hashRecord(
      'PackageRecoveryRetentionLockFixture',
      { path: packagePath },
    ),
    retentionLockVersion: 'fixture-lock-version-1',
    retainUntil: '2036-08-20T00:00:00.000Z',
    storageLedgerReceiptId: 'fixture-storage-ledger-receipt',
    storageLedgerReceiptHash: hashRecord(
      'PackageRecoveryStorageLedgerReceiptFixture',
      { path: packagePath },
    ),
    trustStoreHash: hashRecord(
      'PackageRecoveryTrustStoreFixture',
      { path: packagePath },
    ),
  });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-reachability-'));
  t.after(() => {
    restoreOwnerWrite(root);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const snapshots = path.join(root, 'workspace-snapshots');
  const artifacts = path.join(root, 'automation-artifacts');
  const packages = path.join(root, 'packages');
  const casObjects = path.join(root, 'artifact-cas', 'objects', 'sha256');
  for (const directory of [snapshots, artifacts, packages, casObjects]) fs.mkdirSync(directory, { recursive: true });

  fs.writeFileSync(path.join(snapshots, 'snapshot-old.tar.gz'), 'recoverable snapshot archive\n');
  fs.writeFileSync(path.join(snapshots, 'snapshot-old.manifest.json'), '{"verified":true}\n');
  fs.mkdirSync(path.join(artifacts, 'campaign-old'));
  fs.writeFileSync(path.join(artifacts, 'campaign-old', 'result.json'), '{"result":"old"}\n');
  fs.mkdirSync(path.join(packages, 'paper-old'));
  fs.writeFileSync(path.join(packages, 'paper-old', 'PACKAGE_RECORD.json'), '{"superseded":true}\n');
  fs.mkdirSync(path.join(casObjects, 'aa'));
  fs.writeFileSync(path.join(casObjects, 'aa', 'object'), 'unreachable object\n');

  const entries = Object.fromEntries(GOVERNED_CATEGORIES.map((category) => {
    const listed = listRuntimeRetentionEntries(root, category);
    assert.equal(listed.blocker, null);
    assert.equal(listed.entries.length, 1, category);
    return [category, listed.entries[0]];
  }));
  return { root, entries };
}

function manifestFor({ root, entries, createdAt = '2026-07-21T00:00:00.000Z' }) {
  return buildRuntimeRetentionReachabilityManifest({
    runtimeRoot: root,
    createdAt,
    categories: Object.fromEntries(GOVERNED_CATEGORIES.map((category) => [category, {
      inventoryComplete: true,
      activePaths: [],
      referencedPaths: [],
      releaseDependentPaths: [],
      recoveryProtectedPaths: [],
      deletionEvidence: [{
        path: entries[category].path,
        contentHash: entries[category].contentHash,
        evidenceKind: EVIDENCE_KINDS[category],
        sourceEvidenceHashes: [hashRecord('RetentionReachabilitySourceEvidence', { category })],
        ...(category === 'packages'
          ? publishedPackageLeaseEvidenceBinding(entries[category].path)
          : {}),
      }],
    }])),
  });
}

function trustedRetentionLedger(root) {
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'ledger.sqlite') });
  const clock = { nowIso: () => '2026-07-21T00:00:00.000Z' };
  return {
    store,
    ledger: createSqliteReceiptLedger({ store, clock, issuerCapability: issueRuntimeRetentionWriter() }),
    packageRecoveryDeletionLeasePort:
      createPackageRecoveryDeletionLeaseFixture().port,
  };
}

function fixedManifestProvider(manifest) {
  return Object.freeze({
    createManifest({ createdAt } = {}) {
      assert.equal(createdAt, manifest.createdAt);
      return manifest;
    },
  });
}

function makePackageTreeReadOnly(candidate) {
  const stat = fs.lstatSync(candidate);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(candidate)) {
      makePackageTreeReadOnly(path.join(candidate, name));
    }
    fs.chmodSync(candidate, 0o500);
  } else {
    fs.chmodSync(candidate, 0o400);
  }
}

function restoreOwnerWrite(candidate) {
  if (!fs.existsSync(candidate)) return;
  const stat = fs.lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  fs.chmodSync(candidate, 0o700);
  for (const name of fs.readdirSync(candidate)) {
    restoreOwnerWrite(path.join(candidate, name));
  }
}

function packageRemovalRecoveryBinding(root, packageEntry, identity, index = 0) {
  fs.mkdirSync(path.join(root, 'retention'), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(root, 'retention'), 0o700);
  const intentHash = hashRecord('RuntimeRetentionIntent', { root, index });
  const quarantineName = `.hepta-retention-${hashRecord(
    'RuntimeRetentionQuarantineMember',
    { root, index },
  ).slice(7, 47)}.quarantine`;
  return retentionRemovalRecoveryBindingForIntent({
    operationId: `runtime-retention-test-${index}`,
    runtimeRoot: root,
    runtimeRetentionIntentReceiptHash: intentHash,
  }, {
    authorized: true,
    category: 'packages',
  }, 0, {
    path: packageEntry.path,
    contentHash: packageEntry.contentHash,
    identity,
    quarantineName,
  }, index);
}

test('removal recovery live capability is idempotent and closes fail-closed', (t) => {
  const { root, entries } = fixture(t);
  const packagePath = entries.packages.path;
  makePackageTreeReadOnly(packagePath);
  const packageEntry = listRuntimeRetentionEntries(root, 'packages').entries[0];
  const expectedIdentity = retentionMemberIdentity(packagePath);
  const binding = packageRemovalRecoveryBinding(root, packageEntry, expectedIdentity);
  assert.throws(
    () => assertRetentionRemovalLiveStageCapabilitySync({}, binding),
    /runtime_retention_removal_recovery_stage_capability_invalid/,
  );
  assert.throws(() => prepareRetentionRemovalRecoverySync({
    candidate: null,
    binding,
    expectedIdentity,
  }), /runtime_retention_removal_recovery_preimage_changed/);
  const recovery = prepareRetentionRemovalRecoverySync({
    candidate: packagePath,
    binding,
    expectedIdentity,
  });
  recovery.beginMutation();
  recovery.beginMutation();
  recovery.close();
  recovery.close();
  assert.throws(() => recovery.beginMutation(), /runtime_retention_removal_recovery_closed/);
  restoreOwnerWrite(root);
});

test('new runtime scopes report inventory and quota pressure but protect every unknown entry by default', (t) => {
  const { root, entries } = fixture(t);
  const plan = buildRuntimeRetentionPlan({ runtimeRoot: root, policies: governedPolicies() });

  for (const category of GOVERNED_CATEGORIES) {
    const inventory = plan.categories.find((entry) => entry.category === category);
    assert.equal(inventory.entryCount, 1, category);
    assert.equal(inventory.reachabilityGoverned, true, category);
    assert.equal(inventory.reachabilityInventoryComplete, false, category);
    assert.equal(inventory.reachabilityProtectedCount, 1, category);
    assert.equal(inventory.unknownReferenceProtectedCount, 1, category);
    assert.equal(inventory.quotaPressureBytesBefore, entries[category].bytes, category);
    assert.equal(inventory.quotaPressureBytesAfter, entries[category].bytes, category);
  }
  assert.equal(plan.removals.some((entry) => GOVERNED_CATEGORIES.includes(entry.category)), false);

  const inventoryOnlyManifest = buildRuntimeRetentionReachabilityManifest({
    runtimeRoot: root,
    categories: Object.fromEntries(GOVERNED_CATEGORIES.map((category) => [category, {
      inventoryComplete: true,
      activePaths: [],
      referencedPaths: [],
      releaseDependentPaths: [],
      recoveryProtectedPaths: [],
      deletionEvidence: [],
    }])),
  });
  const inventoryOnly = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    reachabilityManifest: inventoryOnlyManifest,
    policies: governedPolicies(),
  });
  assert.equal(inventoryOnly.removals.some((entry) => GOVERNED_CATEGORIES.includes(entry.category)), false);
  assert.equal(inventoryOnly.categories.filter((entry) => GOVERNED_CATEGORIES.includes(entry.category))
    .every((entry) => entry.reachabilityInventoryComplete && entry.unknownReferenceProtectedCount === 1), true);
});

test('complete reachability evidence closes dry-run and trusted apply for snapshots, artifacts, packages, and CAS prefixes', (t) => {
  const { root, entries } = fixture(t);
  t.after(() => restoreOwnerWrite(root));
  makePackageTreeReadOnly(entries.packages.path);
  const currentEntries = {
    ...entries,
    packages: listRuntimeRetentionEntries(root, 'packages').entries[0],
  };
  const reachabilityManifest = manifestFor({ root, entries: currentEntries });
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    reachabilityManifest,
    policies: governedPolicies(),
  });
  assert.deepEqual(plan.removals.map((entry) => entry.category).sort(), [...GOVERNED_CATEGORIES].sort());
  assert.equal(plan.categories.every((entry) => !GOVERNED_CATEGORIES.includes(entry.category)
    || entry.quotaPressureBytesAfter === 0), true);

  const dryRun = executeRuntimeRetentionPlan(plan);
  assert.equal(dryRun.status, 'runtime_retention_dry_run');
  assert.equal(dryRun.bytesRemoved, 0);
  assert.equal(fs.existsSync(entries['workspace-snapshots'].path), true);

  const { store, ledger, packageRecoveryDeletionLeasePort } =
    trustedRetentionLedger(root);
  t.after(() => store.close());
  const applied = executeRuntimeRetentionPlan(plan, {
    apply: true,
    reachabilityManifest,
    reachabilityManifestProvider: fixedManifestProvider(reachabilityManifest),
    retentionReceiptLedger: ledger,
    packageRecoveryDeletionLeasePort,
  });
  assert.equal(applied.status, 'runtime_retention_applied');
  for (const category of GOVERNED_CATEGORIES) assert.equal(fs.existsSync(entries[category].path), false, category);
  assert.equal(fs.existsSync(entries['workspace-snapshots'].companionPaths[0]), false);
});

test('trusted retention explicitly unseals and removes an authorized immutable package tree', (t) => {
  const { root, entries } = fixture(t);
  const packagePath = entries.packages.path;
  const nested = path.join(packagePath, 'evidence', 'gpu-scientific');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'artifact.json'), '{"immutable":true}\n');
  makePackageTreeReadOnly(packagePath);
  assert.equal(fs.lstatSync(packagePath).mode & 0o222, 0);
  assert.equal(fs.lstatSync(nested).mode & 0o222, 0);

  const currentEntries = {
    ...entries,
    packages: listRuntimeRetentionEntries(root, 'packages').entries[0],
  };
  const reachabilityManifest = manifestFor({ root, entries: currentEntries });
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    reachabilityManifest,
    policies: governedPolicies(),
  });
  const { store, ledger, packageRecoveryDeletionLeasePort } =
    trustedRetentionLedger(root);
  t.after(() => store.close());
  const applied = executeRuntimeRetentionPlan(plan, {
    apply: true,
    reachabilityManifest,
    reachabilityManifestProvider: fixedManifestProvider(reachabilityManifest),
    retentionReceiptLedger: ledger,
    packageRecoveryDeletionLeasePort,
  });

  assert.equal(applied.status, 'runtime_retention_applied');
  assert.equal(applied.removed.find((entry) => entry.category === 'packages')?.removed, true);
  assert.equal(fs.existsSync(packagePath), false);
});

test('authorized package removal preserves a candidate replacement raced after isolation', (t) => {
  const { root, entries } = fixture(t);
  const packagePath = entries.packages.path;
  const nested = path.join(packagePath, 'evidence');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'authorized.json'), '{"authorized":true}\n');
  makePackageTreeReadOnly(packagePath);
  const packageEntry = listRuntimeRetentionEntries(root, 'packages').entries[0];
  const reachabilityManifest = manifestFor({
    root,
    entries: { ...entries, packages: packageEntry },
  });
  const retentionDeletionEvidence = reachabilityManifest.categories
    .find((entry) => entry.category === 'packages').deletionEvidence[0];
  const expectedIdentity = retentionMemberIdentity(packagePath);
  const originalFsyncSync = fs.fsyncSync;
  let replacementInstalled = false;
  fs.fsyncSync = (descriptor) => {
    const result = originalFsyncSync(descriptor);
    const recoveryRoot = path.join(root, 'retention', 'removal-recovery');
    const isolated = fs.existsSync(recoveryRoot)
      && fs.readdirSync(recoveryRoot)
        .some((name) => name.startsWith('.hepta-retention-delete-')
          && fs.existsSync(path.join(recoveryRoot, name, 'package')));
    if (!replacementInstalled && !fs.existsSync(packagePath) && isolated) {
      replacementInstalled = true;
      fs.mkdirSync(packagePath);
      fs.writeFileSync(path.join(packagePath, 'LATER.txt'), 'must survive\n');
      makePackageTreeReadOnly(packagePath);
    }
    return result;
  };
  t.after(() => {
    fs.fsyncSync = originalFsyncSync;
    if (!fs.existsSync(root)) return;
    for (const name of fs.readdirSync(path.dirname(packagePath))) {
      restoreOwnerWrite(path.join(path.dirname(packagePath), name));
    }
  });

  try {
    assert.throws(() => removeAuthorizedSealedPackageTreeSync({
      candidate: packagePath,
      expectedContentHash: packageEntry.contentHash,
      expectedIdentity,
      authorization: {
        authorized: true,
        category: 'packages',
        sourcePath: packagePath,
        retentionDeletionEvidence,
      },
      revalidateAuthorization: () => reachabilityManifest,
      recoveryBinding: packageRemovalRecoveryBinding(root, packageEntry, expectedIdentity),
    }), /runtime_retention_package_removal_(?:source_advanced|failed_and_reseal_failed)/);
  } finally {
    fs.fsyncSync = originalFsyncSync;
  }

  assert.equal(replacementInstalled, true);
  assert.equal(fs.readFileSync(path.join(packagePath, 'LATER.txt'), 'utf8'), 'must survive\n');
  assert.equal(fs.lstatSync(packagePath).mode & 0o222, 0);
  const recoveryRoot = path.join(root, 'retention', 'removal-recovery');
  const isolationNames = fs.readdirSync(recoveryRoot)
    .filter((name) => name.startsWith('.hepta-retention-delete-'));
  assert.equal(isolationNames.length, 1);
  const isolatedPackage = path.join(recoveryRoot, isolationNames[0], 'package');
  assert.equal(fs.readFileSync(path.join(isolatedPackage, 'PACKAGE_RECORD.json'), 'utf8'), '{"superseded":true}\n');
  assert.equal(fs.lstatSync(isolatedPackage).mode & 0o222, 0);
  assert.equal(fs.lstatSync(path.dirname(isolatedPackage)).mode & 0o777, 0o700);
  restoreOwnerWrite(packagePath);
  restoreOwnerWrite(path.join(recoveryRoot, isolationNames[0]));
});

test('authorized package removal rejects a preoccupied recovery stage without replacing it', (t) => {
  const { root, entries } = fixture(t);
  const packagePath = entries.packages.path;
  makePackageTreeReadOnly(packagePath);
  const expectedContentHash = retentionMemberHash(packagePath);
  const expectedIdentity = retentionMemberIdentity(packagePath);
  const packageEntry = listRuntimeRetentionEntries(root, 'packages').entries[0];
  const reachabilityManifest = manifestFor({
    root,
    entries: { ...entries, packages: packageEntry },
  });
  const retentionDeletionEvidence = reachabilityManifest.categories
    .find((entry) => entry.category === 'packages').deletionEvidence[0];
  const recoveryBinding = packageRemovalRecoveryBinding(root, packageEntry, expectedIdentity);
  const recoveryRoot = path.join(root, 'retention', 'removal-recovery');
  const stage = path.join(recoveryRoot, retentionRemovalRecoveryStageName(recoveryBinding));
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  fs.chmodSync(recoveryRoot, 0o700);
  const collision = path.join(stage, 'package');
  fs.mkdirSync(collision);
  fs.writeFileSync(path.join(collision, 'COLLISION.txt'), 'must not be replaced\n');
  makePackageTreeReadOnly(collision);

  assert.throws(() => removeAuthorizedSealedPackageTreeSync({
    candidate: packagePath,
    expectedContentHash,
    expectedIdentity,
    authorization: {
      authorized: true,
      category: 'packages',
      sourcePath: packagePath,
      retentionDeletionEvidence,
    },
    revalidateAuthorization: () => reachabilityManifest,
    recoveryBinding,
  }), /runtime_retention_removal_recovery_pending/);

  assert.equal(fs.readFileSync(path.join(packagePath, 'PACKAGE_RECORD.json'), 'utf8'), '{"superseded":true}\n');
  assert.equal(fs.lstatSync(packagePath).mode & 0o222, 0);
  assert.equal(fs.readFileSync(path.join(collision, 'COLLISION.txt'), 'utf8'), 'must not be replaced\n');
  assert.equal(fs.lstatSync(collision).mode & 0o222, 0);
  restoreOwnerWrite(packagePath);
  restoreOwnerWrite(stage);
});

test('authorized package removal preserves an in-callback child replacement as operator residue', (t) => {
  const { root, entries } = fixture(t);
  const packagePath = entries.packages.path;
  makePackageTreeReadOnly(packagePath);
  const expectedContentHash = retentionMemberHash(packagePath);
  const expectedIdentity = retentionMemberIdentity(packagePath);
  const packageEntry = listRuntimeRetentionEntries(root, 'packages').entries[0];
  const reachabilityManifest = manifestFor({
    root,
    entries: { ...entries, packages: packageEntry },
  });
  const retentionDeletionEvidence = reachabilityManifest.categories
    .find((entry) => entry.category === 'packages').deletionEvidence[0];
  let childReplaced = false;
  const replaceChild = ({ stage }) => {
    if (!childReplaced && stage === 'before_package_tree_first_unlink_revalidation') {
      const recoveryRoot = path.join(root, 'retention', 'removal-recovery');
      const isolationName = fs.readdirSync(recoveryRoot)
        .find((name) => name.startsWith('.hepta-retention-delete-'));
      const isolatedPackage = path.join(recoveryRoot, isolationName, 'package');
      const authorizedChild = path.join(isolatedPackage, 'PACKAGE_RECORD.json');
      const displacedChild = path.join(isolatedPackage, 'PACKAGE_RECORD.authorized-original.json');
      fs.renameSync(authorizedChild, displacedChild);
      fs.writeFileSync(authorizedChild, 'later child must survive\n');
      fs.chmodSync(authorizedChild, 0o400);
      childReplaced = true;
    }
  };

  assert.throws(() => removeAuthorizedSealedPackageTreeSync({
        candidate: packagePath,
        expectedContentHash,
        expectedIdentity,
        authorization: {
          authorized: true,
          category: 'packages',
          sourcePath: packagePath,
          retentionDeletionEvidence,
        },
        revalidateAuthorization: () => reachabilityManifest,
        recoveryBinding: packageRemovalRecoveryBinding(root, packageEntry, expectedIdentity),
        faultInjector: replaceChild,
      }),
      /runtime_retention_package_removal_(?:isolated_tree_changed|failed_and_reseal_failed)/,
    );

  assert.equal(childReplaced, true);
  assert.equal(fs.existsSync(packagePath), true);
  assert.equal(
    fs.readFileSync(path.join(packagePath, 'PACKAGE_RECORD.json'), 'utf8'),
    '{"superseded":true}\n',
  );
  assert.equal(fs.lstatSync(packagePath).mode & 0o222, 0);
  const recoveryRoot = path.join(root, 'retention', 'removal-recovery');
  const recoveryStages = fs.readdirSync(recoveryRoot);
  assert.equal(recoveryStages.length, 1);
  assert.equal(fs.existsSync(path.join(recoveryRoot, recoveryStages[0], 'journal.json')), true);
  assert.equal(fs.existsSync(path.join(recoveryRoot, recoveryStages[0], 'package')), true);
  assert.equal(fs.existsSync(path.join(recoveryRoot, recoveryStages[0], 'rollback')), false);
  restoreOwnerWrite(packagePath);
});

test('package retention never unseals or deletes a sealed tree whose physical preimage changed', (t) => {
  const { root, entries } = fixture(t);
  const packagePath = entries.packages.path;
  const packageFile = path.join(packagePath, 'PACKAGE_RECORD.json');
  makePackageTreeReadOnly(packagePath);
  const currentEntries = {
    ...entries,
    packages: listRuntimeRetentionEntries(root, 'packages').entries[0],
  };
  const reachabilityManifest = manifestFor({ root, entries: currentEntries });
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    reachabilityManifest,
    policies: governedPolicies(),
  });

  fs.chmodSync(packagePath, 0o700);
  fs.chmodSync(packageFile, 0o600);
  fs.writeFileSync(packageFile, '{"superseded":"tampered"}\n');
  fs.chmodSync(packageFile, 0o400);
  fs.symlinkSync('/dev/null', path.join(packagePath, 'UNBOUND.bin'));
  fs.chmodSync(packagePath, 0o500);
  const { store, ledger, packageRecoveryDeletionLeasePort } =
    trustedRetentionLedger(root);
  t.after(() => store.close());
  const applied = executeRuntimeRetentionPlan(plan, {
    apply: true,
    reachabilityManifest,
    reachabilityManifestProvider: fixedManifestProvider(reachabilityManifest),
    retentionReceiptLedger: ledger,
    packageRecoveryDeletionLeasePort,
  });

  assert.equal(applied.status, 'runtime_retention_partially_blocked');
  const packageResult = applied.removed.find((entry) => entry.category === 'packages');
  assert.equal(packageResult.removed, false);
  assert.equal(packageResult.blockers.includes('retention_entry_hash_changed_after_plan'), true);
  assert.equal(fs.existsSync(packagePath), true);
  assert.equal(fs.lstatSync(packagePath).mode & 0o222, 0);
  restoreOwnerWrite(packagePath);
});

test('sealed package unsealing requires explicit trusted deletion authority', (t) => {
  const { entries } = fixture(t);
  const packagePath = entries.packages.path;
  makePackageTreeReadOnly(packagePath);
  const expectedContentHash = retentionMemberHash(packagePath);
  const expectedIdentity = retentionMemberIdentity(packagePath);

  assert.throws(() => removeAuthorizedSealedPackageTreeSync({
    candidate: packagePath,
    expectedContentHash,
    expectedIdentity,
    authorization: {
      authorized: false,
      category: 'packages',
      sourcePath: packagePath,
      retentionDeletionEvidence: null,
    },
  }), /runtime_retention_package_removal_authorization_invalid/);
  assert.equal(fs.existsSync(packagePath), true);
  assert.equal(fs.lstatSync(packagePath).mode & 0o222, 0);
  restoreOwnerWrite(packagePath);
});

test('authorized package retention rejects and restores a sealed hardlinked tree', (t) => {
  const { root, entries } = fixture(t);
  const packagePath = entries.packages.path;
  const packageFile = path.join(packagePath, 'PACKAGE_RECORD.json');
  fs.linkSync(packageFile, path.join(packagePath, 'PACKAGE_RECORD.alias.json'));
  makePackageTreeReadOnly(packagePath);
  const currentEntries = {
    ...entries,
    packages: listRuntimeRetentionEntries(root, 'packages').entries[0],
  };
  const reachabilityManifest = manifestFor({ root, entries: currentEntries });
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    reachabilityManifest,
    policies: governedPolicies(),
  });
  const { store, ledger, packageRecoveryDeletionLeasePort } =
    trustedRetentionLedger(root);
  t.after(() => store.close());

  assert.throws(() => executeRuntimeRetentionPlan(plan, {
    apply: true,
    reachabilityManifest,
    reachabilityManifestProvider: fixedManifestProvider(reachabilityManifest),
    retentionReceiptLedger: ledger,
    packageRecoveryDeletionLeasePort,
  }), /runtime_retention_package_deletion_failed_and_fence_recovery_failed/);
  assert.equal(fs.existsSync(packagePath), true);
  assert.equal(fs.lstatSync(packagePath).mode & 0o222, 0);
  assert.equal(fs.lstatSync(packageFile).nlink, 2);
  assert.equal(fs.readdirSync(path.dirname(packagePath))
    .some((name) => name.endsWith('.quarantine')), false);
  restoreOwnerWrite(packagePath);
});

test('active, referenced, release-dependent, and recovery-protected entries cannot conflict with deletion evidence', (t) => {
  const { root, entries } = fixture(t);
  const protections = {
    'workspace-snapshots': 'activePaths',
    'automation-artifacts': 'referencedPaths',
    packages: 'releaseDependentPaths',
    'artifact-cas': 'recoveryProtectedPaths',
  };
  const categories = Object.fromEntries(GOVERNED_CATEGORIES.map((category) => [category, {
    inventoryComplete: true,
    activePaths: protections[category] === 'activePaths' ? [entries[category].path] : [],
    referencedPaths: protections[category] === 'referencedPaths' ? [entries[category].path] : [],
    releaseDependentPaths: protections[category] === 'releaseDependentPaths' ? [entries[category].path] : [],
    recoveryProtectedPaths: protections[category] === 'recoveryProtectedPaths' ? [entries[category].path] : [],
    deletionEvidence: [],
  }]));
  const protectedManifest = buildRuntimeRetentionReachabilityManifest({
    runtimeRoot: root,
    createdAt: '2026-07-21T00:00:00.000Z',
    categories,
  });
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    reachabilityManifest: protectedManifest,
    policies: governedPolicies(),
  });
  assert.equal(plan.removals.some((entry) => GOVERNED_CATEGORIES.includes(entry.category)), false);
  assert.equal(plan.categories.find((entry) => entry.category === 'workspace-snapshots').activeReferenceProtectedCount, 1);
  assert.equal(plan.categories.find((entry) => entry.category === 'automation-artifacts').referencedProtectedCount, 1);
  assert.equal(plan.categories.find((entry) => entry.category === 'packages').releaseDependencyProtectedCount, 1);
  assert.equal(plan.categories.find((entry) => entry.category === 'artifact-cas').recoveryProtectedCount, 1);
  assert.equal(plan.categories.filter((entry) => GOVERNED_CATEGORIES.includes(entry.category))
    .every((entry) => entry.unknownReferenceProtectedCount === 0), true);

  categories.packages.deletionEvidence = [{
    path: entries.packages.path,
    contentHash: entries.packages.contentHash,
    evidenceKind: EVIDENCE_KINDS.packages,
    sourceEvidenceHashes: [hashRecord('RetentionReachabilitySourceEvidence', { category: 'packages' })],
    ...publishedPackageLeaseEvidenceBinding(entries.packages.path),
  }];
  assert.throws(() => buildRuntimeRetentionReachabilityManifest({ runtimeRoot: root, categories }), /conflicts_with_liveness/);
});

test('artifact CAS inventory rejects a symlinked object hierarchy without reading or deleting the external target', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-cas-scope-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-cas-outside-'));
  t.after(() => {
    restoreOwnerWrite(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'artifact-cas'), { recursive: true });
  const externalPrefix = path.join(outside, 'sha256', 'aa');
  fs.mkdirSync(externalPrefix, { recursive: true });
  const externalObject = path.join(externalPrefix, 'object');
  fs.writeFileSync(externalObject, 'must survive\n');
  fs.symlinkSync(outside, path.join(root, 'artifact-cas', 'objects'));

  const plan = buildRuntimeRetentionPlan({ runtimeRoot: root, policies: governedPolicies() });
  const category = plan.categories.find((entry) => entry.category === 'artifact-cas');
  assert.match(category.scopeBlocker, /scope_not_regular_directory/);
  assert.equal(category.entryCount, 0);
  assert.equal(plan.removals.some((entry) => entry.category === 'artifact-cas'), false);
  assert.equal(fs.readFileSync(externalObject, 'utf8'), 'must survive\n');
});

test('apply rejects a different reachability manifest even when its deletion evidence is otherwise identical', (t) => {
  const { root, entries } = fixture(t);
  const plannedManifest = manifestFor({ root, entries, createdAt: '2026-07-21T00:00:00.000Z' });
  const changedManifest = manifestFor({ root, entries, createdAt: '2026-07-21T00:00:01.000Z' });
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    reachabilityManifest: plannedManifest,
    policies: governedPolicies(),
  });
  const { store, ledger, packageRecoveryDeletionLeasePort } =
    trustedRetentionLedger(root);
  t.after(() => store.close());
  const applied = executeRuntimeRetentionPlan(plan, {
    apply: true,
    reachabilityManifest: changedManifest,
    retentionReceiptLedger: ledger,
    packageRecoveryDeletionLeasePort,
  });
  assert.equal(applied.status, 'runtime_retention_partially_blocked');
  assert.equal(applied.removed.every((entry) => entry.blockers.includes('retention_reachability_manifest_changed_after_plan')), true);
  for (const category of GOVERNED_CATEGORIES) assert.equal(fs.existsSync(entries[category].path), true, category);
});

test('crash recovery restores exact bytes, closes the stale intent, and requires a fresh plan', (t) => {
  const { root, entries } = fixture(t);
  const reachabilityManifest = manifestFor({ root, entries });
  const artifactOnlyPolicies = {
    ...governedPolicies(),
    'workspace-snapshots': { maxBytes: Number.MAX_SAFE_INTEGER, maxAgeMs: Number.MAX_SAFE_INTEGER, keepNewest: 1 },
    packages: { maxBytes: Number.MAX_SAFE_INTEGER, maxAgeMs: Number.MAX_SAFE_INTEGER, keepNewest: 1 },
    'artifact-cas': { maxBytes: Number.MAX_SAFE_INTEGER, maxAgeMs: Number.MAX_SAFE_INTEGER, keepNewest: 1 },
  };
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    reachabilityManifest,
    policies: artifactOnlyPolicies,
  });
  assert.deepEqual(plan.removals.map((entry) => entry.category), ['automation-artifacts']);
  const { store, ledger, packageRecoveryDeletionLeasePort } =
    trustedRetentionLedger(root);
  t.after(() => store.close());
  assert.throws(() => executeRuntimeRetentionPlan(plan, {
    apply: true,
    reachabilityManifest,
    reachabilityManifestProvider: fixedManifestProvider(reachabilityManifest),
    retentionReceiptLedger: ledger,
    packageRecoveryDeletionLeasePort,
    faultInjector(event) {
      if (event.stage === 'after_member_removed') throw new Error('simulated_reachability_gc_crash');
    },
  }), /simulated_reachability_gc_crash/);
  assert.equal(fs.existsSync(entries['automation-artifacts'].path), false);

  const blocked = reconcileRuntimeRetentionIntents({
    runtimeRoot: root,
    retentionReceiptLedger: ledger,
    packageRecoveryDeletionLeasePort,
  });
  assert.equal(blocked.status, 'runtime_retention_recovery_blocked');
  assert.match(blocked.blockers[0].blocker, /reachability_recovery_blocked/);
  const recovered = reconcileRuntimeRetentionIntents({
    runtimeRoot: root,
    reachabilityManifest,
    retentionReceiptLedger: ledger,
    packageRecoveryDeletionLeasePort,
  });
  assert.equal(
    recovered.status,
    'runtime_retention_recovery_complete',
    JSON.stringify(recovered.blockers),
  );
  assert.equal(recovered.recovered[0].status, 'runtime_retention_partially_blocked');
  assert.equal(fs.existsSync(entries['automation-artifacts'].path), true);

  const freshPlan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    reachabilityManifest,
    policies: artifactOnlyPolicies,
  });
  const applied = executeRuntimeRetentionPlan(freshPlan, {
    apply: true,
    reachabilityManifest,
    reachabilityManifestProvider: fixedManifestProvider(reachabilityManifest),
    retentionReceiptLedger: ledger,
    packageRecoveryDeletionLeasePort,
  });
  assert.equal(applied.status, 'runtime_retention_applied');
  assert.equal(fs.existsSync(entries['automation-artifacts'].path), false);
});

test('recovery regenerates live authority and refuses a newly active entry before deletion', (t) => {
  const { root, entries } = fixture(t);
  const originalManifest = manifestFor({ root, entries });
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    reachabilityManifest: originalManifest,
    policies: {
      ...governedPolicies(),
      'workspace-snapshots': { maxBytes: Number.MAX_SAFE_INTEGER, maxAgeMs: Number.MAX_SAFE_INTEGER, keepNewest: 1 },
      packages: { maxBytes: Number.MAX_SAFE_INTEGER, maxAgeMs: Number.MAX_SAFE_INTEGER, keepNewest: 1 },
      'artifact-cas': { maxBytes: Number.MAX_SAFE_INTEGER, maxAgeMs: Number.MAX_SAFE_INTEGER, keepNewest: 1 },
    },
  });
  const target = entries['automation-artifacts'];
  const currentManifest = buildRuntimeRetentionReachabilityManifest({
    runtimeRoot: root,
    createdAt: originalManifest.createdAt,
    categories: Object.fromEntries(originalManifest.categories.map((category) => [category.category, {
      ...category,
      activePaths: category.category === 'automation-artifacts' ? [target.path] : category.activePaths,
      deletionEvidence: category.category === 'automation-artifacts' ? [] : category.deletionEvidence,
    }])),
  });
  const { store, ledger, packageRecoveryDeletionLeasePort } =
    trustedRetentionLedger(root);
  t.after(() => store.close());
  assert.throws(() => executeRuntimeRetentionPlan(plan, {
    apply: true,
    reachabilityManifest: originalManifest,
    reachabilityManifestProvider: fixedManifestProvider(originalManifest),
    retentionReceiptLedger: ledger,
    packageRecoveryDeletionLeasePort,
    faultInjector(event) {
      if (event.stage === 'after_intent_recorded') throw new Error('simulated_pre_delete_crash');
    },
  }), /simulated_pre_delete_crash/);

  const recovered = reconcileRuntimeRetentionIntents({
    runtimeRoot: root,
    reachabilityManifest: originalManifest,
    reachabilityManifestProvider: fixedManifestProvider(currentManifest),
    retentionReceiptLedger: ledger,
    packageRecoveryDeletionLeasePort,
  });
  assert.equal(recovered.status, 'runtime_retention_recovery_blocked');
  assert.match(recovered.blockers[0].blocker, /live_reachability_authority_changed/);
  assert.equal(fs.existsSync(target.path), true);
});

test('authorized package removal fails closed across validation and physical-tree TOCTOU branches', (t) => {
  const authorityFor = ({ root, entries }) => {
    const packageEntry = listRuntimeRetentionEntries(root, 'packages').entries[0];
    const manifest = manifestFor({
      root,
      entries: { ...entries, packages: packageEntry },
    });
    const retentionDeletionEvidence = manifest.categories
      .find((entry) => entry.category === 'packages').deletionEvidence[0];
    return {
      root,
      packageEntry,
      manifest,
      authorization: {
        authorized: true,
        category: 'packages',
        sourcePath: packageEntry.path,
        retentionDeletionEvidence,
      },
    };
  };
  const invoke = ({ root, packageEntry, manifest, authorization }, overrides = {}) => {
    const expectedIdentity = retentionMemberIdentity(packageEntry.path);
    return removeAuthorizedSealedPackageTreeSync({
      candidate: packageEntry.path,
      expectedContentHash: packageEntry.contentHash,
      expectedIdentity,
      authorization,
      revalidateAuthorization: () => manifest,
      recoveryBinding: packageRemovalRecoveryBinding(
        root,
        packageEntry,
        expectedIdentity,
        1,
      ),
      ...overrides,
    });
  };

  {
    const { root, entries } = fixture(t);
    makePackageTreeReadOnly(entries.packages.path);
    const authority = authorityFor({ root, entries });
    assert.throws(
      () => invoke(authority, { revalidateAuthorization: undefined }),
      /runtime_retention_package_removal_live_authority_required/,
    );
    assert.throws(
      () => invoke(authority, { candidate: path.parse(root).root }),
      /runtime_retention_package_removal_preimage_changed/,
    );
    assert.throws(
      () => invoke(authority, { candidate: undefined }),
      /runtime_retention_package_removal_preimage_changed/,
    );
    const regularFileCandidate = path.join(root, 'not-a-package-directory');
    fs.writeFileSync(regularFileCandidate, 'must not be removed\n');
    assert.throws(
      () => invoke(authority, { candidate: regularFileCandidate }),
      /runtime_retention_package_removal_preimage_changed/,
    );
    assert.equal(fs.readFileSync(regularFileCandidate, 'utf8'), 'must not be removed\n');
    assert.equal(fs.existsSync(entries.packages.path), true);
    restoreOwnerWrite(entries.packages.path);
  }

  {
    const { root, entries } = fixture(t);
    const authority = authorityFor({ root, entries });
    assert.throws(
      () => invoke(authority),
      /runtime_retention_package_removal_tree_not_sealed/,
    );
    assert.equal(fs.existsSync(entries.packages.path), true);
  }

  {
    const { root, entries } = fixture(t);
    const packagePath = entries.packages.path;
    fs.symlinkSync('PACKAGE_RECORD.json', path.join(packagePath, 'PACKAGE_RECORD.link'));
    fs.chmodSync(path.join(packagePath, 'PACKAGE_RECORD.json'), 0o400);
    fs.chmodSync(packagePath, 0o500);
    const authority = authorityFor({ root, entries });
    assert.throws(
      () => invoke(authority),
      /runtime_retention_package_removal_entry_unsafe/,
    );
    assert.equal(fs.existsSync(packagePath), true);
    restoreOwnerWrite(packagePath);
  }

  {
    const { root, entries } = fixture(t);
    const packagePath = entries.packages.path;
    const nested = path.join(packagePath, 'nested');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'evidence.json'), '{}\n');
    makePackageTreeReadOnly(packagePath);
    const authority = authorityFor({ root, entries });
    let driftInjected = false;
    assert.throws(
      () => invoke(authority, {
        revalidateAuthorization: () => {
          if (!driftInjected) {
            fs.chmodSync(nested, 0o700);
            driftInjected = true;
          }
          return authority.manifest;
        },
      }),
      /runtime_retention_package_removal_tree_not_sealed/,
    );
    assert.equal(driftInjected, true);
    assert.equal(fs.existsSync(packagePath), true);
    restoreOwnerWrite(packagePath);
  }

  {
    const { root, entries } = fixture(t);
    const packagePath = entries.packages.path;
    const packageRecord = path.join(packagePath, 'PACKAGE_RECORD.json');
    const replacementSource = path.join(root, 'replacement-source.json');
    makePackageTreeReadOnly(packagePath);
    const authority = authorityFor({ root, entries });
    let replacementInjected = false;
    assert.throws(
      () => invoke(authority, {
        revalidateAuthorization: () => {
          if (!replacementInjected) {
            fs.chmodSync(packagePath, 0o700);
            fs.renameSync(packageRecord, replacementSource);
            fs.writeFileSync(packageRecord, '{"superseded":true}\n');
            fs.chmodSync(packageRecord, 0o400);
            fs.chmodSync(packagePath, 0o500);
            replacementInjected = true;
          }
          return authority.manifest;
        },
      }),
      /runtime_retention_package_removal_(?:entry_identity_changed|failed_and_reseal_failed)/,
    );
    assert.equal(replacementInjected, true);
    assert.equal(fs.existsSync(packagePath), true);
    assert.equal(fs.existsSync(replacementSource), true);
    restoreOwnerWrite(packagePath);
  }

  {
    const { root, entries } = fixture(t);
    const packagePath = entries.packages.path;
    const packageRecord = path.join(packagePath, 'PACKAGE_RECORD.json');
    makePackageTreeReadOnly(packagePath);
    const authority = authorityFor({ root, entries });
    let modeDriftInjected = false;
    assert.throws(
      () => invoke(authority, {
        revalidateAuthorization: () => {
          if (!modeDriftInjected) {
            fs.chmodSync(packageRecord, 0o600);
            modeDriftInjected = true;
          }
          return authority.manifest;
        },
      }),
      /runtime_retention_package_removal_tree_not_sealed/,
    );
    assert.equal(modeDriftInjected, true);
    assert.equal(fs.existsSync(packagePath), true);
    restoreOwnerWrite(packagePath);
  }
});
