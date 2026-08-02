import fs from 'node:fs';
import path from 'node:path';
import {
  CURRENT_CAPABILITY_VERIFICATION_MANIFEST_POINTER_KEYS,
  verifyCurrentCapabilityVerificationManifestPointer,
} from '../src/current-capability-verification-manifest-pointer.mjs';
import { releaseIntegrityEvidence } from './release-integrity-evidence.mjs';
import {
  inspectIsolatedVerificationCapabilityManifestBytes,
} from './isolated-verification-receipt-publication.mjs';

const MAXIMUM_ARTIFACT_BYTES = 16 * 1024 * 1024;
const {
  exactKeys,
  existingDirectoryWithinRuntime,
  loadExistingReleaseSigningKey,
  pathWithin,
  readRegularFileNoFollow,
  sha256Bytes,
  unique,
  verifyReleaseIntegritySignature,
} = releaseIntegrityEvidence;

function blockedSelection(blockers, details = {}) {
  return Object.freeze({
    version: 1,
    kind: 'CurrentCapabilityVerificationManifestSelection',
    status: 'current_capability_verification_manifest_evidence_blocked',
    pointer: null,
    manifest: null,
    releaseEvidenceReady: false,
    blockers: unique(blockers),
    ...details,
  });
}

function safeRuntimeArtifactPath(runtimeRoot, relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) return null;
  const absolutePath = path.resolve(runtimeRoot, relativePath);
  if (pathWithin(runtimeRoot, absolutePath) !== relativePath.replace(/\\/gu, '/')) return null;
  try {
    if (!existingDirectoryWithinRuntime(runtimeRoot, path.dirname(absolutePath))) return null;
  } catch {
    return null;
  }
  return absolutePath;
}

export function selectCurrentCapabilityVerificationManifest({
  runtimeRoot,
  expectedReceipt,
  expectedReceiptRelativePath,
  expectedReceiptFileHash,
  readArtifact = readRegularFileNoFollow,
} = {}) {
  if (typeof runtimeRoot !== 'string' || !path.isAbsolute(runtimeRoot)) {
    return blockedSelection(['capability_manifest_runtime_root_invalid']);
  }
  const currentRoot = path.join(runtimeRoot, 'release-evidence', 'current');
  if (!fs.existsSync(currentRoot)) {
    return blockedSelection(['capability_manifest_current_pointer_missing']);
  }
  try {
    if (!existingDirectoryWithinRuntime(runtimeRoot, currentRoot)) {
      return blockedSelection(['capability_manifest_current_root_unsafe']);
    }
  } catch {
    return blockedSelection(['capability_manifest_current_root_unsafe']);
  }
  let key;
  try { key = loadExistingReleaseSigningKey(runtimeRoot); } catch {
    return blockedSelection(['capability_manifest_pinned_public_key_unavailable']);
  }
  const pointerPath = path.join(currentRoot, 'CAPABILITY_VERIFICATION_MANIFEST.json');
  const pointerRelativePath = pathWithin(runtimeRoot, pointerPath);
  let pointerBytes;
  try {
    pointerBytes = readArtifact(pointerPath, {
      maximumBytes: MAXIMUM_ARTIFACT_BYTES,
    });
  } catch {
    return blockedSelection(['capability_manifest_current_pointer_file_unsafe'], {
      pointerRelativePath,
      pinnedPublicKeyFingerprint: key.publicKeyFingerprint,
    });
  }
  const pointerFileHash = sha256Bytes(pointerBytes);
  let document;
  try { document = JSON.parse(pointerBytes.toString('utf8')); } catch {
    return blockedSelection(['capability_manifest_current_pointer_json_invalid'], {
      pointerRelativePath,
      pointerFileHash,
      pinnedPublicKeyFingerprint: key.publicKeyFingerprint,
    });
  }
  if (!exactKeys(document, [
    ...CURRENT_CAPABILITY_VERIFICATION_MANIFEST_POINTER_KEYS,
    'signature',
  ])) {
    return blockedSelection(['capability_manifest_current_pointer_shape_invalid'], {
      pointerRelativePath,
      pointerFileHash,
      pinnedPublicKeyFingerprint: key.publicKeyFingerprint,
    });
  }
  const { signature, ...pointer } = document;
  const blockers = [];
  const pointerVerification = verifyCurrentCapabilityVerificationManifestPointer({
    pointer,
    expectedReceipt,
  });
  if (pointerVerification.status
    !== 'current_capability_verification_manifest_pointer_verified') {
    blockers.push(...pointerVerification.blockers);
  }
  if (!verifyReleaseIntegritySignature(pointer, signature, {
    pinnedPublicKeyPem: key.publicKeyPem,
    pinnedPublicKeyFingerprint: key.publicKeyFingerprint,
  })) blockers.push('capability_manifest_current_pointer_signature_invalid');
  if (pointer.isolatedVerificationReceiptRelativePath !== expectedReceiptRelativePath
    || pointer.isolatedVerificationReceiptFileHash !== expectedReceiptFileHash) {
    blockers.push('capability_manifest_current_pointer_receipt_file_mismatch');
  }
  const receiptPath = safeRuntimeArtifactPath(
    runtimeRoot,
    pointer.isolatedVerificationReceiptRelativePath,
  );
  const manifestPath = safeRuntimeArtifactPath(runtimeRoot, pointer.targetRelativePath);
  if (!receiptPath) blockers.push('capability_manifest_pointer_receipt_path_unsafe');
  if (!manifestPath) blockers.push('capability_manifest_pointer_target_path_unsafe');
  let receiptFileHash = null;
  if (receiptPath) {
    try {
      receiptFileHash = sha256Bytes(readArtifact(receiptPath, {
        maximumBytes: MAXIMUM_ARTIFACT_BYTES,
      }));
    } catch { blockers.push('capability_manifest_pointer_receipt_file_unsafe'); }
    if (receiptFileHash !== pointer.isolatedVerificationReceiptFileHash) {
      blockers.push('capability_manifest_pointer_receipt_file_hash_mismatch');
    }
  }
  let manifestFileHash = null;
  let manifest = null;
  if (manifestPath) {
    let manifestBytes;
    try {
      manifestBytes = readArtifact(manifestPath, {
        maximumBytes: MAXIMUM_ARTIFACT_BYTES,
      });
      manifestFileHash = sha256Bytes(manifestBytes);
    } catch { blockers.push('capability_manifest_pointer_target_file_unsafe'); }
    if (manifestFileHash !== pointer.targetFileHash) {
      blockers.push('capability_manifest_pointer_target_file_hash_mismatch');
    }
    const inspection = inspectIsolatedVerificationCapabilityManifestBytes({
      capabilityManifestBytes: manifestBytes,
      expectedCodeProvenance: expectedReceipt?.codeProvenance,
      notAfter: expectedReceipt?.completedAt,
    });
    if (inspection.status !== 'isolated_verification_capability_manifest_verified') {
      blockers.push(...inspection.blockers);
    } else {
      manifest = inspection.manifest;
      if (manifest.capabilityVerificationManifestHash
        !== pointer.capabilityVerificationManifestHash) {
        blockers.push('capability_manifest_pointer_semantic_hash_mismatch');
      }
    }
  }
  if (blockers.length) {
    return blockedSelection(blockers, {
      pointerRelativePath,
      pointerFileHash,
      targetRelativePath: pointer.targetRelativePath || null,
      targetFileHash: manifestFileHash,
      pinnedPublicKeyFingerprint: key.publicKeyFingerprint,
    });
  }
  return Object.freeze({
    version: 1,
    kind: 'CurrentCapabilityVerificationManifestSelection',
    status: 'current_capability_verification_manifest_evidence_verified',
    pointer: Object.freeze(pointer),
    manifest,
    pointerRelativePath,
    pointerFileHash,
    targetRelativePath: pointer.targetRelativePath,
    targetFileHash: manifestFileHash,
    receiptRelativePath: pointer.isolatedVerificationReceiptRelativePath,
    receiptFileHash,
    pinnedPublicKeyFingerprint: key.publicKeyFingerprint,
    releaseEvidenceReady: true,
    blockers: [],
  });
}
