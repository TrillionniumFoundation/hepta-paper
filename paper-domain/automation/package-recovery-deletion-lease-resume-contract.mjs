import { hasExactPlainObjectKeys }
  from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyPackageRecoveryDeletionLease,
  verifyPackageRecoveryDeletionLeaseAcquireRequest,
  verifyPackageRecoveryDeletionLeaseCommand,
  verifyPackageRecoveryDeletionLeaseOperationReceipt,
} from './package-recovery-deletion-lease-contract.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const TERMINAL_ACTIONS = new Set(['commit', 'abort_release']);
const REQUEST_KEYS = Object.freeze([
  'version', 'kind', 'acquireRequestHash', 'challengeHash', 'operationId',
  'deletionOperationHash', 'action', 'commandIdHash',
  'localDeletedFenceHash', 'abortReasonHash',
  'packageRecoveryDeletionLeaseResumeRequestHash',
]);
const RESOLUTION_KEYS = Object.freeze([
  'version', 'kind', 'status', 'resumeRequestHash', 'acquireRequestHash',
  'lease', 'fenceToken', 'terminalCommand', 'terminalReceipt',
  'providerAttestationHash',
  'packageRecoveryDeletionLeaseResumeResolutionHash',
]);
const HANDLE_KEYS = Object.freeze(['lease', 'fenceToken']);

function result(blockers) {
  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

function validHash(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function terminalShape(value) {
  if (value?.action === 'commit') {
    return validHash(value.localDeletedFenceHash)
      && value.abortReasonHash === null;
  }
  return value?.action === 'abort_release'
    && value.localDeletedFenceHash === null
    && validHash(value.abortReasonHash);
}

function sameRequestBinding(resumeRequest, acquireRequest) {
  return Boolean(resumeRequest && acquireRequest
    && resumeRequest.acquireRequestHash
      === acquireRequest.packageRecoveryDeletionLeaseAcquireRequestHash
    && resumeRequest.challengeHash === acquireRequest.challengeHash
    && resumeRequest.operationId === acquireRequest.operationId
    && resumeRequest.deletionOperationHash
      === acquireRequest.deletionOperationHash);
}

function sameTerminalBinding(resumeRequest, command) {
  return Boolean(resumeRequest && command
    && command.action === resumeRequest.action
    && command.commandIdHash === resumeRequest.commandIdHash
    && command.localDeletedFenceHash
      === resumeRequest.localDeletedFenceHash
    && command.abortReasonHash === resumeRequest.abortReasonHash);
}

function seal(kind, hashField, payload) {
  return Object.freeze({
    ...payload,
    [hashField]: hashRecord(kind, payload),
  });
}

export function createPackageRecoveryDeletionLeaseResumeRequest({
  acquireRequest,
  action,
  commandIdHash,
  localDeletedFenceHash = null,
  abortReasonHash = null,
} = {}) {
  if (!verifyPackageRecoveryDeletionLeaseAcquireRequest(acquireRequest).valid) {
    throw new Error('package_recovery_deletion_lease_resume_acquire_request_invalid');
  }
  const payload = {
    version: 1,
    kind: 'PackageRecoveryDeletionLeaseResumeRequest',
    acquireRequestHash:
      acquireRequest.packageRecoveryDeletionLeaseAcquireRequestHash,
    challengeHash: acquireRequest.challengeHash,
    operationId: acquireRequest.operationId,
    deletionOperationHash: acquireRequest.deletionOperationHash,
    action,
    commandIdHash,
    localDeletedFenceHash,
    abortReasonHash,
  };
  const request = seal(
    'PackageRecoveryDeletionLeaseResumeRequest',
    'packageRecoveryDeletionLeaseResumeRequestHash',
    payload,
  );
  if (!verifyPackageRecoveryDeletionLeaseResumeRequest(request, {
    acquireRequest,
  }).valid) {
    throw new Error('package_recovery_deletion_lease_resume_request_invalid');
  }
  return request;
}

export function verifyPackageRecoveryDeletionLeaseResumeRequest(
  request,
  { acquireRequest = null } = {},
) {
  const blockers = [];
  const {
    packageRecoveryDeletionLeaseResumeRequestHash = null,
    ...payload
  } = request || {};
  if (!hasExactPlainObjectKeys(request, REQUEST_KEYS)
    || request?.version !== 1
    || request.kind !== 'PackageRecoveryDeletionLeaseResumeRequest'
    || !validHash(request.acquireRequestHash)
    || !validHash(request.challengeHash)
    || !OPERATION_ID.test(String(request.operationId || ''))
    || !validHash(request.deletionOperationHash)
    || !TERMINAL_ACTIONS.has(request.action)
    || !validHash(request.commandIdHash)
    || !terminalShape(request)
    || !validHash(packageRecoveryDeletionLeaseResumeRequestHash)
    || hashRecord('PackageRecoveryDeletionLeaseResumeRequest', payload)
      !== packageRecoveryDeletionLeaseResumeRequestHash) {
    blockers.push('package_recovery_deletion_lease_resume_request_invalid');
  }
  if (acquireRequest
    && (!verifyPackageRecoveryDeletionLeaseAcquireRequest(acquireRequest).valid
      || !sameRequestBinding(request, acquireRequest))) {
    blockers.push('package_recovery_deletion_lease_resume_request_binding_invalid');
  }
  return result(blockers);
}

function copiedResolutionPayload({
  status,
  resumeRequest,
  acquireRequest,
  handle,
  terminalCommand,
  terminalReceipt,
  providerAttestationHash,
}) {
  const terminal = status === 'package_recovery_deletion_lease_resume_terminal';
  return {
    version: 1,
    kind: 'PackageRecoveryDeletionLeaseResumeResolution',
    status,
    resumeRequestHash:
      resumeRequest?.packageRecoveryDeletionLeaseResumeRequestHash,
    acquireRequestHash:
      acquireRequest?.packageRecoveryDeletionLeaseAcquireRequestHash,
    lease: Object.freeze({ ...(handle?.lease || {}) }),
    fenceToken: terminal ? null : handle?.fenceToken,
    terminalCommand: terminal
      ? Object.freeze({ ...(terminalCommand || {}) }) : null,
    terminalReceipt: terminal
      ? Object.freeze({ ...(terminalReceipt || {}) }) : null,
    providerAttestationHash,
  };
}

export function createPackageRecoveryDeletionLeaseResumeResolution({
  status,
  resumeRequest,
  acquireRequest,
  handle,
  terminalCommand = null,
  terminalReceipt = null,
  providerAttestationHash,
} = {}) {
  const resolution = seal(
    'PackageRecoveryDeletionLeaseResumeResolution',
    'packageRecoveryDeletionLeaseResumeResolutionHash',
    copiedResolutionPayload({
      status,
      resumeRequest,
      acquireRequest,
      handle,
      terminalCommand,
      terminalReceipt,
      providerAttestationHash,
    }),
  );
  if (!verifyPackageRecoveryDeletionLeaseResumeResolution(resolution, {
    acquireRequest,
    resumeRequest,
  }).valid) {
    throw new Error('package_recovery_deletion_lease_resume_resolution_invalid');
  }
  return resolution;
}

function activeResolutionValid(resolution, acquireRequest) {
  return resolution.status === 'package_recovery_deletion_lease_resume_active'
    && typeof resolution.fenceToken === 'string'
    && resolution.terminalCommand === null
    && resolution.terminalReceipt === null
    && verifyPackageRecoveryDeletionLease(resolution.lease, {
      request: acquireRequest,
      fenceToken: resolution.fenceToken,
    }).valid;
}

function terminalResolutionValid(resolution, acquireRequest, resumeRequest) {
  return resolution.status === 'package_recovery_deletion_lease_resume_terminal'
    && resolution.fenceToken === null
    && verifyPackageRecoveryDeletionLease(resolution.lease, {
      request: acquireRequest,
    }).valid
    && verifyPackageRecoveryDeletionLeaseCommand(
      resolution.terminalCommand,
      { lease: resolution.lease },
    ).valid
    && sameTerminalBinding(resumeRequest, resolution.terminalCommand)
    && verifyPackageRecoveryDeletionLeaseOperationReceipt(
      resolution.terminalReceipt,
      {
        lease: resolution.lease,
        command: resolution.terminalCommand,
        observedAt: resolution.terminalReceipt?.checkedAt,
      },
    ).valid;
}

export function verifyPackageRecoveryDeletionLeaseResumeResolution(
  resolution,
  { acquireRequest = null, resumeRequest = null } = {},
) {
  const blockers = [];
  const {
    packageRecoveryDeletionLeaseResumeResolutionHash = null,
    ...payload
  } = resolution || {};
  const requestValid = verifyPackageRecoveryDeletionLeaseAcquireRequest(
    acquireRequest,
  ).valid;
  const resumeValid = verifyPackageRecoveryDeletionLeaseResumeRequest(
    resumeRequest,
    { acquireRequest },
  ).valid;
  const stateValid = requestValid && resumeValid
    && (activeResolutionValid(resolution, acquireRequest)
      || terminalResolutionValid(resolution, acquireRequest, resumeRequest));
  if (!hasExactPlainObjectKeys(resolution, RESOLUTION_KEYS)
    || resolution?.version !== 1
    || resolution.kind !== 'PackageRecoveryDeletionLeaseResumeResolution'
    || resolution.resumeRequestHash
      !== resumeRequest?.packageRecoveryDeletionLeaseResumeRequestHash
    || resolution.acquireRequestHash
      !== acquireRequest?.packageRecoveryDeletionLeaseAcquireRequestHash
    || !hasExactPlainObjectKeys(
      { lease: resolution.lease, fenceToken: resolution.fenceToken },
      HANDLE_KEYS,
    )
    || !validHash(resolution.providerAttestationHash)
    || !stateValid
    || !validHash(packageRecoveryDeletionLeaseResumeResolutionHash)
    || hashRecord('PackageRecoveryDeletionLeaseResumeResolution', payload)
      !== packageRecoveryDeletionLeaseResumeResolutionHash) {
    blockers.push('package_recovery_deletion_lease_resume_resolution_invalid');
  }
  return result(blockers);
}
