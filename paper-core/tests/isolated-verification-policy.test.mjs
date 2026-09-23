import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  inspectIsolatedVerificationPreflight,
  isolatedVerificationCodeProvenanceMatches,
} from '../src/isolated-verification-policy.mjs';
import {
  buildIsolatedVerificationReceipt,
  verifyIsolatedVerificationReceipt,
} from '../src/isolated-verification-receipt-contract.mjs';
import { publishIsolatedVerificationReceiptArtifacts } from '../bin/isolated-verification-receipt-publication.mjs';
import { verifyCurrentCapabilityVerificationManifestPointer } from '../src/current-capability-verification-manifest-pointer.mjs';

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

function sha(character) {
  return `sha256:${character.repeat(64)}`;
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function provenance(overrides = {}) {
  return {
    version: 2,
    kind: 'CodeProvenance',
    packageVersion: '0.21.0',
    commit: 'a'.repeat(40),
    commitTree: 'b'.repeat(40),
    treeDirty: false,
    indexStateHash: `sha256:${'1'.repeat(64)}`,
    repositoryEntryCount: 2_000,
    repositoryContentHash: `sha256:${'2'.repeat(64)}`,
    worktreeStateHash: `sha256:${'3'.repeat(64)}`,
    tags: [],
    evidenceEnvironment: 'verification',
    evidenceClass: 'technical_conformance',
    ...overrides,
  };
}

function releaseStateSnapshot(overrides = {}) {
  const payload = {
    version: 2,
    kind: 'WorkspaceReleaseStateSnapshot',
    status: 'workspace_release_state_release_ready',
    headCommit: 'a'.repeat(40),
    headTags: [],
    allTags: [],
    documentHashes: {
      packageJson: { path: 'package.json', sha256: sha('a') },
      packageLock: { path: 'package-lock.json', sha256: sha('b') },
      currentStatus: { path: 'paper-core/docs/CURRENT_STATUS.md', sha256: sha('c') },
      releaseDocument: { path: 'RELEASE.md', sha256: sha('d') },
      changelog: { path: 'CHANGELOG.md', sha256: sha('e') },
    },
    releaseState: {
      ok: true,
      kind: 'ReleaseStateConsistency',
      contractVersion: 2,
      version: '0.21.0',
      state: 'release_ready',
      documentationProfile: 'finalized',
      errors: [],
    },
    ...overrides,
  };
  return {
    ...payload,
    workspaceReleaseStateSnapshotHash: sha256(JSON.stringify(payload)),
  };
}

function productionGraph(overrides = {}) {
  return {
    version: 1,
    kind: 'TrackedProductionGraphReport',
    status: 'tracked_production_graph_ready',
    moduleCount: 250,
    edgeCount: 480,
    trackedModuleCount: 250,
    indexBoundModuleCount: 250,
    allProductionModulesTracked: true,
    productionGraphManifestHash: sha('f'),
    blockers: [],
    ...overrides,
  };
}

function validReleaseReceipt(overrides = {}) {
  const state = releaseStateSnapshot();
  return buildIsolatedVerificationReceipt({
    mode: 'release',
    codeProvenance: provenance(),
    completedCodeProvenance: provenance(),
    releaseStateSnapshot: state,
    completedReleaseStateSnapshot: structuredClone(state),
    productionGraphTracking: productionGraph(),
    startedAt: '2030-01-01T00:00:00.000Z',
    completedAt: '2030-01-01T00:00:01.000Z',
    exitCode: 0,
    isolatedStoreHash: sha('4'),
    productionStoreHashBefore: sha('5'),
    productionStoreHashAfter: sha('5'),
    productionLogicalHashBefore: sha('6'),
    productionLogicalHashAfter: sha('6'),
    productionLogicalIntegrityStatusBefore: 'sqlite_logical_integrity_verified',
    productionLogicalIntegrityStatusAfter: 'sqlite_logical_integrity_verified',
    productionLogicalIntegrityBlockersBefore: [],
    productionLogicalIntegrityBlockersAfter: [],
    ...overrides,
  });
}

function releaseSignature(payload, { privateKey, publicKey }) {
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const canonical = Buffer.from(JSON.stringify(payload), 'utf8');
  return {
    version: 1,
    kind: 'ReleaseIntegritySignature',
    role: 'local_release_integrity',
    algorithm: 'ed25519',
    publicKeyFingerprint: sha256(publicKeyPem),
    publicKeyPem,
    payloadHash: sha256(canonical),
    signature: crypto.sign(null, canonical, privateKey).toString('base64'),
    authorityLimit: 'build_and_archive_integrity_only_not_owner_academic_referee_or_submission_authority',
  };
}

function signedDocument(receipt, signing) {
  return { ...receipt, signature: releaseSignature(receipt, signing) };
}

function currentPointerSigner(signing) {
  return (pointer) => releaseSignature(pointer, signing);
}

function capabilityManifest(codeProvenance = provenance(), overrides = {}) {
  const codeProvenanceHash = hashRecord('CapabilityVerificationCodeProvenance', codeProvenance);
  const receiptPayload = {
    status: 'capability_implementation_verified',
    codeProvenance,
    codeProvenanceHash,
  };
  const payload = {
    version: 2,
    kind: 'CapabilityVerificationManifest',
    status: 'capability_verification_complete',
    generatedAt: '2030-01-01T00:00:00.000Z',
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
      ledgerReceiptId: 'fixture-ledger-receipt',
    }],
    ...overrides,
  };
  return {
    ...payload,
    capabilityVerificationManifestHash: hashRecord('CapabilityVerificationManifest', payload),
  };
}

function createPublicationFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isolated-verification-publication-'));
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isolated-verification-source-'));
  const capabilityManifestPath = path.join(sourceRoot, 'CAPABILITY_VERIFICATION_MANIFEST.json');
  fs.writeFileSync(
    capabilityManifestPath,
    `${JSON.stringify(capabilityManifest(), null, 2)}\n`,
    { mode: 0o444 },
  );
  const signing = crypto.generateKeyPairSync('ed25519');
  const signingRoot = path.join(root, 'release-signing');
  fs.mkdirSync(signingRoot, { mode: 0o700 });
  const privatePath = path.join(signingRoot, 'release-integrity-ed25519-private.pem');
  const publicPath = path.join(signingRoot, 'release-integrity-ed25519-public.pem');
  fs.writeFileSync(
    privatePath,
    signing.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    publicPath,
    signing.publicKey.export({ type: 'spki', format: 'pem' }),
    { mode: 0o444 },
  );
  fs.chmodSync(privatePath, 0o600);
  fs.chmodSync(publicPath, 0o444);
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  });
  return { root, sourceRoot, capabilityManifestPath, signing };
}

function rehashReceipt(receipt) {
  const payload = { ...receipt };
  delete payload.isolatedVerificationReceiptHash;
  return {
    ...payload,
    isolatedVerificationReceiptHash: hashRecord('IsolatedVerificationReceipt', payload),
  };
}

test('release verification requires an explicitly clean worktree', () => {
  const dirty = inspectIsolatedVerificationPreflight({
    mode: 'release',
    codeProvenance: provenance({ treeDirty: true }),
  });
  assert.equal(dirty.status, 'isolated_verification_preflight_blocked');
  assert.deepEqual(dirty.blockers, ['release_verification_clean_worktree_required']);

  const missing = inspectIsolatedVerificationPreflight({
    mode: 'release',
    codeProvenance: {},
  });
  assert.deepEqual(missing.blockers, [
    'release_verification_clean_worktree_required',
    'release_verification_exact_code_provenance_required',
  ]);

  const clean = inspectIsolatedVerificationPreflight({
    mode: 'release',
    codeProvenance: provenance(),
  });
  assert.equal(clean.status, 'isolated_verification_preflight_ready');
  assert.deepEqual(clean.blockers, []);
});

test('release verification treats HEPTA_RELEASE_COMMIT only as an equality assertion', () => {
  const exact = provenance();
  const matching = inspectIsolatedVerificationPreflight({
    mode: 'release',
    codeProvenance: exact,
    declaredReleaseCommit: exact.commit,
  });
  assert.equal(matching.status, 'isolated_verification_preflight_ready');

  const mismatching = inspectIsolatedVerificationPreflight({
    mode: 'release',
    codeProvenance: exact,
    declaredReleaseCommit: 'f'.repeat(40),
  });
  assert.equal(mismatching.status, 'isolated_verification_preflight_blocked');
  assert.ok(mismatching.blockers.includes('release_verification_declared_commit_mismatch'));
});

test('release postflight compares the complete exact repository identity', () => {
  const before = provenance();
  assert.equal(isolatedVerificationCodeProvenanceMatches(before, { ...before }), true);
  for (const changed of [
    { indexStateHash: `sha256:${'4'.repeat(64)}` },
    { repositoryEntryCount: 2_001 },
    { repositoryContentHash: `sha256:${'5'.repeat(64)}` },
    { worktreeStateHash: `sha256:${'6'.repeat(64)}` },
    { treeDirty: true },
    { tags: ['v0.21.0'] },
    { evidenceEnvironment: 'production' },
    { evidenceClass: 'runtime_unclassified' },
  ]) {
    assert.equal(isolatedVerificationCodeProvenanceMatches(before, provenance(changed)), false);
  }
});

test('development test and CI verification may diagnose a dirty worktree', () => {
  for (const mode of ['test', 'ci']) {
    const report = inspectIsolatedVerificationPreflight({
      mode,
      codeProvenance: { treeDirty: true },
    });
    assert.equal(report.status, 'isolated_verification_preflight_ready');
    assert.deepEqual(report.blockers, []);
  }
});

test('isolated verification rejects unsupported modes before execution', () => {
  const report = inspectIsolatedVerificationPreflight({
    mode: 'unknown',
    codeProvenance: { treeDirty: false },
  });
  assert.equal(report.status, 'isolated_verification_preflight_blocked');
  assert.deepEqual(report.blockers, ['isolated_verification_mode_unsupported:unknown']);
});

test('v2 release receipt binds complete provenance, release state, graph, bytes, and logical integrity', () => {
  const receipt = validReleaseReceipt();
  assert.equal(receipt.version, 2);
  assert.equal(receipt.kind, 'IsolatedVerificationReceipt');
  assert.equal(receipt.status, 'isolated_verification_passed');
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.sourceMutatedDuringVerification, false);
  assert.equal(receipt.productionStoreMutated, false);
  assert.equal(receipt.productionLogicalStoreMutated, false);
  assert.deepEqual(receipt.blockers, []);
  assert.equal(receipt.codeProvenance.tags.length, 0);
  assert.equal(receipt.codeProvenance.evidenceEnvironment, 'verification');
  assert.equal(receipt.codeProvenance.evidenceClass, 'technical_conformance');
  assert.equal(
    receipt.releaseStateSnapshot.workspaceReleaseStateSnapshotHash,
    receipt.completedReleaseStateSnapshot.workspaceReleaseStateSnapshotHash,
  );
  assert.equal(receipt.productionGraphTracking.allProductionModulesTracked, true);
  assert.equal(
    verifyIsolatedVerificationReceipt({ receipt, expectedMode: 'release' }).status,
    'isolated_verification_receipt_verified',
  );
});

test('v2 release receipt rejects every critical-field or exact-shape tamper', () => {
  const receipt = validReleaseReceipt();
  const mutations = [
    (candidate) => { candidate.status = 'isolated_verification_blocked'; },
    (candidate) => { candidate.exitCode = 9; },
    (candidate) => { candidate.isolatedStoreHash = sha('7'); },
    (candidate) => { candidate.productionStoreHashAfter = sha('8'); },
    (candidate) => { candidate.productionStoreMutated = true; },
    (candidate) => { candidate.productionLogicalHashAfter = sha('9'); },
    (candidate) => { candidate.productionLogicalIntegrityStatusAfter = 'sqlite_logical_integrity_blocked'; },
    (candidate) => { candidate.productionLogicalIntegrityBlockersAfter = ['foreign_key_failure']; },
    (candidate) => { candidate.productionLogicalStoreMutated = true; },
    (candidate) => { candidate.sourceMutatedDuringVerification = true; },
    (candidate) => { candidate.codeProvenance.tags = ['v0.21.0']; },
    (candidate) => { candidate.completedCodeProvenance.evidenceClass = 'changed'; },
    (candidate) => { candidate.releaseStateSnapshot.status = 'workspace_release_state_development'; },
    (candidate) => { candidate.completedReleaseStateSnapshot.workspaceReleaseStateSnapshotHash = sha('0'); },
    (candidate) => { candidate.productionGraphTracking.trackedModuleCount -= 1; },
    (candidate) => { candidate.blockers = ['forged_blocker']; },
    (candidate) => { candidate.unexpected = true; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(receipt);
    mutate(candidate);
    assert.equal(
      verifyIsolatedVerificationReceipt({ receipt: candidate }).status,
      'isolated_verification_receipt_invalid',
    );
  }
});

test('a recomputed self-hash cannot make semantically inconsistent release evidence valid', () => {
  const receipt = validReleaseReceipt();
  const mutations = [
    (candidate) => { candidate.status = 'isolated_verification_blocked'; },
    (candidate) => { candidate.exitCode = 3; },
    (candidate) => { candidate.productionStoreMutated = true; },
    (candidate) => { candidate.sourceMutatedDuringVerification = true; },
    (candidate) => { candidate.blockers = ['isolated_verification_process_failed']; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(receipt);
    mutate(candidate);
    const rehashed = rehashReceipt(candidate);
    const verification = verifyIsolatedVerificationReceipt({ receipt: rehashed });
    assert.equal(verification.status, 'isolated_verification_receipt_invalid');
    assert.ok(verification.blockers.includes('isolated_verification_receipt_status_inconsistent'));
  }
});

test('failed execution creates a coherent verifiable blocked receipt with its real exit code', () => {
  const receipt = validReleaseReceipt({ exitCode: 7 });
  assert.equal(receipt.status, 'isolated_verification_blocked');
  assert.equal(receipt.exitCode, 7);
  assert.ok(receipt.blockers.includes('isolated_verification_process_failed'));
  assert.equal(
    verifyIsolatedVerificationReceipt({ receipt }).status,
    'isolated_verification_receipt_verified',
  );
});

test('a release artifact blocker remains coherent without falsifying a zero process exit code', () => {
  const receipt = validReleaseReceipt({
    blockers: ['isolated_verification_capability_manifest_file_unsafe_or_missing'],
  });
  assert.equal(receipt.status, 'isolated_verification_blocked');
  assert.equal(receipt.exitCode, 0);
  assert.deepEqual(receipt.blockers, [
    'isolated_verification_capability_manifest_file_unsafe_or_missing',
  ]);
  assert.equal(
    verifyIsolatedVerificationReceipt({ receipt }).status,
    'isolated_verification_receipt_verified',
  );
});

test('publisher commits signed receipt and capability manifest as immutable no-clobber files', (t) => {
  const fixture = createPublicationFixture(t);
  const receipt = validReleaseReceipt();
  const document = signedDocument(receipt, fixture.signing);
  const boundaries = [];
  const publication = publishIsolatedVerificationReceiptArtifacts({
    runtimeRoot: fixture.root,
    signedDocument: document,
    capabilityManifestPath: fixture.capabilityManifestPath,
    signCurrentPointer: currentPointerSigner(fixture.signing),
    beforePublish() { boundaries.push('before'); },
    afterPublish() { boundaries.push('after'); },
  });
  assert.deepEqual(boundaries, ['before', 'after']);
  assert.equal(publication.status, 'isolated_verification_artifacts_published');
  assert.match(
    path.basename(publication.receiptPath),
    /^ISOLATED_VERIFICATION_RECEIPT_\d{13}_[a-f0-9]{64}\.json$/u,
  );
  assert.equal(fs.lstatSync(publication.receiptPath).mode & 0o777, 0o444);
  assert.equal(fs.lstatSync(publication.receiptPath).nlink, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(publication.receiptPath, 'utf8')), document);
  assert.equal(fs.lstatSync(publication.capabilityManifestPath).mode & 0o777, 0o444);
  assert.equal(fs.lstatSync(publication.capabilityManifestPath).nlink, 1);
  assert.equal(
    fs.readFileSync(publication.capabilityManifestPath, 'utf8'),
    fs.readFileSync(fixture.capabilityManifestPath, 'utf8'),
  );
  const pointerDocument = JSON.parse(fs.readFileSync(
    publication.capabilityManifestPointerPath,
    'utf8',
  ));
  const { signature: pointerSignature, ...pointer } = pointerDocument;
  assert.equal(typeof pointerSignature.signature, 'string');
  assert.equal(
    verifyCurrentCapabilityVerificationManifestPointer({
      pointer,
      expectedReceipt: receipt,
    }).status,
    'current_capability_verification_manifest_pointer_verified',
  );
  assert.equal(
    pointer.targetRelativePath,
    path.relative(fixture.root, publication.capabilityManifestPath),
  );

  const persisted = fs.readFileSync(publication.receiptPath);
  const repeated = publishIsolatedVerificationReceiptArtifacts({
    runtimeRoot: fixture.root,
    signedDocument: document,
    capabilityManifestPath: fixture.capabilityManifestPath,
    signCurrentPointer: currentPointerSigner(fixture.signing),
  });
  assert.equal(repeated.receiptPreexisting, true);
  assert.equal(repeated.capabilityManifestPreexisting, true);
  assert.deepEqual(fs.readFileSync(publication.receiptPath), persisted);
});

test('publisher rolls back both new artifacts when post-publication identity validation fails', (t) => {
  const fixture = createPublicationFixture(t);
  const receipt = validReleaseReceipt();
  assert.throws(() => publishIsolatedVerificationReceiptArtifacts({
    runtimeRoot: fixture.root,
    signedDocument: signedDocument(receipt, fixture.signing),
    capabilityManifestPath: fixture.capabilityManifestPath,
    signCurrentPointer: currentPointerSigner(fixture.signing),
    afterPublish() { throw new Error('simulated_provenance_change'); },
  }), /simulated_provenance_change/u);
  const evidenceRoot = path.join(fixture.root, 'release-evidence');
  assert.deepEqual(fs.readdirSync(path.join(evidenceRoot, 'verification-receipts')), []);
  assert.equal(
    fs.existsSync(path.join(evidenceRoot, 'current', 'CAPABILITY_VERIFICATION_MANIFEST.json')),
    false,
  );
  assert.deepEqual(fs.readdirSync(path.join(evidenceRoot, 'capability-verification-manifests')), []);
});

test('passed publication requires a synchronous pointer signer bound to the pinned receipt key', (t) => {
  const fixture = createPublicationFixture(t);
  const receipt = validReleaseReceipt();
  const document = signedDocument(receipt, fixture.signing);
  assert.throws(() => publishIsolatedVerificationReceiptArtifacts({
    runtimeRoot: fixture.root,
    signedDocument: document,
    capabilityManifestPath: fixture.capabilityManifestPath,
  }), /isolated_verification_current_pointer_signer_required/u);
  assert.equal(fs.existsSync(path.join(fixture.root, 'release-evidence')), false);

  assert.throws(() => publishIsolatedVerificationReceiptArtifacts({
    runtimeRoot: fixture.root,
    signedDocument: document,
    capabilityManifestPath: fixture.capabilityManifestPath,
    signCurrentPointer: async (pointer) => releaseSignature(pointer, fixture.signing),
  }), /isolated_verification_current_pointer_signer_must_be_synchronous/u);

  const foreignSigning = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => publishIsolatedVerificationReceiptArtifacts({
    runtimeRoot: fixture.root,
    signedDocument: document,
    capabilityManifestPath: fixture.capabilityManifestPath,
    signCurrentPointer: currentPointerSigner(foreignSigning),
  }), /isolated_verification_current_pointer_signing_key_mismatch/u);
  const evidenceRoot = path.join(fixture.root, 'release-evidence');
  assert.deepEqual(fs.readdirSync(path.join(evidenceRoot, 'verification-receipts')), []);
  assert.deepEqual(fs.readdirSync(path.join(evidenceRoot, 'capability-verification-manifests')), []);
  assert.deepEqual(fs.readdirSync(path.join(evidenceRoot, 'current')), []);
});

test('publisher rejects symlink collisions without overwrite or half publication', (t) => {
  const receiptCollision = createPublicationFixture(t);
  const receipt = validReleaseReceipt();
  const receiptRoot = path.join(
    receiptCollision.root,
    'release-evidence',
    'verification-receipts',
  );
  fs.mkdirSync(receiptRoot, { recursive: true, mode: 0o700 });
  const receiptName = `ISOLATED_VERIFICATION_RECEIPT_${Date.parse(receipt.completedAt)}_${receipt.isolatedVerificationReceiptHash.slice(7)}.json`;
  const collisionTarget = path.join(receiptCollision.sourceRoot, 'collision-target.json');
  fs.writeFileSync(collisionTarget, '{}\n');
  const collisionPath = path.join(receiptRoot, receiptName);
  fs.symlinkSync(collisionTarget, collisionPath);
  assert.throws(() => publishIsolatedVerificationReceiptArtifacts({
    runtimeRoot: receiptCollision.root,
    signedDocument: signedDocument(receipt, receiptCollision.signing),
    capabilityManifestPath: receiptCollision.capabilityManifestPath,
    signCurrentPointer: currentPointerSigner(receiptCollision.signing),
  }));
  assert.equal(fs.lstatSync(collisionPath).isSymbolicLink(), true);
  assert.equal(
    fs.existsSync(path.join(receiptCollision.root, 'release-evidence', 'current', 'CAPABILITY_VERIFICATION_MANIFEST.json')),
    false,
  );
  assert.deepEqual(
    fs.readdirSync(path.join(receiptCollision.root, 'release-evidence', 'capability-verification-manifests')),
    [],
  );

  const manifestCollision = createPublicationFixture(t);
  const currentRoot = path.join(manifestCollision.root, 'release-evidence', 'current');
  fs.mkdirSync(currentRoot, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(currentRoot, 'CAPABILITY_VERIFICATION_MANIFEST.json');
  fs.symlinkSync(manifestCollision.capabilityManifestPath, manifestPath);
  assert.throws(() => publishIsolatedVerificationReceiptArtifacts({
    runtimeRoot: manifestCollision.root,
    signedDocument: signedDocument(receipt, manifestCollision.signing),
    capabilityManifestPath: manifestCollision.capabilityManifestPath,
    signCurrentPointer: currentPointerSigner(manifestCollision.signing),
  }));
  assert.equal(fs.lstatSync(manifestPath).isSymbolicLink(), true);
  assert.deepEqual(
    fs.readdirSync(path.join(manifestCollision.root, 'release-evidence', 'verification-receipts')),
    [],
  );
  assert.deepEqual(
    fs.readdirSync(path.join(manifestCollision.root, 'release-evidence', 'capability-verification-manifests')),
    [],
  );
});

test('a newer signed blocked receipt is durably published without replacing capability evidence', (t) => {
  const fixture = createPublicationFixture(t);
  const passed = validReleaseReceipt();
  const first = publishIsolatedVerificationReceiptArtifacts({
    runtimeRoot: fixture.root,
    signedDocument: signedDocument(passed, fixture.signing),
    capabilityManifestPath: fixture.capabilityManifestPath,
    signCurrentPointer: currentPointerSigner(fixture.signing),
  });
  const manifestBefore = fs.readFileSync(first.capabilityManifestPath);
  const pointerBefore = fs.readFileSync(first.capabilityManifestPointerPath);
  const blocked = validReleaseReceipt({
    completedAt: '2030-01-01T00:00:02.000Z',
    exitCode: 11,
  });
  const second = publishIsolatedVerificationReceiptArtifacts({
    runtimeRoot: fixture.root,
    signedDocument: signedDocument(blocked, fixture.signing),
  });
  assert.equal(blocked.status, 'isolated_verification_blocked');
  assert.equal(second.capabilityManifestPath, null);
  assert.deepEqual(fs.readFileSync(first.capabilityManifestPath), manifestBefore);
  assert.deepEqual(fs.readFileSync(first.capabilityManifestPointerPath), pointerBefore);
  const receipts = fs.readdirSync(path.dirname(second.receiptPath)).map((name) => (
    JSON.parse(fs.readFileSync(path.join(path.dirname(second.receiptPath), name), 'utf8'))
  )).sort((left, right) => left.completedAt.localeCompare(right.completedAt));
  assert.equal(receipts.length, 2);
  assert.equal(receipts.at(-1).status, 'isolated_verification_blocked');
  assert.equal(receipts.at(-1).exitCode, 11);
});

test('a blocked receipt signed by a foreign key is rejected before publication', (t) => {
  const fixture = createPublicationFixture(t);
  const foreignSigning = crypto.generateKeyPairSync('ed25519');
  const blocked = validReleaseReceipt({
    completedAt: '2030-01-01T00:00:02.000Z',
    exitCode: 11,
  });
  assert.equal(blocked.status, 'isolated_verification_blocked');
  assert.throws(() => publishIsolatedVerificationReceiptArtifacts({
    runtimeRoot: fixture.root,
    signedDocument: signedDocument(blocked, foreignSigning),
  }), /isolated_verification_receipt_signature_invalid/u);
  assert.equal(fs.existsSync(path.join(fixture.root, 'release-evidence')), false);
});

test('a later passed receipt rotates only the signed current pointer and preserves immutable history', (t) => {
  const fixture = createPublicationFixture(t);
  const firstReceipt = validReleaseReceipt();
  const first = publishIsolatedVerificationReceiptArtifacts({
    runtimeRoot: fixture.root,
    signedDocument: signedDocument(firstReceipt, fixture.signing),
    capabilityManifestPath: fixture.capabilityManifestPath,
    signCurrentPointer: currentPointerSigner(fixture.signing),
  });
  const secondManifestPath = path.join(fixture.sourceRoot, 'CAPABILITY_VERIFICATION_MANIFEST_2.json');
  fs.writeFileSync(
    secondManifestPath,
    `${JSON.stringify(capabilityManifest(provenance(), {
      generatedAt: '2030-01-01T00:00:01.000Z',
    }), null, 2)}\n`,
    { mode: 0o444 },
  );
  const secondReceipt = validReleaseReceipt({
    completedAt: '2030-01-01T00:00:02.000Z',
  });
  const second = publishIsolatedVerificationReceiptArtifacts({
    runtimeRoot: fixture.root,
    signedDocument: signedDocument(secondReceipt, fixture.signing),
    capabilityManifestPath: secondManifestPath,
    signCurrentPointer: currentPointerSigner(fixture.signing),
  });
  assert.notEqual(second.receiptPath, first.receiptPath);
  assert.notEqual(second.capabilityManifestPath, first.capabilityManifestPath);
  assert.equal(fs.existsSync(first.receiptPath), true);
  assert.equal(fs.existsSync(first.capabilityManifestPath), true);
  const { signature, ...pointer } = JSON.parse(fs.readFileSync(
    second.capabilityManifestPointerPath,
    'utf8',
  ));
  assert.equal(typeof signature.signature, 'string');
  assert.equal(
    pointer.targetRelativePath,
    path.relative(fixture.root, second.capabilityManifestPath),
  );
  assert.equal(pointer.isolatedVerificationReceiptHash, secondReceipt.isolatedVerificationReceiptHash);
});

test('release runner uses existing-key-only signing and four release-state/provenance boundaries', () => {
  const source = fs.readFileSync(
    path.join(workspaceRoot, 'paper-core', 'bin', 'run-isolated-verification.mjs'),
    'utf8',
  );
  assert.match(source, /loadExistingReleaseSigningKey\([\s\S]*?includePrivate:\s*true/u);
  assert.match(source, /signReleasePayload\([\s\S]*?allowKeyCreation:\s*false/u);
  assert.doesNotMatch(source, /ensureReleaseSigningKey\s*\(/u);
  assert.match(source, /currentVerificationCodeProvenance\(\{\s*allowReleaseCommitEnvironment:\s*false\s*\}\)/u);
  assert.ok((source.match(/assertWorkspaceReleaseReady\s*\(/gu) || []).length >= 3);
  assert.match(source, /beforePublish:\s*assertPublicationBoundary/u);
  assert.match(source, /afterPublish:\s*assertPublicationBoundary/u);
  assert.match(source, /if \(mode === 'release'\) \{[\s\S]*?signReleasePayload/u);
  assert.match(source, /process\.once\('exit', cleanupLegacyReference\)/u);
  assert.match(source, /process\.removeListener\('exit', cleanupLegacyReference\)/u);
  assert.match(source, /prepareImmutableReleaseWorkspace\(\{[\s\S]*?candidateWorkspaceRoot:\s*workspaceRoot/u);
  assert.match(source, /const executionWorkspaceRoot = immutableReleaseWorkspace\?\.workspaceRoot \|\| workspaceRoot/u);
  assert.match(source, /spawnSync\('npm',[\s\S]*?cwd:\s*executionWorkspaceRoot/u);
  assert.match(source, /bindIdentityBoundTemporaryDirectory\(isolatedRuntimeRoot\)/u);
  assert.match(source, /ownedIsolatedRuntimeRoot\.cleanup\(\)/u);
  assert.doesNotMatch(source, /rmSync\(isolatedRuntimeRoot/u);
});
