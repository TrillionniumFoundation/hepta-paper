import path from 'node:path';
import { assertArtifactRepository } from '../../paper-ports/artifact-repository-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { verifyCampaignReleaseBundleForSubmission } from './campaign-release-bundle-consumer.mjs';
import { captureSubmissionHandoffArtifactRepositoryBoundary } from './handoff-artifact-repository-boundary.mjs';
import {
  assertSubmissionHandoffAuthorityLineage,
  assertSubmissionHandoffManifestWriteSync,
  sealAndVerifySubmissionHandoffBundleSync,
  verifySubmissionHandoffBundle,
} from './handoff-bundle-integrity.mjs';
import {
  createSubmissionHandoffDetachedRecordsCapsule,
} from './handoff-bundle-detached-records.mjs';
import {
  verifyDetachedSubmissionHandoffBundle,
} from './handoff-bundle-detached-verifier.mjs';
import { createSubmissionHandoffBundlePinnedWriter } from './handoff-bundle-pinned-writer.mjs';
import { assertSubmissionHandoffExportArtifactInventory, assertSubmissionHandoffExportResourcePlan, blockedSubmissionHandoffExportReceipt as blockedExportReceipt, submissionHandoffArtifactBundlePath } from './handoff-bundle-resource-plan.mjs';
import {
  abandonSubmissionHandoffBundlePublicationSync,
  createSubmissionHandoffBundlePublication,
  createSubmissionHandoffBundlePublicationLineage,
  publishSubmissionHandoffBundle,
} from './handoff-bundle-publication-repository.mjs';
import {
  copyInspectedSealedPackageOutputFiles,
  copyVerifiedSealedPackageOutputFilesForHandoff,
  inspectSealedPackageOutputFilesSync,
} from './handoff-bundle-sealed-package-copy.mjs';
import {
  createSubmissionHandoffRecoveryBinding,
  reconcileSubmissionHandoffBundlePublication,
  submissionHandoffRequestRecoveryBindingHash,
} from './handoff-bundle-recovery.mjs';
import {
  completeSubmissionHandoffBundlePublicationJournal,
  createRecoverableSubmissionHandoffBundlePublicationJournal,
} from './handoff-bundle-publication-journal-repository.mjs';
import { snapshotSubmissionHandoffExportInput } from './submission-handoff-export-input-snapshot.mjs';
export { copyVerifiedSealedPackageOutputFilesForHandoff,
  verifyDetachedSubmissionHandoffBundle, verifySubmissionHandoffBundle };
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const AUTHORITY_STABLE_FIELDS = Object.freeze([
  'authorizationConsumptionHash',
  'deadLetterCount',
  'dispatchAuthorizationHash',
  'messageId',
  'paperId',
  'payloadBindingHash',
  'providerCapabilityExpiresAt',
  'providerCapabilityHash',
  'providerCapabilityValidFrom',
  'releaseLockHash',
  'responseCount',
  'rowBindingHash',
]);

function normalizePersistedSubmissionAuthority(
  authority,
  { dispatchAuthorizationHash, paperId } = {},
) {
  const authorityPayload = { ...(authority || {}) };
  delete authorityPayload.submissionHandoffExportAuthorityHash;
  if (authority?.version !== 1
    || authority?.kind !== 'PersistedSubmissionHandoffExportAuthority'
    || authority?.status !== 'submission_handoff_export_authority_ready'
    || authority?.readOnly !== true
    || authority?.externalActionPerformed !== false
    || !Array.isArray(authority?.blockers) || authority.blockers.length !== 0
    || authority?.paperId !== paperId
    || authority?.dispatchAuthorizationHash !== dispatchAuthorizationHash
    || !SHA256.test(String(authority?.submissionHandoffExportAuthorityHash || ''))
    || authority.submissionHandoffExportAuthorityHash !== hashRecord(
      'PersistedSubmissionHandoffExportAuthority',
      authorityPayload,
    )) {
    throw new Error('handoff_submission_authority_record_invalid');
  }
  const lineagePayload = {
    version: 1,
    kind: 'SubmissionHandoffAuthorityLineage',
    messageId: authority.messageId,
    paperId: authority.paperId,
    dispatchAuthorizationHash: authority.dispatchAuthorizationHash,
    submissionHandoffExportAuthorityHash:
      authority.submissionHandoffExportAuthorityHash,
    rowBindingHash: authority.rowBindingHash,
    authorizationConsumptionHash: authority.authorizationConsumptionHash,
    releaseLockHash: authority.releaseLockHash,
    payloadBindingHash: authority.payloadBindingHash,
    providerCapabilityHash: authority.providerCapabilityHash,
    providerCapabilityValidFrom: authority.providerCapabilityValidFrom,
    providerCapabilityExpiresAt: authority.providerCapabilityExpiresAt,
    responseCount: authority.responseCount,
    deadLetterCount: authority.deadLetterCount,
    observedAt: authority.observedAt,
    grantsExecutionPermission: false,
    requiresProviderActionTimeAuthorityRevalidation: true,
  };
  const lineage = Object.freeze({
    ...lineagePayload,
    submissionHandoffAuthorityLineageHash: hashRecord(
      'SubmissionHandoffAuthorityLineage',
      lineagePayload,
    ),
  });
  assertSubmissionHandoffAuthorityLineage(lineage, {
    dispatchAuthorizationHash,
    paperId,
  });
  return lineage;
}

function sameStableAuthority(left, right) {
  return AUTHORITY_STABLE_FIELDS.every((field) => left[field] === right[field]);
}

async function verifyCurrentSubmissionAuthority({
  baselineAuthority,
  baselineLineage,
  dispatchAuthorizationHash,
  paperId,
  submissionAuthorityFreshnessQuery,
}) {
  const queryResult = await submissionAuthorityFreshnessQuery(Object.freeze({
    baselineAuthority,
    baselineLineage,
    dispatchAuthorizationHash,
    paperId,
  }));
  const currentAuthority = queryResult?.currentAuthority || queryResult;
  const currentLineage = normalizePersistedSubmissionAuthority(currentAuthority, {
    dispatchAuthorizationHash,
    paperId,
  });
  if (!sameStableAuthority(baselineLineage, currentLineage)
    || Date.parse(currentLineage.observedAt) < Date.parse(baselineLineage.observedAt)) {
    throw new Error('handoff_submission_authority_changed_before_publication');
  }
  const providedReceiptHash = queryResult?.currentAuthority
    ? queryResult.receiptHash || null : null;
  if (queryResult?.currentAuthority
    && (queryResult.status !== 'submission_handoff_authority_fresh'
      || queryResult.baselineAuthorityHash
        !== baselineLineage.submissionHandoffExportAuthorityHash
      || queryResult.currentAuthorityHash
        !== currentLineage.submissionHandoffExportAuthorityHash
      || queryResult.observedAt !== currentLineage.observedAt
      || queryResult.grantsExecutionPermission !== false)) {
    throw new Error('handoff_submission_authority_freshness_receipt_invalid');
  }
  if (providedReceiptHash !== null && !SHA256.test(String(providedReceiptHash))) {
    throw new Error('handoff_submission_authority_freshness_receipt_invalid');
  }
  const payload = {
    version: 1,
    kind: 'SubmissionHandoffAuthorityFreshnessReceipt',
    status: 'submission_handoff_authority_fresh',
    baselineAuthorityHash:
      baselineLineage.submissionHandoffExportAuthorityHash,
    currentAuthorityHash: currentLineage.submissionHandoffExportAuthorityHash,
    baselineObservedAt: baselineLineage.observedAt,
    currentObservedAt: currentLineage.observedAt,
    submissionHandoffAuthorityLineageHash:
      baselineLineage.submissionHandoffAuthorityLineageHash,
    providedFreshnessReceiptHash: providedReceiptHash,
    grantsExecutionPermission: false,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    submissionHandoffAuthorityFreshnessReceiptHash: hashRecord(
      'SubmissionHandoffAuthorityFreshnessReceipt',
      payload,
    ),
  });
}

function resolveArtifact(artifact, baseRoot, scopeRoots) {
  const candidate = path.resolve(path.isAbsolute(artifact.path) ? artifact.path : path.join(baseRoot, artifact.path));
  const scopeRoot = scopeRoots.find((root) => isPathWithin(root, candidate));
  return { candidate, scopeRoot: scopeRoot || null };
}

export async function exportSubmissionHandoffBundle(options = {}) {
  const { artifactRepository, submissionAuthorityFreshnessQuery = null } = options;
  assertArtifactRepository(artifactRepository);
  const artifactRepositoryBoundary =
    captureSubmissionHandoffArtifactRepositoryBoundary(artifactRepository);
  const {
    bundleRoot,
    artifactPackage,
    packageVerificationReceipt,
    manifest,
    handoff,
    replayGuard,
    reviewedSubmitPreflightPacket,
    dispatchAuthorization,
    submissionDecisionPacket,
    artifactBaseRoot,
    artifactScopeRoots = [],
    campaignReleaseBundle = null,
    campaignReleaseAuthority = null,
    campaignReleaseIntegrationReceipt = null,
    campaignReleasePackageResult = null,
    campaignReleaseVerificationReceipt = null,
    submissionAuthority = null,
    submissionHandoffExportRequest = null,
    submissionHandoffExportRequestVerificationReceipt = null,
  } = snapshotSubmissionHandoffExportInput(options);
  const blockers = [];
  let releaseRuntimeRoot = null;
  if (campaignReleaseBundle) {
    const releaseRoot = path.resolve(campaignReleaseBundle.packageOutput?.releaseRoot || '.');
    releaseRuntimeRoot = artifactScopeRoots.map((item) => path.resolve(item)).find((item) => isPathWithin(item, releaseRoot)) || null;
    const releaseVerification = verifyCampaignReleaseBundleForSubmission({
      releaseAuthority: campaignReleaseAuthority,
      releaseBundle: campaignReleaseBundle,
      runtimeRoot: releaseRuntimeRoot,
      sourceScopeRoots: [artifactBaseRoot, ...artifactScopeRoots].filter(Boolean),
    });
    if (releaseVerification.status !== 'submission_campaign_release_verified') blockers.push(...releaseVerification.blockers);
    if (campaignReleaseBundle.artifactPackageHash !== artifactPackage?.artifactPackageHash) blockers.push('campaign_release_handoff_artifact_package_mismatch');
    if (campaignReleaseBundle.packageVerificationReceiptHash !== packageVerificationReceipt?.packageVerificationReceiptHash) blockers.push('campaign_release_handoff_package_verification_mismatch');
  }
  if (!bundleRoot) blockers.push('handoff_bundle_root_missing');
  if (artifactPackage?.submitReady !== true || !artifactPackage?.artifactPackageHash) blockers.push('artifact_package_not_submit_ready');
  if (packageVerificationReceipt?.status !== 'package_verification_passed') blockers.push('package_verification_not_ready');
  if (packageVerificationReceipt?.verifiedArtifactPackageHash !== (artifactPackage?.candidateArtifactPackageHash || artifactPackage?.artifactPackageHash)) blockers.push('package_verification_artifact_package_mismatch');
  if (artifactPackage?.packageVerificationReceiptHash !== packageVerificationReceipt?.packageVerificationReceiptHash) blockers.push('artifact_package_verification_receipt_mismatch');
  if (manifest?.status !== 'ready_for_adapter') blockers.push('submission_manifest_not_ready');
  if (manifest?.payload?.artifactPackageHash !== artifactPackage?.artifactPackageHash) blockers.push('manifest_artifact_package_mismatch');
  if (handoff?.status !== 'dry_run_ready') blockers.push('handoff_envelope_not_ready');
  if (handoff?.manifestHash !== manifest?.manifestHash) blockers.push('handoff_manifest_mismatch');
  if (replayGuard?.status !== 'dry_run_replay_allowed') blockers.push('submission_replay_guard_not_ready');
  if (replayGuard?.manifestHash !== manifest?.manifestHash) blockers.push('replay_guard_manifest_mismatch');
  if (reviewedSubmitPreflightPacket?.status !== 'reviewed_submit_preflight_ready_for_external_executor') {
    blockers.push('reviewed_submit_preflight_not_ready');
  }
  if (dispatchAuthorization?.status !== 'submission_dispatch_authorization_ready') blockers.push('dispatch_authorization_not_ready');
  if (dispatchAuthorization?.artifactPackageHash !== artifactPackage?.artifactPackageHash) blockers.push('dispatch_artifact_package_mismatch');
  if (dispatchAuthorization?.preflightHash !== reviewedSubmitPreflightPacket?.reviewedSubmitPreflightPacketHash) blockers.push('dispatch_preflight_mismatch');
  if (dispatchAuthorization?.outboxHash !== reviewedSubmitPreflightPacket?.outboxHash) blockers.push('dispatch_outbox_mismatch');
  if (submissionDecisionPacket?.status !== 'reviewed_submission_decision_verified') blockers.push('reviewed_submission_decision_not_verified');
  if (dispatchAuthorization?.reviewedSubmissionDecisionPacketHash !== submissionDecisionPacket?.reviewedSubmissionDecisionPacketHash) blockers.push('dispatch_submission_decision_mismatch');
  let persistedSubmissionAuthority = null;
  if (submissionAuthority) {
    if (typeof submissionAuthorityFreshnessQuery !== 'function') {
      blockers.push('handoff_submission_authority_freshness_query_required');
    }
    try {
      persistedSubmissionAuthority = normalizePersistedSubmissionAuthority(
        submissionAuthority,
        {
          dispatchAuthorizationHash:
            dispatchAuthorization?.submissionDispatchAuthorizationHash,
          paperId: manifest?.paperId,
        },
      );
    } catch (error) {
      blockers.push(`handoff_submission_authority_lineage_invalid:${String(
        error?.message || 'authority_invalid',
      )}`);
    }
  } else if (submissionAuthorityFreshnessQuery) {
    blockers.push('handoff_submission_authority_baseline_required');
  }
  const artifacts = artifactPackage?.artifacts || [];
  try {
    assertSubmissionHandoffExportArtifactInventory(artifacts);
  } catch (error) {
    blockers.push(`handoff_bundle_resource_plan_invalid:${String(
      error?.message || 'resource_limit_exceeded',
    )}`);
  }
  if (blockers.length) return blockedExportReceipt(blockers, manifest?.paperId, false);
  let detachedRecordsCapsule = null;
  const detachedRecordsRequested = Boolean(
    submissionHandoffExportRequest
      || submissionHandoffExportRequestVerificationReceipt,
  );
  if (detachedRecordsRequested) {
    try {
      detachedRecordsCapsule =
        createSubmissionHandoffDetachedRecordsCapsule({
          artifactPackage,
          campaignReleaseBundle,
          campaignReleaseIntegrationReceipt,
          campaignReleaseMaterializationReceipt:
            campaignReleaseAuthority?.materializationReceipt || null,
          campaignReleasePackageResult,
          campaignReleasePromotionReceipt:
            campaignReleaseAuthority?.promotionReceipt || null,
          campaignReleaseVerificationReceipt,
          packageVerificationReceipt,
          submissionAuthority,
          submissionHandoffExportRequest,
          submissionHandoffExportRequestVerificationReceipt,
        });
    } catch (error) {
      blockers.push(`handoff_detached_records_invalid:${String(
        error?.message || 'records_invalid',
      )}`);
    }
  }
  const baseRoot = path.resolve(artifactBaseRoot || '.');
  const scopes = [...new Set([baseRoot, ...artifactScopeRoots].filter(Boolean).map((root) => path.resolve(root)))];
  const artifactReads = [];
  for (const [index, artifact] of artifacts.entries()) {
    if (!artifact?.path || !artifact?.hash) { blockers.push(`handoff_artifact_binding_missing:${index}`); continue; }
    const { candidate, scopeRoot } = resolveArtifact(artifact, baseRoot, scopes);
    if (!scopeRoot) { blockers.push(`handoff_artifact_outside_scope:${artifact.path}`); continue; }
    const read = readScopedFileSync({ scopeRoot, candidate });
    if (read.status !== 'scoped_file_read_verified') {
      blockers.push(`handoff_artifact_read_blocked:${artifact.path}`);
      continue;
    }
    if (read.hash !== artifact.hash) blockers.push(`handoff_artifact_hash_mismatch:${artifact.path}`);
    if (artifact.sizeBytes !== null && artifact.sizeBytes !== undefined && Number(artifact.sizeBytes) !== read.bytes) {
      blockers.push(`handoff_artifact_size_mismatch:${artifact.path}`);
    }
    artifactReads.push({ index, artifact, read });
  }
  let sealedPackageInspection = null;
  if (campaignReleaseBundle) {
    try {
      sealedPackageInspection = inspectSealedPackageOutputFilesSync({
        packageOutput: campaignReleaseBundle.packageOutput,
        runtimeRoot: releaseRuntimeRoot,
      });
    } catch (error) {
      blockers.push(`handoff_sealed_package_output_invalid:${String(error?.message || 'verification_failed')}`);
    }
  }
  if (!blockers.length) {
    try {
      assertSubmissionHandoffExportResourcePlan({
        artifactReads, detachedRecordsCapsule, sealedPackageInspection,
      });
    } catch (error) {
      blockers.push(`handoff_bundle_resource_plan_invalid:${String(
        error?.message || 'resource_limit_exceeded',
      )}`);
    }
  }
  if (blockers.length) return blockedExportReceipt(blockers, manifest?.paperId, false);
  const expectedRecoveryBinding = createSubmissionHandoffRecoveryBinding({
    artifactPackage,
    artifactReads,
    campaignReleaseBundle,
    dispatchAuthorization,
    handoff,
    manifest,
    packageVerificationReceipt,
    persistedSubmissionAuthority,
    replayGuard,
    reviewedSubmitPreflightPacket,
    sealedPackageInspection,
    submissionDecisionPacket,
  });
  const expectedRecoveryBindingHash = submissionHandoffRequestRecoveryBindingHash(
    expectedRecoveryBinding,
  );
  const reconciliation = await reconcileSubmissionHandoffBundlePublication({
    artifactRepository: artifactRepositoryBoundary,
    baselineAuthority: submissionAuthority,
    bundleRoot,
    expectedRecoveryBinding,
    submissionAuthorityFreshnessQuery,
    verifyCurrentAuthority: verifyCurrentSubmissionAuthority,
  });
  if (reconciliation.status
      === 'submission_handoff_bundle_reconciliation_blocked') {
    return blockedExportReceipt(
      [reconciliation.blocker],
      manifest?.paperId,
      reconciliation.localFilesystemMutationPerformed,
    );
  }
  if (reconciliation.status
      === 'submission_handoff_bundle_reconciliation_recovered') {
    return reconciliation.receipt;
  }
  let publicationJournalState = reconciliation.publicationJournalState;
  let publication;
  let bundleWriter;
  try {
    publication = createSubmissionHandoffBundlePublication({
      finalRoot: bundleRoot,
      repositoryScopeRoot: artifactRepositoryBoundary.scopeRoot,
      repositoryCasRoot: artifactRepositoryBoundary.casRoot,
    });
    bundleWriter = createSubmissionHandoffBundlePinnedWriter({
      bundleRoot: publication.stagingRoot,
      expectedRootIdentity: publication.stagingIdentity,
    });
  } catch (error) {
    if (publication) {
      try { abandonSubmissionHandoffBundlePublicationSync(publication); } catch {}
    }
    return blockedExportReceipt([
      `handoff_bundle_publication_reservation_invalid:${String(
        error?.message || 'reservation_failed',
      )}`,
    ], manifest?.paperId, reconciliation.localFilesystemMutationPerformed === true
      || error?.localFilesystemMutationPerformed === true);
  }
  const reservedBundleRoot = publication.stagingRoot;
  const blockReserved = (reasons) => {
    try { abandonSubmissionHandoffBundlePublicationSync(publication); } catch {}
    return blockedExportReceipt(reasons, manifest?.paperId, true);
  };
  const copiedArtifacts = [];
  try {
    for (const { index, artifact, read } of artifactReads) {
      const target = path.join(reservedBundleRoot,
        submissionHandoffArtifactBundlePath(artifact, index));
      const write = await bundleWriter.writeBytes(target, read.content, { role: `submission_handoff:${artifact.role || 'artifact'}` });
      if (write.hash !== read.hash || Number(write.bytes) !== Number(read.bytes)) {
        throw new Error(
          `handoff_artifact_copy_write_identity_mismatch:${artifact.path || 'unknown'}`,
        );
      }
      copiedArtifacts.push({
        id: artifact.id || null,
        role: artifact.role || null,
        sourcePath: artifact.path,
        bundlePath: path.relative(reservedBundleRoot, target).replace(/\\/g, '/'),
        hash: artifact.hash,
        bytes: read.bytes,
        sourceReadReceiptHash: read.scopedFileReadReceiptHash,
        writeReceiptHash: write.writeReceiptHash,
      });
    }
  } catch (error) {
    return blockReserved([
      `handoff_artifact_copy_invalid:${String(error?.message || 'verification_failed')}`,
    ]);
  }
  let sealedPackageCopy = null;
  if (sealedPackageInspection) {
    try {
      sealedPackageCopy = await copyInspectedSealedPackageOutputFiles({
        artifactRepository: bundleWriter,
        bundleRoot: reservedBundleRoot,
        inspection: sealedPackageInspection,
      });
    } catch (error) {
      return blockReserved([
        `handoff_sealed_package_copy_invalid:${String(error?.message || 'verification_failed')}`,
      ]);
    }
  }
  const detachedRecordWrites = [];
  if (detachedRecordsCapsule) {
    try {
      for (const document of detachedRecordsCapsule.documents) {
        const write = await bundleWriter.writeBytes(
          path.join(reservedBundleRoot, document.path),
          document.bytes,
          { role: `submission_handoff_detached_record:${document.role}` },
        );
        if (write.hash !== document.descriptor.contentHash
          || Number(write.bytes) !== Number(document.descriptor.bytes)) {
          throw new Error(
            `handoff_detached_record_write_identity_mismatch:${document.role}`,
          );
        }
        detachedRecordWrites.push(Object.freeze({
          role: document.role,
          writeReceiptHash: write.writeReceiptHash,
        }));
      }
    } catch (error) {
      return blockReserved([
        `handoff_detached_record_copy_invalid:${String(
          error?.message || 'verification_failed',
        )}`,
      ]);
    }
  }
  if (campaignReleaseBundle) {
    const postCopyReleaseVerification =
      verifyCampaignReleaseBundleForSubmission({
        releaseAuthority: campaignReleaseAuthority,
        releaseBundle: campaignReleaseBundle,
        runtimeRoot: releaseRuntimeRoot,
        sourceScopeRoots: [artifactBaseRoot, ...artifactScopeRoots]
          .filter(Boolean),
      });
    if (postCopyReleaseVerification.status
        !== 'submission_campaign_release_verified') {
      return blockReserved(postCopyReleaseVerification.blockers);
    }
  }
  const publicationLineage =
    createSubmissionHandoffBundlePublicationLineage(publication);
  const bundleManifest = {
    version: 1,
    kind: 'SubmissionHandoffBundleManifest',
    paperId: manifest.paperId,
    taskKey: manifest.taskKey,
    artifactPackageHash: artifactPackage.artifactPackageHash,
    packageVerificationReceiptHash: packageVerificationReceipt.packageVerificationReceiptHash,
    manifestHash: manifest.manifestHash,
    handoffEnvelopeHash: handoff.envelopeHash,
    replayGuardHash: replayGuard.submissionReplayGuardHash,
    reviewedSubmitPreflightPacketHash: reviewedSubmitPreflightPacket.reviewedSubmitPreflightPacketHash,
    dispatchAuthorizationHash: dispatchAuthorization.submissionDispatchAuthorizationHash,
    persistedSubmissionAuthority,
    grantsExternalExecutionPermission: false,
    requiresCurrentAuthorityRevalidation: true,
    submissionHandoffBundlePublicationLineage: publicationLineage,
    provider: dispatchAuthorization.provider,
    accountId: dispatchAuthorization.accountId,
    nonce: dispatchAuthorization.nonce,
    reviewedSubmissionDecisionPacketHash: submissionDecisionPacket.reviewedSubmissionDecisionPacketHash,
    campaignReleaseBundleHash: campaignReleaseBundle?.campaignReleaseBundleHash || null,
    detachedRecordWriteReceiptHashes:
      detachedRecordWrites.map((item) => item.writeReceiptHash),
    ...(detachedRecordsCapsule?.manifestBinding || {}),
    sealedPackageOutput: sealedPackageCopy ? {
      immutableCampaignPackageOutputHash:
        sealedPackageCopy.immutableCampaignPackageOutputHash,
      fileSetHash: sealedPackageCopy.fileSetHash,
      fileCount: sealedPackageCopy.fileCount,
      files: sealedPackageCopy.files,
    } : null,
    submissionMetadata: submissionDecisionPacket.metadata,
    artifacts: copiedArtifacts,
    artifactCount: copiedArtifacts.length,
    sealedPackageFileCount: sealedPackageCopy?.fileCount || 0,
    externalActionPerformed: false,
  };
  const submissionHandoffBundleManifestHash = hashRecord('SubmissionHandoffBundleManifest', bundleManifest);
  const detachedTrustedAnchor = detachedRecordsCapsule
    ? Object.freeze({
      version: 1,
      kind: 'SubmissionHandoffDetachedTrustedAnchor',
      submissionHandoffBundleManifestHash,
      submissionHandoffExportRequestHash:
        submissionHandoffExportRequest.submissionHandoffExportRequestHash,
      submissionHandoffExportAuthorityHash:
        submissionAuthority.submissionHandoffExportAuthorityHash,
      campaignReleaseBundleHash:
        campaignReleaseBundle.campaignReleaseBundleHash,
      dispatchAuthorizationHash:
        dispatchAuthorization.submissionDispatchAuthorizationHash,
    })
    : null;
  const manifestDocument = structuredClone({
    ...bundleManifest,
    submissionHandoffBundleManifestHash,
  });
  try {
    assertSubmissionHandoffExportResourcePlan({ artifactReads, controlDocument:
      manifestDocument, detachedRecordsCapsule, sealedPackageInspection });
  } catch (error) {
    return blockReserved([`handoff_bundle_resource_plan_invalid:${String(
      error?.message || 'resource_limit_exceeded')}`]);
  }
  let manifestWrite;
  try {
    manifestWrite = await bundleWriter.writeJson(
      path.join(reservedBundleRoot, 'SUBMISSION_HANDOFF_MANIFEST.json'),
      structuredClone(manifestDocument),
      { role: 'submission_handoff_manifest' },
    );
    assertSubmissionHandoffManifestWriteSync({
      bundleRoot: reservedBundleRoot,
      manifestDocument,
      manifestWrite,
    });
  } catch (error) {
    return blockReserved([
      `handoff_manifest_write_invalid:${String(error?.message || 'write_failed')}`,
    ]);
  }
  if (campaignReleaseBundle) {
    const postManifestReleaseVerification =
      verifyCampaignReleaseBundleForSubmission({
        releaseAuthority: campaignReleaseAuthority,
        releaseBundle: campaignReleaseBundle,
        runtimeRoot: releaseRuntimeRoot,
        sourceScopeRoots: [artifactBaseRoot, ...artifactScopeRoots]
          .filter(Boolean),
      });
    if (postManifestReleaseVerification.status
        !== 'submission_campaign_release_verified') {
      return blockReserved(postManifestReleaseVerification.blockers);
    }
  }
  try {
    sealAndVerifySubmissionHandoffBundleSync({
      bundleRoot: reservedBundleRoot,
      manifestDocument,
    });
  } catch (error) {
    return blockReserved([
      `handoff_bundle_sealing_invalid:${String(
        error?.message || 'verification_failed',
      )}`,
    ]);
  }
  const stagedVerification = verifySubmissionHandoffBundle({
    bundleRoot: reservedBundleRoot,
    submissionHandoffBundleManifestHash,
  });
  if (stagedVerification.status !== 'submission_handoff_bundle_verified') {
    return blockReserved(stagedVerification.blockers);
  }
  const stagedDetachedVerification = detachedTrustedAnchor
    ? verifyDetachedSubmissionHandoffBundle({
      bundleRoot: reservedBundleRoot,
      trustedAnchor: detachedTrustedAnchor,
    })
    : null;
  if (stagedDetachedVerification
      && !stagedDetachedVerification.internalLineageVerified) {
    return blockReserved(stagedDetachedVerification.blockers);
  }
  let authorityFreshnessReceipt = null;
  if (persistedSubmissionAuthority) {
    try {
      authorityFreshnessReceipt = await verifyCurrentSubmissionAuthority({
        baselineAuthority: submissionAuthority,
        baselineLineage: persistedSubmissionAuthority,
        dispatchAuthorizationHash:
          dispatchAuthorization.submissionDispatchAuthorizationHash,
        paperId: manifest.paperId,
        submissionAuthorityFreshnessQuery,
      });
    } catch (error) {
      return blockReserved([
        `handoff_submission_authority_freshness_invalid:${String(
          error?.message || 'freshness_failed',
        )}`,
      ]);
    }
  }
  let publicationReceipt;
  try {
    publicationJournalState = createRecoverableSubmissionHandoffBundlePublicationJournal({ publication,
      submissionHandoffRequestRecoveryBindingHash: expectedRecoveryBindingHash,
      submissionHandoffBundleManifestHash,
      submissionHandoffBundlePublicationLineageHash:
        publicationLineage.submissionHandoffBundlePublicationLineageHash,
    });
  } catch (error) {
    return blockedExportReceipt([
      `handoff_bundle_publication_journal_invalid:${String(
        error?.message || 'journal_create_failed',
      )}`,
    ], manifest?.paperId, true);
  }
  try {
    publicationReceipt = publishSubmissionHandoffBundle(publication);
  } catch (error) {
    return blockedExportReceipt([
      `handoff_bundle_publication_invalid:${String(
        error?.message || 'publication_failed',
      )}`,
    ], manifest?.paperId, true);
  }
  const verification = verifySubmissionHandoffBundle({
    bundleRoot: publication.finalRoot,
    submissionHandoffBundleManifestHash,
  });
  if (verification.status !== 'submission_handoff_bundle_verified') {
    return blockedExportReceipt(verification.blockers, manifest?.paperId, true);
  }
  const detachedVerification = detachedTrustedAnchor
    ? verifyDetachedSubmissionHandoffBundle({
      bundleRoot: publication.finalRoot,
      trustedAnchor: detachedTrustedAnchor,
    })
    : null;
  if (detachedVerification
      && !detachedVerification.internalLineageVerified) {
    return blockedExportReceipt(
      detachedVerification.blockers,
      manifest?.paperId,
      true,
    );
  }
  try {
    completeSubmissionHandoffBundlePublicationJournal(publicationJournalState);
  } catch (error) {
    return blockedExportReceipt([`handoff_bundle_publication_journal_completion_invalid:${
      String(error?.message || 'journal_completion_failed')
    }`], manifest?.paperId, true);
  }
  const receipt = {
    version: 1,
    kind: 'SubmissionHandoffBundleExportReceipt',
    status: 'submission_handoff_bundle_exported',
    paperId: manifest.paperId,
    bundleRoot: publication.finalRoot,
    artifactCount: copiedArtifacts.length,
    sealedPackageFileCount: sealedPackageCopy?.fileCount || 0,
    sealedPackageFileSetHash: sealedPackageCopy?.fileSetHash || null,
    submissionHandoffBundleManifestHash,
    manifestWriteReceiptHash: manifestWrite.writeReceiptHash,
    artifactWriteReceiptHashes: copiedArtifacts.map((item) => item.writeReceiptHash),
    sealedPackageWriteReceiptHashes:
      sealedPackageCopy?.files.map((item) => item.writeReceiptHash) || [],
    detachedRecordWriteReceiptHashes:
      detachedRecordWrites.map((item) => item.writeReceiptHash),
    submissionHandoffDetachedRecordSetHash:
      detachedRecordsCapsule?.manifestBinding
        .submissionHandoffDetachedRecordSetHash || null,
    detachedSubmissionHandoffBundleVerificationReceiptHash:
      detachedVerification
        ?.detachedSubmissionHandoffBundleVerificationReceiptHash || null,
    stagedDetachedSubmissionHandoffBundleVerificationReceiptHash:
      stagedDetachedVerification
        ?.detachedSubmissionHandoffBundleVerificationReceiptHash || null,
    submissionHandoffBundleVerificationReceiptHash:
      verification.submissionHandoffBundleVerificationReceiptHash,
    stagedSubmissionHandoffBundleVerificationReceiptHash:
      stagedVerification.submissionHandoffBundleVerificationReceiptHash,
    submissionHandoffBundlePublicationHash:
      publication.submissionHandoffBundlePublicationHash,
    submissionHandoffBundlePublicationReceiptHash:
      publicationReceipt.submissionHandoffBundlePublicationReceiptHash,
    submissionHandoffBundlePublicationRecoveryReceiptHash: null,
    submissionHandoffAuthorityLineageHash:
      persistedSubmissionAuthority
        ?.submissionHandoffAuthorityLineageHash || null,
    submissionHandoffAuthorityFreshnessReceiptHash:
      authorityFreshnessReceipt
        ?.submissionHandoffAuthorityFreshnessReceiptHash || null,
    providedSubmissionHandoffAuthorityFreshnessReceiptHash:
      authorityFreshnessReceipt?.providedFreshnessReceiptHash || null,
    recoveredExistingPublication: false,
    blockers: [],
    localFilesystemMutationPerformed: true,
    externalActionPerformed: false,
  };
  return Object.freeze({ ...receipt, submissionHandoffBundleExportReceiptHash: hashRecord('SubmissionHandoffBundleExportReceipt', receipt) });
}
