import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import {
  abandonSubmissionHandoffBundleAtBoundarySync,
  assertSubmissionHandoffBundleStagingOwner,
  createSubmissionHandoffBundleStagingOwnerSync,
  reconcileSubmissionHandoffBundleStagingAtBoundarySync,
  removeSubmissionHandoffBundleStagingOwnerAtBoundarySync,
} from './handoff-bundle-staging-owner-repository.mjs';
import {
  createSubmissionHandoffBundleStagingName,
  submissionHandoffBundleStagingNamePattern,
} from './handoff-bundle-staging-namespace.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;
const TRUSTED_MOVE_EXECUTABLE = '/usr/bin/mv';
const MOVE_TIMEOUT_MS = 30_000;
const STAGING_ATTEMPTS = 8;
const PUBLICATION_KEYS = Object.freeze([
  'finalRoot',
  'kind',
  'parent',
  'parentIdentity',
  'repositoryCasRoot',
  'repositoryScopeRoot',
  'stagingOwner',
  'stagingIdentity',
  'stagingName',
  'stagingRoot',
  'submissionHandoffBundlePublicationHash',
  'version',
]);
const PUBLICATION_LINEAGE_KEYS = Object.freeze([
  'finalName',
  'kind',
  'parentIdentity',
  'stagingIdentity',
  'submissionHandoffBundlePublicationHash',
  'submissionHandoffBundlePublicationLineageHash',
  'version',
]);

function inodeIdentity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function executableIdentity(stat) {
  return Object.freeze({
    ...inodeIdentity(stat),
    gid: String(stat.gid),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    uid: String(stat.uid),
  });
}

function sameExecutableIdentity(left, right) {
  return sameIdentity(left, right)
    && left?.gid === right?.gid
    && left?.mode === right?.mode
    && left?.nlink === right?.nlink
    && left?.uid === right?.uid;
}

function publicationPayload(publication) {
  const payload = { ...publication };
  delete payload.submissionHandoffBundlePublicationHash;
  return payload;
}

function hasExactKeys(value, expected) {
  return value && typeof value === 'object'
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function validInodeIdentity(value) {
  return hasExactKeys(value, ['dev', 'ino'])
    && /^[0-9]+$/u.test(String(value.dev))
    && /^[0-9]+$/u.test(String(value.ino));
}

function validStagingName(value) {
  return typeof value === 'string'
    && value !== '.' && value !== '..'
    && value.length > 0 && value.length <= 255
    && path.basename(value) === value
    && !value.includes('/') && !value.includes('\\') && !value.includes('\0');
}

export function assertSubmissionHandoffBundlePublicationRecord(publication) {
  if (!hasExactKeys(publication, PUBLICATION_KEYS)
    || publication?.version !== 1
    || publication?.kind !== 'SubmissionHandoffBundlePublication'
    || !validStagingName(publication?.stagingName)
    || !validInodeIdentity(publication?.parentIdentity)
    || !validInodeIdentity(publication?.stagingIdentity)
    || typeof publication?.finalRoot !== 'string'
    || typeof publication?.stagingRoot !== 'string'
    || typeof publication?.parent !== 'string'
    || typeof publication?.repositoryScopeRoot !== 'string'
    || typeof publication?.repositoryCasRoot !== 'string'
    || hashRecord(
      'SubmissionHandoffBundlePublication',
      publicationPayload(publication),
    ) !== publication.submissionHandoffBundlePublicationHash) {
    throw new Error('handoff_bundle_publication_record_invalid');
  }
  assertSubmissionHandoffBundleStagingOwner(
    publication.stagingOwner,
    publication,
  );
  return publication;
}

function assertPublicationLineage(lineage) {
  if (!hasExactKeys(lineage, PUBLICATION_LINEAGE_KEYS)
    || lineage?.version !== 1
    || lineage?.kind !== 'SubmissionHandoffBundlePublicationLineage'
    || !validStagingName(lineage?.finalName)
    || !validInodeIdentity(lineage?.parentIdentity)
    || !validInodeIdentity(lineage?.stagingIdentity)
    || !/^sha256:[0-9a-f]{64}$/u.test(String(
      lineage?.submissionHandoffBundlePublicationHash || '',
    ))) {
    throw new Error('handoff_bundle_publication_lineage_invalid');
  }
  const payload = { ...lineage };
  delete payload.submissionHandoffBundlePublicationLineageHash;
  if (lineage.submissionHandoffBundlePublicationLineageHash !== hashRecord(
    'SubmissionHandoffBundlePublicationLineage',
    payload,
  )) {
    throw new Error('handoff_bundle_publication_lineage_hash_invalid');
  }
}

function inspectPublicationBoundary({
  finalRoot,
  repositoryScopeRoot,
  repositoryCasRoot,
} = {}) {
  if (!finalRoot) throw new Error('handoff_bundle_root_missing');
  if (!repositoryScopeRoot) throw new Error('handoff_bundle_repository_scope_missing');
  if (!repositoryCasRoot) throw new Error('handoff_bundle_repository_cas_missing');
  const selected = path.resolve(finalRoot);
  const scopeRoot = path.resolve(repositoryScopeRoot);
  let scopeStat;
  try { scopeStat = fs.lstatSync(scopeRoot); } catch { /* handled below */ }
  if (!scopeStat?.isDirectory() || scopeStat.isSymbolicLink()
    || fs.realpathSync.native(scopeRoot) !== scopeRoot) {
    throw new Error('handoff_bundle_repository_scope_unsafe');
  }
  if (selected === scopeRoot || !isPathWithin(scopeRoot, selected)) {
    throw new Error('handoff_bundle_root_outside_repository_scope');
  }
  const casRoot = path.resolve(repositoryCasRoot);
  if (isPathWithin(selected, casRoot) || isPathWithin(casRoot, selected)) {
    throw new Error('handoff_bundle_root_overlaps_repository_cas');
  }
  const parent = path.dirname(selected);
  let parentStat;
  try { parentStat = fs.lstatSync(parent, { bigint: true }); } catch { /* handled below */ }
  if (selected === parent || !parentStat?.isDirectory() || parentStat.isSymbolicLink()
    || fs.realpathSync.native(parent) !== parent) {
    throw new Error('handoff_bundle_root_parent_unsafe');
  }
  return Object.freeze({
    finalRoot: selected,
    finalName: path.basename(selected),
    parent,
    parentIdentity: inodeIdentity(parentStat),
    repositoryCasRoot: casRoot,
    repositoryScopeRoot: scopeRoot,
  });
}

export function inspectSubmissionHandoffBundlePublicationBoundary(options = {}) {
  return inspectPublicationBoundary(options);
}

function removeOwnedEmptyReservationSync(candidate, expectedIdentity) {
  try {
    const current = fs.lstatSync(candidate, { bigint: true });
    if (current.isDirectory() && !current.isSymbolicLink()
      && sameIdentity(inodeIdentity(current), expectedIdentity)
      && fs.readdirSync(candidate).length === 0) {
      fs.rmdirSync(candidate);
      return true;
    }
  } catch { /* retain any reservation that is no longer provably ours and empty */ }
  return false;
}

export function reconcileSubmissionHandoffBundleStagingOrphansSync({
  finalRoot,
  repositoryScopeRoot,
  repositoryCasRoot,
} = {}) {
  const boundary = inspectPublicationBoundary({
    finalRoot,
    repositoryScopeRoot,
    repositoryCasRoot,
  });
  return reconcileSubmissionHandoffBundleStagingAtBoundarySync(boundary);
}

export function removeSubmissionHandoffBundleStagingOwnerSync(publication) {
  assertSubmissionHandoffBundlePublicationRecord(publication);
  const boundary = inspectPublicationBoundary({
    finalRoot: publication.finalRoot,
    repositoryScopeRoot: publication.repositoryScopeRoot,
    repositoryCasRoot: publication.repositoryCasRoot,
  });
  return removeSubmissionHandoffBundleStagingOwnerAtBoundarySync({
    boundary,
    publication,
  });
}

export function abandonSubmissionHandoffBundlePublicationSync(publication) {
  assertSubmissionHandoffBundlePublicationRecord(publication);
  const boundary = inspectPublicationBoundary({
    finalRoot: publication.finalRoot,
    repositoryScopeRoot: publication.repositoryScopeRoot,
    repositoryCasRoot: publication.repositoryCasRoot,
  });
  return abandonSubmissionHandoffBundleAtBoundarySync({
    boundary,
    publication,
  });
}

function assertPinnedParent(boundary, descriptor) {
  let lexical;
  try { lexical = fs.lstatSync(boundary.parent, { bigint: true }); } catch { /* below */ }
  const pinned = fs.fstatSync(descriptor, { bigint: true });
  if (!lexical?.isDirectory() || lexical.isSymbolicLink()
    || !sameIdentity(boundary.parentIdentity, inodeIdentity(lexical))
    || !sameIdentity(boundary.parentIdentity, inodeIdentity(pinned))
    || fs.realpathSync.native(boundary.parent) !== boundary.parent) {
    throw new Error('handoff_bundle_root_parent_identity_changed');
  }
}

function reservePinnedRoot(boundary, name) {
  let parentDescriptor;
  let rootDescriptor;
  let pinnedRoot;
  let reservedIdentity = null;
  let reservationCreated = false;
  try {
    parentDescriptor = fs.openSync(
      boundary.parent,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    assertPinnedParent(boundary, parentDescriptor);
    pinnedRoot = path.join(`/proc/self/fd/${parentDescriptor}`, name);
    try {
      fs.mkdirSync(pinnedRoot, { recursive: false, mode: 0o700 });
      reservationCreated = true;
    } catch (error) {
      if (error?.code === 'EEXIST') throw new Error('handoff_bundle_root_preexisting');
      throw new Error(
        `handoff_bundle_root_reservation_failed:${error?.code || 'unknown'}`,
      );
    }
    rootDescriptor = fs.openSync(
      pinnedRoot,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    const reserved = fs.fstatSync(rootDescriptor, { bigint: true });
    const pinned = fs.lstatSync(pinnedRoot, { bigint: true });
    reservedIdentity = inodeIdentity(reserved);
    if (!reserved.isDirectory() || pinned.isSymbolicLink()
      || !sameIdentity(reservedIdentity, inodeIdentity(pinned))) {
      throw new Error('handoff_bundle_root_reservation_identity_invalid');
    }
    fs.fchmodSync(rootDescriptor, 0o700);
    fs.fsyncSync(rootDescriptor);
    const lexicalRoot = path.join(boundary.parent, name);
    assertPinnedParent(boundary, parentDescriptor);
    const lexical = fs.lstatSync(lexicalRoot, { bigint: true });
    if (!lexical.isDirectory() || lexical.isSymbolicLink()
      || !sameIdentity(reservedIdentity, inodeIdentity(lexical))
      || fs.realpathSync.native(lexicalRoot) !== lexicalRoot
      || Number(lexical.mode & 0o777n) !== 0o700
      || !sameIdentity(reservedIdentity, inodeIdentity(
        fs.fstatSync(rootDescriptor, { bigint: true }),
      ))) {
      throw new Error('handoff_bundle_root_parent_identity_changed');
    }
    return Object.freeze({
      root: lexicalRoot,
      rootIdentity: reservedIdentity,
    });
  } catch (error) {
    if (reservedIdentity && pinnedRoot) {
      removeOwnedEmptyReservationSync(pinnedRoot, reservedIdentity);
    }
    if (reservationCreated && error && typeof error === 'object') {
      error.localFilesystemMutationPerformed = true;
    }
    throw error;
  } finally {
    if (rootDescriptor !== undefined) fs.closeSync(rootDescriptor);
    if (parentDescriptor !== undefined) fs.closeSync(parentDescriptor);
  }
}

function assertFinalAbsent(finalRoot) {
  try {
    fs.lstatSync(finalRoot);
    throw new Error('handoff_bundle_final_preexisting');
  } catch (error) {
    if (error?.message === 'handoff_bundle_final_preexisting') throw error;
    if (error?.code !== 'ENOENT') throw new Error('handoff_bundle_final_state_unreadable');
  }
}

function openTrustedMoveExecutable() {
  const before = fs.lstatSync(TRUSTED_MOVE_EXECUTABLE, { bigint: true });
  const beforeIdentity = executableIdentity(before);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.uid !== 0n || before.gid !== 0n
    || Number(before.mode & 0o777n) !== 0o755) {
    throw new Error('handoff_bundle_move_executable_untrusted');
  }
  const descriptor = fs.openSync(
    TRUSTED_MOVE_EXECUTABLE,
    fs.constants.O_RDONLY | NO_FOLLOW,
  );
  const opened = fs.fstatSync(descriptor, { bigint: true });
  if (!opened.isFile()
    || !sameExecutableIdentity(beforeIdentity, executableIdentity(opened))) {
    fs.closeSync(descriptor);
    throw new Error('handoff_bundle_move_executable_identity_changed');
  }
  return Object.freeze({ descriptor, identity: beforeIdentity });
}

function closeTrustedMoveExecutable(executable) {
  const opened = fs.fstatSync(executable.descriptor, { bigint: true });
  const lexical = fs.lstatSync(TRUSTED_MOVE_EXECUTABLE, { bigint: true });
  if (!sameExecutableIdentity(executable.identity, executableIdentity(opened))
    || !sameExecutableIdentity(executable.identity, executableIdentity(lexical))) {
    throw new Error('handoff_bundle_move_executable_identity_changed');
  }
}

export function reserveSubmissionHandoffBundleRootSync({
  bundleRoot,
  repositoryScopeRoot,
  repositoryCasRoot,
} = {}) {
  const boundary = inspectPublicationBoundary({
    finalRoot: bundleRoot,
    repositoryScopeRoot,
    repositoryCasRoot,
  });
  return reservePinnedRoot(boundary, boundary.finalName);
}

export function createSubmissionHandoffBundlePublication({
  finalRoot,
  repositoryScopeRoot,
  repositoryCasRoot,
} = {}) {
  const boundary = inspectPublicationBoundary({
    finalRoot,
    repositoryScopeRoot,
    repositoryCasRoot,
  });
  assertFinalAbsent(boundary.finalRoot);
  let reservation = null;
  let stagingName = null;
  for (let attempt = 0; attempt < STAGING_ATTEMPTS && !reservation; attempt += 1) {
    stagingName = createSubmissionHandoffBundleStagingName({
      finalRoot: boundary.finalRoot,
    });
    try {
      reservation = reservePinnedRoot(boundary, stagingName);
    } catch (error) {
      if (error?.message !== 'handoff_bundle_root_preexisting') throw error;
    }
  }
  if (!reservation) throw new Error('handoff_bundle_staging_name_exhausted');
  try {
    assertFinalAbsent(boundary.finalRoot);
  } catch (error) {
    removeOwnedEmptyReservationSync(reservation.root, reservation.rootIdentity);
    throw error;
  }
  let stagingOwner;
  try {
    stagingOwner = createSubmissionHandoffBundleStagingOwnerSync({
      boundary,
      reservation,
      stagingName,
    });
  } catch (error) {
    removeOwnedEmptyReservationSync(reservation.root, reservation.rootIdentity);
    if (error && typeof error === 'object') {
      error.localFilesystemMutationPerformed = true;
    }
    throw error;
  }
  const payload = {
    version: 1,
    kind: 'SubmissionHandoffBundlePublication',
    finalRoot: boundary.finalRoot,
    stagingRoot: reservation.root,
    stagingName,
    parent: boundary.parent,
    parentIdentity: boundary.parentIdentity,
    stagingIdentity: reservation.rootIdentity,
    stagingOwner,
    repositoryScopeRoot: boundary.repositoryScopeRoot,
    repositoryCasRoot: boundary.repositoryCasRoot,
  };
  return Object.freeze({
    ...payload,
    submissionHandoffBundlePublicationHash: hashRecord(
      'SubmissionHandoffBundlePublication',
      payload,
    ),
  });
}

export function createSubmissionHandoffBundlePublicationLineage(publication) {
  assertSubmissionHandoffBundlePublicationRecord(publication);
  const payload = {
    version: 1,
    kind: 'SubmissionHandoffBundlePublicationLineage',
    finalName: path.basename(publication.finalRoot),
    parentIdentity: publication.parentIdentity,
    stagingIdentity: publication.stagingIdentity,
    submissionHandoffBundlePublicationHash:
      publication.submissionHandoffBundlePublicationHash,
  };
  return Object.freeze({
    ...payload,
    submissionHandoffBundlePublicationLineageHash: hashRecord(
      'SubmissionHandoffBundlePublicationLineage',
      payload,
    ),
  });
}

export function recoverSubmissionHandoffBundlePublication({
  finalRoot,
  repositoryScopeRoot,
  repositoryCasRoot,
  publicationLineage,
} = {}) {
  assertPublicationLineage(publicationLineage);
  const boundary = inspectPublicationBoundary({
    finalRoot,
    repositoryScopeRoot,
    repositoryCasRoot,
  });
  if (publicationLineage.finalName !== boundary.finalName
    || !sameIdentity(
      publicationLineage.parentIdentity,
      boundary.parentIdentity,
    )) {
    throw new Error('handoff_bundle_publication_recovery_boundary_invalid');
  }
  let parentDescriptor;
  try {
    parentDescriptor = fs.openSync(
      boundary.parent,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    assertPinnedParent(boundary, parentDescriptor);
    const pinnedFinal = path.join(
      `/proc/self/fd/${parentDescriptor}`,
      boundary.finalName,
    );
    const before = fs.lstatSync(pinnedFinal, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()
      || !sameIdentity(
        inodeIdentity(before),
        publicationLineage.stagingIdentity,
      )
      || (before.mode & 0o222n) !== 0n) {
      throw new Error('handoff_bundle_publication_recovery_final_invalid');
    }
    try {
      fs.fsyncSync(parentDescriptor);
    } catch {
      throw new Error('handoff_bundle_publication_recovery_durability_failed');
    }
    assertPinnedParent(boundary, parentDescriptor);
    const after = fs.lstatSync(pinnedFinal, { bigint: true });
    if (!sameIdentity(inodeIdentity(before), inodeIdentity(after))) {
      throw new Error('handoff_bundle_publication_recovery_final_changed');
    }
    const payload = {
      version: 1,
      kind: 'SubmissionHandoffBundlePublicationRecoveryReceipt',
      status: 'submission_handoff_bundle_publication_recovered',
      finalRoot: boundary.finalRoot,
      submissionHandoffBundlePublicationHash:
        publicationLineage.submissionHandoffBundlePublicationHash,
      submissionHandoffBundlePublicationLineageHash:
        publicationLineage.submissionHandoffBundlePublicationLineageHash,
      externalActionPerformed: false,
    };
    return Object.freeze({
      ...payload,
      submissionHandoffBundlePublicationRecoveryReceiptHash: hashRecord(
        'SubmissionHandoffBundlePublicationRecoveryReceipt',
        payload,
      ),
    });
  } finally {
    if (parentDescriptor !== undefined) fs.closeSync(parentDescriptor);
  }
}

export function publishSubmissionHandoffBundle(
  publication,
  { spawnSyncImpl = spawnSync } = {},
) {
  assertSubmissionHandoffBundlePublicationRecord(publication);
  const boundary = inspectPublicationBoundary({
    finalRoot: publication.finalRoot,
    repositoryScopeRoot: publication.repositoryScopeRoot,
    repositoryCasRoot: publication.repositoryCasRoot,
  });
  if (!sameIdentity(boundary.parentIdentity, publication.parentIdentity)
    || boundary.parent !== publication.parent
    || boundary.repositoryScopeRoot !== publication.repositoryScopeRoot
    || boundary.repositoryCasRoot !== publication.repositoryCasRoot
    || publication.stagingRoot !== path.join(
      boundary.parent,
      publication.stagingName,
    )
    || !submissionHandoffBundleStagingNamePattern(boundary.finalRoot)
      .test(publication.stagingName)) {
    throw new Error('handoff_bundle_root_parent_identity_changed');
  }
  let parentDescriptor;
  let executable;
  try {
    parentDescriptor = fs.openSync(
      boundary.parent,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    assertPinnedParent(boundary, parentDescriptor);
    const pinnedParent = `/proc/self/fd/${parentDescriptor}`;
    const pinnedStaging = path.join(pinnedParent, publication.stagingName);
    const pinnedFinal = path.join(pinnedParent, boundary.finalName);
    const childPinnedParent = '/proc/self/fd/3';
    const childPinnedStaging = path.join(
      childPinnedParent,
      publication.stagingName,
    );
    const childPinnedFinal = path.join(childPinnedParent, boundary.finalName);
    const staging = fs.lstatSync(pinnedStaging, { bigint: true });
    if (!staging.isDirectory() || staging.isSymbolicLink()
      || !sameIdentity(inodeIdentity(staging), publication.stagingIdentity)
      || (staging.mode & 0o222n) !== 0n) {
      throw new Error('handoff_bundle_staging_identity_invalid');
    }
    assertFinalAbsent(pinnedFinal);
    executable = openTrustedMoveExecutable();
    const result = spawnSyncImpl(
      '/proc/self/fd/4',
      [
        '--no-clobber',
        '--no-copy',
        '--no-target-directory',
        '--',
        childPinnedStaging,
        childPinnedFinal,
      ],
      {
        encoding: 'buffer',
        env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
        maxBuffer: 1024 * 1024,
        stdio: [
          'ignore',
          'pipe',
          'pipe',
          parentDescriptor,
          executable.descriptor,
        ],
        timeout: MOVE_TIMEOUT_MS,
      },
    );
    closeTrustedMoveExecutable(executable);
    if (result.error || result.signal || result.status !== 0) {
      let failedStaging = null;
      let failedFinal = null;
      try { failedStaging = fs.lstatSync(pinnedStaging, { bigint: true }); } catch { /* absent */ }
      try { failedFinal = fs.lstatSync(pinnedFinal, { bigint: true }); } catch { /* absent */ }
      if (failedFinal && failedStaging
        && sameIdentity(
          inodeIdentity(failedStaging),
          publication.stagingIdentity,
        )) {
        throw new Error('handoff_bundle_final_preexisting');
      }
      throw new Error('handoff_bundle_atomic_publication_failed');
    }
    assertPinnedParent(boundary, parentDescriptor);
    let remainingStaging = null;
    let publishedFinal = null;
    try { remainingStaging = fs.lstatSync(pinnedStaging, { bigint: true }); } catch { /* absent */ }
    try { publishedFinal = fs.lstatSync(pinnedFinal, { bigint: true }); } catch { /* below */ }
    if (remainingStaging) {
      if (sameIdentity(inodeIdentity(remainingStaging), publication.stagingIdentity)
        && publishedFinal) throw new Error('handoff_bundle_final_preexisting');
      throw new Error('handoff_bundle_atomic_publication_incomplete');
    }
    if (!publishedFinal?.isDirectory() || publishedFinal.isSymbolicLink()
      || !sameIdentity(inodeIdentity(publishedFinal), publication.stagingIdentity)
      || fs.realpathSync.native(boundary.finalRoot) !== boundary.finalRoot) {
      throw new Error('handoff_bundle_atomic_publication_identity_invalid');
    }
    try {
      fs.fsyncSync(parentDescriptor);
    } catch {
      throw new Error('handoff_bundle_atomic_publication_durability_failed');
    }
    assertPinnedParent(boundary, parentDescriptor);
    const durableFinal = fs.lstatSync(pinnedFinal, { bigint: true });
    if (!sameIdentity(inodeIdentity(durableFinal), publication.stagingIdentity)) {
      throw new Error('handoff_bundle_atomic_publication_identity_invalid');
    }
    const moveExecutableIdentityHash = hashRecord(
      'SubmissionHandoffMoveExecutableIdentity',
      executable.identity,
    );
    const payload = {
      version: 1,
      kind: 'SubmissionHandoffBundlePublicationReceipt',
      status: 'submission_handoff_bundle_published',
      finalRoot: boundary.finalRoot,
      stagingRoot: publication.stagingRoot,
      stagingIdentity: publication.stagingIdentity,
      parentIdentity: publication.parentIdentity,
      moveExecutableIdentityHash,
      submissionHandoffBundlePublicationHash:
        publication.submissionHandoffBundlePublicationHash,
      externalActionPerformed: false,
    };
    return Object.freeze({
      ...payload,
      submissionHandoffBundlePublicationReceiptHash: hashRecord(
        'SubmissionHandoffBundlePublicationReceipt',
        payload,
      ),
    });
  } finally {
    if (executable?.descriptor !== undefined) fs.closeSync(executable.descriptor);
    if (parentDescriptor !== undefined) fs.closeSync(parentDescriptor);
  }
}
