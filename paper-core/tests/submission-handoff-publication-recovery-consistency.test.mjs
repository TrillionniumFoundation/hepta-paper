import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  createFilesystemArtifactRepository,
} from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import {
  copyVerifiedSealedPackageOutputFilesForHandoff,
  exportSubmissionHandoffBundle,
} from '../../paper-adapters/submission/handoff-bundle-exporter.mjs';
import {
  SUBMISSION_HANDOFF_BUNDLE_RESOURCE_LIMITS,
} from '../../paper-adapters/submission/handoff-bundle-integrity.mjs';
import {
  abandonSubmissionHandoffBundlePublicationSync,
  createSubmissionHandoffBundlePublication,
  createSubmissionHandoffBundlePublicationLineage,
  reconcileSubmissionHandoffBundleStagingOrphansSync,
} from '../../paper-adapters/submission/handoff-bundle-publication-repository.mjs';
import {
  createRecoverableSubmissionHandoffBundlePublicationJournal,
} from '../../paper-adapters/submission/handoff-bundle-publication-journal-repository.mjs';
import {
  submissionHandoffBundleStagingNamePattern,
} from '../../paper-adapters/submission/handoff-bundle-staging-namespace.mjs';
import {
  assertSubmissionHandoffBundleResourcePlan,
} from '../../paper-adapters/submission/handoff-bundle-resource-plan.mjs';
import {
  buildSealedSubmissionHandoffPackageFixture,
} from './support/submission-handoff-sealed-package-fixture.mjs';

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function restoreOwnerWrite(candidate) {
  let entry;
  try { entry = fs.lstatSync(candidate); } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (entry.isSymbolicLink()) return;
  fs.chmodSync(candidate, entry.isDirectory() ? 0o700 : 0o600);
  if (entry.isDirectory()) {
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
  const reviewedSubmitPreflightPacket = {
    status: 'reviewed_submit_preflight_ready_for_external_executor',
    reviewedSubmitPreflightPacketHash: 'sha256:preflight',
    outboxHash: 'sha256:outbox',
  };
  return Object.freeze({
    artifactPackage,
    packageVerificationReceipt,
    manifest,
    handoff: {
      status: 'dry_run_ready',
      envelopeHash: 'sha256:handoff',
      manifestHash: manifest.manifestHash,
    },
    replayGuard: {
      status: 'dry_run_replay_allowed',
      submissionReplayGuardHash: 'sha256:replay',
      manifestHash: manifest.manifestHash,
    },
    reviewedSubmitPreflightPacket,
    dispatchAuthorization: {
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
    },
    submissionDecisionPacket: {
      status: 'reviewed_submission_decision_verified',
      reviewedSubmissionDecisionPacketHash: 'sha256:decision',
      metadata: { title: 'before' },
    },
    artifactBaseRoot: sourceRoot,
  });
}

function stagingResidues(parent, finalName) {
  const pattern = submissionHandoffBundleStagingNamePattern(
    path.join(parent, finalName),
  );
  return fs.readdirSync(parent).filter((name) => pattern.test(
    name.endsWith('.owner.json') ? name.slice(0, -'.owner.json'.length) : name,
  ));
}

async function withPreparedJournalParentFsyncFailure(root, operation) {
  const originalFsyncSync = fs.fsyncSync;
  let injected = false;
  fs.fsyncSync = (descriptor) => {
    const result = originalFsyncSync(descriptor);
    if (!injected && fs.readdirSync(root).some(
      (name) => name.includes('.handoff-publication-')
        && name.endsWith('.prepared.json'),
    )) {
      injected = true;
      throw new Error('injected_handoff_journal_parent_fsync');
    }
    return result;
  };
  try {
    return await operation();
  } finally {
    fs.fsyncSync = originalFsyncSync;
    assert.equal(injected, true);
  }
}

function killedCopyScript({ bundleRoot, packageOutput, phase, root }) {
  const copyModule = new URL(
    '../../paper-adapters/submission/handoff-bundle-sealed-package-copy.mjs',
    import.meta.url,
  ).href;
  const repositoryModule = new URL(
    '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs',
    import.meta.url,
  ).href;
  return `
    import fs from 'node:fs';
    import path from 'node:path';
    import { createFilesystemArtifactRepository } from ${JSON.stringify(repositoryModule)};
    import { copyVerifiedSealedPackageOutputFilesForHandoff } from ${JSON.stringify(copyModule)};
    const repository = createFilesystemArtifactRepository({
      scopeRoot: ${JSON.stringify(root)},
      casRoot: ${JSON.stringify(path.join(root, `.cas-${phase}`))},
      receiptLedger: { record: () => ({ receiptId: ${JSON.stringify(phase)} }) },
      clock: {
        now: () => new Date('2026-07-13T00:00:00.000Z'),
        nowIso: () => '2026-07-13T00:00:00.000Z',
      },
    });
    let killed = false;
    const kill = () => {
      if (!killed) {
        killed = true;
        process.kill(process.pid, 'SIGKILL');
      }
    };
    if (${JSON.stringify(phase)} === 'first-file') {
      const originalLink = fs.linkSync;
      fs.linkSync = (source, target, ...rest) => {
        const result = originalLink(source, target, ...rest);
        const parent = fs.realpathSync.native(path.dirname(String(target)));
        if (parent.endsWith('/sealed-package')) kill();
        return result;
      };
    } else if (${JSON.stringify(phase)} === 'prepared') {
      const originalFsync = fs.fsyncSync;
      fs.fsyncSync = (descriptor) => {
        const result = originalFsync(descriptor);
        if (fs.readdirSync(${JSON.stringify(root)}).some(
          (name) => name.includes('.handoff-publication-')
            && name.endsWith('.prepared.json'),
        )) kill();
        return result;
      };
    } else {
      const originalLink = fs.linkSync;
      fs.linkSync = (source, target, ...rest) => {
        const result = originalLink(source, target, ...rest);
        if (String(target).endsWith('.completed.json')) kill();
        return result;
      };
    }
    await copyVerifiedSealedPackageOutputFilesForHandoff({
      artifactRepository: repository,
      bundleRoot: ${JSON.stringify(bundleRoot)},
      packageOutput: ${JSON.stringify(packageOutput)},
      runtimeRoot: ${JSON.stringify(root)},
    });
  `;
}

test('handoff async entry captures nested data and repository boundaries', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hepta-handoff-snapshot-'));
  t.after(() => {
    restoreOwnerWrite(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sourceRoot = path.join(root, 'source');
  fs.mkdirSync(sourceRoot, { mode: 0o700 });
  const content = Buffer.from('%PDF-snapshot-fixture\n');
  fs.writeFileSync(path.join(sourceRoot, 'paper.pdf'), content, { mode: 0o600 });
  const input = readyInput(sourceRoot, content);
  const repository = { ...artifactRepository(root, 'snapshot') };
  const originalScopeRoot = repository.scopeRoot;
  const originalCasRoot = repository.casRoot;
  const decision = {
    ...input.submissionDecisionPacket,
    metadata: { title: 'before' },
  };
  const bundleRoot = path.join(root, 'bundle');
  const pending = exportSubmissionHandoffBundle({
    ...input,
    artifactRepository: repository,
    bundleRoot,
    submissionDecisionPacket: decision,
  });
  decision.metadata.title = 'after';
  repository.scopeRoot = path.join(root, 'drifted-scope');
  repository.casRoot = path.join(root, 'drifted-cas');
  const exported = await pending;
  assert.equal(exported.status, 'submission_handoff_bundle_exported');
  const document = JSON.parse(fs.readFileSync(
    path.join(bundleRoot, 'SUBMISSION_HANDOFF_MANIFEST.json'),
    'utf8',
  ));
  assert.equal(document.submissionMetadata.title, 'before');
  const replayRepository = {
    ...repository,
    scopeRoot: originalScopeRoot,
    casRoot: originalCasRoot,
  };
  const replayed = await exportSubmissionHandoffBundle({
    ...input,
    artifactRepository: replayRepository,
    bundleRoot,
  });
  assert.equal(replayed.status, 'submission_handoff_bundle_exported');
  assert.equal(replayed.recoveredExistingPublication, true);
});

test('non-BMP artifact paths retain one canonical replay binding', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hepta-handoff-unicode-'));
  t.after(() => {
    restoreOwnerWrite(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sourceRoot = path.join(root, 'source');
  fs.mkdirSync(sourceRoot, { mode: 0o700 });
  const content = Buffer.from('%PDF-unicode-fixture\n');
  fs.writeFileSync(path.join(sourceRoot, '😀.pdf'), content, { mode: 0o600 });
  const base = readyInput(sourceRoot, content);
  const input = {
    ...base,
    artifactPackage: {
      ...base.artifactPackage,
      artifacts: [{ ...base.artifactPackage.artifacts[0], path: '😀.pdf' }],
    },
  };
  const repository = artifactRepository(root, 'unicode');
  const bundleRoot = path.join(root, 'bundle');
  const exported = await exportSubmissionHandoffBundle({
    ...input, artifactRepository: repository, bundleRoot,
  });
  assert.equal(exported.status, 'submission_handoff_bundle_exported');
  const replayed = await exportSubmissionHandoffBundle({
    ...input, artifactRepository: repository, bundleRoot,
  });
  assert.equal(replayed.status, 'submission_handoff_bundle_exported');
  assert.equal(replayed.recoveredExistingPublication, true);
});

test('oversized inputs fail before either handoff entry reserves staging', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hepta-handoff-limit-'));
  t.after(() => {
    restoreOwnerWrite(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sourceRoot = path.join(root, 'source');
  fs.mkdirSync(sourceRoot, { mode: 0o700 });
  const content = Buffer.from('%PDF-limit-fixture\n');
  fs.writeFileSync(path.join(sourceRoot, 'paper.pdf'), content, { mode: 0o600 });
  const base = readyInput(sourceRoot, content);
  const artifact = base.artifactPackage.artifacts[0];
  const input = {
    ...base,
    artifactPackage: {
      ...base.artifactPackage,
      artifacts: Array(SUBMISSION_HANDOFF_BUNDLE_RESOURCE_LIMITS.maximumEntries)
        .fill(artifact),
    },
  };
  const repository = artifactRepository(root, 'limit');
  const exportRoot = path.join(root, 'export-bundle');
  const blocked = await exportSubmissionHandoffBundle({
    ...input, artifactRepository: repository, bundleRoot: exportRoot,
  });
  assert.equal(blocked.status, 'submission_handoff_bundle_blocked');
  assert.ok(blocked.blockers.some((item) => item.startsWith(
    'handoff_bundle_resource_plan_invalid:',
  )));
  assert.equal(fs.existsSync(exportRoot), false);
  assert.deepEqual(stagingResidues(root, path.basename(exportRoot)), []);

  const packageOutput = buildSealedSubmissionHandoffPackageFixture(root);
  const copyRoot = path.join(root, 'copy-bundle');
  const oversizedPackage = {
    ...packageOutput,
    files: Array(SUBMISSION_HANDOFF_BUNDLE_RESOURCE_LIMITS.maximumEntries)
      .fill(packageOutput.files[0]),
    fileCount: SUBMISSION_HANDOFF_BUNDLE_RESOURCE_LIMITS.maximumEntries,
  };
  await assert.rejects(
    () => copyVerifiedSealedPackageOutputFilesForHandoff({
      artifactRepository: repository,
      bundleRoot: copyRoot,
      packageOutput: oversizedPackage,
      runtimeRoot: root,
    }),
    /handoff_bundle_resource_file_inventory_exceeded/,
  );
  assert.equal(fs.existsSync(copyRoot), false);
  assert.deepEqual(stagingResidues(root, path.basename(copyRoot)), []);
  assert.equal(fs.readdirSync(root).some(
    (name) => name.includes('.handoff-publication-'),
  ), false);
});

test('resource planner enforces the exact shared entry, depth, and byte limits', () => {
  const limits = SUBMISSION_HANDOFF_BUNDLE_RESOURCE_LIMITS;
  const atEntryLimit = Array.from(
    { length: limits.maximumEntries - 1 },
    (_, index) => ({ relativePath: `files/${index}`, bytes: 0 }),
  );
  assert.equal(assertSubmissionHandoffBundleResourcePlan({
    files: atEntryLimit,
  }).entryCount, limits.maximumEntries);
  assert.throws(() => assertSubmissionHandoffBundleResourcePlan({
    files: [...atEntryLimit, { relativePath: 'overflow', bytes: 0 }],
  }), /entry_limit_exceeded/);
  assert.throws(() => assertSubmissionHandoffBundleResourcePlan({
    files: [{
      relativePath: `${'nested/'.repeat(limits.maximumDepth)}file`,
      bytes: 0,
    }],
  }), /depth_limit_exceeded/);
  const atByteLimit = Array.from({ length: 16 }, (_, index) => ({
    relativePath: `bytes-${index}`,
    bytes: limits.maximumFileBytes,
  }));
  assert.equal(assertSubmissionHandoffBundleResourcePlan({
    files: atByteLimit,
  }).totalBytes, limits.maximumTotalBytes);
  assert.throws(() => assertSubmissionHandoffBundleResourcePlan({
    files: [...atByteLimit, { relativePath: 'bytes-overflow', bytes: 1 }],
  }), /total_bytes_exceeded/);
  assert.throws(() => assertSubmissionHandoffBundleResourcePlan({
    files: [{ relativePath: 'tree', bytes: 0 },
      { relativePath: 'tree/child', bytes: 0 }],
  }), /path_duplicate/);
});

test('journal and publication moves propagate Node coverage without frozen env', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hepta-handoff-v8-'));
  t.after(() => {
    restoreOwnerWrite(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const coverageRoot = path.join(root, 'coverage');
  fs.mkdirSync(coverageRoot, { mode: 0o700 });
  const publicationModule = new URL(
    '../../paper-adapters/submission/handoff-bundle-publication-repository.mjs',
    import.meta.url,
  ).href;
  const journalModule = new URL(
    '../../paper-adapters/submission/handoff-bundle-publication-journal-repository.mjs',
    import.meta.url,
  ).href;
  const bundleRoot = path.join(root, 'bundle');
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import fs from 'node:fs';
    import path from 'node:path';
    import {
      createSubmissionHandoffBundlePublication,
      createSubmissionHandoffBundlePublicationLineage,
      publishSubmissionHandoffBundle,
    } from ${JSON.stringify(publicationModule)};
    import {
      createRecoverableSubmissionHandoffBundlePublicationJournal,
    } from ${JSON.stringify(journalModule)};
    const root = ${JSON.stringify(root)};
    const publication = createSubmissionHandoffBundlePublication({
      finalRoot: ${JSON.stringify(bundleRoot)},
      repositoryScopeRoot: root,
      repositoryCasRoot: path.join(root, '.cas'),
    });
    fs.writeFileSync(path.join(publication.stagingRoot, 'payload'), 'ok', {
      mode: 0o400,
    });
    fs.chmodSync(publication.stagingRoot, 0o500);
    const lineage = createSubmissionHandoffBundlePublicationLineage(publication);
    createRecoverableSubmissionHandoffBundlePublicationJournal({
      publication,
      submissionHandoffRequestRecoveryBindingHash:
        'sha256:${'1'.repeat(64)}',
      submissionHandoffBundleManifestHash: 'sha256:${'2'.repeat(64)}',
      submissionHandoffBundlePublicationLineageHash:
        lineage.submissionHandoffBundlePublicationLineageHash,
    });
    publishSubmissionHandoffBundle(publication);
  `], {
    encoding: 'utf8',
    env: { ...process.env, NODE_V8_COVERAGE: coverageRoot },
  });
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(fs.existsSync(bundleRoot), true);
  assert.ok(fs.readdirSync(coverageRoot).some((name) => name.endsWith('.json')));
});

test('export retry recovers a journal durable before parent fsync failure', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hepta-export-fsync-'));
  t.after(() => {
    restoreOwnerWrite(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sourceRoot = path.join(root, 'source');
  fs.mkdirSync(sourceRoot, { mode: 0o700 });
  const content = Buffer.from('%PDF-fsync-fixture\n');
  fs.writeFileSync(path.join(sourceRoot, 'paper.pdf'), content, { mode: 0o600 });
  const input = readyInput(sourceRoot, content);
  const repository = artifactRepository(root, 'export-fsync');
  const bundleRoot = path.join(root, 'bundle');
  const failed = await withPreparedJournalParentFsyncFailure(
    root,
    () => exportSubmissionHandoffBundle({
      ...input, artifactRepository: repository, bundleRoot,
    }),
  );
  assert.equal(failed.status, 'submission_handoff_bundle_blocked');
  assert.ok(failed.blockers.some((blocker) => blocker.startsWith(
    'handoff_bundle_publication_journal_invalid:',
  )));
  assert.equal(fs.existsSync(bundleRoot), false);
  assert.ok(stagingResidues(root, path.basename(bundleRoot)).length >= 1);
  const recovered = await exportSubmissionHandoffBundle({
    ...input, artifactRepository: repository, bundleRoot,
  });
  assert.equal(recovered.status, 'submission_handoff_bundle_exported');
  assert.equal(recovered.recoveredExistingPublication, true);
  assert.deepEqual(stagingResidues(root, path.basename(bundleRoot)), []);
});

test('sealed copy retry recovers a journal durable before parent fsync failure', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hepta-copy-fsync-'));
  t.after(() => {
    restoreOwnerWrite(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const packageOutput = buildSealedSubmissionHandoffPackageFixture(root);
  const repository = artifactRepository(root, 'copy-fsync');
  const bundleRoot = path.join(root, 'bundle');
  await assert.rejects(
    () => withPreparedJournalParentFsyncFailure(
      root,
      () => copyVerifiedSealedPackageOutputFilesForHandoff({
        artifactRepository: repository,
        bundleRoot,
        packageOutput,
        runtimeRoot: root,
      }),
    ),
    /injected_handoff_journal_parent_fsync/,
  );
  assert.equal(fs.existsSync(bundleRoot), false);
  assert.ok(stagingResidues(root, path.basename(bundleRoot)).length >= 1);
  const recovered = await copyVerifiedSealedPackageOutputFilesForHandoff({
    artifactRepository: repository,
    bundleRoot,
    packageOutput,
    runtimeRoot: root,
  });
  assert.equal(recovered.fileCount, packageOutput.fileCount);
  assert.deepEqual(stagingResidues(root, path.basename(bundleRoot)), []);
});

test('a concurrent journal loser abandons only its owner-bound stage', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hepta-journal-race-'));
  t.after(() => {
    restoreOwnerWrite(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const repository = artifactRepository(root, 'journal-race');
  const bundleRoot = path.join(root, 'bundle');
  const first = createSubmissionHandoffBundlePublication({
    finalRoot: bundleRoot,
    repositoryScopeRoot: repository.scopeRoot,
    repositoryCasRoot: repository.casRoot,
  });
  const loser = createSubmissionHandoffBundlePublication({
    finalRoot: bundleRoot,
    repositoryScopeRoot: repository.scopeRoot,
    repositoryCasRoot: repository.casRoot,
  });
  fs.chmodSync(first.stagingRoot, 0o500);
  fs.chmodSync(loser.stagingRoot, 0o500);
  const journalInput = (publication) => ({
    publication,
    submissionHandoffRequestRecoveryBindingHash: sha256('shared-binding'),
    submissionHandoffBundleManifestHash: sha256('shared-manifest'),
    submissionHandoffBundlePublicationLineageHash:
      createSubmissionHandoffBundlePublicationLineage(publication)
        .submissionHandoffBundlePublicationLineageHash,
  });
  createRecoverableSubmissionHandoffBundlePublicationJournal(
    journalInput(first),
  );
  assert.throws(
    () => createRecoverableSubmissionHandoffBundlePublicationJournal(
      journalInput(loser),
    ),
    /handoff_bundle_publication_journal_preexisting/,
  );
  assert.equal(fs.existsSync(first.stagingRoot), true);
  assert.equal(fs.existsSync(path.join(
    first.parent,
    first.stagingOwner.markerName,
  )), true);
  assert.equal(fs.existsSync(loser.stagingRoot), false);
  assert.equal(fs.existsSync(path.join(
    loser.parent,
    loser.stagingOwner.markerName,
  )), false);
});

test('marker-only crash residue is bounded and reclaimed by exact ownership', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hepta-marker-only-'));
  t.after(() => {
    restoreOwnerWrite(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const repository = artifactRepository(root, 'marker-only');
  const currentRoot = path.join(root, 'current-bundle');
  const current = createSubmissionHandoffBundlePublication({
    finalRoot: currentRoot,
    repositoryScopeRoot: repository.scopeRoot,
    repositoryCasRoot: repository.casRoot,
  });
  fs.rmdirSync(current.stagingRoot);
  const currentReconciliation =
    reconcileSubmissionHandoffBundleStagingOrphansSync({
      finalRoot: currentRoot,
      repositoryScopeRoot: repository.scopeRoot,
      repositoryCasRoot: repository.casRoot,
    });
  assert.deepEqual(currentReconciliation.activeStages, []);
  assert.equal(currentReconciliation.cleanedStages.length, 1);
  assert.deepEqual(stagingResidues(root, path.basename(currentRoot)), []);

  const crashedRoot = path.join(root, 'crashed-bundle');
  const publicationModule = new URL(
    '../../paper-adapters/submission/handoff-bundle-publication-repository.mjs',
    import.meta.url,
  ).href;
  const killed = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `
      import fs from 'node:fs';
      import { createSubmissionHandoffBundlePublication } from ${JSON.stringify(publicationModule)};
      const publication = createSubmissionHandoffBundlePublication({
        finalRoot: ${JSON.stringify(crashedRoot)},
        repositoryScopeRoot: ${JSON.stringify(repository.scopeRoot)},
        repositoryCasRoot: ${JSON.stringify(repository.casRoot)},
      });
      fs.rmdirSync(publication.stagingRoot);
      process.kill(process.pid, 'SIGKILL');
    `,
  ]);
  assert.equal(killed.signal, 'SIGKILL');
  assert.equal(stagingResidues(root, path.basename(crashedRoot)).length, 1);
  const reconciled = reconcileSubmissionHandoffBundleStagingOrphansSync({
    finalRoot: crashedRoot,
    repositoryScopeRoot: repository.scopeRoot,
    repositoryCasRoot: repository.casRoot,
  });
  assert.deepEqual(reconciled.activeStages, []);
  assert.equal(reconciled.cleanedStages.length, 1);
  assert.deepEqual(stagingResidues(root, path.basename(crashedRoot)), []);
  const retried = createSubmissionHandoffBundlePublication({
    finalRoot: crashedRoot,
    repositoryScopeRoot: repository.scopeRoot,
    repositoryCasRoot: repository.casRoot,
  });
  assert.equal(abandonSubmissionHandoffBundlePublicationSync(retried), true);
});

test('staging inventory counts both roots and owner markers', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hepta-stage-bound-'));
  t.after(() => {
    restoreOwnerWrite(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const repository = artifactRepository(root, 'stage-bound');
  const bundleRoot = path.join(root, 'bundle');
  for (let index = 0; index < 65; index += 1) {
    createSubmissionHandoffBundlePublication({
      finalRoot: bundleRoot,
      repositoryScopeRoot: repository.scopeRoot,
      repositoryCasRoot: repository.casRoot,
    });
  }
  assert.throws(
    () => reconcileSubmissionHandoffBundleStagingOrphansSync({
      finalRoot: bundleRoot,
      repositoryScopeRoot: repository.scopeRoot,
      repositoryCasRoot: repository.casRoot,
    }),
    /handoff_bundle_staging_inventory_exceeded/,
  );
});

test('staging namespaces isolate final roots with the same long prefix', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hepta-stage-ns-'));
  t.after(() => {
    restoreOwnerWrite(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const repository = artifactRepository(root, 'stage-ns');
  const sharedPrefix = 'x'.repeat(80);
  const firstRoot = path.join(root, `${sharedPrefix}-first`);
  const secondRoot = path.join(root, `${sharedPrefix}-second`);
  const publicationModule = new URL(
    '../../paper-adapters/submission/handoff-bundle-publication-repository.mjs',
    import.meta.url,
  ).href;
  const killed = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `
      import { createSubmissionHandoffBundlePublication } from ${JSON.stringify(publicationModule)};
      createSubmissionHandoffBundlePublication({
        finalRoot: ${JSON.stringify(firstRoot)},
        repositoryScopeRoot: ${JSON.stringify(repository.scopeRoot)},
        repositoryCasRoot: ${JSON.stringify(repository.casRoot)},
      });
      process.kill(process.pid, 'SIGKILL');
    `,
  ]);
  assert.equal(killed.signal, 'SIGKILL');
  assert.equal(stagingResidues(root, path.basename(firstRoot)).length, 2);
  assert.deepEqual(stagingResidues(root, path.basename(secondRoot)), []);
  const secondReconciliation =
    reconcileSubmissionHandoffBundleStagingOrphansSync({
      finalRoot: secondRoot,
      repositoryScopeRoot: repository.scopeRoot,
      repositoryCasRoot: repository.casRoot,
    });
  assert.deepEqual(secondReconciliation.activeStages, []);
  assert.deepEqual(secondReconciliation.cleanedStages, []);
  const second = createSubmissionHandoffBundlePublication({
    finalRoot: secondRoot,
    repositoryScopeRoot: repository.scopeRoot,
    repositoryCasRoot: repository.casRoot,
  });
  assert.equal(abandonSubmissionHandoffBundlePublicationSync(second), true);
  assert.equal(stagingResidues(root, path.basename(firstRoot)).length, 2);
  const firstReconciliation =
    reconcileSubmissionHandoffBundleStagingOrphansSync({
      finalRoot: firstRoot,
      repositoryScopeRoot: repository.scopeRoot,
      repositoryCasRoot: repository.casRoot,
    });
  assert.deepEqual(firstReconciliation.activeStages, []);
  assert.equal(firstReconciliation.cleanedStages.length, 1);
  assert.deepEqual(stagingResidues(root, path.basename(firstRoot)), []);
});

test('sealed copy recovers exact output after SIGKILL in every publication phase', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hepta-copy-sigkill-'));
  t.after(() => {
    restoreOwnerWrite(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const packageOutput = buildSealedSubmissionHandoffPackageFixture(root);
  for (const phase of ['first-file', 'prepared', 'completed']) {
    const bundleRoot = path.join(root, `${phase}-bundle`);
    const killed = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      killedCopyScript({ bundleRoot, packageOutput, phase, root }),
    ]);
    assert.equal(killed.signal, 'SIGKILL', phase);
    assert.equal(fs.existsSync(bundleRoot), phase === 'completed', phase);
    const repository = artifactRepository(root, phase);
    const recovered = await copyVerifiedSealedPackageOutputFilesForHandoff({
      artifactRepository: repository,
      bundleRoot,
      packageOutput,
      runtimeRoot: root,
    });
    assert.equal(recovered.fileCount, packageOutput.fileCount, phase);
    assert.deepEqual(stagingResidues(root, path.basename(bundleRoot)), [], phase);
    const replayed = await copyVerifiedSealedPackageOutputFilesForHandoff({
      artifactRepository: repository,
      bundleRoot,
      packageOutput,
      runtimeRoot: root,
    });
    assert.deepEqual(replayed, recovered, phase);
  }
});
