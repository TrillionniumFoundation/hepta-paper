import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createFilesystemArtifactRepository,
} from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import {
  exportSubmissionHandoffBundle,
  verifySubmissionHandoffBundle,
} from '../../paper-adapters/submission/handoff-bundle-exporter.mjs';
import {
  canonicalSubmissionHandoffManifestBytes,
  sealAndVerifySubmissionHandoffBundleSync,
} from '../../paper-adapters/submission/handoff-bundle-integrity.mjs';
import {
  createSubmissionHandoffBundlePublicationJournal,
  inspectSubmissionHandoffBundlePublicationJournal,
  SUBMISSION_HANDOFF_PUBLICATION_JOURNAL_RESIDUAL_RISKS,
  submissionHandoffBundlePublicationJournalPaths,
} from '../../paper-adapters/submission/handoff-bundle-publication-journal-repository.mjs';
import {
  createSubmissionHandoffBundlePublication,
} from '../../paper-adapters/submission/handoff-bundle-publication-repository.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function inodeIdentity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

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

function artifactRepository(root, label) {
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

function readyInput(sourceRoot, content) {
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
  return Object.freeze({
    artifactPackage,
    packageVerificationReceipt,
    manifest,
    handoff,
    replayGuard,
    reviewedSubmitPreflightPacket,
    dispatchAuthorization,
    submissionDecisionPacket: {
      status: 'reviewed_submission_decision_verified',
      reviewedSubmissionDecisionPacketHash: 'sha256:decision',
      metadata: { title: 'Fixture' },
    },
    artifactBaseRoot: sourceRoot,
  });
}

function persistedSubmissionAuthority({
  dispatchAuthorizationHash,
  observedAt,
} = {}) {
  const payload = {
    version: 1,
    kind: 'PersistedSubmissionHandoffExportAuthority',
    status: 'submission_handoff_export_authority_ready',
    messageId: 'journal-authority-message',
    paperId: 'paper',
    dispatchAuthorizationHash,
    rowBindingHash: sha256('journal-authority-row'),
    authorizationConsumptionHash: sha256('journal-authority-consumption'),
    releaseLockHash: sha256('journal-authority-release-lock'),
    payloadBindingHash: sha256('journal-authority-payload'),
    providerCapabilityHash: sha256('journal-authority-capability'),
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

function directPublication(root, label) {
  const publication = createSubmissionHandoffBundlePublication({
    finalRoot: path.join(root, `direct-${label}-bundle`),
    repositoryScopeRoot: root,
    repositoryCasRoot: path.join(root, `.cas-direct-${label}`),
  });
  fs.chmodSync(publication.stagingRoot, 0o500);
  return publication;
}

function journalCreateInput(publication, label) {
  return Object.freeze({
    publication,
    submissionHandoffRequestRecoveryBindingHash:
      sha256(`journal-${label}-binding`),
    submissionHandoffBundleManifestHash:
      sha256(`journal-${label}-manifest`),
    submissionHandoffBundlePublicationLineageHash:
      sha256(`journal-${label}-lineage`),
  });
}

async function leavePreparedAfterRename({ bundleRoot, input, repository }) {
  const originalFsyncSync = fs.fsyncSync;
  let injected = false;
  fs.fsyncSync = (descriptor) => {
    if (!injected && fs.existsSync(bundleRoot)) {
      injected = true;
      throw new Error('injected_post_rename_fsync_failure');
    }
    return originalFsyncSync(descriptor);
  };
  let receipt;
  try {
    receipt = await exportSubmissionHandoffBundle({
      ...input,
      artifactRepository: repository,
      bundleRoot,
    });
  } finally {
    fs.fsyncSync = originalFsyncSync;
  }
  assert.equal(injected, true);
  assert.equal(receipt.status, 'submission_handoff_bundle_blocked');
  assert.deepEqual(receipt.blockers, [
    'handoff_bundle_publication_invalid:'
      + 'handoff_bundle_atomic_publication_durability_failed',
  ]);
  const state = inspectSubmissionHandoffBundlePublicationJournal({
    finalRoot: bundleRoot,
    repositoryScopeRoot: repository.scopeRoot,
    repositoryCasRoot: repository.casRoot,
  });
  assert.equal(
    state.status,
    'submission_handoff_bundle_publication_journal_prepared',
  );
  assert.equal(fs.existsSync(state.paths.preparedPath), true);
  assert.equal(fs.existsSync(state.paths.completedPath), false);
  return state;
}

test('submission handoff publication journal fences recovery provenance', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-handoff-journal-'));
  t.after(() => {
    restoreOwnerWrite(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sourceRoot = path.join(root, 'source');
  const content = Buffer.from('%PDF-journal-fixture\n');
  fs.mkdirSync(sourceRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(sourceRoot, 'paper.pdf'), content, { mode: 0o600 });
  const input = readyInput(sourceRoot, content);

  const originalRoot = path.join(root, 'published-bundle');
  const originalRepository = artifactRepository(root, 'published');
  const published = await exportSubmissionHandoffBundle({
    ...input,
    artifactRepository: originalRepository,
    bundleRoot: originalRoot,
  });
  assert.equal(published.status, 'submission_handoff_bundle_exported');
  const journal = inspectSubmissionHandoffBundlePublicationJournal({
    finalRoot: originalRoot,
    repositoryScopeRoot: originalRepository.scopeRoot,
    repositoryCasRoot: originalRepository.casRoot,
  });
  assert.equal(
    journal.status,
    'submission_handoff_bundle_publication_journal_completed',
  );
  assert.equal(journal.preparedTwin, false);
  assert.equal(fs.existsSync(journal.paths.preparedPath), false);
  assert.equal(fs.existsSync(journal.paths.completedPath), true);
  assert.equal(path.dirname(journal.paths.completedPath), path.dirname(originalRoot));
  assert.deepEqual(
    journal.entry.record.residualRiskDisclosures,
    SUBMISSION_HANDOFF_PUBLICATION_JOURNAL_RESIDUAL_RISKS,
  );
  assert.deepEqual(
    journal.entry.record.stagingIdentity,
    inodeIdentity(fs.lstatSync(originalRoot, { bigint: true })),
  );
  const replay = await exportSubmissionHandoffBundle({
    ...input,
    artifactRepository: originalRepository,
    bundleRoot: originalRoot,
  });
  assert.equal(replay.status, 'submission_handoff_bundle_exported');
  assert.equal(replay.recoveredExistingPublication, true);
  assert.equal(replay.localFilesystemMutationPerformed, false);
  assert.equal(
    replay.submissionHandoffBundleManifestHash,
    published.submissionHandoffBundleManifestHash,
  );

  await t.test('self-consistent preexisting tree without a journal collides', async () => {
    const forgedRoot = path.join(root, 'forged-self-consistent-bundle');
    fs.cpSync(originalRoot, forgedRoot, { recursive: true });
    restoreOwnerWrite(forgedRoot);
    const manifestPath = path.join(
      forgedRoot,
      'SUBMISSION_HANDOFF_MANIFEST.json',
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const lineagePayload = {
      version: 1,
      kind: 'SubmissionHandoffBundlePublicationLineage',
      finalName: path.basename(forgedRoot),
      parentIdentity: inodeIdentity(fs.lstatSync(root, { bigint: true })),
      stagingIdentity:
        inodeIdentity(fs.lstatSync(forgedRoot, { bigint: true })),
      submissionHandoffBundlePublicationHash: hashRecord(
        'ForgedSubmissionHandoffBundlePublication',
        { forgedRoot },
      ),
    };
    manifest.submissionHandoffBundlePublicationLineage = {
      ...lineagePayload,
      submissionHandoffBundlePublicationLineageHash: hashRecord(
        'SubmissionHandoffBundlePublicationLineage',
        lineagePayload,
      ),
    };
    delete manifest.submissionHandoffBundleManifestHash;
    manifest.submissionHandoffBundleManifestHash = hashRecord(
      'SubmissionHandoffBundleManifest',
      manifest,
    );
    fs.writeFileSync(manifestPath, canonicalSubmissionHandoffManifestBytes(manifest));
    sealAndVerifySubmissionHandoffBundleSync({
      bundleRoot: forgedRoot,
      manifestDocument: manifest,
    });
    assert.equal(verifySubmissionHandoffBundle({
      bundleRoot: forgedRoot,
      submissionHandoffBundleManifestHash:
        manifest.submissionHandoffBundleManifestHash,
    }).status, 'submission_handoff_bundle_verified');
    const paths = submissionHandoffBundlePublicationJournalPaths({
      finalRoot: forgedRoot,
    });
    assert.equal(fs.existsSync(paths.preparedPath), false);
    assert.equal(fs.existsSync(paths.completedPath), false);
    const blocked = await exportSubmissionHandoffBundle({
      ...input,
      artifactRepository: artifactRepository(root, 'forged'),
      bundleRoot: forgedRoot,
    });
    assert.deepEqual(blocked.blockers, ['handoff_bundle_preexisting_collision']);
  });

  await t.test('missing prepared journal cannot authorize recovery', async () => {
    const bundleRoot = path.join(root, 'missing-journal-bundle');
    const repository = artifactRepository(root, 'missing-journal');
    const prepared = await leavePreparedAfterRename({
      bundleRoot,
      input,
      repository,
    });
    fs.unlinkSync(prepared.paths.preparedPath);
    const blocked = await exportSubmissionHandoffBundle({
      ...input,
      artifactRepository: repository,
      bundleRoot,
    });
    assert.deepEqual(blocked.blockers, ['handoff_bundle_preexisting_collision']);
  });

  await t.test('tampered prepared journal cannot authorize recovery', async () => {
    const bundleRoot = path.join(root, 'tampered-journal-bundle');
    const repository = artifactRepository(root, 'tampered-journal');
    const prepared = await leavePreparedAfterRename({
      bundleRoot,
      input,
      repository,
    });
    const record = JSON.parse(fs.readFileSync(prepared.paths.preparedPath, 'utf8'));
    record.submissionHandoffBundleManifestHash = sha256('tampered-journal');
    fs.chmodSync(prepared.paths.preparedPath, 0o600);
    fs.writeFileSync(
      prepared.paths.preparedPath,
      `${JSON.stringify(record, null, 2)}\n`,
    );
    fs.chmodSync(prepared.paths.preparedPath, 0o444);
    const blocked = await exportSubmissionHandoffBundle({
      ...input,
      artifactRepository: repository,
      bundleRoot,
    });
    assert.deepEqual(blocked.blockers, [
      'handoff_bundle_publication_journal_invalid:'
        + 'handoff_bundle_publication_journal_record_invalid',
    ]);
  });

  await t.test('replacement final inode cannot impersonate staged identity', async () => {
    const bundleRoot = path.join(root, 'replacement-final-bundle');
    const repository = artifactRepository(root, 'replacement-final');
    const prepared = await leavePreparedAfterRename({
      bundleRoot,
      input,
      repository,
    });
    const displaced = path.join(root, 'displaced-original-bundle');
    fs.renameSync(bundleRoot, displaced);
    fs.cpSync(displaced, bundleRoot, { recursive: true });
    restoreOwnerWrite(bundleRoot);
    sealAndVerifySubmissionHandoffBundleSync({
      bundleRoot,
      manifestDocument: JSON.parse(fs.readFileSync(
        path.join(bundleRoot, 'SUBMISSION_HANDOFF_MANIFEST.json'),
        'utf8',
      )),
    });
    assert.equal(verifySubmissionHandoffBundle({
      bundleRoot,
      submissionHandoffBundleManifestHash:
        prepared.entry.record.submissionHandoffBundleManifestHash,
    }).status, 'submission_handoff_bundle_verified');
    assert.notDeepEqual(
      inodeIdentity(fs.lstatSync(bundleRoot, { bigint: true })),
      prepared.entry.record.stagingIdentity,
    );
    const blocked = await exportSubmissionHandoffBundle({
      ...input,
      artifactRepository: repository,
      bundleRoot,
    });
    assert.deepEqual(blocked.blockers, [
      'handoff_bundle_preexisting_recovery_invalid:'
        + 'handoff_bundle_recovery_staging_identity_mismatch',
    ]);
  });

  await t.test('prepared journal is published only from a complete fsynced temp', () => {
    const partialPublication = directPublication(root, 'partial-write');
    const partialInput = journalCreateInput(
      partialPublication,
      'partial-write',
    );
    const partialPaths = submissionHandoffBundlePublicationJournalPaths({
      finalRoot: partialPublication.finalRoot,
    });
    const originalWriteSync = fs.writeSync;
    let partialInjected = false;
    fs.writeSync = (descriptor, bytes, offset, length, ...rest) => {
      if (!partialInjected) {
        partialInjected = true;
        originalWriteSync(
          descriptor,
          bytes,
          offset,
          Math.min(8, length),
          ...rest,
        );
        throw new Error('injected_partial_journal_temp_write');
      }
      return originalWriteSync(descriptor, bytes, offset, length, ...rest);
    };
    try {
      assert.throws(
        () => createSubmissionHandoffBundlePublicationJournal(partialInput),
        /injected_partial_journal_temp_write/,
      );
    } finally {
      fs.writeSync = originalWriteSync;
    }
    assert.equal(partialInjected, true);
    assert.equal(fs.existsSync(partialPaths.preparedPath), false);
    assert.equal(
      inspectSubmissionHandoffBundlePublicationJournal({
        finalRoot: partialPublication.finalRoot,
        repositoryScopeRoot: partialPublication.repositoryScopeRoot,
        repositoryCasRoot: partialPublication.repositoryCasRoot,
      }).status,
      'submission_handoff_bundle_publication_journal_absent',
    );

    const crashResidue = path.join(
      path.dirname(partialPaths.preparedPath),
      `.${path.basename(partialPaths.preparedPath)}.tmp-crash-residue`,
    );
    fs.writeFileSync(crashResidue, '{partial', { mode: 0o444 });
    const created = createSubmissionHandoffBundlePublicationJournal(
      partialInput,
    );
    assert.equal(
      created.status,
      'submission_handoff_bundle_publication_journal_prepared',
    );
    assert.equal(fs.existsSync(crashResidue), true);

    const fileFsyncPublication = directPublication(root, 'file-fsync');
    const fileFsyncInput = journalCreateInput(
      fileFsyncPublication,
      'file-fsync',
    );
    const fileFsyncPaths = submissionHandoffBundlePublicationJournalPaths({
      finalRoot: fileFsyncPublication.finalRoot,
    });
    const originalFsyncSync = fs.fsyncSync;
    let fileFsyncInjected = false;
    fs.fsyncSync = () => {
      fileFsyncInjected = true;
      throw new Error('injected_journal_temp_file_fsync');
    };
    try {
      assert.throws(
        () => createSubmissionHandoffBundlePublicationJournal(fileFsyncInput),
        /injected_journal_temp_file_fsync/,
      );
    } finally {
      fs.fsyncSync = originalFsyncSync;
    }
    assert.equal(fileFsyncInjected, true);
    assert.equal(fs.existsSync(fileFsyncPaths.preparedPath), false);
    assert.equal(
      inspectSubmissionHandoffBundlePublicationJournal({
        finalRoot: fileFsyncPublication.finalRoot,
        repositoryScopeRoot: fileFsyncPublication.repositoryScopeRoot,
        repositoryCasRoot: fileFsyncPublication.repositoryCasRoot,
      }).status,
      'submission_handoff_bundle_publication_journal_absent',
    );

    const parentFsyncPublication = directPublication(root, 'parent-fsync');
    const parentFsyncInput = journalCreateInput(
      parentFsyncPublication,
      'parent-fsync',
    );
    let fsyncCalls = 0;
    fs.fsyncSync = (descriptor) => {
      fsyncCalls += 1;
      if (fsyncCalls === 2) {
        throw new Error('injected_journal_prepared_parent_fsync');
      }
      return originalFsyncSync(descriptor);
    };
    try {
      assert.throws(
        () => createSubmissionHandoffBundlePublicationJournal(
          parentFsyncInput,
        ),
        /injected_journal_prepared_parent_fsync/,
      );
    } finally {
      fs.fsyncSync = originalFsyncSync;
    }
    assert.equal(fsyncCalls, 2);
    assert.equal(
      inspectSubmissionHandoffBundlePublicationJournal({
        finalRoot: parentFsyncPublication.finalRoot,
        repositoryScopeRoot: parentFsyncPublication.repositoryScopeRoot,
        repositoryCasRoot: parentFsyncPublication.repositoryCasRoot,
      }).status,
      'submission_handoff_bundle_publication_journal_prepared',
    );
  });

  await t.test('authority observation time changes do not break recovery binding', async () => {
    const bundleRoot = path.join(root, 'authority-recovery-bundle');
    const repository = artifactRepository(root, 'authority-recovery');
    const dispatchAuthorizationHash = sha256(
      'journal-authority-dispatch',
    );
    const authorizedInput = {
      ...input,
      dispatchAuthorization: {
        ...input.dispatchAuthorization,
        submissionDispatchAuthorizationHash: dispatchAuthorizationHash,
      },
    };
    const originalAuthority = persistedSubmissionAuthority({
      dispatchAuthorizationHash,
      observedAt: '2026-07-13T00:00:00.000Z',
    });
    await leavePreparedAfterRename({
      bundleRoot,
      repository,
      input: {
        ...authorizedInput,
        submissionAuthority: originalAuthority,
        submissionAuthorityFreshnessQuery: async () => (
          persistedSubmissionAuthority({
            dispatchAuthorizationHash,
            observedAt: '2026-07-13T00:00:01.000Z',
          })
        ),
      },
    });
    const restartAuthority = persistedSubmissionAuthority({
      dispatchAuthorizationHash,
      observedAt: '2026-07-13T00:00:02.000Z',
    });
    let freshnessCalls = 0;
    const recovered = await exportSubmissionHandoffBundle({
      ...authorizedInput,
      artifactRepository: repository,
      bundleRoot,
      submissionAuthority: restartAuthority,
      submissionAuthorityFreshnessQuery: async ({
        baselineAuthority,
        baselineLineage,
      }) => {
        freshnessCalls += 1;
        assert.equal(
          baselineAuthority.observedAt,
          restartAuthority.observedAt,
        );
        assert.equal(
          baselineLineage.observedAt,
          originalAuthority.observedAt,
        );
        return persistedSubmissionAuthority({
          dispatchAuthorizationHash,
          observedAt: '2026-07-13T00:00:03.000Z',
        });
      },
    });
    assert.equal(recovered.status, 'submission_handoff_bundle_exported');
    assert.equal(recovered.recoveredExistingPublication, true);
    assert.equal(freshnessCalls, 1);
  });

  await t.test('completed twin is exact-bound before terminal cleanup', async () => {
    const bundleRoot = path.join(root, 'completed-twin-bundle');
    const repository = artifactRepository(root, 'completed-twin');
    const exported = await exportSubmissionHandoffBundle({
      ...input,
      artifactRepository: repository,
      bundleRoot,
    });
    assert.equal(exported.status, 'submission_handoff_bundle_exported');
    const completed = inspectSubmissionHandoffBundlePublicationJournal({
      finalRoot: bundleRoot,
      repositoryScopeRoot: repository.scopeRoot,
      repositoryCasRoot: repository.casRoot,
    });
    fs.linkSync(completed.paths.completedPath, completed.paths.preparedPath);
    assert.equal(
      inspectSubmissionHandoffBundlePublicationJournal({
        finalRoot: bundleRoot,
        repositoryScopeRoot: repository.scopeRoot,
        repositoryCasRoot: repository.casRoot,
      }).preparedTwin,
      true,
    );

    const mismatched = await exportSubmissionHandoffBundle({
      ...input,
      artifactRepository: repository,
      bundleRoot,
      submissionDecisionPacket: {
        ...input.submissionDecisionPacket,
        metadata: { title: 'Different terminal replay' },
      },
    });
    assert.deepEqual(mismatched.blockers, [
      'handoff_bundle_preexisting_recovery_invalid:'
        + 'handoff_bundle_publication_journal_binding_mismatch',
    ]);
    assert.equal(mismatched.localFilesystemMutationPerformed, false);
    assert.equal(fs.existsSync(completed.paths.preparedPath), true);

    const exact = await exportSubmissionHandoffBundle({
      ...input,
      artifactRepository: repository,
      bundleRoot,
    });
    assert.equal(exact.status, 'submission_handoff_bundle_exported');
    assert.equal(exact.recoveredExistingPublication, true);
    assert.equal(exact.localFilesystemMutationPerformed, true);
    assert.equal(fs.existsSync(completed.paths.preparedPath), false);
    assert.equal(fs.existsSync(completed.paths.completedPath), true);

    const terminalReplay = await exportSubmissionHandoffBundle({
      ...input,
      artifactRepository: repository,
      bundleRoot,
    });
    assert.equal(
      terminalReplay.status,
      'submission_handoff_bundle_exported',
    );
    assert.equal(terminalReplay.recoveredExistingPublication, true);
    assert.equal(
      terminalReplay.localFilesystemMutationPerformed,
      false,
    );
  });
});
