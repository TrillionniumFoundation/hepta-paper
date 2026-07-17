import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { fsyncDirectoryPathSync } from '../runtime/scoped-file-materialization-path-io.mjs';
import {
  abortStagedScopedFileSync,
  cleanupStagedScopedFileSync,
  commitStagedScopedFileSync,
  ensureScopedDirectorySync,
  inspectScopedRegularFileSync,
  inspectScopedRegularFileWithRecoverySync,
  normalizeScopedRelativePath,
  recoverScopedMaterializationIntentsSync,
  removeScopedRegularFileSync,
  stageScopedRegularFileCopySync,
} from '../runtime/scoped-file-materialization-repository.mjs';
import {
  acquireWorkspaceCommitLock,
  loadOrCreateWorkspaceIntegrationJournalSync,
  persistWorkspaceIntegrationJournalSync,
  workspaceIntegrationJournalOperations,
  workspaceIntegrationJournalPathSync,
  workspaceIntegrationStageId,
} from './workspace-attempt-commit-journal-repository.mjs';
import {
  buildWorkspaceIntegrationDescriptorSync,
  validateWorkspaceIntegrationAuthority,
  verifyWorkspaceIntegrationDescriptor,
} from './workspace-attempt-descriptor.mjs';
import { workspaceAttemptIntegrationError as integrationError } from './workspace-attempt-errors.mjs';
import {
  validateWorkspaceAttemptSourceReadSet,
  workspaceAttemptRowsEqual,
  workspaceAttemptSnapshotMatchesExact,
} from './workspace-attempt-manifest.mjs';
import {
  assertCurrentWorkspaceAttemptRootIdentity,
  assertDisjointWorkspaceAttemptRoots,
  DEFAULT_WORKSPACE_ATTEMPT_EXCLUDED_NAMES,
  effectiveWorkspaceAttemptExcludedNames,
  isWorkspaceAttemptEntryExcluded,
  snapshotWorkspaceFilesSync,
  workspaceAttemptPathEntryExistsSync,
  workspaceAttemptRelativePath,
  workspaceAttemptRootIdentitySync,
} from './workspace-attempt-root-snapshot.mjs';

export { buildWorkspaceIntegrationDescriptorSync, snapshotWorkspaceFilesSync };

function cloneWorkspaceTreeSync({ sourceRoot, destinationBaseRoot, destinationRelative, excludedNames }) {
  const source = workspaceAttemptRootIdentitySync(sourceRoot, 'source').realPath;
  const destinationBase = workspaceAttemptRootIdentitySync(destinationBaseRoot, 'runtime').realPath;
  const destination = ensureScopedDirectorySync({
    scopeRoot: destinationBase,
    relative: destinationRelative,
  });
  const excluded = effectiveWorkspaceAttemptExcludedNames(
    excludedNames || DEFAULT_WORKSPACE_ATTEMPT_EXCLUDED_NAMES,
  );
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const candidate = path.join(directory, entry.name);
      const relative = workspaceAttemptRelativePath(source, candidate);
      if (isWorkspaceAttemptEntryExcluded(entry, relative, excluded)) continue;
      const stat = fs.lstatSync(candidate);
      const destinationPath = `${destinationRelative}/${relative}`;
      if (stat.isDirectory()) {
        ensureScopedDirectorySync({ scopeRoot: destinationBase, relative: destinationPath });
        walk(candidate);
      } else if (stat.isFile()) {
        let staged = null;
        try {
          staged = stageScopedRegularFileCopySync({
            sourceRoot: source,
            destinationRoot: destinationBase,
            relative,
            destinationRelative: destinationPath,
            stageId: `clone-${crypto.createHash('sha256').update(`${destinationPath}\0${relative}`).digest('hex')}`,
            expectedHash: null,
          });
          commitStagedScopedFileSync(staged, {
            destinationRoot: destinationBase,
            expectedHash: null,
          });
        } finally {
          abortStagedScopedFileSync(staged);
        }
      } else if (!stat.isSymbolicLink()) {
        throw integrationError('workspace_attempt_special_file_forbidden', { detail: relative });
      }
      // Source symlinks remain part of the read-set but are deliberately not cloned.
    }
  };
  walk(source);
  return fs.realpathSync.native(destination);
}

export function prepareWorkspaceAttemptSync({
  sourceRoot,
  attemptBaseRoot,
  attemptRelative,
  campaignId,
  nodeId,
  attemptId,
  excludedNames = DEFAULT_WORKSPACE_ATTEMPT_EXCLUDED_NAMES,
} = {}) {
  if (!sourceRoot || !attemptBaseRoot || !attemptRelative) {
    throw integrationError('workspace_attempt_source_base_relative_required');
  }
  if (!campaignId || !nodeId || !attemptId) throw integrationError('workspace_attempt_identity_required');
  const sourceIdentity = workspaceAttemptRootIdentitySync(sourceRoot, 'source');
  const runtimeIdentity = workspaceAttemptRootIdentitySync(attemptBaseRoot, 'runtime');
  const normalizedAttemptRelative = normalizeScopedRelativePath(attemptRelative);
  const intendedDestination = path.resolve(
    runtimeIdentity.realPath,
    ...normalizedAttemptRelative.split('/'),
  );
  if (!isPathWithin(runtimeIdentity.realPath, intendedDestination)) {
    throw integrationError('workspace_attempt_runtime_escape');
  }
  if (isPathWithin(sourceIdentity.realPath, intendedDestination)
    || isPathWithin(intendedDestination, sourceIdentity.realPath)) {
    throw integrationError('workspace_attempt_roots_overlap');
  }
  if (workspaceAttemptPathEntryExistsSync(intendedDestination)) {
    throw integrationError('workspace_attempt_already_exists');
  }

  const excluded = effectiveWorkspaceAttemptExcludedNames(excludedNames);
  const sourceBaseline = snapshotWorkspaceFilesSync({
    root: sourceIdentity.realPath,
    excludedNames: excluded,
  });
  let attemptWorkspace = null;
  try {
    attemptWorkspace = cloneWorkspaceTreeSync({
      sourceRoot: sourceIdentity.realPath,
      destinationBaseRoot: runtimeIdentity.realPath,
      destinationRelative: normalizedAttemptRelative,
      excludedNames: excluded,
    });
    const attemptIdentity = workspaceAttemptRootIdentitySync(attemptWorkspace, 'attempt');
    assertDisjointWorkspaceAttemptRoots(sourceIdentity, attemptIdentity);
    const sourceAfterClone = snapshotWorkspaceFilesSync({
      root: sourceIdentity.realPath,
      excludedNames: excluded,
    });
    if (!workspaceAttemptRowsEqual(sourceBaseline, sourceAfterClone)) {
      throw integrationError('workspace_attempt_source_changed_during_clone', { retryable: true });
    }
    const attemptBaseline = snapshotWorkspaceFilesSync({
      root: attemptWorkspace,
      excludedNames: excluded,
    });
    const expectedClone = new Map(
      [...sourceBaseline.entries()].filter(([, hash]) => !String(hash || '').startsWith('unsafe:')),
    );
    if (!workspaceAttemptRowsEqual(expectedClone, attemptBaseline)) {
      throw integrationError('workspace_attempt_clone_manifest_mismatch', { retryable: true });
    }
    return Object.freeze({
      campaignId: String(campaignId),
      nodeId: String(nodeId),
      originalAttemptId: String(attemptId),
      sourceWorkspace: sourceIdentity.realPath,
      attemptWorkspace: attemptIdentity.realPath,
      runtimeRoot: runtimeIdentity.realPath,
      sourceRootIdentity: sourceIdentity,
      attemptRootIdentity: attemptIdentity,
      sourceBaseline,
      attemptBaseline,
      excludedNames: [...excluded].sort(),
    });
  } catch (error) {
    const cleanupPath = attemptWorkspace || intendedDestination;
    if (isPathWithin(runtimeIdentity.realPath, cleanupPath)) {
      try {
        const existed = workspaceAttemptPathEntryExistsSync(cleanupPath);
        fs.rmSync(cleanupPath, { recursive: true, force: true });
        if (existed) fsyncDirectoryPathSync(path.dirname(cleanupPath));
      } catch {}
    }
    throw error;
  }
}

export function integrateWorkspaceAttemptSync(descriptor = {}, {
  authority = null,
  expected = null,
  executionSignal = null,
  faultInjector = null,
} = {}) {
  const verified = verifyWorkspaceIntegrationDescriptor(descriptor);
  const { sourceIdentity, attemptIdentity, runtimeIdentity } = validateWorkspaceIntegrationAuthority(
    descriptor,
    expected || authority || {},
  );
  const lock = acquireWorkspaceCommitLock({
    runtimeRoot: runtimeIdentity.realPath,
    sourceIdentity,
    descriptorHash: descriptor.workspaceAttemptIntegrationDescriptorHash,
  });
  const immutableOperations = workspaceIntegrationJournalOperations(verified.changes);
  const journalPath = workspaceIntegrationJournalPathSync(
    runtimeIdentity.realPath,
    descriptor.workspaceAttemptIntegrationDescriptorHash,
  );
  const alreadyIntegrated = [];
  try {
    lock.assertOwned();
    assertCurrentWorkspaceAttemptRootIdentity(
      sourceIdentity.realPath,
      descriptor.sourceRootIdentity,
      'source',
    );
    assertCurrentWorkspaceAttemptRootIdentity(
      attemptIdentity.realPath,
      descriptor.attemptRootIdentity,
      'attempt',
    );
    recoverScopedMaterializationIntentsSync({ scopeRoot: sourceIdentity.realPath });
    lock.assertOwned();
    assertCurrentWorkspaceAttemptRootIdentity(
      sourceIdentity.realPath,
      descriptor.sourceRootIdentity,
      'source',
    );
    for (const change of verified.changes) {
      if (change.postimageHash !== null) {
        cleanupStagedScopedFileSync({
          destinationRoot: sourceIdentity.realPath,
          relative: change.path,
          stageId: workspaceIntegrationStageId(
            descriptor.workspaceAttemptIntegrationDescriptorHash,
            change.path,
          ),
        });
      }
    }
    const excludedNames = new Set(descriptor.excludedNames);
    const attemptCurrent = snapshotWorkspaceFilesSync({
      root: attemptIdentity.realPath,
      excludedNames,
    });
    if (!workspaceAttemptSnapshotMatchesExact(attemptCurrent, verified.attemptPostimage)) {
      throw integrationError('workspace_attempt_postimage_manifest_mismatch');
    }
    const sourceCurrent = snapshotWorkspaceFilesSync({
      root: sourceIdentity.realPath,
      excludedNames,
    });
    validateWorkspaceAttemptSourceReadSet(
      sourceCurrent,
      verified.sourceReadSet,
      verified.changes,
    );

    const currentByPath = new Map();
    const conflicts = [];
    for (const change of verified.changes) {
      let attemptFile;
      let sourceFile;
      try {
        attemptFile = inspectScopedRegularFileSync({
          scopeRoot: attemptIdentity.realPath,
          relative: change.path,
        });
      } catch (error) {
        throw integrationError('workspace_attempt_postimage_unsafe', {
          detail: `${change.path}:${error?.code || 'identity_failed'}`,
        });
      }
      if (attemptFile.hash !== change.postimageHash) {
        throw integrationError('workspace_attempt_postimage_mismatch', { detail: change.path });
      }
      try {
        sourceFile = inspectScopedRegularFileSync({
          scopeRoot: sourceIdentity.realPath,
          relative: change.path,
        });
      } catch (error) {
        throw integrationError('workspace_attempt_source_unsafe', {
          detail: `${change.path}:${error?.code || 'identity_failed'}`,
        });
      }
      currentByPath.set(change.path, sourceFile.hash);
      if (sourceFile.hash === change.postimageHash) alreadyIntegrated.push(change.path);
      else if (sourceFile.hash !== change.preimageHash) conflicts.push(change.path);
    }
    if (conflicts.length) {
      const error = integrationError('workspace_attempt_integration_conflict', {
        retryable: true,
        detail: conflicts.join(','),
      });
      error.conflicts = conflicts;
      throw error;
    }

    let journal = loadOrCreateWorkspaceIntegrationJournalSync({
      journalPath,
      descriptor,
      immutableOperations,
    });
    const operations = journal.operations.map((operation) => ({ ...operation }));
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      const currentHash = currentByPath.get(operation.path);
      if (operation.status === 'applied' && currentHash !== operation.postimageHash) {
        throw integrationError('workspace_attempt_integration_journal_regressed', {
          detail: operation.path,
        });
      }
      if (currentHash === operation.postimageHash && operation.status !== 'applied') {
        operation.status = 'applied';
        operation.appliedAt = new Date().toISOString();
      }
    }
    journal = persistWorkspaceIntegrationJournalSync(journalPath, {
      ...journal,
      status: 'integrating',
      operations,
    });

    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      if (operation.status === 'applied') continue;
      if (executionSignal?.aborted) throw integrationError('workspace_attempt_integration_aborted');
      lock.assertOwned();
      assertCurrentWorkspaceAttemptRootIdentity(
        sourceIdentity.realPath,
        descriptor.sourceRootIdentity,
        'source',
      );
      let staged = null;
      try {
        const current = inspectScopedRegularFileWithRecoverySync({
          scopeRoot: sourceIdentity.realPath,
          relative: operation.path,
        });
        if (current.hash === operation.postimageHash) {
          alreadyIntegrated.push(operation.path);
        } else if (current.hash !== operation.preimageHash) {
          throw integrationError('workspace_attempt_integration_conflict', {
            retryable: true,
            detail: operation.path,
          });
        } else if (operation.type === 'delete') {
          removeScopedRegularFileSync({
            scopeRoot: sourceIdentity.realPath,
            relative: operation.path,
            expectedHash: operation.preimageHash,
            operationId: workspaceIntegrationStageId(
              descriptor.workspaceAttemptIntegrationDescriptorHash,
              operation.path,
            ),
          });
        } else {
          staged = stageScopedRegularFileCopySync({
            sourceRoot: attemptIdentity.realPath,
            destinationRoot: sourceIdentity.realPath,
            relative: operation.path,
            stageId: workspaceIntegrationStageId(
              descriptor.workspaceAttemptIntegrationDescriptorHash,
              operation.path,
            ),
            expectedHash: operation.preimageHash,
          });
          if (staged.hash !== operation.postimageHash) {
            throw integrationError('workspace_attempt_staged_postimage_mismatch', {
              detail: operation.path,
            });
          }
          faultInjector?.({
            phase: 'after_path_staged_before_commit',
            path: operation.path,
            index,
            journalPath,
          });
          commitStagedScopedFileSync(staged, {
            destinationRoot: sourceIdentity.realPath,
            expectedHash: operation.preimageHash,
          });
        }
        faultInjector?.({
          phase: 'after_path_commit_before_journal',
          path: operation.path,
          index,
          journalPath,
        });
      } finally {
        abortStagedScopedFileSync(staged);
      }
      operation.status = 'applied';
      operation.appliedAt = new Date().toISOString();
      journal = persistWorkspaceIntegrationJournalSync(journalPath, {
        ...journal,
        status: 'integrating',
        operations,
      });
    }

    const finalSource = snapshotWorkspaceFilesSync({
      root: sourceIdentity.realPath,
      excludedNames,
    });
    if (!workspaceAttemptSnapshotMatchesExact(finalSource, verified.integratedSourceManifest)) {
      throw integrationError('workspace_attempt_integration_final_manifest_mismatch');
    }
    journal = persistWorkspaceIntegrationJournalSync(journalPath, {
      ...journal,
      status: 'completed',
      completedAt: new Date().toISOString(),
      operations,
    });
    const payload = {
      version: 2,
      kind: 'WorkspaceAttemptIntegrationReceipt',
      descriptorHash: descriptor.workspaceAttemptIntegrationDescriptorHash,
      journalHash: journal.workspaceAttemptIntegrationJournalHash,
      sourceRootIdentityHash: sourceIdentity.workspaceAttemptRootIdentityHash,
      attemptRootIdentityHash: attemptIdentity.workspaceAttemptRootIdentityHash,
      integratedSourceManifestHash: descriptor.integratedSourceManifestHash,
      changedPaths: verified.changes.map((change) => change.path),
      alreadyIntegratedPaths: [...new Set(alreadyIntegrated)].sort(),
      status: 'workspace_attempt_integrated',
      externalActionPerformed: false,
    };
    return Object.freeze({
      ...payload,
      workspaceAttemptIntegrationReceiptHash: hashRecord('WorkspaceAttemptIntegrationReceipt', payload),
    });
  } finally {
    lock.release();
  }
}
