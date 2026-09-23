import crypto from 'node:crypto';

import { verifyPackageRecoveryAuthorityReadinessInspection }
  from '../paper-domain/automation/package-recovery-authority-readiness-contract.mjs';
import {
  createPackageRecoveryDeletionLeaseCommand,
  verifyPackageRecoveryDeletionLease,
  verifyPackageRecoveryDeletionLeaseAcquireRequest,
  verifyPackageRecoveryDeletionLeaseOperationReceipt,
} from '../paper-domain/automation/package-recovery-deletion-lease-contract.mjs';
import { createPackageRecoveryDeletionLeaseResumeRequest } from '../paper-domain/automation/package-recovery-deletion-lease-resume-contract.mjs';
import { hashRecord } from '../workflow-kernel/record-hash.mjs';
import { assertPackageRecoveryDeletionLeasePort }
  from './package-recovery-deletion-lease-port.mjs';

function deletionLeaseCommand({ action, handle, inspection, requestedAt }) {
  return createPackageRecoveryDeletionLeaseCommand({
    lease: handle.lease,
    fenceToken: handle.fenceToken,
    action,
    commandIdHash: hashRecord(
      'PackageRecoveryReadinessDeletionLeaseCommandId',
      {
        action,
        challengeHash: inspection.challengeHash,
        inspectionHash:
          inspection.packageRecoveryAuthorityReadinessInspectionHash,
        leaseHash: handle.lease.packageRecoveryDeletionLeaseHash,
      },
    ),
    requestedAt,
    minimumRemainingHorizonMs: action === 'assert' ? 1 : 0,
    abortReasonHash: action === 'abort_release'
      ? hashRecord('PackageRecoveryReadinessDeletionLeaseAbortReason', {
        challengeHash: inspection.challengeHash,
        inspectionHash:
          inspection.packageRecoveryAuthorityReadinessInspectionHash,
      }) : null,
  });
}

function verifyDeletionLeaseCanary({ inspection, port, observeNow }) {
  const request = inspection.deletionLeaseAuthorityCanary.acquireRequest;
  if (!verifyPackageRecoveryDeletionLeaseAcquireRequest(request).valid
    || request.challengeHash !== inspection.challengeHash
    || request.requestedAt !== inspection.requestedAt
    || request.authoritySnapshotHash !== inspection.authoritySnapshotHash) return false;
  let handle = null;
  let assertionValid = false;
  let releaseValid = false;
  try {
    handle = port.acquire(request);
    const leaseObservedAt = observeNow();
    const leaseValid = verifyPackageRecoveryDeletionLease(handle?.lease, {
      request,
      fenceToken: handle?.fenceToken,
      observedAt: leaseObservedAt,
      minimumRemainingHorizonMs: 1,
    }).valid;
    if (leaseValid) {
      const command = deletionLeaseCommand({
        action: 'assert', handle, inspection, requestedAt: leaseObservedAt,
      });
      const receipt = port.assert(handle, command);
      assertionValid = verifyPackageRecoveryDeletionLeaseOperationReceipt(
        receipt,
        { lease: handle.lease, command, observedAt: observeNow() },
      ).valid;
    }
  } catch { assertionValid = false; }
  if (handle) {
    try {
      const command = deletionLeaseCommand({
        action: 'abort_release',
        handle,
        inspection,
        requestedAt: observeNow(),
      });
      const receipt = port.abortRelease(handle, command);
      const replayRequest = createPackageRecoveryDeletionLeaseResumeRequest({
        acquireRequest: request, action: command.action,
        commandIdHash: command.commandIdHash, abortReasonHash: command.abortReasonHash,
      });
      const replayed = port.resumeTerminal(request, replayRequest);
      releaseValid = verifyPackageRecoveryDeletionLeaseOperationReceipt(
        receipt,
        { lease: handle.lease, command, observedAt: observeNow() },
      ).valid && replayed.packageRecoveryDeletionLeaseOperationReceiptHash
        === receipt.packageRecoveryDeletionLeaseOperationReceiptHash;
    } catch { releaseValid = false; }
  }
  return assertionValid && releaseValid;
}

export function inspectPackageRecoveryAuthorityReadiness({
  packageRecoveryAuthority,
  packageRecoveryDeletionLeasePort,
  readinessVerifier,
  requestedAt,
  observeNow,
} = {}) {
  let deletionLeasePort;
  try {
    deletionLeasePort = assertPackageRecoveryDeletionLeasePort(
      packageRecoveryDeletionLeasePort,
    );
  } catch { return null; }
  if (typeof packageRecoveryAuthority?.inspectAuthenticatedReadiness !== 'function'
    || typeof packageRecoveryAuthority?.verifyStorageAuthorityProof !== 'function'
    || typeof packageRecoveryAuthority?.verifyRestoreExecutionProof !== 'function'
    || typeof readinessVerifier?.verifyAuthenticatedInspection !== 'function'
    || typeof observeNow !== 'function'
    || !Number.isFinite(Date.parse(requestedAt || ''))) return null;
  const challengeHash = hashRecord('PackageRecoveryAuthorityReadinessChallenge', {
    nonce: crypto.randomUUID(),
    requestedAt,
  });
  let inspection;
  try {
    inspection = packageRecoveryAuthority.inspectAuthenticatedReadiness({
      challengeHash,
      requestedAt,
    });
  } catch { return null; }
  let observedAt;
  try { observedAt = observeNow(); } catch { return null; }
  const context = {
    challengeHash,
    requestedAt,
    observedAt,
  };
  if (!verifyPackageRecoveryAuthorityReadinessInspection(
    inspection,
    context,
  )) return null;
  try {
    if (packageRecoveryAuthority.verifyStorageAuthorityProof(
      inspection.storageAuthorityCanary.proof,
      { lifecycleReceipt: inspection.storageAuthorityCanary.lifecycleReceipt },
    ) !== true || packageRecoveryAuthority.verifyRestoreExecutionProof(
      inspection.restoreAuthorityCanary.proof,
      { recoverySourceAuthority: inspection.restoreAuthorityCanary.recoverySourceAuthority },
    ) !== true || readinessVerifier.verifyAuthenticatedInspection(
      inspection,
      context,
    ) !== true || !verifyDeletionLeaseCanary({
      inspection,
      port: deletionLeasePort,
      observeNow,
    })) return null;
  } catch { return null; }
  let finalizedAt;
  try { finalizedAt = observeNow(); } catch { return null; }
  if (!verifyPackageRecoveryAuthorityReadinessInspection(inspection, {
    challengeHash,
    requestedAt,
    observedAt: finalizedAt,
  })) return null;
  return Object.freeze({ ...inspection });
}
