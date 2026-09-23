import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  normalizeSubmissionHandoffBundleRelativePath,
  SUBMISSION_HANDOFF_BUNDLE_RESOURCE_LIMITS,
} from './handoff-bundle-integrity.mjs';

function assertBoundedInventory(files, reservedFiles = 0) {
  if (!Array.isArray(files)
    || files.length + reservedFiles
      > SUBMISSION_HANDOFF_BUNDLE_RESOURCE_LIMITS.maximumEntries) {
    throw new Error('handoff_bundle_resource_file_inventory_exceeded');
  }
}

export function blockedSubmissionHandoffExportReceipt(
  blockers,
  paperId,
  localFilesystemMutationPerformed = false,
) {
  const blocked = {
    version: 1,
    kind: 'SubmissionHandoffBundleExportReceipt',
    status: 'submission_handoff_bundle_blocked',
    paperId: paperId || null,
    blockers: [...new Set(blockers)],
    localFilesystemMutationPerformed,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...blocked,
    submissionHandoffBundleExportReceiptHash: hashRecord(
      'SubmissionHandoffBundleExportReceipt',
      blocked,
    ),
  });
}

function controlDocumentBytes(value) {
  return value === null
    ? 0 : Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function submissionHandoffArtifactBundlePath(artifact, index) {
  const name = String(path.basename(artifact?.path || '') || 'artifact')
    .replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 160) || 'artifact';
  return `artifacts/${String(index + 1).padStart(3, '0')}-${name}`;
}

export function assertSubmissionHandoffBundleResourcePlan({
  files,
  errorPrefix = 'handoff_bundle_resource_plan',
} = {}) {
  assertBoundedInventory(files);
  const plannedFiles = new Set();
  const plannedDirectories = new Set();
  let totalBytes = 0;
  for (const file of files) {
    const relative = normalizeSubmissionHandoffBundleRelativePath(
      file?.relativePath,
      `${errorPrefix}_path_invalid`,
    );
    const bytes = Number(file?.bytes);
    if (!Number.isSafeInteger(bytes) || bytes < 0
      || bytes > SUBMISSION_HANDOFF_BUNDLE_RESOURCE_LIMITS.maximumFileBytes) {
      throw new Error(`${errorPrefix}_file_bytes_exceeded`);
    }
    if (plannedFiles.has(relative) || plannedDirectories.has(relative)) {
      throw new Error(`${errorPrefix}_path_duplicate`);
    }
    const segments = relative.split('/');
    if (segments.length
        > SUBMISSION_HANDOFF_BUNDLE_RESOURCE_LIMITS.maximumDepth) {
      throw new Error(`${errorPrefix}_depth_limit_exceeded`);
    }
    plannedFiles.add(relative);
    for (let index = 1; index < segments.length; index += 1) {
      const directory = segments.slice(0, index).join('/');
      if (plannedFiles.has(directory)) {
        throw new Error(`${errorPrefix}_path_duplicate`);
      }
      plannedDirectories.add(directory);
    }
    if (plannedFiles.size + plannedDirectories.size
        > SUBMISSION_HANDOFF_BUNDLE_RESOURCE_LIMITS.maximumEntries) {
      throw new Error(`${errorPrefix}_entry_limit_exceeded`);
    }
    totalBytes += bytes;
    if (totalBytes
        > SUBMISSION_HANDOFF_BUNDLE_RESOURCE_LIMITS.maximumTotalBytes) {
      throw new Error(`${errorPrefix}_total_bytes_exceeded`);
    }
  }
  return Object.freeze({
    directoryCount: plannedDirectories.size,
    entryCount: plannedFiles.size + plannedDirectories.size,
    fileCount: plannedFiles.size,
    totalBytes,
  });
}

export function assertSubmissionHandoffExportArtifactInventory(artifacts) {
  assertBoundedInventory(artifacts, 1);
  return true;
}

export function assertSubmissionHandoffExportResourcePlan({
  artifactReads,
  controlDocument = null,
  detachedRecordsCapsule = null,
  sealedPackageInspection = null,
} = {}) {
  const documents = detachedRecordsCapsule?.documents || [];
  const sealedFiles = sealedPackageInspection?.descriptors || [];
  assertBoundedInventory(artifactReads);
  assertBoundedInventory(documents);
  assertBoundedInventory(sealedFiles);
  if (1 + artifactReads.length + documents.length + sealedFiles.length
      > SUBMISSION_HANDOFF_BUNDLE_RESOURCE_LIMITS.maximumEntries) {
    throw new Error('handoff_bundle_resource_file_inventory_exceeded');
  }
  return assertSubmissionHandoffBundleResourcePlan({
    files: [
      {
        relativePath: 'SUBMISSION_HANDOFF_MANIFEST.json',
        bytes: controlDocumentBytes(controlDocument),
      },
      ...artifactReads.map(({ artifact, index, read }) => ({
        relativePath: submissionHandoffArtifactBundlePath(artifact, index),
        bytes: read.bytes,
      })),
      ...documents.map((document) => ({
        relativePath: document.path,
        bytes: document.descriptor.bytes,
      })),
      ...sealedFiles.map(({ read, relative }) => ({
        relativePath: `sealed-package/${relative}`,
        bytes: read.bytes,
      })),
    ],
    errorPrefix: 'handoff_bundle_resource_plan',
  });
}

export function assertSubmissionHandoffSealedCopyInputInventory(files) {
  assertBoundedInventory(files, 1);
  return true;
}

export function assertSubmissionHandoffSealedCopyResourcePlan(
  inspection,
  { controlDocument = null } = {},
) {
  const descriptors = inspection?.descriptors;
  assertBoundedInventory(descriptors, 1);
  return assertSubmissionHandoffBundleResourcePlan({
    files: [
      { relativePath: 'SEALED_PACKAGE_COPY_TRANSACTION.json',
        bytes: controlDocumentBytes(controlDocument) },
      ...descriptors.map(({ read, relative }) => ({
        relativePath: `sealed-package/${relative}`,
        bytes: read.bytes,
      })),
    ],
    errorPrefix: 'handoff_sealed_package_copy_resource_plan',
  });
}
