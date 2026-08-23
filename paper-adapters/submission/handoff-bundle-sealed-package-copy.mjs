import fs from 'node:fs';
import path from 'node:path';

import { assertArtifactRepository } from '../../paper-ports/artifact-repository-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  readScopedFileSync,
} from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import {
  assertSealedImmutableCampaignPackageFilesSync,
} from '../automation/campaign-release-materialization.mjs';
import {
  captureSubmissionHandoffArtifactRepositoryBoundary,
} from './handoff-artifact-repository-boundary.mjs';
import {
  assertSubmissionHandoffSealedPackageCopySync,
  inspectSubmissionHandoffBundleTreeSync,
  sealSubmissionHandoffBundleTreeSync,
} from './handoff-bundle-integrity.mjs';
import {
  createSubmissionHandoffBundlePinnedWriter,
} from './handoff-bundle-pinned-writer.mjs';
import {
  assertSubmissionHandoffSealedCopyInputInventory,
  assertSubmissionHandoffSealedCopyResourcePlan,
} from './handoff-bundle-resource-plan.mjs';
import {
  abandonSubmissionHandoffBundlePublicationSync,
  createSubmissionHandoffBundlePublication,
  createSubmissionHandoffBundlePublicationLineage,
  publishSubmissionHandoffBundle,
  reconcileSubmissionHandoffBundleStagingOrphansSync,
  recoverSubmissionHandoffBundlePublication,
} from './handoff-bundle-publication-repository.mjs';
import {
  assertSubmissionHandoffBundlePublicationJournalForRecovery,
  completeSubmissionHandoffBundlePublicationJournal,
  createRecoverableSubmissionHandoffBundlePublicationJournal,
  inspectSubmissionHandoffBundlePublicationJournal,
} from './handoff-bundle-publication-journal-repository.mjs';

const TRANSACTION_FILE = 'SEALED_PACKAGE_COPY_TRANSACTION.json';
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COPY_FILE_KEYS = Object.freeze([
  'bundlePath',
  'bytes',
  'capsuleRole',
  'executionRole',
  'experimentId',
  'hash',
  'packageRelativePath',
  'role',
  'sourceReadReceiptHash',
  'writeReceiptHash',
]);
const TRANSACTION_KEYS = Object.freeze([
  'externalActionPerformed',
  'fileCount',
  'fileSetHash',
  'files',
  'immutableCampaignPackageOutputHash',
  'kind',
  'status',
  'submissionHandoffBundlePublicationLineage',
  'submissionHandoffSealedPackageCopyBindingHash',
  'submissionHandoffSealedPackageCopyTransactionHash',
  'version',
]);

function portableRelativePath(value) {
  const relative = String(value || '').replace(/\\/gu, '/');
  if (!relative || relative.startsWith('/')
    || relative.split('/').some(
      (segment) => !segment || segment === '.' || segment === '..',
    )) {
    throw new Error('handoff_sealed_package_relative_path_invalid');
  }
  return relative;
}

export function inspectSealedPackageOutputFilesSync({
  packageOutput,
  runtimeRoot,
} = {}) {
  const resolvedRuntimeRoot = path.resolve(runtimeRoot || '.');
  assertSubmissionHandoffSealedCopyInputInventory(packageOutput?.files);
  inspectSubmissionHandoffBundleTreeSync({
    bundleRoot: packageOutput?.packageDir,
    errorPrefix: 'handoff_sealed_package_source',
    requireReadOnly: true,
  });
  assertSealedImmutableCampaignPackageFilesSync(
    packageOutput,
    resolvedRuntimeRoot,
  );
  const packageRoot = path.resolve(packageOutput.packageDir);
  const descriptors = [];
  const relativePaths = new Set();
  for (const file of packageOutput.files) {
    const candidate = path.resolve(file?.path || '.');
    if (candidate === packageRoot || !isPathWithin(packageRoot, candidate)) {
      throw new Error(
        `handoff_sealed_package_file_scope_invalid:${
          file?.role || 'unknown'}`,
      );
    }
    const relative = portableRelativePath(path.relative(packageRoot, candidate));
    if (file.packageRelativePath !== undefined
      && portableRelativePath(file.packageRelativePath) !== relative) {
      throw new Error(
        `handoff_sealed_package_file_relative_path_mismatch:${
          file?.role || 'unknown'}`,
      );
    }
    if (relativePaths.has(relative)) {
      throw new Error('handoff_sealed_package_file_path_duplicate');
    }
    relativePaths.add(relative);
    const read = readScopedFileSync({ scopeRoot: packageRoot, candidate });
    if (read.status !== 'scoped_file_read_verified') {
      throw new Error(
        `handoff_sealed_package_file_read_blocked:${file?.role || 'unknown'}`,
      );
    }
    if (read.hash !== file.hash) {
      throw new Error(
        `handoff_sealed_package_file_hash_mismatch:${file?.role || 'unknown'}`,
      );
    }
    if (!Number.isSafeInteger(Number(file.bytes)) || Number(file.bytes) < 0
      || read.bytes !== Number(file.bytes)) {
      throw new Error(
        `handoff_sealed_package_file_size_mismatch:${file?.role || 'unknown'}`,
      );
    }
    const fileSnapshot = Object.freeze(JSON.parse(JSON.stringify(file)));
    descriptors.push(Object.freeze({
      file: fileSnapshot,
      relative,
      read,
    }));
  }
  descriptors.sort((left, right) => left.relative.localeCompare(right.relative));
  const inspection = Object.freeze({
    packageRoot,
    immutableCampaignPackageOutputHash:
      packageOutput.immutableCampaignPackageOutputHash,
    descriptors: Object.freeze(descriptors),
  });
  assertSubmissionHandoffSealedCopyResourcePlan(inspection);
  return inspection;
}

export async function copyInspectedSealedPackageOutputFiles({
  artifactRepository,
  bundleRoot,
  inspection,
}) {
  const copied = [];
  for (const { file, relative, read } of inspection.descriptors) {
    const target = path.join(
      bundleRoot,
      'sealed-package',
      ...relative.split('/'),
    );
    const write = await artifactRepository.writeBytes(target, read.content, {
      role: `submission_handoff_sealed_package:${file.role || 'file'}`,
    });
    if (write.hash !== file.hash || Number(write.bytes) !== Number(file.bytes)) {
      throw new Error(
        `handoff_sealed_package_copy_write_identity_mismatch:${
          file.role || 'unknown'}`,
      );
    }
    copied.push(Object.freeze({
      role: file.role || null,
      capsuleRole: file.capsuleRole || null,
      executionRole: file.executionRole || null,
      experimentId: file.experimentId || null,
      packageRelativePath: relative,
      bundlePath: path.relative(bundleRoot, target).replace(/\\/gu, '/'),
      hash: file.hash,
      bytes: Number(file.bytes),
      sourceReadReceiptHash: read.scopedFileReadReceiptHash,
      writeReceiptHash: write.writeReceiptHash,
    }));
  }
  assertSubmissionHandoffSealedPackageCopySync(bundleRoot, copied);
  const portableFiles = copied.map((file) => ({
    role: file.role,
    capsuleRole: file.capsuleRole,
    executionRole: file.executionRole,
    experimentId: file.experimentId,
    packageRelativePath: file.packageRelativePath,
    bundlePath: file.bundlePath,
    hash: file.hash,
    bytes: file.bytes,
  }));
  return Object.freeze({
    immutableCampaignPackageOutputHash:
      inspection.immutableCampaignPackageOutputHash,
    files: Object.freeze(copied),
    fileCount: copied.length,
    fileSetHash: hashRecord(
      'SubmissionHandoffSealedPackageFileSet',
      portableFiles,
    ),
  });
}

function hasExactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0')
      === [...expected].sort().join('\0');
}

function portableFiles(files) {
  return files.map((file) => ({
    role: file.role,
    capsuleRole: file.capsuleRole,
    executionRole: file.executionRole,
    experimentId: file.experimentId,
    packageRelativePath: file.packageRelativePath,
    bundlePath: file.bundlePath,
    hash: file.hash,
    bytes: file.bytes,
  }));
}

function copyBindingHash({ immutableCampaignPackageOutputHash, files }) {
  return hashRecord('SubmissionHandoffSealedPackageCopyBinding', {
    version: 1,
    kind: 'SubmissionHandoffSealedPackageCopyBinding',
    immutableCampaignPackageOutputHash,
    files: portableFiles(files),
  });
}

function expectedCopyBindingHash(inspection) {
  return copyBindingHash({
    immutableCampaignPackageOutputHash:
      inspection.immutableCampaignPackageOutputHash,
    files: inspection.descriptors.map(({ file, relative }) => ({
      role: file.role || null,
      capsuleRole: file.capsuleRole || null,
      executionRole: file.executionRole || null,
      experimentId: file.experimentId || null,
      packageRelativePath: relative,
      bundlePath: `sealed-package/${relative}`,
      hash: file.hash,
      bytes: Number(file.bytes),
    })),
  });
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function expectedDirectories(relativePaths) {
  const directories = new Set();
  for (const relative of relativePaths) {
    const parts = relative.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join('/'));
    }
  }
  return directories;
}

function sameSet(left, right) {
  return left.size === right.size
    && [...left].every((entry) => right.has(entry));
}

function assertPublicationLineage(lineage) {
  const keys = [
    'finalName',
    'kind',
    'parentIdentity',
    'stagingIdentity',
    'submissionHandoffBundlePublicationHash',
    'submissionHandoffBundlePublicationLineageHash',
    'version',
  ];
  const payload = { ...(lineage || {}) };
  delete payload.submissionHandoffBundlePublicationLineageHash;
  if (!hasExactKeys(lineage, keys)
    || lineage.version !== 1
    || lineage.kind !== 'SubmissionHandoffBundlePublicationLineage'
    || !SHA256.test(String(
      lineage.submissionHandoffBundlePublicationHash || '',
    ))
    || lineage.submissionHandoffBundlePublicationLineageHash !== hashRecord(
      'SubmissionHandoffBundlePublicationLineage',
      payload,
    )) {
    throw new Error('handoff_sealed_package_copy_lineage_invalid');
  }
}

function transactionPayload(transaction) {
  const payload = { ...transaction };
  delete payload.submissionHandoffSealedPackageCopyTransactionHash;
  return payload;
}

function assertCopyTransaction(transaction, {
  expectedBindingHash: bindingHash,
  expectedLineageHash = null,
} = {}) {
  const files = Array.isArray(transaction?.files) ? transaction.files : [];
  if (!hasExactKeys(transaction, TRANSACTION_KEYS)
    || transaction.version !== 1
    || transaction.kind !== 'SubmissionHandoffSealedPackageCopyTransaction'
    || transaction.status !== 'submission_handoff_sealed_package_copy_prepared'
    || transaction.externalActionPerformed !== false
    || !SHA256.test(String(
      transaction.immutableCampaignPackageOutputHash || '',
    ))
    || !SHA256.test(String(transaction.fileSetHash || ''))
    || !SHA256.test(String(
      transaction.submissionHandoffSealedPackageCopyBindingHash || '',
    ))
    || !SHA256.test(String(
      transaction.submissionHandoffSealedPackageCopyTransactionHash || '',
    ))
    || files.length !== Number(transaction.fileCount)
    || !files.every((file) => hasExactKeys(file, COPY_FILE_KEYS)
      && portableRelativePath(file.packageRelativePath)
        === file.packageRelativePath
      && file.bundlePath === `sealed-package/${file.packageRelativePath}`
      && SHA256.test(String(file.hash || ''))
      && SHA256.test(String(file.sourceReadReceiptHash || ''))
      && SHA256.test(String(file.writeReceiptHash || ''))
      && Number.isSafeInteger(Number(file.bytes)) && Number(file.bytes) >= 0)
    || transaction.fileSetHash !== hashRecord(
      'SubmissionHandoffSealedPackageFileSet',
      portableFiles(files),
    )
    || transaction.submissionHandoffSealedPackageCopyBindingHash
      !== copyBindingHash(transaction)
    || transaction.submissionHandoffSealedPackageCopyBindingHash
      !== bindingHash
    || transaction.submissionHandoffSealedPackageCopyTransactionHash
      !== hashRecord(
        'SubmissionHandoffSealedPackageCopyTransaction',
        transactionPayload(transaction),
      )) {
    throw new Error('handoff_sealed_package_copy_transaction_invalid');
  }
  assertPublicationLineage(
    transaction.submissionHandoffBundlePublicationLineage,
  );
  if (expectedLineageHash
    && transaction.submissionHandoffBundlePublicationLineage
      .submissionHandoffBundlePublicationLineageHash !== expectedLineageHash) {
    throw new Error('handoff_sealed_package_copy_lineage_mismatch');
  }
  return transaction;
}

function createCopyTransaction({
  copy,
  expectedBindingHash: bindingHash,
  publicationLineage,
}) {
  const payload = {
    version: 1,
    kind: 'SubmissionHandoffSealedPackageCopyTransaction',
    status: 'submission_handoff_sealed_package_copy_prepared',
    immutableCampaignPackageOutputHash:
      copy.immutableCampaignPackageOutputHash,
    files: copy.files,
    fileCount: copy.fileCount,
    fileSetHash: copy.fileSetHash,
    submissionHandoffSealedPackageCopyBindingHash: bindingHash,
    submissionHandoffBundlePublicationLineage: publicationLineage,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    submissionHandoffSealedPackageCopyTransactionHash: hashRecord(
      'SubmissionHandoffSealedPackageCopyTransaction',
      payload,
    ),
  });
}

function copyResult(transaction) {
  return Object.freeze({
    immutableCampaignPackageOutputHash:
      transaction.immutableCampaignPackageOutputHash,
    files: Object.freeze(transaction.files.map((file) => Object.freeze({
      ...file,
    }))),
    fileCount: transaction.fileCount,
    fileSetHash: transaction.fileSetHash,
  });
}

function readVerifiedCopyTransaction({
  bundleRoot,
  expectedBindingHash: bindingHash,
  journalRecord,
}) {
  const selectedRoot = path.resolve(bundleRoot);
  const root = fs.lstatSync(selectedRoot, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink()
    || String(root.dev) !== journalRecord.stagingIdentity.dev
    || String(root.ino) !== journalRecord.stagingIdentity.ino) {
    throw new Error('handoff_sealed_package_copy_root_identity_invalid');
  }
  const read = readScopedFileSync({
    scopeRoot: selectedRoot,
    candidate: path.join(selectedRoot, TRANSACTION_FILE),
  });
  if (read.status !== 'scoped_file_read_verified') {
    throw new Error('handoff_sealed_package_copy_transaction_unreadable');
  }
  let transaction;
  try { transaction = JSON.parse(read.content.toString('utf8')); } catch {
    throw new Error('handoff_sealed_package_copy_transaction_json_invalid');
  }
  assertCopyTransaction(transaction, {
    expectedBindingHash: bindingHash,
    expectedLineageHash:
      journalRecord.submissionHandoffBundlePublicationLineageHash,
  });
  if (transaction.submissionHandoffSealedPackageCopyTransactionHash
      !== journalRecord.submissionHandoffBundleManifestHash
    || transaction.submissionHandoffBundlePublicationLineage
      .submissionHandoffBundlePublicationHash
        !== journalRecord.submissionHandoffBundlePublicationHash
    || !read.content.equals(canonicalJsonBytes(transaction))) {
    throw new Error('handoff_sealed_package_copy_journal_binding_invalid');
  }
  const expectedFiles = new Set([
    TRANSACTION_FILE,
    ...transaction.files.map((file) => file.bundlePath),
  ]);
  const actual = inspectSubmissionHandoffBundleTreeSync({
    bundleRoot: selectedRoot,
    errorPrefix: 'handoff_sealed_package_copy_root',
    requireReadOnly: true,
  });
  if (!sameSet(expectedFiles, actual.files)
    || !sameSet(expectedDirectories(expectedFiles), actual.directories)) {
    throw new Error('handoff_sealed_package_copy_root_exact_tree_invalid');
  }
  assertSubmissionHandoffSealedPackageCopySync(
    selectedRoot,
    transaction.files,
  );
  return Object.freeze(transaction);
}

function inspectFinalRoot(bundleRoot) {
  try {
    fs.lstatSync(path.resolve(bundleRoot));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw new Error('handoff_bundle_final_state_unreadable', { cause: error });
  }
}

function journalForBinding(state, bindingHash, { allowCompleted = false } = {}) {
  return assertSubmissionHandoffBundlePublicationJournalForRecovery(state, {
    allowCompleted,
    submissionHandoffRequestRecoveryBindingHash: bindingHash,
  });
}

function recoverCopyTransaction({
  artifactRepository,
  bindingHash,
  bundleRoot,
  finalExists,
  journalState,
}) {
  const completed = journalState.status
    === 'submission_handoff_bundle_publication_journal_completed';
  const journal = journalForBinding(journalState, bindingHash, {
    allowCompleted: completed,
  });
  if (completed && !finalExists) {
    throw new Error('handoff_sealed_package_copy_completed_final_missing');
  }
  const sourceRoot = finalExists
    ? path.resolve(bundleRoot) : journal.publication.stagingRoot;
  const transaction = readVerifiedCopyTransaction({
    bundleRoot: sourceRoot,
    expectedBindingHash: bindingHash,
    journalRecord: journal,
  });
  if (!finalExists) publishSubmissionHandoffBundle(journal.publication);
  else if (!completed) {
    recoverSubmissionHandoffBundlePublication({
      finalRoot: bundleRoot,
      repositoryScopeRoot: artifactRepository.scopeRoot,
      repositoryCasRoot: artifactRepository.casRoot,
      publicationLineage:
        transaction.submissionHandoffBundlePublicationLineage,
    });
  }
  const durable = readVerifiedCopyTransaction({
    bundleRoot,
    expectedBindingHash: bindingHash,
    journalRecord: journal,
  });
  completeSubmissionHandoffBundlePublicationJournal(journalState);
  return copyResult(durable);
}

export async function copyVerifiedSealedPackageOutputFilesForHandoff({
  artifactRepository,
  bundleRoot,
  packageOutput,
  runtimeRoot,
} = {}) {
  assertArtifactRepository(artifactRepository);
  if (!bundleRoot) throw new Error('handoff_bundle_root_missing');
  const artifactRepositoryBoundary =
    captureSubmissionHandoffArtifactRepositoryBoundary(artifactRepository);
  const inspection = inspectSealedPackageOutputFilesSync({
    packageOutput,
    runtimeRoot,
  });
  const bindingHash = expectedCopyBindingHash(inspection);
  const journalOptions = {
    finalRoot: bundleRoot,
    repositoryScopeRoot: artifactRepositoryBoundary.scopeRoot,
    repositoryCasRoot: artifactRepositoryBoundary.casRoot,
  };
  const finalExists = inspectFinalRoot(bundleRoot);
  const journalState = inspectSubmissionHandoffBundlePublicationJournal(
    journalOptions,
  );
  if (finalExists) {
    if (journalState.status
        === 'submission_handoff_bundle_publication_journal_absent') {
      throw new Error('handoff_bundle_preexisting_collision');
    }
    return recoverCopyTransaction({
      artifactRepository: artifactRepositoryBoundary,
      bindingHash,
      bundleRoot,
      finalExists,
      journalState,
    });
  }
  if (journalState.status
      !== 'submission_handoff_bundle_publication_journal_absent') {
    return recoverCopyTransaction({
      artifactRepository: artifactRepositoryBoundary,
      bindingHash,
      bundleRoot,
      finalExists,
      journalState,
    });
  }
  const staging = reconcileSubmissionHandoffBundleStagingOrphansSync({
    finalRoot: bundleRoot,
    repositoryScopeRoot: artifactRepositoryBoundary.scopeRoot,
    repositoryCasRoot: artifactRepositoryBoundary.casRoot,
  });
  if (staging.activeStages.length) {
    throw new Error('handoff_bundle_publication_in_progress');
  }
  const publication = createSubmissionHandoffBundlePublication({
    finalRoot: bundleRoot,
    repositoryScopeRoot: artifactRepositoryBoundary.scopeRoot,
    repositoryCasRoot: artifactRepositoryBoundary.casRoot,
  });
  let journalAttempted = false;
  try {
    const writer = createSubmissionHandoffBundlePinnedWriter({
      bundleRoot: publication.stagingRoot,
      expectedRootIdentity: publication.stagingIdentity,
    });
    const copy = await copyInspectedSealedPackageOutputFiles({
      artifactRepository: writer,
      bundleRoot: publication.stagingRoot,
      inspection,
    });
    const publicationLineage =
      createSubmissionHandoffBundlePublicationLineage(publication);
    const transaction = createCopyTransaction({
      copy,
      expectedBindingHash: bindingHash,
      publicationLineage,
    });
    assertSubmissionHandoffSealedCopyResourcePlan(inspection, {
      controlDocument: transaction,
    });
    await writer.writeJson(
      path.join(publication.stagingRoot, TRANSACTION_FILE),
      transaction,
      { role: 'submission_handoff_sealed_package_copy_transaction' },
    );
    sealSubmissionHandoffBundleTreeSync({
      bundleRoot: publication.stagingRoot,
      errorPrefix: 'handoff_sealed_package_copy_root',
    });
    journalAttempted = true;
    const prepared = createRecoverableSubmissionHandoffBundlePublicationJournal({
      publication,
      submissionHandoffRequestRecoveryBindingHash: bindingHash,
      submissionHandoffBundleManifestHash:
        transaction.submissionHandoffSealedPackageCopyTransactionHash,
      submissionHandoffBundlePublicationLineageHash:
        publicationLineage.submissionHandoffBundlePublicationLineageHash,
    });
    const verified = readVerifiedCopyTransaction({
      bundleRoot: publication.stagingRoot,
      expectedBindingHash: bindingHash,
      journalRecord: prepared.entry.record,
    });
    publishSubmissionHandoffBundle(publication);
    const durable = readVerifiedCopyTransaction({
      bundleRoot: publication.finalRoot,
      expectedBindingHash: bindingHash,
      journalRecord: prepared.entry.record,
    });
    completeSubmissionHandoffBundlePublicationJournal(prepared);
    return copyResult(durable || verified);
  } catch (error) {
    if (!journalAttempted) {
      try { abandonSubmissionHandoffBundlePublicationSync(publication); } catch {
        /* A later process can reconcile the exact owner-bound staging root. */
      }
    }
    throw error;
  }
}
