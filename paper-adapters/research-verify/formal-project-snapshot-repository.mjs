import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectScopedPathSync, readScopedFileSync, inspectScopedWriteTargetSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { writeDescriptorFullySync } from '../../workflow-kernel/runtime/file-descriptor-utils.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { ensureScopedDirectorySync } from '../runtime/scoped-file-materialization-path-io.mjs';

function safeRelativeFile(value) {
  const relative = String(value || '').replace(/\\/g, '/');
  return relative && !relative.startsWith('/') && !relative.split('/').includes('..') ? relative : null;
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function verifiedPosixMode(value) {
  const mode = Number(value);
  return Number.isInteger(mode) && mode >= 0 && mode <= 0o777 ? mode : null;
}

const FORMAL_SOURCE_MTIME_MS = Date.UTC(2000, 0, 1);
const FORMAL_COMPILED_MTIME_MS = Date.UTC(2000, 0, 2);

function safeSnapshotMode(posixMode) {
  // Verifier inputs are immutable. Preserve only source read/execute authority;
  // outputs must use the separate sandbox output root.
  return posixMode & 0o555;
}

function writeAtomicScopedFile({
  scopeRoot,
  relative,
  content,
  posixMode,
  compiledArtifact = false,
}) {
  const destination = path.join(scopeRoot, relative);
  if (path.dirname(relative) !== '.') {
    ensureScopedDirectorySync({ scopeRoot, relative: path.dirname(relative) });
  }
  const target = inspectScopedWriteTargetSync({ scopeRoot, candidate: destination });
  if (target.status !== 'scoped_write_target_verified') {
    throw new Error(`formal_project_snapshot_destination_unsafe:${relative}:${target.blockers.join('|')}`);
  }
  const parent = path.dirname(destination);
  const temporary = path.join(parent, `.${path.basename(destination)}.pending-${crypto.randomUUID()}`);
  const temporaryTarget = inspectScopedWriteTargetSync({ scopeRoot, candidate: temporary });
  if (temporaryTarget.status !== 'scoped_write_target_verified') {
    throw new Error(`formal_project_snapshot_temporary_unsafe:${relative}:${temporaryTarget.blockers.join('|')}`);
  }
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    writeDescriptorFullySync(descriptor, content);
    fs.fchmodSync(descriptor, safeSnapshotMode(posixMode));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, destination);
    const timestamp = new Date(
      compiledArtifact ? FORMAL_COMPILED_MTIME_MS : FORMAL_SOURCE_MTIME_MS,
    );
    fs.utimesSync(destination, timestamp, timestamp);
    fsyncDirectory(parent);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
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
        const sealed = fs.lstatSync(absolute);
        files.push(Object.freeze({
          path: relative,
          hash: hashBytes(fs.readFileSync(absolute)),
          bytes: sealed.size,
          posixMode: sealed.mode & 0o777,
          mtimeMs: Math.trunc(sealed.mtimeMs),
        }));
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
  const payload = {
    version: 1,
    kind: 'FormalProjectSnapshotSealReceipt',
    status: 'formal_project_snapshot_sealed',
    fileCount: files.length,
    directoryCount: directoryRecords.length,
    fileManifestHash: hashRecord('FormalProjectSnapshotSealedFiles', files),
    directoryManifestHash:
      hashRecord('FormalProjectSnapshotSealedDirectories', directoryRecords),
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
          const source = readScopedFileSync({ scopeRoot: dependencyScopeRoot, candidate: sourcePath });
          if (source.status !== 'scoped_file_read_verified' || source.hash !== file.hash || source.bytes !== file.bytes) {
            throw new Error(`formal_project_snapshot_input_mismatch:${file.path}`);
          }
          const sourceMode = sourceIdentity.status === 'scoped_file_identity_verified'
            ? Number(BigInt(sourceIdentity.identity.mode) & 0o777n)
            : null;
          if (sourceMode !== declaredMode) throw new Error(`formal_project_snapshot_mode_mismatch:${file.path}`);
          const directives = projectRelative ? auditBySource.get(projectRelative) : null;
          const content = directives
            ? Buffer.concat([source.content, Buffer.from(`\n${directives}\n`)])
            : source.content;
          writeAtomicScopedFile({
            scopeRoot: snapshotScopeRoot,
            relative: sourceRelative,
            content,
            posixMode: declaredMode,
            compiledArtifact: file.role === 'lake_build_artifact'
              || file.role === 'lake_runtime_metadata'
              || /\.olean(?:\.|$)|\.trace$/.test(sourceRelative)
              || /(?:^|\/)\.lake\/build\//.test(sourceRelative),
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
