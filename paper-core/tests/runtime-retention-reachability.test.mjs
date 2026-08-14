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
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { issueRuntimeRetentionWriter } from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

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

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-reachability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

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
  const reachabilityManifest = manifestFor({ root, entries });
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

  const { store, ledger } = trustedRetentionLedger(root);
  t.after(() => store.close());
  const applied = executeRuntimeRetentionPlan(plan, {
    apply: true,
    reachabilityManifest,
    reachabilityManifestProvider: fixedManifestProvider(reachabilityManifest),
    retentionReceiptLedger: ledger,
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
  const { store, ledger } = trustedRetentionLedger(root);
  t.after(() => store.close());
  const applied = executeRuntimeRetentionPlan(plan, {
    apply: true,
    reachabilityManifest,
    reachabilityManifestProvider: fixedManifestProvider(reachabilityManifest),
    retentionReceiptLedger: ledger,
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
  const originalFsyncSync = fs.fsyncSync;
  let replacementInstalled = false;
  fs.fsyncSync = (descriptor) => {
    const result = originalFsyncSync(descriptor);
    const isolated = fs.existsSync(path.dirname(packagePath))
      && fs.readdirSync(path.dirname(packagePath))
        .some((name) => name.startsWith('.hepta-retention-package-delete-')
          && fs.existsSync(path.join(path.dirname(packagePath), name, 'package')));
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
      expectedIdentity: retentionMemberIdentity(packagePath),
      authorization: {
        authorized: true,
        category: 'packages',
        sourcePath: packagePath,
        retentionDeletionEvidence,
      },
    }), /runtime_retention_package_removal_source_advanced/);
  } finally {
    fs.fsyncSync = originalFsyncSync;
  }

  assert.equal(replacementInstalled, true);
  assert.equal(fs.readFileSync(path.join(packagePath, 'LATER.txt'), 'utf8'), 'must survive\n');
  assert.equal(fs.lstatSync(packagePath).mode & 0o222, 0);
  const isolationNames = fs.readdirSync(path.dirname(packagePath))
    .filter((name) => name.startsWith('.hepta-retention-package-delete-'));
  assert.equal(isolationNames.length, 1);
  const isolatedPackage = path.join(path.dirname(packagePath), isolationNames[0], 'package');
  assert.equal(fs.readFileSync(path.join(isolatedPackage, 'PACKAGE_RECORD.json'), 'utf8'), '{"superseded":true}\n');
  assert.equal(fs.lstatSync(isolatedPackage).mode & 0o222, 0);
  assert.equal(fs.lstatSync(path.dirname(isolatedPackage)).mode & 0o222, 0);
  restoreOwnerWrite(packagePath);
  restoreOwnerWrite(path.join(path.dirname(packagePath), isolationNames[0]));
});

test('authorized package removal rejects a preoccupied isolation destination without replacing it', (t) => {
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
  const originalMkdtempSync = fs.mkdtempSync;
  let collisionInstalled = false;
  fs.mkdtempSync = (prefix, ...args) => {
    const created = originalMkdtempSync(prefix, ...args);
    if (!collisionInstalled
      && String(prefix).includes('.hepta-retention-package-delete-')) {
      collisionInstalled = true;
      const collision = path.join(created, 'package');
      fs.mkdirSync(collision);
      fs.writeFileSync(path.join(collision, 'COLLISION.txt'), 'must not be replaced\n');
      makePackageTreeReadOnly(collision);
    }
    return created;
  };
  t.after(() => { fs.mkdtempSync = originalMkdtempSync; });

  try {
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
    }), /runtime_retention_package_removal_no_replace_move_failed/);
  } finally {
    fs.mkdtempSync = originalMkdtempSync;
  }

  assert.equal(collisionInstalled, true);
  assert.equal(fs.readFileSync(path.join(packagePath, 'PACKAGE_RECORD.json'), 'utf8'), '{"superseded":true}\n');
  assert.equal(fs.lstatSync(packagePath).mode & 0o222, 0);
  const isolationName = fs.readdirSync(path.dirname(packagePath))
    .find((name) => name.startsWith('.hepta-retention-package-delete-'));
  const collision = path.join(path.dirname(packagePath), isolationName, 'package');
  assert.equal(fs.readFileSync(path.join(collision, 'COLLISION.txt'), 'utf8'), 'must not be replaced\n');
  assert.equal(fs.lstatSync(collision).mode & 0o222, 0);
  restoreOwnerWrite(packagePath);
  restoreOwnerWrite(path.join(path.dirname(packagePath), isolationName));
});

test('authorized package removal preserves a child replacement injected before its isolation move', (t) => {
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
  const originalMkdtempSync = fs.mkdtempSync;
  let childReplaced = false;
  fs.mkdtempSync = (prefix, ...args) => {
    const created = originalMkdtempSync(prefix, ...args);
    if (!childReplaced && String(prefix).endsWith('/.entry-')) {
      const isolationName = fs.readdirSync(path.dirname(packagePath))
        .find((name) => name.startsWith('.hepta-retention-package-delete-'));
      const isolatedPackage = path.join(path.dirname(packagePath), isolationName, 'package');
      const authorizedChild = path.join(isolatedPackage, 'PACKAGE_RECORD.json');
      const displacedChild = path.join(isolatedPackage, 'PACKAGE_RECORD.authorized-original.json');
      fs.renameSync(authorizedChild, displacedChild);
      fs.writeFileSync(authorizedChild, 'later child must survive\n');
      fs.chmodSync(authorizedChild, 0o400);
      childReplaced = true;
    }
    return created;
  };
  t.after(() => { fs.mkdtempSync = originalMkdtempSync; });

  try {
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
    }), /runtime_retention_package_removal_failed_and_reseal_failed/);
  } finally {
    fs.mkdtempSync = originalMkdtempSync;
  }

  assert.equal(childReplaced, true);
  assert.equal(fs.existsSync(packagePath), false);
  const isolationName = fs.readdirSync(path.dirname(packagePath))
    .find((name) => name.startsWith('.hepta-retention-package-delete-'));
  const isolatedPackage = path.join(path.dirname(packagePath), isolationName, 'package');
  assert.equal(fs.readFileSync(path.join(isolatedPackage, 'PACKAGE_RECORD.json'), 'utf8'), 'later child must survive\n');
  assert.equal(fs.readFileSync(
    path.join(isolatedPackage, 'PACKAGE_RECORD.authorized-original.json'),
    'utf8',
  ), '{"superseded":true}\n');
  assert.equal(fs.lstatSync(isolatedPackage).mode & 0o222, 0);
  restoreOwnerWrite(path.join(path.dirname(packagePath), isolationName));
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
  const { store, ledger } = trustedRetentionLedger(root);
  t.after(() => store.close());
  const applied = executeRuntimeRetentionPlan(plan, {
    apply: true,
    reachabilityManifest,
    reachabilityManifestProvider: fixedManifestProvider(reachabilityManifest),
    retentionReceiptLedger: ledger,
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
  const { store, ledger } = trustedRetentionLedger(root);
  t.after(() => store.close());

  assert.throws(() => executeRuntimeRetentionPlan(plan, {
    apply: true,
    reachabilityManifest,
    reachabilityManifestProvider: fixedManifestProvider(reachabilityManifest),
    retentionReceiptLedger: ledger,
  }), /runtime_retention_package_removal_tree_not_sealed/);
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
  }];
  assert.throws(() => buildRuntimeRetentionReachabilityManifest({ runtimeRoot: root, categories }), /conflicts_with_liveness/);
});

test('artifact CAS inventory rejects a symlinked object hierarchy without reading or deleting the external target', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-cas-scope-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-cas-outside-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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
  const { store, ledger } = trustedRetentionLedger(root);
  t.after(() => store.close());
  const applied = executeRuntimeRetentionPlan(plan, {
    apply: true,
    reachabilityManifest: changedManifest,
    retentionReceiptLedger: ledger,
  });
  assert.equal(applied.status, 'runtime_retention_partially_blocked');
  assert.equal(applied.removed.every((entry) => entry.blockers.includes('retention_reachability_manifest_changed_after_plan')), true);
  for (const category of GOVERNED_CATEGORIES) assert.equal(fs.existsSync(entries[category].path), true, category);
});

test('crash recovery refuses missing reachability evidence and converges once the original manifest is restored', (t) => {
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
  const { store, ledger } = trustedRetentionLedger(root);
  t.after(() => store.close());
  assert.throws(() => executeRuntimeRetentionPlan(plan, {
    apply: true,
    reachabilityManifest,
    reachabilityManifestProvider: fixedManifestProvider(reachabilityManifest),
    retentionReceiptLedger: ledger,
    faultInjector(event) {
      if (event.stage === 'after_member_removed') throw new Error('simulated_reachability_gc_crash');
    },
  }), /simulated_reachability_gc_crash/);
  assert.equal(fs.existsSync(entries['automation-artifacts'].path), false);

  const blocked = reconcileRuntimeRetentionIntents({ runtimeRoot: root, retentionReceiptLedger: ledger });
  assert.equal(blocked.status, 'runtime_retention_recovery_blocked');
  assert.match(blocked.blockers[0].blocker, /reachability_recovery_blocked/);
  const recovered = reconcileRuntimeRetentionIntents({
    runtimeRoot: root,
    reachabilityManifest,
    retentionReceiptLedger: ledger,
  });
  assert.equal(recovered.status, 'runtime_retention_recovery_complete');
  assert.equal(recovered.recovered[0].status, 'runtime_retention_applied');
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
  const { store, ledger } = trustedRetentionLedger(root);
  t.after(() => store.close());
  assert.throws(() => executeRuntimeRetentionPlan(plan, {
    apply: true,
    reachabilityManifest: originalManifest,
    reachabilityManifestProvider: fixedManifestProvider(originalManifest),
    retentionReceiptLedger: ledger,
    faultInjector(event) {
      if (event.stage === 'after_intent_recorded') throw new Error('simulated_pre_delete_crash');
    },
  }), /simulated_pre_delete_crash/);

  const recovered = reconcileRuntimeRetentionIntents({
    runtimeRoot: root,
    reachabilityManifest: originalManifest,
    reachabilityManifestProvider: fixedManifestProvider(currentManifest),
    retentionReceiptLedger: ledger,
  });
  assert.equal(recovered.status, 'runtime_retention_recovery_blocked');
  assert.match(recovered.blockers[0].blocker, /live_reachability_authority_changed/);
  assert.equal(fs.existsSync(target.path), true);
});
