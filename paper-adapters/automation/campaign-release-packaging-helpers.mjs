import fs from 'node:fs';
import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { fileRecord } from '../../workflow-kernel/runtime/file-utils.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import {
  workspaceExecutionMerkleHash,
} from '../../workflow-kernel/runtime/workspace-execution-identity.mjs';
import {
  inspectWorkspaceExecutionSnapshot,
  sourceTreeExcludedNames,
} from '../runtime/execution-snapshot.mjs';
import {
  packageDeletionWriterScopeForArtifactRepositoryFactory,
} from '../../paper-ports/execution-service-ports.mjs';
import { createRuntimeRetentionPackageDeletionWriterBoundary }
  from './runtime-retention-package-deletion-writer-boundary.mjs';

function packageWriterBoundaryError(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function withCampaignReleasePackageWriterBoundary({
  runtimeRoot,
  packagePath,
  artifactRepositoryFactory = null,
  packageDeletionWriterBoundary = null,
  packageDeletionWriterOperationId = null,
}, operation) {
  if (typeof runtimeRoot !== 'string' || !runtimeRoot.trim()
    || typeof packagePath !== 'string' || !packagePath.trim()) {
    packageWriterBoundaryError('campaign_release_package_writer_boundary_input_invalid');
  }
  const root = path.resolve(runtimeRoot);
  const selectedPackagePath = path.resolve(packagePath);
  if (path.dirname(selectedPackagePath) !== path.join(root, 'packages')
    || typeof operation !== 'function') {
    packageWriterBoundaryError('campaign_release_package_writer_boundary_input_invalid');
  }
  const boundary = packageDeletionWriterScopeForArtifactRepositoryFactory(
    artifactRepositoryFactory,
  ) || packageDeletionWriterBoundary
    || createRuntimeRetentionPackageDeletionWriterBoundary({ runtimeRoot: root });
  if (!boundary || typeof boundary.runAsync !== 'function') {
    packageWriterBoundaryError('campaign_release_package_writer_boundary_required');
  }
  const selector = Object.freeze({
    packagePath: selectedPackagePath,
    ...(packageDeletionWriterOperationId
      ? { operationId: packageDeletionWriterOperationId } : {}),
  });
  return boundary.runAsync(selector, async () => operation(selector));
}

export function campaignManuscriptPath(workspace) {
  for (const name of ['main.tex', 'paper.tex', 'manuscript.tex']) {
    if (fs.existsSync(path.join(workspace, name))) return name;
  }
  return 'main.tex';
}

export function fsyncCampaignReleaseFileSync(candidate) {
  const before = fs.lstatSync(candidate, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error('campaign_release_package_file_identity_invalid');
  }
  const descriptor = fs.openSync(
    candidate,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n
      || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('campaign_release_package_file_identity_invalid');
    }
    fs.fchmodSync(descriptor, 0o444);
    fs.fsyncSync(descriptor);
    const completed = fs.fstatSync(descriptor, { bigint: true });
    const selected = fs.lstatSync(candidate, { bigint: true });
    if (!completed.isFile() || completed.nlink !== 1n
      || !selected.isFile() || selected.isSymbolicLink()
      || selected.nlink !== 1n
      || completed.dev !== opened.dev || completed.ino !== opened.ino
      || selected.dev !== completed.dev || selected.ino !== completed.ino
      || (Number(completed.mode) & 0o777) !== 0o444
      || (Number(selected.mode) & 0o777) !== 0o444) {
      throw new Error('campaign_release_package_file_identity_changed');
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

export function campaignReleaseSourceSnapshotOptions({
  workspace,
  campaign,
  campaignResearchSourceSnapshot = null,
} = {}) {
  if (campaignResearchSourceSnapshot) {
    const excludeRoots = (campaignResearchSourceSnapshot.excludedRelativeRoots || [])
      .map((relative) => {
        const candidate = path.resolve(workspace, relative);
        if (!isPathWithin(workspace, candidate) || candidate === workspace) {
          throw new Error('campaign_release_source_snapshot_exclusion_invalid');
        }
        return candidate;
      });
    return Object.freeze({
      excludeRoots,
      excludeNames: [...campaignResearchSourceSnapshot.excludedNames],
    });
  }
  const excludeRoots = (campaign?.spec?.datasetMounts || [])
    .map((mount) => path.resolve(String(mount.source || '')))
    .filter((source) => source !== workspace && isPathWithin(workspace, source));
  return Object.freeze({
    excludeRoots,
    excludeNames: sourceTreeExcludedNames(workspace),
  });
}

export function inspectCampaignReleaseSourceSnapshot(workspace, options) {
  const snapshot = inspectWorkspaceExecutionSnapshot(workspace, options);
  if (snapshot.blockers.length) {
    throw new Error(`campaign_release_source_snapshot_invalid:${snapshot.blockers.join(',')}`);
  }
  return snapshot;
}

export function assertSameCampaignReleaseSourceSnapshot(actual, expected, blocker) {
  if (actual.merkleHash !== expected.merkleHash
    || actual.manifestHash !== expected.manifestHash) {
    throw new Error(blocker);
  }
}

export function buildCampaignReleaseSourceArchiveDefinition({
  paperId,
  sourceSnapshot,
  lineageHash = null,
} = {}) {
  const files = (sourceSnapshot.fileRecords || []).map((record) => {
    if (/(^|\/)(?:\.env|id_rsa|credentials|secrets?)(?:\.|$)/i.test(record.path)) {
      throw new Error(`campaign_release_source_archive_secret_forbidden:${record.path}`);
    }
    return Object.freeze({
      path: record.path,
      role: record.path === 'main.tex' ? 'main_tex' : 'source_file',
      required: true,
    });
  });
  const contractSubject = {
    version: 1,
    kind: 'SourcePackageContract',
    paperId,
    files,
    contractFileHash: lineageHash,
  };
  const sourcePackageContractHash = hashRecord('SourcePackageContract', contractSubject);
  const sourcePackageContract = Object.freeze({
    ...contractSubject,
    status: 'source_package_contract_verified',
    blockers: Object.freeze([]),
    sourcePackageContractHash,
  });
  const rows = sourceSnapshot.fileRecords.map((record) => Object.freeze({
    path: record.path,
    role: record.path === 'main.tex' ? 'main_tex' : 'source_file',
    required: true,
    hash: record.hash,
    bytes: record.bytes,
    identityHash: null,
  }));
  const manifestPayload = {
    version: 1,
    kind: 'ScopedSourceTreeManifest',
    status: 'scoped_source_tree_verified',
    sourcePackageContractHash,
    fileCount: rows.length,
    totalBytes: rows.reduce((total, item) => total + item.bytes, 0),
    rows,
    blockers: Object.freeze([]),
  };
  const sourceTreeManifest = Object.freeze({
    ...manifestPayload,
    sourceTreeManifestHash: hashRecord('ScopedSourceTreeManifest', manifestPayload),
  });
  const archivedMerkleHash = workspaceExecutionMerkleHash(rows);
  if (archivedMerkleHash !== sourceSnapshot.merkleHash) {
    throw new Error('campaign_release_source_archive_merkle_mismatch');
  }
  return Object.freeze({
    sourcePackageContractHash,
    sourceTreeManifestHash: sourceTreeManifest.sourceTreeManifestHash,
    archivedSourceMerkleHash: archivedMerkleHash,
    sourceWorkspaceManifestHash: sourceSnapshot.manifestHash,
    sourcePackageContract,
    sourceTreeManifest,
  });
}

export async function compiledCampaignPdfRecord(workspace, finalCompileNode) {
  const candidates = [
    ...(finalCompileNode?.result?.materializedPaths || []),
    'main.pdf',
    'paper.pdf',
    'manuscript.pdf',
  ].filter((candidate) => /\.pdf$/i.test(String(candidate)));
  for (const relative of candidates) {
    const candidate = path.resolve(workspace, relative);
    if (!isPathWithin(workspace, candidate) || !fs.existsSync(candidate)) continue;
    const record = await fileRecord(workspace, candidate, 'compiled_pdf');
    if (record) return record;
  }
  return null;
}

export function campaignReleasePackageNodeResult(releaseBundle, materializationReceipt) {
  const payload = {
    version: 1,
    kind: 'CampaignReleasePackageResult',
    status: 'campaign_release_prepared',
    campaignId: releaseBundle.campaignId,
    paperId: releaseBundle.paperId,
    packageNodeId: releaseBundle.packageNodeId,
    packageAttemptId: releaseBundle.packageAttemptId,
    campaignPlanHash: releaseBundle.campaignPlanHash,
    campaignReleaseBundleHash: releaseBundle.campaignReleaseBundleHash,
    experimentRegistryHash: releaseBundle.experimentRegistryHash || null,
    empiricalAssertionAuthorityHash: releaseBundle.empiricalAssertionAuthorityHash || null,
    empiricalAssertionUniverseHash: releaseBundle.empiricalAssertionUniverseHash || null,
    empiricalAssertionUniverseBindingHash:
      releaseBundle.empiricalAssertionUniverseBindingHash || null,
    empiricalAssertionManuscriptCorpusHash:
      releaseBundle.empiricalAssertionManuscriptCorpusHash || null,
    advancedNumericalExecutionPlanHash:
      releaseBundle.advancedNumericalExecutionPlanHash || null,
    advancedNumericalCampaignExecutionReceiptHash:
      releaseBundle.advancedNumericalCampaignExecutionReceiptHash || null,
    advancedNumericalCampaignEvidenceHash:
      releaseBundle.advancedNumericalCampaignEvidenceHash || null,
    gpuScientificExecutionPlanHash:
      releaseBundle.gpuScientificExecutionPlanHash || null,
    gpuScientificCampaignExecutionResultHash:
      releaseBundle.gpuScientificCampaignExecutionResultHash || null,
    releaseBundle,
    artifactPackage: releaseBundle.artifactPackage,
    packageVerificationReceipt: releaseBundle.packageVerificationReceipt,
    manuscriptPromotionGate: releaseBundle.manuscriptPromotionGate,
    campaignReleaseBundleMaterializationReceiptHash:
      materializationReceipt.campaignReleaseBundleMaterializationReceiptHash,
    materializationReceipt,
    submitReady: false,
    submissionConsumable: false,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    campaignReleasePackageResultHash:
      hashRecord('CampaignReleasePackageResult', payload),
  });
}
