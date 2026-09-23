import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectScopedPathSync, inspectScopedWriteTargetSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { writeDescriptorFullySync } from '../../workflow-kernel/runtime/file-descriptor-utils.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  workspaceExecutionManifestHash,
  workspaceExecutionMerkleHash,
} from '../../workflow-kernel/runtime/workspace-execution-identity.mjs';
import { ensureScopedDirectorySync } from '../runtime/scoped-file-materialization-path-io.mjs';
import {
  sourceTreeExcludedNames,
  sourceTreePathExcluded,
} from '../runtime/execution-snapshot.mjs';

function safeRelativeFile(value) {
  const relative = String(value || '').replace(/\\/g, '/');
  return relative && !relative.startsWith('/') && !relative.split('/').includes('..') ? relative : null;
}

function verifiedPosixMode(value) {
  const mode = Number(value);
  return Number.isInteger(mode) && mode >= 0 && mode <= 0o777 ? mode : null;
}

const FORMAL_SOURCE_MTIME_MS = Date.UTC(2000, 0, 1);
const FORMAL_COMPILED_MTIME_MS = Date.UTC(2000, 0, 2);
const COPY_BUFFER_BYTES = 1024 * 1024;

function safeSnapshotMode(posixMode) {
  // Verifier inputs are immutable. Preserve only source read/execute authority;
  // outputs must use the separate sandbox output root.
  return posixMode & 0o555;
}

function descriptorMatchesIdentity(descriptor, identity) {
  const stat = fs.fstatSync(descriptor, { bigint: true });
  return identity
    && String(stat.dev) === String(identity.device)
    && String(stat.ino) === String(identity.inode)
    && String(stat.mode) === String(identity.mode)
    && Number(stat.size) === Number(identity.size)
    && String(stat.mtimeNs) === String(identity.mtimeNs)
    && Number(stat.nlink) === Number(identity.linkCount);
}

function prepareSnapshotParent({
  scopeRoot,
  relative,
  preparedDirectories,
}) {
  const parentRelative = path.dirname(relative).replace(/\\/g, '/');
  if (parentRelative === '.') return scopeRoot;
  if (!preparedDirectories.has(parentRelative)) {
    ensureScopedDirectorySync({ scopeRoot, relative: parentRelative });
    preparedDirectories.add(parentRelative);
  }
  return path.join(scopeRoot, parentRelative);
}

function writeVerifiedScopedFile({
  scopeRoot,
  relative,
  sourcePath,
  sourceIdentity,
  expectedHash,
  expectedBytes,
  posixMode,
  compiledArtifact = false,
  appendedContent = null,
  preparedDirectories,
  copyBuffer,
}) {
  const destination = path.join(scopeRoot, relative);
  prepareSnapshotParent({ scopeRoot, relative, preparedDirectories });
  const target = inspectScopedWriteTargetSync({ scopeRoot, candidate: destination });
  if (target.status !== 'scoped_write_target_verified') {
    throw new Error(`formal_project_snapshot_destination_unsafe:${relative}:${target.blockers.join('|')}`);
  }
  let sourceDescriptor;
  let destinationDescriptor;
  try {
    sourceDescriptor = fs.openSync(
      sourcePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    if (!descriptorMatchesIdentity(sourceDescriptor, sourceIdentity.identity)) {
      throw new Error(`formal_project_snapshot_source_identity_mismatch:${relative}`);
    }
    destinationDescriptor = fs.openSync(
      destination,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    const digest = crypto.createHash('sha256');
    let bytes = 0;
    while (true) {
      const read = fs.readSync(
        sourceDescriptor,
        copyBuffer,
        0,
        copyBuffer.length,
        null,
      );
      if (!read) break;
      const chunk = copyBuffer.subarray(0, read);
      digest.update(chunk);
      writeDescriptorFullySync(destinationDescriptor, chunk);
      bytes += read;
    }
    const measuredHash = `sha256:${digest.digest('hex')}`;
    if (bytes !== expectedBytes || measuredHash !== expectedHash) {
      throw new Error(`formal_project_snapshot_input_mismatch:${relative}`);
    }
    if (!descriptorMatchesIdentity(sourceDescriptor, sourceIdentity.identity)) {
      throw new Error(`formal_project_snapshot_source_changed_during_copy:${relative}`);
    }
    if (appendedContent?.length) {
      writeDescriptorFullySync(destinationDescriptor, appendedContent);
    }
    // This tree is an ephemeral execution snapshot, not a durable repository:
    // it is accepted only after the complete tree is sealed and rehashed.
    // Avoid per-file fsyncs, which make a Mathlib-sized closure operationally
    // unbounded while adding no authority to the later seal receipt.
    const timestamp = new Date(
      compiledArtifact ? FORMAL_COMPILED_MTIME_MS : FORMAL_SOURCE_MTIME_MS,
    );
    fs.futimesSync(destinationDescriptor, timestamp, timestamp);
    fs.fchmodSync(destinationDescriptor, safeSnapshotMode(posixMode));
    fs.closeSync(destinationDescriptor);
    destinationDescriptor = undefined;
    fs.closeSync(sourceDescriptor);
    sourceDescriptor = undefined;
    const afterSource = inspectScopedPathSync({
      scopeRoot: sourceIdentity.scopeRoot,
      candidate: sourcePath,
      expect: 'file',
      forbidHardlinks: true,
    });
    if (afterSource.status !== 'scoped_file_identity_verified'
      || afterSource.scopedFileIdentityHash !== sourceIdentity.scopedFileIdentityHash) {
      throw new Error(`formal_project_snapshot_source_changed_during_copy:${relative}`);
    }
  } catch (error) {
    if (sourceDescriptor !== undefined) fs.closeSync(sourceDescriptor);
    if (destinationDescriptor !== undefined) fs.closeSync(destinationDescriptor);
    fs.rmSync(destination, { force: true });
    throw error;
  }
}

function hashSealedRegularFile(absolute, expectedStat, buffer) {
  const descriptor = fs.openSync(
    absolute,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  const digest = crypto.createHash('sha256');
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (String(opened.dev) !== String(expectedStat.dev)
      || String(opened.ino) !== String(expectedStat.ino)
      || String(opened.mode) !== String(expectedStat.mode)
      || Number(opened.size) !== Number(expectedStat.size)
      || String(opened.mtimeNs) !== String(expectedStat.mtimeNs)
      || Number(opened.nlink) !== Number(expectedStat.nlink)) {
      throw new Error('formal_project_snapshot_seal_file_identity_changed');
    }
    while (true) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!read) break;
      digest.update(buffer.subarray(0, read));
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (String(after.dev) !== String(opened.dev)
      || String(after.ino) !== String(opened.ino)
      || String(after.mode) !== String(opened.mode)
      || Number(after.size) !== Number(opened.size)
      || String(after.mtimeNs) !== String(opened.mtimeNs)
      || Number(after.nlink) !== Number(opened.nlink)) {
      throw new Error('formal_project_snapshot_seal_file_changed_during_hash');
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${digest.digest('hex')}`;
}

function makeSnapshotWritableForCleanup(root) {
  if (!fs.existsSync(root)) return;
  const visit = (directory) => {
    try { fs.chmodSync(directory, 0o700); } catch { return; }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(path.join(directory, entry.name));
    }
  };
  visit(root);
}

function sealSnapshotTree(root) {
  const files = [];
  const directories = [];
  const hashBuffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  const executionExcludedNames = new Set(sourceTreeExcludedNames(root));
  const executionPathIncluded = (relative) => !sourceTreePathExcluded(
    root,
    path.join(root, relative),
    executionExcludedNames,
  );
  const visit = (directory) => {
    directories.push(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error('formal_project_snapshot_seal_symlink_forbidden');
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) {
        fs.chmodSync(absolute, stat.mode & 0o555);
        const compiledArtifact = /\.olean(?:\.|$)|\.trace$/.test(relative)
          || /(?:^|\/)\.lake\/build\//.test(relative)
          || /(?:^|\/)\.lake\/(?!packages\/|build\/)/.test(relative);
        const timestamp = new Date(
          compiledArtifact ? FORMAL_COMPILED_MTIME_MS : FORMAL_SOURCE_MTIME_MS,
        );
        fs.utimesSync(absolute, timestamp, timestamp);
        const sealed = fs.lstatSync(absolute, { bigint: true });
        const sealedFile = Object.freeze({
          path: relative,
          hash: hashSealedRegularFile(absolute, sealed, hashBuffer),
          bytes: Number(sealed.size),
          posixMode: Number(sealed.mode & 0o777n),
          mtimeMs: Number(sealed.mtimeMs),
        });
        files.push(sealedFile);
      } else throw new Error('formal_project_snapshot_seal_special_file_forbidden');
    }
  };
  visit(root);
  for (const directory of directories.sort((left, right) => right.length - left.length)) {
    const stat = fs.lstatSync(directory);
    fs.chmodSync(directory, (stat.mode & 0o555) | 0o500);
  }
  const directoryRecords = directories.map((directory) => {
    const stat = fs.lstatSync(directory);
    return Object.freeze({
      path: path.relative(root, directory).replace(/\\/g, '/') || '.',
      posixMode: stat.mode & 0o777,
    });
  }).sort((left, right) => left.path.localeCompare(right.path));
  const executionFileRecords = files
    .filter((file) => executionPathIncluded(file.path))
    .map((file) => Object.freeze({
      path: file.path,
      mode: file.posixMode,
      hash: file.hash,
      bytes: file.bytes,
    }));
  const executionDirectoryRecords = directoryRecords
    .filter((directory) => (
      directory.path !== '.' && executionPathIncluded(directory.path)
    ))
    .map((directory) => Object.freeze({
      path: directory.path,
      mode: directory.posixMode,
    }));
  const payload = {
    version: 1,
    kind: 'FormalProjectSnapshotSealReceipt',
    status: 'formal_project_snapshot_sealed',
    fileCount: files.length,
    directoryCount: directoryRecords.length,
    fileManifestHash: hashRecord('FormalProjectSnapshotSealedFiles', files),
    directoryManifestHash:
      hashRecord('FormalProjectSnapshotSealedDirectories', directoryRecords),
    workspaceExecutionMerkleHash:
      workspaceExecutionMerkleHash(executionFileRecords),
    workspaceExecutionManifestHash:
      workspaceExecutionManifestHash(
        executionFileRecords,
        executionDirectoryRecords,
      ),
    writableFileCount: files.filter((file) => (file.posixMode & 0o222) !== 0).length,
    writableDirectoryCount:
      directoryRecords.filter((item) => (item.posixMode & 0o222) !== 0).length,
    deterministicSourceMtimeMs: FORMAL_SOURCE_MTIME_MS,
    deterministicCompiledMtimeMs: FORMAL_COMPILED_MTIME_MS,
    blockers: Object.freeze([]),
  };
  return Object.freeze({
    ...payload,
    formalProjectSnapshotSealReceiptHash:
      hashRecord('FormalProjectSnapshotSealReceipt', payload),
  });
}

export function createFormalProjectSnapshotRepository({ temporaryRoot = os.tmpdir() } = {}) {
  return Object.freeze({
    version: 1,
    kind: 'FormalProjectSnapshotRepository',
    materialize({ projectRoot, dependencyScopeRoot = projectRoot, projectFiles, systemAuditPlan = null } = {}) {
      const snapshotScopeRoot = fs.mkdtempSync(path.join(temporaryRoot, 'hepta-formal-project-'));
      fs.chmodSync(snapshotScopeRoot, 0o700);
      try {
        const auditBySource = new Map((systemAuditPlan?.entries || []).map((entry) => [entry.sourceFile, entry.directives]));
        const preparedDirectories = new Set(['.']);
        const copyBuffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
        for (const file of projectFiles || []) {
          const sourceRelative = safeRelativeFile(file.sourcePath || file.path);
          const projectRelative = file.projectPath === null ? null : safeRelativeFile(file.projectPath || file.path);
          if (!sourceRelative || (file.projectPath !== null && !projectRelative)) throw new Error('formal_project_manifest_path_invalid');
          const declaredMode = verifiedPosixMode(file.posixMode);
          if (declaredMode === null) throw new Error(`formal_project_snapshot_mode_invalid:${file.path}`);
          const sourcePath = path.join(dependencyScopeRoot, sourceRelative);
          const sourceIdentity = inspectScopedPathSync({
            scopeRoot: dependencyScopeRoot,
            candidate: sourcePath,
            expect: 'file',
            forbidHardlinks: true,
          });
          if (sourceIdentity.status !== 'scoped_file_identity_verified') {
            throw new Error(`formal_project_snapshot_input_mismatch:${file.path}`);
          }
          const sourceMode = sourceIdentity.status === 'scoped_file_identity_verified'
            ? Number(BigInt(sourceIdentity.identity.mode) & 0o777n)
            : null;
          if (sourceMode !== declaredMode) throw new Error(`formal_project_snapshot_mode_mismatch:${file.path}`);
          const directives = projectRelative ? auditBySource.get(projectRelative) : null;
          writeVerifiedScopedFile({
            scopeRoot: snapshotScopeRoot,
            relative: sourceRelative,
            sourcePath,
            sourceIdentity,
            expectedHash: file.hash,
            expectedBytes: file.bytes,
            posixMode: declaredMode,
            compiledArtifact: file.role === 'lake_build_artifact'
              || file.role === 'lake_runtime_metadata'
              || /\.olean(?:\.|$)|\.trace$/.test(sourceRelative)
              || /(?:^|\/)\.lake\/build\//.test(sourceRelative),
            appendedContent: directives
              ? Buffer.from(`\n${directives}\n`)
              : null,
            preparedDirectories,
            copyBuffer,
          });
        }
        const projectScopeRelative = path.relative(dependencyScopeRoot, projectRoot).replace(/\\/g, '/');
        const snapshotRoot = projectScopeRelative && projectScopeRelative !== '.'
          ? path.join(snapshotScopeRoot, projectScopeRelative)
          : snapshotScopeRoot;
        if (!fs.existsSync(snapshotRoot) || !fs.statSync(snapshotRoot).isDirectory()) {
          throw new Error('formal_project_snapshot_root_missing');
        }
        let sealReceipt = null;
        return Object.freeze({
          version: 1,
          kind: 'FormalProjectSnapshot',
          root: snapshotRoot,
          scopeRoot: snapshotScopeRoot,
          seal() {
            if (!sealReceipt) sealReceipt = sealSnapshotTree(snapshotScopeRoot);
            return sealReceipt;
          },
          cleanup() {
            makeSnapshotWritableForCleanup(snapshotScopeRoot);
            fs.rmSync(snapshotScopeRoot, { recursive: true, force: true });
          },
        });
      } catch (error) {
        makeSnapshotWritableForCleanup(snapshotScopeRoot);
        fs.rmSync(snapshotScopeRoot, { recursive: true, force: true });
        throw error;
      }
    },
  });
}
