import {
  assertPackageRecoveryDeletionLeaseAuthority,
  assertPackageRecoveryDeletionLeasePort,
} from '../../paper-ports/package-recovery-deletion-lease-port.mjs';
import { hasExactPlainObjectKeys }
  from '../../workflow-kernel/exact-object-keys.mjs';
import {
  createPackageRecoveryDeletionLeaseCommand,
  verifyPackageRecoveryDeletionLease,
  verifyPackageRecoveryDeletionLeaseAcquireRequest,
  verifyPackageRecoveryDeletionLeaseCommand,
  verifyPackageRecoveryDeletionLeaseOperationReceipt,
} from '../../paper-domain/automation/package-recovery-deletion-lease-contract.mjs';
import {
  verifyPackageRecoveryDeletionLeaseResumeRequest,
  verifyPackageRecoveryDeletionLeaseResumeResolution,
} from '../../paper-domain/automation/package-recovery-deletion-lease-resume-contract.mjs';

const HANDLE_KEYS = Object.freeze(['lease', 'fenceToken']);

function invalid(blocker) {
  throw new Error(blocker);
}

function copyRequest(request) {
  if (!verifyPackageRecoveryDeletionLeaseAcquireRequest(request).valid) {
    invalid('package_recovery_deletion_lease_acquire_request_invalid');
  }
  const selected = Object.freeze({ ...(request || {}) });
  if (!verifyPackageRecoveryDeletionLeaseAcquireRequest(selected).valid) {
    invalid('package_recovery_deletion_lease_acquire_request_invalid');
  }
  return selected;
}

function copyHandle(handle) {
  if (!hasExactPlainObjectKeys(handle, HANDLE_KEYS)
    || typeof handle.fenceToken !== 'string'
    || !verifyPackageRecoveryDeletionLease(handle.lease, {
      fenceToken: handle.fenceToken,
    }).valid) {
    invalid('package_recovery_deletion_lease_handle_invalid');
  }
  const selected = Object.freeze({
    lease: Object.freeze({ ...(handle.lease || {}) }),
    fenceToken: handle.fenceToken,
  });
  if (!verifyPackageRecoveryDeletionLease(selected.lease, {
    fenceToken: selected.fenceToken,
  }).valid) {
    invalid('package_recovery_deletion_lease_handle_invalid');
  }
  return selected;
}

function copyCommand(command, handle, expectedAction) {
  if (command?.action !== expectedAction
    || !verifyPackageRecoveryDeletionLeaseCommand(command, {
      lease: handle.lease,
      fenceToken: handle.fenceToken,
    }).valid) {
    invalid('package_recovery_deletion_lease_command_invalid');
  }
  const selected = Object.freeze({ ...(command || {}) });
  if (selected.action !== expectedAction
    || !verifyPackageRecoveryDeletionLeaseCommand(selected, {
      lease: handle.lease,
      fenceToken: handle.fenceToken,
    }).valid) {
    invalid('package_recovery_deletion_lease_command_invalid');
  }
  return selected;
}

function copyOperationReceipt(receipt) {
  if (!verifyPackageRecoveryDeletionLeaseOperationReceipt(receipt).valid) {
    invalid('package_recovery_deletion_lease_operation_receipt_invalid');
  }
  return Object.freeze({ ...(receipt || {}) });
}

function copyResumeRequest(resumeRequest, acquireRequest) {
  if (!verifyPackageRecoveryDeletionLeaseResumeRequest(resumeRequest, {
    acquireRequest,
  }).valid) {
    invalid('package_recovery_deletion_lease_resume_request_invalid');
  }
  const selected = Object.freeze({ ...(resumeRequest || {}) });
  if (!verifyPackageRecoveryDeletionLeaseResumeRequest(selected, {
    acquireRequest,
  }).valid) {
    invalid('package_recovery_deletion_lease_resume_request_invalid');
  }
  return selected;
}

function copyResumeResolution(resolution, acquireRequest, resumeRequest) {
  if (!verifyPackageRecoveryDeletionLeaseResumeResolution(resolution, {
    acquireRequest,
    resumeRequest,
  }).valid) {
    invalid('package_recovery_deletion_lease_resume_resolution_invalid');
  }
  const selected = Object.freeze({
    ...(resolution || {}),
    lease: Object.freeze({ ...(resolution?.lease || {}) }),
    terminalCommand: resolution?.terminalCommand
      ? Object.freeze({ ...resolution.terminalCommand }) : null,
    terminalReceipt: resolution?.terminalReceipt
      ? Object.freeze({ ...resolution.terminalReceipt }) : null,
  });
  if (!verifyPackageRecoveryDeletionLeaseResumeResolution(selected, {
    acquireRequest,
    resumeRequest,
  }).valid) {
    invalid('package_recovery_deletion_lease_resume_resolution_invalid');
  }
  return selected;
}

function authorityEnvelope(handle, command) {
  return Object.freeze({
    lease: handle.lease,
    fenceToken: handle.fenceToken,
    command,
  });
}

function sameHandle(left, right) {
  return Boolean(left && right
    && left.fenceToken === right.fenceToken
    && left.lease.packageRecoveryDeletionLeaseHash
      === right.lease.packageRecoveryDeletionLeaseHash);
}

function laterHandleOnSameLease(left, right) {
  return Boolean(left && right
    && right.lease.leaseId === left.lease.leaseId
    && right.lease.acquireRequestHash === left.lease.acquireRequestHash
    && right.lease.generation > left.lease.generation);
}

function canonicalObservedAt(observeNow) {
  let observedAt;
  try { observedAt = observeNow(); } catch {
    invalid('package_recovery_deletion_lease_observation_failed');
  }
  if (typeof observedAt !== 'string'
    || !Number.isFinite(Date.parse(observedAt))
    || new Date(Date.parse(observedAt)).toISOString() !== observedAt) {
    invalid('package_recovery_deletion_lease_observation_invalid');
  }
  return observedAt;
}

function synchronousAuthorityResult(value) {
  if (value && typeof value.then === 'function') {
    invalid('package_recovery_deletion_lease_async_authority_forbidden');
  }
  return value;
}

export function createPackageRecoveryDeletionLeasePort({
  authority,
  observeNow = () => new Date().toISOString(),
} = {}) {
  const selectedAuthority = assertPackageRecoveryDeletionLeaseAuthority(
    authority,
  );
  if (typeof observeNow !== 'function') {
    invalid('package_recovery_deletion_lease_observer_invalid');
  }
  const acquireResults = new Map();
  const commandResults = new Map();
  const latestLeaseById = new Map();
  const terminalCommandByLeaseId = new Map();

  function assertCurrent(handle, command) {
    const cached = commandResults.get(
      command.packageRecoveryDeletionLeaseCommandHash,
    );
    const latest = latestLeaseById.get(handle.lease.leaseId);
    if (latest && !sameHandle(latest, handle) && !cached) {
      invalid('package_recovery_deletion_lease_stale_generation_or_token');
    }
    const terminalCommand = terminalCommandByLeaseId.get(handle.lease.leaseId);
    if (terminalCommand && terminalCommand
      !== command.packageRecoveryDeletionLeaseCommandHash) {
      invalid('package_recovery_deletion_lease_terminal');
    }
    return cached;
  }

  function recordCommandResult(command, value, identity) {
    const commandHash = command.packageRecoveryDeletionLeaseCommandHash;
    const previous = commandResults.get(commandHash);
    if (previous && previous.identity !== identity) {
      invalid('package_recovery_deletion_lease_idempotency_violated');
    }
    commandResults.set(commandHash, Object.freeze({ identity, value }));
  }

  function acquire(request) {
    const selectedRequest = copyRequest(request);
    const raw = synchronousAuthorityResult(
      selectedAuthority.acquire(selectedRequest),
    );
    const handle = copyHandle(raw);
    const observedAt = canonicalObservedAt(observeNow);
    if (!verifyPackageRecoveryDeletionLease(handle.lease, {
      request: selectedRequest,
      fenceToken: handle.fenceToken,
      observedAt,
      minimumRemainingHorizonMs:
        selectedRequest.minimumRemainingHorizonMs,
    }).valid) {
      invalid('package_recovery_deletion_lease_acquisition_invalid');
    }
    const requestHash = selectedRequest
      .packageRecoveryDeletionLeaseAcquireRequestHash;
    const previous = acquireResults.get(requestHash);
    if (terminalCommandByLeaseId.has(handle.lease.leaseId)
      && (!previous || !sameHandle(previous, handle))) {
      invalid('package_recovery_deletion_lease_terminal');
    }
    if (previous && !sameHandle(previous, handle)
      && !laterHandleOnSameLease(previous, handle)) {
      invalid('package_recovery_deletion_lease_idempotency_violated');
    }
    const latest = latestLeaseById.get(handle.lease.leaseId);
    if (latest && !sameHandle(latest, handle)
      && !laterHandleOnSameLease(latest, handle)) {
      invalid('package_recovery_deletion_lease_identity_collision');
    }
    acquireResults.set(requestHash, handle);
    latestLeaseById.set(handle.lease.leaseId, handle);
    return handle;
  }

  function resumeTerminal(request, resumeRequest) {
    const selectedRequest = copyRequest(request);
    const selectedResumeRequest = copyResumeRequest(
      resumeRequest,
      selectedRequest,
    );
    const raw = synchronousAuthorityResult(selectedAuthority.lookupTerminal(
      Object.freeze({
        acquireRequest: selectedRequest,
        resumeRequest: selectedResumeRequest,
      }),
    ));
    const resolution = copyResumeResolution(
      raw,
      selectedRequest,
      selectedResumeRequest,
    );
    if (resolution.status
      === 'package_recovery_deletion_lease_resume_terminal') {
      const command = resolution.terminalCommand;
      const receipt = copyOperationReceipt(resolution.terminalReceipt);
      recordCommandResult(
        command,
        receipt,
        receipt.packageRecoveryDeletionLeaseOperationReceiptHash,
      );
      terminalCommandByLeaseId.set(
        resolution.lease.leaseId,
        command.packageRecoveryDeletionLeaseCommandHash,
      );
      return receipt;
    }
    const handle = copyHandle({
      lease: resolution.lease,
      fenceToken: resolution.fenceToken,
    });
    const observedAt = canonicalObservedAt(observeNow);
    if (selectedResumeRequest.action === 'commit'
      && !verifyPackageRecoveryDeletionLease(handle.lease, {
        request: selectedRequest,
        fenceToken: handle.fenceToken,
        observedAt,
        minimumRemainingHorizonMs:
          selectedRequest.minimumRemainingHorizonMs,
      }).valid) {
      invalid('package_recovery_deletion_lease_resume_commit_expired');
    }
    const command = createPackageRecoveryDeletionLeaseCommand({
      lease: handle.lease,
      fenceToken: handle.fenceToken,
      action: selectedResumeRequest.action,
      commandIdHash: selectedResumeRequest.commandIdHash,
      requestedAt: handle.lease.issuedAt,
      localDeletedFenceHash: selectedResumeRequest.localDeletedFenceHash,
      abortReasonHash: selectedResumeRequest.abortReasonHash,
    });
    latestLeaseById.set(handle.lease.leaseId, handle);
    acquireResults.set(handle.lease.acquireRequestHash, handle);
    return terminalOperation(
      handle,
      command,
      selectedResumeRequest.action,
      selectedResumeRequest.action === 'commit' ? 'commit' : 'abortRelease',
    );
  }

  function assertLease(handle, command) {
    const selectedHandle = copyHandle(handle);
    const selectedCommand = copyCommand(command, selectedHandle, 'assert');
    assertCurrent(selectedHandle, selectedCommand);
    const raw = synchronousAuthorityResult(selectedAuthority.assert(
      authorityEnvelope(selectedHandle, selectedCommand),
    ));
    const receipt = copyOperationReceipt(raw);
    const observedAt = canonicalObservedAt(observeNow);
    if (!verifyPackageRecoveryDeletionLeaseOperationReceipt(receipt, {
      lease: selectedHandle.lease,
      command: selectedCommand,
      observedAt,
    }).valid) {
      invalid('package_recovery_deletion_lease_assertion_invalid');
    }
    recordCommandResult(
      selectedCommand,
      receipt,
      receipt.packageRecoveryDeletionLeaseOperationReceiptHash,
    );
    return receipt;
  }

  function renew(handle, command) {
    const selectedHandle = copyHandle(handle);
    const selectedCommand = copyCommand(command, selectedHandle, 'renew');
    assertCurrent(selectedHandle, selectedCommand);
    const raw = synchronousAuthorityResult(selectedAuthority.renew(
      authorityEnvelope(selectedHandle, selectedCommand),
    ));
    const renewedHandle = copyHandle(raw);
    const observedAt = canonicalObservedAt(observeNow);
    if (!verifyPackageRecoveryDeletionLease(renewedHandle.lease, {
      previousLease: selectedHandle.lease,
      renewCommand: selectedCommand,
      fenceToken: renewedHandle.fenceToken,
      observedAt,
      minimumRemainingHorizonMs:
        selectedCommand.minimumRemainingHorizonMs,
    }).valid) {
      invalid('package_recovery_deletion_lease_renewal_invalid');
    }
    recordCommandResult(
      selectedCommand,
      renewedHandle,
      renewedHandle.lease.packageRecoveryDeletionLeaseHash,
    );
    latestLeaseById.set(renewedHandle.lease.leaseId, renewedHandle);
    acquireResults.set(renewedHandle.lease.acquireRequestHash, renewedHandle);
    return renewedHandle;
  }

  function terminalOperation(handle, command, action, authorityMethod) {
    const selectedHandle = copyHandle(handle);
    const selectedCommand = copyCommand(command, selectedHandle, action);
    assertCurrent(selectedHandle, selectedCommand);
    const raw = synchronousAuthorityResult(selectedAuthority[authorityMethod](
      authorityEnvelope(selectedHandle, selectedCommand),
    ));
    const receipt = copyOperationReceipt(raw);
    const observedAt = canonicalObservedAt(observeNow);
    if (!verifyPackageRecoveryDeletionLeaseOperationReceipt(receipt, {
      lease: selectedHandle.lease,
      command: selectedCommand,
      observedAt,
    }).valid) {
      invalid(`package_recovery_deletion_lease_${action}_invalid`);
    }
    recordCommandResult(
      selectedCommand,
      receipt,
      receipt.packageRecoveryDeletionLeaseOperationReceiptHash,
    );
    terminalCommandByLeaseId.set(
      selectedHandle.lease.leaseId,
      selectedCommand.packageRecoveryDeletionLeaseCommandHash,
    );
    return receipt;
  }

  return assertPackageRecoveryDeletionLeasePort(Object.freeze({
    version: 1,
    kind: 'PackageRecoveryDeletionLeasePort',
    acquire,
    resumeTerminal,
    assert: assertLease,
    renew,
    commit: (handle, command) => terminalOperation(
      handle,
      command,
      'commit',
      'commit',
    ),
    abortRelease: (handle, command) => terminalOperation(
      handle,
      command,
      'abort_release',
      'abortRelease',
    ),
  }));
}
