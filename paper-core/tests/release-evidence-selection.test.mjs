import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { releaseIntegrityEvidence } from '../bin/release-integrity-evidence.mjs';
import {
  releaseAttestationCodeProvenance,
} from '../bin/release-evidence-input-snapshot.mjs';
import {
  retirementLifecycleStatus,
} from '../bin/release-evidence-bundle.mjs';
import {
  selectCurrentCapabilityVerificationManifest,
} from '../bin/release-capability-manifest-selection.mjs';
import {
  selectCurrentLegacyDeletionDrillReceipt,
} from '../bin/release-evidence-legacy-deletion-drill.mjs';
import {
  selectCurrentReleaseVerificationReceipt,
} from '../bin/release-verification-receipt-selection.mjs';
import { signReleasePayload } from '../bin/release-integrity-signing.mjs';
import { buildIsolatedVerificationReceipt } from '../src/isolated-verification-receipt-contract.mjs';
import { publishIsolatedVerificationReceiptArtifacts } from '../bin/isolated-verification-receipt-publication.mjs';
import {
  parseReleaseEvidenceArguments,
  releaseEvidenceUsage,
} from '../bin/release-evidence.mjs';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { resolveImmutableLegacyMatrixArchive } from '../../migration/legacy-matrix-reference.mjs';

const {
  assertExactCleanCodeProvenance,
  publishJsonArtifactSet,
  writeNoClobberJsonFile,
} = releaseIntegrityEvidence;

const NOW = new Date('2026-08-01T04:00:00.000Z');
const RELEASE_INTEGRITY_AUTHORITY_LIMIT =
  'build_and_archive_integrity_only_not_owner_academic_referee_or_submission_authority';
const NON_ISOLATED_TEST_ENVIRONMENT = Object.freeze({
  HEPTA_PAPER_RUNTIME_ISOLATED: '0',
});

function sha256Json(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function releaseStateSnapshot(commit = '1'.repeat(40)) {
  const documentHashes = Object.freeze(Object.fromEntries([
    ['packageJson', 'package.json'],
    ['packageLock', 'package-lock.json'],
    ['currentStatus', 'paper-core/docs/CURRENT_STATUS.md'],
    ['releaseDocument', 'RELEASE.md'],
    ['changelog', 'CHANGELOG.md'],
  ].map(([name, selectedPath], index) => [name, Object.freeze({
    path: selectedPath,
    sha256: `sha256:${String(index + 1).repeat(64)}`,
  })])));
  const payload = {
    version: 2,
    kind: 'WorkspaceReleaseStateSnapshot',
    status: 'workspace_release_state_release_ready',
    headCommit: commit,
    headTags: [],
    allTags: [],
    documentHashes,
    releaseState: {
      version: '0.21.0',
      kind: 'ReleaseStateConsistency',
      contractVersion: 2,
      state: 'release_ready',
      documentationProfile: 'finalized',
      ok: true,
      errors: [],
    },
  };
  return Object.freeze({
    ...payload,
    workspaceReleaseStateSnapshotHash: sha256Json(payload),
  });
}

function exactProvenance(overrides = {}) {
  return releaseAttestationCodeProvenance({
    version: 2,
    kind: 'CodeProvenance',
    packageVersion: '0.21.0',
    commit: '1'.repeat(40),
    commitTree: '2'.repeat(40),
    tags: [],
    treeDirty: false,
    indexStateHash: `sha256:${'3'.repeat(64)}`,
    repositoryEntryCount: 1900,
    repositoryContentHash: `sha256:${'4'.repeat(64)}`,
    worktreeStateHash: `sha256:${'5'.repeat(64)}`,
    evidenceEnvironment: 'production',
    evidenceClass: 'runtime_unclassified',
    ...overrides,
  });
}

function installFixtureSigningAuthority(runtimeRoot) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const publicKeyFingerprint = `sha256:${crypto.createHash('sha256')
    .update(publicKeyPem).digest('hex')}`;
  const keyRoot = path.join(runtimeRoot, 'release-signing');
  fs.mkdirSync(keyRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(keyRoot, 'release-integrity-ed25519-private.pem'),
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(keyRoot, 'release-integrity-ed25519-public.pem'),
    publicKeyPem,
    { mode: 0o444 },
  );
  return Object.freeze({
    signPayload(payload) {
      const canonical = Buffer.from(JSON.stringify(payload), 'utf8');
      return Object.freeze({
        version: 1,
        kind: 'ReleaseIntegritySignature',
        role: 'local_release_integrity',
        algorithm: 'ed25519',
        publicKeyFingerprint,
        publicKeyPem,
        payloadHash: `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`,
        signature: crypto.sign(null, canonical, privateKey).toString('base64'),
        authorityLimit: RELEASE_INTEGRITY_AUTHORITY_LIMIT,
      });
    },
  });
}

function deletionFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-deletion-drill-selection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const deletionDrillRoot = path.join(runtimeRoot, 'legacy-retirement', 'deletion-drills');
  const archivePath = path.join(root, 'paper-factory-control-plane-reference.tar.gz');
  fs.mkdirSync(deletionDrillRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(archivePath, 'immutable archive bytes\n', { mode: 0o444 });
  const signingAuthority = installFixtureSigningAuthority(runtimeRoot);
  const codeProvenance = exactProvenance();
  return {
    root,
    runtimeRoot,
    deletionDrillRoot,
    archivePath,
    signingAuthority,
    codeProvenance,
    releaseStateSnapshot: releaseStateSnapshot(codeProvenance.commit),
  };
}

function archiveHash(archivePath) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex')}`;
}

function deletionCommandResult(args, hashCharacter) {
  return {
    version: 1,
    kind: 'LegacyDeletionDrillCommandResult',
    executable: process.execPath,
    args,
    exitCode: 0,
    signal: null,
    errorCode: null,
    timedOut: false,
    stdoutHash: `sha256:${hashCharacter.repeat(64)}`,
    stderrHash: `sha256:${'0'.repeat(64)}`,
  };
}

function signedDeletionDocument(fixture, {
  createdAt = NOW.toISOString(),
  codeProvenance = fixture.codeProvenance,
  archivePath = fixture.archivePath,
  selectedArchiveHash = archiveHash(fixture.archivePath),
  version = 2,
  status = 'legacy_reference_restore_drill_passed_deletion_allowed',
  blockers = [],
  physicalDeletionAllowed = true,
  signingAuthority = fixture.signingAuthority,
  payloadOverrides = {},
} = {}) {
  const payload = {
    version,
    kind: 'LegacyPhysicalDeletionAndRestoreDrillReceipt',
    status,
    codeProvenance,
    releaseStateSnapshot: fixture.releaseStateSnapshot,
    releaseStateSnapshotHash:
      fixture.releaseStateSnapshot.workspaceReleaseStateSnapshotHash,
    archivePath,
    archiveHash: selectedArchiveHash,
    checks: [
      deletionCommandResult(['migration/tests/p0-production-core-differential.mjs'], '6'),
      deletionCommandResult(['migration/tests/p1-referee-revision-differential.mjs'], '7'),
    ],
    policyChecks: [
      deletionCommandResult(['migration/tests/matrix-integrity.mjs'], '8'),
    ],
    sqliteQuickCheck: 'ok',
    minimalDifferentialFixture: { status: 'legacy_differential_reference_verified' },
    archiveImmutable: true,
    ownerAccepted: 263,
    ownerAcceptanceRequired: 263,
    operationallyProven: 263,
    operationalProofRequired: 263,
    physicalDeletionAllowed,
    blockers,
    destructiveDeletionPerformed: false,
    liveLegacyRootPresent: true,
    restoredFromReferenceArchive: true,
    createdAt,
    ...payloadOverrides,
  };
  const receipt = {
    ...payload,
    legacyPhysicalDeletionAndRestoreDrillReceiptHash: hashRecord('LegacyPhysicalDeletionAndRestoreDrillReceipt', payload),
  };
  return { ...receipt, signature: signingAuthority.signPayload(receipt) };
}

function deletionDocumentName(document) {
  return `LEGACY_DELETION_DRILL_${Date.parse(document.createdAt)}_${document.legacyPhysicalDeletionAndRestoreDrillReceiptHash.slice('sha256:'.length)}.json`;
}

function writeDeletionDocument(fixture, document, name = deletionDocumentName(document)) {
  fs.writeFileSync(path.join(fixture.deletionDrillRoot, name), `${JSON.stringify(document, null, 2)}\n`, { mode: 0o444 });
  return name;
}

function selectDeletion(fixture, overrides = {}) {
  return selectCurrentLegacyDeletionDrillReceipt({
    deletionDrillRoot: fixture.deletionDrillRoot,
    runtimeRoot: fixture.runtimeRoot,
    expectedCodeProvenance: fixture.codeProvenance,
    expectedReleaseStateSnapshot: fixture.releaseStateSnapshot,
    archivePath: fixture.archivePath,
    now: NOW,
    spawnSyncImpl: () => ({
      status: 0,
      stdout: `----i----------------- ${fixture.archivePath}\n`,
    }),
    ...overrides,
  });
}

function verificationFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-verification-selection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const verificationRoot = path.join(runtimeRoot, 'release-evidence', 'verification-receipts');
  fs.mkdirSync(verificationRoot, { recursive: true, mode: 0o700 });
  const signingAuthority = installFixtureSigningAuthority(runtimeRoot);
  const codeProvenance = exactProvenance();
  return {
    root,
    runtimeRoot,
    verificationRoot,
    signingAuthority,
    codeProvenance,
    releaseStateSnapshot: releaseStateSnapshot(codeProvenance.commit),
  };
}

function signedVerificationDocument(fixture, {
  completedAt = NOW.toISOString(),
  codeProvenance = fixture.codeProvenance,
  releaseSnapshot = fixture.releaseStateSnapshot,
  exitCode = 0,
  signingAuthority = fixture.signingAuthority,
  receiptOverrides = {},
} = {}) {
  const verificationProvenance = {
    ...codeProvenance,
    evidenceEnvironment: 'verification',
    evidenceClass: 'technical_conformance',
  };
  const receipt = {
    ...buildIsolatedVerificationReceipt({
      mode: 'release',
      codeProvenance: verificationProvenance,
      completedCodeProvenance: verificationProvenance,
      releaseStateSnapshot: releaseSnapshot,
      completedReleaseStateSnapshot: releaseSnapshot,
      productionGraphTracking: {
        version: 1,
        kind: 'TrackedProductionGraphReport',
        status: 'tracked_production_graph_ready',
        moduleCount: 20,
        edgeCount: 30,
        trackedModuleCount: 20,
        indexBoundModuleCount: 20,
        allProductionModulesTracked: true,
        productionGraphManifestHash: `sha256:${'6'.repeat(64)}`,
        blockers: [],
      },
      startedAt: new Date(Date.parse(completedAt) - 60_000).toISOString(),
      completedAt,
      exitCode,
      isolatedStoreHash: `sha256:${'7'.repeat(64)}`,
      productionStoreHashBefore: `sha256:${'8'.repeat(64)}`,
      productionStoreHashAfter: `sha256:${'8'.repeat(64)}`,
      productionLogicalHashBefore: `sha256:${'9'.repeat(64)}`,
      productionLogicalHashAfter: `sha256:${'9'.repeat(64)}`,
      productionLogicalIntegrityStatusBefore: 'sqlite_logical_integrity_verified',
      productionLogicalIntegrityStatusAfter: 'sqlite_logical_integrity_verified',
      productionLogicalIntegrityBlockersBefore: [],
      productionLogicalIntegrityBlockersAfter: [],
    }),
    ...receiptOverrides,
  };
  return {
    ...receipt,
    signature: signingAuthority.signPayload(receipt),
  };
}

function capabilityManifestDocument(codeProvenance) {
  const codeProvenanceHash = hashRecord(
    'CapabilityVerificationCodeProvenance',
    codeProvenance,
  );
  const receiptPayload = {
    version: 2,
    kind: 'CapabilityVerificationReceipt',
    status: 'capability_implementation_verified',
    capabilityId: 'fixture-capability',
    codeProvenance,
    codeProvenanceHash,
  };
  const payload = {
    version: 2,
    kind: 'CapabilityVerificationManifest',
    status: 'capability_verification_complete',
    generatedAt: NOW.toISOString(),
    capabilityCount: 1,
    passedCount: 1,
    codeProvenance,
    codeProvenanceHash,
    receipts: [{
      ...receiptPayload,
      capabilityVerificationReceiptHash: hashRecord(
        'CapabilityVerificationReceipt',
        receiptPayload,
      ),
    }],
  };
  return {
    ...payload,
    capabilityVerificationManifestHash: hashRecord('CapabilityVerificationManifest', payload),
  };
}

function verificationDocumentName(document) {
  return `ISOLATED_VERIFICATION_RECEIPT_${Date.parse(document.completedAt)}_${document.isolatedVerificationReceiptHash.slice('sha256:'.length)}.json`;
}

function writeVerificationDocument(fixture, document, name = verificationDocumentName(document)) {
  fs.writeFileSync(
    path.join(fixture.verificationRoot, name),
    `${JSON.stringify(document, null, 2)}\n`,
    { mode: 0o444 },
  );
  return name;
}

function selectVerification(fixture, overrides = {}) {
  return selectCurrentReleaseVerificationReceipt({
    verificationRoot: fixture.verificationRoot,
    runtimeRoot: fixture.runtimeRoot,
    codeProvenance: fixture.codeProvenance,
    expectedReleaseStateSnapshot: fixture.releaseStateSnapshot,
    now: NOW,
    ...overrides,
  });
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return String(result.stdout || '').trim();
}

test('code provenance binds both the commit tree and exact worktree state', (t) => {
  const releaseCommit = process.env.HEPTA_RELEASE_COMMIT;
  process.env.HEPTA_RELEASE_COMMIT = 'f'.repeat(40);
  t.after(() => {
    if (releaseCommit === undefined) delete process.env.HEPTA_RELEASE_COMMIT;
    else process.env.HEPTA_RELEASE_COMMIT = releaseCommit;
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-code-provenance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.2.3"}\n');
  fs.writeFileSync(path.join(root, 'source.mjs'), 'export const value = 1;\n');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'hepta-test@example.invalid');
  git(root, 'config', 'user.name', 'Hepta Test');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  const clean = currentCodeProvenance({ workspaceRoot: root });
  assert.equal(clean.version, 2);
  assert.equal(clean.treeDirty, false);
  assert.equal(clean.commitTree, git(root, 'rev-parse', 'HEAD^{tree}'));
  fs.writeFileSync(path.join(root, 'source.mjs'), 'export const value = 2;\n');
  const dirty = currentCodeProvenance({ workspaceRoot: root });
  assert.equal(dirty.commit, clean.commit);
  assert.equal(dirty.commitTree, clean.commitTree);
  assert.equal(dirty.treeDirty, true);
  assert.notEqual(dirty.worktreeStateHash, clean.worktreeStateHash);
  fs.writeFileSync(path.join(root, 'source.mjs'), 'export const value = 3;\n');
  const dirtyAgain = currentCodeProvenance({ workspaceRoot: root });
  assert.notEqual(dirtyAgain.repositoryContentHash, dirty.repositoryContentHash);
  assert.notEqual(dirtyAgain.worktreeStateHash, dirty.worktreeStateHash);
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'first\n');
  const untracked = currentCodeProvenance({ workspaceRoot: root });
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'second\n');
  const changedUntracked = currentCodeProvenance({ workspaceRoot: root });
  assert.notEqual(changedUntracked.worktreeStateHash, untracked.worktreeStateHash);
});

test('release attestation is administrative evidence rather than production runtime evidence', () => {
  const provenance = releaseAttestationCodeProvenance({
    packageVersion: '0.20.2',
    commit: 'current-commit',
    treeDirty: false,
    evidenceEnvironment: 'production',
    evidenceClass: 'runtime_unclassified',
  });
  assert.equal(provenance.evidenceEnvironment, 'administrative');
  assert.equal(provenance.evidenceClass, 'release_attestation');
  assert.equal(provenance.commit, 'current-commit');
});

test('retirement lifecycle reports observed deletion instead of hard-coded non-deletion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retirement-lifecycle-'));
  fs.rmSync(root, { recursive: true, force: true });
  const immutableReceipt = {
    status: 'legacy_reference_ext4_inode_immutable',
    immutableContentObjectClaimed: true,
  };
  const status = retirementLifecycleStatus({
    legacyRoot: root,
    deletionDrill: { status: 'legacy_reference_restore_drill_passed_deletion_blocked', physicalDeletionAllowed: false },
    immutableReceipt,
    immutableSnapshotEvidence: {
      status: 'legacy_immutable_snapshot_current_evidence_verified',
      releaseEvidenceReady: true,
      receipt: immutableReceipt,
      blockers: [],
    },
  });
  assert.equal(status.liveLegacyRootPresent, false);
  assert.equal(status.physicalDeletionObserved, true);
  assert.equal(status.destructiveDeletionPerformed, true);
  assert.equal(status.deletionLifecycleStatus, 'legacy_root_deleted_under_prior_authorization_current_gate_blocked');
});

test('retirement lifecycle never infers deletion authority from an unverified receipt', () => {
  const status = retirementLifecycleStatus({
    legacyRoot: '/definitely-present-for-policy-only',
    deletionDrill: { status: 'legacy_reference_restore_drill_passed_deletion_allowed', physicalDeletionAllowed: true },
    deletionDrillEvidence: { status: 'legacy_deletion_drill_current_evidence_blocked', blockers: ['signature_invalid'] },
  });
  assert.equal(status.currentPhysicalDeletionAuthorization, false);
  assert.equal(status.physicalDeletionAllowed, false);
  assert.deepEqual(status.restoreDrillEvidenceBlockers, ['signature_invalid']);
});

test('release verification selection accepts only the exact signed v2 receipt and pinned key', (t) => {
  const fixture = verificationFixture(t);
  const document = signedVerificationDocument(fixture);
  const name = writeVerificationDocument(fixture, document);
  const selected = selectVerification(fixture);
  assert.equal(selected.status, 'release_verification_current_evidence_verified');
  assert.equal(selected.releaseEvidenceReady, true);
  assert.equal(selected.receiptHash, document.isolatedVerificationReceiptHash);
  assert.equal(
    selected.candidateRelativePath,
    `release-evidence/verification-receipts/${name}`,
  );
  assert.equal(selected.pinnedPublicKeyFingerprint, document.signature.publicKeyFingerprint);
  assert.deepEqual(selected.blockers, []);
});

test('a malformed or blocked latest verification receipt prevents fallback to an older pass', async (t) => {
  const fixture = verificationFixture(t);
  writeVerificationDocument(fixture, signedVerificationDocument(fixture, {
    completedAt: new Date(NOW.getTime() - 60_000).toISOString(),
  }));
  await t.test('malformed latest', () => {
    const name = `ISOLATED_VERIFICATION_RECEIPT_${NOW.getTime()}_${'f'.repeat(64)}.json`;
    fs.writeFileSync(path.join(fixture.verificationRoot, name), '{', { mode: 0o444 });
    const selected = selectVerification(fixture);
    assert.equal(selected.candidateName, name);
    assert.deepEqual(selected.blockers, ['release_verification_candidate_json_invalid']);
    fs.unlinkSync(path.join(fixture.verificationRoot, name));
  });
  await t.test('authentic blocked latest', () => {
    const blocked = signedVerificationDocument(fixture, { exitCode: 1 });
    writeVerificationDocument(fixture, blocked);
    const selected = selectVerification(fixture);
    assert.equal(selected.status, 'release_verification_current_evidence_blocked');
    assert.ok(selected.blockers.includes('release_verification_receipt_not_passed'));
    assert.equal(selected.releaseEvidenceReady, false);
  });
});

test('verification receipt tampering, key substitution, and release-state drift fail closed', async (t) => {
  const fixture = verificationFixture(t);
  const cases = [
    ['self hash', () => signedVerificationDocument(fixture, {
      receiptOverrides: { isolatedStoreHash: `sha256:${'a'.repeat(64)}` },
    }), 'isolated_verification_receipt_self_hash_mismatch'],
    ['release state', () => signedVerificationDocument(fixture, {
      releaseSnapshot: releaseStateSnapshot('a'.repeat(40)),
    }), 'release_verification_release_state_mismatch'],
  ];
  for (const [label, build, blocker] of cases) await t.test(label, () => {
    for (const name of fs.readdirSync(fixture.verificationRoot)) {
      fs.unlinkSync(path.join(fixture.verificationRoot, name));
    }
    writeVerificationDocument(fixture, build());
    assert.ok(selectVerification(fixture).blockers.includes(blocker));
  });
  await t.test('unpinned key', () => {
    for (const name of fs.readdirSync(fixture.verificationRoot)) {
      fs.unlinkSync(path.join(fixture.verificationRoot, name));
    }
    const alternateRuntimeRoot = path.join(fixture.root, 'alternate-runtime');
    const alternateSigningAuthority = installFixtureSigningAuthority(alternateRuntimeRoot);
    const document = signedVerificationDocument(fixture, {
      signingAuthority: alternateSigningAuthority,
    });
    writeVerificationDocument(fixture, document);
    assert.ok(selectVerification(fixture).blockers.includes('release_verification_signature_invalid'));
  });
});

test('verification selection rejects a symlink candidate without reading its target', (t) => {
  const fixture = verificationFixture(t);
  const document = signedVerificationDocument(fixture);
  const external = path.join(fixture.root, 'external.json');
  fs.writeFileSync(external, `${JSON.stringify(document)}\n`);
  fs.symlinkSync(external, path.join(fixture.verificationRoot, verificationDocumentName(document)));
  const selected = selectVerification(fixture);
  assert.deepEqual(selected.blockers, ['release_verification_candidate_file_unsafe']);
  assert.equal(fs.readFileSync(external, 'utf8'), `${JSON.stringify(document)}\n`);
});

test('release evidence pins the signed current capability pointer and immutable manifest separately', async (t) => {
  const fixture = verificationFixture(t);
  const document = signedVerificationDocument(fixture);
  const sourceManifestPath = path.join(fixture.root, 'source-manifest.json');
  fs.writeFileSync(
    sourceManifestPath,
    `${JSON.stringify(capabilityManifestDocument(document.codeProvenance), null, 2)}\n`,
    { mode: 0o444 },
  );
  const publication = publishIsolatedVerificationReceiptArtifacts({
    runtimeRoot: fixture.runtimeRoot,
    signedDocument: document,
    capabilityManifestPath: sourceManifestPath,
    signCurrentPointer: fixture.signingAuthority.signPayload,
  });
  const selected = selectCurrentCapabilityVerificationManifest({
    runtimeRoot: fixture.runtimeRoot,
    expectedReceipt: (() => {
      const { signature, ...receipt } = document;
      assert.ok(signature);
      return receipt;
    })(),
    expectedReceiptRelativePath: path.relative(
      fixture.runtimeRoot,
      publication.receiptPath,
    ),
    expectedReceiptFileHash: publication.receiptFileHash,
  });
  assert.equal(
    selected.status,
    'current_capability_verification_manifest_evidence_verified',
  );
  assert.equal(selected.pointerFileHash === selected.targetFileHash, false);
  assert.equal(
    selected.pointer.currentCapabilityVerificationManifestPointerHash,
    publication.capabilityManifestPointerHash,
  );
  assert.equal(selected.targetFileHash, publication.capabilityManifestFileHash);
  assert.equal(selected.releaseEvidenceReady, true);
  await t.test('target tamper', () => {
    fs.chmodSync(publication.capabilityManifestPath, 0o644);
    fs.appendFileSync(publication.capabilityManifestPath, ' ');
    fs.chmodSync(publication.capabilityManifestPath, 0o444);
    const blocked = selectCurrentCapabilityVerificationManifest({
      runtimeRoot: fixture.runtimeRoot,
      expectedReceipt: selected.pointer && (() => {
        const { signature, ...receipt } = document;
        assert.ok(signature);
        return receipt;
      })(),
      expectedReceiptRelativePath: selected.receiptRelativePath,
      expectedReceiptFileHash: selected.receiptFileHash,
    });
    assert.ok(blocked.blockers.includes('capability_manifest_pointer_target_file_hash_mismatch'));
    assert.equal(blocked.releaseEvidenceReady, false);
  });
});

test('capability selection hashes and validates one captured manifest byte sequence', (t) => {
  const fixture = verificationFixture(t);
  const document = signedVerificationDocument(fixture);
  const sourceManifestPath = path.join(fixture.root, 'single-read-source-manifest.json');
  fs.writeFileSync(
    sourceManifestPath,
    `${JSON.stringify(capabilityManifestDocument(document.codeProvenance), null, 2)}\n`,
    { mode: 0o444 },
  );
  const publication = publishIsolatedVerificationReceiptArtifacts({
    runtimeRoot: fixture.runtimeRoot,
    signedDocument: document,
    capabilityManifestPath: sourceManifestPath,
    signCurrentPointer: fixture.signingAuthority.signPayload,
  });
  const { signature, ...receipt } = document;
  assert.ok(signature);
  let replaced = false;
  const selected = selectCurrentCapabilityVerificationManifest({
    runtimeRoot: fixture.runtimeRoot,
    expectedReceipt: receipt,
    expectedReceiptRelativePath: path.relative(
      fixture.runtimeRoot,
      publication.receiptPath,
    ),
    expectedReceiptFileHash: publication.receiptFileHash,
    readArtifact(candidate) {
      const bytes = fs.readFileSync(candidate);
      if (!replaced && candidate === publication.capabilityManifestPath) {
        replaced = true;
        fs.chmodSync(candidate, 0o644);
        fs.writeFileSync(candidate, '{"invalid":true}\n');
        fs.chmodSync(candidate, 0o444);
      }
      return bytes;
    },
  });
  assert.equal(replaced, true);
  assert.equal(
    selected.status,
    'current_capability_verification_manifest_evidence_verified',
  );
  assert.equal(selected.targetFileHash, publication.capabilityManifestFileHash);
  const changed = selectCurrentCapabilityVerificationManifest({
    runtimeRoot: fixture.runtimeRoot,
    expectedReceipt: receipt,
    expectedReceiptRelativePath: selected.receiptRelativePath,
    expectedReceiptFileHash: selected.receiptFileHash,
  });
  assert.ok(changed.blockers.includes('capability_manifest_pointer_target_file_hash_mismatch'));
});

test('current deletion drill evidence requires the exact v2 receipt, archive, self-hash, and pinned key', (t) => {
  const fixture = deletionFixture(t);
  const document = signedDeletionDocument(fixture);
  const name = writeDeletionDocument(fixture, document);
  const selected = selectDeletion(fixture);
  assert.equal(selected.status, 'legacy_deletion_drill_current_evidence_verified');
  assert.equal(selected.releaseEvidenceReady, true);
  assert.equal(selected.physicalDeletionAllowed, true);
  assert.equal(selected.receiptHash, document.legacyPhysicalDeletionAndRestoreDrillReceiptHash);
  assert.equal(selected.candidateRelativePath, `legacy-retirement/deletion-drills/${name}`);
  assert.match(selected.candidateFileHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(selected.pinnedPublicKeyFingerprint, document.signature.publicKeyFingerprint);
  assert.deepEqual(selected.blockers, []);
});

test('deletion receipts require exact command results from the fixed verification commands', async (t) => {
  const fixture = deletionFixture(t);
  const baseline = signedDeletionDocument(fixture);
  const cases = [
    ['minimal result', { exitCode: 0 }],
    ['foreign executable', { ...baseline.checks[0], executable: '/usr/bin/foreign-node' }],
    ['unapproved arguments', { ...baseline.checks[0], args: ['migration/tests/unapproved.mjs'] }],
    ['invalid stdout hash', { ...baseline.checks[0], stdoutHash: 'sha256:not-a-hash' }],
    ['inconsistent timeout', { ...baseline.checks[0], timedOut: true }],
  ];
  for (const [label, invalidResult] of cases) await t.test(label, () => {
    for (const name of fs.readdirSync(fixture.deletionDrillRoot)) {
      fs.unlinkSync(path.join(fixture.deletionDrillRoot, name));
    }
    const document = signedDeletionDocument(fixture, {
      payloadOverrides: { checks: [invalidResult, baseline.checks[1]] },
    });
    writeDeletionDocument(fixture, document);
    const selected = selectDeletion(fixture);
    assert.equal(selected.status, 'legacy_deletion_drill_current_evidence_blocked');
    assert.ok(selected.blockers.includes('legacy_deletion_drill_command_results_invalid'));
    assert.equal(selected.releaseEvidenceReady, false);
    assert.equal(selected.physicalDeletionAllowed, false);
  });
});

test('zero required authority counts cannot authorize deletion', (t) => {
  const fixture = deletionFixture(t);
  writeDeletionDocument(fixture, signedDeletionDocument(fixture, {
    status: 'legacy_reference_restore_drill_passed_deletion_blocked',
    blockers: [
      'owner_acceptance_required_count_invalid',
      'operational_proof_required_count_invalid',
    ],
    physicalDeletionAllowed: false,
    payloadOverrides: {
      ownerAccepted: 0,
      ownerAcceptanceRequired: 0,
      operationallyProven: 0,
      operationalProofRequired: 0,
    },
  }));
  const selected = selectDeletion(fixture);
  assert.equal(selected.status, 'legacy_deletion_drill_current_evidence_blocked');
  assert.ok(selected.blockers.includes('legacy_deletion_drill_required_counts_invalid'));
  assert.equal(selected.releaseEvidenceReady, false);
  assert.equal(selected.physicalDeletionAllowed, false);
});

test('deletion selection rechecks the current archive immutable flag', (t) => {
  const fixture = deletionFixture(t);
  writeDeletionDocument(fixture, signedDeletionDocument(fixture));
  const selected = selectDeletion(fixture, {
    spawnSyncImpl: () => ({
      status: 0,
      stdout: `---------------------- ${fixture.archivePath}\n`,
    }),
  });
  assert.equal(selected.status, 'legacy_deletion_drill_current_evidence_blocked');
  assert.ok(selected.blockers.includes('legacy_deletion_drill_current_archive_not_immutable'));
  assert.equal(selected.releaseEvidenceReady, false);
  assert.equal(selected.physicalDeletionAllowed, false);
});

test('newer deletion candidate insertion during selection fails closed', (t) => {
  const fixture = deletionFixture(t);
  writeDeletionDocument(fixture, signedDeletionDocument(fixture));
  const insertedName = `LEGACY_DELETION_DRILL_${NOW.getTime() + 1}_${'f'.repeat(64)}.json`;
  let injected = false;
  const selected = selectDeletion(fixture, {
    spawnSyncImpl: () => {
      if (!injected) {
        injected = true;
        fs.writeFileSync(path.join(fixture.deletionDrillRoot, insertedName), '{}\n', { mode: 0o444 });
      }
      return { status: 0, stdout: `----i----------------- ${fixture.archivePath}\n` };
    },
  });
  assert.equal(injected, true);
  assert.equal(fs.existsSync(path.join(fixture.deletionDrillRoot, insertedName)), true);
  assert.deepEqual(selected.blockers, ['legacy_deletion_drill_root_changed_during_selection']);
  assert.equal(selected.releaseEvidenceReady, false);
});

test('deletion receipt directory replacement during selection fails closed', (t) => {
  const fixture = deletionFixture(t);
  writeDeletionDocument(fixture, signedDeletionDocument(fixture));
  const savedRoot = `${fixture.deletionDrillRoot}-saved`;
  let injected = false;
  const selected = selectDeletion(fixture, {
    spawnSyncImpl: () => {
      if (!injected) {
        injected = true;
        fs.renameSync(fixture.deletionDrillRoot, savedRoot);
        fs.mkdirSync(fixture.deletionDrillRoot, { mode: 0o700 });
        fs.writeFileSync(path.join(fixture.deletionDrillRoot, 'replacement'), 'must survive\n');
      }
      return { status: 0, stdout: `----i----------------- ${fixture.archivePath}\n` };
    },
  });
  assert.equal(injected, true);
  assert.equal(
    fs.readFileSync(path.join(fixture.deletionDrillRoot, 'replacement'), 'utf8'),
    'must survive\n',
  );
  assert.deepEqual(selected.blockers, ['legacy_deletion_drill_root_changed_during_selection']);
  assert.equal(selected.releaseEvidenceReady, false);
});

test('an authentic restore pass may support code evidence without granting physical deletion', (t) => {
  const fixture = deletionFixture(t);
  writeDeletionDocument(fixture, signedDeletionDocument(fixture, {
    status: 'legacy_reference_restore_drill_passed_deletion_blocked',
    blockers: ['operational_proof_incomplete'],
    physicalDeletionAllowed: false,
    payloadOverrides: { operationallyProven: 14 },
  }));
  const selected = selectDeletion(fixture);
  assert.equal(selected.status, 'legacy_deletion_drill_current_evidence_verified');
  assert.equal(selected.releaseEvidenceReady, true);
  assert.equal(selected.physicalDeletionAllowed, false);
  assert.deepEqual(selected.receiptBlockers, ['operational_proof_incomplete']);
});

test('historic v1 deletion receipts are audit-only and a newer bad receipt prevents fallback', (t) => {
  const fixture = deletionFixture(t);
  const older = signedDeletionDocument(fixture, { createdAt: '2026-08-01T03:59:00.000Z' });
  writeDeletionDocument(fixture, older);
  const historic = signedDeletionDocument(fixture, { version: 1 });
  writeDeletionDocument(fixture, historic);
  const selected = selectDeletion(fixture);
  assert.equal(selected.status, 'legacy_deletion_drill_current_evidence_blocked');
  assert.equal(selected.receipt, null);
  assert.equal(selected.releaseEvidenceReady, false);
  assert.equal(selected.physicalDeletionAllowed, false);
  assert.ok(selected.blockers.includes('legacy_deletion_drill_receipt_v2_required'));
});

test('deletion receipt rejects stale or dirty exact code provenance even when locally signed', async (t) => {
  const fixture = deletionFixture(t);
  const cases = [
    ['stale', exactProvenance({ commit: 'a'.repeat(40) }), 'legacy_deletion_drill_code_provenance_mismatch'],
    ['dirty', exactProvenance({ treeDirty: true }), 'legacy_deletion_drill_code_provenance_mismatch'],
  ];
  for (const [label, codeProvenance, blocker] of cases) await t.test(label, () => {
    for (const name of fs.readdirSync(fixture.deletionDrillRoot)) fs.unlinkSync(path.join(fixture.deletionDrillRoot, name));
    writeDeletionDocument(fixture, signedDeletionDocument(fixture, { codeProvenance }));
    const selected = selectDeletion(fixture);
    assert.equal(selected.status, 'legacy_deletion_drill_current_evidence_blocked');
    assert.ok(selected.blockers.includes(blocker));
    assert.equal(selected.physicalDeletionAllowed, false);
  });
});

test('deletion receipt binds the current archive path and bytes independently of signature validity', async (t) => {
  const fixture = deletionFixture(t);
  const cases = [
    [
      'path',
      () => signedDeletionDocument(fixture, { archivePath: path.join(fixture.root, 'other.tar.gz') }),
      'legacy_deletion_drill_archive_path_mismatch',
    ],
    [
      'hash',
      () => signedDeletionDocument(fixture, { selectedArchiveHash: `sha256:${'a'.repeat(64)}` }),
      'legacy_deletion_drill_archive_hash_mismatch',
    ],
  ];
  for (const [label, build, blocker] of cases) await t.test(label, () => {
    for (const name of fs.readdirSync(fixture.deletionDrillRoot)) fs.unlinkSync(path.join(fixture.deletionDrillRoot, name));
    writeDeletionDocument(fixture, build());
    const selected = selectDeletion(fixture);
    assert.ok(selected.blockers.includes(blocker));
  });
  for (const name of fs.readdirSync(fixture.deletionDrillRoot)) fs.unlinkSync(path.join(fixture.deletionDrillRoot, name));
  const beforeMutation = signedDeletionDocument(fixture);
  writeDeletionDocument(fixture, beforeMutation);
  fs.chmodSync(fixture.archivePath, 0o644);
  fs.writeFileSync(fixture.archivePath, 'changed archive bytes\n');
  fs.chmodSync(fixture.archivePath, 0o444);
  assert.ok(selectDeletion(fixture).blockers.includes('legacy_deletion_drill_archive_hash_mismatch'));
});

test('deletion receipt rejects a stale self-hash even when the modified receipt is re-signed', (t) => {
  const fixture = deletionFixture(t);
  const original = signedDeletionDocument(fixture);
  const { signature: ignored, ...receipt } = original;
  assert.ok(ignored);
  const modifiedReceipt = { ...receipt, ownerAccepted: receipt.ownerAccepted - 1 };
  const modified = {
    ...modifiedReceipt,
    signature: fixture.signingAuthority.signPayload(modifiedReceipt),
  };
  writeDeletionDocument(fixture, modified);
  const selected = selectDeletion(fixture);
  assert.ok(selected.blockers.includes('legacy_deletion_drill_self_hash_mismatch'));
  assert.equal(selected.receiptHash, null);
});

test('deletion receipt rejects signature tampering and a valid signature from an unpinned key', async (t) => {
  const fixture = deletionFixture(t);
  await t.test('signature bytes', () => {
    const document = signedDeletionDocument(fixture);
    document.signature = {
      ...document.signature,
      signature: `${document.signature.signature[0] === 'A' ? 'B' : 'A'}${document.signature.signature.slice(1)}`,
    };
    writeDeletionDocument(fixture, document);
    assert.ok(selectDeletion(fixture).blockers.includes('legacy_deletion_drill_signature_invalid'));
  });
  await t.test('key pin', () => {
    for (const name of fs.readdirSync(fixture.deletionDrillRoot)) fs.unlinkSync(path.join(fixture.deletionDrillRoot, name));
    const alternateRuntimeRoot = path.join(fixture.root, 'alternate-runtime');
    const alternateSigningAuthority = installFixtureSigningAuthority(alternateRuntimeRoot);
    const original = signedDeletionDocument(fixture);
    const { signature: ignored, ...receipt } = original;
    assert.ok(ignored);
    const alternateSignature = alternateSigningAuthority.signPayload(receipt);
    writeDeletionDocument(fixture, {
      ...receipt,
      signature: alternateSignature,
    });
    const selected = selectDeletion(fixture);
    assert.ok(selected.blockers.includes('legacy_deletion_drill_signature_invalid'));
    assert.notEqual(selected.pinnedPublicKeyFingerprint, alternateSignature.publicKeyFingerprint);
  });
});

test('deletion receipt signature metadata is exact and cannot widen local integrity authority', async (t) => {
  const fixture = deletionFixture(t);
  const cases = [
    ['payload hash', { payloadHash: `sha256:${'0'.repeat(64)}` }],
    ['algorithm', { algorithm: 'rsa-pss' }],
    ['role', { role: 'submission_operator' }],
    ['authority limit', { authorityLimit: 'unlimited' }],
    ['fingerprint', { publicKeyFingerprint: `sha256:${'9'.repeat(64)}` }],
  ];
  for (const [label, signatureOverride] of cases) await t.test(label, () => {
    for (const name of fs.readdirSync(fixture.deletionDrillRoot)) fs.unlinkSync(path.join(fixture.deletionDrillRoot, name));
    const document = signedDeletionDocument(fixture);
    document.signature = { ...document.signature, ...signatureOverride };
    writeDeletionDocument(fixture, document);
    assert.ok(selectDeletion(fixture).blockers.includes('legacy_deletion_drill_signature_invalid'));
  });
});

test('malformed latest deletion candidate blocks rather than falling back to an older valid receipt', (t) => {
  const fixture = deletionFixture(t);
  writeDeletionDocument(fixture, signedDeletionDocument(fixture, { createdAt: '2026-08-01T03:59:00.000Z' }));
  const latest = `LEGACY_DELETION_DRILL_${NOW.getTime()}_${'f'.repeat(64)}.json`;
  fs.writeFileSync(path.join(fixture.deletionDrillRoot, latest), '{');
  const selected = selectDeletion(fixture);
  assert.equal(selected.candidateName, latest);
  assert.deepEqual(selected.blockers, ['legacy_deletion_drill_candidate_json_invalid']);
  assert.equal(selected.releaseEvidenceReady, false);
});

test('deletion drill freshness is bounded and future-dated evidence fails closed', async (t) => {
  const fixture = deletionFixture(t);
  const cases = [
    ['stale', new Date(NOW.getTime() - (24 * 60 * 60 * 1000) - 1).toISOString(), 'legacy_deletion_drill_receipt_stale'],
    ['future', new Date(NOW.getTime() + (5 * 60 * 1000) + 1).toISOString(), 'legacy_deletion_drill_created_in_future'],
  ];
  for (const [label, createdAt, blocker] of cases) await t.test(label, () => {
    for (const name of fs.readdirSync(fixture.deletionDrillRoot)) fs.unlinkSync(path.join(fixture.deletionDrillRoot, name));
    writeDeletionDocument(fixture, signedDeletionDocument(fixture, { createdAt }));
    assert.ok(selectDeletion(fixture).blockers.includes(blocker));
  });
});

test('deletion verification never creates a missing pinned key', (t) => {
  const fixture = deletionFixture(t);
  writeDeletionDocument(fixture, signedDeletionDocument(fixture));
  const publicPath = path.join(fixture.runtimeRoot, 'release-signing', 'release-integrity-ed25519-public.pem');
  fs.unlinkSync(publicPath);
  const selected = selectDeletion(fixture);
  assert.deepEqual(selected.blockers, ['legacy_deletion_drill_pinned_public_key_unavailable']);
  assert.equal(fs.existsSync(publicPath), false);
});

test('no-clobber release evidence publication preserves an existing file and rejects a symlink', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-no-clobber-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'receipt.json');
  const first = writeNoClobberJsonFile(target, { version: 1 });
  assert.match(first.fileHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(fs.statSync(target).mode & 0o777, 0o444);
  assert.throws(() => writeNoClobberJsonFile(target, { version: 2 }), /EEXIST/);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).version, 1);
  const external = path.join(root, 'external.json');
  const link = path.join(root, 'link.json');
  fs.writeFileSync(external, '{}\n');
  fs.symlinkSync(external, link);
  assert.throws(() => writeNoClobberJsonFile(link, { version: 3 }), /EEXIST/);
  assert.equal(fs.readFileSync(external, 'utf8'), '{}\n');
});

test('artifact-set publication rolls back artifacts and restores the pointer on a post-commit race', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-artifact-set-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundlePath = path.join(root, 'bundle.json');
  const signaturePath = path.join(root, 'signature.json');
  const pointerPath = path.join(root, 'CURRENT.json');
  const previousPointer = '{"version":1,"marker":"previous"}\n';
  fs.writeFileSync(pointerPath, previousPointer, { mode: 0o444 });
  assert.throws(() => publishJsonArtifactSet({
    entries: [
      { path: bundlePath, value: { version: 2, kind: 'Bundle' } },
      { path: signaturePath, value: { version: 1, kind: 'Signature' } },
    ],
    pointerPath,
    pointerValue: { version: 2, marker: 'candidate' },
    afterPointer() { throw new Error('simulated_release_state_toctou'); },
  }), /simulated_release_state_toctou/);
  assert.equal(fs.existsSync(bundlePath), false);
  assert.equal(fs.existsSync(signaturePath), false);
  assert.equal(fs.readFileSync(pointerPath, 'utf8'), previousPointer);
});

test('artifact-set collision and unsafe pointer fail without a half publication', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-artifact-collision-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await t.test('artifact collision', () => {
    const bundlePath = path.join(root, 'bundle.json');
    const signaturePath = path.join(root, 'signature.json');
    fs.writeFileSync(signaturePath, '{"preserve":true}\n');
    assert.throws(() => publishJsonArtifactSet({
      entries: [
        { path: bundlePath, value: { version: 2 } },
        { path: signaturePath, value: { version: 1 } },
      ],
      pointerPath: path.join(root, 'CURRENT.json'),
      pointerValue: { version: 2 },
    }), /release_evidence_artifact_collision/);
    assert.equal(fs.existsSync(bundlePath), false);
    assert.equal(fs.readFileSync(signaturePath, 'utf8'), '{"preserve":true}\n');
  });
  await t.test('symlink pointer', () => {
    const child = path.join(root, 'second');
    fs.mkdirSync(child);
    const external = path.join(root, 'external.json');
    const pointerPath = path.join(child, 'CURRENT.json');
    fs.writeFileSync(external, '{"preserve":true}\n');
    fs.symlinkSync(external, pointerPath);
    const bundlePath = path.join(child, 'bundle.json');
    const signaturePath = path.join(child, 'signature.json');
    assert.throws(() => publishJsonArtifactSet({
      entries: [
        { path: bundlePath, value: { version: 2 } },
        { path: signaturePath, value: { version: 1 } },
      ],
      pointerPath,
      pointerValue: { version: 2 },
    }), /release_evidence_pointer_unsafe/);
    assert.equal(fs.existsSync(bundlePath), false);
    assert.equal(fs.existsSync(signaturePath), false);
    assert.equal(fs.readFileSync(external, 'utf8'), '{"preserve":true}\n');
  });
});

test('artifact-set publication accepts only exact immutable replays and supports pointer-only commit', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-idempotent-set-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactPath = path.join(root, 'artifact.json');
  const pointerPath = path.join(root, 'CURRENT.json');
  const value = { version: 2, kind: 'ImmutableArtifact' };
  const original = writeNoClobberJsonFile(artifactPath, value);
  const replay = publishJsonArtifactSet({
    entries: [{ path: artifactPath, value, allowExistingExact: true }],
    pointerPath,
    pointerValue: { version: 1, artifact: 'artifact.json' },
  });
  assert.equal(replay.artifacts[0].preexisting, true);
  assert.deepEqual(replay.artifacts[0].identity, original.identity);
  const pointerOnly = publishJsonArtifactSet({
    entries: [],
    pointerPath,
    pointerValue: { version: 2, artifact: 'artifact.json' },
  });
  assert.deepEqual(pointerOnly.artifacts, []);
  assert.equal(JSON.parse(fs.readFileSync(pointerPath, 'utf8')).version, 2);
  assert.throws(() => publishJsonArtifactSet({
    entries: [{
      path: artifactPath,
      value: { ...value, kind: 'ConflictingArtifact' },
      allowExistingExact: true,
    }],
    pointerPath,
    pointerValue: { version: 3 },
  }), /release_evidence_existing_artifact_conflict/);
  assert.equal(JSON.parse(fs.readFileSync(pointerPath, 'utf8')).version, 2);
});

test('release signing in attest mode requires an existing key and never creates one', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-existing-key-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  assert.throws(
    () => signReleasePayload({ version: 1 }, runtimeRoot, {
      allowKeyCreation: false,
      environment: NON_ISOLATED_TEST_ENVIRONMENT,
    }),
    /ENOENT/,
  );
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'release-signing')), false);
  installFixtureSigningAuthority(runtimeRoot);
  const signature = signReleasePayload({ version: 1 }, runtimeRoot, {
    allowKeyCreation: false,
    environment: NON_ISOLATED_TEST_ENVIRONMENT,
  });
  assert.equal(signature.kind, 'ReleaseIntegritySignature');
});

test('pure deletion drill passes in a fresh isolated runtime without reading or writing a key', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-pure-deletion-drill-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  const result = spawnSync(process.execPath, ['paper-core/bin/legacy-deletion-drill.mjs'], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'),
    encoding: 'utf8',
    timeout: 240_000,
    env: {
      ...process.env,
      HEPTA_PAPER_RUNTIME_ROOT: runtimeRoot,
      HEPTA_PAPER_RUNTIME_ISOLATED: '1',
      HEPTA_LEGACY_REFERENCE_ARCHIVE: resolveImmutableLegacyMatrixArchive(),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'legacy_reference_restore_drill_verification_passed');
  assert.equal(report.signingKeyRead, false);
  assert.equal(report.runtimeEvidenceWritten, false);
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'release-signing')), false);
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'legacy-retirement', 'deletion-drills')), false);
});

test('release evidence CLI help, invalid arguments, and missing confirmation are zero-write', (t) => {
  assert.deepEqual(parseReleaseEvidenceArguments(['--help']), {
    help: true,
    execute: false,
  });
  assert.match(releaseEvidenceUsage(), /--execute/u);
  assert.throws(
    () => parseReleaseEvidenceArguments([]),
    /release_attestation_execute_required/u,
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-evidence-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [label, args, expectedStatus, expectedOutput] of [
    ['help', ['--help'], 0, /Usage: release-evidence --execute/u],
    ['unknown', ['--unknown'], 1, /unknown_cli_option/u],
    ['unconfirmed', [], 1, /release_attestation_execute_required/u],
  ]) {
    const runtimeRoot = path.join(root, label);
    const result = spawnSync(
      process.execPath,
      ['paper-core/bin/release-evidence.mjs', ...args],
      {
        cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'),
        encoding: 'utf8',
        env: {
          ...process.env,
          HEPTA_PAPER_RUNTIME_ROOT: runtimeRoot,
        },
      },
    );
    assert.equal(result.status, expectedStatus, result.stderr);
    assert.match(`${result.stdout}\n${result.stderr}`, expectedOutput);
    assert.equal(fs.existsSync(runtimeRoot), false);
  }
});

test('isolated attest commands reject before creating runtime evidence', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-isolated-attest-reject-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [label, argv, blocker] of [
    [
      'deletion drill',
      ['paper-core/bin/legacy-deletion-drill.mjs', '--attest'],
      'legacy_deletion_drill_attestation_forbidden_in_isolated_runtime',
    ],
    [
      'release attest',
      ['paper-core/bin/release-evidence.mjs', '--execute'],
      'release_attestation_forbidden_in_isolated_runtime',
    ],
  ]) await t.test(label, () => {
    const runtimeRoot = path.join(root, label.replace(' ', '-'));
    const result = spawnSync(process.execPath, argv, {
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        HEPTA_PAPER_RUNTIME_ROOT: runtimeRoot,
        HEPTA_PAPER_RUNTIME_ISOLATED: '1',
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(blocker));
    assert.equal(fs.existsSync(runtimeRoot), false);
  });
});

test('release commit environment is only an assertion over exact repository provenance', () => {
  const provenance = exactProvenance();
  assert.equal(assertExactCleanCodeProvenance(provenance, { releaseCommitAssertion: provenance.commit }), provenance);
  assert.throws(
    () => assertExactCleanCodeProvenance(provenance, { releaseCommitAssertion: 'f'.repeat(40) }),
    /release_commit_environment_mismatch/,
  );
});
