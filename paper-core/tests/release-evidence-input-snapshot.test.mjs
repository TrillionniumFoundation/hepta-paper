import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { releaseIntegrityEvidence } from '../bin/release-integrity-evidence.mjs';
import {
  assertReleaseEvidenceInputSnapshotUnchanged,
  assertValidReleaseEvidenceInputSnapshot,
  buildReleaseEvidenceProofSetSnapshot,
  captureReleaseEvidenceInputSnapshot,
  projectReleaseEvidenceSemanticContract,
  releaseAttestationCodeProvenance,
} from '../bin/release-evidence-input-snapshot.mjs';
import {
  buildReleaseEvidenceBundle,
} from '../bin/release-evidence-bundle.mjs';
import {
  captureProductionStoreLogicalIntegrity,
  captureReleaseEvidenceRegularFile,
} from '../bin/release-evidence-input-file-capture.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const { publishJsonArtifactSet } = releaseIntegrityEvidence;

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const hash = (character) => `sha256:${character.repeat(64)}`;

function fileCapture(file, character, present = true) {
  return present
    ? {
      present: true,
      path: file,
      fileHash: hash(character),
      device: '1',
      inode: String(character.codePointAt(0)),
      size: 10,
      mode: 0o600,
      mtimeMs: 1,
      ctimeMs: 1,
    }
    : { present: false, path: file, fileHash: null };
}

function finalizeSnapshot(value) {
  const payload = structuredClone(value);
  delete payload.releaseEvidenceInputSnapshotHash;
  return {
    ...payload,
    releaseEvidenceInputSnapshotHash: hashRecord('ReleaseEvidenceInputSnapshot', payload),
  };
}

function readySnapshot() {
  const workspaceRoot = '/test/workspace';
  const runtimeRoot = '/test/runtime';
  const legacyRoot = '/test/legacy';
  const implementationProofSet = buildReleaseEvidenceProofSetSnapshot(
    'implementation',
    new Map([['alpha', { receiptHash: hash('1') }]]),
  );
  const conformanceProofSet = buildReleaseEvidenceProofSetSnapshot(
    'release_bound_conformance',
    new Map([['alpha', { receiptHash: hash('2') }]]),
  );
  const operationalProofSet = buildReleaseEvidenceProofSetSnapshot(
    'independent_production_operational',
    new Map([['alpha', { receiptHash: hash('3') }]]),
  );
  return finalizeSnapshot({
    version: 1,
    kind: 'ReleaseEvidenceInputSnapshot',
    releaseStateSnapshot: {
      headCommit: 'a'.repeat(40),
      workspaceReleaseStateSnapshotHash: hash('a'),
    },
    codeProvenance: {
      commit: 'a'.repeat(40),
      packageVersion: '1.0.0',
      treeDirty: false,
    },
    verificationReceiptEvidence: {
      status: 'release_verification_current_evidence_verified',
      releaseEvidenceReady: true,
      receipt: { codeProvenance: { commit: 'a'.repeat(40) } },
      receiptHash: hash('4'),
      candidateFileHash: hash('5'),
      candidateRelativePath: 'verification/receipt.json',
      pinnedPublicKeyFingerprint: hash('6'),
      blockers: [],
    },
    capabilityManifestEvidence: {
      status: 'current_capability_verification_manifest_evidence_verified',
      releaseEvidenceReady: true,
      pointer: {
        capabilityVerificationManifestHash: hash('7'),
        currentCapabilityVerificationManifestPointerHash: hash('8'),
      },
      targetFileHash: hash('9'),
      targetRelativePath: 'capability/manifest.json',
      pointerFileHash: hash('b'),
      pointerRelativePath: 'capability/current.json',
      pinnedPublicKeyFingerprint: hash('c'),
      blockers: [],
    },
    deletionDrillEvidence: {
      status: 'legacy_deletion_drill_current_evidence_verified',
      releaseEvidenceReady: true,
      receipt: { status: 'legacy_reference_restore_drill_passed_deletion_blocked' },
      receiptHash: hash('d'),
      claimedReceiptHash: hash('d'),
      candidateFileHash: hash('e'),
      candidateRelativePath: 'legacy/deletion.json',
      pinnedPublicKeyFingerprint: hash('f'),
      blockers: [],
      receiptBlockers: [],
    },
    immutableSnapshotEvidence: {
      status: 'legacy_immutable_snapshot_current_evidence_verified',
      releaseEvidenceReady: true,
      receipt: {
        status: 'legacy_reference_ext4_inode_immutable',
        immutableContentObjectClaimed: true,
      },
      receiptHash: hash('1'),
      candidateFileHash: hash('2'),
      candidatePath: '/test/archive/receipt.json',
      signatureFileHash: hash('3'),
      signaturePath: '/test/archive/signature.json',
      pinnedPublicKeyFingerprint: hash('4'),
      currentArchive: { archiveHash: hash('5') },
      blockers: [],
    },
    capabilityCount: 1,
    capabilityCatalogHash: hash('6'),
    implementationProofSet,
    conformanceProofSet,
    operationalProofSet,
    trustLayerGate: { status: 'code_release_trust_layers_ready' },
    coldVolumeContract: fileCapture('/test/cold.json', '7'),
    coldVolumeStatus: { contractValid: true, contractHash: hash('8') },
    minimalDifferentialFixture: {
      status: 'legacy_differential_reference_verified',
      archiveSha256: hash('9'),
    },
    immutableMatrixReference: {
      status: 'immutable_legacy_matrix_reference_ready',
      matrixSha256: hash('a'),
    },
    productionStoreLogicalIntegrity: {
      status: 'sqlite_logical_integrity_verified',
      logicalDatabaseHash: hash('b'),
    },
    coldVolumeCas: { status: 'cold_volume_cas_ready', manifestHash: hash('c') },
    offhostWormContract: fileCapture('/test/offhost.json', 'd'),
    offhostWormStatus: { offHostOrOffsiteCustodyQualified: true },
    runtimeHygieneExport: fileCapture('/test/hygiene.json', 'e'),
    authorityTrustStore: fileCapture('/test/trust.json', 'f'),
    inputs: {
      workspaceRoot,
      runtimeRoot,
      legacyRoot: {
        present: false,
        path: legacyRoot,
      },
      legacyDatabase: fileCapture('/test/legacy/paper_factory.sqlite', '1'),
      archivePath: '/test/archive/reference.tar.gz',
      archiveReadOnlyReceipt: fileCapture('/test/archive/read-only.json', '2'),
      migrationMatrix: fileCapture('/test/workspace/migration/matrix.json', '3'),
      productionDatabase: fileCapture('/test/runtime/hepta-paper.sqlite', '4'),
    },
  });
}

function mutatedSnapshot(snapshot, mutate) {
  const next = structuredClone(snapshot);
  delete next.releaseEvidenceInputSnapshotHash;
  mutate(next);
  return finalizeSnapshot(next);
}

test('proof-set snapshots sort map entries and bind proof content rather than counts', () => {
  const first = buildReleaseEvidenceProofSetSnapshot('implementation', new Map([
    ['beta', { receiptHash: hash('b'), details: { z: 1, a: 2 } }],
    ['alpha', { receiptHash: hash('a') }],
  ]));
  const reordered = buildReleaseEvidenceProofSetSnapshot('implementation', new Map([
    ['alpha', { receiptHash: hash('a') }],
    ['beta', { details: { a: 2, z: 1 }, receiptHash: hash('b') }],
  ]));
  const changed = buildReleaseEvidenceProofSetSnapshot('implementation', new Map([
    ['alpha', { receiptHash: hash('a') }],
    ['beta', { details: { a: 2, z: 1 }, receiptHash: hash('c') }],
  ]));
  assert.deepEqual(first, reordered);
  assert.notEqual(
    first.releaseEvidenceProofSetSnapshotHash,
    changed.releaseEvidenceProofSetSnapshotHash,
  );
  assert.deepEqual(first.entries.map((entry) => entry.key), ['alpha', 'beta']);
});

test('proof-set canonicalization is deterministic across rich values and rejects ambiguity', () => {
  const snapshot = buildReleaseEvidenceProofSetSnapshot('rich-values', new Map([
    ['rich', {
      binary: Buffer.from('bound bytes'),
      date: new Date('2026-08-01T00:00:00.000Z'),
      integer: 42n,
      set: new Set(['beta', 'alpha']),
      array: [true, null, 3],
      omitted: undefined,
    }],
  ]));
  const rich = snapshot.entries[0].value;
  assert.deepEqual(rich.binary, {
    encoding: 'base64',
    value: Buffer.from('bound bytes').toString('base64'),
  });
  assert.equal(rich.date, '2026-08-01T00:00:00.000Z');
  assert.equal(rich.integer, '42');
  assert.deepEqual(rich.set, ['alpha', 'beta']);
  assert.equal(Object.hasOwn(rich, 'omitted'), false);

  for (const [proofs, blocker] of [
    [new Map([['number', Number.NaN]]), 'release_evidence_input_snapshot_number_invalid'],
    [new Map([['date', new Date(Number.NaN)]]), 'release_evidence_input_snapshot_date_invalid'],
    [new Map([[1, true], ['1', false]]), 'release_evidence_input_snapshot_map_key_collision'],
    [new Map([['value', () => {}]]), 'release_evidence_input_snapshot_value_invalid'],
  ]) {
    assert.throws(
      () => buildReleaseEvidenceProofSetSnapshot('invalid', proofs),
      new RegExp(blocker),
    );
  }
  for (const [kind, proofs] of [[null, new Map()], ['valid', {}]]) {
    assert.throws(
      () => buildReleaseEvidenceProofSetSnapshot(kind, proofs),
      /release_evidence_proof_set_inputs_invalid/,
    );
  }
  const provenance = releaseAttestationCodeProvenance({
    commit: 'a'.repeat(40),
    treeDirty: false,
  });
  assert.equal(provenance.evidenceEnvironment, 'administrative');
  assert.equal(provenance.evidenceClass, 'release_attestation');
});

test('semantic projections remove observation time but retain signed evidence time', () => {
  const firstStatus = projectReleaseEvidenceSemanticContract('coldVolumeStatus', {
    version: 1,
    kind: 'ColdVolumeMountContractStatus',
    status: 'cold_volume_contract_verified_volume_unavailable',
    contractValid: true,
    blockers: [],
    observedAt: '2026-08-01T00:00:00.000Z',
    verifiedAt: '2026-08-01T00:00:00.000Z',
    generatedAt: '2026-08-01T00:00:00.000Z',
  });
  const secondStatus = projectReleaseEvidenceSemanticContract('coldVolumeStatus', {
    version: 1,
    kind: 'ColdVolumeMountContractStatus',
    status: 'cold_volume_contract_verified_volume_unavailable',
    contractValid: true,
    blockers: [],
    observedAt: '2026-08-01T00:00:01.000Z',
    verifiedAt: '2026-08-01T00:00:01.000Z',
    generatedAt: '2026-08-01T00:00:01.000Z',
  });
  assert.deepEqual(firstStatus, secondStatus);

  const firstMountBinding = projectReleaseEvidenceSemanticContract('coldVolumeStatus', {
    mountObservationHash: hash('1'),
    targetDirectoryIdentity: { dev: '8', ino: '9' },
    targetDeviceMajorMinor: '8:1',
    targetMountId: '42',
    mountDeviceMatchesTarget: true,
    mountIdMatchesTarget: true,
    mountBindingStable: true,
    expectedStorageIdentityHash: hash('2'),
    storageIdentityMatchesContract: true,
  });
  const changedMountBinding = projectReleaseEvidenceSemanticContract('coldVolumeStatus', {
    mountObservationHash: hash('3'),
    targetDirectoryIdentity: { dev: '8', ino: '10' },
    targetDeviceMajorMinor: '8:1',
    targetMountId: '43',
    mountDeviceMatchesTarget: true,
    mountIdMatchesTarget: false,
    mountBindingStable: false,
    expectedStorageIdentityHash: hash('2'),
    storageIdentityMatchesContract: true,
  });
  assert.notDeepEqual(firstMountBinding, changedMountBinding);
  assert.equal(firstMountBinding.mountBindingStable, true);
  assert.equal(changedMountBinding.mountBindingStable, false);

  const dispositionBinding = projectReleaseEvidenceSemanticContract('coldVolumeStatus', {
    storageAccessPolicyHash: hash('6'),
    coldCasRoot: '/data/home-data/hepta-paper-cold-object-store',
    dispositionHash: hash('7'),
    releaseScopeHash: hash('8'),
    releaseScopeRetired: true,
    releaseGateSatisfied: true,
    retiredEntryCount: 15,
    retiredLogicalPathCount: 0,
    rawDatasetRootCount: 3,
    presentDispositionCount: 0,
    rebuildableDispositionCount: 6,
    missingDispositionCount: 9,
    rawDatasetRows: [{
      datasetId: 'openneuro:ds000030',
      role: 'raw_source_only_not_derived_artifact',
      present: true,
    }],
  });
  assert.equal(dispositionBinding.dispositionHash, hash('7'));
  assert.equal(dispositionBinding.releaseScopeHash, hash('8'));
  assert.equal(dispositionBinding.releaseScopeRetired, true);
  assert.equal(dispositionBinding.releaseGateSatisfied, true);
  assert.equal(dispositionBinding.retiredEntryCount, 15);
  assert.equal(dispositionBinding.retiredLogicalPathCount, 0);
  assert.equal(dispositionBinding.presentDispositionCount, 0);
  assert.equal(dispositionBinding.rebuildableDispositionCount, 6);
  assert.equal(dispositionBinding.missingDispositionCount, 9);
  assert.equal(dispositionBinding.rawDatasetRows[0].role,
    'raw_source_only_not_derived_artifact');

  const offhostMountBinding = projectReleaseEvidenceSemanticContract('offhostWormStatus', {
    mountObservationHash: hash('4'),
    expectedStorageIdentityHash: hash('5'),
    storageIdentityMatchesContract: true,
    mountDeviceMatchesTarget: true,
    mountIdMatchesTarget: true,
  });
  assert.deepEqual(offhostMountBinding, {
    expectedStorageIdentityHash: hash('5'),
    mountDeviceMatchesTarget: true,
    mountIdMatchesTarget: true,
    mountObservationHash: hash('4'),
    storageIdentityMatchesContract: true,
  });

  const firstReceipt = projectReleaseEvidenceSemanticContract('verificationReceiptEvidence', {
    status: 'release_verification_current_evidence_verified',
    receipt: { completedAt: '2026-08-01T00:00:00.000Z' },
  });
  const secondReceipt = projectReleaseEvidenceSemanticContract('verificationReceiptEvidence', {
    status: 'release_verification_current_evidence_verified',
    receipt: { completedAt: '2026-08-01T00:00:01.000Z' },
  });
  assert.notDeepEqual(firstReceipt, secondReceipt);
});

test('regular-file capture uses one pinned descriptor and rejects an A/B/A path swap', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-input-file-'));
  try {
    const selectedPath = path.join(root, 'selected.bin');
    const replacementPath = path.join(root, 'replacement.bin');
    const parkedA = path.join(root, 'parked-a.bin');
    const parkedB = path.join(root, 'parked-b.bin');
    fs.writeFileSync(selectedPath, 'AAAA');
    fs.writeFileSync(replacementPath, 'BBBB');
    let swapped = false;
    const swappingFileSystem = {
      ...fs,
      readSync(...arguments_) {
        if (!swapped) {
          swapped = true;
          fs.renameSync(selectedPath, parkedA);
          fs.renameSync(replacementPath, selectedPath);
        }
        const result = fs.readSync(...arguments_);
        if (fs.existsSync(selectedPath) && !fs.existsSync(parkedB)) {
          fs.renameSync(selectedPath, parkedB);
          fs.renameSync(parkedA, selectedPath);
        }
        return result;
      },
    };
    assert.throws(
      () => captureReleaseEvidenceRegularFile(selectedPath, {
        required: true,
        fileSystem: swappingFileSystem,
      }),
      /release_evidence_input_file_changed/,
    );
    assert.equal(fs.readFileSync(selectedPath, 'utf8'), 'AAAA');
    assert.equal(fs.readFileSync(parkedB, 'utf8'), 'BBBB');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('production logical inspection pins the runtime directory and rejects DB-entry A/B/A', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'release-production-db-'));
  try {
    const runtimeRoot = path.join(parent, 'runtime');
    const databasePath = path.join(runtimeRoot, 'hepta-paper.sqlite');
    const replacementPath = path.join(runtimeRoot, 'replacement.sqlite');
    fs.mkdirSync(runtimeRoot, { mode: 0o700 });
    fs.writeFileSync(databasePath, 'AAAA');
    const captured = captureProductionStoreLogicalIntegrity({
      runtimeRoot,
      inspectLogicalIntegrity: (pinnedPath) => {
        assert.match(pinnedPath, /^\/proc\/self\/fd\/\d+\/hepta-paper\.sqlite$/u);
        assert.equal(fs.readFileSync(pinnedPath, 'utf8'), 'AAAA');
        return {
          version: 1,
          kind: 'SqliteLogicalIntegrityReport',
          status: 'sqlite_logical_integrity_verified',
          dbPath: pinnedPath,
          logicalDatabaseHash: hash('a'),
        };
      },
    });
    assert.equal(captured.database.path, databasePath);
    assert.equal(captured.report.dbPath, databasePath);

    fs.writeFileSync(replacementPath, 'BBBB');
    const parkedA = path.join(runtimeRoot, 'parked-a.sqlite');
    const parkedB = path.join(runtimeRoot, 'parked-b.sqlite');
    assert.throws(
      () => captureProductionStoreLogicalIntegrity({
        runtimeRoot,
        inspectLogicalIntegrity: (pinnedPath) => {
          fs.renameSync(databasePath, parkedA);
          fs.renameSync(replacementPath, databasePath);
          assert.equal(fs.readFileSync(pinnedPath, 'utf8'), 'BBBB');
          fs.renameSync(databasePath, parkedB);
          fs.renameSync(parkedA, databasePath);
          return {
            version: 1,
            kind: 'SqliteLogicalIntegrityReport',
            status: 'sqlite_logical_integrity_verified',
            dbPath: pinnedPath,
            logicalDatabaseHash: hash('a'),
          };
        },
      }),
      /release_evidence_production_database_dependency_changed/,
    );
    assert.equal(fs.readFileSync(databasePath, 'utf8'), 'AAAA');
    assert.equal(fs.readFileSync(parkedB, 'utf8'), 'BBBB');
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('production logical inspection binds SQLite WAL and SHM dependency bytes', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'release-production-sidecars-'));
  try {
    const runtimeRoot = path.join(parent, 'runtime');
    const databasePath = path.join(runtimeRoot, 'hepta-paper.sqlite');
    const walPath = `${databasePath}-wal`;
    const shmPath = `${databasePath}-shm`;
    fs.mkdirSync(runtimeRoot, { mode: 0o700 });
    fs.writeFileSync(databasePath, 'DATABASE-A');
    fs.writeFileSync(walPath, 'WAL-A');
    fs.writeFileSync(shmPath, 'SHM-A');
    const report = () => ({
      version: 1,
      kind: 'SqliteLogicalIntegrityReport',
      status: 'sqlite_logical_integrity_verified',
      logicalDatabaseHash: hash('a'),
    });
    const captured = captureProductionStoreLogicalIntegrity({
      runtimeRoot,
      inspectLogicalIntegrity: report,
    });
    const dependencies = new Map(
      captured.database.dependencies.map((dependency) => [dependency.name, dependency]),
    );
    assert.equal(dependencies.get('hepta-paper.sqlite-wal')?.present, true);
    assert.equal(dependencies.get('hepta-paper.sqlite-shm')?.present, true);
    assert.equal(dependencies.get('hepta-paper.sqlite-journal')?.present, false);

    assert.throws(
      () => captureProductionStoreLogicalIntegrity({
        runtimeRoot,
        inspectLogicalIntegrity: () => {
          fs.writeFileSync(walPath, 'WAL-B');
          fs.writeFileSync(walPath, 'WAL-A');
          return report();
        },
      }),
      /release_evidence_production_database_dependency_changed/,
    );
    assert.equal(fs.readFileSync(walPath, 'utf8'), 'WAL-A');
    assert.equal(fs.readFileSync(shmPath, 'utf8'), 'SHM-A');
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('production logical inspection stays on the pinned directory during root replacement', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'release-production-root-'));
  try {
    const runtimeRoot = path.join(parent, 'runtime');
    const displacedRoot = path.join(parent, 'runtime-displaced');
    fs.mkdirSync(runtimeRoot, { mode: 0o700 });
    fs.writeFileSync(path.join(runtimeRoot, 'hepta-paper.sqlite'), 'AAAA');
    assert.throws(
      () => captureProductionStoreLogicalIntegrity({
        runtimeRoot,
        inspectLogicalIntegrity: (pinnedPath) => {
          fs.renameSync(runtimeRoot, displacedRoot);
          fs.mkdirSync(runtimeRoot, { mode: 0o700 });
          fs.writeFileSync(path.join(runtimeRoot, 'hepta-paper.sqlite'), 'BBBB');
          assert.equal(fs.readFileSync(pinnedPath, 'utf8'), 'AAAA');
          return {
            version: 1,
            kind: 'SqliteLogicalIntegrityReport',
            status: 'sqlite_logical_integrity_verified',
            dbPath: pinnedPath,
            logicalDatabaseHash: hash('a'),
          };
        },
      }),
      /release_evidence_production_database_changed_during_snapshot/,
    );
    assert.equal(
      fs.readFileSync(path.join(displacedRoot, 'hepta-paper.sqlite'), 'utf8'),
      'AAAA',
    );
    assert.equal(fs.readFileSync(path.join(runtimeRoot, 'hepta-paper.sqlite'), 'utf8'), 'BBBB');
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('bundle construction consumes a supplied snapshot and binds its single hash', () => {
  const snapshot = readySnapshot();
  const bundle = buildReleaseEvidenceBundle({
    workspaceRoot: snapshot.inputs.workspaceRoot,
    runtimeRoot: snapshot.inputs.runtimeRoot,
    legacyRoot: snapshot.inputs.legacyRoot.path,
    expectedReleaseStateSnapshotHash:
      snapshot.releaseStateSnapshot.workspaceReleaseStateSnapshotHash,
    inputSnapshot: snapshot,
    now: new Date('2026-08-01T00:00:00.000Z'),
  });
  assert.equal(bundle.status, 'code_release_evidence_ready');
  assert.equal(
    bundle.bindings.releaseEvidenceInputSnapshotHash,
    snapshot.releaseEvidenceInputSnapshotHash,
  );
  assert.equal(
    bundle.bindings.implementationProofSetHash,
    snapshot.implementationProofSet.releaseEvidenceProofSetSnapshotHash,
  );
});

test('bundle scope and nullable evidence mutations remain fail-closed', () => {
  const snapshot = readySnapshot();
  assert.throws(() => buildReleaseEvidenceBundle({
    workspaceRoot: '/different/workspace',
    runtimeRoot: snapshot.inputs.runtimeRoot,
    legacyRoot: snapshot.inputs.legacyRoot.path,
    inputSnapshot: snapshot,
  }), /release_evidence_input_snapshot_scope_mismatch/);

  const blocked = mutatedSnapshot(snapshot, (value) => {
    value.verificationReceiptEvidence.receiptHash = null;
    value.verificationReceiptEvidence.candidateFileHash = null;
    value.verificationReceiptEvidence.candidateRelativePath = null;
    value.verificationReceiptEvidence.pinnedPublicKeyFingerprint = null;
    value.capabilityManifestEvidence.pointer = null;
    value.capabilityManifestEvidence.targetFileHash = null;
    value.capabilityManifestEvidence.targetRelativePath = null;
    value.capabilityManifestEvidence.pointerFileHash = null;
    value.capabilityManifestEvidence.pointerRelativePath = null;
    value.capabilityManifestEvidence.pinnedPublicKeyFingerprint = null;
    value.deletionDrillEvidence.receiptHash = null;
    value.deletionDrillEvidence.claimedReceiptHash = null;
    value.deletionDrillEvidence.candidateFileHash = null;
    value.deletionDrillEvidence.candidateRelativePath = null;
    value.deletionDrillEvidence.pinnedPublicKeyFingerprint = null;
    value.deletionDrillEvidence.receiptBlockers = undefined;
    value.immutableSnapshotEvidence.currentArchive = null;
    value.immutableSnapshotEvidence.receiptHash = null;
    value.immutableSnapshotEvidence.candidateFileHash = null;
    value.immutableSnapshotEvidence.candidatePath = null;
    value.immutableSnapshotEvidence.signatureFileHash = null;
    value.immutableSnapshotEvidence.signaturePath = null;
    value.immutableSnapshotEvidence.pinnedPublicKeyFingerprint = null;
    value.productionStoreLogicalIntegrity = null;
    value.coldVolumeCas.status = 'cold_volume_cas_blocked';
    value.offhostWormStatus.offHostOrOffsiteCustodyQualified = false;
    value.trustLayerGate.status = 'code_release_trust_layers_blocked';
  });
  const bundle = buildReleaseEvidenceBundle({
    workspaceRoot: blocked.inputs.workspaceRoot,
    runtimeRoot: blocked.inputs.runtimeRoot,
    legacyRoot: blocked.inputs.legacyRoot.path,
    inputSnapshot: blocked,
    now: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(bundle.status, 'code_release_evidence_blocked');
  assert.equal(bundle.disasterRecoveryStatus, 'disaster_recovery_blocked');
  assert.equal(bundle.bindings.capabilityVerificationManifestHash, null);
  assert.equal(bundle.bindings.productionStoreLogicalHash, null);
});

test('snapshot capture rejects an incomplete clean release workspace after provenance binding', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-input-capture-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  const runtimeRoot = path.join(root, 'runtime');
  const legacyRoot = path.join(root, 'legacy');
  fs.mkdirSync(path.join(workspaceRoot, 'paper-core', 'docs'), { recursive: true });
  fs.mkdirSync(runtimeRoot);
  for (const relative of [
    'package.json',
    'package-lock.json',
    'paper-core/docs/CURRENT_STATUS.md',
    'RELEASE.md',
    'CHANGELOG.md',
  ]) {
    fs.copyFileSync(path.join(WORKSPACE_ROOT, relative), path.join(workspaceRoot, relative));
  }
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'release-fixture@example.test'],
    ['config', 'user.name', 'Release Fixture'],
    ['add', '.'],
    ['commit', '-qm', 'release fixture'],
  ]) {
    const child = spawnSync('git', args, { cwd: workspaceRoot, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
  }
  assert.throws(
    () => captureReleaseEvidenceInputSnapshot({
      workspaceRoot,
      runtimeRoot,
      legacyRoot,
      environment: {},
      now: new Date('2026-08-01T00:00:00.000Z'),
    }),
  );
});

test('every readiness input category changes the unified snapshot hash', async (context) => {
  const snapshot = readySnapshot();
  const cases = [
    ['release state', (value) => { value.releaseStateSnapshot.headCommit = 'b'.repeat(40); }],
    ['code provenance', (value) => { value.codeProvenance.commit = 'b'.repeat(40); }],
    ['verification selector', (value) => { value.verificationReceiptEvidence.receiptHash = hash('0'); }],
    ['capability selector', (value) => { value.capabilityManifestEvidence.targetFileHash = hash('0'); }],
    ['deletion selector', (value) => { value.deletionDrillEvidence.receiptHash = hash('0'); }],
    ['immutable selector', (value) => { value.immutableSnapshotEvidence.receiptHash = hash('0'); }],
    ['cold contract', (value) => { value.coldVolumeContract.fileHash = hash('0'); }],
    ['cold readiness', (value) => { value.coldVolumeStatus.contractValid = false; }],
    ['differential fixture', (value) => { value.minimalDifferentialFixture.archiveSha256 = hash('0'); }],
    ['immutable matrix', (value) => { value.immutableMatrixReference.matrixSha256 = hash('0'); }],
    ['production integrity', (value) => { value.productionStoreLogicalIntegrity.logicalDatabaseHash = hash('0'); }],
    ['implementation proofs', (value) => { value.implementationProofSet.entries[0].value.receiptHash = hash('0'); }],
    ['conformance proofs', (value) => { value.conformanceProofSet.entries[0].value.receiptHash = hash('0'); }],
    ['operational proofs', (value) => { value.operationalProofSet.entries[0].value.receiptHash = hash('0'); }],
    ['trust-layer gate', (value) => { value.trustLayerGate.status = 'code_release_trust_layers_blocked'; }],
    ['legacy root', (value) => { value.inputs.legacyRoot.present = true; }],
    ['legacy database', (value) => { value.inputs.legacyDatabase.fileHash = hash('0'); }],
    ['read-only receipt', (value) => { value.inputs.archiveReadOnlyReceipt.fileHash = hash('0'); }],
    ['migration matrix', (value) => { value.inputs.migrationMatrix.fileHash = hash('0'); }],
    ['cold CAS', (value) => { value.coldVolumeCas.manifestHash = hash('0'); }],
    ['offhost contract', (value) => { value.offhostWormContract.fileHash = hash('0'); }],
    ['offhost readiness', (value) => { value.offhostWormStatus.offHostOrOffsiteCustodyQualified = false; }],
    ['runtime hygiene', (value) => { value.runtimeHygieneExport.fileHash = hash('0'); }],
    ['authority trust store', (value) => { value.authorityTrustStore.fileHash = hash('0'); }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, () => {
      const changed = mutatedSnapshot(snapshot, mutate);
      assert.notEqual(
        changed.releaseEvidenceInputSnapshotHash,
        snapshot.releaseEvidenceInputSnapshotHash,
      );
      assert.throws(
        () => assertReleaseEvidenceInputSnapshotUnchanged({
          expectedSnapshotHash: snapshot.releaseEvidenceInputSnapshotHash,
          capture: () => changed,
        }),
        /release_evidence_input_snapshot_changed/,
      );
    });
  }
});

test('snapshot validation rejects stale self-hashes and capture failures fail closed', () => {
  const snapshot = readySnapshot();
  assert.equal(assertValidReleaseEvidenceInputSnapshot(snapshot), snapshot);
  assert.throws(
    () => assertValidReleaseEvidenceInputSnapshot({
      ...snapshot,
      coldVolumeStatus: { contractValid: false },
    }),
    /release_evidence_input_snapshot_invalid/,
  );
  assert.throws(
    () => assertReleaseEvidenceInputSnapshotUnchanged({
      expectedSnapshotHash: snapshot.releaseEvidenceInputSnapshotHash,
      capture: () => { throw new Error('input unavailable'); },
    }),
    /release_evidence_input_snapshot_changed/,
  );

  const invalidProofs = [
    (value) => { value.implementationProofSet.version = 2; },
    (value) => { value.conformanceProofSet.proofKind = 'implementation'; },
    (value) => { value.operationalProofSet.count += 1; },
    (value) => { value.implementationProofSet.entries[0].key = 1; },
    (value) => { value.conformanceProofSet.entries.push(
      structuredClone(value.conformanceProofSet.entries[0]),
    ); },
  ];
  for (const mutate of invalidProofs) {
    const invalid = structuredClone(snapshot);
    mutate(invalid);
    assert.throws(
      () => assertValidReleaseEvidenceInputSnapshot(invalid),
      /release_evidence_input_snapshot_invalid/,
    );
  }
  assert.throws(
    () => assertReleaseEvidenceInputSnapshotUnchanged({}),
    /release_evidence_input_snapshot_boundary_invalid/,
  );
});

test('snapshot drift before or after pointer publication rolls back the entire artifact set', async (context) => {
  const snapshot = readySnapshot();
  const changed = mutatedSnapshot(snapshot, (value) => {
    value.authorityTrustStore.fileHash = hash('0');
  });
  for (const boundary of ['beforePointer', 'afterPointer']) {
    await context.test(boundary, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-input-snapshot-'));
      try {
        const artifactPath = path.join(root, 'bundle.json');
        const pointerPath = path.join(root, 'current.json');
        const stable = () => assertReleaseEvidenceInputSnapshotUnchanged({
          expectedSnapshotHash: snapshot.releaseEvidenceInputSnapshotHash,
          capture: () => boundary === 'beforePointer' || fs.existsSync(pointerPath)
            ? changed
            : snapshot,
        });
        assert.throws(
          () => publishJsonArtifactSet({
            entries: [{ path: artifactPath, value: { bundle: true } }],
            pointerPath,
            pointerValue: { current: true },
            beforePointer: boundary === 'beforePointer' ? stable : () => {},
            afterPointer: boundary === 'afterPointer' ? stable : () => {},
          }),
          /release_evidence_input_snapshot_changed/,
        );
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(pointerPath), false);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }
});
