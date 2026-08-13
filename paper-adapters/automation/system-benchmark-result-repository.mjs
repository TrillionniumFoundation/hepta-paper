import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  fsyncDirectorySync,
} from '../runtime/durable-json-repository.mjs';
import { systemBenchmarkNowEpochMs } from './system-benchmark-wall-clock.mjs';

const RESULT_ARTIFACT_NAMES = Object.freeze([
  'results.json',
  'results.csv',
  'raw-events.ndjson',
]);
const rollbackAuthorizations = new WeakMap();

function writeDurableTextSync(candidate, content) {
  const destination = path.resolve(candidate);
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.${path.basename(destination)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.linkSync(temporary, destination);
    fs.unlinkSync(temporary);
    fsyncDirectorySync(parent);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function deadlineObservation(absoluteDeadlineEpochMs, minimumEpochMs = 0) {
  const observed = systemBenchmarkNowEpochMs();
  const deadline = Number(absoluteDeadlineEpochMs);
  return Number.isSafeInteger(observed) && observed >= minimumEpochMs
    && Number.isSafeInteger(deadline) && deadline >= 0 && observed < deadline
    ? observed : null;
}

function pathEntryExists(candidate) {
  try { fs.lstatSync(candidate); return true; }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function publicationIdentity(directory, name, recheckPath = true) {
  const candidate = path.join(directory, name);
  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error('system_benchmark_result_not_regular');
    const sha256 = hashBytes(fs.readFileSync(descriptor));
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (String(before.dev) !== String(after.dev) || String(before.ino) !== String(after.ino)
      || String(before.nlink) !== String(after.nlink) || String(before.size) !== String(after.size)
      || String(before.mtimeNs) !== String(after.mtimeNs)) {
      throw new Error('system_benchmark_result_identity_changed_during_read');
    }
    const identity = Object.freeze({
      name,
      device: String(after.dev),
      inode: String(after.ino),
      linkCount: String(after.nlink),
      sha256,
    });
    if (recheckPath) {
      const pathIdentity = publicationIdentity(directory, name, false);
      if (!samePublicationIdentity(pathIdentity, identity)
        || pathIdentity.linkCount !== identity.linkCount) {
        throw new Error('system_benchmark_result_path_changed_during_read');
      }
    }
    return identity;
  } finally { fs.closeSync(descriptor); }
}

function samePublicationIdentity(left, right) {
  return left.name === right.name && left.device === right.device && left.inode === right.inode
    && left.sha256 === right.sha256;
}

function sameExclusivePublicationIdentity(left, right) {
  return samePublicationIdentity(left, right) && left.linkCount === '1';
}

function removeIdentityBoundDirectory(directory, publications, blocker) {
  const expectedNames = publications.map(({ name }) => name).sort();
  const observedNames = fs.readdirSync(directory).sort();
  if (JSON.stringify(observedNames) !== JSON.stringify(expectedNames)
    || publications.some((publication) => !samePublicationIdentity(
      publicationIdentity(directory, publication.name), publication,
    ))) throw new Error(blocker);
  for (const publication of publications) fs.unlinkSync(path.join(directory, publication.name));
  fsyncDirectorySync(directory);
  fs.rmdirSync(directory);
}

function verifyAuthorizedPublications(directory, authorization) {
  if (authorization.publications.some((publication) => !sameExclusivePublicationIdentity(
    publicationIdentity(directory, publication.name), publication,
  ))) throw new Error('system_benchmark_result_finalization_identity_mismatch');
}

function quarantinePublished(directory, publications) {
  for (const publication of publications) {
    const observed = publicationIdentity(directory, publication.name);
    if (!samePublicationIdentity(observed, publication)) {
      throw new Error('system_benchmark_result_rollback_identity_mismatch');
    }
  }
  const quarantine = fs.mkdtempSync(path.join(directory, '.hepta-system-results-rollback-'));
  fs.chmodSync(quarantine, 0o700);
  const moved = [];
  try {
    for (const publication of publications) {
      fs.renameSync(path.join(directory, publication.name), path.join(quarantine, publication.name));
      moved.push(publication);
    }
    fsyncDirectorySync(directory);
    for (const publication of publications) {
      const observed = publicationIdentity(quarantine, publication.name);
      if (!samePublicationIdentity(observed, publication)) {
        throw new Error('system_benchmark_result_rollback_identity_mismatch');
      }
    }
    removeIdentityBoundDirectory(
      quarantine,
      publications,
      'system_benchmark_result_rollback_quarantine_mismatch',
    );
    fsyncDirectorySync(directory);
    if (publications.some(({ name }) => fs.existsSync(path.join(directory, name)))) {
      throw new Error('system_benchmark_result_rollback_failed');
    }
  } catch (error) {
    for (const publication of moved.reverse()) {
      const quarantined = path.join(quarantine, publication.name);
      const destination = path.join(directory, publication.name);
      if (fs.existsSync(quarantined) && !fs.existsSync(destination)) {
        fs.renameSync(quarantined, destination);
      }
    }
    try { fs.rmdirSync(quarantine); } catch {}
    fsyncDirectorySync(directory);
    throw error;
  }
}

function discardMatchingPublications(directory, publications) {
  const quarantine = fs.mkdtempSync(path.join(directory, '.hepta-system-results-rejected-'));
  fs.chmodSync(quarantine, 0o700);
  const cleanupBlockers = [];
  for (const publication of publications) {
    const source = path.join(directory, publication.name);
    const quarantined = path.join(quarantine, publication.name);
    if (!pathEntryExists(source)) continue;
    try {
      fs.renameSync(source, quarantined);
      let owned = false;
      try {
        owned = samePublicationIdentity(
          publicationIdentity(quarantine, publication.name),
          publication,
        );
      } catch { /* preserve unrecognized entries */ }
      if (owned) fs.unlinkSync(quarantined);
      else if (!pathEntryExists(source)) fs.renameSync(quarantined, source);
      else cleanupBlockers.push(`benchmark_result_rejected_entry_preserved:${publication.name}`);
    } catch {
      cleanupBlockers.push(`benchmark_result_rejected_entry_preserved:${publication.name}`);
    }
  }
  fsyncDirectorySync(directory);
  try { fs.rmdirSync(quarantine); }
  catch { cleanupBlockers.push('benchmark_result_rejected_quarantine_preserved'); }
  return cleanupBlockers;
}

function blockedResult(blockers) {
  return Object.freeze({
    status: 'system_benchmark_results_blocked',
    blockers: Object.freeze([...new Set(blockers)]),
    resultPersistenceCompletedAtEpochMs: null,
    rollbackAuthority: null,
    resultJsonHash: null,
    resultCsvHash: null,
    rawEventArtifactHash: null,
    rawEventArtifactBytes: null,
    artifacts: Object.freeze([]),
  });
}

function blockedReceiptPayload(payload, blockers, receiptFinalizedAtEpochMs) {
  return {
    ...payload,
    status: 'system_benchmark_harness_blocked',
    integrityStatus: 'system_benchmark_integrity_blocked',
    scientificVerdict: 'not_evaluable',
    scientificFindings: [],
    resultPersistenceCompletedAtEpochMs: null,
    receiptFinalizedAtEpochMs,
    resultDocument: null,
    csvDocument: null,
    resultJsonHash: null,
    resultCsvHash: null,
    artifacts: [],
    blockers: [...new Set(blockers)],
  };
}

export function finalizeSystemBenchmarkReceiptBeforeDeadline({
  payload,
  outputDirectory,
  rollbackAuthority,
} = {}) {
  const blockers = [...payload.blockers];
  const directory = path.resolve(outputDirectory);
  const authorization = rollbackAuthorizations.get(rollbackAuthority);
  if (!blockers.length && (!authorization || authorization.directory !== directory)) {
    blockers.push('benchmark_result_rollback_authority_missing');
  }
  if (!blockers.length) {
    try { verifyAuthorizedPublications(directory, authorization); }
    catch { blockers.push('benchmark_result_finalization_identity_mismatch'); }
  }
  const observed = systemBenchmarkNowEpochMs();
  let receiptFinalizedAtEpochMs = Number.isSafeInteger(observed) ? observed : null;
  if (!blockers.length && (receiptFinalizedAtEpochMs === null
    || !Number.isSafeInteger(payload.absoluteDeadlineEpochMs)
    || payload.absoluteDeadlineEpochMs < 0
    || !Number.isSafeInteger(payload.resultPersistenceCompletedAtEpochMs)
    || payload.resultPersistenceCompletedAtEpochMs < 0
    || receiptFinalizedAtEpochMs < payload.resultPersistenceCompletedAtEpochMs
    || receiptFinalizedAtEpochMs >= payload.absoluteDeadlineEpochMs)) {
    blockers.push('benchmark_harness_absolute_deadline_exhausted');
  }
  const cleanupAuthorizedPublications = () => {
    if (!authorization) return;
    try { quarantinePublished(authorization.directory, authorization.publications); }
    catch {
      blockers.push('benchmark_result_rollback_identity_mismatch');
      try {
        blockers.push(...discardMatchingPublications(
          authorization.directory,
          authorization.publications,
        ));
      } catch { blockers.push('benchmark_result_rejected_cleanup_failed'); }
    }
    rollbackAuthorizations.delete(rollbackAuthority);
  };
  const completedAtEpochMs = systemBenchmarkNowEpochMs();
  if (!blockers.length && (!Number.isSafeInteger(completedAtEpochMs)
    || completedAtEpochMs < receiptFinalizedAtEpochMs
    || completedAtEpochMs >= payload.absoluteDeadlineEpochMs)) {
    blockers.push('benchmark_harness_absolute_deadline_exhausted');
  } else if (!blockers.length) receiptFinalizedAtEpochMs = completedAtEpochMs;
  if (!blockers.length) {
    try { verifyAuthorizedPublications(directory, authorization); }
    catch { blockers.push('benchmark_result_finalization_identity_mismatch'); }
  }
  if (blockers.length) cleanupAuthorizedPublications();
  let finalizedPayload = blockers.length
    ? blockedReceiptPayload(payload, blockers, receiptFinalizedAtEpochMs)
    : { ...payload, receiptFinalizedAtEpochMs };
  let receiptHash = null;
  try {
    receiptHash = hashRecord('SystemBenchmarkHarnessExecutionReceipt', finalizedPayload);
  } catch {
    blockers.push('benchmark_result_receipt_hash_failed');
    cleanupAuthorizedPublications();
    finalizedPayload = blockedReceiptPayload({
      version: 5,
      kind: 'SystemBenchmarkHarnessExecutionReceipt',
      executionStatus: 'system_benchmark_execution_failed',
      absoluteDeadlineEpochMs: Number.isSafeInteger(payload?.absoluteDeadlineEpochMs)
        ? payload.absoluteDeadlineEpochMs : null,
      externalActionPerformed: false,
    }, blockers, receiptFinalizedAtEpochMs);
    receiptHash = hashRecord('SystemBenchmarkHarnessExecutionReceipt', finalizedPayload);
  }
  if (!blockers.length) rollbackAuthorizations.delete(rollbackAuthority);
  return Object.freeze({ ...finalizedPayload,
    systemBenchmarkHarnessExecutionReceiptHash: receiptHash });
}

export function writeSystemBenchmarkResults({
  outputDirectory,
  resultDocument,
  csvDocument,
  rawEventDocument,
  absoluteDeadlineEpochMs,
} = {}) {
  const directory = path.resolve(outputDirectory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const occupied = RESULT_ARTIFACT_NAMES.filter((name) => pathEntryExists(path.join(directory, name)));
  if (occupied.length) {
    return blockedResult(occupied.map((name) => `benchmark_result_artifact_already_exists:${name}`));
  }
  const persistenceStartedAtEpochMs = deadlineObservation(absoluteDeadlineEpochMs);
  if (persistenceStartedAtEpochMs === null) {
    return blockedResult(['benchmark_harness_absolute_deadline_exhausted']);
  }
  const stagingDirectory = fs.mkdtempSync(path.join(directory, '.hepta-system-results-'));
  fs.chmodSync(stagingDirectory, 0o700);
  const published = [];
  const stagedIdentities = [];
  let stagingRemoved = false;
  try {
    const stagedPaths = RESULT_ARTIFACT_NAMES.map((name) => path.join(stagingDirectory, name));
    writeDurableTextSync(stagedPaths[0], `${JSON.stringify(resultDocument, null, 2)}\n`);
    stagedIdentities.push(publicationIdentity(stagingDirectory, RESULT_ARTIFACT_NAMES[0]));
    writeDurableTextSync(stagedPaths[1], csvDocument);
    stagedIdentities.push(publicationIdentity(stagingDirectory, RESULT_ARTIFACT_NAMES[1]));
    writeDurableTextSync(stagedPaths[2], rawEventDocument);
    stagedIdentities.push(publicationIdentity(stagingDirectory, RESULT_ARTIFACT_NAMES[2]));
    const stagingCompletedAtEpochMs = deadlineObservation(
      absoluteDeadlineEpochMs,
      persistenceStartedAtEpochMs,
    );
    if (stagingCompletedAtEpochMs === null) {
      return blockedResult(['benchmark_harness_absolute_deadline_exhausted']);
    }
    const [resultJson, resultCsv, rawEvents] = stagedPaths.map((candidate) => fs.readFileSync(candidate));
    for (let index = 0; index < RESULT_ARTIFACT_NAMES.length; index += 1) {
      fs.linkSync(stagedPaths[index], path.join(directory, RESULT_ARTIFACT_NAMES[index]));
      published.push(stagedIdentities[index]);
    }
    fsyncDirectorySync(directory);
    removeIdentityBoundDirectory(
      stagingDirectory,
      stagedIdentities,
      'system_benchmark_result_staging_identity_mismatch',
    );
    stagingRemoved = true;
    fsyncDirectorySync(directory);
    const finalIdentities = RESULT_ARTIFACT_NAMES.map((name) => publicationIdentity(directory, name));
    if (finalIdentities.some((identity, index) => identity.linkCount !== '1'
      || !samePublicationIdentity(identity, stagedIdentities[index]))) {
      quarantinePublished(directory, published);
      return blockedResult(['benchmark_result_artifact_persistence_mismatch']);
    }
    const finalDocuments = RESULT_ARTIFACT_NAMES.map((name) => fs.readFileSync(path.join(directory, name)));
    if (finalDocuments.some((document, index) => !document.equals([resultJson, resultCsv, rawEvents][index]))) {
      quarantinePublished(directory, published);
      return blockedResult(['benchmark_result_artifact_persistence_mismatch']);
    }
    const resultPersistenceCompletedAtEpochMs = deadlineObservation(
      absoluteDeadlineEpochMs,
      stagingCompletedAtEpochMs,
    );
    if (resultPersistenceCompletedAtEpochMs === null) {
      quarantinePublished(directory, published);
      return blockedResult(['benchmark_harness_absolute_deadline_exhausted']);
    }
  const resultJsonHash = hashBytes(resultJson);
  const resultCsvHash = hashBytes(resultCsv);
  const rawEventArtifactHash = hashBytes(rawEvents);
  const rollbackAuthority = Object.freeze({});
  rollbackAuthorizations.set(rollbackAuthority, Object.freeze({
    directory,
    publications: Object.freeze([...published]),
  }));
  return Object.freeze({
    status: 'system_benchmark_results_persisted',
    blockers: Object.freeze([]),
    resultPersistenceCompletedAtEpochMs,
    rollbackAuthority,
    resultJsonHash,
    resultCsvHash,
    rawEventArtifactHash,
    rawEventArtifactBytes: rawEvents.length,
    artifacts: Object.freeze([
      { path: 'results.json', sha256: resultJsonHash, bytes: resultJson.length },
      { path: 'results.csv', sha256: resultCsvHash, bytes: resultCsv.length },
      { path: 'raw-events.ndjson', sha256: rawEventArtifactHash, bytes: rawEvents.length },
    ]),
  });
  } catch (error) {
    if (published.length) quarantinePublished(directory, published);
    if (error?.code === 'EEXIST') {
      return blockedResult(['benchmark_result_artifact_publish_collision']);
    }
    throw error;
  } finally {
    if (!stagingRemoved) {
      if (pathEntryExists(stagingDirectory)) {
        try { removeIdentityBoundDirectory(stagingDirectory, stagedIdentities,
          'system_benchmark_result_staging_identity_mismatch'); }
        catch (error) {
          discardMatchingPublications(stagingDirectory, stagedIdentities);
          throw error;
        }
      }
      fsyncDirectorySync(directory);
    }
  }
}
