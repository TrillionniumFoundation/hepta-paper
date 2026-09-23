import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  submissionHandoffBundleStagingNamePattern,
} from './handoff-bundle-staging-namespace.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;
const MAXIMUM_STAGING_INVENTORY = 64;
const MAXIMUM_STAGING_CLEANUP_ENTRIES = 8_192;
const MAXIMUM_STAGING_CLEANUP_DEPTH = 64;
const STAGING_OWNER_SUFFIX = '.owner.json';
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const STAGING_OWNER_KEYS = Object.freeze([
  'finalRoot',
  'kind',
  'markerName',
  'ownerPid',
  'ownerProcessStartTicks',
  'ownerToken',
  'parentIdentity',
  'stagingIdentity',
  'stagingName',
  'submissionHandoffBundleStagingOwnerHash',
  'version',
]);

function inodeIdentity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function trustedOwner(stat) {
  return typeof process.geteuid !== 'function'
    || Number(stat.uid) === process.geteuid();
}

function hasExactKeys(value, expected) {
  return value && typeof value === 'object'
    && Object.keys(value).sort().join('\0')
      === [...expected].sort().join('\0');
}

function validInodeIdentity(value) {
  return hasExactKeys(value, ['dev', 'ino'])
    && /^[0-9]+$/u.test(String(value.dev))
    && /^[0-9]+$/u.test(String(value.ino));
}

function validEntryName(value) {
  return typeof value === 'string'
    && value !== '.' && value !== '..'
    && value.length > 0 && value.length <= 255
    && path.basename(value) === value
    && !value.includes('/') && !value.includes('\\') && !value.includes('\0');
}

function processStartTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${Number(pid)}/stat`, 'utf8');
    const closing = stat.lastIndexOf(')');
    if (closing < 0) return null;
    const fields = stat.slice(closing + 1).trim().split(/\s+/u);
    const ticks = fields[19];
    return /^[0-9]+$/u.test(String(ticks || '')) ? String(ticks) : null;
  } catch {
    return null;
  }
}

function ownerPayload(owner) {
  const payload = { ...owner };
  delete payload.submissionHandoffBundleStagingOwnerHash;
  return payload;
}

export function assertSubmissionHandoffBundleStagingOwner(
  owner,
  publication = null,
) {
  if (!hasExactKeys(owner, STAGING_OWNER_KEYS)
    || owner.version !== 1
    || owner.kind !== 'SubmissionHandoffBundleStagingOwner'
    || !validEntryName(owner.markerName)
    || !validEntryName(owner.stagingName)
    || !validInodeIdentity(owner.parentIdentity)
    || !validInodeIdentity(owner.stagingIdentity)
    || !Number.isSafeInteger(owner.ownerPid) || owner.ownerPid < 1
    || !/^[0-9]+$/u.test(String(owner.ownerProcessStartTicks || ''))
    || !/^[0-9a-f]{32}$/u.test(String(owner.ownerToken || ''))
    || !SHA256.test(String(owner.submissionHandoffBundleStagingOwnerHash || ''))
    || owner.markerName !== `${owner.stagingName}${STAGING_OWNER_SUFFIX}`
    || owner.submissionHandoffBundleStagingOwnerHash !== hashRecord(
      'SubmissionHandoffBundleStagingOwner',
      ownerPayload(owner),
    )) {
    throw new Error('handoff_bundle_staging_owner_invalid');
  }
  if (publication
    && (owner.finalRoot !== publication.finalRoot
      || owner.stagingName !== publication.stagingName
      || !sameIdentity(owner.parentIdentity, publication.parentIdentity)
      || !sameIdentity(owner.stagingIdentity, publication.stagingIdentity))) {
    throw new Error('handoff_bundle_staging_owner_binding_invalid');
  }
  return owner;
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeFully(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written <= 0) {
      throw new Error('handoff_bundle_staging_owner_write_failed');
    }
    offset += written;
  }
}

function assertPinnedParent(boundary, descriptor) {
  let lexical;
  try { lexical = fs.lstatSync(boundary.parent, { bigint: true }); } catch {
    lexical = null;
  }
  const pinned = fs.fstatSync(descriptor, { bigint: true });
  if (!lexical?.isDirectory() || lexical.isSymbolicLink()
    || !sameIdentity(boundary.parentIdentity, inodeIdentity(lexical))
    || !sameIdentity(boundary.parentIdentity, inodeIdentity(pinned))
    || fs.realpathSync.native(boundary.parent) !== boundary.parent) {
    throw new Error('handoff_bundle_root_parent_identity_changed');
  }
}

function assertTrustedCleanupParent(boundary, descriptor) {
  assertPinnedParent(boundary, descriptor);
  const parent = fs.fstatSync(descriptor, { bigint: true });
  if (!trustedOwner(parent) || (parent.mode & 0o022n) !== 0n) {
    throw new Error('handoff_bundle_staging_cleanup_parent_untrusted');
  }
}

function markerPath(parentDescriptor, markerName) {
  return path.join(`/proc/self/fd/${parentDescriptor}`, markerName);
}

function removeStagingMarker(parentDescriptor, markerName, expected = null) {
  const candidate = markerPath(parentDescriptor, markerName);
  let current;
  try { current = fs.lstatSync(candidate, { bigint: true }); } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!current.isFile() || current.isSymbolicLink() || !trustedOwner(current)
    || current.nlink !== 1n
    || (expected && !sameIdentity(expected, inodeIdentity(current)))) {
    throw new Error('handoff_bundle_staging_owner_file_invalid');
  }
  fs.unlinkSync(candidate);
  return true;
}

function validateOpenedMarker(initial, opened, bytes) {
  const completed = fs.fstatSync(opened.descriptor, { bigint: true });
  const lexical = fs.lstatSync(opened.path, { bigint: true });
  if (!trustedOwner(completed) || !trustedOwner(lexical)
    || !sameIdentity(inodeIdentity(initial), inodeIdentity(completed))
    || !sameIdentity(inodeIdentity(completed), inodeIdentity(lexical))
    || completed.nlink !== 1n || lexical.nlink !== 1n
    || completed.size !== BigInt(bytes.length)
    || (completed.mode & 0o777n) !== 0o444n) {
    throw new Error('handoff_bundle_staging_owner_file_changed');
  }
  return completed;
}

function readStagingOwner(parentDescriptor, markerName) {
  const candidate = markerPath(parentDescriptor, markerName);
  let initial;
  try { initial = fs.lstatSync(candidate, { bigint: true }); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let descriptor;
  try {
    if (!initial.isFile() || initial.isSymbolicLink() || !trustedOwner(initial)
      || initial.nlink !== 1n || initial.size > 32_768n) {
      throw new Error('handoff_bundle_staging_owner_file_invalid');
    }
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | NO_FOLLOW);
    const openedStat = fs.fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(inodeIdentity(initial), inodeIdentity(openedStat))) {
      throw new Error('handoff_bundle_staging_owner_file_changed');
    }
    const bytes = fs.readFileSync(descriptor);
    const completed = validateOpenedMarker(initial, {
      descriptor,
      path: candidate,
    }, bytes);
    let owner;
    try { owner = JSON.parse(bytes.toString('utf8')); } catch {
      throw new Error('handoff_bundle_staging_owner_json_invalid');
    }
    assertSubmissionHandoffBundleStagingOwner(owner);
    if (!bytes.equals(canonicalJsonBytes(owner))) {
      throw new Error('handoff_bundle_staging_owner_encoding_invalid');
    }
    return Object.freeze({
      identity: inodeIdentity(completed),
      owner: Object.freeze(owner),
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function removeCreatedMarker(boundary, parentDescriptor, owner, identity) {
  if (parentDescriptor === undefined || !identity) return;
  try {
    removeStagingMarker(parentDescriptor, owner.markerName, identity);
    fs.fsyncSync(parentDescriptor);
    assertTrustedCleanupParent(boundary, parentDescriptor);
  } catch {
    // Retain anything no longer provably owned for bounded later reconciliation.
  }
}

export function createSubmissionHandoffBundleStagingOwnerSync({
  boundary,
  reservation,
  stagingName,
} = {}) {
  const startTicks = processStartTicks(process.pid);
  if (!startTicks) throw new Error('handoff_bundle_staging_owner_process_invalid');
  const payload = {
    version: 1,
    kind: 'SubmissionHandoffBundleStagingOwner',
    finalRoot: boundary.finalRoot,
    parentIdentity: boundary.parentIdentity,
    stagingName,
    stagingIdentity: reservation.rootIdentity,
    markerName: `${stagingName}${STAGING_OWNER_SUFFIX}`,
    ownerPid: process.pid,
    ownerProcessStartTicks: startTicks,
    ownerToken: crypto.randomBytes(16).toString('hex'),
  };
  const owner = Object.freeze({
    ...payload,
    submissionHandoffBundleStagingOwnerHash: hashRecord(
      'SubmissionHandoffBundleStagingOwner',
      payload,
    ),
  });
  assertSubmissionHandoffBundleStagingOwner(owner);
  return writeStagingOwner(boundary, owner);
}

function writeStagingOwner(boundary, owner) {
  const bytes = canonicalJsonBytes(owner);
  let parentDescriptor;
  let descriptor;
  let identity = null;
  try {
    parentDescriptor = fs.openSync(
      boundary.parent,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    assertTrustedCleanupParent(boundary, parentDescriptor);
    descriptor = fs.openSync(
      markerPath(parentDescriptor, owner.markerName),
      fs.constants.O_WRONLY | fs.constants.O_CREAT
        | fs.constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    identity = inodeIdentity(opened);
    if (!opened.isFile() || !trustedOwner(opened) || opened.nlink !== 1n) {
      throw new Error('handoff_bundle_staging_owner_file_invalid');
    }
    writeFully(descriptor, bytes);
    fs.fchmodSync(descriptor, 0o444);
    fs.fsyncSync(descriptor);
    const completed = fs.fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(identity, inodeIdentity(completed))
      || completed.size !== BigInt(bytes.length)
      || (completed.mode & 0o777n) !== 0o444n) {
      throw new Error('handoff_bundle_staging_owner_file_invalid');
    }
    fs.fsyncSync(parentDescriptor);
    assertTrustedCleanupParent(boundary, parentDescriptor);
    return owner;
  } catch (error) {
    removeCreatedMarker(boundary, parentDescriptor, owner, identity);
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (parentDescriptor !== undefined) fs.closeSync(parentDescriptor);
  }
}

function listPinnedEntries(descriptor, {
  include = () => true,
  maximumEntries = MAXIMUM_STAGING_CLEANUP_ENTRIES,
  overflowError = 'handoff_bundle_staging_cleanup_entries_exceeded',
} = {}) {
  const directory = fs.opendirSync(`/proc/self/fd/${descriptor}`, {
    encoding: 'buffer',
  });
  const names = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      const raw = Buffer.isBuffer(entry.name)
        ? entry.name : Buffer.from(entry.name, 'utf8');
      const name = raw.toString('utf8');
      if (!Buffer.from(name, 'utf8').equals(raw) || !validEntryName(name)) {
        throw new Error('handoff_bundle_staging_cleanup_entry_invalid');
      }
      if (!include(name)) continue;
      names.push(name);
      if (names.length > maximumEntries) throw new Error(overflowError);
    }
  } finally {
    directory.closeSync();
  }
  return names.sort();
}

function prepareCleanupDirectory(descriptor) {
  const opened = fs.fstatSync(descriptor, { bigint: true });
  if (!opened.isDirectory() || !trustedOwner(opened)) {
    throw new Error('handoff_bundle_staging_cleanup_entry_invalid');
  }
  if ((opened.mode & 0o700n) !== 0o700n) {
    fs.fchmodSync(descriptor, 0o700);
    fs.fsyncSync(descriptor);
  }
}

function removePinnedChild(parentDescriptor, name, counters, depth) {
  counters.entries += 1;
  if (counters.entries > MAXIMUM_STAGING_CLEANUP_ENTRIES) {
    throw new Error('handoff_bundle_staging_cleanup_entries_exceeded');
  }
  const child = path.join(`/proc/self/fd/${parentDescriptor}`, name);
  const initial = fs.lstatSync(child, { bigint: true });
  if (!trustedOwner(initial)
    || (!initial.isDirectory() && !initial.isFile()
      && !initial.isSymbolicLink())) {
    throw new Error('handoff_bundle_staging_cleanup_entry_invalid');
  }
  if (!initial.isDirectory() || initial.isSymbolicLink()) {
    const completed = fs.lstatSync(child, { bigint: true });
    if (!sameIdentity(inodeIdentity(initial), inodeIdentity(completed))) {
      throw new Error('handoff_bundle_staging_cleanup_identity_changed');
    }
    fs.unlinkSync(child);
    return;
  }
  let descriptor;
  try {
    descriptor = fs.openSync(
      child,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(inodeIdentity(initial), inodeIdentity(opened))) {
      throw new Error('handoff_bundle_staging_cleanup_identity_changed');
    }
    removePinnedTreeContents(descriptor, counters, depth + 1);
    const completed = fs.lstatSync(child, { bigint: true });
    if (!sameIdentity(inodeIdentity(opened), inodeIdentity(completed))) {
      throw new Error('handoff_bundle_staging_cleanup_identity_changed');
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  fs.rmdirSync(child);
}

function removePinnedTreeContents(descriptor, counters, depth = 0) {
  if (depth > MAXIMUM_STAGING_CLEANUP_DEPTH) {
    throw new Error('handoff_bundle_staging_cleanup_depth_exceeded');
  }
  prepareCleanupDirectory(descriptor);
  for (const name of listPinnedEntries(descriptor, {
    maximumEntries: MAXIMUM_STAGING_CLEANUP_ENTRIES - counters.entries,
  })) {
    removePinnedChild(descriptor, name, counters, depth);
  }
  fs.fsyncSync(descriptor);
}

function removeOwnedStagingRoot(parentDescriptor, name, expectedIdentity) {
  const pinned = path.join(`/proc/self/fd/${parentDescriptor}`, name);
  let descriptor;
  try {
    const initial = fs.lstatSync(pinned, { bigint: true });
    if (!initial.isDirectory() || initial.isSymbolicLink()
      || !trustedOwner(initial) || (initial.mode & 0o077n) !== 0n
      || !sameIdentity(expectedIdentity, inodeIdentity(initial))) {
      throw new Error('handoff_bundle_staging_cleanup_root_invalid');
    }
    descriptor = fs.openSync(
      pinned,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(expectedIdentity, inodeIdentity(opened))) {
      throw new Error('handoff_bundle_staging_cleanup_identity_changed');
    }
    removePinnedTreeContents(descriptor, { entries: 0 });
    const completed = fs.lstatSync(pinned, { bigint: true });
    if (!sameIdentity(expectedIdentity, inodeIdentity(completed))) {
      throw new Error('handoff_bundle_staging_cleanup_identity_changed');
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  fs.rmdirSync(pinned);
}

function inventoryStagingName(pattern, name) {
  if (pattern.test(name)) return name;
  if (!name.endsWith(STAGING_OWNER_SUFFIX)) return null;
  const stagingName = name.slice(0, -STAGING_OWNER_SUFFIX.length);
  return pattern.test(stagingName) ? stagingName : null;
}

function validPartialMarker(parentDescriptor, markerName) {
  let partial;
  try {
    partial = fs.lstatSync(markerPath(parentDescriptor, markerName), {
      bigint: true,
    });
  } catch {
    return false;
  }
  return partial.isFile() && !partial.isSymbolicLink()
    && trustedOwner(partial) && partial.nlink === 1n;
}

function inspectInventoryEntry(boundary, parentDescriptor, name) {
  const pinned = path.join(`/proc/self/fd/${parentDescriptor}`, name);
  const stage = fs.lstatSync(pinned, { bigint: true });
  const stageIdentity = inodeIdentity(stage);
  if (!stage.isDirectory() || stage.isSymbolicLink()
    || !trustedOwner(stage) || (stage.mode & 0o077n) !== 0n) {
    throw new Error('handoff_bundle_staging_inventory_entry_invalid');
  }
  const markerName = `${name}${STAGING_OWNER_SUFFIX}`;
  let marker = null;
  let markerError = null;
  try { marker = readStagingOwner(parentDescriptor, markerName); } catch (error) {
    markerError = error;
  }
  if (marker) {
    const owner = marker.owner;
    if (owner.finalRoot !== boundary.finalRoot || owner.stagingName !== name
      || !sameIdentity(owner.parentIdentity, boundary.parentIdentity)
      || !sameIdentity(owner.stagingIdentity, stageIdentity)) {
      throw new Error('handoff_bundle_staging_owner_binding_invalid');
    }
    if (processStartTicks(owner.ownerPid) === owner.ownerProcessStartTicks) {
      return Object.freeze({ active: true, marker, markerName, stageIdentity });
    }
  } else {
    const namePid = Number(name.match(
      submissionHandoffBundleStagingNamePattern(boundary.finalRoot),
    )?.[1]);
    if (processStartTicks(namePid) !== null) {
      return Object.freeze({ active: true, marker, markerName, stageIdentity });
    }
    if (markerError && !validPartialMarker(parentDescriptor, markerName)) {
      throw markerError;
    }
  }
  return Object.freeze({ active: false, marker, markerName, stageIdentity });
}

function cleanupInventoryEntry(parentDescriptor, name, inspected) {
  removeOwnedStagingRoot(parentDescriptor, name, inspected.stageIdentity);
  if (inspected.marker) {
    removeStagingMarker(
      parentDescriptor,
      inspected.markerName,
      inspected.marker.identity,
    );
  } else {
    removeStagingMarker(parentDescriptor, inspected.markerName);
  }
}

function cleanupMarkerOnlyEntry(boundary, parentDescriptor, name) {
  const marker = readStagingOwner(
    parentDescriptor,
    `${name}${STAGING_OWNER_SUFFIX}`,
  );
  if (!marker
    || marker.owner.finalRoot !== boundary.finalRoot
    || marker.owner.stagingName !== name
    || !sameIdentity(marker.owner.parentIdentity, boundary.parentIdentity)) {
    throw new Error('handoff_bundle_staging_owner_binding_invalid');
  }
  removeStagingMarker(
    parentDescriptor,
    marker.owner.markerName,
    marker.identity,
  );
}

export function reconcileSubmissionHandoffBundleStagingAtBoundarySync(
  boundary,
) {
  let parentDescriptor;
  let mutated = false;
  const cleanedStages = [];
  const activeStages = [];
  try {
    parentDescriptor = fs.openSync(
      boundary.parent,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    assertTrustedCleanupParent(boundary, parentDescriptor);
    const pattern = submissionHandoffBundleStagingNamePattern(
      boundary.finalRoot,
    );
    const entries = listPinnedEntries(parentDescriptor, {
      include: (name) => Boolean(inventoryStagingName(pattern, name)),
      maximumEntries: MAXIMUM_STAGING_INVENTORY * 2,
      overflowError: 'handoff_bundle_staging_inventory_exceeded',
    });
    const names = [...new Set(entries.map(
      (name) => inventoryStagingName(pattern, name),
    ))].sort();
    if (names.length > MAXIMUM_STAGING_INVENTORY) {
      throw new Error('handoff_bundle_staging_inventory_exceeded');
    }
    const entrySet = new Set(entries);
    for (const name of names) {
      if (!entrySet.has(name)) {
        cleanupMarkerOnlyEntry(boundary, parentDescriptor, name);
        cleanedStages.push(name);
        mutated = true;
      } else {
        const inspected = inspectInventoryEntry(
          boundary,
          parentDescriptor,
          name,
        );
        if (inspected.active) {
          activeStages.push(name);
          continue;
        }
        cleanupInventoryEntry(parentDescriptor, name, inspected);
        cleanedStages.push(name);
        mutated = true;
      }
    }
    if (mutated) fs.fsyncSync(parentDescriptor);
    assertTrustedCleanupParent(boundary, parentDescriptor);
  } finally {
    if (parentDescriptor !== undefined) fs.closeSync(parentDescriptor);
  }
  return Object.freeze({
    status: activeStages.length
      ? 'submission_handoff_bundle_staging_in_progress'
      : 'submission_handoff_bundle_staging_reconciled',
    activeStages: Object.freeze(activeStages),
    cleanedStages: Object.freeze(cleanedStages),
    localFilesystemMutationPerformed: mutated,
  });
}

export function removeSubmissionHandoffBundleStagingOwnerAtBoundarySync({
  boundary,
  publication,
} = {}) {
  let parentDescriptor;
  try {
    parentDescriptor = fs.openSync(
      boundary.parent,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    assertTrustedCleanupParent(boundary, parentDescriptor);
    const marker = readStagingOwner(
      parentDescriptor,
      publication.stagingOwner.markerName,
    );
    if (!marker) return false;
    assertSubmissionHandoffBundleStagingOwner(marker.owner, publication);
    removeStagingMarker(
      parentDescriptor,
      publication.stagingOwner.markerName,
      marker.identity,
    );
    fs.fsyncSync(parentDescriptor);
    assertTrustedCleanupParent(boundary, parentDescriptor);
    return true;
  } finally {
    if (parentDescriptor !== undefined) fs.closeSync(parentDescriptor);
  }
}

export function abandonSubmissionHandoffBundleAtBoundarySync({
  boundary,
  publication,
} = {}) {
  let parentDescriptor;
  try {
    parentDescriptor = fs.openSync(
      boundary.parent,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    assertTrustedCleanupParent(boundary, parentDescriptor);
    const marker = readStagingOwner(
      parentDescriptor,
      publication.stagingOwner.markerName,
    );
    if (!marker) throw new Error('handoff_bundle_staging_owner_missing');
    assertSubmissionHandoffBundleStagingOwner(marker.owner, publication);
    try {
      removeOwnedStagingRoot(
        parentDescriptor,
        publication.stagingName,
        publication.stagingIdentity,
      );
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    removeStagingMarker(
      parentDescriptor,
      publication.stagingOwner.markerName,
      marker.identity,
    );
    fs.fsyncSync(parentDescriptor);
    assertTrustedCleanupParent(boundary, parentDescriptor);
    return true;
  } finally {
    if (parentDescriptor !== undefined) fs.closeSync(parentDescriptor);
  }
}
