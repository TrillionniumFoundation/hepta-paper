import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeDescriptorFullySync } from '../../workflow-kernel/runtime/file-descriptor-utils.mjs';
import { spawnSync } from 'node:child_process';
import {
  descriptorAccessPathSync,
  descriptorSha256HashSync,
  samePinnedFileIdentity,
} from '../runtime/pinned-file-reader.mjs';

const WORKSPACE_INTERNAL_EXCLUDED_NAMES = new Set(['.hepta-materialization-recovery']);
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;
const DIRECTORY_OPEN_FLAGS = fs.constants.O_RDONLY | NO_FOLLOW | DIRECTORY_ONLY;
const REGULAR_OPEN_FLAGS = fs.constants.O_RDONLY | NO_FOLLOW;
const TAR_TIMEOUT_MS = 120_000;
const MAX_TAR_OUTPUT = 8 * 1024 * 1024;

export const WORKSPACE_SNAPSHOT_RESOURCE_LIMITS = Object.freeze({
  maxArchiveBytes: 4 * 1024 * 1024 * 1024,
  maxArchiveMembers: 100_000,
  maxEntries: 50_000,
  maxFileBytes: 2 * 1024 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
});

function trustedTarExecutable() {
  for (const candidate of ['/usr/bin/tar', '/bin/tar']) {
    try {
      const stat = fs.lstatSync(candidate);
      if (path.isAbsolute(candidate) && stat.isFile() && !stat.isSymbolicLink()) return candidate;
    } catch { /* try the next fixed system path */ }
  }
  throw new Error('workspace_snapshot_trusted_tar_unavailable');
}

export function descriptorPath(descriptor) {
  return descriptorAccessPathSync(descriptor, { errorCode: 'workspace_snapshot_descriptor_path_unavailable' });
}

export const sameIdentity = samePinnedFileIdentity;

export function identityRecord(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino), mode: Number(stat.mode) });
}

export function matchesIdentityRecord(stat, expected) {
  return Boolean(stat && expected
    && String(stat.dev) === expected.dev
    && String(stat.ino) === expected.ino
    && Number(stat.mode) === expected.mode);
}

export function safeRelative(value) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value) || path.isAbsolute(value)) return false;
  const parts = value.replace(/\\/g, '/').split('/');
  return !parts.some((part) => !part || part === '.' || part === '..');
}

export function safeControlName(value) {
  return typeof value === 'string'
    && value.length > 0
    && value !== '.'
    && value !== '..'
    && !/[\0\r\n/\\]/.test(value)
    && path.basename(value) === value;
}

export function validateEntryResourceBounds(entries, prefix = 'workspace_snapshot_manifest') {
  if (!Array.isArray(entries) || entries.length > WORKSPACE_SNAPSHOT_RESOURCE_LIMITS.maxEntries) {
    throw new Error(`${prefix}_entry_limit_exceeded`);
  }
  let totalBytes = 0;
  for (const entry of entries) {
    if (!safeRelative(entry?.path)
      || !/^sha256:[0-9a-f]{64}$/.test(entry?.hash || '')
      || !Number.isSafeInteger(entry?.bytes) || entry.bytes < 0) {
      throw new Error(`${prefix}_entry_invalid`);
    }
    if (entry.bytes > WORKSPACE_SNAPSHOT_RESOURCE_LIMITS.maxFileBytes) throw new Error(`${prefix}_file_bytes_exceeded`);
    totalBytes += entry.bytes;
    if (totalBytes > WORKSPACE_SNAPSHOT_RESOURCE_LIMITS.maxTotalBytes) throw new Error(`${prefix}_total_bytes_exceeded`);
  }
  return totalBytes;
}

export const hashDescriptor = descriptorSha256HashSync;

function hashAndCopyDescriptor(sourceDescriptor, destinationDescriptor = null) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  let offset = 0;
  for (;;) {
    const bytesRead = fs.readSync(sourceDescriptor, buffer, 0, buffer.length, offset);
    if (!bytesRead) break;
    const content = buffer.subarray(0, bytesRead);
    hash.update(content);
    if (destinationDescriptor !== null) writeDescriptorFullySync(destinationDescriptor, content);
    offset += bytesRead;
  }
  return `sha256:${hash.digest('hex')}`;
}

export function openPinnedRegularFile(candidate, errorCode = 'workspace_snapshot_file_not_regular') {
  let before = null;
  try { before = fs.lstatSync(candidate, { bigint: true }); } catch { throw new Error(errorCode); }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(errorCode);
  let descriptor = null;
  try {
    descriptor = fs.openSync(candidate, REGULAR_OPEN_FLAGS);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) throw new Error(errorCode);
    return { descriptor, opened };
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    throw error;
  }
}

export function fileHash(candidate) {
  const pinned = openPinnedRegularFile(candidate);
  try {
    const hash = hashDescriptor(pinned.descriptor);
    if (!sameIdentity(pinned.opened, fs.fstatSync(pinned.descriptor, { bigint: true }))) throw new Error('workspace_snapshot_file_changed_while_reading');
    return hash;
  } finally { fs.closeSync(pinned.descriptor); }
}

export function openOrCreateDirectory(candidate) {
  if (!NO_FOLLOW || !DIRECTORY_ONLY) throw new Error('workspace_snapshot_no_follow_directory_open_unavailable');
  const absolute = path.resolve(candidate);
  const components = absolute.split(path.sep).filter(Boolean);
  let descriptor = fs.openSync(path.parse(absolute).root || path.sep, DIRECTORY_OPEN_FLAGS);
  try {
    for (const component of components) {
      const child = path.join(descriptorPath(descriptor), component);
      let next = null;
      try { next = fs.openSync(child, DIRECTORY_OPEN_FLAGS); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        try { fs.mkdirSync(child, { mode: 0o700 }); } catch (mkdirError) {
          if (mkdirError?.code !== 'EEXIST') throw mkdirError;
        }
        next = fs.openSync(child, DIRECTORY_OPEN_FLAGS);
      }
      const opened = fs.fstatSync(next, { bigint: true });
      if (!opened.isDirectory()) {
        fs.closeSync(next);
        throw new Error('workspace_snapshot_parent_not_regular_directory');
      }
      fs.closeSync(descriptor);
      descriptor = next;
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

export function assertPublicDirectoryBinding(publicPath, descriptor, errorCode = 'workspace_snapshot_parent_identity_changed') {
  let current = null;
  try { current = fs.lstatSync(publicPath, { bigint: true }); } catch { throw new Error(errorCode); }
  const opened = fs.fstatSync(descriptor, { bigint: true });
  if (!current.isDirectory() || current.isSymbolicLink()
    || current.dev !== opened.dev || current.ino !== opened.ino
    || fs.realpathSync.native(publicPath) !== fs.realpathSync.native(descriptorPath(descriptor))) {
    throw new Error(errorCode);
  }
}

export function childStat(parentDescriptor, name) {
  try { return fs.lstatSync(path.join(descriptorPath(parentDescriptor), name), { bigint: true }); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function createControlledDirectory(parentDescriptor, prefix) {
  const name = `${prefix}${crypto.randomUUID()}`;
  const candidate = path.join(descriptorPath(parentDescriptor), name);
  fs.mkdirSync(candidate, { mode: 0o700 });
  const descriptor = fs.openSync(candidate, DIRECTORY_OPEN_FLAGS);
  const stat = fs.fstatSync(descriptor, { bigint: true });
  if (!stat.isDirectory()) {
    fs.closeSync(descriptor);
    throw new Error('workspace_snapshot_staging_not_directory');
  }
  return { name, candidate, descriptor, identity: identityRecord(stat) };
}

export function removeControlledDirectory(parentDescriptor, name, expectedIdentity = null) {
  const stat = childStat(parentDescriptor, name);
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (expectedIdentity && !matchesIdentityRecord(stat, expectedIdentity))) {
    throw new Error('workspace_snapshot_cleanup_identity_mismatch');
  }
  const rootDevice = stat.dev;
  const removeContents = (directoryDescriptor) => {
    for (const childName of fs.readdirSync(descriptorPath(directoryDescriptor)).sort()) {
      const child = path.join(descriptorPath(directoryDescriptor), childName);
      const observed = fs.lstatSync(child, { bigint: true });
      if (observed.isDirectory() && !observed.isSymbolicLink()) {
        if (observed.dev !== rootDevice) throw new Error('workspace_snapshot_cleanup_mount_forbidden');
        const childDescriptor = fs.openSync(child, DIRECTORY_OPEN_FLAGS);
        try {
          const opened = fs.fstatSync(childDescriptor, { bigint: true });
          if (!sameIdentity(observed, opened)) throw new Error('workspace_snapshot_cleanup_identity_mismatch');
          removeContents(childDescriptor);
        } finally { fs.closeSync(childDescriptor); }
        fs.rmdirSync(child);
      } else {
        fs.unlinkSync(child);
      }
    }
    fs.fsyncSync(directoryDescriptor);
  };
  const directoryPath = path.join(descriptorPath(parentDescriptor), name);
  const directoryDescriptor = fs.openSync(directoryPath, DIRECTORY_OPEN_FLAGS);
  try {
    const opened = fs.fstatSync(directoryDescriptor, { bigint: true });
    if (!matchesIdentityRecord(opened, identityRecord(stat))) throw new Error('workspace_snapshot_cleanup_identity_mismatch');
    removeContents(directoryDescriptor);
  } finally { fs.closeSync(directoryDescriptor); }
  fs.rmdirSync(directoryPath);
  fs.fsyncSync(parentDescriptor);
}

export function unlinkControlledFile(parentDescriptor, name) {
  const stat = childStat(parentDescriptor, name);
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('workspace_snapshot_cleanup_file_identity_mismatch');
  fs.unlinkSync(path.join(descriptorPath(parentDescriptor), name));
  fs.fsyncSync(parentDescriptor);
}

function ensureStagedParent(stagePath, relative) {
  const parts = relative.split('/');
  parts.pop();
  let current = stagePath;
  for (const part of parts) {
    current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('workspace_snapshot_staging_parent_unsafe');
    }
  }
}

function copyPinnedWorkspaceFile({ fileDescriptor, openedFile, stagePath, relative, external }) {
  let destinationDescriptor = null;
  try {
    if (!external) {
      ensureStagedParent(stagePath, relative);
      destinationDescriptor = fs.openSync(path.join(stagePath, ...relative.split('/')),
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
    }
    const hash = hashAndCopyDescriptor(fileDescriptor, destinationDescriptor);
    if (destinationDescriptor !== null) fs.fsyncSync(destinationDescriptor);
    const after = fs.fstatSync(fileDescriptor, { bigint: true });
    if (!sameIdentity(openedFile, after)) throw new Error(`workspace_snapshot_source_changed_while_staging:${relative}`);
    return { path: relative, hash, bytes: Number(after.size) };
  } finally {
    if (destinationDescriptor !== null) fs.closeSync(destinationDescriptor);
  }
}

export function stagePinnedWorkspace({ source, stagePath, externalContentBindings }) {
  let before = null;
  try { before = fs.lstatSync(source, { bigint: true }); } catch { throw new Error('workspace snapshot source directory missing'); }
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('workspace snapshot source directory missing');
  const rootDescriptor = fs.openSync(source, DIRECTORY_OPEN_FLAGS);
  try {
    const opened = fs.fstatSync(rootDescriptor, { bigint: true });
    if (!sameIdentity(before, opened)) throw new Error('workspace_snapshot_source_identity_changed');
    const rootDevice = opened.dev;
    const rootRealPath = fs.realpathSync.native(descriptorPath(rootDescriptor));
    if (fs.realpathSync.native(source) !== rootRealPath) throw new Error('workspace_snapshot_source_realpath_changed');
    const entries = [];
    let totalBytes = 0;
    const walk = (directoryDescriptor, relativeDirectory = '') => {
      const directoryBefore = fs.fstatSync(directoryDescriptor, { bigint: true });
      for (const name of fs.readdirSync(descriptorPath(directoryDescriptor)).sort()) {
        if (WORKSPACE_INTERNAL_EXCLUDED_NAMES.has(name)) continue;
        const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
        if (!safeRelative(relative)) throw new Error(`workspace_snapshot_path_unsafe:${relative}`);
        const candidate = path.join(descriptorPath(directoryDescriptor), name);
        const observed = fs.lstatSync(candidate, { bigint: true });
        if (observed.isSymbolicLink()) throw new Error(`workspace_snapshot_symlink_forbidden:${relative}`);
        if (observed.isDirectory()) {
          const childDescriptor = fs.openSync(candidate, DIRECTORY_OPEN_FLAGS);
          try {
            const childOpened = fs.fstatSync(childDescriptor, { bigint: true });
            if (!sameIdentity(observed, childOpened)) throw new Error(`workspace_snapshot_directory_identity_changed:${relative}`);
            if (childOpened.dev !== rootDevice) throw new Error(`workspace_snapshot_cross_device_forbidden:${relative}`);
            const childRealPath = fs.realpathSync.native(descriptorPath(childDescriptor));
            const childRelative = path.relative(rootRealPath, childRealPath);
            if (childRelative.startsWith('..') || path.isAbsolute(childRelative)) throw new Error(`workspace_snapshot_directory_outside_root:${relative}`);
            walk(childDescriptor, relative);
            if (!sameIdentity(childOpened, fs.fstatSync(childDescriptor, { bigint: true }))) throw new Error(`workspace_snapshot_directory_changed_while_staging:${relative}`);
          } finally { fs.closeSync(childDescriptor); }
          continue;
        }
        if (!observed.isFile()) throw new Error(`workspace_snapshot_special_file_forbidden:${relative}`);
        const fileDescriptor = fs.openSync(candidate, REGULAR_OPEN_FLAGS);
        try {
          const openedFile = fs.fstatSync(fileDescriptor, { bigint: true });
          const fileRealPath = fs.realpathSync.native(descriptorPath(fileDescriptor));
          const fileRelative = path.relative(rootRealPath, fileRealPath);
          if (!openedFile.isFile() || !sameIdentity(observed, openedFile)
            || fileRelative.startsWith('..') || path.isAbsolute(fileRelative)) {
            throw new Error(`workspace_snapshot_file_identity_changed:${relative}`);
          }
          if (openedFile.dev !== rootDevice) throw new Error(`workspace_snapshot_cross_device_forbidden:${relative}`);
          if (openedFile.nlink !== 1n) throw new Error(`workspace_snapshot_hardlink_forbidden:${relative}`);
          if (openedFile.size > BigInt(WORKSPACE_SNAPSHOT_RESOURCE_LIMITS.maxFileBytes)) {
            throw new Error(`workspace_snapshot_source_file_too_large:${relative}`);
          }
          if (entries.length >= WORKSPACE_SNAPSHOT_RESOURCE_LIMITS.maxEntries) throw new Error('workspace_snapshot_source_entry_limit_exceeded');
          totalBytes += Number(openedFile.size);
          if (totalBytes > WORKSPACE_SNAPSHOT_RESOURCE_LIMITS.maxTotalBytes) throw new Error('workspace_snapshot_source_total_bytes_exceeded');
          entries.push(copyPinnedWorkspaceFile({
            fileDescriptor,
            openedFile,
            stagePath,
            relative,
            external: Object.hasOwn(externalContentBindings, relative),
          }));
        } finally { fs.closeSync(fileDescriptor); }
      }
      if (!sameIdentity(directoryBefore, fs.fstatSync(directoryDescriptor, { bigint: true }))) {
        throw new Error(`workspace_snapshot_directory_changed_while_staging:${relativeDirectory || '.'}`);
      }
    };
    walk(rootDescriptor);
    const finalDescriptor = fs.fstatSync(rootDescriptor, { bigint: true });
    let finalPath = null;
    try { finalPath = fs.lstatSync(source, { bigint: true }); } catch { throw new Error('workspace_snapshot_source_identity_changed'); }
    if (!sameIdentity(opened, finalDescriptor) || !sameIdentity(finalDescriptor, finalPath)) throw new Error('workspace_snapshot_source_identity_changed');
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  } finally { fs.closeSync(rootDescriptor); }
}

export function validateExternalBinding(entry, candidate) {
  let pinned = null;
  try { pinned = openPinnedRegularFile(candidate, `workspace_snapshot_external_content_missing:${entry.path}`); } catch (error) { throw error; }
  try {
    const hash = hashDescriptor(pinned.descriptor);
    const after = fs.fstatSync(pinned.descriptor, { bigint: true });
    if (!sameIdentity(pinned.opened, after) || Number(after.size) !== entry.bytes || hash !== entry.hash) {
      throw new Error(`workspace_snapshot_external_content_mismatch:${entry.path}`);
    }
  } finally { fs.closeSync(pinned.descriptor); }
}

function runTar(args, inheritedDescriptors = []) {
  return spawnSync(trustedTarExecutable(), args, {
    encoding: 'utf8',
    // Node's coverage runner may add NODE_V8_COVERAGE while normalizing spawn
    // options, so give child_process a fresh mutable object. The allowlist stays
    // exact; only the container object must remain mutable until spawn.
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    timeout: TAR_TIMEOUT_MS,
    maxBuffer: MAX_TAR_OUTPUT,
    stdio: ['ignore', 'pipe', 'pipe', ...inheritedDescriptors],
  });
}

export function archiveStagedWorkspace({ destinationDescriptor, stageDescriptor, archiveName }) {
  const temporaryName = `.${archiveName}.tmp-${crypto.randomUUID()}`;
  const temporaryPath = path.join(descriptorPath(destinationDescriptor), temporaryName);
  let archiveDescriptor = null;
  try {
    archiveDescriptor = fs.openSync(temporaryPath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
    const archive = runTar(['-czf', '/proc/self/fd/3', '-C', '/proc/self/fd/4', '--', '.'], [archiveDescriptor, stageDescriptor]);
    if (archive.status !== 0) throw new Error(archive.stderr || 'workspace_snapshot_archive_failed');
    fs.fsyncSync(archiveDescriptor);
    fs.closeSync(archiveDescriptor);
    archiveDescriptor = null;
    fs.renameSync(temporaryPath, path.join(descriptorPath(destinationDescriptor), archiveName));
    fs.fsyncSync(destinationDescriptor);
  } finally {
    if (archiveDescriptor !== null) fs.closeSync(archiveDescriptor);
    try { unlinkControlledFile(destinationDescriptor, temporaryName); } catch { /* preserve primary failure */ }
  }
}

export function writeDurableFile(parentDescriptor, finalName, content, mode = 0o444) {
  const temporaryName = `.${finalName}.tmp-${crypto.randomUUID()}`;
  const temporaryPath = path.join(descriptorPath(parentDescriptor), temporaryName);
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, mode);
    writeDescriptorFullySync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, path.join(descriptorPath(parentDescriptor), finalName));
    fs.fsyncSync(parentDescriptor);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    try { unlinkControlledFile(parentDescriptor, temporaryName); } catch { /* preserve primary failure */ }
  }
}

export function readPinnedJson(candidate, errorCode) {
  const pinned = openPinnedRegularFile(candidate, errorCode);
  try {
    const parsed = JSON.parse(fs.readFileSync(pinned.descriptor, 'utf8'));
    if (!sameIdentity(pinned.opened, fs.fstatSync(pinned.descriptor, { bigint: true }))) throw new Error(errorCode);
    return parsed;
  } catch { throw new Error(errorCode); } finally { fs.closeSync(pinned.descriptor); }
}

function normalizeArchiveMember(raw) {
  if (typeof raw !== 'string' || /[\0\r\n]/.test(raw)) throw new Error('workspace_snapshot_archive_member_name_unsafe');
  let value = raw;
  while (value.startsWith('./')) value = value.slice(2);
  value = value.replace(/\/+$/, '');
  if (!value) return '.';
  if (!safeRelative(value)) throw new Error(`workspace_snapshot_archive_path_unsafe:${raw}`);
  if (value.split('/').some((part) => WORKSPACE_INTERNAL_EXCLUDED_NAMES.has(part))) {
    throw new Error(`workspace_snapshot_archive_internal_state_forbidden:${value}`);
  }
  return value;
}

export function validateArchiveMembers(archiveDescriptor, entries) {
  const namesResult = runTar(['--list', '--gzip', '--file', '/proc/self/fd/3', '--quoting-style=literal'], [archiveDescriptor]);
  if (namesResult.status !== 0) throw new Error(namesResult.stderr || 'workspace_snapshot_listing_failed');
  const typesResult = runTar([
    '--list', '--verbose', '--numeric-owner', '--full-time', '--gzip', '--file', '/proc/self/fd/3', '--quoting-style=escape',
  ], [archiveDescriptor]);
  if (typesResult.status !== 0) throw new Error(typesResult.stderr || 'workspace_snapshot_listing_failed');
  const names = String(namesResult.stdout || '').split('\n').filter((line) => line.length > 0);
  const typeLines = String(typesResult.stdout || '').split('\n').filter((line) => line.length > 0);
  if (names.length !== typeLines.length) throw new Error('workspace_snapshot_archive_member_name_unsafe');
  if (names.length > WORKSPACE_SNAPSHOT_RESOURCE_LIMITS.maxArchiveMembers) throw new Error('workspace_snapshot_archive_member_limit_exceeded');
  const seen = new Set();
  const observedMembers = new Map();
  let totalUncompressedBytes = 0;
  for (let index = 0; index < names.length; index += 1) {
    const memberType = typeLines[index][0];
    if (memberType !== '-' && memberType !== 'd') throw new Error(`workspace_snapshot_archive_member_type_forbidden:${memberType || 'unknown'}`);
    const sizeMatch = /^\S+\s+\d+\/\d+\s+(\d+)\s+/.exec(typeLines[index]);
    if (!sizeMatch) throw new Error('workspace_snapshot_archive_member_metadata_invalid');
    const memberBytes = Number(sizeMatch[1]);
    if (!Number.isSafeInteger(memberBytes) || memberBytes < 0) throw new Error('workspace_snapshot_archive_member_metadata_invalid');
    if (memberType === 'd' && memberBytes !== 0) throw new Error('workspace_snapshot_archive_directory_bytes_invalid');
    if (memberType === '-' && memberBytes > WORKSPACE_SNAPSHOT_RESOURCE_LIMITS.maxFileBytes) {
      throw new Error('workspace_snapshot_archive_file_bytes_exceeded');
    }
    totalUncompressedBytes += memberBytes;
    if (totalUncompressedBytes > WORKSPACE_SNAPSHOT_RESOURCE_LIMITS.maxTotalBytes) {
      throw new Error('workspace_snapshot_archive_total_bytes_exceeded');
    }
    const normalized = normalizeArchiveMember(names[index]);
    if (seen.has(normalized)) throw new Error(`workspace_snapshot_archive_duplicate_member:${normalized}`);
    seen.add(normalized);
    if (normalized === '.' && memberType !== 'd') throw new Error('workspace_snapshot_archive_root_not_directory');
    observedMembers.set(normalized, [memberType, memberBytes]);
  }
  const expectedMembers = new Map([['.', ['d', 0]]]);
  for (const entry of entries.filter((item) => !item.externalContent)) {
    if (!safeRelative(entry.path)) throw new Error(`workspace_snapshot_manifest_path_unsafe:${entry.path}`);
    const parts = entry.path.split('/');
    for (let index = 1; index < parts.length; index += 1) expectedMembers.set(parts.slice(0, index).join('/'), ['d', 0]);
    expectedMembers.set(entry.path, ['-', entry.bytes]);
  }
  const observed = [...observedMembers].sort(([left], [right]) => left.localeCompare(right));
  const expected = [...expectedMembers].sort(([left], [right]) => left.localeCompare(right));
  if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error('workspace_snapshot_archive_file_manifest_mismatch');
}

export function extractArchive(archiveDescriptor, stageDescriptor) {
  const extract = runTar([
    '--extract', '--gzip', '--file', '/proc/self/fd/3', '--directory', '/proc/self/fd/4',
    '--no-same-owner', '--no-same-permissions', '--delay-directory-restore',
  ], [archiveDescriptor, stageDescriptor]);
  if (extract.status !== 0) throw new Error(extract.stderr || 'workspace_snapshot_restore_failed');
}

export function fsyncStagedTree(directoryDescriptor, relativeDirectory = '') {
  const before = fs.fstatSync(directoryDescriptor, { bigint: true });
  if (!before.isDirectory()) throw new Error('workspace_snapshot_staging_not_directory');
  for (const name of fs.readdirSync(descriptorPath(directoryDescriptor)).sort()) {
    const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
    if (!safeRelative(relative)) throw new Error(`workspace_snapshot_staging_path_unsafe:${relative}`);
    const candidate = path.join(descriptorPath(directoryDescriptor), name);
    const observed = fs.lstatSync(candidate, { bigint: true });
    if (observed.isSymbolicLink()) throw new Error(`workspace_snapshot_staging_symlink_forbidden:${relative}`);
    if (observed.isDirectory()) {
      const childDescriptor = fs.openSync(candidate, DIRECTORY_OPEN_FLAGS);
      try {
        const opened = fs.fstatSync(childDescriptor, { bigint: true });
        if (!sameIdentity(observed, opened)) throw new Error(`workspace_snapshot_staging_identity_changed:${relative}`);
        fsyncStagedTree(childDescriptor, relative);
        if (!sameIdentity(opened, fs.fstatSync(childDescriptor, { bigint: true }))) throw new Error(`workspace_snapshot_staging_changed_while_syncing:${relative}`);
      } finally { fs.closeSync(childDescriptor); }
      continue;
    }
    if (!observed.isFile()) throw new Error(`workspace_snapshot_staging_special_file_forbidden:${relative}`);
    const fileDescriptor = fs.openSync(candidate, REGULAR_OPEN_FLAGS);
    try {
      const opened = fs.fstatSync(fileDescriptor, { bigint: true });
      if (!sameIdentity(observed, opened)) throw new Error(`workspace_snapshot_staging_identity_changed:${relative}`);
      fs.fsyncSync(fileDescriptor);
      if (!sameIdentity(opened, fs.fstatSync(fileDescriptor, { bigint: true }))) throw new Error(`workspace_snapshot_staging_changed_while_syncing:${relative}`);
    } finally { fs.closeSync(fileDescriptor); }
  }
  fs.fsyncSync(directoryDescriptor);
  if (!sameIdentity(before, fs.fstatSync(directoryDescriptor, { bigint: true }))) {
    throw new Error(`workspace_snapshot_staging_changed_while_syncing:${relativeDirectory || '.'}`);
  }
}

export function copyExternalContentToStage(entry, stagePath) {
  const external = entry.externalContent;
  let pinned = null;
  try { pinned = openPinnedRegularFile(external.path, `workspace_snapshot_external_content_restore_blocked:${entry.path}`); } catch { throw new Error(`workspace_snapshot_external_content_restore_blocked:${entry.path}`); }
  let destinationDescriptor = null;
  try {
    ensureStagedParent(stagePath, entry.path);
    destinationDescriptor = fs.openSync(path.join(stagePath, ...entry.path.split('/')),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
    const hash = hashAndCopyDescriptor(pinned.descriptor, destinationDescriptor);
    fs.fsyncSync(destinationDescriptor);
    const after = fs.fstatSync(pinned.descriptor, { bigint: true });
    if (!sameIdentity(pinned.opened, after) || Number(after.size) !== external.bytes || hash !== external.hash) {
      throw new Error(`workspace_snapshot_external_content_restore_blocked:${entry.path}`);
    }
  } finally {
    if (destinationDescriptor !== null) fs.closeSync(destinationDescriptor);
    if (pinned) fs.closeSync(pinned.descriptor);
  }
}
