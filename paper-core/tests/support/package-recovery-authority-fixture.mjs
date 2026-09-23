import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createPackageExactRestoreDrillReceipt,
  createPackageExactRestoreExecutionProof,
  createPackageImmutableRecoverySourceAuthority,
  createPackageLifecycleReceipt,
  createPackageRecoveryRetentionPolicy,
  createPackageRecoveryStorageAuthorityProof,
  createPackageRetentionRecoveryReceipt,
  packageRecoveryStorageAuthoritySubjectHash,
  verifyPackageExactRestoreExecutionProof,
  verifyPackageRecoveryStorageAuthorityProof,
} from '../../../paper-domain/automation/package-lifecycle-authority-contract.mjs';
import {
  packageRecoveryLiveAuthoritySnapshotHash,
  packageRecoveryVerificationOptions,
} from '../../../paper-ports/package-recovery-authority-port.mjs';
import {
  retentionMemberHash,
  retentionMemberIdentity,
} from '../../../paper-adapters/automation/runtime-retention-scope-repository.mjs';
import { createPackageRecoveryExactRestoreRepository }
  from '../../../paper-adapters/automation/package-recovery-exact-restore-repository.mjs';
import { inspectPackageRecoveryTreeInventorySync }
  from '../../../paper-adapters/automation/package-recovery-tree-inventory-repository.mjs';
import { fileSha256HashSync }
  from '../../../paper-adapters/runtime/pinned-file-reader.mjs';
import { hashRecord }
  from '../../../workflow-kernel/record-hash.mjs';
import { createPackageRecoveryDeletionLeaseFixture }
  from './package-recovery-deletion-lease-fixture.mjs';

const h = (value) => hashRecord('PackageRecoveryAuthorityTestFixture', value);

export const PACKAGE_RECOVERY_FIXTURE_TIMES = Object.freeze({
  promotedAt: '2026-08-18T00:00:00.000Z',
  lifecycleRecordedAt: '2026-08-18T00:01:00.000Z',
  storageIssuedAt: '2026-08-18T00:02:00.000Z',
  storageVerifiedAt: '2026-08-18T00:03:00.000Z',
  restoreStartedAt: '2026-08-18T00:04:00.000Z',
  restoreCompletedAt: '2026-08-18T00:05:00.000Z',
  recoveryRequestedAt: '2026-08-18T00:06:00.000Z',
  recoveryRecordedAt: '2026-08-18T00:07:00.000Z',
  liveInspectedAt: '2026-08-18T00:08:00.000Z',
  retainUntil: '2027-08-18T00:00:00.000Z',
});

function restorePermissions(candidate) {
  if (!fs.existsSync(candidate)) return;
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.chmodSync(candidate, 0o700);
    for (const name of fs.readdirSync(candidate)) {
      restorePermissions(path.join(candidate, name));
    }
  } else {
    fs.chmodSync(candidate, 0o600);
  }
}

function storageObjectIdentity(storageObjectPath) {
  const stat = fs.lstatSync(storageObjectPath, { bigint: true });
  const storageObjectRealPath = fs.realpathSync.native(storageObjectPath);
  const identity = Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    nlink: String(stat.nlink),
    realPath: storageObjectRealPath,
  });
  return Object.freeze({
    storageObjectRealPath,
    storageObjectIdentityHash: hashRecord(
      'PackageRecoveryLiveStorageObjectIdentity',
      identity,
    ),
  });
}

function signSubject(keys, signedSubjectHash) {
  return Object.freeze(keys.map(({ keyId, privateKey }) => Object.freeze({
    algorithm: 'ed25519',
    keyId,
    role: 'package_recovery_storage_authority',
    signedSubjectHash,
    value: crypto.sign(
      null,
      Buffer.from(signedSubjectHash, 'utf8'),
      privateKey,
    ).toString('base64'),
  })));
}

function productionIdentityHash(packagePath) {
  return hashRecord(
    'PackageRecoveryTestProductionPackageIdentity',
    retentionMemberIdentity(packagePath),
  );
}

function exactPackageInspection(packagePath, immutableCampaignPackageOutputHash) {
  const inspected = inspectPackageRecoveryTreeInventorySync({ packagePath });
  return Object.freeze({
    packagePath,
    packageContentHash: retentionMemberHash(packagePath),
    packageRecoveryTreeInventoryHash:
      inspected.inventory.packageRecoveryTreeInventoryHash,
    immutableCampaignPackageOutputHash,
    packageDirectoryIdentity: retentionMemberIdentity(packagePath),
  });
}

function archiveInventory(packagePath) {
  const files = [];
  const inventory = inspectPackageRecoveryTreeInventorySync({ packagePath }).inventory;
  for (const entry of inventory.entries.filter((candidate) => candidate.kind === 'file')) {
    const bytes = fs.readFileSync(path.join(packagePath, entry.path));
    files.push(Object.freeze({
      path: entry.path,
      bytesBase64: bytes.toString('base64'),
    }));
  }
  return Object.freeze({
    inventory,
    files: Object.freeze(files),
  });
}

export function createSequenceClock(values) {
  const pending = [...values];
  return Object.freeze({
    nowIso() {
      if (!pending.length) throw new Error('package_recovery_test_clock_exhausted');
      return pending.shift();
    },
  });
}

export function createTestPackageRetentionRecoveryLockRepository() {
  const held = new Set();
  return Object.freeze({
    version: 1,
    kind: 'PackageRetentionRecoveryLockRepository',
    withLifecycleLock(packageLifecycleReceiptHash, operation) {
      if (held.has(packageLifecycleReceiptHash)) {
        throw new Error('package_recovery_test_lock_already_held');
      }
      held.add(packageLifecycleReceiptHash);
      let active = true;
      try {
        return operation(Object.freeze({
          assertHeld() {
            if (!active || !held.has(packageLifecycleReceiptHash)) {
              throw new Error('package_recovery_test_lock_not_held');
            }
          },
        }));
      } finally {
        active = false;
        held.delete(packageLifecycleReceiptHash);
      }
    },
  });
}

export function createTrustedPackageRecoveryAuthorityFixture(t, {
  name = 'generation-a',
  times = PACKAGE_RECOVERY_FIXTURE_TIMES,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-package-recovery-v2-'));
  const runtimeRoot = path.join(root, 'runtime');
  const externalRoot = path.join(root, 'external-recovery');
  const packagePath = path.join(runtimeRoot, 'packages', name);
  const storageObjectPath = path.join(externalRoot, 'objects', `${name}.archive.json`);
  const restoreRoot = path.join(externalRoot, 'restore-drills');
  fs.mkdirSync(packagePath, { recursive: true });
  fs.mkdirSync(path.dirname(storageObjectPath), { recursive: true });
  fs.mkdirSync(restoreRoot, { recursive: true });
  fs.chmodSync(restoreRoot, 0o700);
  fs.writeFileSync(
    path.join(packagePath, 'PACKAGE_RECORD.json'),
    `${JSON.stringify({ generation: name, result: 'production-ready' })}\n`,
  );
  fs.chmodSync(path.join(packagePath, 'PACKAGE_RECORD.json'), 0o444);
  fs.chmodSync(packagePath, 0o500);
  const packageContentHash = retentionMemberHash(packagePath);
  const archived = archiveInventory(packagePath);
  const packageRecoveryTreeInventory = archived.inventory;
  const sourceInventoryHash =
    packageRecoveryTreeInventory.packageRecoveryTreeInventoryHash;
  const immutableCampaignPackageOutputHash = h(`${name}:immutable-output`);
  const release = Object.freeze({
    status: 'current_completed_release',
    campaignId: `${name}-campaign`,
    paperId: 'paper-recovery-v2',
    campaignPlanHash: h(`${name}:plan`),
    packageNodeId: `${name}:package`,
    packageResultHash: h(`${name}:result`),
    campaignReleaseBundleHash: h(`${name}:release-bundle`),
    materializationReceiptHash: h(`${name}:materialization`),
    packagePath,
    immutableCampaignPackageOutputHash,
    packageNodeStatus: 'completed',
    campaignStatus: 'completed',
    promotedAt: times.promotedAt,
    releaseBundle: Object.freeze({ packageOutput: Object.freeze({ packageDir: packagePath }) }),
  });
  const lifecycleReceipt = createPackageLifecycleReceipt({
    runtimeRoot,
    packagePath,
    packageContentHash,
    packageRecoveryTreeInventoryHash: sourceInventoryHash,
    release,
    recordedAt: times.lifecycleRecordedAt,
  });
  const archive = Object.freeze({
    version: 2,
    kind: 'PackageRecoveryTestArchive',
    packageLifecycleReceiptHash: lifecycleReceipt.packageLifecycleReceiptHash,
    packageContentHash,
    sourceInventoryHash,
    packageRecoveryTreeInventory,
    files: archived.files,
  });
  fs.writeFileSync(storageObjectPath, `${JSON.stringify(archive)}\n`);
  fs.chmodSync(storageObjectPath, 0o444);
  const storageObjectBytesHash = fileSha256HashSync(storageObjectPath);
  const exactRestoreRepository = createPackageRecoveryExactRestoreRepository({
    restoreRoot,
    runtimeRoot,
    storageObjectPath,
  });
  const inspectedPackage = exactPackageInspection(
    packagePath,
    immutableCampaignPackageOutputHash,
  );

  const signingKeys = ['recovery-key-a', 'recovery-key-b'].map((keyId) => ({
    keyId,
    ...crypto.generateKeyPairSync('ed25519'),
  }));
  const publicKeys = new Map(signingKeys.map(({ keyId, publicKey }) => [keyId, publicKey]));
  const trustStoreHash = h(signingKeys.map(({ keyId, publicKey }) => ({
    keyId,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  })));
  const ledgerReceipts = new Map();
  const retentionLocks = new Map();
  const storageObjects = new Map();
  const restoreExecutionAttestations = new Map();
  const retentionLockKey = (policy) => [
    policy?.retentionLockAuthorityId,
    policy?.retentionLockId,
  ].join(':');
  const storageObjectKey = (proof) => [
    proof?.storageAuthorityId,
    proof?.storageObjectId,
  ].join(':');
  const retentionPolicy = createPackageRecoveryRetentionPolicy({
    retentionLockAuthorityId: 'test-compliance-lock-authority',
    retentionLockId: `${name}-retention-lock`,
    retentionLockMode: 'compliance',
    retentionLockVersion: `${name}-retention-lock-version-1`,
    retentionLockIdentityHash: h(`${name}:retention-lock-identity`),
    retainUntil: times.retainUntil,
  });
  retentionLocks.set(retentionLockKey(retentionPolicy), {
    status: 'active',
    retentionLockAuthorityId: retentionPolicy.retentionLockAuthorityId,
    retentionLockId: retentionPolicy.retentionLockId,
    retentionLockMode: retentionPolicy.retentionLockMode,
    retentionLockVersion: retentionPolicy.retentionLockVersion,
    retentionLockIdentityHash: retentionPolicy.retentionLockIdentityHash,
    retainUntil: retentionPolicy.retainUntil,
    deletionProtected: true,
    packageRecoveryRetentionPolicyHash:
      retentionPolicy.packageRecoveryRetentionPolicyHash,
  });

  let issuedProofCount = 0;
  const issueStorageProof = ({
    candidateLifecycleReceipt = lifecycleReceipt,
    candidateStorageObjectPath = storageObjectPath,
    candidateStorageObjectBytesHash = storageObjectBytesHash,
    candidateStoredPackageContentHash = packageContentHash,
    candidateSourceInventoryHash = sourceInventoryHash,
    candidateRetentionPolicy = retentionPolicy,
    candidateArchiveSchemaVersion = 2,
    candidateStorageObjectId = null,
    candidateStorageObjectVersion = null,
    candidateLedgerReceiptId = null,
    candidateLedgerReceiptHash = null,
    candidateVerifiedAt = times.storageVerifiedAt,
    candidateVerificationEpoch = null,
    transformSignatures = (signatures) => signatures,
    registerAuthorities = true,
  } = {}) => {
    issuedProofCount += 1;
    const suffix = issuedProofCount === 1 ? '' : `-${issuedProofCount}`;
    const storageObjectId = candidateStorageObjectId
      || `${name}-storage-object${suffix}`;
    const storageObjectVersion = candidateStorageObjectVersion
      || `${name}-storage-object-version${suffix || '-1'}`;
    const ledgerIdentity = Object.freeze({
      receiptId: candidateLedgerReceiptId || `${name}-storage-receipt${suffix}`,
      receiptHash: candidateLedgerReceiptHash
        || h(`${name}:storage-ledger-receipt${suffix || '-1'}`),
      stream: 'package-recovery-storage',
      writerId: 'test-package-recovery-writer',
      writerKind: 'immutable-package-recovery-storage-authority',
      issuerPolicyId: 'test-package-recovery-storage-policy',
      issuerPolicyHash: h('storage-issuer-policy'),
      writerTrusted: true,
    });
    const subjectInput = {
      runtimeRoot: candidateLifecycleReceipt.runtimeRoot,
      paperId: candidateLifecycleReceipt.releaseIdentity.paperId,
      packagePath: candidateLifecycleReceipt.packagePath,
      packageContentHash: candidateLifecycleReceipt.packageContentHash,
      packageLifecycleReceiptHash:
        candidateLifecycleReceipt.packageLifecycleReceiptHash,
      packageReleaseIdentityHash:
        candidateLifecycleReceipt.packageReleaseIdentityHash,
      immutableCampaignPackageOutputHash:
        candidateLifecycleReceipt.releaseIdentity.immutableCampaignPackageOutputHash,
      packageRecoveryTreeInventoryHash: candidateSourceInventoryHash,
      lifecycleRecordedAt: candidateLifecycleReceipt.recordedAt,
      archiveSchemaVersion: candidateArchiveSchemaVersion,
      archiveInventoryHash: candidateSourceInventoryHash,
      storageAuthorityId: 'test-worm-storage-authority',
      storageClass: 'worm',
      storageObjectId,
      storageObjectVersion,
      storageObjectPath: candidateStorageObjectPath,
      storageObjectBytesHash: candidateStorageObjectBytesHash,
      storedPackageContentHash: candidateStoredPackageContentHash,
      sourceInventoryHash: candidateSourceInventoryHash,
      retentionPolicy: candidateRetentionPolicy,
      packageRecoveryRetentionPolicyHash:
        candidateRetentionPolicy.packageRecoveryRetentionPolicyHash,
      trustStoreHash,
      ledgerIdentity,
      issuedAt: times.storageIssuedAt,
      verifiedAt: candidateVerifiedAt,
      verificationEpoch: candidateVerificationEpoch
        || `${name}-verification-epoch${suffix || '-1'}`,
    };
    const signedSubjectHash = packageRecoveryStorageAuthoritySubjectHash(subjectInput);
    const proof = createPackageRecoveryStorageAuthorityProof({
      ...subjectInput,
      signatures: transformSignatures(signSubject(signingKeys, signedSubjectHash)),
    });
    if (registerAuthorities) {
      ledgerReceipts.set(ledgerIdentity.receiptId, {
        ...ledgerIdentity,
        signedSubjectHash,
        active: true,
      });
      if (!retentionLocks.has(retentionLockKey(candidateRetentionPolicy))) {
        retentionLocks.set(retentionLockKey(candidateRetentionPolicy), {
          status: 'active',
          retentionLockAuthorityId:
            candidateRetentionPolicy.retentionLockAuthorityId,
          retentionLockId: candidateRetentionPolicy.retentionLockId,
          retentionLockMode: candidateRetentionPolicy.retentionLockMode,
          retentionLockVersion: candidateRetentionPolicy.retentionLockVersion,
          retentionLockIdentityHash:
            candidateRetentionPolicy.retentionLockIdentityHash,
          retainUntil: candidateRetentionPolicy.retainUntil,
          deletionProtected: true,
          packageRecoveryRetentionPolicyHash:
            candidateRetentionPolicy.packageRecoveryRetentionPolicyHash,
        });
      }
      storageObjects.set(storageObjectKey(proof), {
        status: 'active',
        immutable: true,
        storageAuthorityId: proof.storageAuthorityId,
        storageClass: proof.storageClass,
        storageObjectId: proof.storageObjectId,
        storageObjectVersion: proof.storageObjectVersion,
        storageObjectPath: proof.storageObjectPath,
        storageObjectBytesHash: proof.storageObjectBytesHash,
        storedPackageContentHash: proof.storedPackageContentHash,
        packageLifecycleReceiptHash: proof.packageLifecycleReceiptHash,
        packageReleaseIdentityHash: proof.packageReleaseIdentityHash,
        packagePath: proof.packagePath,
        archiveSchemaVersion: proof.archiveSchemaVersion,
        archiveInventoryHash: proof.archiveInventoryHash,
        packageRecoveryTreeInventoryHash: proof.packageRecoveryTreeInventoryHash,
      });
    }
    return proof;
  };
  const storageAuthorityProof = issueStorageProof();

  const control = {
    createEvidenceCalls: 0,
    inspectLiveCalls: 0,
    storageVerifierMode: 'valid',
    restoreVerifierMode: 'valid',
    evidenceMode: 'valid',
    liveTransform: null,
    restoreTargets: [],
    ledgerReceipts,
    retentionLocks,
    storageObjects,
    restoreExecutionAttestations,
  };

  const verifyStorageAuthorityState = (proof, context = {}, state = {}) => {
    const expectedLifecycle = context.lifecycleReceipt || state.lifecycleReceipt;
    const authoritativeLedger = state.ledgerReceipts
      ?.get(proof?.ledgerIdentity?.receiptId);
    const authoritativeLock = state.retentionLocks
      ?.get(retentionLockKey(proof?.retentionPolicy));
    const authoritativeObject = state.storageObjects?.get(storageObjectKey(proof));
    if (!verifyPackageRecoveryStorageAuthorityProof(proof).valid
      || proof.trustStoreHash !== state.trustStoreHash
      || packageRecoveryStorageAuthoritySubjectHash(proof) !== proof.signedSubjectHash
      || proof.runtimeRoot !== expectedLifecycle?.runtimeRoot
      || proof.paperId !== expectedLifecycle?.releaseIdentity?.paperId
      || proof.packagePath !== expectedLifecycle?.packagePath
      || proof.packageContentHash !== expectedLifecycle?.packageContentHash
      || proof.packageLifecycleReceiptHash
        !== expectedLifecycle?.packageLifecycleReceiptHash
      || proof.packageReleaseIdentityHash
        !== expectedLifecycle?.packageReleaseIdentityHash
      || proof.immutableCampaignPackageOutputHash
        !== expectedLifecycle?.releaseIdentity?.immutableCampaignPackageOutputHash
      || proof.packageRecoveryTreeInventoryHash
        !== expectedLifecycle?.packageRecoveryTreeInventoryHash
      || proof.lifecycleRecordedAt !== expectedLifecycle?.recordedAt
      || authoritativeLedger?.active !== true
      || authoritativeLedger.receiptId !== proof.ledgerIdentity.receiptId
      || authoritativeLedger.receiptHash !== proof.ledgerIdentity.receiptHash
      || authoritativeLedger.signedSubjectHash !== proof.signedSubjectHash
      || authoritativeLedger.stream !== proof.ledgerIdentity.stream
      || authoritativeLedger.writerId !== proof.ledgerIdentity.writerId
      || authoritativeLedger.writerKind !== proof.ledgerIdentity.writerKind
      || authoritativeLedger.issuerPolicyId !== proof.ledgerIdentity.issuerPolicyId
      || authoritativeLedger.issuerPolicyHash !== proof.ledgerIdentity.issuerPolicyHash
      || authoritativeLedger.writerTrusted !== true
      || authoritativeLedger.writerTrusted !== proof.ledgerIdentity.writerTrusted
      || authoritativeLock?.status !== 'active'
      || authoritativeLock.retentionLockAuthorityId
        !== proof.retentionPolicy.retentionLockAuthorityId
      || authoritativeLock.retentionLockId !== proof.retentionPolicy.retentionLockId
      || authoritativeLock.retentionLockVersion
        !== proof.retentionPolicy.retentionLockVersion
      || authoritativeLock.retentionLockIdentityHash
        !== proof.retentionPolicy.retentionLockIdentityHash
      || authoritativeLock.retentionLockMode !== proof.retentionPolicy.retentionLockMode
      || authoritativeLock.retainUntil !== proof.retentionPolicy.retainUntil
      || authoritativeLock.deletionProtected !== true
      || authoritativeLock.packageRecoveryRetentionPolicyHash
        !== proof.packageRecoveryRetentionPolicyHash
      || authoritativeObject?.status !== 'active'
      || authoritativeObject.immutable !== true
      || authoritativeObject.storageAuthorityId !== proof.storageAuthorityId
      || authoritativeObject.storageClass !== proof.storageClass
      || authoritativeObject.storageObjectId !== proof.storageObjectId
      || authoritativeObject.storageObjectVersion !== proof.storageObjectVersion
      || authoritativeObject.storageObjectPath !== proof.storageObjectPath
      || authoritativeObject.storageObjectBytesHash !== proof.storageObjectBytesHash
      || authoritativeObject.storedPackageContentHash !== proof.storedPackageContentHash
      || authoritativeObject.packageLifecycleReceiptHash
        !== proof.packageLifecycleReceiptHash
      || authoritativeObject.packageReleaseIdentityHash
        !== proof.packageReleaseIdentityHash
      || authoritativeObject.packagePath !== proof.packagePath
      || authoritativeObject.archiveSchemaVersion !== proof.archiveSchemaVersion
      || authoritativeObject.archiveInventoryHash !== proof.archiveInventoryHash
      || authoritativeObject.packageRecoveryTreeInventoryHash
        !== proof.packageRecoveryTreeInventoryHash) {
      return false;
    }
    return proof.signatures.every((signature) => {
      const publicKey = state.publicKeys?.get(signature.keyId);
      return Boolean(publicKey && crypto.verify(
        null,
        Buffer.from(proof.signedSubjectHash, 'utf8'),
        publicKey,
        Buffer.from(signature.value, 'base64'),
      ));
    });
  };

  const restoreExecutionAttestation = (proof, context = {}) => Object.freeze({
    version: 1,
    kind: 'PackageRecoveryRestoreExecutionAttestation',
    status: 'package_recovery_restore_execution_attested',
    packageLifecycleReceiptHash:
      context.lifecycleReceipt?.packageLifecycleReceiptHash,
    packageImmutableRecoverySourceAuthorityHash:
      context.recoverySourceAuthority?.packageImmutableRecoverySourceAuthorityHash,
    packageRecoveryStorageAuthorityProofHash:
      context.recoverySourceAuthority?.packageRecoveryStorageAuthorityProofHash,
    packageExactRestoreExecutionProofHash:
      proof?.packageExactRestoreExecutionProofHash,
    attestedProofHash: hashRecord(
      'PackageRecoveryRestoreExecutionAttestedProof',
      proof,
    ),
  });
  const verifyRestoreExecutionAttestation = (
    proof,
    context,
    attestations = restoreExecutionAttestations,
  ) => {
    const recoverySourceAuthority = context?.recoverySourceAuthority;
    if (!verifyPackageExactRestoreExecutionProof(proof, {
      recoverySourceAuthority,
    }).valid) return false;
    const expected = restoreExecutionAttestation(proof, context);
    const persisted = attestations.get(proof.packageExactRestoreExecutionProofHash);
    return Boolean(persisted && hashRecord(
      'PackageRecoveryRestoreExecutionAttestation',
      persisted,
    ) === hashRecord('PackageRecoveryRestoreExecutionAttestation', expected));
  };

  const authority = {
    version: 1,
    kind: 'PackageRecoveryAuthority',
    verifyStorageAuthorityProof(proof, context = {}) {
      if (control.storageVerifierMode === 'throw') {
        throw new Error('test_storage_verifier_failure');
      }
      if (control.storageVerifierMode === 'false') return false;
      return verifyStorageAuthorityState(proof, context, {
        lifecycleReceipt,
        trustStoreHash,
        ledgerReceipts,
        retentionLocks,
        storageObjects,
        publicKeys,
      });
    },
    verifyRestoreExecutionProof(proof, context) {
      if (control.restoreVerifierMode === 'throw') {
        throw new Error('test_restore_verifier_failure');
      }
      if (control.restoreVerifierMode === 'false') return false;
      return verifyRestoreExecutionAttestation(proof, context);
    },
    createRecoveryEvidence({
      lifecycleReceipt: suppliedLifecycleReceipt,
      inspectedPackage: suppliedInspectedPackage,
    } = {}) {
      control.createEvidenceCalls += 1;
      if (control.evidenceMode === 'wrong-shape') return Object.freeze({});
      if (control.evidenceMode === 'promise') return Promise.resolve({});
      if (suppliedLifecycleReceipt?.packageLifecycleReceiptHash
          !== lifecycleReceipt.packageLifecycleReceiptHash
        || suppliedInspectedPackage?.packageContentHash !== packageContentHash
        || suppliedInspectedPackage?.packageRecoveryTreeInventoryHash
          !== sourceInventoryHash) {
        throw new Error('test_package_recovery_preimage_invalid');
      }
      const recoverySourceAuthority = createPackageImmutableRecoverySourceAuthority({
        lifecycleReceipt,
        storageAuthorityProof,
        trustedStorageAuthorityVerifier: (proof, context) =>
          authority.verifyStorageAuthorityProof(proof, context),
      });
      const storedArchive = JSON.parse(fs.readFileSync(storageObjectPath, 'utf8'));
      if (storedArchive?.version !== 2
        || storedArchive.kind !== 'PackageRecoveryTestArchive'
        || storedArchive.packageLifecycleReceiptHash
          !== lifecycleReceipt.packageLifecycleReceiptHash
        || storedArchive.packageContentHash !== packageContentHash
        || storedArchive.sourceInventoryHash !== sourceInventoryHash
        || storedArchive.packageRecoveryTreeInventory
          ?.packageRecoveryTreeInventoryHash !== sourceInventoryHash
        || !Array.isArray(storedArchive.files)) {
        throw new Error('package_recovery_test_archive_invalid');
      }
      const archivedFileBytes = new Map(storedArchive.files.map((file) => [
        file.path,
        Buffer.from(file.bytesBase64, 'base64'),
      ]));
      if (archivedFileBytes.size !== storedArchive.files.length
        || archivedFileBytes.size !== storedArchive.packageRecoveryTreeInventory.entries
          .filter((entry) => entry.kind === 'file').length) {
        throw new Error('package_recovery_test_archive_invalid');
      }
      const productionPackageIdentityHashBefore = productionIdentityHash(packagePath);
      const productionPackageContentHashBefore = retentionMemberHash(packagePath);
      const productionInventoryBefore =
        inspectPackageRecoveryTreeInventorySync({ packagePath }).inventory;
      const restoreExecutionProof = exactRestoreRepository.withExactRestore({
        expectedInventory: storedArchive.packageRecoveryTreeInventory,
        readFileBytes(relativePath) {
          const bytes = archivedFileBytes.get(relativePath);
          if (!bytes) throw new Error('package_recovery_test_archive_file_missing');
          return bytes;
        },
        operation({
          restoreTargetPath,
          restoreTargetIdentityHash,
          restoredInventory,
          assertLive,
        }) {
          control.restoreTargets.push(restoreTargetPath);
          const restoredPackageContentHash = retentionMemberHash(restoreTargetPath);
          const productionPackageIdentityHashAfter = productionIdentityHash(packagePath);
          const productionPackageContentHashAfter = retentionMemberHash(packagePath);
          const productionInventoryAfter =
            inspectPackageRecoveryTreeInventorySync({ packagePath }).inventory;
          assertLive();
          return createPackageExactRestoreExecutionProof({
            recoverySourceAuthority,
            restoreTargetPath,
            restoreTargetIdentityHash,
            expectedPackageContentHash: packageContentHash,
            restoredPackageContentHash,
            expectedPackageRecoveryTreeInventoryHash: sourceInventoryHash,
            restoredPackageRecoveryTreeInventoryHash:
              restoredInventory.packageRecoveryTreeInventoryHash,
            productionPackagePath: packagePath,
            productionPackageIdentityHashBefore,
            productionPackageIdentityHashAfter,
            productionPackageContentHashBefore,
            productionPackageContentHashAfter,
            productionPackageRecoveryTreeInventoryHashBefore:
              productionInventoryBefore.packageRecoveryTreeInventoryHash,
            productionPackageRecoveryTreeInventoryHashAfter:
              productionInventoryAfter.packageRecoveryTreeInventoryHash,
            startedAt: times.restoreStartedAt,
            completedAt: times.restoreCompletedAt,
          });
        },
      });
      restoreExecutionAttestations.set(
        restoreExecutionProof.packageExactRestoreExecutionProofHash,
        restoreExecutionAttestation(restoreExecutionProof, {
          lifecycleReceipt,
          recoverySourceAuthority,
        }),
      );
      const restoreDrillReceipt = createPackageExactRestoreDrillReceipt({
        lifecycleReceipt,
        recoverySourceAuthority,
        restoreExecutionProof,
        trustedStorageAuthorityVerifier: (proof, context) =>
          authority.verifyStorageAuthorityProof(proof, context),
        trustedRestoreDrillVerifier: (proof, context) =>
          authority.verifyRestoreExecutionProof(proof, context),
      });
      return Object.freeze({ recoverySourceAuthority, restoreDrillReceipt });
    },
    inspectLiveRecoverySource({ recoveryReceipt, lifecycleReceipt: suppliedLifecycle } = {}) {
      control.inspectLiveCalls += 1;
      const recoverySource = recoveryReceipt?.recoverySourceAuthority;
      const liveStoragePath = recoverySource?.storageObjectPath;
      const identity = storageObjectIdentity(liveStoragePath);
      const livePayload = {
        valid: true,
        blockers: [],
        sourcePresent: true,
        immutable: true,
        deletionProtected: true,
        packageLifecycleReceiptHash:
          suppliedLifecycle?.packageLifecycleReceiptHash,
        packageRecoveryStorageAuthorityProofHash:
          recoverySource?.packageRecoveryStorageAuthorityProofHash,
        packageRecoveryRetentionPolicyHash:
          recoverySource?.packageRecoveryRetentionPolicyHash,
        storageAuthorityId: recoverySource?.storageAuthorityId,
        storageClass: recoverySource?.storageClass,
        storageObjectId: recoverySource?.storageObjectId,
        storageObjectVersion: recoverySource?.storageObjectVersion,
        storageObjectPath: liveStoragePath,
        storageObjectRealPath: identity.storageObjectRealPath,
        storageObjectIdentityHash: identity.storageObjectIdentityHash,
        storageObjectBytesHash: fileSha256HashSync(liveStoragePath),
        storageIssuerPolicyHash:
          recoverySource?.storageAuthorityProof?.ledgerIdentity?.issuerPolicyHash,
        storageLedgerReceiptHash:
          recoverySource?.storageAuthorityProof?.ledgerIdentity?.receiptHash,
        storageLedgerReceiptId:
          recoverySource?.storageAuthorityProof?.ledgerIdentity?.receiptId,
        trustStoreHash: recoverySource?.storageAuthorityProof?.trustStoreHash,
        sourceInventoryHash: recoverySource?.sourceInventoryHash,
        packageRecoveryTreeInventoryHash:
          recoverySource?.packageRecoveryTreeInventoryHash,
        retentionLockVersion: recoverySource?.retentionLockVersion,
        retentionLockIdentityHash: recoverySource?.retentionLockIdentityHash,
        retainUntil: recoverySource?.retainUntil,
      };
      const live = {
        ...livePayload,
        authoritySnapshotHash: packageRecoveryLiveAuthoritySnapshotHash(livePayload),
      };
      return typeof control.liveTransform === 'function'
        ? control.liveTransform(live)
        : live;
    },
  };

  const cloneAuthorityRecords = (records) => new Map(
    [...records].map(([key, value]) => [key, structuredClone(value)]),
  );
  const createRestartedVerificationAuthority = () => {
    const persistedState = Object.freeze({
      lifecycleReceipt: structuredClone(lifecycleReceipt),
      trustStoreHash,
      ledgerReceipts: cloneAuthorityRecords(ledgerReceipts),
      retentionLocks: cloneAuthorityRecords(retentionLocks),
      storageObjects: cloneAuthorityRecords(storageObjects),
      publicKeys: new Map(signingKeys.map(({ keyId, publicKey }) => [
        keyId,
        crypto.createPublicKey(publicKey.export({ type: 'spki', format: 'pem' })),
      ])),
    });
    const persistedRestoreAttestations = cloneAuthorityRecords(
      restoreExecutionAttestations,
    );
    return Object.freeze({
      version: 1,
      kind: 'PackageRecoveryAuthority',
      verifyStorageAuthorityProof: (proof, context = {}) =>
        verifyStorageAuthorityState(proof, context, persistedState),
      verifyRestoreExecutionProof: (proof, context = {}) =>
        verifyRestoreExecutionAttestation(
          proof,
          context,
          persistedRestoreAttestations,
        ),
    });
  };

  const createRecoveryReceipt = ({
    recordedAt = times.recoveryRecordedAt,
  } = {}) => {
    const evidence = authority.createRecoveryEvidence({
      lifecycleReceipt,
      inspectedPackage,
      recordedAt: times.recoveryRequestedAt,
    });
    return createPackageRetentionRecoveryReceipt({
      lifecycleReceipt,
      recoverySourceAuthority: evidence.recoverySourceAuthority,
      restoreDrillReceipt: evidence.restoreDrillReceipt,
      recordedAt,
      ...packageRecoveryVerificationOptions(authority),
    });
  };

  t.after(() => {
    restorePermissions(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const deletionLease = createPackageRecoveryDeletionLeaseFixture();
  return Object.freeze({
    root,
    runtimeRoot,
    externalRoot,
    packagePath,
    storageObjectPath,
    storageObjectBytesHash,
    sourceInventoryHash,
    packageRecoveryTreeInventory,
    release,
    lifecycleReceipt,
    inspectedPackage,
    retentionPolicy,
    storageAuthorityProof,
    authority,
    packageRecoveryDeletionLeasePort: deletionLease.port,
    packageRecoveryDeletionLeaseControl: deletionLease,
    control,
    times,
    issueStorageProof,
    createRecoveryReceipt,
    createRestartedVerificationAuthority,
  });
}
