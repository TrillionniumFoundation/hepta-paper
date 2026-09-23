import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import {
  copyVerifiedSealedPackageOutputFilesForHandoff,
  exportSubmissionHandoffBundle,
  verifySubmissionHandoffBundle,
} from '../../paper-adapters/submission/handoff-bundle-exporter.mjs';
import {
  createSubmissionHandoffBundlePublication,
  publishSubmissionHandoffBundle,
} from '../../paper-adapters/submission/handoff-bundle-publication-repository.mjs';
import { sealAndVerifySubmissionHandoffBundleSync } from '../../paper-adapters/submission/handoff-bundle-integrity.mjs';
import { submissionHandoffBundleStagingNamePattern } from '../../paper-adapters/submission/handoff-bundle-staging-namespace.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { buildSealedSubmissionHandoffPackageFixture as sealedPackageFixture, rehashSealedSubmissionHandoffPackageOutput as rehashPackageOutput } from './support/submission-handoff-sealed-package-fixture.mjs';
function sha256(bytes) { return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`; }
function restoreOwnerWrite(candidate) {
  let stat;
  try {
    stat = fs.lstatSync(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) return;
  fs.chmodSync(candidate, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(candidate)) {
      restoreOwnerWrite(path.join(candidate, name));
    }
  }
}
function artifactRepository(root, label = 'handoff') {
  return createFilesystemArtifactRepository({
    scopeRoot: root,
    casRoot: path.join(root, `.cas-${label}`),
    receiptLedger: { record: () => ({ receiptId: `ledger-${label}` }) },
    clock: {
      now: () => new Date('2026-07-13T00:00:00.000Z'),
      nowIso: () => '2026-07-13T00:00:00.000Z',
    },
  });
}
function portableTree(root) {
  const files = [];
  const directories = [];
  const visit = (candidate, relative = '') => {
    const stat = fs.lstatSync(candidate);
    if (stat.isDirectory()) {
      if (relative) directories.push(relative);
      for (const name of fs.readdirSync(candidate).sort()) {
        visit(path.join(candidate, name), relative ? `${relative}/${name}` : name);
      }
    } else {
      files.push(relative);
    }
  };
  visit(root);
  return { files, directories };
}
function overrideWriteBytes(repository, writeBytes) { return Object.freeze({ ...repository, writeBytes }); }
async function withManifestLinkMutation(mutate, operation) {
  const originalLinkSync = fs.linkSync;
  let mutated = false;
  fs.linkSync = (source, target, ...rest) => {
    const result = originalLinkSync(source, target, ...rest);
    if (!mutated
      && path.basename(String(target)) === 'SUBMISSION_HANDOFF_MANIFEST.json') {
      mutated = true;
      const stagingRoot = fs.realpathSync.native(path.dirname(String(target)));
      mutate({ originalLinkSync, stagingRoot, target: String(target) });
    }
    return result;
  };
  try {
    const result = await operation();
    assert.equal(mutated, true, 'manifest link mutation hook was not reached');
    return result;
  } finally {
    fs.linkSync = originalLinkSync;
  }
}
function stagingResidues(parent, finalName) {
  const pattern = submissionHandoffBundleStagingNamePattern(path.join(parent, finalName));
  return fs.readdirSync(parent).filter((name) => pattern.test(
    name.endsWith('.owner.json') ? name.slice(0, -11) : name));
}
function basicReadyHandoffInput(sourceRoot, content) {
  const packageVerificationReceipt = {
    status: 'package_verification_passed',
    verifiedArtifactPackageHash: 'sha256:candidate',
    packageVerificationReceiptHash: 'sha256:verification',
  };
  const artifactPackage = {
    submitReady: true,
    artifactPackageHash: 'sha256:package',
    candidateArtifactPackageHash: 'sha256:candidate',
    packageVerificationReceiptHash:
      packageVerificationReceipt.packageVerificationReceiptHash,
    artifacts: [{
      id: 'pdf',
      role: 'manuscript',
      path: 'paper.pdf',
      hash: sha256(content),
    }],
  };
  const manifest = {
    status: 'ready_for_adapter',
    paperId: 'paper',
    taskKey: 'paper:paper',
    manifestHash: 'sha256:manifest',
    payload: { artifactPackageHash: artifactPackage.artifactPackageHash },
  };
  const handoff = {
    status: 'dry_run_ready',
    envelopeHash: 'sha256:handoff',
    manifestHash: manifest.manifestHash,
  };
  const replayGuard = {
    status: 'dry_run_replay_allowed',
    submissionReplayGuardHash: 'sha256:replay',
    manifestHash: manifest.manifestHash,
  };
  const reviewedSubmitPreflightPacket = {
    status: 'reviewed_submit_preflight_ready_for_external_executor',
    reviewedSubmitPreflightPacketHash: 'sha256:preflight',
    outboxHash: 'sha256:outbox',
  };
  const dispatchAuthorization = {
    status: 'submission_dispatch_authorization_ready',
    submissionDispatchAuthorizationHash: 'sha256:dispatch',
    artifactPackageHash: artifactPackage.artifactPackageHash,
    preflightHash:
      reviewedSubmitPreflightPacket.reviewedSubmitPreflightPacketHash,
    outboxHash: reviewedSubmitPreflightPacket.outboxHash,
    provider: 'provider',
    accountId: 'account',
    nonce: 'nonce',
    reviewedSubmissionDecisionPacketHash: 'sha256:decision',
  };
  const submissionDecisionPacket = {
    status: 'reviewed_submission_decision_verified',
    reviewedSubmissionDecisionPacketHash: 'sha256:decision',
    metadata: { title: 'Fixture' },
  };
  return Object.freeze({
    artifactPackage,
    packageVerificationReceipt,
    manifest,
    handoff,
    replayGuard,
    reviewedSubmitPreflightPacket,
    dispatchAuthorization,
    submissionDecisionPacket,
    artifactBaseRoot: sourceRoot,
  });
}
function persistedSubmissionAuthorityFixture({
  dispatchAuthorizationHash,
  observedAt = '2026-07-13T00:00:00.000Z',
  rowBindingHash = sha256('authority-row-binding'),
} = {}) {
  const payload = {
    version: 1,
    kind: 'PersistedSubmissionHandoffExportAuthority',
    status: 'submission_handoff_export_authority_ready',
    messageId: 'message-authority-fixture',
    paperId: 'paper',
    dispatchAuthorizationHash,
    rowBindingHash,
    authorizationConsumptionHash: sha256('authority-consumption'),
    releaseLockHash: sha256('authority-release-lock'),
    payloadBindingHash: sha256('authority-payload-binding'),
    providerCapabilityHash: sha256('authority-provider-capability'),
    providerCapabilityValidFrom: '2026-07-12T00:00:00.000Z',
    providerCapabilityExpiresAt: '2026-07-15T00:00:00.000Z',
    responseCount: 0,
    deadLetterCount: 0,
    observedAt,
    blockers: [],
    readOnly: true,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    submissionHandoffExportAuthorityHash: hashRecord(
      'PersistedSubmissionHandoffExportAuthority',
      payload,
    ),
  });
}
test('submission handoff exporter creates a portable hash-bound artifact bundle', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hepta-handoff-bundle-'));
  t.after(() => {
    restoreOwnerWrite(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sourceRoot = path.join(root, 'source');
  const bundleRoot = path.join(root, 'bundle');
  await fsp.mkdir(sourceRoot);
  const content = Buffer.from('%PDF-fixture\n');
  await fsp.writeFile(path.join(sourceRoot, 'paper.pdf'), content);
  const repository = createFilesystemArtifactRepository({
    scopeRoot: root,
    receiptLedger: { record: () => ({ receiptId: 'ledger-receipt' }) },
    clock: { now: () => new Date('2026-07-13T00:00:00.000Z'), nowIso: () => '2026-07-13T00:00:00.000Z' },
  });
  const packageVerificationReceipt = { status: 'package_verification_passed', verifiedArtifactPackageHash: 'sha256:candidate', packageVerificationReceiptHash: 'sha256:verification' };
  const artifactPackage = {
    submitReady: true,
    artifactPackageHash: 'sha256:package',
    candidateArtifactPackageHash: 'sha256:candidate',
    packageVerificationReceiptHash: packageVerificationReceipt.packageVerificationReceiptHash,
    artifacts: [{ id: 'pdf', role: 'manuscript', path: 'paper.pdf', hash: sha256(content) }],
  };
  const manifest = { status: 'ready_for_adapter', paperId: 'paper', taskKey: 'paper:paper', manifestHash: 'sha256:manifest', payload: { artifactPackageHash: artifactPackage.artifactPackageHash } };
  const handoff = { status: 'dry_run_ready', envelopeHash: 'sha256:handoff', manifestHash: manifest.manifestHash };
  const replayGuard = { status: 'dry_run_replay_allowed', submissionReplayGuardHash: 'sha256:replay', manifestHash: manifest.manifestHash };
  const reviewedSubmitPreflightPacket = { status: 'reviewed_submit_preflight_ready_for_external_executor', reviewedSubmitPreflightPacketHash: 'sha256:preflight', outboxHash: 'sha256:outbox' };
  const dispatchAuthorization = { status: 'submission_dispatch_authorization_ready', submissionDispatchAuthorizationHash: 'sha256:dispatch', artifactPackageHash: artifactPackage.artifactPackageHash, preflightHash: reviewedSubmitPreflightPacket.reviewedSubmitPreflightPacketHash, outboxHash: reviewedSubmitPreflightPacket.outboxHash, provider: 'provider', accountId: 'account', nonce: 'nonce' };
  const submissionDecisionPacket = { status: 'reviewed_submission_decision_verified', reviewedSubmissionDecisionPacketHash: 'sha256:decision', metadata: { title: 'Fixture' } };
  dispatchAuthorization.reviewedSubmissionDecisionPacketHash = submissionDecisionPacket.reviewedSubmissionDecisionPacketHash;
  const readyInput = {
    artifactPackage,
    packageVerificationReceipt,
    manifest,
    handoff,
    replayGuard,
    reviewedSubmitPreflightPacket,
    dispatchAuthorization,
    submissionDecisionPacket,
    artifactBaseRoot: sourceRoot,
  };
  const receipt = await exportSubmissionHandoffBundle({
    ...readyInput,
    artifactRepository: repository,
    bundleRoot,
  });
  assert.equal(receipt.status, 'submission_handoff_bundle_exported');
  assert.equal(receipt.artifactCount, 1);
  assert.deepEqual(await fsp.readFile(path.join(bundleRoot, 'artifacts', '001-paper.pdf')), content);
  const bundleManifest = JSON.parse(await fsp.readFile(path.join(bundleRoot, 'SUBMISSION_HANDOFF_MANIFEST.json'), 'utf8'));
  assert.equal(bundleManifest.dispatchAuthorizationHash, dispatchAuthorization.submissionDispatchAuthorizationHash);
  assert.equal(bundleManifest.artifacts[0].hash, sha256(content));
  assert.equal(bundleManifest.persistedSubmissionAuthority, null);
  assert.equal(bundleManifest.grantsExternalExecutionPermission, false);
  assert.equal(bundleManifest.requiresCurrentAuthorityRevalidation, true);
  const verified = verifySubmissionHandoffBundle({
    bundleRoot,
    submissionHandoffBundleManifestHash:
      receipt.submissionHandoffBundleManifestHash,
  });
  assert.equal(verified.status, 'submission_handoff_bundle_verified');
  const transferredRoot = path.join(root, 'transferred-bundle');
  fs.cpSync(bundleRoot, transferredRoot, { recursive: true });
  sealAndVerifySubmissionHandoffBundleSync({
    bundleRoot: transferredRoot,
    manifestDocument: JSON.parse(fs.readFileSync(
      path.join(transferredRoot, 'SUBMISSION_HANDOFF_MANIFEST.json'),
      'utf8',
    )),
  });
  const transferred = verifySubmissionHandoffBundle({
    bundleRoot: transferredRoot,
    submissionHandoffBundleManifestHash:
      receipt.submissionHandoffBundleManifestHash,
  });
  assert.equal(
    transferred.status,
    'submission_handoff_bundle_verified',
    JSON.stringify(transferred.blockers),
  );
  for (const candidate of [
    bundleRoot,
    path.join(bundleRoot, 'artifacts'),
    path.join(bundleRoot, 'artifacts', '001-paper.pdf'),
    path.join(bundleRoot, 'SUBMISSION_HANDOFF_MANIFEST.json'),
  ]) {
    assert.equal(fs.lstatSync(candidate).mode & 0o222, 0, candidate);
  }
  const blocked = await exportSubmissionHandoffBundle({
    ...readyInput,
    artifactRepository: repository,
    bundleRoot: path.join(root, 'blocked'),
    artifactPackage: {
      ...artifactPackage,
      artifacts: [{ ...artifactPackage.artifacts[0], hash: 'sha256:wrong' }],
    },
  });
  assert.equal(blocked.status, 'submission_handoff_bundle_blocked');
  assert.ok(blocked.blockers.includes('handoff_artifact_hash_mismatch:paper.pdf'));
  assert.equal(fs.existsSync(path.join(root, 'blocked')), false);
  let tampered = false;
  const tamperingRepository = overrideWriteBytes(
    repository,
    async (target, value, options) => {
      if (!tampered && options.role.startsWith('submission_handoff:')) {
        tampered = true;
        return repository.writeBytes(
          target,
          Buffer.concat([Buffer.from(value), Buffer.from('tampered')]),
          options,
        );
      }
      return repository.writeBytes(target, value, options);
    },
  );
  const isolatedCopy = await exportSubmissionHandoffBundle({
    ...readyInput,
    artifactRepository: tamperingRepository,
    bundleRoot: path.join(root, 'tampered-copy'),
  });
  assert.equal(isolatedCopy.status, 'submission_handoff_bundle_exported');
  assert.equal(tampered, false);
  assert.equal(isolatedCopy.localFilesystemMutationPerformed, true);
  assert.equal(isolatedCopy.externalActionPerformed, false);
  assert.equal(
    sha256(fs.readFileSync(path.join(
      root,
      'tampered-copy',
      'artifacts',
      '001-paper.pdf',
    ))),
    sha256(content),
  );
});

test('submission handoff bundle rejects manifest and whole-tree attacks', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hepta-handoff-integrity-'));
  t.after(() => {
    restoreOwnerWrite(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sourceRoot = path.join(root, 'source');
  fs.mkdirSync(sourceRoot, { mode: 0o700 });
  const content = Buffer.from('%PDF-integrity-fixture\n');
  fs.writeFileSync(path.join(sourceRoot, 'paper.pdf'), content, { mode: 0o600 });
  const readyInput = basicReadyHandoffInput(sourceRoot, content);

  await t.test('invalid authority bindings block before root reservation', async () => {
    const receipt = await exportSubmissionHandoffBundle({
      artifactRepository: artifactRepository(root, 'invalid-authority'),
      artifactPackage: {
        submitReady: false,
        artifactPackageHash: 'sha256:package-a',
        candidateArtifactPackageHash: 'sha256:candidate-a',
        packageVerificationReceiptHash: 'sha256:verification-a',
        artifacts: [],
      },
      packageVerificationReceipt: {
        status: 'blocked',
        verifiedArtifactPackageHash: 'sha256:candidate-b',
        packageVerificationReceiptHash: 'sha256:verification-b',
      },
      manifest: {
        status: 'blocked',
        paperId: 'paper',
        manifestHash: 'sha256:manifest-a',
        payload: { artifactPackageHash: 'sha256:package-b' },
      },
      handoff: { status: 'blocked', manifestHash: 'sha256:manifest-b' },
      replayGuard: { status: 'blocked', manifestHash: 'sha256:manifest-c' },
      reviewedSubmitPreflightPacket: {
        status: 'blocked',
        reviewedSubmitPreflightPacketHash: 'sha256:preflight-a',
        outboxHash: 'sha256:outbox-a',
      },
      dispatchAuthorization: {
        status: 'blocked',
        artifactPackageHash: 'sha256:package-b',
        preflightHash: 'sha256:preflight-b',
        outboxHash: 'sha256:outbox-b',
        reviewedSubmissionDecisionPacketHash: 'sha256:decision-a',
      },
      submissionDecisionPacket: {
        status: 'blocked',
        reviewedSubmissionDecisionPacketHash: 'sha256:decision-b',
      },
      artifactBaseRoot: sourceRoot,
    });
    assert.equal(receipt.status, 'submission_handoff_bundle_blocked');
    assert.ok(receipt.blockers.length >= 16);
    assert.equal(receipt.externalActionPerformed, false);
  });

  await t.test('invalid artifact descriptors block before root reservation', async () => {
    const bundleRoot = path.join(root, 'invalid-artifact-bundle');
    const receipt = await exportSubmissionHandoffBundle({
      ...readyInput,
      artifactRepository: artifactRepository(root, 'invalid-artifact'),
      bundleRoot,
      artifactPackage: {
        ...readyInput.artifactPackage,
        artifacts: [
          { id: 'missing-binding' },
          {
            id: 'outside',
            path: path.join(root, '..', 'outside-paper.pdf'),
            hash: sha256('outside'),
          },
          { id: 'missing', path: 'missing.pdf', hash: sha256('missing') },
          { ...readyInput.artifactPackage.artifacts[0], sizeBytes: content.length + 1 },
        ],
      },
    });
    assert.equal(receipt.status, 'submission_handoff_bundle_blocked');
    assert.equal(receipt.blockers.some((blocker) => blocker.startsWith(
      'handoff_artifact_binding_missing:',
    )), true);
    assert.equal(receipt.blockers.some((blocker) => blocker.startsWith(
      'handoff_artifact_outside_scope:',
    )), true);
    assert.equal(receipt.blockers.some((blocker) => blocker.startsWith(
      'handoff_artifact_read_blocked:',
    )), true);
    assert.equal(receipt.blockers.some((blocker) => blocker.startsWith(
      'handoff_artifact_size_mismatch:',
    )), true);
    assert.equal(fs.existsSync(bundleRoot), false);
  });

  await t.test('reservation stays inside repository scope and outside CAS', async () => {
    const repositoryScope = path.join(root, 'repository-scope');
    fs.mkdirSync(repositoryScope, { mode: 0o700 });
    const repository = artifactRepository(repositoryScope, 'reservation-scope');
    for (const bundleRoot of [
      path.join(root, 'absolute-scope-escape'),
      path.join(repositoryScope, '..', 'relative-scope-escape'),
      path.join(repository.casRoot, 'bundle-inside-cas'),
    ]) {
      const receipt = await exportSubmissionHandoffBundle({
        ...readyInput,
        artifactRepository: repository,
        bundleRoot,
      });
      assert.equal(receipt.status, 'submission_handoff_bundle_blocked');
      assert.match(
        receipt.blockers[0],
        /handoff_bundle_root_(?:outside_repository_scope|overlaps_repository_cas)/,
      );
      assert.equal(fs.existsSync(path.resolve(bundleRoot)), false);
    }

    const packageOutput = sealedPackageFixture(path.join(root, 'copy-scope-source'));
    const copyEscape = path.join(root, 'copy-helper-scope-escape');
    await assert.rejects(
      copyVerifiedSealedPackageOutputFilesForHandoff({
        artifactRepository: repository,
        bundleRoot: copyEscape,
        packageOutput,
        runtimeRoot: root,
      }),
      /handoff_bundle_root_outside_repository_scope/,
    );
    assert.equal(fs.existsSync(copyEscape), false);
  });

  await t.test('reservation rejects a parent identity exchange without escaping', async () => {
    const repositoryScope = path.join(root, 'parent-swap-scope');
    const reservationParent = path.join(repositoryScope, 'handoff-parent');
    const movedParent = path.join(repositoryScope, 'handoff-parent-original');
    const outsideParent = path.join(root, 'parent-swap-outside');
    const bundleRoot = path.join(reservationParent, 'bundle');
    fs.mkdirSync(reservationParent, { recursive: true, mode: 0o700 });
    const repository = artifactRepository(repositoryScope, 'parent-swap');
    const originalMkdirSync = fs.mkdirSync;
    let swapped = false;
    fs.mkdirSync = (candidate, options) => {
      if (!swapped && String(candidate).startsWith('/proc/self/fd/')) {
        swapped = true;
        fs.renameSync(reservationParent, movedParent);
        originalMkdirSync(outsideParent, { mode: 0o700 });
        fs.symlinkSync(outsideParent, reservationParent, 'dir');
      }
      return originalMkdirSync(candidate, options);
    };
    let receipt;
    try {
      receipt = await exportSubmissionHandoffBundle({
        ...readyInput,
        artifactRepository: repository,
        bundleRoot,
      });
      assert.equal(receipt.status, 'submission_handoff_bundle_blocked');
      assert.deepEqual(receipt.blockers, [
        'handoff_bundle_publication_reservation_invalid:'
          + 'handoff_bundle_root_parent_identity_changed',
      ]);
      assert.equal(fs.existsSync(path.join(outsideParent, 'bundle')), false);
      assert.equal(fs.existsSync(path.join(movedParent, 'bundle')), false);
    } finally {
      fs.mkdirSync = originalMkdirSync;
      if (fs.lstatSync(reservationParent).isSymbolicLink()) {
        fs.rmSync(reservationParent);
        fs.renameSync(movedParent, reservationParent);
      }
    }
    assert.equal(swapped, true);
    assert.equal(receipt.localFilesystemMutationPerformed, true);
    assert.equal(receipt.externalActionPerformed, false);
  });

  await t.test('preexisting roots are never reused', async () => {
    for (const [label, setup] of [
      ['empty', () => {}],
      ['root-extra', (candidate) => fs.writeFileSync(
        path.join(candidate, 'UNDECLARED'),
        'extra',
      )],
      ['artifacts-extra', (candidate) => {
        fs.mkdirSync(path.join(candidate, 'artifacts'));
        fs.writeFileSync(path.join(candidate, 'artifacts', 'UNDECLARED'), 'extra');
      }],
    ]) {
      const bundleRoot = path.join(root, `preexisting-${label}`);
      fs.mkdirSync(bundleRoot, { mode: 0o700 });
      setup(bundleRoot);
      const receipt = await exportSubmissionHandoffBundle({
        ...readyInput,
        artifactRepository: artifactRepository(root, `preexisting-${label}`),
        bundleRoot,
      });
      assert.equal(receipt.status, 'submission_handoff_bundle_blocked');
      assert.deepEqual(receipt.blockers, ['handoff_bundle_preexisting_collision']);
      assert.equal(receipt.localFilesystemMutationPerformed, false);
      assert.equal(receipt.externalActionPerformed, false);
      assert.equal(
        fs.existsSync(path.join(bundleRoot, 'SUBMISSION_HANDOFF_MANIFEST.json')),
        false,
      );
    }
  });

  await t.test('generic repository cannot replace deterministic manifest bytes', async () => {
    const base = artifactRepository(root, 'wrong-manifest');
    let invoked = false;
    const repository = Object.freeze({
      ...base,
      writeJson: (target, value, options) => {
        invoked = true;
        return base.writeJson(target, {
          ...value,
          provider: 'attacker',
        }, options);
      },
    });
    const receipt = await exportSubmissionHandoffBundle({
      ...readyInput,
      artifactRepository: repository,
      bundleRoot: path.join(root, 'wrong-manifest-bundle'),
    });
    assert.equal(receipt.status, 'submission_handoff_bundle_exported');
    assert.equal(invoked, false);
    const document = JSON.parse(fs.readFileSync(
      path.join(receipt.bundleRoot, 'SUBMISSION_HANDOFF_MANIFEST.json'),
      'utf8',
    ));
    assert.equal(document.provider, 'provider');
  });

  await t.test('manifest write is reread before it is trusted', async () => {
    const bundleRoot = path.join(root, 'manifest-tamper-bundle');
    const receipt = await withManifestLinkMutation(
      ({ target }) => {
        fs.chmodSync(target, 0o644);
        fs.appendFileSync(target, 'manifest-write-tamper');
      },
      () => exportSubmissionHandoffBundle({
        ...readyInput,
        artifactRepository: artifactRepository(root, 'manifest-tamper'),
        bundleRoot,
      }),
    );
    assert.equal(receipt.status, 'submission_handoff_bundle_blocked');
    assert.ok(receipt.blockers.some((blocker) => blocker.startsWith(
      'handoff_manifest_write_invalid:handoff_bundle_writer_target_identity_invalid',
    )));
    assert.equal(fs.existsSync(bundleRoot), false);
  });

  for (const attack of [
    'root-extra',
    'artifacts-extra',
    'symlink',
    'hardlink',
    'special-file',
    'depth-limit',
    'file-size-limit',
  ]) {
    await t.test(`post-manifest ${attack}`, async () => {
      const bundleRoot = path.join(root, `post-manifest-${attack}-bundle`);
      const receipt = await withManifestLinkMutation(
        ({ originalLinkSync, stagingRoot }) => {
          if (attack === 'root-extra') {
            fs.writeFileSync(path.join(stagingRoot, 'UNDECLARED'), 'extra');
          } else if (attack === 'artifacts-extra') {
            fs.writeFileSync(
              path.join(stagingRoot, 'artifacts', 'UNDECLARED'),
              'extra',
            );
          } else if (attack === 'symlink') {
            fs.symlinkSync(
              path.join(sourceRoot, 'paper.pdf'),
              path.join(stagingRoot, 'UNDECLARED'),
            );
          } else if (attack === 'hardlink') {
            originalLinkSync(
              path.join(stagingRoot, 'artifacts', '001-paper.pdf'),
              path.join(stagingRoot, 'UNDECLARED'),
            );
          } else if (attack === 'special-file') {
            const created = spawnSync('mkfifo', [
              path.join(stagingRoot, 'UNDECLARED'),
            ]);
            assert.equal(created.status, 0, created.stderr?.toString('utf8'));
          } else if (attack === 'depth-limit') {
            let cursor = stagingRoot;
            for (let index = 0; index < 33; index += 1) {
              cursor = path.join(cursor, `depth-${index}`);
              fs.mkdirSync(cursor);
            }
            fs.writeFileSync(path.join(cursor, 'UNDECLARED'), 'extra');
          } else {
            const descriptor = fs.openSync(
              path.join(stagingRoot, 'UNDECLARED'),
              'w',
              0o600,
            );
            try {
              fs.ftruncateSync(descriptor, 256 * 1024 * 1024 + 1);
            } finally {
              fs.closeSync(descriptor);
            }
          }
        },
        () => exportSubmissionHandoffBundle({
          ...readyInput,
          artifactRepository: artifactRepository(root, `post-manifest-${attack}`),
          bundleRoot,
        }),
      );
      assert.equal(receipt.status, 'submission_handoff_bundle_blocked');
      assert.ok(receipt.blockers.some((blocker) => blocker.startsWith(
        'handoff_bundle_sealing_invalid:',
      )));
      assert.equal(receipt.localFilesystemMutationPerformed, true);
      assert.equal(receipt.externalActionPerformed, false);
      assert.equal(fs.existsSync(bundleRoot), false);
    });
  }

  await t.test('write and seal failures leave final absent for same-root retry', async () => {
    for (const failure of ['write', 'seal']) {
      const bundleRoot = path.join(root, `${failure}-retry-bundle`);
      const repository = artifactRepository(root, `${failure}-retry`);
      let failed;
      if (failure === 'write') {
        const originalLinkSync = fs.linkSync;
        let injected = false;
        fs.linkSync = (source, target, ...rest) => {
          if (!injected) {
            injected = true;
            throw new Error('injected_handoff_write_failure');
          }
          return originalLinkSync(source, target, ...rest);
        };
        try {
          failed = await exportSubmissionHandoffBundle({
            ...readyInput, artifactRepository: repository, bundleRoot,
          });
        } finally {
          fs.linkSync = originalLinkSync;
        }
        assert.equal(injected, true);
        assert.ok(failed.blockers.some((blocker) => blocker.includes(
          'injected_handoff_write_failure',
        )));
      } else {
        failed = await withManifestLinkMutation(
          ({ stagingRoot }) => fs.writeFileSync(
            path.join(stagingRoot, 'UNDECLARED'),
            'seal-failure',
          ),
          () => exportSubmissionHandoffBundle({
            ...readyInput, artifactRepository: repository, bundleRoot,
          }),
        );
        assert.ok(failed.blockers.some((blocker) => blocker.startsWith(
          'handoff_bundle_sealing_invalid:',
        )));
      }
      assert.equal(failed.status, 'submission_handoff_bundle_blocked');
      assert.equal(failed.localFilesystemMutationPerformed, true);
      assert.equal(failed.externalActionPerformed, false);
      assert.equal(fs.existsSync(bundleRoot), false);
      assert.deepEqual(stagingResidues(root, path.basename(bundleRoot)), []);

      const retried = await exportSubmissionHandoffBundle({
        ...readyInput, artifactRepository: repository, bundleRoot,
      });
      assert.equal(retried.status, 'submission_handoff_bundle_exported');
      assert.equal(retried.bundleRoot, bundleRoot);
      assert.deepEqual(stagingResidues(root, path.basename(bundleRoot)), []);
    }
  });

  await t.test('stage path exchange cannot redirect pinned writes', async () => {
    const bundleRoot = path.join(root, 'stage-swap-bundle');
    const movedStage = path.join(root, 'stage-swap-original');
    const outside = path.join(root, 'stage-swap-outside');
    fs.mkdirSync(outside, { mode: 0o700 });
    const originalLinkSync = fs.linkSync;
    let swapped = false;
    fs.linkSync = (source, target, ...rest) => {
      if (!swapped) {
        const targetParent = fs.realpathSync.native(path.dirname(String(target)));
        const stagingRoot = path.dirname(targetParent);
        if (path.basename(stagingRoot).includes('.handoff-stage-')) {
          swapped = true;
          fs.renameSync(stagingRoot, movedStage);
          fs.symlinkSync(outside, stagingRoot, 'dir');
        }
      }
      return originalLinkSync(source, target, ...rest);
    };
    let receipt;
    try {
      receipt = await exportSubmissionHandoffBundle({
        ...readyInput,
        artifactRepository: artifactRepository(root, 'stage-swap'),
        bundleRoot,
      });
    } finally {
      fs.linkSync = originalLinkSync;
    }
    assert.equal(swapped, true);
    assert.equal(receipt.status, 'submission_handoff_bundle_blocked');
    assert.equal(receipt.localFilesystemMutationPerformed, true);
    assert.equal(receipt.externalActionPerformed, false);
    assert.equal(fs.existsSync(bundleRoot), false);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.deepEqual(
      fs.readFileSync(path.join(movedStage, 'artifacts', '001-paper.pdf')),
      content,
    );
  });

  await t.test('reservation fchmod is inode-pinned across a path exchange', async () => {
    const bundleRoot = path.join(root, 'fchmod-swap-bundle');
    const movedStage = path.join(root, 'fchmod-swap-original');
    const outside = path.join(root, 'fchmod-swap-outside');
    fs.mkdirSync(outside, { mode: 0o711 });
    const originalFchmodSync = fs.fchmodSync;
    let swapped = false;
    fs.fchmodSync = (descriptor, mode) => {
      if (!swapped) {
        const opened = fs.realpathSync.native(`/proc/self/fd/${descriptor}`);
        if (path.basename(opened).includes('.handoff-stage-')) {
          swapped = true;
          fs.renameSync(opened, movedStage);
          fs.symlinkSync(outside, opened, 'dir');
        }
      }
      return originalFchmodSync(descriptor, mode);
    };
    let receipt;
    try {
      receipt = await exportSubmissionHandoffBundle({
        ...readyInput,
        artifactRepository: artifactRepository(root, 'fchmod-swap'),
        bundleRoot,
      });
    } finally {
      fs.fchmodSync = originalFchmodSync;
    }
    assert.equal(swapped, true);
    assert.equal(receipt.status, 'submission_handoff_bundle_blocked');
    assert.equal(receipt.localFilesystemMutationPerformed, true);
    assert.equal(fs.existsSync(bundleRoot), false);
    assert.equal(fs.lstatSync(outside).mode & 0o777, 0o711);
    assert.equal(fs.lstatSync(movedStage).mode & 0o777, 0o700);
  });

  await t.test('SIGKILL staging residue never occupies final root', async () => {
    const bundleRoot = path.join(root, 'sigkill-retry-bundle');
    const control = path.join(root, 'sigkill-staging-path.txt');
    const repository = artifactRepository(root, 'sigkill-retry');
    const publicationModule = new URL(
      '../../paper-adapters/submission/handoff-bundle-publication-repository.mjs',
      import.meta.url,
    ).href;
    const script = `
      import fs from 'node:fs';
      import { createSubmissionHandoffBundlePublication } from ${JSON.stringify(publicationModule)};
      const publication = createSubmissionHandoffBundlePublication(${JSON.stringify({
    finalRoot: bundleRoot,
    repositoryScopeRoot: root,
    repositoryCasRoot: repository.casRoot,
  })});
      fs.writeFileSync(${JSON.stringify(control)}, publication.stagingRoot);
      process.kill(process.pid, 'SIGKILL');
    `;
    const killed = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      script,
    ]);
    assert.equal(killed.signal, 'SIGKILL');
    const residue = fs.readFileSync(control, 'utf8');
    assert.equal(fs.existsSync(residue), true);
    assert.equal(fs.existsSync(bundleRoot), false);
    const retried = await exportSubmissionHandoffBundle({
      ...readyInput,
      artifactRepository: repository,
      bundleRoot,
    });
    assert.equal(retried.status, 'submission_handoff_bundle_exported');
    assert.equal(fs.existsSync(residue), false);
  });

  await t.test('atomic publication rejects races and forged traversal records', () => {
    const repository = artifactRepository(root, 'publication-race');
    const finalRoot = path.join(root, 'publication-race-final');
    const publication = createSubmissionHandoffBundlePublication({
      finalRoot,
      repositoryScopeRoot: root,
      repositoryCasRoot: repository.casRoot,
    });
    fs.chmodSync(publication.stagingRoot, 0o500);
    let spawned = false;
    const forgedPayload = {
      ...publication,
      stagingName: '../publication-outside',
      stagingRoot: path.join(root, '..', 'publication-outside'),
    };
    delete forgedPayload.submissionHandoffBundlePublicationHash;
    const forged = Object.freeze({
      ...forgedPayload,
      submissionHandoffBundlePublicationHash: hashRecord(
        'SubmissionHandoffBundlePublication',
        forgedPayload,
      ),
    });
    assert.throws(
      () => publishSubmissionHandoffBundle(forged, {
        spawnSyncImpl: () => {
          spawned = true;
          return { status: 0 };
        },
      }),
      /handoff_bundle_publication_record_invalid/,
    );
    assert.equal(spawned, false);

    assert.throws(
      () => publishSubmissionHandoffBundle(publication, {
        spawnSyncImpl: (command, args, options) => {
          spawned = true;
          fs.mkdirSync(finalRoot, { mode: 0o700 });
          fs.writeFileSync(path.join(finalRoot, 'RACE_MARKER'), 'racer');
          return spawnSync(command, args, options);
        },
      }),
      /handoff_bundle_final_preexisting/,
    );
    assert.equal(spawned, true);
    assert.equal(fs.readFileSync(path.join(finalRoot, 'RACE_MARKER'), 'utf8'), 'racer');
    assert.equal(fs.existsSync(publication.stagingRoot), true);
  });

  await t.test('publication fsync failure cannot produce a published receipt', () => {
    const repository = artifactRepository(root, 'publication-fsync');
    const publication = createSubmissionHandoffBundlePublication({
      finalRoot: path.join(root, 'publication-fsync-final'),
      repositoryScopeRoot: root,
      repositoryCasRoot: repository.casRoot,
    });
    fs.chmodSync(publication.stagingRoot, 0o500);
    const originalFsyncSync = fs.fsyncSync;
    fs.fsyncSync = () => {
      throw new Error('injected_parent_fsync_failure');
    };
    try {
      assert.throws(
        () => publishSubmissionHandoffBundle(publication),
        /handoff_bundle_atomic_publication_durability_failed/,
      );
    } finally {
      fs.fsyncSync = originalFsyncSync;
    }
  });

  await t.test('same request safely recovers a rename completed before fsync', async () => {
    const bundleRoot = path.join(root, 'publication-recovery-bundle');
    const repository = artifactRepository(root, 'publication-recovery');
    const originalFsyncSync = fs.fsyncSync;
    let injected = false;
    fs.fsyncSync = (descriptor) => {
      if (!injected && fs.existsSync(bundleRoot)) {
        injected = true;
        throw new Error('injected_post_rename_fsync_failure');
      }
      return originalFsyncSync(descriptor);
    };
    let blocked;
    try {
      blocked = await exportSubmissionHandoffBundle({
        ...readyInput,
        artifactRepository: repository,
        bundleRoot,
      });
    } finally {
      fs.fsyncSync = originalFsyncSync;
    }
    assert.equal(injected, true);
    assert.equal(blocked.status, 'submission_handoff_bundle_blocked');
    assert.ok(blocked.blockers.some((blocker) => blocker.endsWith(
      'handoff_bundle_atomic_publication_durability_failed',
    )));
    assert.equal(blocked.externalActionPerformed, false);
    assert.equal(fs.existsSync(bundleRoot), true);
    const recovered = await exportSubmissionHandoffBundle({
      ...readyInput,
      artifactRepository: repository,
      bundleRoot,
    });
    assert.equal(recovered.status, 'submission_handoff_bundle_exported');
    assert.equal(recovered.recoveredExistingPublication, true);
    assert.equal(recovered.submissionHandoffBundlePublicationReceiptHash, null);
    assert.match(
      recovered.submissionHandoffBundlePublicationRecoveryReceiptHash,
      /^sha256:[0-9a-f]{64}$/u,
    );
    assert.equal(
      recovered.submissionHandoffBundleManifestHash,
      JSON.parse(fs.readFileSync(
        path.join(bundleRoot, 'SUBMISSION_HANDOFF_MANIFEST.json'),
        'utf8',
      )).submissionHandoffBundleManifestHash,
    );

    const mismatched = await exportSubmissionHandoffBundle({
      ...readyInput,
      artifactRepository: repository,
      bundleRoot,
      submissionDecisionPacket: {
        ...readyInput.submissionDecisionPacket,
        metadata: { title: 'Different same-root request' },
      },
    });
    assert.equal(mismatched.status, 'submission_handoff_bundle_blocked');
    assert.deepEqual(mismatched.blockers, [
      'handoff_bundle_preexisting_recovery_invalid:'
        + 'handoff_bundle_publication_journal_binding_mismatch',
    ]);
  });

  await t.test('SIGKILL after rename is idempotently recovered', async () => {
    const bundleRoot = path.join(root, 'post-rename-sigkill-bundle');
    const casRoot = path.join(root, '.cas-post-rename-sigkill');
    const exporterModule = new URL(
      '../../paper-adapters/submission/handoff-bundle-exporter.mjs',
      import.meta.url,
    ).href;
    const repositoryModule = new URL(
      '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs',
      import.meta.url,
    ).href;
    const script = `
      import fs from 'node:fs';
      import { createFilesystemArtifactRepository } from ${JSON.stringify(repositoryModule)};
      import { exportSubmissionHandoffBundle } from ${JSON.stringify(exporterModule)};
      const bundleRoot = ${JSON.stringify(bundleRoot)};
      const originalFsyncSync = fs.fsyncSync;
      fs.fsyncSync = (descriptor) => {
        if (fs.existsSync(bundleRoot)) process.kill(process.pid, 'SIGKILL');
        return originalFsyncSync(descriptor);
      };
      const repository = createFilesystemArtifactRepository({
        scopeRoot: ${JSON.stringify(root)},
        casRoot: ${JSON.stringify(casRoot)},
        receiptLedger: { record: () => ({ receiptId: 'sigkill-ledger' }) },
        clock: {
          now: () => new Date('2026-07-13T00:00:00.000Z'),
          nowIso: () => '2026-07-13T00:00:00.000Z',
        },
      });
      await exportSubmissionHandoffBundle({
        ...${JSON.stringify(readyInput)},
        artifactRepository: repository,
        bundleRoot,
      });
    `;
    const killed = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      script,
    ]);
    assert.equal(killed.signal, 'SIGKILL');
    assert.equal(fs.existsSync(bundleRoot), true);
    const recovered = await exportSubmissionHandoffBundle({
      ...readyInput,
      artifactRepository: artifactRepository(root, 'post-rename-sigkill'),
      bundleRoot,
    });
    assert.equal(recovered.status, 'submission_handoff_bundle_exported');
    assert.equal(recovered.recoveredExistingPublication, true);
    assert.match(
      recovered.submissionHandoffBundlePublicationRecoveryReceiptHash,
      /^sha256:[0-9a-f]{64}$/u,
    );
  });

  await t.test('SIGKILL after terminal journal commit reconstructs success', async () => {
    const bundleRoot = path.join(root, 'terminal-journal-sigkill-bundle');
    const casRoot = path.join(root, '.cas-terminal-journal-sigkill');
    const exporterModule = new URL(
      '../../paper-adapters/submission/handoff-bundle-exporter.mjs',
      import.meta.url,
    ).href;
    const repositoryModule = new URL(
      '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs',
      import.meta.url,
    ).href;
    const journalModule = new URL(
      '../../paper-adapters/submission/handoff-bundle-publication-journal-repository.mjs',
      import.meta.url,
    ).href;
    const script = `
      import fs from 'node:fs';
      import { createFilesystemArtifactRepository } from ${JSON.stringify(repositoryModule)};
      import { exportSubmissionHandoffBundle } from ${JSON.stringify(exporterModule)};
      import { submissionHandoffBundlePublicationJournalPaths } from ${JSON.stringify(journalModule)};
      const bundleRoot = ${JSON.stringify(bundleRoot)};
      const paths = submissionHandoffBundlePublicationJournalPaths({ finalRoot: bundleRoot });
      const originalFsyncSync = fs.fsyncSync;
      fs.fsyncSync = (descriptor) => {
        const result = originalFsyncSync(descriptor);
        if (fs.existsSync(bundleRoot)
          && fs.existsSync(paths.completedPath)
          && !fs.existsSync(paths.preparedPath)) {
          process.kill(process.pid, 'SIGKILL');
        }
        return result;
      };
      const repository = createFilesystemArtifactRepository({
        scopeRoot: ${JSON.stringify(root)},
        casRoot: ${JSON.stringify(casRoot)},
        receiptLedger: { record: () => ({ receiptId: 'terminal-sigkill-ledger' }) },
        clock: {
          now: () => new Date('2026-07-13T00:00:00.000Z'),
          nowIso: () => '2026-07-13T00:00:00.000Z',
        },
      });
      await exportSubmissionHandoffBundle({
        ...${JSON.stringify(readyInput)},
        artifactRepository: repository,
        bundleRoot,
      });
    `;
    const killed = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      script,
    ]);
    assert.equal(killed.signal, 'SIGKILL');
    assert.equal(fs.existsSync(bundleRoot), true);
    const recovered = await exportSubmissionHandoffBundle({
      ...readyInput,
      artifactRepository: artifactRepository(root, 'terminal-journal-sigkill'),
      bundleRoot,
    });
    assert.equal(recovered.status, 'submission_handoff_bundle_exported');
    assert.equal(recovered.recoveredExistingPublication, true);
    assert.equal(recovered.localFilesystemMutationPerformed, false);
    assert.equal(
      recovered.submissionHandoffBundlePublicationReceiptHash,
      null,
    );
    assert.equal(
      recovered.submissionHandoffBundlePublicationRecoveryReceiptHash,
      null,
    );
  });

  await t.test('persisted authority lineage is sealed and refreshed before publish', async () => {
    const dispatchAuthorizationHash = sha256('persisted-authority-dispatch');
    const authorizedInput = {
      ...readyInput,
      dispatchAuthorization: {
        ...readyInput.dispatchAuthorization,
        submissionDispatchAuthorizationHash: dispatchAuthorizationHash,
      },
    };
    const baseline = persistedSubmissionAuthorityFixture({
      dispatchAuthorizationHash,
    });
    const current = persistedSubmissionAuthorityFixture({
      dispatchAuthorizationHash,
      observedAt: '2026-07-13T00:00:01.000Z',
    });
    const bundleRoot = path.join(root, 'persisted-authority-bundle');
    let queryCalls = 0;
    const exported = await exportSubmissionHandoffBundle({
      ...authorizedInput,
      artifactRepository: artifactRepository(root, 'persisted-authority'),
      bundleRoot,
      submissionAuthority: baseline,
      submissionAuthorityFreshnessQuery: async (expected) => {
        queryCalls += 1;
        assert.equal(
          expected.baselineLineage.submissionHandoffExportAuthorityHash,
          baseline.submissionHandoffExportAuthorityHash,
        );
        assert.equal(fs.existsSync(bundleRoot), false);
        return {
          status: 'submission_handoff_authority_fresh',
          receiptHash: sha256('provided-authority-freshness'),
          baselineAuthorityHash: baseline.submissionHandoffExportAuthorityHash,
          currentAuthorityHash: current.submissionHandoffExportAuthorityHash,
          observedAt: current.observedAt,
          grantsExecutionPermission: false,
          currentAuthority: current,
        };
      },
    });
    assert.equal(exported.status, 'submission_handoff_bundle_exported');
    assert.equal(queryCalls, 1);
    assert.match(
      exported.submissionHandoffAuthorityLineageHash,
      /^sha256:[0-9a-f]{64}$/u,
    );
    assert.match(
      exported.submissionHandoffAuthorityFreshnessReceiptHash,
      /^sha256:[0-9a-f]{64}$/u,
    );
    const document = JSON.parse(fs.readFileSync(
      path.join(bundleRoot, 'SUBMISSION_HANDOFF_MANIFEST.json'),
      'utf8',
    ));
    assert.equal(
      document.persistedSubmissionAuthority
        .submissionHandoffExportAuthorityHash,
      baseline.submissionHandoffExportAuthorityHash,
    );
    assert.equal(
      document.persistedSubmissionAuthority.payloadBindingHash,
      baseline.payloadBindingHash,
    );
    assert.equal(
      document.persistedSubmissionAuthority
        .requiresProviderActionTimeAuthorityRevalidation,
      true,
    );

    const staleRoot = path.join(root, 'persisted-authority-stale-bundle');
    const changed = persistedSubmissionAuthorityFixture({
      dispatchAuthorizationHash,
      observedAt: '2026-07-13T00:00:02.000Z',
      rowBindingHash: sha256('changed-authority-row-binding'),
    });
    const blocked = await exportSubmissionHandoffBundle({
      ...authorizedInput,
      artifactRepository: artifactRepository(root, 'persisted-authority-stale'),
      bundleRoot: staleRoot,
      submissionAuthority: baseline,
      submissionAuthorityFreshnessQuery: async () => ({
        status: 'submission_handoff_authority_fresh',
        receiptHash: sha256('changed-authority-freshness'),
        baselineAuthorityHash: baseline.submissionHandoffExportAuthorityHash,
        currentAuthorityHash: changed.submissionHandoffExportAuthorityHash,
        observedAt: changed.observedAt,
        grantsExecutionPermission: false,
        currentAuthority: changed,
      }),
    });
    assert.equal(blocked.status, 'submission_handoff_bundle_blocked');
    assert.ok(blocked.blockers.some((blocker) => blocker.endsWith(
      'handoff_submission_authority_changed_before_publication',
    )));
    assert.equal(blocked.localFilesystemMutationPerformed, true);
    assert.equal(blocked.externalActionPerformed, false);
    assert.equal(fs.existsSync(staleRoot), false);
  });

  await t.test('consumer detects post-return tamper and wrong expected hash', async () => {
    const bundleRoot = path.join(root, 'consumer-bundle');
    const exported = await exportSubmissionHandoffBundle({
      ...readyInput,
      artifactRepository: artifactRepository(root, 'consumer'),
      bundleRoot,
    });
    assert.equal(exported.status, 'submission_handoff_bundle_exported');
    const verified = verifySubmissionHandoffBundle({
      bundleRoot,
      submissionHandoffBundleManifestHash:
        exported.submissionHandoffBundleManifestHash,
    });
    assert.equal(verified.status, 'submission_handoff_bundle_verified');
    const missingExpected = verifySubmissionHandoffBundle({ bundleRoot });
    assert.deepEqual(missingExpected.blockers, [
      'handoff_bundle_expected_manifest_hash_required',
    ]);
    const wrongExpected = verifySubmissionHandoffBundle({
      bundleRoot,
      submissionHandoffBundleManifestHash: sha256('wrong'),
    });
    assert.equal(
      wrongExpected.status,
      'submission_handoff_bundle_verification_blocked',
    );
    assert.ok(wrongExpected.blockers.some((blocker) => blocker.endsWith(
      'handoff_bundle_expected_manifest_hash_mismatch',
    )));

    fs.chmodSync(bundleRoot, 0o700);
    const copied = path.join(bundleRoot, 'artifacts', '001-paper.pdf');
    fs.chmodSync(path.dirname(copied), 0o700);
    fs.chmodSync(copied, 0o600);
    fs.appendFileSync(copied, 'post-return-tamper');
    const tampered = verifySubmissionHandoffBundle({
      bundleRoot,
      submissionHandoffBundleManifestHash:
        exported.submissionHandoffBundleManifestHash,
    });
    assert.equal(
      tampered.status,
      'submission_handoff_bundle_verification_blocked',
    );
  });
});

test('sealed campaign package handoff copy preserves the exact tree and portable lineage', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hepta-handoff-sealed-copy-'));
  t.after(() => {
    restoreOwnerWrite(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const packageOutput = sealedPackageFixture(root);
  const bundleRoot = path.join(root, 'bundle');
  const copy = await copyVerifiedSealedPackageOutputFilesForHandoff({
    artifactRepository: artifactRepository(root, 'exact'),
    bundleRoot,
    packageOutput,
    runtimeRoot: root,
  });

  assert.equal(
    copy.immutableCampaignPackageOutputHash,
    packageOutput.immutableCampaignPackageOutputHash,
  );
  assert.equal(copy.fileCount, packageOutput.fileCount);
  assert.deepEqual(portableTree(path.join(bundleRoot, 'sealed-package')), {
    files: [
      'PACKAGE_RECORD.json',
      'evidence/CAPSULE_MANIFEST.json',
      'evidence/gpu-scientific/pde-output.bin',
    ],
    directories: ['evidence', 'evidence/gpu-scientific'],
  });
  const sourceByRelative = new Map(packageOutput.files.map(
    (file) => [file.packageRelativePath, file],
  ));
  for (const file of copy.files) {
    const source = sourceByRelative.get(file.packageRelativePath);
    assert.ok(source);
    assert.deepEqual({
      role: file.role,
      capsuleRole: file.capsuleRole,
      executionRole: file.executionRole,
      experimentId: file.experimentId,
      hash: file.hash,
      bytes: file.bytes,
    }, {
      role: source.role,
      capsuleRole: source.capsuleRole || null,
      executionRole: source.executionRole || null,
      experimentId: source.experimentId || null,
      hash: source.hash,
      bytes: source.bytes,
    });
    assert.equal(
      file.bundlePath,
      `sealed-package/${file.packageRelativePath}`,
    );
    assert.match(file.sourceReadReceiptHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(file.writeReceiptHash, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(
      fs.readFileSync(path.join(bundleRoot, file.bundlePath)),
      fs.readFileSync(source.path),
    );
  }
  const portableFiles = copy.files.map((file) => ({
    role: file.role,
    capsuleRole: file.capsuleRole,
    executionRole: file.executionRole,
    experimentId: file.experimentId,
    packageRelativePath: file.packageRelativePath,
    bundlePath: file.bundlePath,
    hash: file.hash,
    bytes: file.bytes,
  }));
  assert.equal(
    copy.fileSetHash,
    hashRecord('SubmissionHandoffSealedPackageFileSet', portableFiles),
  );
});

test('sealed campaign package handoff copy fails closed on copy-tree attacks', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hepta-handoff-sealed-attacks-'));
  t.after(() => {
    restoreOwnerWrite(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const packageOutput = sealedPackageFixture(root);

  await t.test('tampered bytes', async () => {
    const repository = artifactRepository(root, 'tamper');
    const originalLinkSync = fs.linkSync;
    let attacked = false;
    fs.linkSync = (source, target, ...rest) => {
      const result = originalLinkSync(source, target, ...rest);
      if (!attacked) {
        attacked = true;
        fs.chmodSync(target, 0o600);
        fs.appendFileSync(target, 'tampered');
      }
      return result;
    };
    try {
      await assert.rejects(
        copyVerifiedSealedPackageOutputFilesForHandoff({
          artifactRepository: repository,
          bundleRoot: path.join(root, 'tampered-bundle'),
          packageOutput,
          runtimeRoot: root,
        }),
        /handoff_bundle_writer_target_identity_invalid/,
      );
    } finally {
      fs.linkSync = originalLinkSync;
    }
    assert.equal(attacked, true);
  });

  for (const attack of ['extra-file', 'symlink', 'hardlink']) {
    await t.test(attack, async () => {
      const repository = artifactRepository(root, attack);
      const bundleRoot = path.join(root, `${attack}-bundle`);
      const originalLinkSync = fs.linkSync;
      let attacked = false;
      fs.linkSync = (source, target, ...rest) => {
        const result = originalLinkSync(source, target, ...rest);
        if (!attacked) {
          attacked = true;
          if (attack === 'extra-file') {
            fs.writeFileSync(
              path.join(path.dirname(target), 'UNDECLARED'),
              'extra',
            );
          } else if (attack === 'symlink') {
            const peer = path.join(root, 'symlink-peer');
            fs.writeFileSync(peer, fs.readFileSync(target));
            fs.rmSync(target);
            fs.symlinkSync(peer, target);
          } else {
            originalLinkSync(target, path.join(root, 'hardlink-peer'));
          }
        }
        return result;
      };
      try {
        await assert.rejects(
          copyVerifiedSealedPackageOutputFilesForHandoff({
            artifactRepository: repository,
            bundleRoot,
            packageOutput,
            runtimeRoot: root,
          }),
          attack === 'extra-file'
            ? /handoff_sealed_package_copy_exact_tree_invalid/
            : /handoff_bundle_writer_target_identity_invalid/,
        );
      } finally {
        fs.linkSync = originalLinkSync;
      }
      assert.equal(attacked, true);
    });
  }

  await t.test('repository failure', async () => {
    const repository = artifactRepository(root, 'failure');
    const originalLinkSync = fs.linkSync;
    let writes = 0;
    fs.linkSync = (source, target, ...rest) => {
      writes += 1;
      if (writes === 2) throw new Error('injected_sealed_package_copy_failure');
      return originalLinkSync(source, target, ...rest);
    };
    try {
      await assert.rejects(
        copyVerifiedSealedPackageOutputFilesForHandoff({
          artifactRepository: repository,
          bundleRoot: path.join(root, 'failed-bundle'),
          packageOutput,
          runtimeRoot: root,
        }),
        /injected_sealed_package_copy_failure/,
      );
    } finally {
      fs.linkSync = originalLinkSync;
    }
  });
});

test('sealed campaign package handoff copy rejects invalid source descriptors and trees', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hepta-handoff-sealed-source-'));
  t.after(() => {
    restoreOwnerWrite(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const copy = (label, packageOutput) => (
    copyVerifiedSealedPackageOutputFilesForHandoff({
      artifactRepository: artifactRepository(root, label),
      bundleRoot: path.join(root, `${label}-bundle`),
      packageOutput,
      runtimeRoot: root,
    })
  );

  for (const field of ['hash', 'bytes', 'packageRelativePath']) {
    await t.test(`${field} descriptor mismatch`, async () => {
      const packageOutput = sealedPackageFixture(path.join(root, `descriptor-${field}`));
      const files = packageOutput.files.map((file, index) => {
        if (index !== 0) return file;
        if (field === 'hash') return { ...file, hash: sha256('wrong') };
        if (field === 'bytes') return { ...file, bytes: file.bytes + 1 };
        return { ...file, packageRelativePath: 'WRONG_PACKAGE_RECORD.json' };
      });
      const mismatched = rehashPackageOutput(packageOutput, {
        files: Object.freeze(files),
      });
      await assert.rejects(
        copy(`descriptor-${field}`, mismatched),
        field === 'packageRelativePath'
          ? /handoff_sealed_package_file_relative_path_mismatch/
          : /campaign_release_package_output_file_invalid/,
      );
    });
  }

  await t.test('undeclared source file', async () => {
    const packageOutput = sealedPackageFixture(path.join(root, 'source-extra'));
    fs.chmodSync(packageOutput.packageDir, 0o755);
    fs.writeFileSync(
      path.join(packageOutput.packageDir, 'UNDECLARED'),
      'extra',
      { mode: 0o444 },
    );
    fs.chmodSync(packageOutput.packageDir, 0o555);
    await assert.rejects(
      copy('source-extra', packageOutput),
      /campaign_release_package_output_exact_tree_invalid/,
    );
  });

  await t.test('source symlink', async () => {
    const packageOutput = sealedPackageFixture(path.join(root, 'source-symlink'));
    const file = packageOutput.files[0];
    const peer = path.join(root, 'source-symlink-peer');
    fs.writeFileSync(peer, fs.readFileSync(file.path), { mode: 0o444 });
    fs.chmodSync(packageOutput.packageDir, 0o755);
    fs.rmSync(file.path);
    fs.symlinkSync(peer, file.path);
    fs.chmodSync(packageOutput.packageDir, 0o555);
    await assert.rejects(
      copy('source-symlink', packageOutput),
      /(?:campaign_release_package_output_(?:file_invalid|entry_unsafe)|handoff_sealed_package_source_symlink_forbidden)/,
    );
  });

  await t.test('source hardlink', async () => {
    const packageOutput = sealedPackageFixture(path.join(root, 'source-hardlink'));
    fs.linkSync(packageOutput.files[0].path, path.join(root, 'source-hardlink-peer'));
    await assert.rejects(
      copy('source-hardlink', packageOutput),
      /(?:campaign_release_package_output_(?:file_invalid|entry_unsafe)|handoff_sealed_package_source_hardlink_forbidden)/,
    );
  });
});
