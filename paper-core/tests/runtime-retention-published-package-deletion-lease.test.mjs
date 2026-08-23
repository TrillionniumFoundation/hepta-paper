import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { inspectPackageRecoveryTreeInventorySync }
  from '../../paper-adapters/automation/package-recovery-tree-inventory-repository.mjs';
import { executeRuntimeRetentionPlan }
  from '../../paper-adapters/automation/runtime-retention.mjs';
import { createPackageRetentionLegalHoldReceipt }
  from '../../paper-domain/automation/package-lifecycle-authority-contract.mjs';
import { packageRecoveryLiveAuthoritySnapshotHash }
  from '../../paper-ports/package-recovery-authority-port.mjs';
import {
  assertFailedPackageRemovalLeftNoTombstone,
  campaignRecord,
  createLivePackageRetentionFixture as livePackageRetentionFixture,
  createPackageCasReference,
  hashTestValue as h,
  reconcileLivePackageRetention,
  recordPackageAuthorityReceipt,
  retentionTombstoneCount,
} from './support/runtime-retention-published-package-deletion-fixture.mjs';

test('published package deletion commits an external lease only after the local deleted fence', (t) => {
  const fixture = livePackageRetentionFixture(t);
  const receipt = executeRuntimeRetentionPlan(fixture.plan, {
    apply: true,
    reachabilityManifest: fixture.manifest,
    reachabilityManifestProvider: fixture.provider,
    retentionReceiptLedger: fixture.retentionLedger,
    packageRecoveryDeletionLeasePort: fixture.packageRecoveryDeletionLeasePort,
  });
  assert.equal(receipt.status, 'runtime_retention_applied');
  assert.equal(fs.existsSync(fixture.predecessorPath), false);
  assert.equal(fixture.recoveryFixture.packageRecoveryDeletionLeaseControl.calls.acquire, 1);
  assert.equal(fixture.recoveryFixture.packageRecoveryDeletionLeaseControl.calls.commit, 1);
  assert.equal(fixture.recoveryFixture.packageRecoveryDeletionLeaseControl.calls.abortRelease, 0);
  assert.ok(fixture.recoveryFixture.packageRecoveryDeletionLeaseControl.calls.assert >= 2);
  assert.equal(retentionTombstoneCount(fixture.retentionLedger), 1);
});

test('external deletion lease failure restores the package and reconciliation aborts the fence', (t) => {
  const fixture = livePackageRetentionFixture(t);
  const lease = fixture.recoveryFixture.packageRecoveryDeletionLeaseControl;
  let withdrawn = false;
  assert.throws(() => executeRuntimeRetentionPlan(fixture.plan, {
    apply: true,
    reachabilityManifest: fixture.manifest,
    reachabilityManifestProvider: fixture.provider,
    retentionReceiptLedger: fixture.retentionLedger,
    packageRecoveryDeletionLeasePort: fixture.packageRecoveryDeletionLeasePort,
    faultInjector(event) {
      if (withdrawn || event.stage !== 'before_package_deletion_lease_asserted') return;
      withdrawn = true;
      lease.setAvailable(false);
    },
  }), /runtime_retention_package_deletion_failed_and_fence_recovery_failed/);
  assert.equal(withdrawn, true);
  assertFailedPackageRemovalLeftNoTombstone(fixture);
  lease.setAvailable(true);
  const recovered = reconcileLivePackageRetention(fixture);
  assert.equal(recovered.status, 'runtime_retention_recovery_complete',
    JSON.stringify(recovered.blockers));
  assert.equal(recovered.recovered[0].status,
    'runtime_retention_partially_blocked');
  assert.equal(lease.calls.commit, 0);
  assert.equal(lease.calls.abortRelease, 2);
  assert.equal(fs.existsSync(fixture.predecessorPath), true);
  assert.equal(fs.lstatSync(fixture.predecessorPath).mode & 0o222, 0);
  assert.equal(fs.readdirSync(path.dirname(fixture.predecessorPath))
    .some((name) => name.endsWith('.quarantine')
      || name.startsWith('.hepta-retention-package-delete-')), false);
  assert.equal(retentionTombstoneCount(fixture.retentionLedger), 1);
});

test('crash after local deleted fence resumes the exact external lease commit without restore', (t) => {
  const fixture = livePackageRetentionFixture(t);
  const lease = fixture.recoveryFixture.packageRecoveryDeletionLeaseControl;
  let interrupted = false;
  assert.throws(() => executeRuntimeRetentionPlan(fixture.plan, {
    apply: true,
    reachabilityManifest: fixture.manifest,
    reachabilityManifestProvider: fixture.provider,
    retentionReceiptLedger: fixture.retentionLedger,
    packageRecoveryDeletionLeasePort: fixture.packageRecoveryDeletionLeasePort,
    faultInjector(event) {
      if (interrupted || event.stage !== 'before_package_deletion_lease_committed') return;
      interrupted = true;
      throw new Error('simulated_post_fence_pre_commit_crash');
    },
  }), /simulated_post_fence_pre_commit_crash/);
  assert.equal(interrupted, true);
  assert.equal(fs.existsSync(fixture.predecessorPath), false);
  assert.equal(lease.calls.commit, 0);
  const recovered = reconcileLivePackageRetention(fixture);
  assert.equal(recovered.status, 'runtime_retention_recovery_complete',
    JSON.stringify(recovered.blockers));
  assert.equal(fs.existsSync(fixture.predecessorPath), false);
  assert.equal(lease.calls.commit, 1);
  assert.equal(lease.calls.abortRelease, 0);
  assert.equal(retentionTombstoneCount(fixture.retentionLedger), 1);
});

test('crash after filesystem deletion restores exact inventory before releasing the lease', (t) => {
  const fixture = livePackageRetentionFixture(t);
  const lease = fixture.recoveryFixture.packageRecoveryDeletionLeaseControl;
  let interrupted = false;
  assert.throws(() => executeRuntimeRetentionPlan(fixture.plan, {
    apply: true,
    reachabilityManifest: fixture.manifest,
    reachabilityManifestProvider: fixture.provider,
    retentionReceiptLedger: fixture.retentionLedger,
    packageRecoveryDeletionLeasePort: fixture.packageRecoveryDeletionLeasePort,
    faultInjector(event) {
      if (interrupted
        || event.stage
          !== 'after_package_filesystem_deleted_before_local_fence_deleted') return;
      interrupted = true;
      throw new Error('simulated_post_filesystem_pre_fence_crash');
    },
  }), /simulated_post_filesystem_pre_fence_crash/);
  assert.equal(interrupted, true);
  assert.equal(fs.existsSync(fixture.predecessorPath), false);
  assert.equal(lease.calls.commit, 0);
  assert.equal(lease.calls.abortRelease, 0);
  const recovered = reconcileLivePackageRetention(fixture);
  assert.equal(recovered.status, 'runtime_retention_recovery_complete',
    JSON.stringify(recovered.blockers));
  assert.equal(fs.existsSync(fixture.predecessorPath), true);
  assert.equal(inspectPackageRecoveryTreeInventorySync({
    packagePath: fixture.predecessorPath,
  }).inventory.packageRecoveryTreeInventoryHash,
  fixture.predecessorLifecycle.packageRecoveryTreeInventoryHash);
  assert.equal(lease.calls.commit, 0);
  assert.equal(lease.calls.abortRelease, 1);
  assert.equal(retentionTombstoneCount(fixture.retentionLedger), 1);
});

test('restart after expiry replays the exact lost external commit response', (t) => {
  const fixture = livePackageRetentionFixture(t);
  const lease = fixture.recoveryFixture.packageRecoveryDeletionLeaseControl;
  let responseLost = false;
  assert.throws(() => executeRuntimeRetentionPlan(fixture.plan, {
    apply: true,
    reachabilityManifest: fixture.manifest,
    reachabilityManifestProvider: fixture.provider,
    retentionReceiptLedger: fixture.retentionLedger,
    packageRecoveryDeletionLeasePort: fixture.packageRecoveryDeletionLeasePort,
    faultInjector(event) {
      if (responseLost || event.stage !== 'after_package_deletion_lease_committed') return;
      responseLost = true;
      throw new Error('simulated_deletion_lease_commit_response_loss');
    },
  }), /simulated_deletion_lease_commit_response_loss/);
  assert.equal(responseLost, true);
  assert.equal(fs.existsSync(fixture.predecessorPath), false);
  assert.equal(lease.calls.commit, 1);
  lease.expireLeases();
  const restartedPort = lease.createRestartedPort();
  const recovered = reconcileLivePackageRetention(fixture, restartedPort);
  assert.equal(recovered.status, 'runtime_retention_recovery_complete',
    JSON.stringify(recovered.blockers));
  assert.equal(lease.calls.acquire, 1);
  assert.equal(lease.calls.lookupTerminal, 1);
  assert.equal(lease.calls.commit, 1);
  assert.equal(fs.existsSync(fixture.predecessorPath), false);
  assert.equal(retentionTombstoneCount(fixture.retentionLedger), 1);
});

test('restart after expiry replays the exact lost external abort response', (t) => {
  const fixture = livePackageRetentionFixture(t);
  const lease = fixture.recoveryFixture.packageRecoveryDeletionLeaseControl;
  let deletionFailed = false;
  let responseLost = false;
  assert.throws(() => executeRuntimeRetentionPlan(fixture.plan, {
    apply: true,
    reachabilityManifest: fixture.manifest,
    reachabilityManifestProvider: fixture.provider,
    retentionReceiptLedger: fixture.retentionLedger,
    packageRecoveryDeletionLeasePort: fixture.packageRecoveryDeletionLeasePort,
    faultInjector(event) {
      if (!deletionFailed
        && event.stage === 'before_package_tree_irreversible_removal') {
        deletionFailed = true;
        throw new Error('simulated_pre_deletion_failure');
      }
      if (!responseLost && event.stage === 'after_package_deletion_lease_aborted') {
        responseLost = true;
        throw new Error('simulated_deletion_lease_abort_response_loss');
      }
    },
  }), /runtime_retention_package_deletion_failed_and_fence_recovery_failed/);
  assert.equal(deletionFailed, true);
  assert.equal(responseLost, true);
  assert.equal(fs.existsSync(fixture.predecessorPath), true);
  assert.equal(lease.calls.abortRelease, 1);
  lease.expireLeases();
  const restartedPort = lease.createRestartedPort();
  const recovered = reconcileLivePackageRetention(fixture, restartedPort);
  assert.equal(recovered.status, 'runtime_retention_recovery_complete',
    JSON.stringify(recovered.blockers));
  assert.equal(lease.calls.acquire, 1);
  assert.equal(lease.calls.lookupTerminal, 1);
  assert.equal(lease.calls.abortRelease, 1);
  assert.equal(fs.existsSync(fixture.predecessorPath), true);
  assert.equal(retentionTombstoneCount(fixture.retentionLedger), 1);
});

test('live package authority blocks a new active recovery after quarantine', (t) => {
  const fixture = livePackageRetentionFixture(t);
  let recoveryAdded = false;
  assert.throws(() => executeRuntimeRetentionPlan(fixture.plan, {
    apply: true,
    reachabilityManifest: fixture.manifest,
    reachabilityManifestProvider: fixture.provider,
    retentionReceiptLedger: fixture.retentionLedger,
    packageRecoveryDeletionLeasePort: fixture.packageRecoveryDeletionLeasePort,
    faultInjector(event) {
      if (recoveryAdded || event.stage !== 'after_entry_quarantined') return;
      recoveryAdded = true;
      fixture.campaigns.push(campaignRecord({
        campaignId: 'live-package-recovery',
        paperId: fixture.predecessor.paperId,
        status: 'running',
        effectiveStatus: 'running',
        recoveryOfCampaignId: fixture.predecessor.campaignId,
      }));
    },
  }), /runtime_retention_live_reachability_authority_changed/);
  assert.equal(recoveryAdded, true);
  assert.equal(fs.existsSync(fixture.predecessorPath), true);
});

test('live package authority blocks a new CAS reference before removal', (t) => {
  const fixture = livePackageRetentionFixture(t);
  let referenceAdded = false;
  assert.throws(() => executeRuntimeRetentionPlan(fixture.plan, {
    apply: true,
    reachabilityManifest: fixture.manifest,
    reachabilityManifestProvider: fixture.provider,
    retentionReceiptLedger: fixture.retentionLedger,
    packageRecoveryDeletionLeasePort: fixture.packageRecoveryDeletionLeasePort,
    faultInjector(event) {
      if (referenceAdded || event.stage !== 'before_quarantined_member_removed') return;
      referenceAdded = true;
      createPackageCasReference(fixture.root, fixture.predecessorPath);
    },
  }), /runtime_retention_live_reachability_authority_changed/);
  assert.equal(referenceAdded, true);
  assert.equal(fs.existsSync(fixture.predecessorPath), true);
});

for (const stage of ['before_member_quarantined', 'before_quarantined_member_removed']) {
  test(`live package authority blocks a legal hold added at ${stage}`, (t) => {
    const fixture = livePackageRetentionFixture(t);
    let holdRecorded = false;
    assert.throws(() => executeRuntimeRetentionPlan(fixture.plan, {
      apply: true,
      reachabilityManifest: fixture.manifest,
      reachabilityManifestProvider: fixture.provider,
      retentionReceiptLedger: fixture.retentionLedger,
      packageRecoveryDeletionLeasePort: fixture.packageRecoveryDeletionLeasePort,
      faultInjector(event) {
        if (holdRecorded || event.stage !== stage
          || event.member?.path !== fixture.predecessorPath) return;
        holdRecorded = true;
        recordPackageAuthorityReceipt(
          fixture.lifecycleLedger,
          createPackageRetentionLegalHoldReceipt({
            lifecycleReceipt: fixture.predecessorLifecycle,
            reasonHash: h(`live hold:${stage}`),
            createdAt: '2026-08-18T00:21:00.000Z',
          }),
        );
      },
    }), /runtime_retention_live_reachability_authority_changed/);
    assert.equal(holdRecorded, true);
    assert.equal(fs.existsSync(fixture.predecessorPath), true);
    assert.equal(fs.readdirSync(path.dirname(fixture.predecessorPath))
      .some((name) => name.endsWith('.quarantine')), false);
  });
}

test('live package authority restores a quarantined package after recovery bytes change', (t) => {
  const fixture = livePackageRetentionFixture(t);
  let changed = false;
  assert.throws(() => executeRuntimeRetentionPlan(fixture.plan, {
    apply: true,
    reachabilityManifest: fixture.manifest,
    reachabilityManifestProvider: fixture.provider,
    retentionReceiptLedger: fixture.retentionLedger,
    packageRecoveryDeletionLeasePort: fixture.packageRecoveryDeletionLeasePort,
    faultInjector(event) {
      if (changed || event.stage !== 'after_entry_quarantined') return;
      changed = true;
      const storagePath = fixture.recoveryFixture.storageObjectPath;
      fs.chmodSync(storagePath, 0o644);
      fs.writeFileSync(storagePath, 'replacement recovery bytes\n');
      fs.chmodSync(storagePath, 0o444);
    },
  }), /runtime_retention_live_reachability_authority_changed/);
  assert.equal(changed, true);
  assertFailedPackageRemovalLeftNoTombstone(fixture);
});

test('live package authority restores a package when the retention lock identity drifts', (t) => {
  const fixture = livePackageRetentionFixture(t);
  let drifted = false;
  assert.throws(() => executeRuntimeRetentionPlan(fixture.plan, {
    apply: true,
    reachabilityManifest: fixture.manifest,
    reachabilityManifestProvider: fixture.provider,
    retentionReceiptLedger: fixture.retentionLedger,
    packageRecoveryDeletionLeasePort: fixture.packageRecoveryDeletionLeasePort,
    faultInjector(event) {
      if (drifted || event.stage !== 'before_member_quarantined') return;
      drifted = true;
      fixture.recoveryFixture.control.liveTransform = (live) => {
        const payload = { ...live };
        delete payload.authoritySnapshotHash;
        const changed = {
          ...payload,
          retentionLockIdentityHash: h('rotated-retention-lock-identity'),
        };
        return {
          ...changed,
          authoritySnapshotHash: packageRecoveryLiveAuthoritySnapshotHash(changed),
        };
      };
    },
  }), /runtime_retention_live_reachability_authority_changed/);
  assert.equal(drifted, true);
  assertFailedPackageRemovalLeftNoTombstone(fixture);
});

test('live package authority restores a package when trusted verification is revoked', (t) => {
  const fixture = livePackageRetentionFixture(t);
  let revoked = false;
  assert.throws(() => executeRuntimeRetentionPlan(fixture.plan, {
    apply: true,
    reachabilityManifest: fixture.manifest,
    reachabilityManifestProvider: fixture.provider,
    retentionReceiptLedger: fixture.retentionLedger,
    packageRecoveryDeletionLeasePort: fixture.packageRecoveryDeletionLeasePort,
    faultInjector(event) {
      if (revoked || event.stage !== 'before_quarantined_member_removed') return;
      revoked = true;
      fixture.recoveryFixture.control.storageVerifierMode = 'false';
    },
  }), /runtime_retention_live_reachability_authority_changed/);
  assert.equal(revoked, true);
  assertFailedPackageRemovalLeftNoTombstone(fixture);
});

test('destructive boundary restores a package when a duplicate appears after the first unlink', (t) => {
  const fixture = livePackageRetentionFixture(t);
  const duplicate = fixture.recoveryFixture.createRecoveryReceipt({
    recordedAt: '2026-08-18T00:07:30.000Z',
  });
  let inserted = false;
  assert.throws(() => executeRuntimeRetentionPlan(fixture.plan, {
    apply: true,
    reachabilityManifest: fixture.manifest,
    reachabilityManifestProvider: fixture.provider,
    retentionReceiptLedger: fixture.retentionLedger,
    packageRecoveryDeletionLeasePort: fixture.packageRecoveryDeletionLeasePort,
    faultInjector(event) {
      if (inserted || event.stage !== 'after_package_tree_irreversible_step') return;
      assert.equal(event.irreversibleStep, 1);
      inserted = true;
      recordPackageAuthorityReceipt(fixture.lifecycleLedger, duplicate);
    },
  }), /runtime_retention_(?:live_reachability_authority_changed|package_removal_live_authority_changed)/);
  assert.equal(inserted, true);
  assertFailedPackageRemovalLeftNoTombstone(fixture);
});

const latePackageAuthorityMutations = Object.freeze([
  Object.freeze({
    name: 'recovery archive bytes change',
    mutate(fixture) {
      const storagePath = fixture.recoveryFixture.storageObjectPath;
      fs.chmodSync(storagePath, 0o644);
      fs.writeFileSync(storagePath, 'late replacement recovery bytes\n');
      fs.chmodSync(storagePath, 0o444);
    },
  }),
  Object.freeze({
    name: 'trusted verifier revocation',
    mutate(fixture) {
      fixture.recoveryFixture.control.storageVerifierMode = 'false';
    },
  }),
  Object.freeze({
    name: 'retention lock identity drift',
    mutate(fixture) {
      fixture.recoveryFixture.control.liveTransform = (live) => {
        const payload = { ...live };
        delete payload.authoritySnapshotHash;
        const changed = {
          ...payload,
          retentionLockIdentityHash: h('late-rotated-retention-lock-identity'),
        };
        return {
          ...changed,
          authoritySnapshotHash: packageRecoveryLiveAuthoritySnapshotHash(changed),
        };
      };
    },
  }),
]);

for (const mutation of latePackageAuthorityMutations) {
  test(`every package unlink rechecks live authority after ${mutation.name}`, (t) => {
    const fixture = livePackageRetentionFixture(t);
    let mutated = false;
    assert.throws(() => executeRuntimeRetentionPlan(fixture.plan, {
      apply: true,
      reachabilityManifest: fixture.manifest,
      reachabilityManifestProvider: fixture.provider,
      retentionReceiptLedger: fixture.retentionLedger,
      packageRecoveryDeletionLeasePort: fixture.packageRecoveryDeletionLeasePort,
      faultInjector(event) {
        if (mutated || event.stage !== 'after_package_tree_irreversible_step') return;
        assert.equal(event.irreversibleStep, 1);
        mutated = true;
        mutation.mutate(fixture);
      },
    }), /runtime_retention_(?:live_reachability_authority_changed|package_removal_live_authority_changed)/);
    assert.equal(mutated, true);
    assertFailedPackageRemovalLeftNoTombstone(fixture);
  });
}
