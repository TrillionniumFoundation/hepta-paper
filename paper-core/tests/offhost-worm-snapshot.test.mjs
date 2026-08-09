import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createOffhostWormSnapshot,
  drillOffhostWormRestore,
  resolveLatestReleaseEvidencePointer,
  selectLatestVerifiedReleaseEvidence,
  verifyOffhostWormTarget,
} from '../../paper-adapters/archives/offhost-worm-repository.mjs';
import {
  buildPinnedExternalEvidenceEnvelope,
  inspectPinnedExternalEvidenceTrustStore,
  pinnedExternalEvidenceSigningPayload,
} from '../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const AUTHORITY_LIMIT =
  'build_and_archive_integrity_only_not_owner_academic_referee_or_submission_authority';
const CUSTODY_NOW = new Date('2026-08-09T00:10:00.000Z');

function custodyEvidenceFixture({ contract, targetMountRoot, receiptType = 'object_lock' }) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const keyId = 'custody-key-1';
  const custodianId = 'independent-custodian-1';
  const role = 'offhost_worm_independent_custodian';
  const trustStore = {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [{
      keyId,
      subjectId: custodianId,
      organization: 'Independent Custody Fixture',
      algorithm: 'ed25519',
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
      roles: [role],
      status: 'active',
      effectiveFrom: '2026-08-08T00:00:00.000Z',
      expiresAt: '2026-08-10T00:00:00.000Z',
      revokedAt: null,
    }],
  };
  const trust = inspectPinnedExternalEvidenceTrustStore(trustStore, {
    requiredRole: role,
    expectedKeyIds: [keyId],
  });
  assert.equal(trust.ready, true);
  const storageIdentityHash = hashRecord('OffhostWormStorageIdentityFixture', {
    targetMountRoot,
  });
  const snapshotId = (receiptType === 'object_lock' ? 'a' : 'b').repeat(64);
  const snapshotRoot = path.join(targetMountRoot, 'hepta-paper-worm', snapshotId);
  const objectRoot = path.join(snapshotRoot, 'objects');
  fs.mkdirSync(objectRoot, { recursive: true });
  const objectBytes = Buffer.from('qualified custody snapshot object\n');
  const objectHash = hashBytes(objectBytes);
  const objectPath = path.join(objectRoot, objectHash.replace(/^sha256:/u, ''));
  fs.writeFileSync(objectPath, objectBytes, { mode: 0o444 });
  const objects = [{
    role: 'fixture',
    sourceHash: objectHash,
    objectPath,
    objectHash,
    immutable: true,
  }];
  const manifestPayload = {
    version: 2,
    kind: 'OffhostWormSnapshotManifest',
    contractId: contract.contractId,
    snapshotId,
    protectionLevel: 'same_host_external_disk',
    offHostOrOffsiteCustodyQualified: false,
    objects,
  };
  const snapshotManifest = {
    ...manifestPayload,
    manifestHash: hashRecord('OffhostWormSnapshotManifest', manifestPayload),
    signature: { fixture: true },
  };
  const custodySnapshotManifestPath = path.join(
    snapshotRoot,
    'OFFHOST_WORM_SNAPSHOT_MANIFEST.json',
  );
  fs.writeFileSync(
    custodySnapshotManifestPath,
    `${JSON.stringify(snapshotManifest, null, 2)}\n`,
    { mode: 0o444 },
  );
  const selectedContract = {
    ...contract,
    offHostOrOffsiteCustodyQualified: true,
    custodyEvidencePath: '/fixture/OFFHOST_WORM_CUSTODY_EVIDENCE.json',
    custodyTrustStorePath: '/fixture/OFFHOST_WORM_CUSTODY_TRUST_STORE.json',
    custodyTrustStoreHash: trust.trustStoreHash,
    custodySignerKeyIds: [keyId],
    custodyEvidenceMaximumLifetimeMs: 60 * 60 * 1000,
    custodySnapshotManifestPath,
  };
  const receiptPayload = {
    version: 1,
    kind: 'OffhostWormCustodyReceipt',
    contractId: contract.contractId,
    receiptType,
    targetMountRoot,
    storageIdentityHash,
    snapshotManifestHash: snapshotManifest.manifestHash,
    snapshotObjectSetHash: hashRecord('OffhostWormSnapshotObjectSet', objects),
    storageSubjectId: 'storage-provider-1',
    custodyClass: 'offsite',
    issuedAt: '2026-08-09T00:00:00.000Z',
    expiresAt: '2026-08-09T00:45:00.000Z',
  };
  const receipt = {
    ...receiptPayload,
    receiptHash: hashRecord('OffhostWormCustodyReceipt', receiptPayload),
  };
  const subjectPayload = {
    version: 1,
    kind: 'OffhostWormCustodyAttestationSubject',
    contractId: contract.contractId,
    targetMountRoot,
    custodyReceiptHash: receipt.receiptHash,
    custodyClass: 'offsite',
    independentCustodianId: custodianId,
    attestedAt: '2026-08-09T00:05:00.000Z',
    expiresAt: '2026-08-09T00:40:00.000Z',
  };
  const attestationSubject = {
    ...subjectPayload,
    offhostWormCustodyAttestationSubjectHash: hashRecord(
      'OffhostWormCustodyAttestationSubject',
      subjectPayload,
    ),
  };
  const placeholder = buildPinnedExternalEvidenceEnvelope({
    subjectKind: 'OffhostWormCustodyAttestationSubject',
    subjectHash: attestationSubject.offhostWormCustodyAttestationSubjectHash,
    signedAt: attestationSubject.attestedAt,
    expiresAt: attestationSubject.expiresAt,
    signatures: [{ keyId, role, algorithm: 'ed25519', value: 'placeholder' }],
  });
  const authorityEnvelope = buildPinnedExternalEvidenceEnvelope({
    ...placeholder,
    signatures: [{
      keyId,
      role,
      algorithm: 'ed25519',
      value: crypto.sign(
        null,
        pinnedExternalEvidenceSigningPayload(placeholder),
        pair.privateKey,
      ).toString('base64'),
    }],
  });
  const bundlePayload = {
    version: 1,
    kind: 'OffhostWormCustodyEvidenceBundle',
    receipt,
    attestationSubject,
    authorityEnvelope,
  };
  return Object.freeze({
    contract: selectedContract,
    storageIdentityHash,
    objectPath,
    trustStore,
    evidence: {
      ...bundlePayload,
      custodyEvidenceBundleHash: hashRecord(
        'OffhostWormCustodyEvidenceBundle',
        bundlePayload,
      ),
    },
  });
}

const TEST_MANIFEST_AUTHORITY = (() => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const publicKeyFingerprint = hashBytes(publicKeyPem);
  const signManifest = (payload) => {
    const canonical = Buffer.from(JSON.stringify(payload), 'utf8');
    return Object.freeze({
      version: 1,
      kind: 'ReleaseIntegritySignature',
      role: 'local_release_integrity',
      algorithm: 'ed25519',
      publicKeyFingerprint,
      publicKeyPem,
      payloadHash: hashBytes(canonical),
      signature: crypto.sign(null, canonical, pair.privateKey).toString('base64'),
      authorityLimit: AUTHORITY_LIMIT,
    });
  };
  const verifyManifestSignature = (payload, signature) => {
    const canonical = Buffer.from(JSON.stringify(payload), 'utf8');
    return signature?.publicKeyPem === publicKeyPem
      && signature?.publicKeyFingerprint === publicKeyFingerprint
      && signature?.payloadHash === hashBytes(canonical)
      && crypto.verify(
        null,
        canonical,
        pair.publicKey,
        Buffer.from(String(signature?.signature || ''), 'base64'),
      );
  };
  return Object.freeze({ signManifest, verifyManifestSignature });
})();

function writeJsonReadOnly(candidate, value) {
  fs.writeFileSync(candidate, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o444 });
}

function installSigningKey(runtimeRoot) {
  const keyRoot = path.join(runtimeRoot, 'release-signing');
  fs.mkdirSync(keyRoot, { mode: 0o700 });
  const pair = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  fs.writeFileSync(
    path.join(keyRoot, 'release-integrity-ed25519-private.pem'),
    privateKeyPem,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(keyRoot, 'release-integrity-ed25519-public.pem'),
    publicKeyPem,
    { mode: 0o444 },
  );
  return Object.freeze({ privateKey: pair.privateKey, publicKeyPem });
}

function releaseState(commit) {
  const payload = {
    version: 2,
    kind: 'WorkspaceReleaseStateSnapshot',
    status: 'workspace_release_state_release_ready',
    headCommit: commit,
    headTags: [],
    allTags: [],
    documentHashes: {},
    releaseState: { ok: true, state: 'release_ready' },
  };
  return {
    ...payload,
    workspaceReleaseStateSnapshotHash: hashBytes(JSON.stringify(payload)),
  };
}

function signedReleaseFixture({
  runtimeRoot,
  signingKey,
  packageVersion,
  commit,
  generatedAt,
  pointerOverrides = {},
  signingOverride = null,
} = {}) {
  const snapshot = releaseState(commit);
  const bundlePayload = {
    version: 2,
    kind: 'ReleaseEvidenceBundle',
    status: 'code_release_evidence_ready',
    releaseProfile: 'code_release',
    codeProvenance: {
      version: 2,
      kind: 'CodeProvenance',
      packageVersion,
      commit,
      treeDirty: false,
      evidenceEnvironment: 'administrative',
      evidenceClass: 'release_attestation',
    },
    releaseStateSnapshot: snapshot,
    releaseStateSnapshotHash: snapshot.workspaceReleaseStateSnapshotHash,
    generatedAt,
    verificationReceipt: {},
    bindings: {
      releaseEvidenceInputSnapshotHash: hashRecord('ReleaseEvidenceInputSnapshot', {
        packageVersion,
        commit,
      }),
    },
    authorityStatus: {},
    deletionDrillEvidence: {},
    verificationReceiptEvidence: {},
    capabilityManifestEvidence: {},
    retirementStatus: {},
    assetRecoveryStatus: {},
    disasterRecoveryStatus: 'disaster_recovery_ready',
    trustLayers: {},
    minimalDifferentialFixture: {},
    immutableMatrixReference: {},
    productionStoreLogicalIntegrity: {},
    evidenceClasses: {},
    externalActionPerformed: false,
  };
  const bundle = {
    ...bundlePayload,
    releaseEvidenceBundleHash: hashRecord('ReleaseEvidenceBundle', bundlePayload),
  };
  const root = path.join(runtimeRoot, 'release-evidence', packageVersion, commit);
  fs.mkdirSync(root, { recursive: true });
  const token = bundle.releaseEvidenceBundleHash.slice('sha256:'.length);
  const bundlePath = path.join(root, `RELEASE_EVIDENCE_BUNDLE_${token}.json`);
  const signaturePath = path.join(root, `RELEASE_EVIDENCE_SIGNATURE_${token}.json`);
  const signer = signingOverride || signingKey;
  const canonical = Buffer.from(JSON.stringify(bundle), 'utf8');
  const signature = {
    version: 1,
    kind: 'ReleaseIntegritySignature',
    role: 'local_release_integrity',
    algorithm: 'ed25519',
    publicKeyFingerprint: hashBytes(signer.publicKeyPem),
    publicKeyPem: signer.publicKeyPem,
    payloadHash: hashBytes(canonical),
    signature: crypto.sign(null, canonical, signer.privateKey).toString('base64'),
    authorityLimit: AUTHORITY_LIMIT,
  };
  writeJsonReadOnly(bundlePath, bundle);
  writeJsonReadOnly(signaturePath, signature);
  const pointerPayload = {
    version: 2,
    kind: 'CurrentReleaseEvidencePointer',
    packageVersion,
    commit,
    bundlePath,
    bundleHash: bundle.releaseEvidenceBundleHash,
    signaturePath,
    signatureVerified: true,
    generatedAt,
    releaseStateSnapshotHash: bundle.releaseStateSnapshotHash,
    releaseEvidenceInputSnapshotHash: bundle.bindings.releaseEvidenceInputSnapshotHash,
    ...pointerOverrides,
  };
  const pointer = {
    ...pointerPayload,
    currentReleaseEvidencePointerHash: hashRecord(
      'CurrentReleaseEvidencePointer',
      pointerPayload,
    ),
  };
  const pointerPath = path.join(root, 'CURRENT_RELEASE_EVIDENCE.json');
  writeJsonReadOnly(pointerPath, pointer);
  return Object.freeze({ root, pointerPath, bundlePath, signaturePath, bundle, pointer });
}

test('release evidence selection orders semantic versions numerically', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-pointer-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const signingKey = installSigningKey(runtimeRoot);
  signedReleaseFixture({
    runtimeRoot,
    signingKey,
    packageVersion: '0.9.0',
    commit: '1'.repeat(40),
    generatedAt: '2026-07-10T00:00:00.000Z',
  });
  signedReleaseFixture({
    runtimeRoot,
    signingKey,
    packageVersion: '0.10.0',
    commit: '2'.repeat(40),
    generatedAt: '2026-07-11T00:00:00.000Z',
  });
  const selection = selectLatestVerifiedReleaseEvidence(runtimeRoot);
  assert.equal(selection.status, 'release_evidence_selection_verified');
  assert.equal(selection.packageVersion, '0.10.0');
  assert.equal(selection.sources.length, 3);
  assert.equal(resolveLatestReleaseEvidencePointer(runtimeRoot).packageVersion, '0.10.0');
});

test('release evidence selection blocks an arbitrary local path pointer', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-pointer-path-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const signingKey = installSigningKey(runtimeRoot);
  signedReleaseFixture({
    runtimeRoot,
    signingKey,
    packageVersion: '1.0.0',
    commit: '3'.repeat(40),
    generatedAt: '2026-07-11T00:00:00.000Z',
    pointerOverrides: { bundlePath: '/etc/hosts', signaturePath: '/etc/passwd' },
  });
  const selection = selectLatestVerifiedReleaseEvidence(runtimeRoot);
  assert.equal(selection.status, 'release_evidence_selection_blocked');
  assert.deepEqual(selection.sources, []);
  assert.deepEqual(selection.blockers, ['offhost_release_pointer_path_escape']);
});

test('release evidence selection never falls back from an invalid highest version', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-pointer-latest-bad-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const signingKey = installSigningKey(runtimeRoot);
  signedReleaseFixture({
    runtimeRoot,
    signingKey,
    packageVersion: '1.0.0',
    commit: '4'.repeat(40),
    generatedAt: '2026-07-11T00:00:00.000Z',
  });
  const badRoot = path.join(runtimeRoot, 'release-evidence', '2.0.0', '5'.repeat(40));
  fs.mkdirSync(badRoot, { recursive: true });
  writeJsonReadOnly(path.join(badRoot, 'CURRENT_RELEASE_EVIDENCE.json'), {
    kind: 'CurrentReleaseEvidencePointer',
    packageVersion: '2.0.0',
  });
  const selection = selectLatestVerifiedReleaseEvidence(runtimeRoot);
  assert.equal(selection.status, 'release_evidence_selection_blocked');
  assert.notEqual(selection.packageVersion, '1.0.0');
});

test('release evidence selection rejects a valid-looking bundle signed by a foreign key', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-pointer-foreign-key-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const signingKey = installSigningKey(runtimeRoot);
  const foreign = crypto.generateKeyPairSync('ed25519');
  signedReleaseFixture({
    runtimeRoot,
    signingKey,
    signingOverride: {
      privateKey: foreign.privateKey,
      publicKeyPem: foreign.publicKey.export({ type: 'spki', format: 'pem' }),
    },
    packageVersion: '1.0.0',
    commit: '6'.repeat(40),
    generatedAt: '2026-07-11T00:00:00.000Z',
  });
  const selection = selectLatestVerifiedReleaseEvidence(runtimeRoot);
  assert.equal(selection.status, 'release_evidence_selection_blocked');
  assert.deepEqual(selection.blockers, ['offhost_release_signature_verification_failed']);
});

test('offhost target status requires qualified custody only in the explicit exit gate', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-offhost-custody-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetMountRoot = path.join(root, 'target');
  fs.mkdirSync(targetMountRoot);
  const contract = {
    version: 1,
    kind: 'OffhostWormSnapshotContract',
    contractId: 'custody-fixture',
    targetMountRoot,
    requireDistinctFilesystemDevice: true,
    offHostOrOffsiteCustodyQualified: false,
    offlineDetachmentOrObjectLockReceiptRequired: true,
    independentCustodyAttestationRequired: true,
  };
  const probe = {
    workspaceRoot: root,
    contract,
    mountAvailableOverride: true,
    distinctDeviceOverride: true,
  };
  const diagnostic = verifyOffhostWormTarget(probe);
  assert.equal(diagnostic.status, 'offhost_worm_target_ready');
  assert.equal(diagnostic.custodyRequired, false);
  assert.deepEqual(diagnostic.blockers, []);
  for (const blocker of [
    'offhost_or_offsite_custody_not_qualified',
    'offhost_worm_custody_freshness_policy_missing_or_invalid',
    'offhost_worm_custody_evidence_missing',
    'offhost_worm_custody_trust_store_missing',
    'current_object_lock_receipt_missing',
    'independent_custody_attestation_missing',
  ]) assert.ok(diagnostic.custodyBlockers.includes(blocker), blocker);

  const exitGate = verifyOffhostWormTarget({ ...probe, requireCustody: true });
  assert.equal(exitGate.status, 'offhost_worm_target_blocked');
  assert.equal(exitGate.custodyRequired, true);
  assert.deepEqual(exitGate.blockers, diagnostic.custodyBlockers);

  const staticBooleanOnly = verifyOffhostWormTarget({
    ...probe,
    contract: { ...contract, offHostOrOffsiteCustodyQualified: true },
    requireCustody: true,
  });
  assert.equal(staticBooleanOnly.status, 'offhost_worm_target_blocked');
  assert.equal(staticBooleanOnly.custodyDeclaredQualified, true);
  assert.equal(staticBooleanOnly.offHostOrOffsiteCustodyQualified, false);
  assert.ok(staticBooleanOnly.blockers.includes(
    'current_object_lock_receipt_missing',
  ));
  assert.ok(staticBooleanOnly.blockers.includes('independent_custody_attestation_missing'));

  const fixture = custodyEvidenceFixture({ contract, targetMountRoot });
  const qualified = verifyOffhostWormTarget({
    ...probe,
    contract: fixture.contract,
    custodyEvidenceOverride: fixture.evidence,
    custodyTrustStoreOverride: fixture.trustStore,
    storageIdentityHashOverride: fixture.storageIdentityHash,
    custodyImmutableOverride: true,
    now: CUSTODY_NOW,
    requireCustody: true,
  });
  assert.equal(qualified.status, 'offhost_worm_target_ready');
  assert.equal(qualified.offHostOrOffsiteCustodyQualified, true);
  assert.equal(qualified.custodyEvidenceStatus, 'offhost_worm_custody_evidence_verified');
  assert.deepEqual(qualified.custodyBlockers, []);
  assert.deepEqual(qualified.blockers, []);

  const historicalDetachment = custodyEvidenceFixture({
    contract,
    targetMountRoot,
    receiptType: 'offline_detachment',
  });
  const reattached = verifyOffhostWormTarget({
    ...probe,
    contract: historicalDetachment.contract,
    custodyEvidenceOverride: historicalDetachment.evidence,
    custodyTrustStoreOverride: historicalDetachment.trustStore,
    storageIdentityHashOverride: historicalDetachment.storageIdentityHash,
    custodyImmutableOverride: true,
    now: CUSTODY_NOW,
    requireCustody: true,
  });
  assert.equal(reattached.status, 'offhost_worm_target_blocked');
  assert.equal(reattached.offHostOrOffsiteCustodyQualified, false);
  assert.ok(reattached.blockers.includes(
    'current_object_lock_receipt_invalid_or_stale',
  ));

  const replacedStorage = verifyOffhostWormTarget({
    ...probe,
    contract: fixture.contract,
    custodyEvidenceOverride: fixture.evidence,
    custodyTrustStoreOverride: fixture.trustStore,
    storageIdentityHashOverride: hashRecord('ReplacementStorageIdentity', {}),
    custodyImmutableOverride: true,
    now: CUSTODY_NOW,
    requireCustody: true,
  });
  assert.equal(replacedStorage.status, 'offhost_worm_target_blocked');
  assert.ok(replacedStorage.blockers.includes(
    'current_object_lock_receipt_invalid_or_stale',
  ));

  const stale = verifyOffhostWormTarget({
    ...probe,
    contract: fixture.contract,
    custodyEvidenceOverride: fixture.evidence,
    custodyTrustStoreOverride: fixture.trustStore,
    storageIdentityHashOverride: fixture.storageIdentityHash,
    custodyImmutableOverride: true,
    now: new Date('2026-08-09T00:45:00.000Z'),
    requireCustody: true,
  });
  assert.equal(stale.status, 'offhost_worm_target_blocked');
  assert.ok(stale.blockers.includes(
    'current_object_lock_receipt_invalid_or_stale',
  ));

  fs.chmodSync(fixture.objectPath, 0o644);
  fs.writeFileSync(fixture.objectPath, 'modified after custody attestation\n');
  fs.chmodSync(fixture.objectPath, 0o444);
  const modifiedSnapshot = verifyOffhostWormTarget({
    ...probe,
    contract: fixture.contract,
    custodyEvidenceOverride: fixture.evidence,
    custodyTrustStoreOverride: fixture.trustStore,
    storageIdentityHashOverride: fixture.storageIdentityHash,
    custodyImmutableOverride: true,
    now: CUSTODY_NOW,
    requireCustody: true,
  });
  assert.equal(modifiedSnapshot.status, 'offhost_worm_target_blocked');
  assert.ok(modifiedSnapshot.blockers.includes(
    'offhost_worm_custody_snapshot_object_invalid_or_changed',
  ));
  assert.throws(
    () => verifyOffhostWormTarget({ ...probe, requireCustody: 'true' }),
    /offhost_worm_require_custody_boolean_required/u,
  );
});

test('offhost status CLI makes require-custody a fail-closed exit mode', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-offhost-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    path.join(WORKSPACE_ROOT, 'paper-core', 'bin', 'offhost-worm-snapshot.mjs'),
    'status',
    '--require-custody',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HEPTA_OFFHOST_WORM_ROOT: path.join(root, 'unmounted-target'),
    },
  });
  assert.equal(result.status, 1, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.custodyRequired, true);
  assert.ok(status.blockers.includes('offhost_worm_target_unavailable'));
});

test('offhost WORM snapshot binds immutable objects and supports restore verification', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-offhost-worm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.json');
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(source, '{"verified":true}\n');
  const contract = { version: 1, kind: 'OffhostWormSnapshotContract', contractId: 'fixture', targetMountRoot: target, requireDistinctFilesystemDevice: true, requireFilesystemImmutableObjects: true };
  const snapshot = createOffhostWormSnapshot({
    workspaceRoot: root,
    contract,
    sources: [{ role: 'fixture', path: source }],
    execute: true,
    mountAvailableOverride: true,
    distinctDeviceOverride: true,
    immutableOverride: true,
    ...TEST_MANIFEST_AUTHORITY,
  });
  assert.equal(snapshot.status, 'offhost_worm_snapshot_recorded');
  assert.equal(snapshot.target.offHostOrOffsiteCustodyQualified, false);
  assert.equal(snapshot.target.custodyStatus, 'offhost_or_offsite_custody_blocked');
  const drill = drillOffhostWormRestore({
    manifestPath: snapshot.manifestPath,
    targetMountRoot: target,
    immutableOverride: true,
    verifyManifestSignature: TEST_MANIFEST_AUTHORITY.verifyManifestSignature,
  });
  assert.equal(drill.status, 'offhost_worm_restore_drill_passed');
  assert.equal(drill.verifiedObjectCount, 1);
  const mutableDrill = drillOffhostWormRestore({
    manifestPath: snapshot.manifestPath,
    targetMountRoot: target,
    immutableOverride: false,
    verifyManifestSignature: TEST_MANIFEST_AUTHORITY.verifyManifestSignature,
  });
  assert.equal(mutableDrill.status, 'offhost_worm_restore_drill_blocked');
  assert.equal(mutableDrill.verifiedObjectCount, 0);
  assert.deepEqual(mutableDrill.blockers, ['offhost_worm_object_not_immutable:fixture']);
});

test('new snapshot never inherits a prior snapshot custody qualification', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-offhost-new-snapshot-custody-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  const targetMountRoot = path.join(root, 'target');
  fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(targetMountRoot);
  const source = path.join(workspaceRoot, 'new-snapshot-source.json');
  fs.writeFileSync(source, '{"snapshot":"B"}\n');
  const contract = {
    version: 1,
    kind: 'OffhostWormSnapshotContract',
    contractId: 'custody-fixture',
    targetMountRoot,
    requireDistinctFilesystemDevice: true,
    requireFilesystemImmutableObjects: true,
    offHostOrOffsiteCustodyQualified: false,
    offlineDetachmentOrObjectLockReceiptRequired: true,
    independentCustodyAttestationRequired: true,
  };
  const fixture = custodyEvidenceFixture({ contract, targetMountRoot });
  const priorQualification = verifyOffhostWormTarget({
    workspaceRoot,
    contract: fixture.contract,
    mountAvailableOverride: true,
    distinctDeviceOverride: true,
    custodyEvidenceOverride: fixture.evidence,
    custodyTrustStoreOverride: fixture.trustStore,
    storageIdentityHashOverride: fixture.storageIdentityHash,
    custodyImmutableOverride: true,
    now: CUSTODY_NOW,
    requireCustody: true,
  });
  assert.equal(priorQualification.offHostOrOffsiteCustodyQualified, true);

  const snapshot = createOffhostWormSnapshot({
    workspaceRoot,
    contract: fixture.contract,
    sources: [{ role: 'new_snapshot_source', path: source }],
    execute: true,
    mountAvailableOverride: true,
    distinctDeviceOverride: true,
    immutableOverride: true,
    custodyEvidenceOverride: fixture.evidence,
    custodyTrustStoreOverride: fixture.trustStore,
    storageIdentityHashOverride: fixture.storageIdentityHash,
    custodyImmutableOverride: true,
    custodyNow: CUSTODY_NOW,
    ...TEST_MANIFEST_AUTHORITY,
  });
  assert.equal(snapshot.status, 'offhost_worm_snapshot_recorded');
  assert.equal(snapshot.target.offHostOrOffsiteCustodyQualified, true);
  const manifest = JSON.parse(fs.readFileSync(snapshot.manifestPath, 'utf8'));
  assert.notEqual(manifest.snapshotId, 'a'.repeat(64));
  assert.equal(manifest.offHostOrOffsiteCustodyQualified, false);
  const { signature, ...signedManifest } = manifest;
  assert.equal(
    TEST_MANIFEST_AUTHORITY.verifyManifestSignature(signedManifest, signature),
    true,
  );
});

test('offhost WORM snapshot rejects a release source replaced after verified selection', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-offhost-selection-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const workspaceRoot = path.join(root, 'workspace');
  const targetMountRoot = path.join(root, 'target');
  fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(targetMountRoot);
  const signingKey = installSigningKey(runtimeRoot);
  const published = signedReleaseFixture({
    runtimeRoot,
    signingKey,
    packageVersion: '1.0.0',
    commit: '7'.repeat(40),
    generatedAt: '2026-07-11T00:00:00.000Z',
  });
  const selection = selectLatestVerifiedReleaseEvidence(runtimeRoot);
  assert.equal(selection.status, 'release_evidence_selection_verified');
  fs.renameSync(published.bundlePath, `${published.bundlePath}.replaced`);
  writeJsonReadOnly(published.bundlePath, published.bundle);
  const contract = {
    version: 1,
    kind: 'OffhostWormSnapshotContract',
    contractId: 'selection-race',
    targetMountRoot,
    requireDistinctFilesystemDevice: true,
    requireFilesystemImmutableObjects: true,
  };
  const result = createOffhostWormSnapshot({
    workspaceRoot,
    contract,
    sources: selection.sources,
    execute: true,
    mountAvailableOverride: true,
    distinctDeviceOverride: true,
    immutableOverride: true,
    ...TEST_MANIFEST_AUTHORITY,
  });
  assert.equal(result.status, 'offhost_worm_snapshot_blocked');
  assert.ok(result.blockers.includes('offhost_worm_source_unsafe:release_evidence_bundle'));
  assert.equal(fs.existsSync(path.join(targetMountRoot, 'hepta-paper-worm')), false);
});

test('offhost WORM snapshot detects a source path swap during copy', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-offhost-copy-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  const targetMountRoot = path.join(root, 'target');
  fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(targetMountRoot);
  const source = path.join(workspaceRoot, 'source.json');
  fs.writeFileSync(source, '{"first":true}\n');
  const contract = {
    version: 1,
    kind: 'OffhostWormSnapshotContract',
    contractId: 'copy-race',
    targetMountRoot,
    requireDistinctFilesystemDevice: true,
    requireFilesystemImmutableObjects: true,
  };
  let swapped = false;
  const result = createOffhostWormSnapshot({
    workspaceRoot,
    contract,
    sources: [{ role: 'subject', path: source }],
    execute: true,
    mountAvailableOverride: true,
    distinctDeviceOverride: true,
    immutableOverride: true,
    faultInjector({ stage }) {
      if (stage !== 'after_source_copy' || swapped) return;
      swapped = true;
      fs.renameSync(source, `${source}.original`);
      fs.writeFileSync(source, '{"second":true}\n');
    },
    ...TEST_MANIFEST_AUTHORITY,
  });
  assert.equal(result.status, 'offhost_worm_snapshot_blocked');
  assert.ok(result.blockers.includes('offhost_worm_source_changed_or_copy_failed:subject'));
});

test('offhost WORM snapshot rejects symlink sources and dry mode writes nothing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-offhost-symlink-dry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  const targetMountRoot = path.join(root, 'target');
  fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(targetMountRoot);
  const source = path.join(workspaceRoot, 'source.json');
  const link = path.join(workspaceRoot, 'source-link.json');
  fs.writeFileSync(source, '{"verified":true}\n');
  fs.symlinkSync(source, link);
  const contract = {
    version: 1,
    kind: 'OffhostWormSnapshotContract',
    contractId: 'symlink-dry',
    targetMountRoot,
    requireDistinctFilesystemDevice: true,
    requireFilesystemImmutableObjects: true,
  };
  const linked = createOffhostWormSnapshot({
    workspaceRoot,
    contract,
    sources: [{ role: 'subject', path: link }],
    execute: true,
    mountAvailableOverride: true,
    distinctDeviceOverride: true,
    immutableOverride: true,
    ...TEST_MANIFEST_AUTHORITY,
  });
  assert.equal(linked.status, 'offhost_worm_snapshot_blocked');
  assert.ok(linked.blockers.includes('offhost_worm_source_unsafe:subject'));
  const dry = createOffhostWormSnapshot({
    workspaceRoot,
    contract,
    sources: [{ role: 'subject', path: source }],
    execute: false,
    mountAvailableOverride: true,
    distinctDeviceOverride: true,
    immutableOverride: true,
    ...TEST_MANIFEST_AUTHORITY,
  });
  assert.equal(dry.status, 'offhost_worm_snapshot_blocked');
  assert.ok(dry.blockers.includes('offhost_worm_snapshot_execute_required'));
  assert.equal(fs.existsSync(path.join(targetMountRoot, 'hepta-paper-worm')), false);
});

test('offhost WORM snapshot detects a corrupt pre-existing content-addressed object', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-offhost-worm-corrupt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  const targetMountRoot = path.join(root, 'target');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(targetMountRoot, { recursive: true });
  const source = path.join(workspaceRoot, 'source.json');
  fs.writeFileSync(source, '{"ok":true}\n');
  const contract = {
    version: 1,
    kind: 'OffhostWormSnapshotContract',
    contractId: 'test-worm-corrupt-v1',
    targetMountRoot,
    requireDistinctFilesystemDevice: true,
    requireFilesystemImmutableObjects: true,
  };
  const first = createOffhostWormSnapshot({
    workspaceRoot,
    contract,
    sources: [{ role: 'subject', path: source }],
    execute: true,
    mountAvailableOverride: true,
    distinctDeviceOverride: true,
    immutableOverride: true,
    ...TEST_MANIFEST_AUTHORITY,
  });
  const manifest = JSON.parse(fs.readFileSync(first.manifestPath, 'utf8'));
  const objectPath = manifest.objects[0].objectPath;
  fs.chmodSync(objectPath, 0o644);
  fs.writeFileSync(objectPath, '{"corrupt":true}\n');
  const second = createOffhostWormSnapshot({
    workspaceRoot,
    contract,
    sources: [{ role: 'subject', path: source }],
    execute: true,
    mountAvailableOverride: true,
    distinctDeviceOverride: true,
    immutableOverride: true,
    ...TEST_MANIFEST_AUTHORITY,
  });
  assert.equal(second.status, 'offhost_worm_snapshot_blocked');
  assert.ok(second.blockers.includes('offhost_worm_source_changed_or_copy_failed:subject'));
});

test('offhost WORM snapshot leaves no file outside the fixed root when object parent is swapped', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-offhost-parent-swap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  const targetMountRoot = path.join(root, 'target');
  const escapeRoot = path.join(root, 'escape');
  const redirectRoot = path.join(escapeRoot, 'redirect');
  fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(targetMountRoot);
  fs.mkdirSync(redirectRoot, { recursive: true });
  const source = path.join(workspaceRoot, 'source.json');
  fs.writeFileSync(source, '{"secret":"must-not-escape"}\n');
  const contract = {
    version: 1,
    kind: 'OffhostWormSnapshotContract',
    contractId: 'parent-swap',
    targetMountRoot,
    requireDistinctFilesystemDevice: true,
    requireFilesystemImmutableObjects: true,
  };
  let swapped = false;
  const result = createOffhostWormSnapshot({
    workspaceRoot,
    contract,
    sources: [{ role: 'subject', path: source }],
    execute: true,
    mountAvailableOverride: true,
    distinctDeviceOverride: true,
    immutableOverride: true,
    faultInjector({ stage, destination }) {
      if (stage !== 'before_source_copy' || swapped) return;
      swapped = true;
      const objectRoot = path.dirname(destination);
      fs.renameSync(objectRoot, path.join(escapeRoot, 'original-objects'));
      fs.symlinkSync(redirectRoot, objectRoot);
    },
    ...TEST_MANIFEST_AUTHORITY,
  });
  assert.equal(result.status, 'offhost_worm_snapshot_blocked');
  assert.ok(result.blockers.includes('offhost_worm_source_changed_or_copy_failed:subject'));
  assert.deepEqual(fs.readdirSync(redirectRoot), []);
  assert.deepEqual(fs.readdirSync(path.join(escapeRoot, 'original-objects')), []);
});

test('offhost WORM restore rejects outside manifests and signed arbitrary object paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-offhost-restore-forgery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetMountRoot = path.join(root, 'target');
  fs.mkdirSync(targetMountRoot);
  const outsideObject = path.join(root, 'outside-object');
  fs.writeFileSync(outsideObject, 'outside\n', { mode: 0o444 });
  const snapshotId = 'a'.repeat(64);
  const snapshotRoot = path.join(targetMountRoot, 'hepta-paper-worm', snapshotId);
  fs.mkdirSync(path.join(snapshotRoot, 'objects'), { recursive: true, mode: 0o700 });
  const sourceHash = hashBytes(fs.readFileSync(outsideObject));
  const payload = {
    version: 2,
    kind: 'OffhostWormSnapshotManifest',
    contractId: 'forged-object-path',
    snapshotId,
    protectionLevel: 'fixture',
    offHostOrOffsiteCustodyQualified: false,
    objects: [{
      role: 'outside',
      sourceHash,
      objectPath: outsideObject,
      objectHash: sourceHash,
      immutable: true,
    }],
  };
  const unsignedManifest = {
    ...payload,
    manifestHash: hashRecord('OffhostWormSnapshotManifest', payload),
  };
  const document = {
    ...unsignedManifest,
    signature: TEST_MANIFEST_AUTHORITY.signManifest(unsignedManifest),
  };
  const inRootManifest = path.join(snapshotRoot, 'OFFHOST_WORM_SNAPSHOT_MANIFEST.json');
  writeJsonReadOnly(inRootManifest, document);
  const arbitraryObject = drillOffhostWormRestore({
    manifestPath: inRootManifest,
    targetMountRoot,
    immutableOverride: true,
    verifyManifestSignature: TEST_MANIFEST_AUTHORITY.verifyManifestSignature,
  });
  assert.equal(arbitraryObject.status, 'offhost_worm_restore_drill_blocked');
  assert.ok(arbitraryObject.blockers.includes('offhost_worm_object_contract_invalid:outside'));

  const outsideManifest = path.join(root, 'outside-manifest.json');
  writeJsonReadOnly(outsideManifest, document);
  const outside = drillOffhostWormRestore({
    manifestPath: outsideManifest,
    targetMountRoot,
    immutableOverride: true,
    verifyManifestSignature: TEST_MANIFEST_AUTHORITY.verifyManifestSignature,
  });
  assert.deepEqual(outside.blockers, ['offhost_worm_manifest_path_outside_fixed_root']);
});
