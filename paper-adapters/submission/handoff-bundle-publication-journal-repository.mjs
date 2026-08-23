import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  writeAtomicPreparedSubmissionHandoffJournal,
} from './handoff-bundle-publication-journal-atomic-writer.mjs';
import {
  abandonSubmissionHandoffBundlePublicationSync,
  assertSubmissionHandoffBundlePublicationRecord,
  inspectSubmissionHandoffBundlePublicationBoundary,
  removeSubmissionHandoffBundleStagingOwnerSync,
} from './handoff-bundle-publication-repository.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;
const MAXIMUM_JOURNAL_BYTES = 64 * 1024;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PUBLICATION_KEYS = Object.freeze([
  'finalRoot', 'kind', 'parent', 'parentIdentity', 'repositoryCasRoot',
  'repositoryScopeRoot', 'stagingIdentity', 'stagingName', 'stagingOwner',
  'stagingRoot',
  'submissionHandoffBundlePublicationHash', 'version',
]);
const JOURNAL_KEYS = Object.freeze([
  'finalRoot', 'kind', 'parentIdentity', 'publication',
  'residualRiskDisclosures', 'stagingIdentity', 'status',
  'submissionHandoffBundleManifestHash',
  'submissionHandoffBundlePublicationHash',
  'submissionHandoffBundlePublicationJournalHash',
  'submissionHandoffBundlePublicationLineageHash',
  'submissionHandoffRequestRecoveryBindingHash', 'version',
]);

export const SUBMISSION_HANDOFF_PUBLICATION_JOURNAL_RESIDUAL_RISKS =
  Object.freeze([
    'handoff_publication_journal_same_uid_noncooperating_sibling_forgery_not_fenced',
  ]);

function hasExactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function inodeIdentity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function validIdentity(value) {
  return hasExactKeys(value, ['dev', 'ino'])
    && /^[0-9]+$/u.test(String(value.dev))
    && /^[0-9]+$/u.test(String(value.ino));
}

function validEntryName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255
    && value !== '.' && value !== '..' && path.basename(value) === value
    && !value.includes('/') && !value.includes('\\') && !value.includes('\0');
}

function trustedOwner(stat) {
  return typeof process.geteuid !== 'function'
    || Number(stat.uid) === process.geteuid();
}

function trustedParent(stat) {
  return stat.isDirectory() && !stat.isSymbolicLink()
    && trustedOwner(stat) && (stat.mode & 0o022n) === 0n;
}

function trustedJournalFile(stat, { allowTwinLink = false } = {}) {
  return stat.isFile() && !stat.isSymbolicLink() && trustedOwner(stat)
    && (stat.mode & 0o777n) === 0o444n
    && (stat.nlink === 1n || (allowTwinLink && stat.nlink === 2n));
}

function trustedStagingDirectory(stat) {
  return stat.isDirectory() && !stat.isSymbolicLink() && trustedOwner(stat)
    && (stat.mode & 0o222n) === 0n;
}

function publicationPayload(publication) {
  const payload = { ...publication };
  delete payload.submissionHandoffBundlePublicationHash;
  return payload;
}

function journalPayload(journal) {
  const payload = { ...journal };
  delete payload.submissionHandoffBundlePublicationJournalHash;
  return payload;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function journalStem(finalRoot) {
  const selected = path.resolve(finalRoot || '.');
  const label = path.basename(selected)
    .replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 48) || 'bundle';
  const suffix = crypto.createHash('sha256').update(selected).digest('hex').slice(0, 32);
  return `.${label}.handoff-publication-${suffix}`;
}

export function submissionHandoffBundlePublicationJournalPaths({ finalRoot } = {}) {
  const selected = path.resolve(finalRoot || '.');
  const parent = path.dirname(selected);
  const stem = journalStem(selected);
  return Object.freeze({
    completedPath: path.join(parent, `${stem}.completed.json`),
    preparedPath: path.join(parent, `${stem}.prepared.json`),
  });
}

function pinTrustedParent(boundary) {
  let descriptor;
  try {
    const lexical = fs.lstatSync(boundary.parent, { bigint: true });
    if (!trustedParent(lexical)
      || !sameIdentity(boundary.parentIdentity, inodeIdentity(lexical))
      || fs.realpathSync.native(boundary.parent) !== boundary.parent) {
      throw new Error('handoff_bundle_publication_journal_parent_untrusted');
    }
    descriptor = fs.openSync(
      boundary.parent,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!trustedParent(opened)
      || !sameIdentity(boundary.parentIdentity, inodeIdentity(opened))) {
      throw new Error('handoff_bundle_publication_journal_parent_untrusted');
    }
    return Object.freeze({ descriptor, identity: inodeIdentity(opened) });
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error?.message === 'handoff_bundle_publication_journal_parent_untrusted') {
      throw error;
    }
    throw new Error('handoff_bundle_publication_journal_parent_untrusted', {
      cause: error,
    });
  }
}

function assertPinnedParent(boundary, descriptor) {
  const lexical = fs.lstatSync(boundary.parent, { bigint: true });
  const opened = fs.fstatSync(descriptor, { bigint: true });
  if (!trustedParent(lexical) || !trustedParent(opened)
    || !sameIdentity(boundary.parentIdentity, inodeIdentity(lexical))
    || !sameIdentity(boundary.parentIdentity, inodeIdentity(opened))
    || fs.realpathSync.native(boundary.parent) !== boundary.parent) {
    throw new Error('handoff_bundle_publication_journal_parent_untrusted');
  }
}

function pinnedEntryPath(parentDescriptor, candidate) {
  return path.join(`/proc/self/fd/${parentDescriptor}`, path.basename(candidate));
}

function assertPinnedStaging(publication, boundary, parentDescriptor) {
  const pinned = pinnedEntryPath(parentDescriptor, publication.stagingRoot);
  let descriptor;
  try {
    const initial = fs.lstatSync(pinned, { bigint: true });
    descriptor = fs.openSync(
      pinned,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const completed = fs.lstatSync(pinned, { bigint: true });
    if (!trustedStagingDirectory(initial)
      || !trustedStagingDirectory(opened)
      || !trustedStagingDirectory(completed)
      || !sameIdentity(inodeIdentity(initial), publication.stagingIdentity)
      || !sameIdentity(inodeIdentity(opened), publication.stagingIdentity)
      || !sameIdentity(inodeIdentity(completed), publication.stagingIdentity)
      || fs.realpathSync.native(pinned) !== publication.stagingRoot) {
      throw new Error('handoff_bundle_publication_journal_staging_invalid');
    }
    assertPinnedParent(boundary, parentDescriptor);
  } catch (error) {
    if (error?.message
        === 'handoff_bundle_publication_journal_staging_invalid') throw error;
    throw new Error('handoff_bundle_publication_journal_staging_invalid', {
      cause: error,
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertPublication(publication, boundary) {
  try {
    assertSubmissionHandoffBundlePublicationRecord(publication);
  } catch (error) {
    throw new Error('handoff_bundle_publication_journal_record_invalid', {
      cause: error,
    });
  }
  if (!hasExactKeys(publication, PUBLICATION_KEYS)
    || publication.version !== 1
    || publication.kind !== 'SubmissionHandoffBundlePublication'
    || publication.finalRoot !== boundary.finalRoot
    || publication.parent !== boundary.parent
    || !validEntryName(publication.stagingName)
    || !validIdentity(publication.parentIdentity)
    || !validIdentity(publication.stagingIdentity)
    || !sameIdentity(publication.parentIdentity, boundary.parentIdentity)
    || publication.stagingRoot !== path.join(
      boundary.parent,
      publication.stagingName || '',
    )
    || publication.repositoryScopeRoot !== boundary.repositoryScopeRoot
    || publication.repositoryCasRoot !== boundary.repositoryCasRoot
    || publication.submissionHandoffBundlePublicationHash !== hashRecord(
      'SubmissionHandoffBundlePublication',
      publicationPayload(publication),
    )) {
    throw new Error('handoff_bundle_publication_journal_record_invalid');
  }
}

function assertJournalRecord(record, boundary) {
  if (!hasExactKeys(record, JOURNAL_KEYS)
    || record.version !== 1
    || record.kind !== 'SubmissionHandoffBundlePublicationJournal'
    || record.status !== 'submission_handoff_bundle_publication_prepared'
    || record.finalRoot !== boundary.finalRoot
    || !validIdentity(record.parentIdentity)
    || !validIdentity(record.stagingIdentity)
    || !sameIdentity(record.parentIdentity, boundary.parentIdentity)
    || !sameIdentity(record.stagingIdentity, record.publication?.stagingIdentity)
    || ![
      record.submissionHandoffRequestRecoveryBindingHash,
      record.submissionHandoffBundleManifestHash,
      record.submissionHandoffBundlePublicationHash,
      record.submissionHandoffBundlePublicationLineageHash,
    ].every((value) => SHA256.test(String(value || '')))
    || record.submissionHandoffBundlePublicationHash
      !== record.publication?.submissionHandoffBundlePublicationHash
    || JSON.stringify(record.residualRiskDisclosures)
      !== JSON.stringify(SUBMISSION_HANDOFF_PUBLICATION_JOURNAL_RESIDUAL_RISKS)
    || record.submissionHandoffBundlePublicationJournalHash !== hashRecord(
      'SubmissionHandoffBundlePublicationJournal',
      journalPayload(record),
    )) {
    throw new Error('handoff_bundle_publication_journal_record_invalid');
  }
  assertPublication(record.publication, boundary);
  return record;
}

function readJournalEntry(parentDescriptor, candidate, boundary) {
  const pinned = pinnedEntryPath(parentDescriptor, candidate);
  let initial;
  try {
    initial = fs.lstatSync(pinned, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let descriptor;
  try {
    descriptor = fs.openSync(pinned, fs.constants.O_RDONLY | NO_FOLLOW);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!trustedJournalFile(initial, { allowTwinLink: true })
      || !trustedJournalFile(opened, { allowTwinLink: true })
      || !sameIdentity(inodeIdentity(initial), inodeIdentity(opened))
      || opened.size > BigInt(MAXIMUM_JOURNAL_BYTES)) {
      throw new Error('handoff_bundle_publication_journal_file_invalid');
    }
    const bytes = fs.readFileSync(descriptor);
    const completed = fs.fstatSync(descriptor, { bigint: true });
    const lexical = fs.lstatSync(pinned, { bigint: true });
    if (!trustedJournalFile(completed, { allowTwinLink: true })
      || !trustedJournalFile(lexical, { allowTwinLink: true })
      || !sameIdentity(inodeIdentity(opened), inodeIdentity(completed))
      || !sameIdentity(inodeIdentity(completed), inodeIdentity(lexical))
      || completed.size !== BigInt(bytes.length)) {
      throw new Error('handoff_bundle_publication_journal_file_changed');
    }
    let record;
    try {
      record = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error('handoff_bundle_publication_journal_json_invalid');
    }
    assertJournalRecord(record, boundary);
    if (!bytes.equals(jsonBytes(record))) {
      throw new Error('handoff_bundle_publication_journal_encoding_invalid');
    }
    return Object.freeze({
      identity: inodeIdentity(completed),
      linkCount: Number(completed.nlink),
      record: Object.freeze(record),
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function inspectSubmissionHandoffBundlePublicationJournal({
  finalRoot,
  repositoryScopeRoot,
  repositoryCasRoot,
} = {}) {
  const boundary = inspectSubmissionHandoffBundlePublicationBoundary({
    finalRoot,
    repositoryScopeRoot,
    repositoryCasRoot,
  });
  const paths = submissionHandoffBundlePublicationJournalPaths({
    finalRoot: boundary.finalRoot,
  });
  const parent = pinTrustedParent(boundary);
  try {
    const completed = readJournalEntry(
      parent.descriptor,
      paths.completedPath,
      boundary,
    );
    const prepared = readJournalEntry(
      parent.descriptor,
      paths.preparedPath,
      boundary,
    );
    assertPinnedParent(boundary, parent.descriptor);
    if (completed) {
      const twin = Boolean(prepared
        && sameIdentity(completed.identity, prepared.identity)
        && completed.record.submissionHandoffBundlePublicationJournalHash
          === prepared.record.submissionHandoffBundlePublicationJournalHash);
      if ((prepared && !twin)
        || completed.linkCount !== (twin ? 2 : 1)
        || (prepared && prepared.linkCount !== 2)) {
        throw new Error('handoff_bundle_publication_journal_terminal_invalid');
      }
      return Object.freeze({
        status: 'submission_handoff_bundle_publication_journal_completed',
        boundary,
        entry: completed,
        paths,
        preparedTwin: twin,
      });
    }
    if (prepared) {
      if (prepared.linkCount !== 1) {
        throw new Error('handoff_bundle_publication_journal_file_invalid');
      }
      return Object.freeze({
        status: 'submission_handoff_bundle_publication_journal_prepared',
        boundary,
        entry: prepared,
        paths,
        preparedTwin: false,
      });
    }
    return Object.freeze({
      status: 'submission_handoff_bundle_publication_journal_absent',
      boundary,
      entry: null,
      paths,
      preparedTwin: false,
    });
  } finally {
    fs.closeSync(parent.descriptor);
  }
}

export function assertSubmissionHandoffBundlePublicationJournalForRecovery(
  state,
  {
    allowCompleted = false,
    submissionHandoffRequestRecoveryBindingHash,
    submissionHandoffBundleManifestHash = null,
    submissionHandoffBundlePublicationLineageHash = null,
  } = {},
) {
  if (state?.status
      === 'submission_handoff_bundle_publication_journal_absent') {
    throw new Error('handoff_bundle_preexisting_collision');
  }
  const recoverableCompleted = allowCompleted === true
    && state?.status
      === 'submission_handoff_bundle_publication_journal_completed';
  if (state?.status
      === 'submission_handoff_bundle_publication_journal_completed'
    && !recoverableCompleted) {
    throw new Error('handoff_bundle_publication_journal_already_completed');
  }
  const record = state?.entry?.record;
  if ((state?.status
      !== 'submission_handoff_bundle_publication_journal_prepared'
      && !recoverableCompleted)
    || record?.submissionHandoffRequestRecoveryBindingHash
      !== submissionHandoffRequestRecoveryBindingHash
    || (submissionHandoffBundleManifestHash
      && record.submissionHandoffBundleManifestHash
        !== submissionHandoffBundleManifestHash)
    || (submissionHandoffBundlePublicationLineageHash
      && record.submissionHandoffBundlePublicationLineageHash
        !== submissionHandoffBundlePublicationLineageHash)) {
    throw new Error('handoff_bundle_publication_journal_binding_mismatch');
  }
  return record;
}

export function createSubmissionHandoffBundlePublicationJournal({
  publication,
  submissionHandoffRequestRecoveryBindingHash,
  submissionHandoffBundleManifestHash,
  submissionHandoffBundlePublicationLineageHash,
} = {}) {
  const boundary = inspectSubmissionHandoffBundlePublicationBoundary({
    finalRoot: publication?.finalRoot,
    repositoryScopeRoot: publication?.repositoryScopeRoot,
    repositoryCasRoot: publication?.repositoryCasRoot,
  });
  assertPublication(publication, boundary);
  const payload = {
    version: 1,
    kind: 'SubmissionHandoffBundlePublicationJournal',
    status: 'submission_handoff_bundle_publication_prepared',
    finalRoot: boundary.finalRoot,
    parentIdentity: boundary.parentIdentity,
    stagingIdentity: publication.stagingIdentity,
    submissionHandoffRequestRecoveryBindingHash,
    submissionHandoffBundleManifestHash,
    submissionHandoffBundlePublicationHash:
      publication.submissionHandoffBundlePublicationHash,
    submissionHandoffBundlePublicationLineageHash,
    publication,
    residualRiskDisclosures:
      SUBMISSION_HANDOFF_PUBLICATION_JOURNAL_RESIDUAL_RISKS,
  };
  const record = Object.freeze({
    ...payload,
    submissionHandoffBundlePublicationJournalHash: hashRecord(
      'SubmissionHandoffBundlePublicationJournal',
      payload,
    ),
  });
  assertJournalRecord(record, boundary);
  const bytes = jsonBytes(record);
  if (bytes.length > MAXIMUM_JOURNAL_BYTES) {
    throw new Error('handoff_bundle_publication_journal_bytes_exceeded');
  }
  const before = inspectSubmissionHandoffBundlePublicationJournal({
    finalRoot: boundary.finalRoot,
    repositoryScopeRoot: boundary.repositoryScopeRoot,
    repositoryCasRoot: boundary.repositoryCasRoot,
  });
  if (before.status !== 'submission_handoff_bundle_publication_journal_absent') {
    throw new Error('handoff_bundle_publication_journal_preexisting');
  }
  const parent = pinTrustedParent(boundary);
  try {
    assertPinnedStaging(publication, boundary, parent.descriptor);
    assertPinnedParent(boundary, parent.descriptor);
    writeAtomicPreparedSubmissionHandoffJournal({
      bytes,
      parentDescriptor: parent.descriptor,
      preparedPath: before.paths.preparedPath,
    });
    assertPinnedParent(boundary, parent.descriptor);
  } finally {
    fs.closeSync(parent.descriptor);
  }
  const created = inspectSubmissionHandoffBundlePublicationJournal({
    finalRoot: boundary.finalRoot,
    repositoryScopeRoot: boundary.repositoryScopeRoot,
    repositoryCasRoot: boundary.repositoryCasRoot,
  });
  if (created.status !== 'submission_handoff_bundle_publication_journal_prepared'
    || created.entry.record.submissionHandoffBundlePublicationJournalHash
      !== record.submissionHandoffBundlePublicationJournalHash) {
    throw new Error('handoff_bundle_publication_journal_create_invalid');
  }
  return created;
}

export function createRecoverableSubmissionHandoffBundlePublicationJournal(
  input = {},
) {
  try {
    return createSubmissionHandoffBundlePublicationJournal(input);
  } catch (error) {
    let abandonCurrentPublication = false;
    try {
      const state = inspectSubmissionHandoffBundlePublicationJournal({
        finalRoot: input.publication?.finalRoot,
        repositoryScopeRoot: input.publication?.repositoryScopeRoot,
        repositoryCasRoot: input.publication?.repositoryCasRoot,
      });
      abandonCurrentPublication = state.status
        === 'submission_handoff_bundle_publication_journal_absent'
        || state.entry.record.submissionHandoffBundlePublicationHash
          !== input.publication?.submissionHandoffBundlePublicationHash;
      if (!abandonCurrentPublication) {
        assertSubmissionHandoffBundlePublicationJournalForRecovery(
          state,
          {
            allowCompleted: true,
            submissionHandoffRequestRecoveryBindingHash:
              input.submissionHandoffRequestRecoveryBindingHash,
            submissionHandoffBundleManifestHash:
              input.submissionHandoffBundleManifestHash,
            submissionHandoffBundlePublicationLineageHash:
              input.submissionHandoffBundlePublicationLineageHash,
          },
        );
      }
    } catch {
      /* Preserve ambiguous durable state; a retry will inspect it exactly. */
    }
    if (abandonCurrentPublication) {
      try { abandonSubmissionHandoffBundlePublicationSync(input.publication); } catch {}
    }
    throw error;
  }
}

function unlinkPreparedTwin(state) {
  if (!state.preparedTwin) return state;
  const parent = pinTrustedParent(state.boundary);
  let localFilesystemMutationPerformed = false;
  try {
    const pinnedPrepared = pinnedEntryPath(
      parent.descriptor,
      state.paths.preparedPath,
    );
    const prepared = fs.lstatSync(pinnedPrepared, { bigint: true });
    if (!trustedJournalFile(prepared, { allowTwinLink: true })
      || prepared.nlink !== 2n
      || !sameIdentity(state.entry.identity, inodeIdentity(prepared))) {
      throw new Error('handoff_bundle_publication_journal_terminal_invalid');
    }
    fs.unlinkSync(pinnedPrepared);
    localFilesystemMutationPerformed = true;
    fs.fsyncSync(parent.descriptor);
    assertPinnedParent(state.boundary, parent.descriptor);
  } catch (error) {
    if (error && typeof error === 'object') {
      error.localFilesystemMutationPerformed =
        localFilesystemMutationPerformed;
    }
    throw error;
  } finally {
    fs.closeSync(parent.descriptor);
  }
  return inspectSubmissionHandoffBundlePublicationJournal({
    finalRoot: state.boundary.finalRoot,
    repositoryScopeRoot: state.boundary.repositoryScopeRoot,
    repositoryCasRoot: state.boundary.repositoryCasRoot,
  });
}

export function completeSubmissionHandoffBundlePublicationJournal(state) {
  let completedState;
  if (state?.status
      === 'submission_handoff_bundle_publication_journal_completed') {
    completedState = unlinkPreparedTwin(state);
    removeSubmissionHandoffBundleStagingOwnerSync(
      completedState.entry.record.publication,
    );
    return completedState;
  }
  if (state?.status
      !== 'submission_handoff_bundle_publication_journal_prepared') {
    throw new Error('handoff_bundle_publication_journal_not_prepared');
  }
  const parent = pinTrustedParent(state.boundary);
  try {
    const pinnedPrepared = pinnedEntryPath(
      parent.descriptor,
      state.paths.preparedPath,
    );
    const pinnedCompleted = pinnedEntryPath(
      parent.descriptor,
      state.paths.completedPath,
    );
    const prepared = fs.lstatSync(pinnedPrepared, { bigint: true });
    if (!trustedJournalFile(prepared)
      || !sameIdentity(state.entry.identity, inodeIdentity(prepared))) {
      throw new Error('handoff_bundle_publication_journal_file_changed');
    }
    try {
      fs.linkSync(pinnedPrepared, pinnedCompleted);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    fs.fsyncSync(parent.descriptor);
    assertPinnedParent(state.boundary, parent.descriptor);
  } finally {
    fs.closeSync(parent.descriptor);
  }
  const completed = inspectSubmissionHandoffBundlePublicationJournal({
    finalRoot: state.boundary.finalRoot,
    repositoryScopeRoot: state.boundary.repositoryScopeRoot,
    repositoryCasRoot: state.boundary.repositoryCasRoot,
  });
  if (completed.status
      !== 'submission_handoff_bundle_publication_journal_completed'
    || completed.entry.record.submissionHandoffBundlePublicationJournalHash
      !== state.entry.record.submissionHandoffBundlePublicationJournalHash) {
    throw new Error('handoff_bundle_publication_journal_completion_invalid');
  }
  completedState = unlinkPreparedTwin(completed);
  removeSubmissionHandoffBundleStagingOwnerSync(
    completedState.entry.record.publication,
  );
  return completedState;
}
