import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SNAPSHOT_ID = /^[a-f0-9]{64}$/;
const MAXIMUM_MANIFEST_BYTES = 16 * 1024 * 1024;
const SIGNATURE_KEYS = Object.freeze([
  'algorithm', 'authorityLimit', 'kind', 'payloadHash', 'publicKeyFingerprint', 'publicKeyPem',
  'role', 'signature', 'version',
]);
const MANIFEST_KEYS = Object.freeze([
  'contractId', 'kind', 'manifestHash', 'objects', 'offHostOrOffsiteCustodyQualified',
  'protectionLevel', 'signature', 'snapshotId', 'version',
]);
const MANIFEST_PAYLOAD_KEYS = Object.freeze([
  'contractId', 'kind', 'objects', 'offHostOrOffsiteCustodyQualified',
  'protectionLevel', 'snapshotId', 'version',
]);
const OBJECT_KEYS = Object.freeze([
  'immutable', 'objectHash', 'objectPath', 'role', 'sourceHash',
]);

function semanticReleaseVersionParts(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)(?:-|$)/);
  return match ? match.slice(1).map(Number) : null;
}

export function isSemanticReleaseVersion(value) {
  return semanticReleaseVersionParts(value) !== null;
}

export function compareSemanticReleaseVersions(left, right) {
  const leftParts = semanticReleaseVersionParts(left);
  const rightParts = semanticReleaseVersionParts(right);
  if (!leftParts && !rightParts) return 0;
  if (!leftParts) return -1;
  if (!rightParts) return 1;
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function exactKeys(value, expected) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function directoryIdentity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function stableFileIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
    nlink: String(stat.nlink), size: String(stat.size), uid: String(stat.uid),
    mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
  });
}

function sameIdentity(left, right) {
  return Boolean(left && right
    && Object.keys(left).every((key) => left[key] === right[key]));
}

export function openPinnedDirectory(candidate, errorCode) {
  const selected = path.resolve(candidate);
  let descriptor;
  try {
    const before = fs.lstatSync(selected, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()
      || fs.realpathSync(selected) !== selected) throw new Error(errorCode);
    descriptor = fs.openSync(
      selected,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | NO_FOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const identity = directoryIdentity(opened);
    if (!opened.isDirectory()
      || !sameIdentity(directoryIdentity(before), identity)) throw new Error(errorCode);
    return { path: selected, descriptor, identity };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw error;
  }
}

export function pinnedChildPath(parent, name, errorCode) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..'
    || path.basename(name) !== name || name.includes('/') || name.includes('\\')) {
    throw new Error(errorCode);
  }
  return path.join('/proc/self/fd', String(parent.descriptor), name);
}

export function assertPinnedDirectoryCurrent(directory, errorCode) {
  let selected;
  try { selected = fs.lstatSync(directory.path, { bigint: true }); }
  catch { throw new Error(errorCode); }
  const opened = fs.fstatSync(directory.descriptor, { bigint: true });
  if (!selected.isDirectory() || selected.isSymbolicLink() || !opened.isDirectory()
    || !sameIdentity(directory.identity, directoryIdentity(selected))
    || !sameIdentity(directory.identity, directoryIdentity(opened))) throw new Error(errorCode);
}

export function assertPinnedDirectoryChain(chain, errorCode) {
  for (const directory of chain) assertPinnedDirectoryCurrent(directory, errorCode);
}

export function openPinnedChildDirectory(parent, name, errorCode) {
  assertPinnedDirectoryCurrent(parent, errorCode);
  const descriptorPath = pinnedChildPath(parent, name, errorCode);
  let descriptor;
  try {
    const selected = fs.lstatSync(descriptorPath, { bigint: true });
    if (!selected.isDirectory() || selected.isSymbolicLink()) throw new Error(errorCode);
    descriptor = fs.openSync(
      descriptorPath,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | NO_FOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const identity = directoryIdentity(opened);
    if (!opened.isDirectory()
      || !sameIdentity(directoryIdentity(selected), identity)) throw new Error(errorCode);
    const child = { path: path.join(parent.path, name), descriptor, identity };
    assertPinnedDirectoryCurrent(parent, errorCode);
    assertPinnedDirectoryCurrent(child, errorCode);
    return child;
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw error;
  }
}

export function ensurePinnedChildDirectory(parent, name, errorCode) {
  assertPinnedDirectoryCurrent(parent, errorCode);
  const descriptorPath = pinnedChildPath(parent, name, errorCode);
  try { fs.mkdirSync(descriptorPath, { mode: 0o700 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  return openPinnedChildDirectory(parent, name, errorCode);
}

export function removePinnedChildExact(parent, name, identity) {
  const child = pinnedChildPath(parent, name, 'offhost_worm_cleanup_path_invalid');
  const quarantineName = `.${name}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.quarantine`;
  const quarantine = pinnedChildPath(parent, quarantineName, 'offhost_worm_cleanup_path_invalid');
  try {
    fs.renameSync(child, quarantine);
    const moved = fs.lstatSync(quarantine, { bigint: true });
    if (!moved.isFile() || moved.isSymbolicLink()
      || !sameIdentity(identity, directoryIdentity(moved))) {
      try { fs.linkSync(quarantine, child); } catch { /* Preserve quarantined bytes. */ }
      return false;
    }
    fs.unlinkSync(quarantine);
    return true;
  } catch { return false; }
}

function openPinnedRegularFile(candidate, errorCode) {
  const selected = path.resolve(candidate);
  let descriptor;
  try {
    const before = fs.lstatSync(selected, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || (before.mode & 0o222n) !== 0n) throw new Error(errorCode);
    descriptor = fs.openSync(selected, fs.constants.O_RDONLY | NO_FOLLOW);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const identity = stableFileIdentity(opened);
    if (!opened.isFile() || !sameIdentity(stableFileIdentity(before), identity)) {
      throw new Error(errorCode);
    }
    return { descriptor, path: selected, identity };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw error;
  }
}

function assertPinnedFileCurrent(pinned, errorCode) {
  const selected = fs.lstatSync(pinned.path, { bigint: true });
  const opened = fs.fstatSync(pinned.descriptor, { bigint: true });
  if (!selected.isFile() || selected.isSymbolicLink()
    || !sameIdentity(pinned.identity, stableFileIdentity(selected))
    || !sameIdentity(pinned.identity, stableFileIdentity(opened))) throw new Error(errorCode);
}

function hashPinnedFile(pinned, errorCode) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  let offset = 0;
  for (;;) {
    const bytesRead = fs.readSync(pinned.descriptor, buffer, 0, buffer.length, offset);
    if (!bytesRead) break;
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  if (String(offset) !== pinned.identity.size) throw new Error(errorCode);
  assertPinnedFileCurrent(pinned, errorCode);
  return `sha256:${hash.digest('hex')}`;
}

function readPinnedBytes(candidate, errorCode) {
  const pinned = openPinnedRegularFile(candidate, errorCode);
  try {
    if (BigInt(pinned.identity.size) < 2n
      || BigInt(pinned.identity.size) > BigInt(MAXIMUM_MANIFEST_BYTES)) throw new Error(errorCode);
    const bytes = fs.readFileSync(pinned.descriptor);
    if (String(bytes.length) !== pinned.identity.size) throw new Error(errorCode);
    assertPinnedFileCurrent(pinned, errorCode);
    return bytes;
  } finally { fs.closeSync(pinned.descriptor); }
}

function filesystemImmutable(file) {
  const probe = spawnSync('lsattr', ['-d', file], { encoding: 'utf8' });
  if (probe.status !== 0) return false;
  return (String(probe.stdout || '').trim().split(/\s+/, 1)[0] || '').includes('i');
}

function writeBufferToDescriptor(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
  }
}

function copyPinnedToDescriptor(source, destinationDescriptor) {
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  let offset = 0;
  for (;;) {
    const bytesRead = fs.readSync(source.pinned.descriptor, buffer, 0, buffer.length, offset);
    if (!bytesRead) break;
    let written = 0;
    while (written < bytesRead) {
      written += fs.writeSync(
        destinationDescriptor,
        buffer,
        written,
        bytesRead - written,
      );
    }
    offset += bytesRead;
  }
  if (offset !== source.bytes) throw new Error('offhost_worm_source_changed_during_copy');
}

function pathExistsNoFollow(candidate) {
  try { fs.lstatSync(candidate); return true; }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function publishSnapshotObject(source, destination, parent, parentChain) {
  const name = path.basename(destination);
  const descriptorPath = pinnedChildPath(parent, name, 'offhost_worm_object_path_invalid');
  assertPinnedDirectoryChain(parentChain, 'offhost_worm_object_parent_changed');
  let createdIdentity = null;
  if (!pathExistsNoFollow(descriptorPath)) {
    let descriptor;
    let identity;
    try {
      descriptor = fs.openSync(
        descriptorPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
        0o444,
      );
      identity = directoryIdentity(fs.fstatSync(descriptor, { bigint: true }));
      createdIdentity = identity;
      assertPinnedDirectoryChain(parentChain, 'offhost_worm_object_parent_changed');
      if (source.captured) writeBufferToDescriptor(descriptor, source.captured);
      else copyPinnedToDescriptor(source, descriptor);
      fs.fchmodSync(descriptor, 0o444);
      fs.fsyncSync(descriptor);
      assertPinnedDirectoryChain(parentChain, 'offhost_worm_object_parent_changed');
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      descriptor = undefined;
      if (identity) removePinnedChildExact(parent, name, identity);
      throw error;
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
  assertPinnedDirectoryChain(parentChain, 'offhost_worm_object_parent_changed');
  const object = openPinnedRegularFile(descriptorPath, 'offhost_worm_object_unsafe');
  try {
    const objectHash = hashPinnedFile(object, 'offhost_worm_object_changed');
    assertPinnedDirectoryChain(parentChain, 'offhost_worm_object_parent_changed');
    return Object.freeze({ objectHash, createdIdentity, name, descriptorPath });
  } finally { fs.closeSync(object.descriptor); }
}

export function publishManifestNoClobber(manifestPath, bytes, parent, parentChain) {
  const name = path.basename(manifestPath);
  const descriptorPath = pinnedChildPath(parent, name, 'offhost_worm_manifest_path_invalid');
  assertPinnedDirectoryChain(parentChain, 'offhost_worm_manifest_parent_changed');
  if (pathExistsNoFollow(descriptorPath)) {
    const existing = readPinnedBytes(descriptorPath, 'offhost_worm_manifest_unsafe');
    if (!existing.equals(bytes)) throw new Error('offhost_worm_manifest_collision');
    assertPinnedDirectoryChain(parentChain, 'offhost_worm_manifest_parent_changed');
    return Object.freeze({ createdIdentity: null, name, descriptorPath });
  }
  let descriptor; let identity;
  try {
    descriptor = fs.openSync(
      descriptorPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o444,
    );
    identity = directoryIdentity(fs.fstatSync(descriptor, { bigint: true }));
    assertPinnedDirectoryChain(parentChain, 'offhost_worm_manifest_parent_changed');
    writeBufferToDescriptor(descriptor, bytes);
    fs.fchmodSync(descriptor, 0o444);
    fs.fsyncSync(descriptor);
    assertPinnedDirectoryChain(parentChain, 'offhost_worm_manifest_parent_changed');
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    descriptor = undefined;
    if (identity) removePinnedChildExact(parent, name, identity);
    throw error;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  return Object.freeze({ createdIdentity: identity, name, descriptorPath });
}

function blockedRestore(blockers, details = {}) {
  return Object.freeze({
    version: 2,
    kind: 'OffhostWormRestoreDrillReceipt',
    status: 'offhost_worm_restore_drill_blocked',
    manifestHash: null,
    verifiedObjectCount: 0,
    ...details,
    blockers: [...new Set(blockers)],
  });
}

export function drillOffhostWormRestore({
  manifestPath,
  targetMountRoot,
  immutableOverride = null,
  verifyManifestSignature = null,
} = {}) {
  if (typeof manifestPath !== 'string' || typeof targetMountRoot !== 'string'
    || typeof verifyManifestSignature !== 'function') {
    return blockedRestore(['offhost_worm_restore_authority_or_path_missing']);
  }
  const rootPath = path.resolve(targetMountRoot);
  const selectedManifest = path.resolve(manifestPath);
  const relative = path.relative(rootPath, selectedManifest).replace(/\\/g, '/');
  const components = relative.split('/');
  if (components.length !== 3 || components[0] !== 'hepta-paper-worm'
    || !SNAPSHOT_ID.test(components[1])
    || components[2] !== 'OFFHOST_WORM_SNAPSHOT_MANIFEST.json') {
    return blockedRestore(['offhost_worm_manifest_path_outside_fixed_root']);
  }
  let targetRoot; let wormDirectory; let snapshotDirectory; let objectDirectory;
  try {
    targetRoot = openPinnedDirectory(rootPath, 'offhost_worm_restore_target_root_unsafe');
    wormDirectory = openPinnedChildDirectory(
      targetRoot, 'hepta-paper-worm', 'offhost_worm_restore_repository_root_unsafe',
    );
    snapshotDirectory = openPinnedChildDirectory(
      wormDirectory, components[1], 'offhost_worm_restore_snapshot_root_unsafe',
    );
    objectDirectory = openPinnedChildDirectory(
      snapshotDirectory, 'objects', 'offhost_worm_restore_object_root_unsafe',
    );
    const directoryChain = [targetRoot, wormDirectory, snapshotDirectory, objectDirectory];
    assertPinnedDirectoryChain(directoryChain, 'offhost_worm_restore_directory_chain_changed');
    const manifestBytes = readPinnedBytes(pinnedChildPath(
      snapshotDirectory,
      'OFFHOST_WORM_SNAPSHOT_MANIFEST.json',
      'offhost_worm_manifest_path_invalid',
    ), 'offhost_worm_manifest_unsafe');
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (!exactKeys(manifest, MANIFEST_KEYS)) {
      return blockedRestore(['offhost_worm_manifest_shape_invalid']);
    }
    const { signature, manifestHash, ...payload } = manifest;
    const blockers = [];
    if (!exactKeys(payload, MANIFEST_PAYLOAD_KEYS)
      || manifest.version !== 2 || manifest.kind !== 'OffhostWormSnapshotManifest'
      || manifest.snapshotId !== components[1] || !SHA256.test(String(manifestHash || ''))
      || hashRecord('OffhostWormSnapshotManifest', payload) !== manifestHash) {
      blockers.push('offhost_worm_manifest_hash_or_identity_invalid');
    }
    const unsignedManifest = Object.freeze({ ...payload, manifestHash });
    if (!exactKeys(signature, SIGNATURE_KEYS)
      || verifyManifestSignature(unsignedManifest, signature) !== true) {
      blockers.push('offhost_worm_manifest_signature_invalid');
    }
    if (!Array.isArray(manifest.objects) || manifest.objects.length < 1) {
      blockers.push('offhost_worm_manifest_objects_invalid');
    }
    const invalidRoles = new Set();
    const roles = new Set();
    const hashes = new Set();
    for (const object of Array.isArray(manifest.objects) ? manifest.objects : []) {
      const role = typeof object?.role === 'string' ? object.role : 'invalid';
      const token = String(object?.sourceHash || '').replace(/^sha256:/, '');
      const expectedObjectPath = path.join(snapshotDirectory.path, 'objects', token);
      if (!exactKeys(object, OBJECT_KEYS) || !role || roles.has(role)
        || !SHA256.test(String(object?.sourceHash || ''))
        || object.objectHash !== object.sourceHash || object.immutable !== true
        || object.objectPath !== expectedObjectPath || hashes.has(object.sourceHash)) {
        blockers.push(`offhost_worm_object_contract_invalid:${role}`);
        invalidRoles.add(role);
        continue;
      }
      roles.add(role);
      hashes.add(object.sourceHash);
      let pinned;
      try {
        assertPinnedDirectoryChain(directoryChain, 'offhost_worm_restore_directory_chain_changed');
        pinned = openPinnedRegularFile(
          pinnedChildPath(objectDirectory, token, 'offhost_worm_object_path_invalid'),
          'offhost_worm_object_unsafe',
        );
        const objectHash = hashPinnedFile(pinned, 'offhost_worm_object_changed');
        const immutable = immutableOverride === null
          ? filesystemImmutable(pinned.path) : Boolean(immutableOverride);
        assertPinnedDirectoryChain(directoryChain, 'offhost_worm_restore_directory_chain_changed');
        if (objectHash !== object.sourceHash) {
          blockers.push(`offhost_worm_object_hash_mismatch:${role}`);
          invalidRoles.add(role);
        }
        if (!immutable) {
          blockers.push(`offhost_worm_object_not_immutable:${role}`);
          invalidRoles.add(role);
        }
      } catch {
        blockers.push(`offhost_worm_object_unsafe_or_changed:${role}`);
        invalidRoles.add(role);
      } finally { if (pinned?.descriptor !== undefined) fs.closeSync(pinned.descriptor); }
    }
    assertPinnedDirectoryChain(directoryChain, 'offhost_worm_restore_directory_chain_changed');
    return Object.freeze({
      version: 2,
      kind: 'OffhostWormRestoreDrillReceipt',
      status: blockers.length
        ? 'offhost_worm_restore_drill_blocked' : 'offhost_worm_restore_drill_passed',
      manifestHash,
      signingKeyFingerprint: signature?.publicKeyFingerprint || null,
      verifiedObjectCount: manifest.objects.length - invalidRoles.size,
      blockers: [...new Set(blockers)],
    });
  } catch (error) {
    return blockedRestore([error?.message || 'offhost_worm_restore_failed']);
  } finally {
    for (const directory of [objectDirectory, snapshotDirectory, wormDirectory, targetRoot]) {
      if (directory?.descriptor !== undefined) fs.closeSync(directory.descriptor);
    }
  }
}
