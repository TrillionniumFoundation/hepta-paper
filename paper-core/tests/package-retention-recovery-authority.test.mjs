import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createPackageRetentionRecoveryProvisioner }
  from '../../paper-application/automation/package-retention-recovery-provisioner.mjs';
import {
  createPackageImmutableRecoverySourceAuthority,
  createPackageLifecycleReceipt,
  verifyPackageExactRestoreExecutionProof,
  verifyPackageRecoveryRetentionPolicy,
  verifyPackageRecoveryStorageAuthorityProof,
  verifyPackageRetentionRecoveryReceipt,
  verifyPackageLifecycleReceipt,
} from '../../paper-domain/automation/package-lifecycle-authority-contract.mjs';
import { createPackageRecoveryTreeInventory }
  from '../../paper-domain/automation/package-recovery-tree-inventory-contract.mjs';
import {
  inspectTrustedLivePackageRecoverySource,
  PACKAGE_RECOVERY_MINIMUM_LIVE_HORIZON_MS,
  packageRecoveryVerificationOptions,
  verifyTrustedPackageRecoveryReceipt,
} from '../../paper-ports/package-recovery-authority-port.mjs';
import { retentionMemberHash }
  from '../../paper-adapters/automation/runtime-retention-scope-repository.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  createSequenceClock,
  createTestPackageRetentionRecoveryLockRepository,
  createTrustedPackageRecoveryAuthorityFixture,
} from './support/package-recovery-authority-fixture.mjs';

function reseal(kind, record, hashField, mutate) {
  const payload = structuredClone(record);
  delete payload[hashField];
  mutate(payload);
  return {
    ...payload,
    [hashField]: hashRecord(kind, payload),
  };
}

function provisionerFor(fixture, rows, {
  clock,
  recordRecoveryReceipt = (receipt) => rows.push({ receipt }),
} = {}) {
  return createPackageRetentionRecoveryProvisioner({
    campaignReleaseQuery: {
      getCurrentRelease: () => fixture.release,
    },
    materializationInspector: {
      inspectRelease: () => fixture.inspectedPackage,
    },
    packageRecoveryAuthority: fixture.authority,
    packageRetentionRecoveryLockRepository:
      createTestPackageRetentionRecoveryLockRepository(),
    loadLifecycleRows: () => rows,
    parseReceipt: (row) => row.receipt,
    recordRecoveryReceipt,
    clock,
  });
}

test('v2 recovery provisions and persistently replays one fully bound external restore', (t) => {
  const fixture = createTrustedPackageRecoveryAuthorityFixture(t);
  const rows = [{ receipt: fixture.lifecycleReceipt }];
  const liveReplayAt = new Date(
    Date.parse(fixture.times.liveInspectedAt) + 60_000,
  ).toISOString();
  const provision = provisionerFor(fixture, rows, {
    clock: createSequenceClock([
      fixture.times.recoveryRequestedAt,
      fixture.times.recoveryRecordedAt,
      fixture.times.liveInspectedAt,
      liveReplayAt,
    ]),
  });

  const first = provision({
    packageLifecycleReceiptHash:
      fixture.lifecycleReceipt.packageLifecycleReceiptHash,
  });
  assert.equal(first.status, 'package_retention_recovery_recorded');
  assert.equal(first.externalActionPerformed, true);
  assert.equal(rows.length, 2);
  const recoveryReceipt = rows[1].receipt;
  const verification = verifyPackageRetentionRecoveryReceipt(recoveryReceipt, {
    lifecycleReceipt: fixture.lifecycleReceipt,
    ...packageRecoveryVerificationOptions(fixture.authority),
  });
  assert.equal(verification.valid, true);
  assert.equal(verification.recoveryEvidenceValid, true);
  assert.equal(verification.deletionAuthorized, false);
  assert.equal(verifyTrustedPackageRecoveryReceipt({
    packageRecoveryAuthority: fixture.authority,
    recoveryReceipt,
    lifecycleReceipt: fixture.lifecycleReceipt,
  }), true);

  const live = inspectTrustedLivePackageRecoverySource({
    packageRecoveryAuthority: fixture.authority,
    recoveryReceipt,
    lifecycleReceipt: fixture.lifecycleReceipt,
    now: fixture.times.liveInspectedAt,
  });
  assert.ok(live);
  assert.deepEqual(Object.keys(live).sort(), [
    'authoritySnapshotHash', 'blockers', 'deletionProtected', 'immutable',
    'packageLifecycleReceiptHash', 'packageRecoveryRetentionPolicyHash',
    'packageRecoveryStorageAuthorityProofHash', 'packageRecoveryTreeInventoryHash',
    'retainUntil', 'retentionLockIdentityHash', 'retentionLockVersion',
    'sourceInventoryHash', 'sourcePresent',
    'storageAuthorityId', 'storageClass', 'storageObjectBytesHash',
    'storageObjectId', 'storageObjectIdentityHash', 'storageObjectPath',
    'storageObjectVersion',
    'storageObjectRealPath', 'storageIssuerPolicyHash',
    'storageLedgerReceiptHash', 'storageLedgerReceiptId', 'trustStoreHash', 'valid',
  ].sort());
  assert.equal(path.isAbsolute(live.storageObjectRealPath), true);
  assert.equal(live.storageObjectRealPath.startsWith(fixture.runtimeRoot), false);
  assert.equal(live.trustStoreHash,
    fixture.storageAuthorityProof.trustStoreHash);
  assert.equal(live.storageIssuerPolicyHash,
    fixture.storageAuthorityProof.ledgerIdentity.issuerPolicyHash);
  assert.equal(live.storageLedgerReceiptHash,
    fixture.storageAuthorityProof.ledgerIdentity.receiptHash);
  assert.equal(live.storageLedgerReceiptId,
    fixture.storageAuthorityProof.ledgerIdentity.receiptId);
  assert.equal(fixture.control.restoreTargets.length, 1);
  assert.equal(fs.existsSync(fixture.control.restoreTargets[0]), false);
  const archive = JSON.parse(fs.readFileSync(fixture.storageObjectPath, 'utf8'));
  assert.deepEqual(archive.files.map((file) => Object.keys(file).sort()), [[
    'bytesBase64', 'path',
  ].sort()]);
  assert.equal(
    archive.packageRecoveryTreeInventory.packageRecoveryTreeInventoryHash,
    fixture.lifecycleReceipt.packageRecoveryTreeInventoryHash,
  );
  assert.equal(
    retentionMemberHash(fixture.packagePath),
    fixture.lifecycleReceipt.packageContentHash,
  );

  const replay = provision({
    packageLifecycleReceiptHash:
      fixture.lifecycleReceipt.packageLifecycleReceiptHash,
  });
  assert.equal(replay.status, 'package_retention_recovery_already_recorded');
  assert.equal(replay.externalActionPerformed, false);
  assert.equal(replay.packageRetentionRecoveryReceiptHash,
    first.packageRetentionRecoveryReceiptHash);
  assert.equal(fixture.control.createEvidenceCalls, 1);
  assert.equal(rows.length, 2);
});

test('signed storage proof rejects lifecycle replay and stale ledger or lock authority', (t) => {
  const fixture = createTrustedPackageRecoveryAuthorityFixture(t, {
    name: 'exact-storage-binding',
  });
  const proof = fixture.storageAuthorityProof;
  const alternateLifecycle = ({ campaignId, packagePath }) => {
    const release = Object.freeze({
      ...fixture.release,
      campaignId,
      campaignPlanHash: hashRecord('AlternateRecoveryCampaignPlan', campaignId),
      packageNodeId: `${campaignId}:package`,
      packageResultHash: hashRecord('AlternateRecoveryPackageResult', campaignId),
      campaignReleaseBundleHash:
        hashRecord('AlternateRecoveryReleaseBundle', campaignId),
      materializationReceiptHash:
        hashRecord('AlternateRecoveryMaterialization', campaignId),
      packagePath,
    });
    return createPackageLifecycleReceipt({
      runtimeRoot: fixture.runtimeRoot,
      packagePath,
      packageContentHash: fixture.lifecycleReceipt.packageContentHash,
      packageRecoveryTreeInventoryHash:
        fixture.lifecycleReceipt.packageRecoveryTreeInventoryHash,
      release,
      recordedAt: fixture.lifecycleReceipt.recordedAt,
    });
  };
  const samePathDifferentLifecycle = alternateLifecycle({
    campaignId: 'same-path-different-lifecycle',
    packagePath: fixture.packagePath,
  });
  const differentPathSameContent = alternateLifecycle({
    campaignId: 'different-path-same-content',
    packagePath: path.join(
      fixture.runtimeRoot,
      'packages',
      'same-content-different-path',
    ),
  });
  for (const lifecycleReceipt of [
    samePathDifferentLifecycle,
    differentPathSameContent,
  ]) {
    assert.equal(fixture.authority.verifyStorageAuthorityProof(proof, {
      lifecycleReceipt,
    }), false);
    assert.throws(() => createPackageImmutableRecoverySourceAuthority({
      lifecycleReceipt,
      storageAuthorityProof: proof,
      trustedStorageAuthorityVerifier: () => true,
    }), /package_immutable_recovery_source_authority_invalid/);
  }

  const verifiedAtOnly = reseal(
    'PackageRecoveryStorageAuthorityProof',
    proof,
    'packageRecoveryStorageAuthorityProofHash',
    (payload) => {
      payload.verifiedAt = new Date(Date.parse(payload.verifiedAt) + 1_000).toISOString();
    },
  );
  assert.equal(verifyPackageRecoveryStorageAuthorityProof(verifiedAtOnly).valid, false);
  assert.equal(fixture.authority.verifyStorageAuthorityProof(verifiedAtOnly), false);

  const ledgerId = proof.ledgerIdentity.receiptId;
  const authoritativeLedger = fixture.control.ledgerReceipts.get(ledgerId);
  fixture.control.ledgerReceipts.delete(ledgerId);
  assert.equal(verifyPackageRecoveryStorageAuthorityProof(proof).valid, true);
  assert.equal(fixture.authority.verifyStorageAuthorityProof(proof), false);
  fixture.control.ledgerReceipts.set(ledgerId, {
    ...authoritativeLedger,
    writerTrusted: false,
  });
  assert.equal(fixture.authority.verifyStorageAuthorityProof(proof), false);
  fixture.control.ledgerReceipts.set(ledgerId, authoritativeLedger);
  assert.equal(fixture.authority.verifyStorageAuthorityProof(proof), true);

  const policy = proof.retentionPolicy;
  const lockKey = `${policy.retentionLockAuthorityId}:${policy.retentionLockId}`;
  const authoritativeLock = fixture.control.retentionLocks.get(lockKey);
  fixture.control.retentionLocks.set(lockKey, {
    ...authoritativeLock,
    status: 'revoked',
  });
  assert.equal(fixture.authority.verifyStorageAuthorityProof(proof), false);
  fixture.control.retentionLocks.set(lockKey, {
    ...authoritativeLock,
    retentionLockVersion: 'drifted-lock-version',
  });
  assert.equal(fixture.authority.verifyStorageAuthorityProof(proof), false);
  fixture.control.retentionLocks.set(lockKey, authoritativeLock);

  const objectKey = `${proof.storageAuthorityId}:${proof.storageObjectId}`;
  const authoritativeObject = fixture.control.storageObjects.get(objectKey);
  fixture.control.storageObjects.set(objectKey, {
    ...authoritativeObject,
    storageObjectVersion: 'drifted-storage-version',
  });
  assert.equal(fixture.authority.verifyStorageAuthorityProof(proof), false);
  fixture.control.storageObjects.set(objectKey, authoritativeObject);
  assert.equal(fixture.authority.verifyStorageAuthorityProof(proof), true);
});

test('mode, uid, gid, and inventory-path replay cannot reuse storage authority', (t) => {
  const fixture = createTrustedPackageRecoveryAuthorityFixture(t, {
    name: 'inventory-replay',
  });
  const fileIndex = fixture.packageRecoveryTreeInventory.entries
    .findIndex((entry) => entry.kind === 'file');
  const mutations = new Map([
    ['mode', (entry) => ({ ...entry, posixMode: entry.posixMode ^ 0o111 })],
    ['uid', (entry) => ({ ...entry, uid: entry.uid + 1 })],
    ['gid', (entry) => ({ ...entry, gid: entry.gid + 1 })],
    ['path', (entry) => ({ ...entry, path: 'RENAMED_PACKAGE_RECORD.json' })],
  ]);
  for (const [name, mutate] of mutations) {
    const entries = fixture.packageRecoveryTreeInventory.entries
      .map((entry, index) => index === fileIndex ? mutate(entry) : entry);
    const alternateInventory = createPackageRecoveryTreeInventory({ entries });
    const alternateLifecycle = createPackageLifecycleReceipt({
      runtimeRoot: fixture.runtimeRoot,
      packagePath: fixture.packagePath,
      packageContentHash: fixture.lifecycleReceipt.packageContentHash,
      packageRecoveryTreeInventoryHash:
        alternateInventory.packageRecoveryTreeInventoryHash,
      release: fixture.release,
      recordedAt: fixture.lifecycleReceipt.recordedAt,
    });
    assert.notEqual(
      alternateLifecycle.packageRecoveryTreeInventoryHash,
      fixture.lifecycleReceipt.packageRecoveryTreeInventoryHash,
      name,
    );
    assert.equal(fixture.authority.verifyStorageAuthorityProof(
      fixture.storageAuthorityProof,
      { lifecycleReceipt: alternateLifecycle },
    ), false, name);
  }
});

test('legacy lifecycle v1 remains audit-valid but cannot create recovery deletion authority', (t) => {
  const fixture = createTrustedPackageRecoveryAuthorityFixture(t, {
    name: 'legacy-lifecycle-audit-only',
  });
  const current = structuredClone(fixture.lifecycleReceipt);
  delete current.packageLifecycleReceiptHash;
  delete current.packageRecoveryTreeInventoryHash;
  current.version = 1;
  const legacy = Object.freeze({
    ...current,
    packageLifecycleReceiptHash: hashRecord('PackageLifecycleReceipt', current),
  });
  const audit = verifyPackageLifecycleReceipt(legacy);
  assert.deepEqual({
    valid: audit.valid,
    legacy: audit.legacy,
    recoveryInventoryBound: audit.recoveryInventoryBound,
    deletionAuthorized: audit.deletionAuthorized,
  }, {
    valid: true,
    legacy: true,
    recoveryInventoryBound: false,
    deletionAuthorized: false,
  });
  const proof = fixture.issueStorageProof({
    candidateLifecycleReceipt: legacy,
  });
  assert.throws(() => createPackageImmutableRecoverySourceAuthority({
    lifecycleReceipt: legacy,
    storageAuthorityProof: proof,
    trustedStorageAuthorityVerifier: () => true,
  }), /package_immutable_recovery_source_authority_invalid/);
  const currentRecovery = fixture.createRecoveryReceipt();
  const mixedVerification = verifyPackageRetentionRecoveryReceipt(currentRecovery, {
    lifecycleReceipt: legacy,
    ...packageRecoveryVerificationOptions(fixture.authority),
  });
  assert.deepEqual({
    valid: mixedVerification.valid,
    recoveryEvidenceValid: mixedVerification.recoveryEvidenceValid,
    deletionAuthorized: mixedVerification.deletionAuthorized,
  }, {
    valid: false,
    recoveryEvidenceValid: false,
    deletionAuthorized: false,
  });
  assert.equal(verifyTrustedPackageRecoveryReceipt({
    packageRecoveryAuthority: fixture.authority,
    recoveryReceipt: currentRecovery,
    lifecycleReceipt: legacy,
  }), false, 'v2 recovery cannot supply the inventory missing from a v1 lifecycle');
});

test('persisted restore attestation survives target cleanup and verifier restart', (t) => {
  const fixture = createTrustedPackageRecoveryAuthorityFixture(t, {
    name: 'persisted-restore-attestation',
  });
  const recoveryReceipt = fixture.createRecoveryReceipt();
  const recoverySourceAuthority = recoveryReceipt.recoverySourceAuthority;
  const restoreExecutionProof = recoveryReceipt.restoreDrillReceipt.restoreExecutionProof;
  const context = {
    lifecycleReceipt: fixture.lifecycleReceipt,
    recoverySourceAuthority,
  };
  assert.equal(fixture.authority.verifyRestoreExecutionProof(
    restoreExecutionProof,
    context,
  ), true);
  const restartedAuthority = fixture.createRestartedVerificationAuthority();
  const tamperedRestoreProof = reseal(
    'PackageExactRestoreExecutionProof',
    restoreExecutionProof,
    'packageExactRestoreExecutionProofHash',
    (payload) => {
      payload.restoreTargetIdentityHash =
        hashRecord('TamperedRestoreTargetIdentity', payload.restoreTargetPath);
    },
  );
  assert.equal(verifyPackageExactRestoreExecutionProof(tamperedRestoreProof, {
    recoverySourceAuthority,
  }).valid, true);
  assert.equal(restartedAuthority.verifyRestoreExecutionProof(
    tamperedRestoreProof,
    context,
  ), false);

  assert.equal(fs.existsSync(restoreExecutionProof.restoreTargetPath), false);
  fs.chmodSync(fixture.packagePath, 0o700);
  fs.rmSync(fixture.packagePath, { recursive: true, force: true });
  fixture.control.restoreExecutionAttestations.clear();
  fixture.control.ledgerReceipts.clear();
  fixture.control.retentionLocks.clear();
  fixture.control.storageObjects.clear();

  assert.equal(fixture.authority.verifyRestoreExecutionProof(
    restoreExecutionProof,
    context,
  ), false);
  assert.equal(restartedAuthority.verifyRestoreExecutionProof(
    restoreExecutionProof,
    context,
  ), true);
  assert.equal(restartedAuthority.verifyStorageAuthorityProof(
    recoverySourceAuthority.storageAuthorityProof,
    { lifecycleReceipt: fixture.lifecycleReceipt },
  ), true);
  assert.equal(verifyTrustedPackageRecoveryReceipt({
    packageRecoveryAuthority: restartedAuthority,
    recoveryReceipt,
    lifecycleReceipt: fixture.lifecycleReceipt,
  }), true);
});

test('v2 recovery rejects cryptographic, ordering, binding, path, time, and live faults', (t) => {
  const fixture = createTrustedPackageRecoveryAuthorityFixture(t);
  const recoveryReceipt = fixture.createRecoveryReceipt();
  const proofHashField = 'packageRecoveryStorageAuthorityProofHash';
  const tamperedSignature = reseal(
    'PackageRecoveryStorageAuthorityProof',
    fixture.storageAuthorityProof,
    proofHashField,
    (payload) => {
      payload.signatures[0].value = Buffer.alloc(64, 7).toString('base64');
    },
  );
  assert.equal(verifyPackageRecoveryStorageAuthorityProof(tamperedSignature).valid, true);
  assert.equal(fixture.authority.verifyStorageAuthorityProof(tamperedSignature), false);

  const reversedSignatures = reseal(
    'PackageRecoveryStorageAuthorityProof',
    fixture.storageAuthorityProof,
    proofHashField,
    (payload) => payload.signatures.reverse(),
  );
  assert.equal(verifyPackageRecoveryStorageAuthorityProof(reversedSignatures).valid, false);
  const duplicateSignature = reseal(
    'PackageRecoveryStorageAuthorityProof',
    fixture.storageAuthorityProof,
    proofHashField,
    (payload) => { payload.signatures = [payload.signatures[0], payload.signatures[0]]; },
  );
  assert.equal(verifyPackageRecoveryStorageAuthorityProof(duplicateSignature).valid, false);

  const reboundReceipt = reseal(
    'PackageRetentionRecoveryReceipt',
    recoveryReceipt,
    'packageRetentionRecoveryReceiptHash',
    (payload) => { payload.storageObjectBytesHash = hashRecord('WrongBinding', 'bytes'); },
  );
  assert.equal(verifyPackageRetentionRecoveryReceipt(reboundReceipt, {
    lifecycleReceipt: fixture.lifecycleReceipt,
    ...packageRecoveryVerificationOptions(fixture.authority),
  }).valid, false);

  const runtimeStorageProof = fixture.issueStorageProof({
    candidateStorageObjectPath: path.join(
      fixture.runtimeRoot,
      'packages',
      'forbidden-recovery.archive',
    ),
  });
  assert.equal(verifyPackageRecoveryStorageAuthorityProof(runtimeStorageProof).valid, true);
  assert.equal(fixture.authority.verifyStorageAuthorityProof(runtimeStorageProof), true);
  assert.throws(() => createPackageImmutableRecoverySourceAuthority({
    lifecycleReceipt: fixture.lifecycleReceipt,
    storageAuthorityProof: runtimeStorageProof,
    trustedStorageAuthorityVerifier: (proof) =>
      fixture.authority.verifyStorageAuthorityProof(proof),
  }), /package_immutable_recovery_source_authority_invalid/);

  assert.equal(verifyPackageRecoveryRetentionPolicy(fixture.retentionPolicy, {
    at: fixture.retentionPolicy.retainUntil,
  }).valid, false);
  const exactHorizon = new Date(
    Date.parse(fixture.retentionPolicy.retainUntil)
      - PACKAGE_RECOVERY_MINIMUM_LIVE_HORIZON_MS,
  ).toISOString();
  assert.ok(inspectTrustedLivePackageRecoverySource({
    packageRecoveryAuthority: fixture.authority,
    recoveryReceipt,
    lifecycleReceipt: fixture.lifecycleReceipt,
    now: exactHorizon,
  }));
  assert.equal(inspectTrustedLivePackageRecoverySource({
    packageRecoveryAuthority: fixture.authority,
    recoveryReceipt,
    lifecycleReceipt: fixture.lifecycleReceipt,
    now: new Date(Date.parse(exactHorizon) + 1).toISOString(),
  }), null);

  fixture.control.storageVerifierMode = 'false';
  assert.equal(verifyTrustedPackageRecoveryReceipt({
    packageRecoveryAuthority: fixture.authority,
    recoveryReceipt,
    lifecycleReceipt: fixture.lifecycleReceipt,
  }), false);
  fixture.control.storageVerifierMode = 'throw';
  assert.equal(verifyTrustedPackageRecoveryReceipt({
    packageRecoveryAuthority: fixture.authority,
    recoveryReceipt,
    lifecycleReceipt: fixture.lifecycleReceipt,
  }), false);
  fixture.control.storageVerifierMode = 'valid';
  fixture.control.restoreVerifierMode = 'false';
  assert.equal(verifyTrustedPackageRecoveryReceipt({
    packageRecoveryAuthority: fixture.authority,
    recoveryReceipt,
    lifecycleReceipt: fixture.lifecycleReceipt,
  }), false);
  fixture.control.restoreVerifierMode = 'throw';
  assert.equal(verifyTrustedPackageRecoveryReceipt({
    packageRecoveryAuthority: fixture.authority,
    recoveryReceipt,
    lifecycleReceipt: fixture.lifecycleReceipt,
  }), false);
  fixture.control.restoreVerifierMode = 'valid';
  fixture.control.liveTransform = (live) => {
    const wrong = { ...live };
    delete wrong.storageObjectIdentityHash;
    return wrong;
  };
  assert.equal(inspectTrustedLivePackageRecoverySource({
    packageRecoveryAuthority: fixture.authority,
    recoveryReceipt,
    lifecycleReceipt: fixture.lifecycleReceipt,
    now: fixture.times.liveInspectedAt,
  }), null);
});

test('v2 recovery provisioner rejects malformed evidence, duplicates, and persist conflicts', (t) => {
  const fixture = createTrustedPackageRecoveryAuthorityFixture(t, {
    name: 'negative-generation',
  });
  const rows = [{ receipt: fixture.lifecycleReceipt }];
  fixture.control.evidenceMode = 'wrong-shape';
  assert.throws(() => provisionerFor(fixture, rows, {
    clock: createSequenceClock([fixture.times.recoveryRequestedAt]),
  })({
    packageLifecycleReceiptHash:
      fixture.lifecycleReceipt.packageLifecycleReceiptHash,
  }), /package_retention_recovery_evidence_invalid/);
  fixture.control.evidenceMode = 'promise';
  assert.throws(() => provisionerFor(fixture, rows, {
    clock: createSequenceClock([fixture.times.recoveryRequestedAt]),
  })({
    packageLifecycleReceiptHash:
      fixture.lifecycleReceipt.packageLifecycleReceiptHash,
  }), /package_retention_recovery_evidence_invalid/);

  fixture.control.evidenceMode = 'valid';
  const recoveryReceipt = fixture.createRecoveryReceipt();
  const duplicateRows = [
    { receipt: fixture.lifecycleReceipt },
    { receipt: recoveryReceipt },
    { receipt: recoveryReceipt },
  ];
  assert.throws(() => provisionerFor(fixture, duplicateRows, {
    clock: createSequenceClock([]),
  })({
    packageLifecycleReceiptHash:
      fixture.lifecycleReceipt.packageLifecycleReceiptHash,
  }), /package_retention_recovery_receipt_ambiguous/);

  const conflictFixture = createTrustedPackageRecoveryAuthorityFixture(t, {
    name: 'persist-conflict-generation',
  });
  const conflictRows = [{ receipt: conflictFixture.lifecycleReceipt }];
  const conflictProvision = provisionerFor(conflictFixture, conflictRows, {
    clock: createSequenceClock([
      conflictFixture.times.recoveryRequestedAt,
      conflictFixture.times.recoveryRecordedAt,
      conflictFixture.times.liveInspectedAt,
    ]),
    recordRecoveryReceipt: () => {},
  });
  assert.throws(() => conflictProvision({
    packageLifecycleReceiptHash:
      conflictFixture.lifecycleReceipt.packageLifecycleReceiptHash,
  }), /package_retention_recovery_persist_conflict/);
  assert.equal(conflictRows.length, 1);
});
