import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  createPackageRetentionRecoveryLockRepository,
  PACKAGE_RETENTION_RECOVERY_READINESS_PROBE_HASH,
}
  from '../../paper-adapters/automation/package-retention-recovery-lock-repository.mjs';
import { createPackageRetentionRecoveryProvisioner }
  from '../../paper-application/automation/package-retention-recovery-provisioner.mjs';
import {
  createPackageExactRestoreDrillReceipt,
  createPackageExactRestoreExecutionProof,
  createPackageImmutableRecoverySourceAuthority,
  createPackageLifecycleReceipt,
  createPackageRecoveryRetentionPolicy,
  createPackageRecoveryStorageAuthorityProof,
  packageRecoveryStorageAuthoritySubjectHash,
} from '../../paper-domain/automation/package-lifecycle-authority-contract.mjs';
import {
  packageRecoveryLiveAuthoritySnapshotHash,
} from '../../paper-ports/package-recovery-authority-port.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (value) => hashRecord('PackageRetentionRecoveryLockTest', value);

function fixtureRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function childLockAttempt(runtimeRoot, packageLifecycleReceiptHash) {
  const moduleUrl = pathToFileURL(path.resolve(
    'paper-adapters/automation/package-retention-recovery-lock-repository.mjs',
  )).href;
  const source = `
    import { createPackageRetentionRecoveryLockRepository } from ${JSON.stringify(moduleUrl)};
    const repository = createPackageRetentionRecoveryLockRepository({
      runtimeRoot: ${JSON.stringify(runtimeRoot)},
    });
    try {
      repository.withLifecycleLock(
        ${JSON.stringify(packageLifecycleReceiptHash)},
        (lock) => ({ held: lock.assertHeld() }),
      );
      process.stdout.write(JSON.stringify({ status: 'acquired' }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        status: 'blocked',
        code: error.code || error.message,
      }));
    }
  `;
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    source,
  ], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('lifecycle flock is cross-process, per receipt, and released after the callback', (t) => {
  const runtimeRoot = fixtureRoot(t, 'hepta-package-recovery-lock-');
  const firstHash = `sha256:${'a'.repeat(64)}`;
  const secondHash = `sha256:${'b'.repeat(64)}`;
  const repository = createPackageRetentionRecoveryLockRepository({ runtimeRoot });

  repository.withLifecycleLock(firstHash, (lock) => {
    assert.equal(lock.assertHeld(), true);
    assert.deepEqual(childLockAttempt(runtimeRoot, firstHash), {
      status: 'blocked',
      code: 'package_retention_recovery_lock_unavailable',
    });
    assert.deepEqual(childLockAttempt(runtimeRoot, secondHash), {
      status: 'acquired',
    });
    assert.equal(lock.assertHeld(), true);
  });

  assert.deepEqual(childLockAttempt(runtimeRoot, firstHash), {
    status: 'acquired',
  });
  assert.throws(
    () => repository.withLifecycleLock(firstHash, () => {
      throw new Error('operation_failed_after_acquisition');
    }),
    /operation_failed_after_acquisition/,
  );
  assert.deepEqual(childLockAttempt(runtimeRoot, firstHash), {
    status: 'acquired',
  });
});

test('readiness uses one pre-provisioned real flock and rejects unsafe lock state', (t) => {
  const runtimeRoot = fixtureRoot(t, 'hepta-package-recovery-readiness-lock-');
  const repository = createPackageRetentionRecoveryLockRepository({ runtimeRoot });
  assert.equal(repository.inspectReadiness(), false);
  repository.withLifecycleLock(
    PACKAGE_RETENTION_RECOVERY_READINESS_PROBE_HASH,
    () => true,
  );
  assert.equal(repository.inspectReadiness(), true);
  repository.withLifecycleLock(
    PACKAGE_RETENTION_RECOVERY_READINESS_PROBE_HASH,
    () => assert.equal(repository.inspectReadiness(), false),
  );
  assert.equal(repository.inspectReadiness(), true);

  const lockRoot = path.join(runtimeRoot, '.hepta-package-retention-recovery-locks');
  fs.chmodSync(lockRoot, 0o755);
  assert.equal(repository.inspectReadiness(), false);
  fs.chmodSync(lockRoot, 0o700);
  assert.equal(repository.inspectReadiness(), true);
});

function releaseFixture(runtimeRoot, packagePath) {
  return Object.freeze({
    version: 1,
    kind: 'CurrentCampaignReleaseAuthority',
    status: 'current_completed_release',
    campaignId: 'campaign-1',
    paperId: 'paper-1',
    campaignPlanHash: H('campaign-plan'),
    packageNodeId: 'campaign-1:package',
    packageResultHash: H('package-result'),
    campaignReleaseBundleHash: H('release-bundle'),
    materializationReceiptHash: H('materialization'),
    packagePath,
    immutableCampaignPackageOutputHash: H('immutable-output'),
    packageNodeStatus: 'completed',
    campaignStatus: 'completed',
    promotedAt: '2026-08-01T00:00:00.000Z',
    releaseBundle: Object.freeze({ runtimeRoot, packagePath }),
  });
}

function storageProofFixture({ lifecycleReceipt, storageObjectPath, issuedAt }) {
  const retentionPolicy = createPackageRecoveryRetentionPolicy({
    retentionLockAuthorityId: 'retention-authority-1',
    retentionLockId: 'retention-lock-1',
    retentionLockMode: 'compliance',
    retentionLockVersion: 'retention-lock-version-1',
    retentionLockIdentityHash: H('retention-lock'),
    retainUntil: '2027-12-31T00:00:00.000Z',
  });
  const ledgerIdentityBase = Object.freeze({
    receiptId: 'storage-receipt-1',
    receiptHash: H('storage-ledger-receipt-1'),
    stream: 'package-recovery-storage',
    writerId: 'storage-writer-1',
    writerKind: 'immutable-package-recovery-storage-authority',
    issuerPolicyId: 'package-recovery-storage-policy',
    issuerPolicyHash: H('issuer-policy'),
    writerTrusted: true,
  });
  const proofInput = {
    runtimeRoot: lifecycleReceipt.runtimeRoot,
    paperId: lifecycleReceipt.releaseIdentity.paperId,
    packagePath: lifecycleReceipt.packagePath,
    packageContentHash: lifecycleReceipt.packageContentHash,
    packageLifecycleReceiptHash: lifecycleReceipt.packageLifecycleReceiptHash,
    packageReleaseIdentityHash: lifecycleReceipt.packageReleaseIdentityHash,
    immutableCampaignPackageOutputHash:
      lifecycleReceipt.releaseIdentity.immutableCampaignPackageOutputHash,
    packageRecoveryTreeInventoryHash:
      lifecycleReceipt.packageRecoveryTreeInventoryHash,
    lifecycleRecordedAt: lifecycleReceipt.recordedAt,
    archiveSchemaVersion: 1,
    archiveInventoryHash: lifecycleReceipt.packageRecoveryTreeInventoryHash,
    storageAuthorityId: 'storage-authority-1',
    storageClass: 'worm',
    storageObjectId: 'storage-object-1',
    storageObjectVersion: 'storage-object-version-1',
    storageObjectPath,
    storageObjectBytesHash: hashBytes(fs.readFileSync(storageObjectPath)),
    storedPackageContentHash: lifecycleReceipt.packageContentHash,
    sourceInventoryHash: lifecycleReceipt.packageRecoveryTreeInventoryHash,
    retentionPolicy,
    trustStoreHash: H('trust-store'),
    ledgerIdentity: ledgerIdentityBase,
    issuedAt,
    verifiedAt: issuedAt,
    verificationEpoch: 'storage-verification-epoch-1',
  };
  const signedSubjectHash = packageRecoveryStorageAuthoritySubjectHash({
    ...proofInput,
    packageRecoveryRetentionPolicyHash:
      retentionPolicy.packageRecoveryRetentionPolicyHash,
  });
  return createPackageRecoveryStorageAuthorityProof({
    ...proofInput,
    signatures: [Object.freeze({
      algorithm: 'ed25519',
      keyId: 'storage-signing-key-1',
      role: 'package_recovery_storage_authority',
      signedSubjectHash,
      value: Buffer.alloc(64).toString('base64'),
    })],
    ledgerIdentity: Object.freeze({
      ...ledgerIdentityBase,
    }),
  });
}

function recoveryEvidenceFixture({
  lifecycleReceipt,
  requestedAt,
  restoreTargetPath,
  storageObjectPath,
}) {
  const storageAuthorityProof = storageProofFixture({
    lifecycleReceipt,
    storageObjectPath,
    issuedAt: requestedAt,
  });
  const recoverySourceAuthority = createPackageImmutableRecoverySourceAuthority({
    lifecycleReceipt,
    storageAuthorityProof,
    trustedStorageAuthorityVerifier: () => true,
  });
  const startedAt = new Date(Date.parse(requestedAt) + 1_000).toISOString();
  const completedAt = new Date(Date.parse(requestedAt) + 2_000).toISOString();
  const packageIdentity = H('production-package-identity');
  const restoreExecutionProof = createPackageExactRestoreExecutionProof({
    recoverySourceAuthority,
    restoreTargetPath,
    restoreTargetIdentityHash: H('restore-target-identity'),
    expectedPackageContentHash: lifecycleReceipt.packageContentHash,
    restoredPackageContentHash: lifecycleReceipt.packageContentHash,
    expectedPackageRecoveryTreeInventoryHash:
      lifecycleReceipt.packageRecoveryTreeInventoryHash,
    restoredPackageRecoveryTreeInventoryHash:
      lifecycleReceipt.packageRecoveryTreeInventoryHash,
    productionPackagePath: lifecycleReceipt.packagePath,
    productionPackageIdentityHashBefore: packageIdentity,
    productionPackageIdentityHashAfter: packageIdentity,
    productionPackageContentHashBefore: lifecycleReceipt.packageContentHash,
    productionPackageContentHashAfter: lifecycleReceipt.packageContentHash,
    productionPackageRecoveryTreeInventoryHashBefore:
      lifecycleReceipt.packageRecoveryTreeInventoryHash,
    productionPackageRecoveryTreeInventoryHashAfter:
      lifecycleReceipt.packageRecoveryTreeInventoryHash,
    startedAt,
    completedAt,
  });
  const restoreDrillReceipt = createPackageExactRestoreDrillReceipt({
    lifecycleReceipt,
    recoverySourceAuthority,
    restoreExecutionProof,
    trustedStorageAuthorityVerifier: () => true,
    trustedRestoreDrillVerifier: () => true,
  });
  return Object.freeze({ recoverySourceAuthority, restoreDrillReceipt });
}

function liveStorageIdentity(storageObjectPath) {
  const stat = fs.lstatSync(storageObjectPath, { bigint: true });
  const storageObjectRealPath = fs.realpathSync.native(storageObjectPath);
  return Object.freeze({
    storageObjectRealPath,
    storageObjectIdentityHash: hashRecord(
      'PackageRecoveryLiveStorageObjectIdentity',
      Object.freeze({
        dev: String(stat.dev),
        ino: String(stat.ino),
        mode: String(stat.mode),
        size: String(stat.size),
        mtimeNs: String(stat.mtimeNs),
        nlink: String(stat.nlink),
        realPath: storageObjectRealPath,
      }),
    ),
  });
}

function liveRecoverySource(recoveryReceipt) {
  const source = recoveryReceipt.recoverySourceAuthority;
  const storageIdentity = liveStorageIdentity(source.storageObjectPath);
  const snapshot = {
    blockers: Object.freeze([]),
    deletionProtected: true,
    immutable: true,
    packageLifecycleReceiptHash: recoveryReceipt.packageLifecycleReceiptHash,
    packageRecoveryRetentionPolicyHash:
      source.packageRecoveryRetentionPolicyHash,
    packageRecoveryStorageAuthorityProofHash:
      source.packageRecoveryStorageAuthorityProofHash,
    retainUntil: source.retainUntil,
    retentionLockVersion: source.retentionLockVersion,
    retentionLockIdentityHash: source.retentionLockIdentityHash,
    sourceInventoryHash: source.sourceInventoryHash,
    packageRecoveryTreeInventoryHash: source.packageRecoveryTreeInventoryHash,
    sourcePresent: true,
    storageAuthorityId: source.storageAuthorityId,
    storageClass: source.storageClass,
    storageObjectBytesHash: source.storageObjectBytesHash,
    storageObjectId: source.storageObjectId,
    storageObjectVersion: source.storageObjectVersion,
    storageObjectIdentityHash: storageIdentity.storageObjectIdentityHash,
    storageObjectPath: source.storageObjectPath,
    storageObjectRealPath: storageIdentity.storageObjectRealPath,
    storageIssuerPolicyHash:
      source.storageAuthorityProof.ledgerIdentity.issuerPolicyHash,
    storageLedgerReceiptHash:
      source.storageAuthorityProof.ledgerIdentity.receiptHash,
    storageLedgerReceiptId:
      source.storageAuthorityProof.ledgerIdentity.receiptId,
    trustStoreHash: source.storageAuthorityProof.trustStoreHash,
    valid: true,
  };
  return Object.freeze({
    ...snapshot,
    authoritySnapshotHash: packageRecoveryLiveAuthoritySnapshotHash(snapshot),
  });
}

test('provisioning rereads under the lifecycle lock and performs recovery once', (t) => {
  const root = fixtureRoot(t, 'hepta-package-recovery-idempotence-');
  const runtimeRoot = path.join(root, 'runtime');
  const packagePath = path.join(runtimeRoot, 'packages', 'package-1');
  const storageObjectPath = path.join(root, 'immutable-storage', 'package-1.bin');
  const restoreTargetPath = path.join(root, 'restore-target', 'package-1');
  fs.mkdirSync(packagePath, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(storageObjectPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(storageObjectPath, 'immutable-package-archive\n');
  fs.chmodSync(storageObjectPath, 0o444);

  const release = releaseFixture(runtimeRoot, packagePath);
  const packageContentHash = H('package-content');
  const lifecycleReceipt = createPackageLifecycleReceipt({
    runtimeRoot,
    packagePath,
    packageContentHash,
    packageRecoveryTreeInventoryHash: H('package-recovery-tree-inventory'),
    release,
    recordedAt: '2026-08-01T00:01:00.000Z',
  });
  const rows = [{ receipt_json: JSON.stringify(lifecycleReceipt) }];
  let externalActionCount = 0;
  let recordCount = 0;
  let now = Date.parse('2026-08-02T00:00:00.000Z');
  const packageRecoveryAuthority = Object.freeze({
    version: 1,
    kind: 'PackageRecoveryAuthority',
    createRecoveryEvidence({ lifecycleReceipt: requested, recordedAt }) {
      assert.equal(requested.packageLifecycleReceiptHash,
        lifecycleReceipt.packageLifecycleReceiptHash);
      externalActionCount += 1;
      return recoveryEvidenceFixture({
        lifecycleReceipt: requested,
        requestedAt: recordedAt,
        restoreTargetPath,
        storageObjectPath,
      });
    },
    inspectLiveRecoverySource({ recoveryReceipt }) {
      return liveRecoverySource(recoveryReceipt);
    },
    verifyStorageAuthorityProof: () => true,
    verifyRestoreExecutionProof: () => true,
  });
  const inspectedPackage = Object.freeze({
    packagePath,
    packageContentHash,
    packageRecoveryTreeInventoryHash:
      lifecycleReceipt.packageRecoveryTreeInventoryHash,
    immutableCampaignPackageOutputHash: release.immutableCampaignPackageOutputHash,
    packageDirectoryIdentity: Object.freeze({ dev: '1', ino: '2' }),
  });
  const provision = createPackageRetentionRecoveryProvisioner({
    campaignReleaseQuery: {
      getCurrentRelease: ({ campaignId }) => (
        campaignId === release.campaignId ? release : null
      ),
    },
    materializationInspector: {
      inspectRelease: () => inspectedPackage,
    },
    packageRecoveryAuthority,
    packageRetentionRecoveryLockRepository:
      createPackageRetentionRecoveryLockRepository({ runtimeRoot }),
    loadLifecycleRows: () => [...rows],
    parseReceipt: (row) => JSON.parse(row.receipt_json),
    recordRecoveryReceipt: (receipt) => {
      recordCount += 1;
      rows.push({ receipt_json: JSON.stringify(receipt) });
    },
    clock: {
      nowIso() {
        now += 60_000;
        return new Date(now).toISOString();
      },
    },
  });

  const first = provision({
    packageLifecycleReceiptHash: lifecycleReceipt.packageLifecycleReceiptHash,
  });
  const second = provision({
    packageLifecycleReceiptHash: lifecycleReceipt.packageLifecycleReceiptHash,
  });

  assert.equal(first.status, 'package_retention_recovery_recorded');
  assert.equal(first.externalActionPerformed, true);
  assert.equal(second.status, 'package_retention_recovery_already_recorded');
  assert.equal(second.externalActionPerformed, false);
  assert.equal(second.packageRetentionRecoveryReceiptHash,
    first.packageRetentionRecoveryReceiptHash);
  assert.equal(externalActionCount, 1);
  assert.equal(recordCount, 1);
  assert.equal(rows.length, 2);
});
