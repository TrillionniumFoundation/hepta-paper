import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectScopedPathSync, readScopedFileSync, inspectScopedWriteTargetSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { writeDescriptorFullySync } from '../../workflow-kernel/runtime/file-descriptor-utils.mjs';
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

function safeSnapshotMode(posixMode) {
  // Preserve every source read/execute bit and owner-write, while never copying
  // group/other write authority into a fresh verifier workspace.
  return posixMode & 0o755;
}

function writeAtomicScopedFile({ scopeRoot, relative, content, posixMode }) {
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
    fsyncDirectory(parent);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
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
          writeAtomicScopedFile({ scopeRoot: snapshotScopeRoot, relative: sourceRelative, content, posixMode: declaredMode });
        }
        const projectScopeRelative = path.relative(dependencyScopeRoot, projectRoot).replace(/\\/g, '/');
        const snapshotRoot = projectScopeRelative && projectScopeRelative !== '.'
          ? path.join(snapshotScopeRoot, projectScopeRelative)
          : snapshotScopeRoot;
        if (!fs.existsSync(snapshotRoot) || !fs.statSync(snapshotRoot).isDirectory()) {
          throw new Error('formal_project_snapshot_root_missing');
        }
        return Object.freeze({
          version: 1,
          kind: 'FormalProjectSnapshot',
          root: snapshotRoot,
          scopeRoot: snapshotScopeRoot,
          cleanup() { fs.rmSync(snapshotScopeRoot, { recursive: true, force: true }); },
        });
      } catch (error) {
        fs.rmSync(snapshotScopeRoot, { recursive: true, force: true });
        throw error;
      }
    },
  });
}
