import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function scoped(root, relative) {
  const resolvedRoot = path.resolve(String(root || ''));
  const candidate = path.resolve(resolvedRoot, String(relative || ''));
  return candidate === resolvedRoot || candidate.startsWith(`${resolvedRoot}${path.sep}`)
    ? candidate
    : null;
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function readStableRegularFile({ root, candidate, label, blockers }) {
  try {
    const resolvedRoot = fs.realpathSync(root);
    const before = fs.lstatSync(candidate);
    if (!before.isFile() || before.isSymbolicLink()) {
      blockers.push(`${label}_not_regular`);
      return null;
    }
    const resolvedCandidate = fs.realpathSync(candidate);
    if (!inside(resolvedRoot, resolvedCandidate)) {
      blockers.push(`${label}_realpath_unsafe`);
      return null;
    }
    const bytes = fs.readFileSync(candidate);
    const after = fs.lstatSync(candidate);
    if (!after.isFile() || after.isSymbolicLink()
      || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      blockers.push(`${label}_changed_during_read`);
      return null;
    }
    return bytes;
  } catch {
    blockers.push(`${label}_missing`);
    return null;
  }
}

export function verifyArtifactWriteReceiptSource({ receipt } = {}) {
  const blockers = [];
  if (receipt?.version !== 2 || receipt?.kind !== 'ArtifactWriteReceipt') blockers.push('artifact_write_receipt_contract_invalid');
  const { writeReceiptHash: _claimedWriteHash, ledgerReceiptId: _ledgerReceiptId, ...receiptPayload } = receipt || {};
  if (!receipt?.writeReceiptHash || hashRecord('ArtifactWriteReceipt', receiptPayload) !== receipt.writeReceiptHash) blockers.push('artifact_write_receipt_hash_mismatch');
  const manifestPath = scoped(receipt?.casRoot, receipt?.manifestPath);
  const materializedPath = scoped(receipt?.scopeRoot, receipt?.path);
  if (!manifestPath) blockers.push('artifact_manifest_path_unsafe');
  if (!materializedPath) blockers.push('artifact_materialized_path_unsafe');
  let manifest = null;
  if (manifestPath) {
    const bytes = readStableRegularFile({ root: receipt?.casRoot, candidate: manifestPath, label: 'artifact_manifest', blockers });
    if (bytes) {
      try { manifest = JSON.parse(bytes.toString('utf8')); } catch { blockers.push('artifact_manifest_invalid'); }
    }
  }
  if (manifest) {
    const { manifestHash: _claimedManifestHash, ...manifestPayload } = manifest;
    if (hashRecord('ImmutableArtifactManifest', manifestPayload) !== receipt?.manifestHash
      || manifest.manifestHash !== receipt?.manifestHash) blockers.push('artifact_manifest_hash_mismatch');
    const expected = {
      repositoryId: receipt?.repositoryId,
      role: receipt?.role,
      contentType: receipt?.contentType,
      logicalPath: receipt?.path,
      contentHash: receipt?.hash,
      bytes: Number(receipt?.bytes),
    };
    for (const [field, value] of Object.entries(expected)) if (manifest?.[field] !== value) blockers.push(`artifact_manifest_${field}_mismatch`);
  }
  const objectPath = manifest ? scoped(receipt?.casRoot, manifest.objectPath) : null;
  if (manifest && !objectPath) blockers.push('artifact_object_path_unsafe');
  let objectBytes = null;
  if (objectPath) {
    objectBytes = readStableRegularFile({ root: receipt?.casRoot, candidate: objectPath, label: 'artifact_object', blockers });
  }
  if (objectBytes) {
    if (sha256(objectBytes) !== receipt?.hash) blockers.push('artifact_object_hash_mismatch');
    if (objectBytes.length !== Number(receipt?.bytes)) blockers.push('artifact_object_size_mismatch');
  }
  let materializedBytes = null;
  if (materializedPath) {
    materializedBytes = readStableRegularFile({ root: receipt?.scopeRoot, candidate: materializedPath, label: 'artifact_materialized_file', blockers });
  }
  if (materializedBytes) {
    if (sha256(materializedBytes) !== receipt?.hash) blockers.push('artifact_materialized_hash_mismatch');
    if (materializedBytes.length !== Number(receipt?.bytes)) blockers.push('artifact_materialized_size_mismatch');
  }
  const payload = {
    version: 1,
    kind: 'ArtifactWriteReceiptSourceVerification',
    status: blockers.length ? 'artifact_write_receipt_source_blocked' : 'artifact_write_receipt_source_verified',
    repositoryId: receipt?.repositoryId || null,
    path: receipt?.path || null,
    contentHash: receipt?.hash || null,
    manifestHash: receipt?.manifestHash || null,
    writeReceiptHash: receipt?.writeReceiptHash || null,
    manifestRead: Boolean(manifest),
    objectBytesRead: Boolean(objectBytes),
    materializedBytesRead: Boolean(materializedBytes),
    blockers: [...new Set(blockers)],
  };
  return Object.freeze({ ...payload, artifactWriteReceiptSourceVerificationHash: hashRecord('ArtifactWriteReceiptSourceVerification', payload) });
}
