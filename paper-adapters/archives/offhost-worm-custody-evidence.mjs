import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  verifyPinnedExternalEvidenceEnvelope,
} from '../authority/pinned-external-evidence-verifier.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const MAXIMUM_DOCUMENT_BYTES = 1024 * 1024;
const MAXIMUM_OBJECT_BYTES = 64 * 1024 * 1024 * 1024;
const MAXIMUM_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const ROLE = 'offhost_worm_independent_custodian';
const SUBJECT_KIND = 'OffhostWormCustodyAttestationSubject';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RECEIPT_KEYS = Object.freeze([
  'contractId', 'custodyClass', 'expiresAt', 'issuedAt', 'kind', 'receiptHash',
  'receiptType', 'snapshotManifestHash', 'snapshotObjectSetHash', 'storageIdentityHash',
  'storageSubjectId', 'targetMountRoot', 'version',
]);
const SUBJECT_KEYS = Object.freeze([
  'attestedAt', 'contractId', 'custodyClass', 'custodyReceiptHash', 'expiresAt',
  'independentCustodianId', 'kind', 'offhostWormCustodyAttestationSubjectHash',
  'targetMountRoot', 'version',
]);
const BUNDLE_KEYS = Object.freeze([
  'attestationSubject', 'authorityEnvelope', 'custodyEvidenceBundleHash', 'kind',
  'receipt', 'version',
]);
const SNAPSHOT_MANIFEST_KEYS = Object.freeze([
  'contractId', 'kind', 'manifestHash', 'objects', 'offHostOrOffsiteCustodyQualified',
  'protectionLevel', 'signature', 'snapshotId', 'version',
]);
const SNAPSHOT_OBJECT_KEYS = Object.freeze([
  'immutable', 'objectHash', 'objectPath', 'role', 'sourceHash',
]);

function exactKeys(value, expected) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function identity(stat) {
  return JSON.stringify({
    ctimeNs: String(stat.ctimeNs),
    dev: String(stat.dev),
    gid: String(stat.gid),
    ino: String(stat.ino),
    mode: String(stat.mode),
    mtimeNs: String(stat.mtimeNs),
    nlink: String(stat.nlink),
    size: String(stat.size),
    uid: String(stat.uid),
  });
}

function readImmutableDocument(candidate, errorCode) {
  const selected = path.resolve(String(candidate || ''));
  let descriptor;
  try {
    if (!path.isAbsolute(String(candidate || '')) || fs.realpathSync(selected) !== selected) {
      throw new Error(errorCode);
    }
    const before = fs.lstatSync(selected, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size < 2n || before.size > BigInt(MAXIMUM_DOCUMENT_BYTES)
      || (before.mode & 0o222n) !== 0n) throw new Error(errorCode);
    descriptor = fs.openSync(selected, fs.constants.O_RDONLY | NO_FOLLOW);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (identity(opened) !== identity(before)) throw new Error(errorCode);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(selected, { bigint: true });
    if (identity(after) !== identity(before) || identity(current) !== identity(before)
      || BigInt(bytes.length) !== before.size) throw new Error(errorCode);
    const document = JSON.parse(bytes.toString('utf8'));
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      throw new Error(errorCode);
    }
    return document;
  } catch {
    throw new Error(errorCode);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function hashImmutableObject(candidate, errorCode) {
  const selected = path.resolve(String(candidate || ''));
  let descriptor;
  try {
    if (!path.isAbsolute(String(candidate || '')) || fs.realpathSync(selected) !== selected) {
      throw new Error(errorCode);
    }
    const before = fs.lstatSync(selected, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size > BigInt(MAXIMUM_OBJECT_BYTES)
      || (before.mode & 0o222n) !== 0n) throw new Error(errorCode);
    descriptor = fs.openSync(selected, fs.constants.O_RDONLY | NO_FOLLOW);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (identity(opened) !== identity(before)) throw new Error(errorCode);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    let offset = 0;
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(selected, { bigint: true });
    if (identity(after) !== identity(before) || identity(current) !== identity(before)
      || BigInt(offset) !== before.size) throw new Error(errorCode);
    return `sha256:${hash.digest('hex')}`;
  } catch {
    throw new Error(errorCode);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function filesystemImmutable(candidate) {
  const result = spawnSync('lsattr', ['-d', candidate], { encoding: 'utf8' });
  return result.status === 0
    && (String(result.stdout || '').trim().split(/\s+/u, 1)[0] || '').includes('i');
}

function loadDocument({ configuredPath, override, missingBlocker, invalidBlocker }) {
  if (override !== null) return Object.freeze({ document: override, blocker: null });
  if (typeof configuredPath !== 'string' || !path.isAbsolute(configuredPath)) {
    return Object.freeze({ document: null, blocker: missingBlocker });
  }
  try {
    return Object.freeze({
      document: readImmutableDocument(configuredPath, invalidBlocker),
      blocker: null,
    });
  } catch {
    return Object.freeze({ document: null, blocker: invalidBlocker });
  }
}

function canonicalInstant(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? value : null;
}

function validWindow({ issuedAt, expiresAt, nowMs, maximumLifetimeMs }) {
  const issued = canonicalInstant(issuedAt);
  const expires = canonicalInstant(expiresAt);
  if (!issued || !expires) return false;
  const issuedMs = Date.parse(issued);
  const expiresMs = Date.parse(expires);
  return issuedMs <= nowMs && expiresMs > nowMs && expiresMs > issuedMs
    && expiresMs - issuedMs <= maximumLifetimeMs;
}

function inspectQualifiedSnapshot({ contract, targetMountRoot, immutableOverride }) {
  const manifestPath = contract?.custodySnapshotManifestPath;
  if (typeof manifestPath !== 'string' || !path.isAbsolute(manifestPath)) {
    return Object.freeze({
      manifestHash: null,
      objectSetHash: null,
      blockers: Object.freeze(['offhost_worm_custody_snapshot_manifest_missing']),
    });
  }
  try {
    const selected = path.resolve(manifestPath);
    const relative = path.relative(targetMountRoot, selected).replace(/\\/g, '/');
    const components = relative.split('/');
    if (components.length !== 3 || components[0] !== 'hepta-paper-worm'
      || !/^[a-f0-9]{64}$/u.test(components[1])
      || components[2] !== 'OFFHOST_WORM_SNAPSHOT_MANIFEST.json') {
      throw new Error('offhost_worm_custody_snapshot_manifest_path_invalid');
    }
    const manifest = readImmutableDocument(
      selected,
      'offhost_worm_custody_snapshot_manifest_invalid',
    );
    const { manifestHash, signature: _signature, ...payload } = manifest;
    if (!exactKeys(manifest, SNAPSHOT_MANIFEST_KEYS)
      || manifest.version !== 2 || manifest.kind !== 'OffhostWormSnapshotManifest'
      || manifest.contractId !== contract.contractId
      || manifest.snapshotId !== components[1]
      || !SHA256.test(String(manifestHash || ''))
      || hashRecord('OffhostWormSnapshotManifest', payload) !== manifestHash
      || !Array.isArray(manifest.objects) || manifest.objects.length < 1) {
      throw new Error('offhost_worm_custody_snapshot_manifest_invalid');
    }
    const roles = new Set();
    const hashes = new Set();
    for (const object of manifest.objects) {
      const token = String(object?.sourceHash || '').replace(/^sha256:/u, '');
      const expectedPath = path.join(
        targetMountRoot,
        'hepta-paper-worm',
        manifest.snapshotId,
        'objects',
        token,
      );
      if (!exactKeys(object, SNAPSHOT_OBJECT_KEYS)
        || typeof object.role !== 'string' || !object.role || roles.has(object.role)
        || !SHA256.test(String(object.sourceHash || '')) || hashes.has(object.sourceHash)
        || object.objectHash !== object.sourceHash || object.immutable !== true
        || object.objectPath !== expectedPath
        || hashImmutableObject(
          expectedPath,
          'offhost_worm_custody_snapshot_object_invalid_or_changed',
        ) !== object.sourceHash
        || !(immutableOverride === null
          ? filesystemImmutable(expectedPath) : Boolean(immutableOverride))) {
        throw new Error('offhost_worm_custody_snapshot_object_invalid_or_changed');
      }
      roles.add(object.role);
      hashes.add(object.sourceHash);
    }
    return Object.freeze({
      manifestHash,
      objectSetHash: hashRecord('OffhostWormSnapshotObjectSet', manifest.objects),
      blockers: Object.freeze([]),
    });
  } catch (error) {
    return Object.freeze({
      manifestHash: null,
      objectSetHash: null,
      blockers: Object.freeze([
        error?.message || 'offhost_worm_custody_snapshot_manifest_invalid',
      ]),
    });
  }
}

export function inspectOffhostWormCustodyEvidence({
  contract,
  targetMountRoot,
  storageIdentityHash = null,
  immutableOverride = null,
  evidenceOverride = null,
  trustStoreOverride = null,
  now = new Date(),
} = {}) {
  const blockers = [];
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ''));
  const maximumLifetimeMs = Number(contract?.custodyEvidenceMaximumLifetimeMs);
  const signerKeyIds = [...new Set((Array.isArray(contract?.custodySignerKeyIds)
    ? contract.custodySignerKeyIds : []).map(String))].sort();
  if (!Number.isFinite(nowMs)) blockers.push('offhost_worm_custody_clock_invalid');
  if (!SHA256.test(String(storageIdentityHash || ''))) {
    blockers.push('offhost_worm_stable_storage_identity_unavailable');
  }
  if (!Number.isSafeInteger(maximumLifetimeMs) || maximumLifetimeMs < 1_000
    || maximumLifetimeMs > MAXIMUM_LIFETIME_MS) {
    blockers.push('offhost_worm_custody_freshness_policy_missing_or_invalid');
  }
  if (signerKeyIds.length < 1 || signerKeyIds.length > 4
    || signerKeyIds.some((keyId) => !SAFE_ID.test(keyId))
    || JSON.stringify(signerKeyIds) !== JSON.stringify(contract?.custodySignerKeyIds)) {
    blockers.push('offhost_worm_custody_signer_key_ids_missing_or_invalid');
  }
  if (!SHA256.test(String(contract?.custodyTrustStoreHash || ''))) {
    blockers.push('offhost_worm_custody_trust_store_hash_missing_or_invalid');
  }
  const snapshot = inspectQualifiedSnapshot({ contract, targetMountRoot, immutableOverride });
  blockers.push(...snapshot.blockers);
  const evidenceLoad = loadDocument({
    configuredPath: contract?.custodyEvidencePath,
    override: evidenceOverride,
    missingBlocker: 'offhost_worm_custody_evidence_missing',
    invalidBlocker: 'offhost_worm_custody_evidence_file_invalid',
  });
  const trustStoreLoad = loadDocument({
    configuredPath: contract?.custodyTrustStorePath,
    override: trustStoreOverride,
    missingBlocker: 'offhost_worm_custody_trust_store_missing',
    invalidBlocker: 'offhost_worm_custody_trust_store_file_invalid',
  });
  if (evidenceLoad.blocker) blockers.push(evidenceLoad.blocker);
  if (trustStoreLoad.blocker) blockers.push(trustStoreLoad.blocker);
  const evidence = evidenceLoad.document;
  let receipt = null;
  let subject = null;
  let evidenceBundleHash = null;
  if (evidence !== null) {
    if (!exactKeys(evidence, BUNDLE_KEYS)
      || evidence.version !== 1 || evidence.kind !== 'OffhostWormCustodyEvidenceBundle') {
      blockers.push('offhost_worm_custody_evidence_type_invalid');
    } else {
      const { custodyEvidenceBundleHash, ...bundlePayload } = evidence;
      if (!SHA256.test(String(custodyEvidenceBundleHash || ''))
        || hashRecord('OffhostWormCustodyEvidenceBundle', bundlePayload)
          !== custodyEvidenceBundleHash) {
        blockers.push('offhost_worm_custody_evidence_hash_invalid');
      } else evidenceBundleHash = custodyEvidenceBundleHash;
      receipt = evidence.receipt;
      subject = evidence.attestationSubject;
    }
  }
  if (!exactKeys(receipt, RECEIPT_KEYS)
    || receipt?.version !== 1 || receipt?.kind !== 'OffhostWormCustodyReceipt') {
    blockers.push('current_object_lock_receipt_missing');
    receipt = null;
  } else {
    const { receiptHash, ...receiptPayload } = receipt;
    if (receipt.contractId !== contract?.contractId
      || receipt.targetMountRoot !== targetMountRoot
      || receipt.storageIdentityHash !== storageIdentityHash
      || receipt.snapshotManifestHash !== snapshot.manifestHash
      || receipt.snapshotObjectSetHash !== snapshot.objectSetHash
      || !SHA256.test(String(receipt.storageIdentityHash || ''))
      || !SHA256.test(String(receipt.snapshotManifestHash || ''))
      || !SHA256.test(String(receipt.snapshotObjectSetHash || ''))
      || receipt.receiptType !== 'object_lock'
      || !['offhost', 'offsite'].includes(receipt.custodyClass)
      || !SAFE_ID.test(String(receipt.storageSubjectId || ''))
      || !validWindow({
        issuedAt: receipt.issuedAt,
        expiresAt: receipt.expiresAt,
        nowMs,
        maximumLifetimeMs,
      })
      || !SHA256.test(String(receiptHash || ''))
      || hashRecord('OffhostWormCustodyReceipt', receiptPayload) !== receiptHash) {
      blockers.push('current_object_lock_receipt_invalid_or_stale');
      receipt = null;
    }
  }
  if (!exactKeys(subject, SUBJECT_KEYS)
    || subject?.version !== 1 || subject?.kind !== SUBJECT_KIND) {
    blockers.push('independent_custody_attestation_missing');
    subject = null;
  } else {
    const { offhostWormCustodyAttestationSubjectHash, ...subjectPayload } = subject;
    if (!receipt || subject.contractId !== contract?.contractId
      || subject.targetMountRoot !== targetMountRoot
      || subject.custodyReceiptHash !== receipt?.receiptHash
      || subject.custodyClass !== receipt?.custodyClass
      || !SAFE_ID.test(String(subject.independentCustodianId || ''))
      || subject.independentCustodianId === receipt?.storageSubjectId
      || !validWindow({
        issuedAt: subject.attestedAt,
        expiresAt: subject.expiresAt,
        nowMs,
        maximumLifetimeMs,
      })
      || Date.parse(subject.attestedAt) < Date.parse(receipt?.issuedAt || '')
      || Date.parse(subject.expiresAt) > Date.parse(receipt?.expiresAt || '')
      || !SHA256.test(String(offhostWormCustodyAttestationSubjectHash || ''))
      || hashRecord(SUBJECT_KIND, subjectPayload)
        !== offhostWormCustodyAttestationSubjectHash) {
      blockers.push('independent_custody_attestation_subject_invalid_or_stale');
      subject = null;
    }
  }
  let verification = null;
  if (subject && trustStoreLoad.document && blockers.length === 0) {
    verification = verifyPinnedExternalEvidenceEnvelope({
      envelope: evidence.authorityEnvelope,
      subjectKind: SUBJECT_KIND,
      subjectHash: subject.offhostWormCustodyAttestationSubjectHash,
      trustStore: trustStoreLoad.document,
      requiredRole: ROLE,
      expectedKeyIds: signerKeyIds,
      now: new Date(nowMs),
      maximumLifetimeMs,
    });
    if (verification.cryptographicAuthorityReady !== true
      || verification.trustStoreHash !== contract.custodyTrustStoreHash
      || JSON.stringify(verification.verifiedSubjectIds)
        !== JSON.stringify([subject.independentCustodianId])
      || verification.signedAt !== subject.attestedAt
      || verification.expiresAt !== subject.expiresAt) {
      blockers.push('independent_custody_attestation_signature_or_freshness_invalid');
    }
  } else if (subject) {
    blockers.push('independent_custody_attestation_verifier_unavailable');
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    status: uniqueBlockers.length
      ? 'offhost_worm_custody_evidence_blocked'
      : 'offhost_worm_custody_evidence_verified',
    qualified: uniqueBlockers.length === 0,
    evidenceBundleHash,
    trustStoreHash: verification?.trustStoreHash || null,
    expiresAt: verification?.expiresAt || null,
    blockers: uniqueBlockers,
  });
}
