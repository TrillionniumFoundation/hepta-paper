import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  currentProcessIdentity,
  processIdentityIsStale,
} from '../../workflow-kernel/runtime/process-identity.mjs';
import { writeDescriptorFullySync } from '../../workflow-kernel/runtime/file-descriptor-utils.mjs';
import {
  fsyncDirectorySync,
  writeDurableJsonSync,
} from '../runtime/durable-json-repository.mjs';

const EVIDENCE_FILE = 'generic-domain-capability-evidence.json';
const MAXIMUM_BYTES = 16 * 1024 * 1024;
const MAXIMUM_LOCK_BYTES = 16 * 1024;
const DEFAULT_LOCK_STALE_AFTER_MS = 5 * 60 * 1000;
const MAXIMUM_LOCK_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const PUBLICATION_LOCK_KIND = 'GenericDomainCapabilityEvidencePublicationLock';
const PUBLICATION_LOCK_KEYS = Object.freeze([
  'acquiredAt',
  'evidenceHash',
  'kind',
  'ownerBootIdentity',
  'ownerHostname',
  'ownerNonce',
  'ownerPid',
  'ownerPidStartTime',
  'ownerUid',
  'staleAfterMs',
  'version',
]);
const PUBLICATION_LOCK_OWNER_NAME = /^owner-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i;
const PUBLICATION_LOCK_TEMPORARY_PREFIX = `.${EVIDENCE_FILE}.publish.lock.`;
const EVIDENCE_KEYS = Object.freeze([
  'dynamicFormalExecutionAuthority',
  'experimentHarnessExecutionReceipt',
  'experimentIrExecutionAuthorityReceipt',
  'experimentReplayReceipt',
  'externalResearchReplayReceipt',
  'externalResearchReplayRequest',
  'formalDomainCoverageReceipt',
  'formalDomainQualificationExternalEvidence',
  'independentFormalReviewReceipt',
  'priorArtClaimAlignmentReceipt',
  'priorArtEvidenceReceipt',
  'researchAgendaIr',
  'venueProfile',
  'venueRequirementIr',
]);

function fileIdentity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function sameFileIdentity(expected, observed) {
  return expected?.dev === String(observed?.dev) && expected?.ino === String(observed?.ino);
}

function ownedByCurrentProcess(stat) {
  return typeof process.getuid !== 'function' || Number(stat.uid) === process.getuid();
}

function securePublicationLockDirectory(stat) {
  return stat.isDirectory() && !stat.isSymbolicLink()
    && ownedByCurrentProcess(stat)
    && (stat.mode & 0o7777) === 0o700;
}

function securePublicationLockOwner(stat) {
  return stat.isFile() && !stat.isSymbolicLink()
    && Number(stat.nlink) === 1
    && ownedByCurrentProcess(stat)
    && (stat.mode & 0o7777) === 0o600
    && stat.size > 0 && stat.size <= MAXIMUM_LOCK_BYTES;
}

function currentBootIdentity() {
  try {
    const value = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return value ? `linux-boot:${value}` : null;
  } catch { return null; }
}

function observedInstant(clock) {
  if (typeof clock?.now !== 'function') {
    throw new Error('generic_domain_capability_evidence_publication_clock_invalid');
  }
  const observed = clock.now();
  const value = observed instanceof Date ? observed : new Date(observed);
  if (!Number.isFinite(value.getTime())) {
    throw new Error('generic_domain_capability_evidence_publication_clock_invalid');
  }
  return value;
}

function publicationLockTiming(staleAfterMs) {
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1
    || staleAfterMs > MAXIMUM_LOCK_STALE_AFTER_MS) {
    throw new Error('generic_domain_capability_evidence_publication_lock_policy_invalid');
  }
  return staleAfterMs;
}

function validPublicationLockRecord(value, { evidenceHash = null } = {}) {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(PUBLICATION_LOCK_KEYS)
    && value.version === 1 && value.kind === PUBLICATION_LOCK_KIND
    && typeof value.evidenceHash === 'string'
    && /^sha256:[0-9a-f]{64}$/.test(value.evidenceHash)
    && (!evidenceHash || value.evidenceHash === evidenceHash)
    && typeof value.ownerNonce === 'string' && value.ownerNonce.length >= 16
    && Number.isSafeInteger(value.ownerPid) && value.ownerPid > 0
    && (value.ownerPidStartTime === null
      || (typeof value.ownerPidStartTime === 'string'
        && /^\d+$/.test(value.ownerPidStartTime)))
    && typeof value.ownerHostname === 'string' && value.ownerHostname.length > 0
    && (value.ownerBootIdentity === null
      || (typeof value.ownerBootIdentity === 'string' && value.ownerBootIdentity.length > 0))
    && value.ownerUid === currentUid
    && Number.isSafeInteger(value.staleAfterMs) && value.staleAfterMs >= 1
    && value.staleAfterMs <= MAXIMUM_LOCK_STALE_AFTER_MS
    && typeof value.acquiredAt === 'string'
    && Number.isFinite(Date.parse(value.acquiredAt));
}

function createPublicationLockRecord({ evidenceHash, now, staleAfterMs }) {
  const identity = currentProcessIdentity();
  const ownerNonce = randomUUID();
  return Object.freeze({
    version: 1,
    kind: PUBLICATION_LOCK_KIND,
    evidenceHash,
    ownerNonce,
    ownerPid: identity.pid,
    ownerPidStartTime: identity.pidStartTime,
    ownerHostname: os.hostname(),
    ownerBootIdentity: currentBootIdentity(),
    ownerUid: typeof process.getuid === 'function' ? process.getuid() : null,
    acquiredAt: now.toISOString(),
    staleAfterMs,
  });
}

function readPublicationLockOwner(candidate, expectedIdentity = null) {
  const resolved = path.resolve(candidate);
  const before = fs.lstatSync(resolved);
  if (!securePublicationLockOwner(before)
    || fs.realpathSync(resolved) !== resolved
    || (expectedIdentity && !sameFileIdentity(expectedIdentity, before))) {
    throw new Error('generic_domain_capability_evidence_publication_lock_invalid');
  }
  const descriptor = fs.openSync(
    resolved,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (!securePublicationLockOwner(opened)
      || !sameFileIdentity(fileIdentity(before), opened)) {
      throw new Error('generic_domain_capability_evidence_publication_lock_invalid');
    }
    const source = fs.readFileSync(descriptor, 'utf8');
    const after = fs.lstatSync(resolved);
    if (!securePublicationLockOwner(after)
      || !sameFileIdentity(fileIdentity(before), after)
      || String(after.size) !== String(before.size)
      || String(after.mtimeMs) !== String(before.mtimeMs)) {
      throw new Error('generic_domain_capability_evidence_publication_lock_drifted');
    }
    return Object.freeze({
      value: Object.freeze(JSON.parse(source)),
      identity: fileIdentity(before),
      stat: before,
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

function readPublicationLock(lockPath, {
  expectedDirectoryIdentity = null,
  expectedOwnerIdentity = null,
} = {}) {
  const resolved = path.resolve(lockPath);
  const before = fs.lstatSync(resolved);
  if (!securePublicationLockDirectory(before)
    || fs.realpathSync(resolved) !== resolved
    || (expectedDirectoryIdentity && !sameFileIdentity(expectedDirectoryIdentity, before))) {
    throw new Error('generic_domain_capability_evidence_publication_lock_invalid');
  }
  const entries = fs.readdirSync(resolved, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isFile() || entries[0].isSymbolicLink()) {
    throw new Error('generic_domain_capability_evidence_publication_lock_invalid');
  }
  const ownerNameMatch = entries[0].name.match(PUBLICATION_LOCK_OWNER_NAME);
  if (!ownerNameMatch) {
    throw new Error('generic_domain_capability_evidence_publication_lock_invalid');
  }
  const ownerPath = path.join(resolved, entries[0].name);
  const owner = readPublicationLockOwner(ownerPath, expectedOwnerIdentity);
  if (!validPublicationLockRecord(owner.value)
    || owner.value.ownerNonce !== ownerNameMatch[1]) {
    throw new Error('generic_domain_capability_evidence_publication_lock_invalid');
  }
  const after = fs.lstatSync(resolved);
  const afterEntries = fs.readdirSync(resolved);
  if (!securePublicationLockDirectory(after)
    || !sameFileIdentity(fileIdentity(before), after)
    || String(after.mtimeMs) !== String(before.mtimeMs)
    || afterEntries.length !== 1 || afterEntries[0] !== entries[0].name) {
    throw new Error('generic_domain_capability_evidence_publication_lock_drifted');
  }
  return Object.freeze({
    value: owner.value,
    directoryIdentity: fileIdentity(before),
    directoryStat: before,
    ownerPath,
    ownerIdentity: owner.identity,
    ownerStat: owner.stat,
  });
}

function samePublicationLockSnapshot(left, right) {
  return sameFileIdentity(left.directoryIdentity, right.directoryStat)
    && sameFileIdentity(left.ownerIdentity, right.ownerStat)
    && String(left.directoryStat.mtimeMs) === String(right.directoryStat.mtimeMs)
    && String(left.ownerStat.size) === String(right.ownerStat.size)
    && String(left.ownerStat.mtimeMs) === String(right.ownerStat.mtimeMs)
    && left.ownerPath === right.ownerPath
    && JSON.stringify(left.value) === JSON.stringify(right.value);
}

function publicationLockOwnerDefinitelyDead(record) {
  if (record.ownerHostname !== os.hostname()) return false;
  const bootIdentity = currentBootIdentity();
  if (record.ownerBootIdentity && bootIdentity
    && record.ownerBootIdentity !== bootIdentity) return true;
  return processIdentityIsStale({
    pid: record.ownerPid,
    pidStartTime: record.ownerPidStartTime,
  });
}

function publicationLockExpired(lock, now) {
  const lastKnownLiveAt = Math.max(
    Date.parse(lock.value.acquiredAt),
    Number(lock.ownerStat.mtimeMs),
  );
  return now.getTime() - lastKnownLiveAt >= lock.value.staleAfterMs;
}

function removePublicationLockDirectory({ root, lockPath, expected }) {
  let current;
  try {
    current = readPublicationLock(lockPath, {
      expectedDirectoryIdentity: expected.directoryIdentity,
      expectedOwnerIdentity: expected.ownerIdentity,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!samePublicationLockSnapshot(expected, current)) return false;
  try {
    fs.unlinkSync(current.ownerPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  try {
    fs.rmdirSync(lockPath);
    fsyncDirectorySync(root);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') return false;
    throw error;
  }
}

function recoverStalePublicationLock({ root, lockPath, now }) {
  try {
    const observed = readPublicationLock(lockPath);
    if (!publicationLockOwnerDefinitelyDead(observed.value)
      || !publicationLockExpired(observed, now)) return false;
    const rechecked = readPublicationLock(lockPath, {
      expectedDirectoryIdentity: observed.directoryIdentity,
      expectedOwnerIdentity: observed.ownerIdentity,
    });
    if (!samePublicationLockSnapshot(observed, rechecked)
      || !publicationLockOwnerDefinitelyDead(rechecked.value)
      || !publicationLockExpired(rechecked, now)) return false;
    // Removing the exact owner before rmdir keeps canonical lock acquisition
    // fenced until the stale directory has gone. A contender that wins after
    // rmdir has a different nonce/owner path and is never removed here.
    return removePublicationLockDirectory({
      root,
      lockPath,
      expected: rechecked,
    });
  } catch {
    return false;
  }
}

function removeOwnedPublicationLock(lock) {
  try {
    if (removePublicationLockDirectory({
      root: lock.root,
      lockPath: lock.lockPath,
      expected: lock,
    })) return;
  } catch (error) {
    throw new Error('generic_domain_capability_evidence_publication_lock_release_failed', {
      cause: error,
    });
  }
  throw new Error('generic_domain_capability_evidence_publication_lock_release_failed');
}

function acquirePublicationLock({ root, lockPath, evidenceHash, staleAfterMs, clock }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = observedInstant(clock);
    const record = createPublicationLockRecord({ evidenceHash, now, staleAfterMs });
    const ownerName = `owner-${record.ownerNonce}.json`;
    const temporaryPath = path.join(
      root,
      `${PUBLICATION_LOCK_TEMPORARY_PREFIX}${record.ownerPid}-${record.ownerNonce}.tmp`,
    );
    const temporaryOwnerPath = path.join(temporaryPath, ownerName);
    let descriptor = null;
    let temporaryCreated = false;
    try {
      fs.mkdirSync(temporaryPath, { mode: 0o700 });
      temporaryCreated = true;
      descriptor = fs.openSync(
        temporaryOwnerPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
          | (fs.constants.O_NOFOLLOW || 0),
        0o600,
      );
      writeDescriptorFullySync(descriptor, `${JSON.stringify(record)}\n`);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fsyncDirectorySync(temporaryPath);
      fs.renameSync(temporaryPath, lockPath);
      temporaryCreated = false;
      fsyncDirectorySync(root);
      const canonical = readPublicationLock(lockPath);
      if (!validPublicationLockRecord(canonical.value, { evidenceHash })
        || canonical.value.ownerNonce !== record.ownerNonce) {
        throw new Error('generic_domain_capability_evidence_publication_lock_invalid');
      }
      return Object.freeze({
        root,
        lockPath,
        ...canonical,
      });
    } catch (error) {
      if (descriptor !== null) fs.closeSync(descriptor);
      if (temporaryCreated) {
        try { fs.unlinkSync(temporaryOwnerPath); } catch { /* unique staging remains harmless */ }
        try { fs.rmdirSync(temporaryPath); } catch { /* unique staging remains harmless */ }
      }
      if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes(error?.code)) throw error;
      if (!recoverStalePublicationLock({ root, lockPath, now })) {
        throw new Error('generic_domain_capability_evidence_publication_in_progress', {
          cause: error,
        });
      }
    }
  }
  throw new Error('generic_domain_capability_evidence_publication_in_progress');
}

export function genericDomainCapabilityEvidencePath({ runtimeRoot } = {}) {
  if (!runtimeRoot) throw new Error('generic_domain_capability_runtime_root_required');
  return path.join(path.resolve(runtimeRoot), EVIDENCE_FILE);
}

export function verifyGenericDomainCapabilityEvidenceShape(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(EVIDENCE_KEYS);
}

export function genericDomainCapabilityEvidenceHash(value) {
  if (!verifyGenericDomainCapabilityEvidenceShape(value)) {
    throw new Error('generic_domain_capability_evidence_shape_invalid');
  }
  return hashRecord('GenericDomainCapabilityEvidence', value);
}

export function inspectGenericDomainCapabilityEvidence({
  runtimeRoot,
  environment = process.env,
} = {}) {
  const canonicalPath = genericDomainCapabilityEvidencePath({ runtimeRoot });
  const configuredPath = environment.HEPTA_GENERIC_DOMAIN_CAPABILITY_EVIDENCE
    ? path.resolve(String(environment.HEPTA_GENERIC_DOMAIN_CAPABILITY_EVIDENCE)) : null;
  const blockers = [];
  if (configuredPath && configuredPath !== canonicalPath) {
    blockers.push('generic_domain_capability_evidence_path_drift');
  }
  const candidate = configuredPath || canonicalPath;
  let evidence = null;
  let descriptor = null;
  try {
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      blockers.push('generic_domain_capability_evidence_not_private_regular_file');
    } else if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
      blockers.push('generic_domain_capability_evidence_not_private_regular_file');
    } else if (stat.size <= 0 || stat.size > MAXIMUM_BYTES) {
      blockers.push('generic_domain_capability_evidence_size_invalid');
    } else {
      const bytes = fs.readFileSync(descriptor);
      const postRead = fs.fstatSync(descriptor);
      if (postRead.dev !== stat.dev || postRead.ino !== stat.ino
        || postRead.size !== stat.size || postRead.mtimeMs !== stat.mtimeMs) {
        blockers.push('generic_domain_capability_evidence_changed_during_read');
      } else {
        const parsed = JSON.parse(bytes.toString('utf8'));
        if (!verifyGenericDomainCapabilityEvidenceShape(parsed)) {
          blockers.push('generic_domain_capability_evidence_shape_invalid');
        } else evidence = Object.freeze(parsed);
      }
    }
  } catch (error) {
    blockers.push(error?.code === 'ENOENT'
      ? 'generic_domain_capability_evidence_required'
      : error?.code === 'ELOOP'
        ? 'generic_domain_capability_evidence_not_private_regular_file'
        : 'generic_domain_capability_evidence_unreadable');
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    version: 1,
    kind: 'GenericDomainCapabilityEvidenceInspection',
    status: uniqueBlockers.length
      ? 'generic_domain_capability_evidence_blocked'
      : 'generic_domain_capability_evidence_loaded',
    ready: uniqueBlockers.length === 0,
    canonicalPath,
    configuredPath,
    evidence,
    evidenceHash: evidence ? genericDomainCapabilityEvidenceHash(evidence) : null,
    blockers: uniqueBlockers,
    statusReadOnly: true,
  });
}


export function publishGenericDomainCapabilityEvidence({
  runtimeRoot,
  evidence,
  expectedCurrentEvidenceHash = null,
  publicationLockStaleAfterMs = DEFAULT_LOCK_STALE_AFTER_MS,
  clock = Object.freeze({ now: () => new Date() }),
} = {}) {
  const evidenceHash = genericDomainCapabilityEvidenceHash(evidence);
  const staleAfterMs = publicationLockTiming(publicationLockStaleAfterMs);
  const root = path.resolve(String(runtimeRoot || ''));
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || fs.realpathSync(root) !== root
    || (rootStat.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && rootStat.uid !== process.getuid())) {
    throw new Error('generic_domain_capability_runtime_root_not_private');
  }
  const candidate = genericDomainCapabilityEvidencePath({ runtimeRoot: root });
  const lockPath = `${candidate}.publish.lock`;
  const publicationLock = acquirePublicationLock({
    root,
    lockPath,
    evidenceHash,
    staleAfterMs,
    clock,
  });
  try {
    const current = inspectGenericDomainCapabilityEvidence({ runtimeRoot: root, environment: {} });
    if (current.ready) {
      if (current.evidenceHash === evidenceHash) {
        return Object.freeze({
          status: 'generic_domain_capability_evidence_already_published',
          evidenceHash,
          path: current.canonicalPath,
          published: false,
        });
      }
      if (current.evidenceHash !== expectedCurrentEvidenceHash) {
        throw new Error('generic_domain_capability_evidence_compare_and_swap_failed');
      }
    } else if (!current.blockers.includes('generic_domain_capability_evidence_required')
      || expectedCurrentEvidenceHash !== null) {
      throw new Error('generic_domain_capability_evidence_existing_state_invalid');
    }
    writeDurableJsonSync(candidate, evidence, { mode: 0o600 });
    const reloaded = inspectGenericDomainCapabilityEvidence({ runtimeRoot: root, environment: {} });
    if (!reloaded.ready || reloaded.evidenceHash !== evidenceHash
      || JSON.stringify(reloaded.evidence) !== JSON.stringify(evidence)) {
      throw new Error('generic_domain_capability_evidence_publication_verification_failed');
    }
  } finally {
    removeOwnedPublicationLock(publicationLock);
  }
  return Object.freeze({
    status: 'generic_domain_capability_evidence_published',
    evidenceHash,
    path: candidate,
    published: true,
  });
}
