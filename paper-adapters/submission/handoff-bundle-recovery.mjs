import fs from 'node:fs';
import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { verifySubmissionHandoffBundle } from './handoff-bundle-integrity.mjs';
import {
  verifyDetachedSubmissionHandoffBundle,
} from './handoff-bundle-detached-verifier.mjs';
import {
  publishSubmissionHandoffBundle,
  reconcileSubmissionHandoffBundleStagingOrphansSync,
  recoverSubmissionHandoffBundlePublication,
} from './handoff-bundle-publication-repository.mjs';
import {
  submissionHandoffArtifactBundlePath,
} from './handoff-bundle-resource-plan.mjs';
import {
  assertSubmissionHandoffBundlePublicationJournalForRecovery,
  completeSubmissionHandoffBundlePublicationJournal,
  inspectSubmissionHandoffBundlePublicationJournal,
} from './handoff-bundle-publication-journal-repository.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;

function portableSealedFiles(inspection) {
  return inspection?.descriptors.map(({ file, relative }) => ({
    role: file.role || null,
    capsuleRole: file.capsuleRole || null,
    executionRole: file.executionRole || null,
    experimentId: file.experimentId || null,
    packageRelativePath: relative,
    bundlePath: `sealed-package/${relative}`,
    hash: file.hash,
    bytes: Number(file.bytes),
  })) || [];
}

function persistedSubmissionAuthorityRecoveryBinding(authority) {
  if (!authority) return null;
  return hashRecord('SubmissionHandoffRecoveryPersistedAuthorityBinding', {
    version: authority.version,
    kind: authority.kind,
    messageId: authority.messageId,
    paperId: authority.paperId,
    dispatchAuthorizationHash: authority.dispatchAuthorizationHash,
    rowBindingHash: authority.rowBindingHash,
    authorizationConsumptionHash: authority.authorizationConsumptionHash,
    releaseLockHash: authority.releaseLockHash,
    payloadBindingHash: authority.payloadBindingHash,
    providerCapabilityHash: authority.providerCapabilityHash,
    providerCapabilityValidFrom: authority.providerCapabilityValidFrom,
    providerCapabilityExpiresAt: authority.providerCapabilityExpiresAt,
    responseCount: authority.responseCount,
    deadLetterCount: authority.deadLetterCount,
    grantsExecutionPermission: authority.grantsExecutionPermission,
    requiresProviderActionTimeAuthorityRevalidation:
      authority.requiresProviderActionTimeAuthorityRevalidation,
  });
}

export function createSubmissionHandoffRecoveryBinding({
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
}) {
  const sealedFiles = portableSealedFiles(sealedPackageInspection);
  return Object.freeze({
    paperId: manifest.paperId,
    taskKey: manifest.taskKey,
    artifactPackageHash: artifactPackage.artifactPackageHash,
    packageVerificationReceiptHash:
      packageVerificationReceipt.packageVerificationReceiptHash,
    manifestHash: manifest.manifestHash,
    handoffEnvelopeHash: handoff.envelopeHash,
    replayGuardHash: replayGuard.submissionReplayGuardHash,
    reviewedSubmitPreflightPacketHash:
      reviewedSubmitPreflightPacket.reviewedSubmitPreflightPacketHash,
    dispatchAuthorizationHash:
      dispatchAuthorization.submissionDispatchAuthorizationHash,
    provider: dispatchAuthorization.provider,
    accountId: dispatchAuthorization.accountId,
    nonce: dispatchAuthorization.nonce,
    reviewedSubmissionDecisionPacketHash:
      submissionDecisionPacket.reviewedSubmissionDecisionPacketHash,
    campaignReleaseBundleHash:
      campaignReleaseBundle?.campaignReleaseBundleHash || null,
    persistedSubmissionAuthorityStableBindingHash:
      persistedSubmissionAuthorityRecoveryBinding(
        persistedSubmissionAuthority,
      ),
    submissionMetadata: submissionDecisionPacket.metadata,
    artifacts: artifactReads.map(({ index, artifact, read }) => ({
      id: artifact.id || null,
      role: artifact.role || null,
      sourcePath: artifact.path,
      bundlePath: submissionHandoffArtifactBundlePath(artifact, index),
      hash: artifact.hash,
      bytes: read.bytes,
    })),
    sealedPackageOutput: sealedPackageInspection ? {
      immutableCampaignPackageOutputHash:
        sealedPackageInspection.immutableCampaignPackageOutputHash,
      fileSetHash: hashRecord(
        'SubmissionHandoffSealedPackageFileSet',
        sealedFiles,
      ),
      files: sealedFiles,
    } : null,
    grantsExternalExecutionPermission: false,
    requiresCurrentAuthorityRevalidation: true,
  });
}

function recoveryBindingFromManifest(document) {
  return {
    paperId: document.paperId,
    taskKey: document.taskKey,
    artifactPackageHash: document.artifactPackageHash,
    packageVerificationReceiptHash: document.packageVerificationReceiptHash,
    manifestHash: document.manifestHash,
    handoffEnvelopeHash: document.handoffEnvelopeHash,
    replayGuardHash: document.replayGuardHash,
    reviewedSubmitPreflightPacketHash:
      document.reviewedSubmitPreflightPacketHash,
    dispatchAuthorizationHash: document.dispatchAuthorizationHash,
    provider: document.provider,
    accountId: document.accountId,
    nonce: document.nonce,
    reviewedSubmissionDecisionPacketHash:
      document.reviewedSubmissionDecisionPacketHash,
    campaignReleaseBundleHash: document.campaignReleaseBundleHash,
    persistedSubmissionAuthorityStableBindingHash:
      persistedSubmissionAuthorityRecoveryBinding(
        document.persistedSubmissionAuthority,
      ),
    submissionMetadata: document.submissionMetadata,
    artifacts: document.artifacts.map((artifact) => ({
      id: artifact.id,
      role: artifact.role,
      sourcePath: artifact.sourcePath,
      bundlePath: artifact.bundlePath,
      hash: artifact.hash,
      bytes: artifact.bytes,
    })),
    sealedPackageOutput: document.sealedPackageOutput ? {
      immutableCampaignPackageOutputHash:
        document.sealedPackageOutput.immutableCampaignPackageOutputHash,
      fileSetHash: document.sealedPackageOutput.fileSetHash,
      files: document.sealedPackageOutput.files.map((file) => ({
        role: file.role,
        capsuleRole: file.capsuleRole,
        executionRole: file.executionRole,
        experimentId: file.experimentId,
        packageRelativePath: file.packageRelativePath,
        bundlePath: file.bundlePath,
        hash: file.hash,
        bytes: file.bytes,
      })),
    } : null,
    grantsExternalExecutionPermission:
      document.grantsExternalExecutionPermission,
    requiresCurrentAuthorityRevalidation:
      document.requiresCurrentAuthorityRevalidation,
  };
}

export function submissionHandoffRequestRecoveryBindingHash(binding) {
  return hashRecord('SubmissionHandoffRequestRecoveryBinding', binding);
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function detachedTrustedAnchorFromManifest(document, expectedManifestHash) {
  const descriptors = document?.detachedRecords;
  const receiptHashes = document?.detachedRecordWriteReceiptHashes;
  if (descriptors === undefined) {
    if (!Array.isArray(receiptHashes) || receiptHashes.length !== 0) {
      throw new Error('handoff_bundle_recovery_detached_write_receipts_invalid');
    }
    return null;
  }
  if (!Array.isArray(descriptors) || descriptors.length === 0
    || !Array.isArray(receiptHashes)
    || receiptHashes.length !== descriptors.length
    || !receiptHashes.every((value) => SHA256.test(String(value || '')))
    || document.submissionHandoffBundleManifestHash !== expectedManifestHash) {
    throw new Error('handoff_bundle_recovery_detached_write_receipts_invalid');
  }
  return Object.freeze({
    version: 1,
    kind: 'SubmissionHandoffDetachedTrustedAnchor',
    submissionHandoffBundleManifestHash: expectedManifestHash,
    submissionHandoffExportRequestHash:
      document.submissionHandoffExportRequestHash,
    submissionHandoffExportAuthorityHash:
      document.submissionHandoffExportAuthorityHash,
    campaignReleaseBundleHash: document.campaignReleaseBundleHash,
    dispatchAuthorizationHash: document.dispatchAuthorizationHash,
  });
}

function verifyRecoveredDetachedBundle({
  bundleRoot,
  document,
  expectedManifestHash,
}) {
  const trustedAnchor = detachedTrustedAnchorFromManifest(
    document,
    expectedManifestHash,
  );
  if (!trustedAnchor) return null;
  const verification = verifyDetachedSubmissionHandoffBundle({
    bundleRoot,
    trustedAnchor,
  });
  if (!verification.internalLineageVerified) {
    throw new Error(`handoff_bundle_recovery_detached_verification_failed:${
      verification.blockers.join(',')}`);
  }
  return verification;
}

function reconstructStagedDetachedVerification(verification, stagingRoot) {
  if (!verification) return null;
  const payload = { ...verification, bundleRoot: path.resolve(stagingRoot) };
  delete payload.detachedSubmissionHandoffBundleVerificationReceiptHash;
  delete payload.manifest;
  return Object.freeze({
    detachedSubmissionHandoffBundleVerificationReceiptHash: hashRecord(
      'DetachedSubmissionHandoffBundleVerificationReceipt',
      payload,
    ),
  });
}

function readJournalBoundRecoveryBundle({
  allowCompleted = false,
  bundleRoot,
  expectedRecoveryBinding,
  publicationJournalState,
}) {
  const expectedBindingHash = submissionHandoffRequestRecoveryBindingHash(
    expectedRecoveryBinding,
  );
  const journal = assertSubmissionHandoffBundlePublicationJournalForRecovery(
    publicationJournalState,
    {
      allowCompleted,
      submissionHandoffRequestRecoveryBindingHash: expectedBindingHash,
    },
  );
  const selectedRoot = path.resolve(bundleRoot);
  const rootStat = fs.lstatSync(selectedRoot, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || !sameIdentity(journal.stagingIdentity, {
      dev: String(rootStat.dev),
      ino: String(rootStat.ino),
    })) {
    throw new Error('handoff_bundle_recovery_staging_identity_mismatch');
  }
  const manifestRead = readScopedFileSync({
    scopeRoot: selectedRoot,
    candidate: path.join(selectedRoot, 'SUBMISSION_HANDOFF_MANIFEST.json'),
  });
  if (manifestRead.status !== 'scoped_file_read_verified') {
    throw new Error('handoff_bundle_recovery_manifest_unreadable');
  }
  let document;
  try {
    document = JSON.parse(manifestRead.content.toString('utf8'));
  } catch {
    throw new Error('handoff_bundle_recovery_manifest_json_invalid');
  }
  const expectedManifestHash = journal.submissionHandoffBundleManifestHash;
  if (document.submissionHandoffBundleManifestHash !== expectedManifestHash) {
    throw new Error('handoff_bundle_recovery_manifest_journal_mismatch');
  }
  const verification = verifySubmissionHandoffBundle({
    bundleRoot: selectedRoot,
    submissionHandoffBundleManifestHash: expectedManifestHash,
  });
  if (verification.status !== 'submission_handoff_bundle_verified') {
    throw new Error(`handoff_bundle_recovery_verification_failed:${
      verification.blockers.join(',')
    }`);
  }
  if (submissionHandoffRequestRecoveryBindingHash(
    recoveryBindingFromManifest(document),
  ) !== expectedBindingHash) {
    throw new Error('handoff_bundle_recovery_request_binding_mismatch');
  }
  const lineage = document.submissionHandoffBundlePublicationLineage;
  assertSubmissionHandoffBundlePublicationJournalForRecovery(
    publicationJournalState,
    {
      allowCompleted,
      submissionHandoffRequestRecoveryBindingHash: expectedBindingHash,
      submissionHandoffBundleManifestHash: expectedManifestHash,
      submissionHandoffBundlePublicationLineageHash:
        lineage?.submissionHandoffBundlePublicationLineageHash,
    },
  );
  if (lineage?.submissionHandoffBundlePublicationHash
      !== journal.submissionHandoffBundlePublicationHash
    || !sameIdentity(lineage?.parentIdentity, journal.parentIdentity)
    || !sameIdentity(lineage?.stagingIdentity, journal.stagingIdentity)) {
    throw new Error('handoff_bundle_recovery_publication_journal_mismatch');
  }
  const detachedVerification = verifyRecoveredDetachedBundle({
    bundleRoot: selectedRoot,
    document,
    expectedManifestHash,
  });
  return Object.freeze({
    detachedVerification,
    document,
    expectedManifestHash,
    journal,
    selectedRoot,
    verification,
  });
}

async function refreshRecoveryAuthority({
  baselineAuthority,
  document,
  submissionAuthorityFreshnessQuery,
  verifyCurrentAuthority,
}) {
  if (!document.persistedSubmissionAuthority) return null;
  return verifyCurrentAuthority({
    baselineAuthority,
    baselineLineage: document.persistedSubmissionAuthority,
    dispatchAuthorizationHash: document.dispatchAuthorizationHash,
    paperId: document.paperId,
    submissionAuthorityFreshnessQuery,
  });
}

function buildRecoveredExportReceipt({
  authorityFreshnessReceipt,
  detachedVerification = null,
  document,
  durableVerification,
  expectedManifestHash,
  publicationReceipt = null,
  recoveryReceipt = null,
  stagedDetachedVerification = null,
  stagedVerification = null,
  localFilesystemMutationPerformed = true,
}) {
  const receipt = {
    version: 1,
    kind: 'SubmissionHandoffBundleExportReceipt',
    status: 'submission_handoff_bundle_exported',
    paperId: document.paperId,
    bundleRoot: durableVerification.bundleRoot,
    artifactCount: document.artifactCount,
    sealedPackageFileCount: document.sealedPackageFileCount,
    sealedPackageFileSetHash: document.sealedPackageOutput?.fileSetHash || null,
    submissionHandoffBundleManifestHash: expectedManifestHash,
    manifestWriteReceiptHash: null,
    artifactWriteReceiptHashes:
      document.artifacts.map((artifact) => artifact.writeReceiptHash),
    sealedPackageWriteReceiptHashes:
      document.sealedPackageOutput?.files.map((file) => file.writeReceiptHash) || [],
    detachedRecordWriteReceiptHashes:
      [...document.detachedRecordWriteReceiptHashes],
    submissionHandoffDetachedRecordSetHash:
      document.submissionHandoffDetachedRecordSetHash || null,
    detachedSubmissionHandoffBundleVerificationReceiptHash:
      detachedVerification
        ?.detachedSubmissionHandoffBundleVerificationReceiptHash || null,
    stagedDetachedSubmissionHandoffBundleVerificationReceiptHash:
      stagedDetachedVerification
        ?.detachedSubmissionHandoffBundleVerificationReceiptHash || null,
    submissionHandoffBundleVerificationReceiptHash:
      durableVerification.submissionHandoffBundleVerificationReceiptHash,
    stagedSubmissionHandoffBundleVerificationReceiptHash:
      stagedVerification?.submissionHandoffBundleVerificationReceiptHash || null,
    submissionHandoffBundlePublicationHash:
      document.submissionHandoffBundlePublicationLineage
        .submissionHandoffBundlePublicationHash,
    submissionHandoffBundlePublicationReceiptHash:
      publicationReceipt?.submissionHandoffBundlePublicationReceiptHash || null,
    submissionHandoffBundlePublicationRecoveryReceiptHash:
      recoveryReceipt
        ?.submissionHandoffBundlePublicationRecoveryReceiptHash || null,
    submissionHandoffAuthorityLineageHash:
      document.persistedSubmissionAuthority
        ?.submissionHandoffAuthorityLineageHash || null,
    submissionHandoffAuthorityFreshnessReceiptHash:
      authorityFreshnessReceipt
        ?.submissionHandoffAuthorityFreshnessReceiptHash || null,
    providedSubmissionHandoffAuthorityFreshnessReceiptHash:
      authorityFreshnessReceipt?.providedFreshnessReceiptHash || null,
    recoveredExistingPublication: true,
    blockers: [],
    localFilesystemMutationPerformed,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...receipt,
    submissionHandoffBundleExportReceiptHash: hashRecord(
      'SubmissionHandoffBundleExportReceipt',
      receipt,
    ),
  });
}

export async function recoverExistingSubmissionHandoffBundle({
  artifactRepository,
  baselineAuthority,
  bundleRoot,
  expectedRecoveryBinding,
  publicationJournalState,
  submissionAuthorityFreshnessQuery,
  verifyCurrentAuthority,
}) {
  const inspected = readJournalBoundRecoveryBundle({
    bundleRoot,
    expectedRecoveryBinding,
    publicationJournalState,
  });
  const authorityFreshnessReceipt = await refreshRecoveryAuthority({
    baselineAuthority,
    document: inspected.document,
    submissionAuthorityFreshnessQuery,
    verifyCurrentAuthority,
  });
  const recoveryReceipt = recoverSubmissionHandoffBundlePublication({
    finalRoot: inspected.selectedRoot,
    repositoryScopeRoot: artifactRepository.scopeRoot,
    repositoryCasRoot: artifactRepository.casRoot,
    publicationLineage:
      inspected.document.submissionHandoffBundlePublicationLineage,
  });
  const durableVerification = verifySubmissionHandoffBundle({
    bundleRoot: inspected.selectedRoot,
    submissionHandoffBundleManifestHash: inspected.expectedManifestHash,
  });
  if (durableVerification.status !== 'submission_handoff_bundle_verified') {
    throw new Error('handoff_bundle_recovery_changed_after_parent_fsync');
  }
  const detachedVerification = verifyRecoveredDetachedBundle({
    bundleRoot: inspected.selectedRoot,
    document: inspected.document,
    expectedManifestHash: inspected.expectedManifestHash,
  });
  completeSubmissionHandoffBundlePublicationJournal(publicationJournalState);
  return buildRecoveredExportReceipt({
    authorityFreshnessReceipt,
    detachedVerification,
    document: inspected.document,
    durableVerification,
    expectedManifestHash: inspected.expectedManifestHash,
    recoveryReceipt,
    stagedDetachedVerification: reconstructStagedDetachedVerification(
      detachedVerification,
      inspected.journal.publication.stagingRoot,
    ),
  });
}

export async function resumePreparedSubmissionHandoffBundle({
  baselineAuthority,
  expectedRecoveryBinding,
  publicationJournalState,
  submissionAuthorityFreshnessQuery,
  verifyCurrentAuthority,
}) {
  const journal = assertSubmissionHandoffBundlePublicationJournalForRecovery(
    publicationJournalState,
    {
      submissionHandoffRequestRecoveryBindingHash:
        submissionHandoffRequestRecoveryBindingHash(expectedRecoveryBinding),
    },
  );
  const inspected = readJournalBoundRecoveryBundle({
    bundleRoot: journal.publication.stagingRoot,
    expectedRecoveryBinding,
    publicationJournalState,
  });
  const authorityFreshnessReceipt = await refreshRecoveryAuthority({
    baselineAuthority,
    document: inspected.document,
    submissionAuthorityFreshnessQuery,
    verifyCurrentAuthority,
  });
  const publicationReceipt = publishSubmissionHandoffBundle(
    journal.publication,
  );
  const durableVerification = verifySubmissionHandoffBundle({
    bundleRoot: journal.publication.finalRoot,
    submissionHandoffBundleManifestHash: inspected.expectedManifestHash,
  });
  if (durableVerification.status !== 'submission_handoff_bundle_verified') {
    throw new Error('handoff_bundle_recovery_changed_after_publication');
  }
  const detachedVerification = verifyRecoveredDetachedBundle({
    bundleRoot: journal.publication.finalRoot,
    document: inspected.document,
    expectedManifestHash: inspected.expectedManifestHash,
  });
  completeSubmissionHandoffBundlePublicationJournal(publicationJournalState);
  return buildRecoveredExportReceipt({
    authorityFreshnessReceipt,
    detachedVerification,
    document: inspected.document,
    durableVerification,
    expectedManifestHash: inspected.expectedManifestHash,
    publicationReceipt,
    stagedDetachedVerification: inspected.detachedVerification,
    stagedVerification: inspected.verification,
  });
}

function preexistingRecoveryBlocker(error) {
  const code = String(error?.message || 'recovery_failed');
  if (code === 'handoff_bundle_preexisting_collision'
    || code === 'handoff_bundle_publication_journal_already_completed') {
    return code;
  }
  return `handoff_bundle_preexisting_recovery_invalid:${code}`;
}

async function recoverCompletedSubmissionHandoffBundle({
  baselineAuthority,
  bundleRoot,
  expectedRecoveryBinding,
  publicationJournalState,
  submissionAuthorityFreshnessQuery,
  verifyCurrentAuthority,
}) {
  const inspected = readJournalBoundRecoveryBundle({
    allowCompleted: true,
    bundleRoot,
    expectedRecoveryBinding,
    publicationJournalState,
  });
  const authorityFreshnessReceipt = await refreshRecoveryAuthority({
    baselineAuthority,
    document: inspected.document,
    submissionAuthorityFreshnessQuery,
    verifyCurrentAuthority,
  });
  const cleanupRequired = publicationJournalState.preparedTwin === true;
  completeSubmissionHandoffBundlePublicationJournal(publicationJournalState);
  const durableVerification = verifySubmissionHandoffBundle({
    bundleRoot: inspected.selectedRoot,
    submissionHandoffBundleManifestHash: inspected.expectedManifestHash,
  });
  if (durableVerification.status !== 'submission_handoff_bundle_verified') {
    throw new Error('handoff_bundle_completed_recovery_changed');
  }
  const detachedVerification = verifyRecoveredDetachedBundle({
    bundleRoot: inspected.selectedRoot,
    document: inspected.document,
    expectedManifestHash: inspected.expectedManifestHash,
  });
  return buildRecoveredExportReceipt({
    authorityFreshnessReceipt,
    detachedVerification,
    document: inspected.document,
    durableVerification,
    expectedManifestHash: inspected.expectedManifestHash,
    localFilesystemMutationPerformed: cleanupRequired,
    stagedDetachedVerification: reconstructStagedDetachedVerification(
      detachedVerification,
      inspected.journal.publication.stagingRoot,
    ),
  });
}

export async function reconcileSubmissionHandoffBundlePublication({
  artifactRepository,
  baselineAuthority,
  bundleRoot,
  expectedRecoveryBinding,
  submissionAuthorityFreshnessQuery,
  verifyCurrentAuthority,
}) {
  let finalRootPreexisting = false;
  try {
    fs.lstatSync(path.resolve(bundleRoot));
    finalRootPreexisting = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return Object.freeze({
        status: 'submission_handoff_bundle_reconciliation_blocked',
        blocker: 'handoff_bundle_final_state_unreadable',
        localFilesystemMutationPerformed: false,
      });
    }
  }
  let publicationJournalState;
  try {
    publicationJournalState = inspectSubmissionHandoffBundlePublicationJournal({
      finalRoot: bundleRoot,
      repositoryScopeRoot: artifactRepository.scopeRoot,
      repositoryCasRoot: artifactRepository.casRoot,
    });
  } catch (error) {
    return Object.freeze({
      status: 'submission_handoff_bundle_reconciliation_blocked',
      blocker: `handoff_bundle_publication_journal_invalid:${String(
        error?.message || 'journal_invalid',
      )}`,
      localFilesystemMutationPerformed: false,
    });
  }
  if (finalRootPreexisting) {
    if (publicationJournalState.status
        === 'submission_handoff_bundle_publication_journal_completed') {
      try {
        return Object.freeze({
          status: 'submission_handoff_bundle_reconciliation_recovered',
          receipt: await recoverCompletedSubmissionHandoffBundle({
            baselineAuthority,
            bundleRoot,
            expectedRecoveryBinding,
            publicationJournalState,
            submissionAuthorityFreshnessQuery,
            verifyCurrentAuthority,
          }),
        });
      } catch (error) {
        return Object.freeze({
          status: 'submission_handoff_bundle_reconciliation_blocked',
          blocker: preexistingRecoveryBlocker(error),
          localFilesystemMutationPerformed: false,
        });
      }
    }
    try {
      return Object.freeze({
        status: 'submission_handoff_bundle_reconciliation_recovered',
        receipt: await recoverExistingSubmissionHandoffBundle({
          artifactRepository,
          baselineAuthority,
          bundleRoot,
          expectedRecoveryBinding,
          publicationJournalState,
          submissionAuthorityFreshnessQuery,
          verifyCurrentAuthority,
        }),
      });
    } catch (error) {
      return Object.freeze({
        status: 'submission_handoff_bundle_reconciliation_blocked',
        blocker: preexistingRecoveryBlocker(error),
        localFilesystemMutationPerformed: false,
      });
    }
  }
  if (publicationJournalState.status
      === 'submission_handoff_bundle_publication_journal_completed') {
    return Object.freeze({
      status: 'submission_handoff_bundle_reconciliation_blocked',
      blocker: 'handoff_bundle_publication_journal_already_completed',
      localFilesystemMutationPerformed: false,
    });
  }
  if (publicationJournalState.status
      === 'submission_handoff_bundle_publication_journal_prepared') {
    try {
      return Object.freeze({
        status: 'submission_handoff_bundle_reconciliation_recovered',
        receipt: await resumePreparedSubmissionHandoffBundle({
          baselineAuthority,
          expectedRecoveryBinding,
          publicationJournalState,
          submissionAuthorityFreshnessQuery,
          verifyCurrentAuthority,
        }),
      });
    } catch (error) {
      return Object.freeze({
        status: 'submission_handoff_bundle_reconciliation_blocked',
        blocker: `handoff_bundle_prepared_recovery_invalid:${String(
          error?.message || 'recovery_failed',
        )}`,
        localFilesystemMutationPerformed: true,
      });
    }
  }
  let stagingReconciliation;
  try {
    stagingReconciliation =
      reconcileSubmissionHandoffBundleStagingOrphansSync({
        finalRoot: bundleRoot,
        repositoryScopeRoot: artifactRepository.scopeRoot,
        repositoryCasRoot: artifactRepository.casRoot,
      });
  } catch (error) {
    return Object.freeze({
      status: 'submission_handoff_bundle_reconciliation_blocked',
      blocker: `handoff_bundle_staging_reconciliation_invalid:${String(
        error?.message || 'staging_reconciliation_failed',
      )}`,
      localFilesystemMutationPerformed:
        error?.localFilesystemMutationPerformed === true,
    });
  }
  if (stagingReconciliation.activeStages.length) {
    return Object.freeze({
      status: 'submission_handoff_bundle_reconciliation_blocked',
      blocker: 'handoff_bundle_publication_in_progress',
      localFilesystemMutationPerformed:
        stagingReconciliation.localFilesystemMutationPerformed,
    });
  }
  return Object.freeze({
    status: 'submission_handoff_bundle_reconciliation_new',
    localFilesystemMutationPerformed:
      stagingReconciliation.localFilesystemMutationPerformed,
    publicationJournalState,
  });
}
