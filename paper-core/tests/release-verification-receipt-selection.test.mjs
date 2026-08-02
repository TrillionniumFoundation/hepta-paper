import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  releaseAttestationCodeProvenance,
} from '../bin/release-evidence-lib.mjs';
import {
  selectCurrentReleaseVerificationReceipt,
} from '../bin/release-verification-receipt-selection.mjs';
import {
  buildIsolatedVerificationReceipt,
} from '../src/isolated-verification-receipt-contract.mjs';

const NOW = new Date('2026-08-01T04:00:00.000Z');
const RELEASE_INTEGRITY_AUTHORITY_LIMIT =
  'build_and_archive_integrity_only_not_owner_academic_referee_or_submission_authority';

function sha256Json(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function releaseStateSnapshot(commit) {
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

function exactProvenance() {
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

function verificationFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-verification-selector-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const verificationRoot = path.join(runtimeRoot, 'release-evidence', 'verification-receipts');
  fs.mkdirSync(verificationRoot, { recursive: true, mode: 0o700 });
  const signingAuthority = installFixtureSigningAuthority(runtimeRoot);
  const codeProvenance = exactProvenance();
  const releaseSnapshot = releaseStateSnapshot(codeProvenance.commit);
  const verificationProvenance = Object.freeze({
    ...codeProvenance,
    evidenceEnvironment: 'verification',
    evidenceClass: 'technical_conformance',
  });
  const receipt = buildIsolatedVerificationReceipt({
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
    startedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    completedAt: NOW.toISOString(),
    exitCode: 0,
    isolatedStoreHash: `sha256:${'7'.repeat(64)}`,
    productionStoreHashBefore: `sha256:${'8'.repeat(64)}`,
    productionStoreHashAfter: `sha256:${'8'.repeat(64)}`,
    productionLogicalHashBefore: `sha256:${'9'.repeat(64)}`,
    productionLogicalHashAfter: `sha256:${'9'.repeat(64)}`,
    productionLogicalIntegrityStatusBefore: 'sqlite_logical_integrity_verified',
    productionLogicalIntegrityStatusAfter: 'sqlite_logical_integrity_verified',
    productionLogicalIntegrityBlockersBefore: [],
    productionLogicalIntegrityBlockersAfter: [],
  });
  const document = {
    ...receipt,
    signature: signingAuthority.signPayload(receipt),
  };
  const candidateName = `ISOLATED_VERIFICATION_RECEIPT_${NOW.getTime()}_${receipt.isolatedVerificationReceiptHash.slice('sha256:'.length)}.json`;
  fs.writeFileSync(
    path.join(verificationRoot, candidateName),
    `${JSON.stringify(document, null, 2)}\n`,
    { mode: 0o444 },
  );
  return Object.freeze({
    root,
    runtimeRoot,
    verificationRoot,
    codeProvenance,
    releaseSnapshot,
    candidateName,
  });
}

function selectVerification(fixture, faultInjector) {
  return selectCurrentReleaseVerificationReceipt({
    verificationRoot: fixture.verificationRoot,
    runtimeRoot: fixture.runtimeRoot,
    codeProvenance: fixture.codeProvenance,
    expectedReleaseStateSnapshot: fixture.releaseSnapshot,
    now: NOW,
    faultInjector,
  });
}

test('newer malformed verification receipt insertion during selection fails closed', (t) => {
  const fixture = verificationFixture(t);
  const insertedName = `ISOLATED_VERIFICATION_RECEIPT_${NOW.getTime() + 1}_${'f'.repeat(64)}.json`;
  const selected = selectVerification(fixture, ({ stage, verificationRoot }) => {
    assert.equal(stage, 'before_final_directory_validation');
    fs.writeFileSync(path.join(verificationRoot, insertedName), '{', { mode: 0o444 });
  });
  assert.equal(selected.status, 'release_verification_current_evidence_blocked');
  assert.equal(selected.candidateName, fixture.candidateName);
  assert.deepEqual(selected.blockers, ['release_verification_candidate_set_changed']);
  assert.equal(fs.readFileSync(path.join(fixture.verificationRoot, insertedName), 'utf8'), '{');
});

test('verification receipt root replacement during selection fails closed', (t) => {
  const fixture = verificationFixture(t);
  const savedRoot = `${fixture.verificationRoot}-saved`;
  const selected = selectVerification(fixture, ({ stage, verificationRoot }) => {
    assert.equal(stage, 'before_final_directory_validation');
    fs.renameSync(verificationRoot, savedRoot);
    fs.mkdirSync(verificationRoot, { mode: 0o700 });
    fs.writeFileSync(path.join(verificationRoot, 'replacement'), 'must survive\n');
  });
  assert.equal(selected.status, 'release_verification_current_evidence_blocked');
  assert.equal(selected.candidateName, fixture.candidateName);
  assert.deepEqual(selected.blockers, ['release_verification_receipt_root_changed']);
  assert.equal(
    fs.readFileSync(path.join(fixture.verificationRoot, 'replacement'), 'utf8'),
    'must survive\n',
  );
  assert.equal(fs.existsSync(path.join(savedRoot, fixture.candidateName)), true);
});
