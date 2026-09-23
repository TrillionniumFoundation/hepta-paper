import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildCurrentCapabilityVerificationManifestPointer,
  verifyCurrentCapabilityVerificationManifestPointer,
} from '../src/current-capability-verification-manifest-pointer.mjs';
import {
  ISOLATED_VERIFICATION_RECEIPT_KEYS,
  isolatedVerificationCodeProvenanceMatches,
  verifyIsolatedVerificationReceipt,
} from '../src/isolated-verification-receipt-contract.mjs';
import { releaseIntegrityEvidence } from './release-integrity-evidence.mjs';

const MAXIMUM_ARTIFACT_BYTES = 16 * 1024 * 1024;
const DOCUMENT_KEYS = Object.freeze([...ISOLATED_VERIFICATION_RECEIPT_KEYS, 'signature']);
const CAPABILITY_MANIFEST_KEYS = Object.freeze([
  'capabilityCount', 'capabilityVerificationManifestHash', 'codeProvenance',
  'codeProvenanceHash', 'generatedAt', 'kind', 'passedCount', 'receipts', 'status', 'version',
]);

function unique(values) {
  return [...new Set(values)];
}

function strictIso(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : null;
}

function prettyJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function safeCallback(callback, label) {
  if (callback === null || callback === undefined) return;
  if (typeof callback !== 'function') throw new Error(`${label}_callback_invalid`);
  const result = callback();
  if (result && typeof result.then === 'function') {
    throw new Error(`${label}_callback_must_be_synchronous`);
  }
}

function signedReceiptDocument(signedDocument, pinnedKey) {
  if (!releaseIntegrityEvidence.exactKeys(signedDocument, DOCUMENT_KEYS)) {
    throw new Error('isolated_verification_signed_document_shape_invalid');
  }
  const { signature, ...receipt } = signedDocument;
  const verification = verifyIsolatedVerificationReceipt({ receipt, expectedMode: 'release' });
  if (verification.status !== 'isolated_verification_receipt_verified') {
    throw new Error(`isolated_verification_receipt_invalid:${verification.blockers.join(',')}`);
  }
  if (!releaseIntegrityEvidence.verifyReleaseIntegritySignature(receipt, signature, {
    pinnedPublicKeyPem: pinnedKey.publicKeyPem,
    pinnedPublicKeyFingerprint: pinnedKey.publicKeyFingerprint,
  })) {
    throw new Error('isolated_verification_receipt_signature_invalid');
  }
  return Object.freeze({ receipt, signature });
}

function receiptFileName(receipt) {
  const epoch = String(Date.parse(receipt.completedAt));
  const digest = String(receipt.isolatedVerificationReceiptHash || '').replace(/^sha256:/u, '');
  if (!/^\d{13}$/u.test(epoch) || !/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error('isolated_verification_receipt_filename_identity_invalid');
  }
  return `ISOLATED_VERIFICATION_RECEIPT_${epoch}_${digest}.json`;
}

function parseCapabilityManifest(bytes, expectedCodeProvenance, notAfter) {
  const blockers = [];
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); }
  catch { blockers.push('isolated_verification_capability_manifest_json_invalid'); }
  if (!releaseIntegrityEvidence.exactKeys(manifest, CAPABILITY_MANIFEST_KEYS)
    || manifest?.version !== 2
    || manifest?.kind !== 'CapabilityVerificationManifest') {
    blockers.push('isolated_verification_capability_manifest_shape_invalid');
  }
  if (manifest?.status !== 'capability_verification_complete'
    || !Number.isSafeInteger(manifest?.capabilityCount)
    || manifest.capabilityCount < 1
    || manifest.passedCount !== manifest.capabilityCount
    || !Array.isArray(manifest.receipts)
    || manifest.receipts.length !== manifest.capabilityCount
    || manifest.receipts.some((receipt) => (
      receipt?.status !== 'capability_implementation_verified'
    ))) blockers.push('isolated_verification_capability_manifest_not_complete');
  if (!isolatedVerificationCodeProvenanceMatches(
    manifest?.codeProvenance,
    expectedCodeProvenance,
  )) blockers.push('isolated_verification_capability_manifest_provenance_mismatch');
  try {
    if (manifest?.codeProvenanceHash
      !== hashRecord('CapabilityVerificationCodeProvenance', manifest?.codeProvenance)) {
      blockers.push('isolated_verification_capability_manifest_provenance_hash_mismatch');
    }
  } catch {
    blockers.push('isolated_verification_capability_manifest_provenance_hash_mismatch');
  }
  const generatedAtMs = strictIso(manifest?.generatedAt);
  if (generatedAtMs === null) blockers.push('isolated_verification_capability_manifest_time_invalid');
  const notAfterMs = notAfter === null || notAfter === undefined ? null : strictIso(notAfter);
  if ((notAfter !== null && notAfter !== undefined && notAfterMs === null)
    || (generatedAtMs !== null && notAfterMs !== null && generatedAtMs > notAfterMs)) {
    blockers.push('isolated_verification_capability_manifest_time_invalid');
  }
  const claimedHash = manifest?.capabilityVerificationManifestHash;
  if (!releaseIntegrityEvidence.SHA256_PATTERN.test(String(claimedHash || ''))) {
    blockers.push('isolated_verification_capability_manifest_self_hash_invalid');
  } else {
    const payload = { ...manifest };
    delete payload.capabilityVerificationManifestHash;
    if (hashRecord('CapabilityVerificationManifest', payload) !== claimedHash) {
      blockers.push('isolated_verification_capability_manifest_self_hash_invalid');
    }
  }
  if (Array.isArray(manifest?.receipts)) {
    for (const receipt of manifest.receipts) {
      const {
        capabilityVerificationReceiptHash: receiptHash,
        ledgerReceiptId,
        ...receiptPayload
      } = receipt || {};
      void ledgerReceiptId;
      if (!releaseIntegrityEvidence.SHA256_PATTERN.test(String(receiptHash || ''))
        || hashRecord('CapabilityVerificationReceipt', receiptPayload) !== receiptHash
        || receipt.codeProvenanceHash !== manifest.codeProvenanceHash
        || !isolatedVerificationCodeProvenanceMatches(
          receipt.codeProvenance,
          manifest.codeProvenance,
        )) {
        blockers.push('isolated_verification_capability_manifest_receipt_invalid');
        break;
      }
    }
  }
  return Object.freeze({
    status: blockers.length
      ? 'isolated_verification_capability_manifest_invalid'
      : 'isolated_verification_capability_manifest_verified',
    blockers: Object.freeze(unique(blockers)),
    manifest: blockers.length ? null : Object.freeze(manifest),
  });
}

export function inspectIsolatedVerificationCapabilityManifest({
  capabilityManifestPath,
  expectedCodeProvenance,
  notAfter = null,
} = {}) {
  if (typeof capabilityManifestPath !== 'string' || !path.isAbsolute(capabilityManifestPath)) {
    return Object.freeze({
      status: 'isolated_verification_capability_manifest_invalid',
      blockers: Object.freeze(['isolated_verification_capability_manifest_path_invalid']),
      manifest: null,
    });
  }
  try {
    const bytes = releaseIntegrityEvidence.readRegularFileNoFollow(
      capabilityManifestPath,
      { maximumBytes: MAXIMUM_ARTIFACT_BYTES },
    );
    return inspectIsolatedVerificationCapabilityManifestBytes({
      capabilityManifestBytes: bytes,
      expectedCodeProvenance,
      notAfter,
    });
  } catch {
    return Object.freeze({
      status: 'isolated_verification_capability_manifest_invalid',
      blockers: Object.freeze(['isolated_verification_capability_manifest_file_unsafe_or_missing']),
      manifest: null,
    });
  }
}

export function inspectIsolatedVerificationCapabilityManifestBytes({
  capabilityManifestBytes,
  expectedCodeProvenance,
  notAfter = null,
} = {}) {
  if (!Buffer.isBuffer(capabilityManifestBytes)
    || capabilityManifestBytes.length < 1
    || capabilityManifestBytes.length > MAXIMUM_ARTIFACT_BYTES) {
    return Object.freeze({
      status: 'isolated_verification_capability_manifest_invalid',
      blockers: Object.freeze(['isolated_verification_capability_manifest_bytes_invalid']),
      manifest: null,
    });
  }
  return parseCapabilityManifest(
    capabilityManifestBytes,
    expectedCodeProvenance,
    notAfter,
  );
}

function ensurePublicationRoots(runtimeRoot, { withManifest }) {
  if (typeof runtimeRoot !== 'string' || !path.isAbsolute(runtimeRoot)) {
    throw new Error('isolated_verification_publication_runtime_root_invalid');
  }
  const root = path.resolve(runtimeRoot);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('isolated_verification_publication_runtime_root_unsafe');
  }
  const evidenceRoot = releaseIntegrityEvidence.ensurePrivateDirectoryWithinRuntime(
    root,
    path.join(root, 'release-evidence'),
  );
  const receiptRoot = releaseIntegrityEvidence.ensurePrivateDirectoryWithinRuntime(
    root,
    path.join(evidenceRoot, 'verification-receipts'),
  );
  if (!withManifest) return Object.freeze({ root, evidenceRoot, receiptRoot });
  const manifestRoot = releaseIntegrityEvidence.ensurePrivateDirectoryWithinRuntime(
    root,
    path.join(evidenceRoot, 'capability-verification-manifests'),
  );
  const currentRoot = releaseIntegrityEvidence.ensurePrivateDirectoryWithinRuntime(
    root,
    path.join(evidenceRoot, 'current'),
  );
  return Object.freeze({ root, evidenceRoot, receiptRoot, manifestRoot, currentRoot });
}

function verifyPublishedArtifact(publication) {
  const stat = fs.lstatSync(publication.path);
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink) !== 1
    || stat.dev !== publication.identity.dev || stat.ino !== publication.identity.ino
    || (stat.mode & 0o777) !== publication.mode
    || releaseIntegrityEvidence.sha256RegularFileNoFollow(publication.path)
      !== publication.fileHash) {
    throw new Error('isolated_verification_publication_postimage_invalid');
  }
}

function publishBlockedReceipt({ receiptPath, signedDocument, beforePublish, afterPublish }) {
  safeCallback(beforePublish, 'isolated_verification_before_publish');
  const [publication] = releaseIntegrityEvidence.writeNoClobberJsonFiles([{
    path: receiptPath,
    value: signedDocument,
    mode: 0o444,
    allowExistingExact: true,
  }]);
  try {
    safeCallback(afterPublish, 'isolated_verification_after_publish');
    verifyPublishedArtifact(publication);
    return publication;
  } catch (error) {
    if (!releaseIntegrityEvidence.removeExactPublishedFile(publication)) {
      throw new Error(`isolated_verification_blocked_receipt_rollback_incomplete:${error.message}`);
    }
    throw error;
  }
}

function verifyPublishedPointer({
  pointerPath,
  pointerDocument,
  receipt,
  receiptSignature,
  pinnedKey,
}) {
  const bytes = releaseIntegrityEvidence.readRegularFileNoFollow(pointerPath);
  let persisted;
  try { persisted = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('isolated_verification_current_pointer_json_invalid'); }
  if (hashRecord('ExactCurrentCapabilityVerificationManifestPointerDocument', persisted)
    !== hashRecord('ExactCurrentCapabilityVerificationManifestPointerDocument', pointerDocument)) {
    throw new Error('isolated_verification_current_pointer_postimage_mismatch');
  }
  const { signature: pointerSignature, ...pointer } = persisted;
  const verification = verifyCurrentCapabilityVerificationManifestPointer({
    pointer,
    expectedReceipt: receipt,
  });
  if (verification.status !== 'current_capability_verification_manifest_pointer_verified'
    || !releaseIntegrityEvidence.verifyReleaseIntegritySignature(pointer, pointerSignature, {
      pinnedPublicKeyPem: pinnedKey.publicKeyPem,
      pinnedPublicKeyFingerprint: pinnedKey.publicKeyFingerprint,
    })
    || pointerSignature.publicKeyPem !== receiptSignature.publicKeyPem
    || pointerSignature.publicKeyFingerprint !== receiptSignature.publicKeyFingerprint) {
    throw new Error('isolated_verification_current_pointer_invalid');
  }
}

export function publishIsolatedVerificationReceiptArtifacts({
  runtimeRoot,
  signedDocument,
  capabilityManifestPath = null,
  signCurrentPointer = null,
  beforePublish = null,
  afterPublish = null,
} = {}) {
  const pinnedKey = releaseIntegrityEvidence.loadExistingReleaseSigningKey(runtimeRoot);
  const { receipt, signature } = signedReceiptDocument(signedDocument, pinnedKey);
  if (receipt.status !== 'isolated_verification_passed' && capabilityManifestPath !== null) {
    throw new Error('isolated_verification_blocked_receipt_manifest_forbidden');
  }
  if (receipt.status === 'isolated_verification_passed'
    && typeof signCurrentPointer !== 'function') {
    throw new Error('isolated_verification_current_pointer_signer_required');
  }
  const roots = ensurePublicationRoots(runtimeRoot, {
    withManifest: receipt.status === 'isolated_verification_passed',
  });
  const receiptPath = path.join(roots.receiptRoot, receiptFileName(receipt));
  const receiptRelativePath = releaseIntegrityEvidence.pathWithin(roots.root, receiptPath);
  const receiptFileHash = releaseIntegrityEvidence.sha256Bytes(prettyJsonBytes(signedDocument));
  if (receipt.status !== 'isolated_verification_passed') {
    const blocked = publishBlockedReceipt({
      receiptPath, signedDocument, beforePublish, afterPublish,
    });
    return Object.freeze({
      version: 2,
      kind: 'IsolatedVerificationPublicationResult',
      status: 'isolated_verification_artifacts_published',
      receiptPath,
      receiptFileHash,
      receiptPreexisting: blocked.preexisting,
      capabilityManifestPath: null,
      capabilityManifestFileHash: null,
      capabilityManifestPreexisting: null,
      capabilityManifestPointerPath: null,
      capabilityManifestPointerHash: null,
    });
  }

  const inspection = inspectIsolatedVerificationCapabilityManifest({
    capabilityManifestPath,
    expectedCodeProvenance: receipt.codeProvenance,
    notAfter: receipt.completedAt,
  });
  if (inspection.status !== 'isolated_verification_capability_manifest_verified') {
    throw new Error(inspection.blockers.join(','));
  }
  const manifest = inspection.manifest;
  const manifestFileHash = releaseIntegrityEvidence.sha256Bytes(prettyJsonBytes(manifest));
  const manifestName = `CAPABILITY_VERIFICATION_MANIFEST_${manifestFileHash.slice(7)}.json`;
  const manifestPath = path.join(roots.manifestRoot, manifestName);
  const manifestRelativePath = releaseIntegrityEvidence.pathWithin(roots.root, manifestPath);
  const pointer = buildCurrentCapabilityVerificationManifestPointer({
    receipt,
    receiptRelativePath,
    receiptFileHash,
    targetRelativePath: manifestRelativePath,
    targetFileHash: manifestFileHash,
    capabilityVerificationManifestHash: manifest.capabilityVerificationManifestHash,
  });
  const pointerSignature = signCurrentPointer(pointer);
  if (pointerSignature && typeof pointerSignature.then === 'function') {
    throw new Error('isolated_verification_current_pointer_signer_must_be_synchronous');
  }
  if (!releaseIntegrityEvidence.verifyReleaseIntegritySignature(pointer, pointerSignature, {
    pinnedPublicKeyPem: pinnedKey.publicKeyPem,
    pinnedPublicKeyFingerprint: pinnedKey.publicKeyFingerprint,
  })
    || pointerSignature.publicKeyPem !== signature.publicKeyPem
    || pointerSignature.publicKeyFingerprint !== signature.publicKeyFingerprint) {
    throw new Error('isolated_verification_current_pointer_signing_key_mismatch');
  }
  const pointerDocument = Object.freeze({ ...pointer, signature: pointerSignature });
  const pointerPath = path.join(roots.currentRoot, 'CAPABILITY_VERIFICATION_MANIFEST.json');
  const publication = releaseIntegrityEvidence.publishJsonArtifactSet({
    entries: [
      {
        path: receiptPath,
        value: signedDocument,
        mode: 0o444,
        allowExistingExact: true,
      },
      {
        path: manifestPath,
        value: manifest,
        mode: 0o444,
        allowExistingExact: true,
      },
    ],
    pointerPath,
    pointerValue: pointerDocument,
    beforePointer() {
      safeCallback(beforePublish, 'isolated_verification_before_publish');
    },
    afterPointer() {
      safeCallback(afterPublish, 'isolated_verification_after_publish');
      verifyPublishedPointer({
        pointerPath,
        pointerDocument,
        receipt,
        receiptSignature: signature,
        pinnedKey,
      });
    },
  });
  return Object.freeze({
    version: 2,
    kind: 'IsolatedVerificationPublicationResult',
    status: 'isolated_verification_artifacts_published',
    receiptPath,
    receiptFileHash,
    receiptPreexisting: publication.artifacts[0].preexisting,
    capabilityManifestPath: manifestPath,
    capabilityManifestFileHash: manifestFileHash,
    capabilityManifestPreexisting: publication.artifacts[1].preexisting,
    capabilityManifestPointerPath: pointerPath,
    capabilityManifestPointerHash:
      pointer.currentCapabilityVerificationManifestPointerHash,
  });
}
