import fs from 'node:fs';
import path from 'node:path';
import { consumeCampaignReleaseBundleForSubmission } from '../../paper-adapters/submission/campaign-release-bundle-consumer.mjs';
import { exportSubmissionHandoffBundle } from '../../paper-adapters/submission/handoff-bundle-exporter.mjs';
import { assertSubmissionHandoffExportRequest } from '../../paper-domain/submission/submission-handoff-export-request.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  inspectScopedPathSync,
  readScopedFileSync,
} from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import {
  bootstrapSubmissionHandoffExportContext,
} from '../bootstrap/submission-handoff-export-context-bootstrap.mjs';

const REQUEST_MAXIMUM_BYTES = 8 * 1024 * 1024;

function fail(code, blockers = [code]) {
  const error = new Error(code);
  error.code = code;
  error.receipt = Object.freeze({
    version: 1,
    kind: 'SubmissionHandoffExportPreflightReceipt',
    status: 'submission_handoff_export_preflight_blocked',
    blockers: Object.freeze([...new Set(blockers)]),
    localFilesystemMutationPerformed: false,
    networkActionPerformed: false,
    providerActionPerformed: false,
    grantsExecutionPermission: false,
    requiresProviderActionTimeAuthorityRevalidation: true,
    externalActionPerformed: false,
  });
  throw error;
}

function assertOutputParent(outputParent) {
  const inspection = inspectScopedPathSync({
    scopeRoot: outputParent,
    candidate: outputParent,
    expect: 'directory',
    forbidHardlinks: false,
  });
  if (inspection.status !== 'scoped_file_identity_verified') {
    fail(
      'submission_handoff_export_output_parent_invalid',
      inspection.blockers.map((blocker) => (
        `submission_handoff_export_output_parent_invalid:${blocker}`
      )),
    );
  }
}

export function inspectSubmissionHandoffExportLayout({ bundleRoot } = {}) {
  if (!bundleRoot || !path.isAbsolute(bundleRoot)) {
    fail('submission_handoff_export_absolute_bundle_root_required');
  }
  const resolvedBundleRoot = path.resolve(bundleRoot);
  const outputParent = path.dirname(resolvedBundleRoot);
  const bundleName = path.basename(resolvedBundleRoot);
  if (!bundleName || resolvedBundleRoot === outputParent) {
    fail('submission_handoff_export_bundle_root_invalid');
  }
  assertOutputParent(outputParent);
  let existingBundleRoot = false;
  try {
    fs.lstatSync(resolvedBundleRoot);
    existingBundleRoot = true;
    const inspection = inspectScopedPathSync({
      scopeRoot: outputParent,
      candidate: resolvedBundleRoot,
      expect: 'directory',
      forbidHardlinks: false,
    });
    if (inspection.status !== 'scoped_file_identity_verified') {
      fail(
        'submission_handoff_export_existing_bundle_root_invalid',
        inspection.blockers.map((blocker) => (
          `submission_handoff_export_existing_bundle_root_invalid:${blocker}`
        )),
      );
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const layout = {
    version: 1,
    kind: 'SubmissionHandoffExportLayout',
    status: 'submission_handoff_export_layout_ready',
    outputParent,
    bundleRoot: resolvedBundleRoot,
    existingBundleRoot,
    excludedRepositoryRoot: path.join(
      outputParent,
      `.${bundleName}.repository-boundary`,
    ),
    blockers: [],
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...layout,
    submissionHandoffExportLayoutHash: hashRecord(
      'SubmissionHandoffExportLayout',
      layout,
    ),
  });
}

function createPublicationBoundaryRepository(layout) {
  const forbidden = () => {
    throw new Error('submission_handoff_export_unpinned_repository_write_forbidden');
  };
  return Object.freeze({
    version: 1,
    kind: 'SubmissionHandoffExportPublicationBoundaryRepository',
    scopeRoot: layout.outputParent,
    casRoot: layout.excludedRepositoryRoot,
    writeBytes: forbidden,
    writeText: forbidden,
    writeJson: forbidden,
    readManifest: forbidden,
    garbageCollect: forbidden,
  });
}

export function readSubmissionHandoffExportRequestSync({ requestPath } = {}) {
  if (!requestPath) fail('submission_handoff_export_request_path_required');
  const candidate = path.resolve(requestPath);
  const scopeRoot = path.dirname(candidate);
  const read = readScopedFileSync({
    scopeRoot,
    candidate,
    maximumBytes: REQUEST_MAXIMUM_BYTES,
  });
  if (read.status !== 'scoped_file_read_verified') {
    fail(
      'submission_handoff_export_request_read_blocked',
      read.blockers.map((blocker) => (
        `submission_handoff_export_request_read_blocked:${blocker}`
      )),
    );
  }
  try {
    const request = JSON.parse(read.content.toString('utf8'));
    return Object.freeze({
      request,
      requestPath: candidate,
      requestContentHash: read.hash,
      requestReadReceiptHash: read.scopedFileReadReceiptHash,
    });
  } catch {
    fail('submission_handoff_export_request_json_invalid');
  }
}

function buildCommandReceipt({
  campaignId,
  request,
  requestRead = null,
  requestVerification,
  submissionAuthority,
  layout,
  releaseInput,
  bundleExportReceipt,
}) {
  const completed = bundleExportReceipt?.status
    === 'submission_handoff_bundle_exported';
  const payload = {
    version: 1,
    kind: 'SubmissionHandoffExportCommandReceipt',
    status: completed
      ? 'submission_handoff_export_completed'
      : 'submission_handoff_export_blocked',
    campaignId,
    paperId: request.manifest.paperId,
    campaignReleaseBundleHash: releaseInput.campaignReleaseBundleHash,
    submissionHandoffExportRequestHash:
      request.submissionHandoffExportRequestHash,
    submissionHandoffExportRequestVerificationReceiptHash:
      requestVerification
        .submissionHandoffExportRequestVerificationReceiptHash,
    submissionHandoffExportAuthorityHash:
      submissionAuthority.submissionHandoffExportAuthorityHash,
    requestContentHash: requestRead?.requestContentHash || null,
    requestReadReceiptHash: requestRead?.requestReadReceiptHash || null,
    bundleRoot: layout.bundleRoot,
    submissionHandoffExportLayoutHash:
      layout.submissionHandoffExportLayoutHash,
    submissionHandoffBundlePublicationHash:
      bundleExportReceipt?.submissionHandoffBundlePublicationHash || null,
    submissionHandoffBundlePublicationReceiptHash:
      bundleExportReceipt
        ?.submissionHandoffBundlePublicationReceiptHash || null,
    submissionHandoffBundlePublicationRecoveryReceiptHash:
      bundleExportReceipt
        ?.submissionHandoffBundlePublicationRecoveryReceiptHash || null,
    recoveredExistingPublication:
      bundleExportReceipt?.recoveredExistingPublication === true,
    stagedSubmissionHandoffBundleVerificationReceiptHash:
      bundleExportReceipt
        ?.stagedSubmissionHandoffBundleVerificationReceiptHash || null,
    submissionHandoffAuthorityLineageHash:
      bundleExportReceipt?.submissionHandoffAuthorityLineageHash || null,
    submissionHandoffAuthorityFreshnessReceiptHash:
      bundleExportReceipt
        ?.submissionHandoffAuthorityFreshnessReceiptHash || null,
    bundleExportReceipt,
    blockers: completed ? [] : [...(bundleExportReceipt?.blockers || [
      'submission_handoff_bundle_export_blocked',
    ])],
    localFilesystemMutationPerformed:
      bundleExportReceipt?.localFilesystemMutationPerformed === true,
    networkActionPerformed: false,
    providerActionPerformed: false,
    grantsExecutionPermission: false,
    requiresProviderActionTimeAuthorityRevalidation: true,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    submissionHandoffExportCommandReceiptHash: hashRecord(
      'SubmissionHandoffExportCommandReceipt',
      payload,
    ),
  });
}

export async function exportVerifiedCurrentReleaseSubmissionHandoff({
  root,
  runtimeRoot,
  campaignId,
  bundleRoot,
  request,
  requestRead = null,
  releaseInput,
  submissionAuthority,
  submissionAuthorityFreshnessQuery,
  bundleExporter = exportSubmissionHandoffBundle,
} = {}) {
  const layout = inspectSubmissionHandoffExportLayout({ bundleRoot });
  const releaseAuthority = releaseInput?.releaseAuthority;
  const releaseBundle = releaseInput?.packageResult?.releaseBundle;
  if (!releaseAuthority || !releaseBundle) {
    fail('submission_handoff_export_verified_release_required');
  }
  const requestVerification = assertSubmissionHandoffExportRequest(request, {
    campaignId,
    paperId: releaseAuthority.paperId,
    artifactPackageHash: releaseInput.artifactPackageHash,
    manuscriptPromotionGateHash: releaseInput.manuscriptPromotionGateHash,
    submissionAuthority,
  });
  if (typeof submissionAuthorityFreshnessQuery !== 'function') {
    fail('submission_handoff_export_authority_freshness_query_required');
  }
  const artifactRepository = createPublicationBoundaryRepository(layout);
  const artifactBaseRoot = releaseBundle.packageOutput?.artifactBaseRoot
    || releaseBundle.packageOutput?.packageDir
    || runtimeRoot;
  const bundleExportReceipt = await bundleExporter({
    artifactRepository,
    bundleRoot: layout.bundleRoot,
    artifactPackage: releaseInput.artifactPackage,
    packageVerificationReceipt:
      releaseInput.packageResult.packageVerificationReceipt,
    manifest: request.manifest,
    handoff: request.handoff,
    replayGuard: request.replayGuard,
    reviewedSubmitPreflightPacket:
      request.reviewedSubmitPreflightPacket,
    dispatchAuthorization: request.dispatchAuthorization,
    submissionDecisionPacket: request.submissionDecisionPacket,
    artifactBaseRoot,
    artifactScopeRoots: [
      artifactBaseRoot,
      root,
      runtimeRoot,
    ].filter(Boolean),
    campaignReleaseBundle: releaseBundle,
    campaignReleaseAuthority: releaseAuthority,
    campaignReleaseVerificationReceipt: releaseInput.verificationReceipt,
    submissionAuthority,
    submissionAuthorityFreshnessQuery,
    submissionHandoffExportRequest: request,
    submissionHandoffExportRequestVerificationReceipt: requestVerification,
  });
  return buildCommandReceipt({
    campaignId,
    request,
    requestRead,
    requestVerification,
    submissionAuthority,
    layout,
    releaseInput,
    bundleExportReceipt,
  });
}

export async function executeSubmissionHandoffExport({
  root,
  runtimeRoot,
  campaignId,
  bundleRoot,
  requestPath,
  bundleExporter = exportSubmissionHandoffBundle,
  serviceOverrides = {},
} = {}) {
  const normalizedCampaignId = String(campaignId || '').trim();
  if (!normalizedCampaignId) {
    fail('submission_handoff_export_campaign_id_required');
  }
  const layout = inspectSubmissionHandoffExportLayout({ bundleRoot });
  const requestRead = readSubmissionHandoffExportRequestSync({ requestPath });
  const context = bootstrapSubmissionHandoffExportContext({
    root: path.resolve(root),
    runtimeRoot: path.resolve(runtimeRoot),
    serviceOverrides,
  });
  try {
    const submissionAuthority = context.services
      .submissionHandoffExportAuthorityQuery
      .getCurrentReviewedSubmissionAuthority({
        paperId: requestRead.request?.manifest?.paperId,
        dispatchAuthorizationHash: requestRead.request
          ?.dispatchAuthorization?.submissionDispatchAuthorizationHash,
      });
    if (!submissionAuthority) {
      fail('submission_handoff_export_persisted_authority_missing');
    }
    if (submissionAuthority.status
        !== 'submission_handoff_export_authority_ready') {
      fail(
        'submission_handoff_export_persisted_authority_blocked',
        submissionAuthority.blockers,
      );
    }
    const releaseInput = consumeCampaignReleaseBundleForSubmission({
      releaseAuthorityQuery: context.services.campaignReleaseQuery,
      campaignId: normalizedCampaignId,
      expected: {
        campaignId: normalizedCampaignId,
        paperId: requestRead.request.manifest.paperId,
      },
      runtimeRoot: path.resolve(runtimeRoot),
    });
    return await exportVerifiedCurrentReleaseSubmissionHandoff({
      root: path.resolve(root),
      runtimeRoot: path.resolve(runtimeRoot),
      campaignId: normalizedCampaignId,
      bundleRoot: layout.bundleRoot,
      request: requestRead.request,
      requestRead,
      releaseInput,
      submissionAuthority,
      submissionAuthorityFreshnessQuery: () => context.services
        .submissionHandoffExportAuthorityQuery
        .getCurrentReviewedSubmissionAuthority({
          paperId: submissionAuthority.paperId,
          dispatchAuthorizationHash:
            submissionAuthority.dispatchAuthorizationHash,
        }),
      bundleExporter,
    });
  } finally {
    context.services.persistenceSession.close?.();
  }
}
