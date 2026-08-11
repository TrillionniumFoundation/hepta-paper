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

export function campaignManuscriptPath(workspace) {
  for (const name of ['main.tex', 'paper.tex', 'manuscript.tex']) {
    if (fs.existsSync(path.join(workspace, name))) return name;
  }
  return 'main.tex';
}

export function fsyncCampaignReleaseFileSync(candidate) {
  const descriptor = fs.openSync(
    candidate,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    fs.fsyncSync(descriptor);
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
