import fs from 'node:fs';
import path from 'node:path';

import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import {
  createSubmissionHandoffDetachedRecordsCapsule,
  hashSubmissionHandoffDetachedRecordSet,
  submissionHandoffDetachedManifestDescriptors,
} from './handoff-bundle-detached-records.mjs';

export {
  createSubmissionHandoffDetachedRecordsCapsule,
  hashSubmissionHandoffDetachedRecordSet,
};

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const AUTHORITY_LINEAGE_KEYS = Object.freeze([
  'authorizationConsumptionHash',
  'deadLetterCount',
  'dispatchAuthorizationHash',
  'grantsExecutionPermission',
  'kind',
  'messageId',
  'observedAt',
  'paperId',
  'payloadBindingHash',
  'providerCapabilityExpiresAt',
  'providerCapabilityHash',
  'providerCapabilityValidFrom',
  'releaseLockHash',
  'requiresProviderActionTimeAuthorityRevalidation',
  'responseCount',
  'rowBindingHash',
  'submissionHandoffAuthorityLineageHash',
  'submissionHandoffExportAuthorityHash',
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
export const SUBMISSION_HANDOFF_BUNDLE_RESOURCE_LIMITS = Object.freeze({
  maximumDepth: 32,
  maximumEntries: 4_096,
  maximumFileBytes: 256 * 1024 * 1024,
  maximumTotalBytes: 4 * 1024 * 1024 * 1024,
});

function identity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function portableRelativePath(value, errorCode = 'handoff_bundle_relative_path_invalid') {
  const relative = String(value || '').replace(/\\/g, '/');
  if (!relative || relative.startsWith('/')
    || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(errorCode);
  }
  return relative;
}

export {
  portableRelativePath as normalizeSubmissionHandoffBundleRelativePath,
};

function expectedDirectorySet(relativePaths) {
  const directories = new Set();
  for (const relative of relativePaths) {
    const segments = relative.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join('/'));
    }
  }
  return directories;
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((entry) => right.has(entry));
}

function hasExactKeys(value, expected) {
  return value && typeof value === 'object'
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

export function assertSubmissionHandoffAuthorityLineage(
  lineage,
  { dispatchAuthorizationHash = null, paperId = null } = {},
) {
  if (!hasExactKeys(lineage, AUTHORITY_LINEAGE_KEYS)
    || lineage.version !== 1
    || lineage.kind !== 'SubmissionHandoffAuthorityLineage'
    || !lineage.messageId || !lineage.paperId
    || (paperId && lineage.paperId !== paperId)
    || !SHA256.test(String(lineage.dispatchAuthorizationHash || ''))
    || (dispatchAuthorizationHash
      && lineage.dispatchAuthorizationHash !== dispatchAuthorizationHash)
    || ![
      lineage.submissionHandoffExportAuthorityHash,
      lineage.rowBindingHash,
      lineage.authorizationConsumptionHash,
      lineage.releaseLockHash,
      lineage.payloadBindingHash,
      lineage.providerCapabilityHash,
    ].every((value) => SHA256.test(String(value || '')))
    || !Number.isFinite(Date.parse(String(lineage.observedAt || '')))
    || !Number.isFinite(Date.parse(
      String(lineage.providerCapabilityValidFrom || ''),
    ))
    || !Number.isFinite(Date.parse(
      String(lineage.providerCapabilityExpiresAt || ''),
    ))
    || Date.parse(lineage.providerCapabilityValidFrom)
      > Date.parse(lineage.observedAt)
    || Date.parse(lineage.observedAt)
      >= Date.parse(lineage.providerCapabilityExpiresAt)
    || lineage.responseCount !== 0 || lineage.deadLetterCount !== 0
    || lineage.grantsExecutionPermission !== false
    || lineage.requiresProviderActionTimeAuthorityRevalidation !== true) {
    throw new Error('handoff_bundle_submission_authority_lineage_invalid');
  }
  const payload = { ...lineage };
  delete payload.submissionHandoffAuthorityLineageHash;
  if (lineage.submissionHandoffAuthorityLineageHash !== hashRecord(
    'SubmissionHandoffAuthorityLineage',
    payload,
  )) {
    throw new Error('handoff_bundle_submission_authority_lineage_hash_invalid');
  }
}

function validInodeIdentity(value) {
  return hasExactKeys(value, ['dev', 'ino'])
    && /^[0-9]+$/u.test(String(value.dev))
    && /^[0-9]+$/u.test(String(value.ino));
}

function assertSubmissionHandoffPublicationLineage(lineage) {
  if (!hasExactKeys(lineage, PUBLICATION_LINEAGE_KEYS)
    || lineage.version !== 1
    || lineage.kind !== 'SubmissionHandoffBundlePublicationLineage'
    || !lineage.finalName || path.basename(lineage.finalName) !== lineage.finalName
    || lineage.finalName === '.' || lineage.finalName === '..'
    || lineage.finalName.includes('\\') || lineage.finalName.includes('\0')
    || !validInodeIdentity(lineage.parentIdentity)
    || !validInodeIdentity(lineage.stagingIdentity)
    || !SHA256.test(String(
      lineage.submissionHandoffBundlePublicationHash || '',
    ))) {
    throw new Error('handoff_bundle_manifest_publication_lineage_invalid');
  }
  const payload = { ...lineage };
  delete payload.submissionHandoffBundlePublicationLineageHash;
  if (lineage.submissionHandoffBundlePublicationLineageHash !== hashRecord(
    'SubmissionHandoffBundlePublicationLineage',
    payload,
  )) {
    throw new Error('handoff_bundle_manifest_publication_lineage_hash_invalid');
  }
}

function walkPinnedTree(root, {
  errorPrefix = 'handoff_bundle_tree',
  seal = false,
  requireReadOnly = false,
} = {}) {
  const selectedRoot = path.resolve(root || '.');
  const files = new Set();
  const directories = new Set();
  let entryCount = 0;
  let totalBytes = 0;
  const visit = (candidate, relative, initial) => {
    const depth = relative ? relative.split('/').length : 0;
    if (depth > SUBMISSION_HANDOFF_BUNDLE_RESOURCE_LIMITS.maximumDepth) {
      throw new Error(`${errorPrefix}_depth_limit_exceeded`);
    }
    if (relative) {
      entryCount += 1;
      if (entryCount > SUBMISSION_HANDOFF_BUNDLE_RESOURCE_LIMITS.maximumEntries) {
        throw new Error(`${errorPrefix}_entry_limit_exceeded`);
      }
    }
    if (initial.isSymbolicLink()) throw new Error(`${errorPrefix}_symlink_forbidden`);
    if (!initial.isDirectory() && !initial.isFile()) {
      throw new Error(`${errorPrefix}_special_file_forbidden`);
    }
    let descriptor;
    try {
      descriptor = fs.openSync(
        candidate,
        fs.constants.O_RDONLY | (initial.isDirectory() ? DIRECTORY_ONLY : 0) | NO_FOLLOW,
      );
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!sameIdentity(identity(initial), identity(opened))
        || initial.isDirectory() !== opened.isDirectory()
        || initial.isFile() !== opened.isFile()) {
        throw new Error(`${errorPrefix}_identity_changed`);
      }
      if (opened.isFile()) {
        if (opened.nlink !== 1n) throw new Error(`${errorPrefix}_hardlink_forbidden`);
        if (opened.size > BigInt(
          SUBMISSION_HANDOFF_BUNDLE_RESOURCE_LIMITS.maximumFileBytes,
        )) throw new Error(`${errorPrefix}_file_bytes_exceeded`);
        totalBytes += Number(opened.size);
        if (totalBytes
          > SUBMISSION_HANDOFF_BUNDLE_RESOURCE_LIMITS.maximumTotalBytes) {
          throw new Error(`${errorPrefix}_total_bytes_exceeded`);
        }
        files.add(relative);
      } else {
        if (relative) directories.add(relative);
        const pinnedDirectory = `/proc/self/fd/${descriptor}`;
        const directory = fs.opendirSync(pinnedDirectory, { encoding: 'buffer' });
        try {
          for (;;) {
            const entry = directory.readSync();
            if (!entry) break;
            const rawName = Buffer.isBuffer(entry.name)
              ? entry.name : Buffer.from(entry.name, 'utf8');
            const name = rawName.toString('utf8');
            if (!Buffer.from(name, 'utf8').equals(rawName)
              || name === '.' || name === '..' || name.includes('/')
              || name.includes('\\') || name.includes('\0')) {
              throw new Error(`${errorPrefix}_entry_name_invalid`);
            }
            const child = path.join(pinnedDirectory, name);
            visit(child, relative ? `${relative}/${name}` : name, fs.lstatSync(child, {
              bigint: true,
            }));
          }
        } finally {
          directory.closeSync();
        }
      }
      if (seal) {
        const mode = Number(opened.mode & 0o555n)
          | (opened.isDirectory() ? 0o500 : 0o400);
        fs.fchmodSync(descriptor, mode);
        fs.fsyncSync(descriptor);
      }
      const completed = fs.fstatSync(descriptor, { bigint: true });
      const pathCompleted = fs.lstatSync(candidate, { bigint: true });
      if (!sameIdentity(identity(opened), identity(completed))
        || !sameIdentity(identity(completed), identity(pathCompleted))) {
        throw new Error(`${errorPrefix}_changed_during_visit`);
      }
      if ((seal || requireReadOnly) && (completed.mode & 0o222n) !== 0n) {
        throw new Error(`${errorPrefix}_write_permission_remains`);
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  };
  const rootStat = fs.lstatSync(selectedRoot, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || fs.realpathSync.native(selectedRoot) !== selectedRoot) {
    throw new Error(`${errorPrefix}_root_unsafe`);
  }
  visit(selectedRoot, '', rootStat);
  const completedRoot = fs.lstatSync(selectedRoot, { bigint: true });
  if (!sameIdentity(identity(rootStat), identity(completedRoot))) {
    throw new Error(`${errorPrefix}_root_identity_changed`);
  }
  return Object.freeze({ files, directories });
}

function manifestDescriptors(manifestDocument) {
  if (manifestDocument?.version !== 1
    || manifestDocument?.kind !== 'SubmissionHandoffBundleManifest') {
    throw new Error('handoff_bundle_manifest_shape_invalid');
  }
  const claimedHash = manifestDocument.submissionHandoffBundleManifestHash;
  const payload = { ...manifestDocument };
  delete payload.submissionHandoffBundleManifestHash;
  if (!SHA256.test(String(claimedHash || ''))
    || hashRecord('SubmissionHandoffBundleManifest', payload) !== claimedHash) {
    throw new Error('handoff_bundle_manifest_hash_invalid');
  }
  if (manifestDocument.grantsExternalExecutionPermission !== false
    || manifestDocument.requiresCurrentAuthorityRevalidation !== true) {
    throw new Error('handoff_bundle_manifest_execution_safety_invalid');
  }
  if (manifestDocument.persistedSubmissionAuthority !== null) {
    assertSubmissionHandoffAuthorityLineage(
      manifestDocument.persistedSubmissionAuthority,
      {
        dispatchAuthorizationHash: manifestDocument.dispatchAuthorizationHash,
        paperId: manifestDocument.paperId,
      },
    );
  }
  assertSubmissionHandoffPublicationLineage(
    manifestDocument.submissionHandoffBundlePublicationLineage,
  );
  const artifacts = Array.isArray(manifestDocument.artifacts)
    ? manifestDocument.artifacts : [];
  const sealed = manifestDocument.sealedPackageOutput;
  const sealedFiles = Array.isArray(sealed?.files) ? sealed.files : [];
  const detachedRecords = submissionHandoffDetachedManifestDescriptors(
    manifestDocument,
  );
  if (artifacts.length !== Number(manifestDocument.artifactCount)
    || sealedFiles.length !== Number(manifestDocument.sealedPackageFileCount)
    || (sealed === null && Number(manifestDocument.sealedPackageFileCount) !== 0)
    || (sealed && sealedFiles.length !== Number(sealed.fileCount))) {
    throw new Error('handoff_bundle_manifest_file_count_invalid');
  }
  if (sealed) {
    const portableFiles = sealedFiles.map((file) => ({
      role: file.role,
      capsuleRole: file.capsuleRole,
      executionRole: file.executionRole,
      experimentId: file.experimentId,
      packageRelativePath: file.packageRelativePath,
      bundlePath: file.bundlePath,
      hash: file.hash,
      bytes: file.bytes,
    }));
    if (!SHA256.test(String(sealed.immutableCampaignPackageOutputHash || ''))
      || !SHA256.test(String(sealed.fileSetHash || ''))
      || hashRecord('SubmissionHandoffSealedPackageFileSet', portableFiles)
        !== sealed.fileSetHash) {
      throw new Error('handoff_bundle_manifest_sealed_lineage_invalid');
    }
  }
  const fileDescriptors = [
    ...artifacts.map((file) => ({ ...file, scope: 'artifacts' })),
    ...sealedFiles.map((file) => ({ ...file, scope: 'sealed-package' })),
  ].map((file) => {
    const relative = portableRelativePath(
      file.bundlePath,
      'handoff_bundle_manifest_file_path_invalid',
    );
    if (!relative.startsWith(`${file.scope}/`)
      || !SHA256.test(String(file.hash || ''))
      || !Number.isSafeInteger(Number(file.bytes)) || Number(file.bytes) < 0) {
      throw new Error('handoff_bundle_manifest_file_descriptor_invalid');
    }
    return Object.freeze({
      relative,
      hash: file.hash,
      bytes: Number(file.bytes),
      label: file.sourcePath || file.role || relative,
    });
  });
  const descriptors = Object.freeze([
    ...fileDescriptors,
    ...detachedRecords,
  ]);
  if (new Set(descriptors.map((file) => file.relative)).size !== descriptors.length) {
    throw new Error('handoff_bundle_manifest_file_path_duplicate');
  }
  return Object.freeze({ claimedHash, descriptors, detachedRecords });
}

function assertExactFile(root, descriptor, expectedBytes = null) {
  const candidate = path.resolve(root, descriptor.relative);
  if (candidate === root || !isPathWithin(root, candidate)) {
    throw new Error(`handoff_bundle_file_scope_invalid:${descriptor.label}`);
  }
  const read = readScopedFileSync({ scopeRoot: root, candidate });
  if (read.status !== 'scoped_file_read_verified'
    || read.hash !== descriptor.hash || read.bytes !== descriptor.bytes
    || (expectedBytes && !read.content.equals(expectedBytes))) {
    throw new Error(`handoff_bundle_file_verification_failed:${descriptor.label}`);
  }
  return read;
}

function assertExactTree(root, manifestDocument, { requireReadOnly = false } = {}) {
  const manifest = manifestDescriptors(manifestDocument);
  const expectedManifestBytes = canonicalSubmissionHandoffManifestBytes(manifestDocument);
  const manifestDescriptor = Object.freeze({
    relative: 'SUBMISSION_HANDOFF_MANIFEST.json',
    hash: hashBytes(expectedManifestBytes),
    bytes: expectedManifestBytes.length,
    label: 'submission_handoff_manifest',
  });
  const descriptors = [manifestDescriptor, ...manifest.descriptors];
  const expectedFiles = new Set(descriptors.map((file) => file.relative));
  const expectedDirectories = expectedDirectorySet(expectedFiles);
  const actual = walkPinnedTree(root, { requireReadOnly });
  if (!sameSet(expectedFiles, actual.files)
    || !sameSet(expectedDirectories, actual.directories)) {
    throw new Error('handoff_bundle_exact_tree_invalid');
  }
  assertExactFile(root, manifestDescriptor, expectedManifestBytes);
  for (const descriptor of manifest.descriptors) assertExactFile(root, descriptor);
  return manifest;
}

export function canonicalSubmissionHandoffManifestBytes(manifestDocument) {
  return Buffer.from(`${JSON.stringify(manifestDocument, null, 2)}\n`, 'utf8');
}

export function assertSubmissionHandoffSealedPackageCopySync(bundleRoot, copied) {
  const copyRoot = path.join(bundleRoot, 'sealed-package');
  const expectedFiles = new Set(copied.map((file) => portableRelativePath(
    file.packageRelativePath,
    'handoff_sealed_package_relative_path_invalid',
  )));
  const expectedDirectories = expectedDirectorySet(expectedFiles);
  const actual = walkPinnedTree(copyRoot, {
    errorPrefix: 'handoff_sealed_package_copy',
  });
  if (!sameSet(expectedFiles, actual.files)
    || !sameSet(expectedDirectories, actual.directories)) {
    throw new Error('handoff_sealed_package_copy_exact_tree_invalid');
  }
  for (const file of copied) {
    assertExactFile(copyRoot, {
      relative: file.packageRelativePath,
      hash: file.hash,
      bytes: file.bytes,
      label: file.role || 'unknown',
    });
  }
}

export function inspectSubmissionHandoffBundleTreeSync({
  bundleRoot,
  errorPrefix = 'handoff_bundle_tree',
  requireReadOnly = false,
} = {}) {
  return walkPinnedTree(path.resolve(bundleRoot || '.'), {
    errorPrefix,
    requireReadOnly,
  });
}

export function sealSubmissionHandoffBundleTreeSync({
  bundleRoot,
  errorPrefix = 'handoff_bundle_tree',
} = {}) {
  const root = path.resolve(bundleRoot || '.');
  walkPinnedTree(root, { errorPrefix, seal: true });
  return walkPinnedTree(root, { errorPrefix, requireReadOnly: true });
}

export function assertSubmissionHandoffManifestWriteSync({
  bundleRoot,
  manifestDocument,
  manifestWrite,
} = {}) {
  const bytes = canonicalSubmissionHandoffManifestBytes(manifestDocument);
  const expectedHash = hashBytes(bytes);
  if (manifestWrite?.hash !== expectedHash
    || Number(manifestWrite?.bytes) !== bytes.length) {
    throw new Error('handoff_manifest_write_identity_mismatch');
  }
  assertExactFile(path.resolve(bundleRoot), {
    relative: 'SUBMISSION_HANDOFF_MANIFEST.json',
    hash: expectedHash,
    bytes: bytes.length,
    label: 'submission_handoff_manifest',
  }, bytes);
}

export function sealAndVerifySubmissionHandoffBundleSync({
  bundleRoot,
  manifestDocument,
} = {}) {
  const root = path.resolve(bundleRoot || '.');
  assertExactTree(root, manifestDocument);
  walkPinnedTree(root, { seal: true });
  assertExactTree(root, manifestDocument, { requireReadOnly: true });
}

export function inspectSubmissionHandoffBundleExactTreeSync({
  bundleRoot,
  manifestDocument,
  requireReadOnly = true,
} = {}) {
  return assertExactTree(path.resolve(bundleRoot || '.'), manifestDocument, {
    requireReadOnly,
  });
}

export function verifySubmissionHandoffBundle({
  bundleRoot,
  submissionHandoffBundleManifestHash,
} = {}) {
  const blockers = [];
  let manifestDocument = null;
  if (!SHA256.test(String(submissionHandoffBundleManifestHash || ''))) {
    blockers.push('handoff_bundle_expected_manifest_hash_required');
  }
  if (!blockers.length) {
    try {
      const root = path.resolve(bundleRoot || '.');
      const read = readScopedFileSync({
        scopeRoot: root,
        candidate: path.join(root, 'SUBMISSION_HANDOFF_MANIFEST.json'),
      });
      if (read.status !== 'scoped_file_read_verified') {
        throw new Error('handoff_bundle_manifest_unreadable');
      }
      manifestDocument = JSON.parse(read.content.toString('utf8'));
      const inspected = assertExactTree(root, manifestDocument, {
        requireReadOnly: true,
      });
      if (inspected.claimedHash !== submissionHandoffBundleManifestHash) {
        throw new Error('handoff_bundle_expected_manifest_hash_mismatch');
      }
    } catch (error) {
      blockers.push(`handoff_bundle_verification_failed:${String(
        error?.message || 'verification_failed',
      )}`);
    }
  }
  const payload = {
    version: 1,
    kind: 'SubmissionHandoffBundleVerificationReceipt',
    status: blockers.length
      ? 'submission_handoff_bundle_verification_blocked'
      : 'submission_handoff_bundle_verified',
    bundleRoot: bundleRoot ? path.resolve(bundleRoot) : null,
    submissionHandoffBundleManifestHash:
      submissionHandoffBundleManifestHash || null,
    blockers: Object.freeze([...new Set(blockers)]),
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    submissionHandoffBundleVerificationReceiptHash: hashRecord(
      'SubmissionHandoffBundleVerificationReceipt',
      payload,
    ),
    manifest: blockers.length ? null : Object.freeze(manifestDocument),
  });
}
