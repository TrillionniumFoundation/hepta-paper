#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertWorkspaceLayoutPhysicallyDecoupled,
  defaultLegacyPaperFactoryRoot,
  defaultPaperAssetRoot,
  defaultPaperRuntimeRoot,
} from '../src/workspace-layout.mjs';

const PROTECTED_ROOTS = Object.freeze([
  'bin',
  'paperctl_modules',
  'plugins',
  'schema',
  'registry',
  'templates',
  'docs',
  'paper_factory.sqlite',
]);
const EXECUTION_BLOCKER =
  'legacy_archive_retirement_execute_disabled_pending_identity_bound_transaction';
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function argumentError(message) {
  const error = new Error(message);
  error.code = 'legacy_archive_retirement_arguments_invalid';
  return error;
}

export function retireLegacyArchiveUsage() {
  return [
    'Usage:',
    '  node paper-core/bin/retire-legacy-archive.mjs',
    '  node paper-core/bin/retire-legacy-archive.mjs status',
    '  node paper-core/bin/retire-legacy-archive.mjs --execute',
    '',
    'The default and status modes are read-only.',
    'Destructive execution is fail-closed until identity-bound publication and rollback are implemented.',
  ].join('\n');
}

export function parseRetireLegacyArchiveArguments(argv = []) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) {
    throw argumentError('legacy_archive_retirement_arguments_must_be_strings');
  }
  if (argv.length === 0 || (argv.length === 1 && argv[0] === 'status')) {
    return Object.freeze({ command: 'status', executeRequested: false });
  }
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return Object.freeze({ command: 'help', executeRequested: false });
  }
  if (argv.length === 1 && argv[0] === '--execute') {
    return Object.freeze({ command: 'execute', executeRequested: true });
  }
  throw argumentError(`legacy_archive_retirement_unknown_arguments:${argv.join(' ')}`);
}

function packageVersion() {
  const packagePath = path.join(workspaceRoot, 'package.json');
  const document = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (typeof document.version !== 'string' || !document.version.trim()) {
    throw new Error('legacy_archive_retirement_package_version_invalid');
  }
  return document.version;
}

function pathKind(candidate) {
  try {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isDirectory()) return 'directory';
    if (stat.isFile()) return 'file';
    return 'other';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    return 'unreadable';
  }
}

function stableRegularFileStatus(candidate) {
  const kind = pathKind(candidate);
  if (kind === 'missing') {
    return Object.freeze({
      path: candidate,
      present: false,
      safeRegularFile: false,
      sha256: null,
      bytes: 0,
      mode: null,
      identity: null,
      blocker: null,
    });
  }
  if (kind !== 'file') {
    return Object.freeze({
      path: candidate,
      present: true,
      safeRegularFile: false,
      sha256: null,
      bytes: 0,
      mode: null,
      identity: null,
      blocker: `legacy_archive_retirement_archive_${kind}`,
    });
  }
  let descriptor;
  try {
    const parent = path.dirname(candidate);
    const parentStat = fs.lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
      || fs.realpathSync(parent) !== path.resolve(parent)) {
      throw new Error('legacy_archive_retirement_archive_parent_unsafe');
    }
    descriptor = fs.openSync(
      candidate,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const before = fs.fstatSync(descriptor);
    const selected = fs.lstatSync(candidate);
    if (!before.isFile() || Number(before.nlink) !== 1
      || !selected.isFile() || selected.isSymbolicLink()
      || before.dev !== selected.dev || before.ino !== selected.ino
      || !Number.isSafeInteger(before.size) || before.size < 0) {
      throw new Error('legacy_archive_retirement_archive_unsafe');
    }
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const read = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position,
      );
      if (read < 1) throw new Error('legacy_archive_retirement_archive_short_read');
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    const after = fs.fstatSync(descriptor);
    const finalPath = fs.lstatSync(candidate);
    if (after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || !finalPath.isFile()
      || finalPath.isSymbolicLink() || finalPath.dev !== before.dev
      || finalPath.ino !== before.ino) {
      throw new Error('legacy_archive_retirement_archive_changed_during_read');
    }
    return Object.freeze({
      path: candidate,
      present: true,
      safeRegularFile: true,
      sha256: `sha256:${hash.digest('hex')}`,
      bytes: before.size,
      mode: before.mode & 0o7777,
      identity: Object.freeze({ dev: String(before.dev), ino: String(before.ino) }),
      blocker: null,
    });
  } catch (error) {
    return Object.freeze({
      path: candidate,
      present: true,
      safeRegularFile: false,
      sha256: null,
      bytes: 0,
      mode: null,
      identity: null,
      blocker: error?.message || 'legacy_archive_retirement_archive_unreadable',
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function inspectLegacyArchiveRetirement({
  legacyRoot = defaultLegacyPaperFactoryRoot(),
  runtimeRoot = defaultPaperRuntimeRoot(),
  assetRoot = defaultPaperAssetRoot(),
  version = packageVersion(),
} = {}) {
  const resolvedLegacyRoot = path.resolve(legacyRoot);
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const resolvedAssetRoot = path.resolve(assetRoot);
  const blockers = [EXECUTION_BLOCKER];
  let layout = null;
  try {
    layout = assertWorkspaceLayoutPhysicallyDecoupled({
      legacyRoot: resolvedLegacyRoot,
      runtimeRoot: resolvedRuntimeRoot,
      assetRoot: resolvedAssetRoot,
    });
  } catch (error) {
    blockers.push(error?.message || 'workspace_layout_not_physically_decoupled');
  }
  const legacyRootKind = pathKind(resolvedLegacyRoot);
  if (!['directory', 'missing'].includes(legacyRootKind)) {
    blockers.push(`legacy_archive_retirement_legacy_root_${legacyRootKind}`);
  }
  const protectedRoots = PROTECTED_ROOTS.map((relative) => Object.freeze({
    relative,
    kind: legacyRootKind === 'directory'
      ? pathKind(path.join(resolvedLegacyRoot, relative))
      : 'missing',
  }));
  const archiveRoot = path.join(
    path.dirname(resolvedLegacyRoot),
    'hepta-paper-legacy-reference',
    version,
  );
  const archive = stableRegularFileStatus(path.join(
    archiveRoot,
    'paper-factory-control-plane-reference.tar.gz',
  ));
  if (archive.blocker) blockers.push(archive.blocker);
  return Object.freeze({
    version: 2,
    kind: 'LegacyArchiveRetirementStatus',
    status: 'legacy_archive_retirement_read_only',
    packageVersion: version,
    executeSupported: false,
    externalActionPerformed: false,
    destructiveRemovalPerformed: false,
    layoutPhysicallyDecoupled: layout?.physicallyDecoupled === true,
    legacyRoot: resolvedLegacyRoot,
    legacyRootKind,
    runtimeRoot: resolvedRuntimeRoot,
    assetRoot: resolvedAssetRoot,
    protectedRoots,
    archiveRoot,
    archive,
    blockers: [...new Set(blockers)],
  });
}

export function runRetireLegacyArchiveCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let parsed;
  try {
    parsed = parseRetireLegacyArchiveArguments(argv);
  } catch (error) {
    stderr.write(`${JSON.stringify({
      version: 1,
      kind: 'LegacyArchiveRetirementCliError',
      status: 'legacy_archive_retirement_arguments_invalid',
      error: error?.message || String(error),
      externalActionPerformed: false,
    })}\n`);
    return 2;
  }
  if (parsed.command === 'help') {
    stdout.write(`${retireLegacyArchiveUsage()}\n`);
    return 0;
  }
  const report = inspectLegacyArchiveRetirement();
  if (parsed.executeRequested) {
    stdout.write(`${JSON.stringify({
      ...report,
      status: 'legacy_archive_retirement_execute_blocked',
      executeRequested: true,
      executeSupported: false,
      externalActionPerformed: false,
    }, null, 2)}\n`);
    return 1;
  }
  stdout.write(`${JSON.stringify({
    ...report,
    executeRequested: false,
  }, null, 2)}\n`);
  return 0;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  }
}

if (isMainModule()) {
  try {
    process.exitCode = runRetireLegacyArchiveCli();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      version: 1,
      kind: 'LegacyArchiveRetirementCliError',
      status: 'legacy_archive_retirement_status_failed',
      error: error?.message || String(error),
      externalActionPerformed: false,
    })}\n`);
    process.exitCode = 1;
  }
}
