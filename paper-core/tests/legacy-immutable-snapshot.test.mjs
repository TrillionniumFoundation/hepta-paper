import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  inspectLegacyReferenceArchive,
  releaseAttestationCodeProvenance,
  retirementLifecycleStatus,
  selectCurrentLegacyImmutableSnapshotReceipt,
} from '../bin/release-evidence-lib.mjs';
import {
  attestLegacyImmutableSnapshot,
  expectedLegacyImmutableArchivePath,
  parseLegacyImmutableSnapshotArguments,
} from '../bin/legacy-immutable-snapshot.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NOW = new Date('2026-08-01T06:00:00.000Z');
const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const RELEASE_INTEGRITY_AUTHORITY_LIMIT =
  'build_and_archive_integrity_only_not_owner_academic_referee_or_submission_authority';
const NON_ISOLATED_TEST_ENVIRONMENT = Object.freeze({
  HEPTA_PAPER_RUNTIME_ISOLATED: '0',
});

function sha256Json(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function releaseStateSnapshot(commit = '1'.repeat(40)) {
  const payload = {
    version: 2,
    kind: 'WorkspaceReleaseStateSnapshot',
    status: 'workspace_release_state_release_ready',
    headCommit: commit,
    headTags: [],
    allTags: [],
    documentHashes: {},
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
  fs.chmodSync(runtimeRoot, 0o700);
  fs.chmodSync(keyRoot, 0o700);
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

function immutableLsattr(command, args) {
  assert.equal(command, 'lsattr');
  assert.deepEqual(args.slice(0, 2), ['-d', '--']);
  return { status: 0, stdout: `----i----------------- ${args.at(-1)}\n`, stderr: '' };
}

function mutableLsattr(command, args) {
  assert.equal(command, 'lsattr');
  return { status: 0, stdout: `---------------------- ${args.at(-1)}\n`, stderr: '' };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-immutable-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const archiveRoot = path.join(root, 'hepta-paper-legacy-reference', '0.21.0');
  const archivePath = path.join(archiveRoot, 'paper-factory-control-plane-reference.tar.gz');
  fs.mkdirSync(archiveRoot, { recursive: true });
  fs.writeFileSync(archivePath, 'immutable legacy archive bytes\n', { mode: 0o444 });
  const signingAuthority = installFixtureSigningAuthority(runtimeRoot);
  const codeProvenance = exactProvenance();
  return {
    root,
    runtimeRoot,
    archiveRoot,
    archivePath,
    signingAuthority,
    codeProvenance,
    releaseStateSnapshot: releaseStateSnapshot(codeProvenance.commit),
  };
}

function buildSignedDocument(fixtureValue, {
  createdAt = NOW.toISOString(),
  codeProvenance = fixtureValue.codeProvenance,
  releaseState = fixtureValue.releaseStateSnapshot,
  signingAuthority = fixtureValue.signingAuthority,
  payloadOverrides = {},
} = {}) {
  const archive = inspectLegacyReferenceArchive({
    archivePath: fixtureValue.archivePath,
    spawnSyncImpl: immutableLsattr,
  });
  const payload = {
    version: 2,
    kind: 'LegacyReferenceImmutableSnapshotReceipt',
    status: 'legacy_reference_ext4_inode_immutable',
    codeProvenance,
    releaseStateSnapshot: releaseState,
    releaseStateSnapshotHash: releaseState.workspaceReleaseStateSnapshotHash,
    referenceVersion: codeProvenance.packageVersion,
    archivePath: archive.archivePath,
    archiveHash: archive.archiveHash,
    archiveDevice: archive.archiveDevice,
    archiveInode: archive.archiveInode,
    archiveSize: archive.archiveSize,
    archiveMode: archive.archiveMode,
    filesystemMechanism: 'ext4_inode_immutable_flag',
    archiveImmutable: true,
    fullFilesystemWormClaimed: false,
    immutableContentObjectClaimed: true,
    destructiveDeletionPerformed: false,
    createdAt,
    ...payloadOverrides,
  };
  const receipt = {
    ...payload,
    immutableSnapshotReceiptHash: hashRecord(
      'LegacyReferenceImmutableSnapshotReceipt',
      payload,
    ),
  };
  return {
    receipt,
    signature: signingAuthority.signPayload(receipt),
  };
}

function documentNames(document) {
  const timestamp = Date.parse(document.receipt.createdAt);
  const token = document.receipt.immutableSnapshotReceiptHash.slice('sha256:'.length);
  return {
    receiptName: `IMMUTABLE_SNAPSHOT_RECEIPT_${timestamp}_${token}.json`,
    signatureName: `IMMUTABLE_SNAPSHOT_SIGNATURE_${timestamp}_${token}.json`,
  };
}

function writeDocument(fixtureValue, document, names = documentNames(document)) {
  fs.writeFileSync(
    path.join(fixtureValue.archiveRoot, names.receiptName),
    `${JSON.stringify(document.receipt, null, 2)}\n`,
    { mode: 0o444 },
  );
  fs.writeFileSync(
    path.join(fixtureValue.archiveRoot, names.signatureName),
    `${JSON.stringify(document.signature, null, 2)}\n`,
    { mode: 0o444 },
  );
  return names;
}

function select(fixtureValue, overrides = {}) {
  return selectCurrentLegacyImmutableSnapshotReceipt({
    archivePath: fixtureValue.archivePath,
    runtimeRoot: fixtureValue.runtimeRoot,
    expectedCodeProvenance: fixtureValue.codeProvenance,
    expectedReleaseStateSnapshot: fixtureValue.releaseStateSnapshot,
    now: NOW,
    spawnSyncImpl: immutableLsattr,
    ...overrides,
  });
}

test('immutable snapshot selector accepts only an exact signed v2 receipt bound to the live inode', (t) => {
  const selectedFixture = fixture(t);
  const document = buildSignedDocument(selectedFixture);
  const names = writeDocument(selectedFixture, document);
  const selected = select(selectedFixture);
  assert.equal(selected.status, 'legacy_immutable_snapshot_current_evidence_verified');
  assert.equal(selected.releaseEvidenceReady, true);
  assert.equal(selected.receiptHash, document.receipt.immutableSnapshotReceiptHash);
  assert.equal(selected.candidateName, names.receiptName);
  assert.equal(selected.signatureCandidateName, names.signatureName);
  assert.equal(selected.currentArchive.archiveImmutable, true);
  assert.deepEqual(selected.blockers, []);
});

test('a minimal forged immutable status document cannot satisfy release evidence', (t) => {
  const selectedFixture = fixture(t);
  const timestamp = NOW.getTime();
  const token = 'f'.repeat(64);
  fs.writeFileSync(
    path.join(selectedFixture.archiveRoot, `IMMUTABLE_SNAPSHOT_RECEIPT_${timestamp}_${token}.json`),
    '{"status":"legacy_reference_ext4_inode_immutable"}\n',
    { mode: 0o444 },
  );
  fs.writeFileSync(
    path.join(selectedFixture.archiveRoot, `IMMUTABLE_SNAPSHOT_SIGNATURE_${timestamp}_${token}.json`),
    '{}\n',
    { mode: 0o444 },
  );
  const selected = select(selectedFixture);
  assert.equal(selected.status, 'legacy_immutable_snapshot_current_evidence_blocked');
  assert.equal(selected.releaseEvidenceReady, false);
  assert.ok(selected.blockers.includes('legacy_immutable_snapshot_receipt_shape_invalid'));
  assert.ok(selected.blockers.includes('legacy_immutable_snapshot_signature_invalid'));
  const missingLegacyRoot = path.join(selectedFixture.root, 'absent-legacy-root');
  const lifecycle = retirementLifecycleStatus({
    legacyRoot: missingLegacyRoot,
    immutableReceipt: { status: 'legacy_reference_ext4_inode_immutable' },
  });
  assert.equal(lifecycle.physicalDeletionObserved, false);
  assert.equal(lifecycle.destructiveDeletionPerformed, false);
});

test('release bundle readiness consumes only the verified immutable selection', () => {
  const captureSource = fs.readFileSync(
    path.join(workspaceRoot, 'paper-core', 'bin', 'release-evidence-input-snapshot.mjs'),
    'utf8',
  );
  const buildSource = fs.readFileSync(
    path.join(workspaceRoot, 'paper-core', 'bin', 'release-evidence-bundle.mjs'),
    'utf8',
  );
  assert.match(captureSource, /selectCurrentLegacyImmutableSnapshotReceipt\(\{/u);
  assert.doesNotMatch(buildSource, /selectCurrentLegacyImmutableSnapshotReceipt\(\{/u);
  assert.match(buildSource, /immutableSnapshotEvidence\.releaseEvidenceReady === true/u);
  assert.match(
    buildSource,
    /legacyImmutableSnapshotReceiptHash: immutableSnapshotEvidence\.receiptHash/u,
  );
  assert.doesNotMatch(buildSource, /JSON\.parse\(fs\.readFileSync\(immutable/u);
});

test('immutable receipt shape, self hash, release state, archive binding, and pinned key fail closed', async (t) => {
  const cases = [
    ['extra field', (selectedFixture) => buildSignedDocument(selectedFixture, {
      payloadOverrides: { unexpected: true },
    }), 'legacy_immutable_snapshot_receipt_shape_invalid'],
    ['archive hash', (selectedFixture) => buildSignedDocument(selectedFixture, {
      payloadOverrides: { archiveHash: `sha256:${'a'.repeat(64)}` },
    }), 'legacy_immutable_snapshot_archive_hash_mismatch'],
    ['release state', (selectedFixture) => buildSignedDocument(selectedFixture, {
      releaseState: releaseStateSnapshot('a'.repeat(40)),
    }), 'legacy_immutable_snapshot_release_state_mismatch'],
  ];
  for (const [label, build, blocker] of cases) await t.test(label, (subtest) => {
    const selectedFixture = fixture(subtest);
    writeDocument(selectedFixture, build(selectedFixture));
    assert.ok(select(selectedFixture).blockers.includes(blocker));
  });
  await t.test('self hash', (subtest) => {
    const selectedFixture = fixture(subtest);
    const document = buildSignedDocument(selectedFixture);
    document.receipt.archiveSize += 1;
    writeDocument(selectedFixture, document);
    assert.ok(select(selectedFixture).blockers.includes('legacy_immutable_snapshot_self_hash_mismatch'));
  });
  await t.test('unpinned key', (subtest) => {
    const selectedFixture = fixture(subtest);
    const alternateRuntimeRoot = path.join(selectedFixture.root, 'alternate-runtime');
    const alternateSigningAuthority = installFixtureSigningAuthority(alternateRuntimeRoot);
    writeDocument(selectedFixture, buildSignedDocument(selectedFixture, {
      signingAuthority: alternateSigningAuthority,
    }));
    assert.ok(select(selectedFixture).blockers.includes('legacy_immutable_snapshot_signature_invalid'));
  });
});

test('a malformed latest immutable receipt blocks fallback to an older verified receipt', (t) => {
  const selectedFixture = fixture(t);
  const older = buildSignedDocument(selectedFixture, {
    createdAt: new Date(NOW.getTime() - 1000).toISOString(),
  });
  writeDocument(selectedFixture, older);
  const latestToken = 'f'.repeat(64);
  const latestName = `IMMUTABLE_SNAPSHOT_RECEIPT_${NOW.getTime()}_${latestToken}.json`;
  fs.writeFileSync(path.join(selectedFixture.archiveRoot, latestName), '{\n', { mode: 0o444 });
  fs.writeFileSync(
    path.join(selectedFixture.archiveRoot, `IMMUTABLE_SNAPSHOT_SIGNATURE_${NOW.getTime()}_${latestToken}.json`),
    '{}\n',
    { mode: 0o444 },
  );
  const selected = select(selectedFixture);
  assert.equal(selected.candidateName, latestName);
  assert.deepEqual(selected.blockers, ['legacy_immutable_snapshot_candidate_json_invalid']);
});

test('a valid timestamped v2 receipt supersedes audit-only v1 history', (t) => {
  const selectedFixture = fixture(t);
  const legacyToken = 'a'.repeat(64);
  fs.writeFileSync(
    path.join(selectedFixture.archiveRoot, `IMMUTABLE_SNAPSHOT_RECEIPT_${legacyToken}.json`),
    '{"version":1}\n',
    { mode: 0o444 },
  );
  fs.writeFileSync(
    path.join(selectedFixture.archiveRoot, `IMMUTABLE_SNAPSHOT_SIGNATURE_${legacyToken}.json`),
    '{}\n',
    { mode: 0o444 },
  );
  const current = buildSignedDocument(selectedFixture);
  const names = writeDocument(selectedFixture, current);
  const selected = select(selectedFixture);
  assert.equal(selected.status, 'legacy_immutable_snapshot_current_evidence_verified');
  assert.equal(selected.candidateName, names.receiptName);
});

test('receipt and signature filenames are bound to timestamp and semantic hash', (t) => {
  const selectedFixture = fixture(t);
  const document = buildSignedDocument(selectedFixture);
  const token = document.receipt.immutableSnapshotReceiptHash.slice('sha256:'.length);
  const mismatchedTimestamp = NOW.getTime() + 1;
  writeDocument(selectedFixture, document, {
    receiptName: `IMMUTABLE_SNAPSHOT_RECEIPT_${mismatchedTimestamp}_${token}.json`,
    signatureName: `IMMUTABLE_SNAPSHOT_SIGNATURE_${mismatchedTimestamp}_${token}.json`,
  });
  const selected = select(selectedFixture);
  assert.ok(selected.blockers.includes('legacy_immutable_snapshot_filename_binding_mismatch'));
  assert.ok(selected.blockers.includes(
    'legacy_immutable_snapshot_signature_filename_binding_mismatch',
  ));
});

test('execute path atomically publishes a selectable receipt pair without touching live roots', (t) => {
  const selectedFixture = fixture(t);
  const legacyRoot = path.join(selectedFixture.root, 'legacy-live');
  fs.mkdirSync(legacyRoot);
  const captureReleaseState = ({ expectedSnapshotHash = null } = {}) => {
    if (expectedSnapshotHash !== null) {
      assert.equal(
        expectedSnapshotHash,
        selectedFixture.releaseStateSnapshot.workspaceReleaseStateSnapshotHash,
      );
    }
    return selectedFixture.releaseStateSnapshot;
  };
  const captureCodeProvenance = () => selectedFixture.codeProvenance;
  const result = attestLegacyImmutableSnapshot({
    archivePath: selectedFixture.archivePath,
    runtimeRoot: selectedFixture.runtimeRoot,
    legacyRoot,
    workspaceRoot: selectedFixture.root,
    referenceVersion: selectedFixture.codeProvenance.packageVersion,
    now: NOW,
    spawnSyncImpl: immutableLsattr,
    captureReleaseState,
    captureCodeProvenance,
    environment: NON_ISOLATED_TEST_ENVIRONMENT,
  });
  assert.equal(result.receipt.version, 2);
  assert.equal(result.immutableCommand.attempted, false);
  assert.equal(result.externalActionPerformed, false);
  assert.equal(fs.existsSync(result.receiptPath), true);
  assert.equal(fs.existsSync(result.signaturePath), true);
  assert.equal(
    fs.existsSync(path.join(selectedFixture.archiveRoot, 'CURRENT_IMMUTABLE_SNAPSHOT.json')),
    true,
  );
  const selected = select(selectedFixture);
  assert.equal(selected.status, 'legacy_immutable_snapshot_current_evidence_verified');
  assert.equal(selected.receiptHash, result.receipt.immutableSnapshotReceiptHash);
});

test('attestation rejects an arbitrary absolute archive before chattr or publication', (t) => {
  const selectedFixture = fixture(t);
  const legacyRoot = path.join(selectedFixture.root, 'legacy-live');
  fs.mkdirSync(legacyRoot);
  assert.equal(expectedLegacyImmutableArchivePath({
    legacyRoot,
    referenceVersion: selectedFixture.codeProvenance.packageVersion,
  }), selectedFixture.archivePath);
  const arbitraryRoot = path.join(selectedFixture.root, 'arbitrary');
  const arbitraryArchive = path.join(arbitraryRoot, 'victim.bin');
  fs.mkdirSync(arbitraryRoot);
  fs.writeFileSync(arbitraryArchive, 'must remain mutable and unchanged\n', { mode: 0o600 });
  const beforeNames = fs.readdirSync(selectedFixture.archiveRoot).sort();
  let commandCount = 0;
  assert.throws(
    () => attestLegacyImmutableSnapshot({
      archivePath: arbitraryArchive,
      runtimeRoot: selectedFixture.runtimeRoot,
      legacyRoot,
      workspaceRoot: selectedFixture.root,
      referenceVersion: selectedFixture.codeProvenance.packageVersion,
      now: NOW,
      spawnSyncImpl: () => {
        commandCount += 1;
        throw new Error('must not execute');
      },
      captureReleaseState: () => selectedFixture.releaseStateSnapshot,
      captureCodeProvenance: () => selectedFixture.codeProvenance,
      environment: NON_ISOLATED_TEST_ENVIRONMENT,
    }),
    /legacy_immutable_snapshot_archive_path_outside_expected_target/,
  );
  assert.equal(commandCount, 0);
  assert.equal(fs.readFileSync(arbitraryArchive, 'utf8'), 'must remain mutable and unchanged\n');
  assert.equal(fs.statSync(arbitraryArchive).mode & 0o7777, 0o600);
  assert.deepEqual(fs.readdirSync(selectedFixture.archiveRoot).sort(), beforeNames);
});

test('symlinked receipt or signature and a mutable current archive are rejected', async (t) => {
  await t.test('symlinked receipt', (subtest) => {
    const selectedFixture = fixture(subtest);
    const document = buildSignedDocument(selectedFixture);
    const names = documentNames(document);
    const external = path.join(selectedFixture.root, 'external-receipt.json');
    fs.writeFileSync(external, `${JSON.stringify(document.receipt)}\n`);
    fs.symlinkSync(external, path.join(selectedFixture.archiveRoot, names.receiptName));
    fs.writeFileSync(
      path.join(selectedFixture.archiveRoot, names.signatureName),
      `${JSON.stringify(document.signature)}\n`,
      { mode: 0o444 },
    );
    assert.deepEqual(select(selectedFixture).blockers, ['legacy_immutable_snapshot_candidate_file_unsafe']);
    assert.equal(fs.readFileSync(external, 'utf8'), `${JSON.stringify(document.receipt)}\n`);
  });
  await t.test('mutable archive', (subtest) => {
    const selectedFixture = fixture(subtest);
    writeDocument(selectedFixture, buildSignedDocument(selectedFixture));
    const selected = select(selectedFixture, { spawnSyncImpl: mutableLsattr });
    assert.ok(selected.blockers.includes(
      'legacy_immutable_snapshot_archive_identity_or_immutable_state_mismatch',
    ));
  });
  await t.test('symlinked signature', (subtest) => {
    const selectedFixture = fixture(subtest);
    const document = buildSignedDocument(selectedFixture);
    const names = documentNames(document);
    fs.writeFileSync(
      path.join(selectedFixture.archiveRoot, names.receiptName),
      `${JSON.stringify(document.receipt)}\n`,
      { mode: 0o444 },
    );
    const external = path.join(selectedFixture.root, 'external-signature.json');
    fs.writeFileSync(external, `${JSON.stringify(document.signature)}\n`);
    fs.symlinkSync(external, path.join(selectedFixture.archiveRoot, names.signatureName));
    assert.deepEqual(select(selectedFixture).blockers, ['legacy_immutable_snapshot_signature_file_unsafe']);
    assert.equal(fs.readFileSync(external, 'utf8'), `${JSON.stringify(document.signature)}\n`);
  });
});

test('archive inspection detects path replacement during immutable-flag inspection', (t) => {
  const selectedFixture = fixture(t);
  writeDocument(selectedFixture, buildSignedDocument(selectedFixture));
  let swapped = false;
  const replacingLsattr = (command, args) => {
    assert.equal(command, 'lsattr');
    if (!swapped) {
      swapped = true;
      const displaced = `${selectedFixture.archivePath}.displaced`;
      fs.renameSync(selectedFixture.archivePath, displaced);
      fs.writeFileSync(selectedFixture.archivePath, 'concurrent replacement\n', { mode: 0o444 });
    }
    return { status: 0, stdout: `----i----------------- ${args.at(-1)}\n` };
  };
  const selected = select(selectedFixture, { spawnSyncImpl: replacingLsattr });
  assert.deepEqual(selected.blockers, ['legacy_immutable_snapshot_current_archive_unsafe']);
  assert.equal(fs.readFileSync(selectedFixture.archivePath, 'utf8'), 'concurrent replacement\n');
  assert.equal(
    fs.readFileSync(`${selectedFixture.archivePath}.displaced`, 'utf8'),
    'immutable legacy archive bytes\n',
  );
});

test('legacy immutable CLI import, default, help, and invalid arguments perform zero writes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-immutable-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime-must-remain-absent');
  const environment = {
    ...process.env,
    HEPTA_PAPER_RUNTIME_ROOT: runtimeRoot,
  };
  const script = path.join(workspaceRoot, 'paper-core', 'bin', 'legacy-immutable-snapshot.mjs');
  const imported = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `await import(${JSON.stringify(new URL(`file://${script}`).href)})`],
    { cwd: workspaceRoot, env: environment, encoding: 'utf8' },
  );
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  for (const args of [[], ['--help']]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: workspaceRoot,
      env: environment,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(runtimeRoot), false);
  }
  const invalid = spawnSync(process.execPath, [script, '--bogus'], {
    cwd: workspaceRoot,
    env: environment,
    encoding: 'utf8',
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /unknown_cli_option:--bogus/u);
  assert.equal(fs.existsSync(runtimeRoot), false);
  assert.throws(
    () => parseLegacyImmutableSnapshotArguments(['--version=../../escape']),
    /legacy_immutable_snapshot_version_invalid/u,
  );
});
