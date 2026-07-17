import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';
import { fsyncDirectoryPathSync } from '../runtime/scoped-file-materialization-path-io.mjs';
import { ensureScopedDirectorySync } from '../runtime/scoped-file-materialization-repository.mjs';
import { workspaceAttemptIntegrationError as integrationError } from './workspace-attempt-errors.mjs';
import { currentProcessIdentity, processIdentityIsStale } from '../../workflow-kernel/runtime/process-identity.mjs';

const WORKSPACE_ATTEMPT_JOURNAL_VERSION = 1;

function safeHashSegment(value) {
  return String(value || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(-180);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readRegularJsonWithIdentitySync(target, code, { maximumLinks = 1 } = {}) {
  let descriptor;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const pathStat = noFollow === 0 ? fs.lstatSync(target, { bigint: true }) : null;
    if (pathStat?.isSymbolicLink()) throw integrationError(code);
    descriptor = fs.openSync(
      target,
      fs.constants.O_RDONLY | noFollow,
    );
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if ((pathStat && !sameFileIdentity(pathStat, stat))
      || !stat.isFile()
      || stat.nlink > BigInt(maximumLinks)) {
      throw integrationError(code);
    }
    return {
      value: JSON.parse(fs.readFileSync(descriptor, 'utf8')),
      identity: { dev: stat.dev, ino: stat.ino },
    };
  } catch (error) {
    if (error?.code === 'ELOOP') throw integrationError(code);
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readRegularJsonSync(target, code, options) {
  return readRegularJsonWithIdentitySync(target, code, options).value;
}

function workspaceCommitLockOwnerName(token) {
  return `owner-${token}.json`;
}

function readWorkspaceCommitLockOwnerSync(lockPath, sourceIdentity) {
  const lockStat = fs.lstatSync(lockPath);
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
    throw integrationError('workspace_attempt_commit_lock_unsafe');
  }
  const entries = fs.readdirSync(lockPath, { withFileTypes: true });
  if (entries.length !== 1) {
    throw integrationError('workspace_attempt_commit_lock_unsafe');
  }
  const [entry] = entries;
  const match = entry.name.match(/^owner-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i);
  if (!match || !entry.isFile() || entry.isSymbolicLink()) {
    throw integrationError('workspace_attempt_commit_lock_unsafe');
  }
  const ownerPath = path.join(lockPath, entry.name);
  const owner = readRegularJsonSync(
    ownerPath,
    'workspace_attempt_commit_lock_unsafe',
  );
  if (owner.version !== 2
    || owner.kind !== 'WorkspaceAttemptCommitLock'
    || owner.token !== match[1]
    || owner.sourceRootIdentityHash !== sourceIdentity.workspaceAttemptRootIdentityHash
    || !Number.isSafeInteger(owner.pid)
    || owner.pid <= 0
    || (owner.pidStartTime !== null
      && (typeof owner.pidStartTime !== 'string' || !/^\d+$/.test(owner.pidStartTime)))) {
    throw integrationError('workspace_attempt_commit_lock_unsafe');
  }
  return { owner, ownerPath };
}

function removeWorkspaceCommitLockDirectorySync({ lockPath, ownerPath, lockDirectory }) {
  try {
    fs.unlinkSync(ownerPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  try {
    fs.rmdirSync(lockPath);
    fsyncDirectoryPathSync(lockDirectory);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') return false;
    throw error;
  }
}

export function acquireWorkspaceCommitLock({ runtimeRoot, sourceIdentity, descriptorHash }) {
  const lockDirectory = ensureScopedDirectorySync({
    scopeRoot: runtimeRoot,
    relative: 'workspace-attempt-integration-locks',
  });
  const lockName = `${safeHashSegment(sourceIdentity.workspaceAttemptRootIdentityHash)}.lock`;
  const lockPath = path.join(lockDirectory, lockName);
  const processIdentity = currentProcessIdentity();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = crypto.randomUUID();
    const payload = {
      version: 2,
      kind: 'WorkspaceAttemptCommitLock',
      pid: processIdentity.pid,
      pidStartTime: processIdentity.pidStartTime,
      token,
      descriptorHash,
      sourceRootIdentityHash: sourceIdentity.workspaceAttemptRootIdentityHash,
      createdAt: new Date().toISOString(),
    };
    const temporary = path.join(lockDirectory, `.${lockName}.${token}.tmp`);
    const temporaryOwnerPath = path.join(temporary, workspaceCommitLockOwnerName(token));
    let descriptor;
    try {
      fs.mkdirSync(temporary, { mode: 0o700 });
      descriptor = fs.openSync(
        temporaryOwnerPath,
        fs.constants.O_WRONLY
          | fs.constants.O_CREAT
          | fs.constants.O_EXCL
          | (fs.constants.O_NOFOLLOW || 0),
        0o600,
      );
      fs.writeFileSync(descriptor, `${JSON.stringify(payload)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    fsyncDirectoryPathSync(temporary);
    try {
      fs.renameSync(temporary, lockPath);
      fsyncDirectoryPathSync(lockDirectory);
      const ownerPath = path.join(lockPath, workspaceCommitLockOwnerName(token));
      const assertOwned = () => {
        let current;
        try {
          current = readRegularJsonSync(
            ownerPath,
            'workspace_attempt_commit_lock_unsafe',
          );
        } catch (error) {
          if (error?.code === 'ENOENT') {
            throw integrationError('workspace_attempt_commit_lock_lost', { retryable: true });
          }
          throw error;
        }
        if (current.token !== token
          || current.pid !== processIdentity.pid
          || current.pidStartTime !== processIdentity.pidStartTime) {
          throw integrationError('workspace_attempt_commit_lock_lost', { retryable: true });
        }
      };
      const release = () => {
        try {
          const current = readRegularJsonSync(
            ownerPath,
            'workspace_attempt_commit_lock_unsafe',
          );
          if (current.token === token
            && current.pid === processIdentity.pid
            && current.pidStartTime === processIdentity.pidStartTime) {
            return removeWorkspaceCommitLockDirectorySync({
              lockPath,
              ownerPath,
              lockDirectory,
            });
          }
        } catch (error) {
          if (error?.code === 'ENOENT') return false;
          throw error;
        }
        return false;
      };
      return { lockPath, ownerPath, token, assertOwned, release };
    } catch (error) {
      try {
        fs.rmSync(temporary, { recursive: true, force: true });
      } catch {}
      if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes(error?.code)) throw error;
      let existingRecord;
      try {
        existingRecord = readWorkspaceCommitLockOwnerSync(lockPath, sourceIdentity);
      } catch (readError) {
        if (readError?.code === 'ENOENT') continue;
        throw readError;
      }
      if (!processIdentityIsStale(existingRecord.owner)) {
        throw integrationError('workspace_attempt_commit_lock_busy', { retryable: true });
      }
      removeWorkspaceCommitLockDirectorySync({
        lockPath,
        ownerPath: existingRecord.ownerPath,
        lockDirectory,
      });
    }
  }
  throw integrationError('workspace_attempt_commit_lock_busy', { retryable: true });
}

export function workspaceIntegrationJournalOperations(changes) {
  return changes.map((change) => ({
    path: change.path,
    type: change.postimageHash === null ? 'delete' : 'copy',
    preimageHash: change.preimageHash,
    postimageHash: change.postimageHash,
  }));
}

function journalWithHash(payload) {
  return {
    ...payload,
    workspaceAttemptIntegrationJournalHash: hashRecord('WorkspaceAttemptIntegrationJournal', payload),
  };
}

function verifyJournal(journal, descriptor, immutableOperations) {
  const { workspaceAttemptIntegrationJournalHash: claimed, ...payload } = journal || {};
  if (!claimed || hashRecord('WorkspaceAttemptIntegrationJournal', payload) !== claimed) {
    throw integrationError('workspace_attempt_integration_journal_hash_invalid');
  }
  if (journal.version !== WORKSPACE_ATTEMPT_JOURNAL_VERSION
    || journal.kind !== 'WorkspaceAttemptIntegrationJournal'
    || journal.descriptorHash !== descriptor.workspaceAttemptIntegrationDescriptorHash
    || journal.campaignId !== descriptor.campaignId
    || journal.nodeId !== descriptor.nodeId
    || journal.originalAttemptId !== descriptor.originalAttemptId
    || journal.sourceRootIdentityHash !== descriptor.sourceRootIdentity.workspaceAttemptRootIdentityHash
    || journal.attemptRootIdentityHash !== descriptor.attemptRootIdentity.workspaceAttemptRootIdentityHash) {
    throw integrationError('workspace_attempt_integration_journal_identity_invalid');
  }
  const actualImmutable = journal.operations.map(({
    path: pathValue,
    type,
    preimageHash,
    postimageHash,
  }) => ({ path: pathValue, type, preimageHash, postimageHash }));
  if (JSON.stringify(actualImmutable) !== JSON.stringify(immutableOperations)) {
    throw integrationError('workspace_attempt_integration_journal_operations_invalid');
  }
  return journal;
}

export function workspaceIntegrationJournalPathSync(runtimeRoot, descriptorHash) {
  const journalDirectory = ensureScopedDirectorySync({
    scopeRoot: runtimeRoot,
    relative: 'workspace-attempt-integration-journals',
  });
  return path.join(journalDirectory, `${safeHashSegment(descriptorHash)}.json`);
}

export function loadOrCreateWorkspaceIntegrationJournalSync({
  journalPath,
  descriptor,
  immutableOperations,
}) {
  if (fs.existsSync(journalPath)) {
    return verifyJournal(
      readRegularJsonSync(journalPath, 'workspace_attempt_integration_journal_unsafe'),
      descriptor,
      immutableOperations,
    );
  }
  const now = new Date().toISOString();
  const journal = journalWithHash({
    version: WORKSPACE_ATTEMPT_JOURNAL_VERSION,
    kind: 'WorkspaceAttemptIntegrationJournal',
    descriptorHash: descriptor.workspaceAttemptIntegrationDescriptorHash,
    campaignId: descriptor.campaignId,
    nodeId: descriptor.nodeId,
    originalAttemptId: descriptor.originalAttemptId,
    sourceRootIdentityHash: descriptor.sourceRootIdentity.workspaceAttemptRootIdentityHash,
    attemptRootIdentityHash: descriptor.attemptRootIdentity.workspaceAttemptRootIdentityHash,
    status: 'integrating',
    operations: immutableOperations.map((operation) => ({
      ...operation,
      status: 'pending',
      appliedAt: null,
    })),
    createdAt: now,
    updatedAt: now,
  });
  writeDurableJsonSync(journalPath, journal);
  return journal;
}

export function persistWorkspaceIntegrationJournalSync(journalPath, journal) {
  const { workspaceAttemptIntegrationJournalHash: ignored, ...payload } = journal;
  const persisted = journalWithHash({ ...payload, updatedAt: new Date().toISOString() });
  writeDurableJsonSync(journalPath, persisted);
  return persisted;
}

export function workspaceIntegrationStageId(descriptorHash, pathValue) {
  const descriptorPart = safeHashSegment(descriptorHash).slice(-32);
  const pathPart = crypto.createHash('sha256').update(pathValue).digest('hex').slice(0, 20);
  return `${descriptorPart}-${pathPart}`;
}
