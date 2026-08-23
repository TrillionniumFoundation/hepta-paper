import { hasExactPlainObjectKeys }
  from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;

export const PACKAGE_RECOVERY_DELETION_LEASE_COMMAND_ACTIONS = Object.freeze([
  'assert',
  'renew',
  'commit',
  'abort_release',
]);

const ACTIONS = new Set(PACKAGE_RECOVERY_DELETION_LEASE_COMMAND_ACTIONS);
const BINDING_FIELDS = Object.freeze([
  'challengeHash',
  'operationId',
  'deletionOperationHash',
  'packageLifecycleReceiptHash',
  'packageRetentionRecoveryReceiptHash',
  'authoritySnapshotHash',
  'storageAuthorityId',
  'storageObjectId',
  'storageObjectVersion',
  'storageObjectBytesHash',
  'retentionLockVersion',
  'retentionLockIdentityHash',
  'retainUntil',
  'storageLedgerReceiptId',
  'storageLedgerReceiptHash',
  'trustStoreHash',
]);
const ACQUIRE_REQUEST_KEYS = Object.freeze([
  'version', 'kind', ...BINDING_FIELDS, 'requestedAt',
  'minimumRemainingHorizonMs',
  'packageRecoveryDeletionLeaseAcquireRequestHash',
]);
const LEASE_KEYS = Object.freeze([
  'version', 'kind', 'status', 'issuance', ...BINDING_FIELDS,
  'acquireRequestHash', 'authorityRequestHash', 'leaseId', 'generation',
  'fenceTokenHash', 'previousLeaseHash', 'issuedAt', 'expiresAt',
  'providerAttestationHash', 'packageRecoveryDeletionLeaseHash',
]);
const COMMAND_KEYS = Object.freeze([
  'version', 'kind', 'action', 'challengeHash', 'operationId',
  'deletionOperationHash', 'packageRecoveryDeletionLeaseHash', 'leaseId',
  'generation', 'fenceTokenHash', 'commandIdHash', 'requestedAt',
  'minimumRemainingHorizonMs', 'localDeletedFenceHash', 'abortReasonHash',
  'packageRecoveryDeletionLeaseCommandHash',
]);
const OPERATION_RECEIPT_KEYS = Object.freeze([
  'version', 'kind', 'status', 'action', 'challengeHash', 'operationId',
  'deletionOperationHash', 'packageRecoveryDeletionLeaseHash', 'leaseId',
  'generation', 'fenceTokenHash', 'commandHash', 'checkedAt', 'expiresAt',
  'authoritySnapshotHash', 'localDeletedFenceHash', 'abortReasonHash',
  'providerAttestationHash',
  'packageRecoveryDeletionLeaseOperationReceiptHash',
]);

function result(blockers) {
  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

function validHash(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function validIdentifier(value) {
  return typeof value === 'string'
    && value.trim() === value
    && value.length >= 1
    && value.length <= 512
    && ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 31 || codePoint === 127;
    });
}

function canonicalTime(value) {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function validHorizon(value, { allowZero = false } = {}) {
  return Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0);
}

function exactBinding(value) {
  return Boolean(value
    && validHash(value.challengeHash)
    && OPERATION_ID.test(String(value.operationId || ''))
    && validHash(value.deletionOperationHash)
    && validHash(value.packageLifecycleReceiptHash)
    && validHash(value.packageRetentionRecoveryReceiptHash)
    && validHash(value.authoritySnapshotHash)
    && validIdentifier(value.storageAuthorityId)
    && validIdentifier(value.storageObjectId)
    && validIdentifier(value.storageObjectVersion)
    && validHash(value.storageObjectBytesHash)
    && validIdentifier(value.retentionLockVersion)
    && validHash(value.retentionLockIdentityHash)
    && canonicalTime(value.retainUntil)
    && validIdentifier(value.storageLedgerReceiptId)
    && validHash(value.storageLedgerReceiptHash)
    && validHash(value.trustStoreHash));
}

function sameBinding(left, right) {
  return Boolean(left && right
    && BINDING_FIELDS.every((field) => left[field] === right[field]));
}

function seal(kind, hashField, payload) {
  return Object.freeze({
    ...payload,
    [hashField]: hashRecord(kind, payload),
  });
}

function assertValid(verification, blocker) {
  if (!verification.valid) throw new Error(blocker);
}

export function packageRecoveryDeletionLeaseFenceTokenHash(fenceToken) {
  if (typeof fenceToken !== 'string'
    || fenceToken.length < 32
    || fenceToken.length > 512
    || [...fenceToken].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 32 || codePoint === 127;
    })) {
    throw new Error('package_recovery_deletion_lease_fence_token_invalid');
  }
  return hashRecord('PackageRecoveryDeletionLeaseFenceToken', { fenceToken });
}

export function createPackageRecoveryDeletionLeaseAcquireRequest({
  challengeHash,
  operationId,
  deletionOperationHash,
  packageLifecycleReceiptHash,
  packageRetentionRecoveryReceiptHash,
  authoritySnapshotHash,
  storageAuthorityId,
  storageObjectId,
  storageObjectVersion,
  storageObjectBytesHash,
  retentionLockVersion,
  retentionLockIdentityHash,
  retainUntil,
  storageLedgerReceiptId,
  storageLedgerReceiptHash,
  trustStoreHash,
  requestedAt,
  minimumRemainingHorizonMs,
} = {}) {
  const payload = {
    version: 1,
    kind: 'PackageRecoveryDeletionLeaseAcquireRequest',
    challengeHash,
    operationId,
    deletionOperationHash,
    packageLifecycleReceiptHash,
    packageRetentionRecoveryReceiptHash,
    authoritySnapshotHash,
    storageAuthorityId,
    storageObjectId,
    storageObjectVersion,
    storageObjectBytesHash,
    retentionLockVersion,
    retentionLockIdentityHash,
    retainUntil,
    storageLedgerReceiptId,
    storageLedgerReceiptHash,
    trustStoreHash,
    requestedAt,
    minimumRemainingHorizonMs,
  };
  const request = seal(
    'PackageRecoveryDeletionLeaseAcquireRequest',
    'packageRecoveryDeletionLeaseAcquireRequestHash',
    payload,
  );
  assertValid(
    verifyPackageRecoveryDeletionLeaseAcquireRequest(request),
    'package_recovery_deletion_lease_acquire_request_invalid',
  );
  return request;
}

export function verifyPackageRecoveryDeletionLeaseAcquireRequest(request) {
  const blockers = [];
  const {
    packageRecoveryDeletionLeaseAcquireRequestHash = null,
    ...payload
  } = request || {};
  if (!hasExactPlainObjectKeys(request, ACQUIRE_REQUEST_KEYS)
    || request?.version !== 1
    || request.kind !== 'PackageRecoveryDeletionLeaseAcquireRequest'
    || !exactBinding(request)
    || !canonicalTime(request.requestedAt)
    || !validHorizon(request.minimumRemainingHorizonMs)
    || Date.parse(request.retainUntil) - Date.parse(request.requestedAt)
      < request.minimumRemainingHorizonMs
    || !validHash(packageRecoveryDeletionLeaseAcquireRequestHash)
    || hashRecord('PackageRecoveryDeletionLeaseAcquireRequest', payload)
      !== packageRecoveryDeletionLeaseAcquireRequestHash) {
    blockers.push('package_recovery_deletion_lease_acquire_request_invalid');
  }
  return result(blockers);
}

function leasePayload({
  request,
  previousLease,
  renewCommand,
  leaseId,
  generation,
  fenceToken,
  issuedAt,
  expiresAt,
  providerAttestationHash,
}) {
  const acquired = !previousLease;
  const source = acquired ? request : previousLease;
  return {
    version: 1,
    kind: 'PackageRecoveryDeletionLease',
    status: 'package_recovery_deletion_lease_active',
    issuance: acquired ? 'acquired' : 'renewed',
    ...Object.fromEntries(BINDING_FIELDS.map((field) => [field, source?.[field]])),
    acquireRequestHash: acquired
      ? request?.packageRecoveryDeletionLeaseAcquireRequestHash
      : previousLease?.acquireRequestHash,
    authorityRequestHash: acquired
      ? request?.packageRecoveryDeletionLeaseAcquireRequestHash
      : renewCommand?.packageRecoveryDeletionLeaseCommandHash,
    leaseId,
    generation,
    fenceTokenHash: packageRecoveryDeletionLeaseFenceTokenHash(fenceToken),
    previousLeaseHash: acquired
      ? null
      : previousLease?.packageRecoveryDeletionLeaseHash,
    issuedAt,
    expiresAt,
    providerAttestationHash,
  };
}

export function createPackageRecoveryDeletionLease({
  request,
  leaseId,
  generation = 1,
  fenceToken,
  issuedAt,
  expiresAt,
  providerAttestationHash,
} = {}) {
  assertValid(
    verifyPackageRecoveryDeletionLeaseAcquireRequest(request),
    'package_recovery_deletion_lease_acquire_request_invalid',
  );
  const lease = seal(
    'PackageRecoveryDeletionLease',
    'packageRecoveryDeletionLeaseHash',
    leasePayload({
      request,
      leaseId,
      generation,
      fenceToken,
      issuedAt,
      expiresAt,
      providerAttestationHash,
    }),
  );
  assertValid(
    verifyPackageRecoveryDeletionLease(lease, { request, fenceToken }),
    'package_recovery_deletion_lease_invalid',
  );
  return lease;
}

export function renewPackageRecoveryDeletionLease({
  previousLease,
  renewCommand,
  fenceToken,
  issuedAt,
  expiresAt,
  providerAttestationHash,
} = {}) {
  assertValid(
    verifyPackageRecoveryDeletionLease(previousLease),
    'package_recovery_deletion_lease_invalid',
  );
  assertValid(
    verifyPackageRecoveryDeletionLeaseCommand(renewCommand, {
      lease: previousLease,
    }),
    'package_recovery_deletion_lease_renew_command_invalid',
  );
  if (renewCommand.action !== 'renew') {
    throw new Error('package_recovery_deletion_lease_renew_command_invalid');
  }
  const lease = seal(
    'PackageRecoveryDeletionLease',
    'packageRecoveryDeletionLeaseHash',
    leasePayload({
      previousLease,
      renewCommand,
      leaseId: previousLease.leaseId,
      generation: previousLease.generation + 1,
      fenceToken,
      issuedAt,
      expiresAt,
      providerAttestationHash,
    }),
  );
  assertValid(verifyPackageRecoveryDeletionLease(lease, {
    previousLease,
    renewCommand,
    fenceToken,
  }), 'package_recovery_deletion_lease_invalid');
  return lease;
}

export function verifyPackageRecoveryDeletionLease(lease, {
  request = null,
  previousLease = null,
  renewCommand = null,
  fenceToken = null,
  observedAt = null,
  minimumRemainingHorizonMs = null,
} = {}) {
  const blockers = [];
  const { packageRecoveryDeletionLeaseHash = null, ...payload } = lease || {};
  const acquired = lease?.issuance === 'acquired';
  const renewed = lease?.issuance === 'renewed';
  if (!hasExactPlainObjectKeys(lease, LEASE_KEYS)
    || lease?.version !== 1
    || lease.kind !== 'PackageRecoveryDeletionLease'
    || lease.status !== 'package_recovery_deletion_lease_active'
    || (!acquired && !renewed)
    || !exactBinding(lease)
    || !validHash(lease.acquireRequestHash)
    || !validHash(lease.authorityRequestHash)
    || !validHash(lease.leaseId)
    || !Number.isSafeInteger(lease.generation)
    || lease.generation < 1
    || !validHash(lease.fenceTokenHash)
    || !(lease.previousLeaseHash === null || validHash(lease.previousLeaseHash))
    || !canonicalTime(lease.issuedAt)
    || !canonicalTime(lease.expiresAt)
    || Date.parse(lease.expiresAt) <= Date.parse(lease.issuedAt)
    || Date.parse(lease.expiresAt) > Date.parse(lease.retainUntil)
    || !validHash(lease.providerAttestationHash)
    || !validHash(packageRecoveryDeletionLeaseHash)
    || hashRecord('PackageRecoveryDeletionLease', payload)
      !== packageRecoveryDeletionLeaseHash
    || (acquired && (lease.generation !== 1
      || lease.previousLeaseHash !== null
      || lease.authorityRequestHash !== lease.acquireRequestHash))
    || (renewed && (lease.generation < 2 || !validHash(lease.previousLeaseHash)))) {
    blockers.push('package_recovery_deletion_lease_invalid');
  }
  if (request && (!verifyPackageRecoveryDeletionLeaseAcquireRequest(request).valid
    || !sameBinding(lease, request)
    || lease.acquireRequestHash
      !== request.packageRecoveryDeletionLeaseAcquireRequestHash
    || (lease.issuance === 'acquired' && lease.authorityRequestHash
      !== request.packageRecoveryDeletionLeaseAcquireRequestHash)
    || Date.parse(lease.issuedAt) < Date.parse(request.requestedAt))) {
    blockers.push('package_recovery_deletion_lease_acquire_binding_invalid');
  }
  if (previousLease || renewCommand) {
    if (!verifyPackageRecoveryDeletionLease(previousLease).valid
      || !verifyPackageRecoveryDeletionLeaseCommand(renewCommand, {
        lease: previousLease,
      }).valid
      || renewCommand?.action !== 'renew'
      || lease?.issuance !== 'renewed'
      || !sameBinding(lease, previousLease)
      || lease.acquireRequestHash !== previousLease?.acquireRequestHash
      || lease.authorityRequestHash
        !== renewCommand?.packageRecoveryDeletionLeaseCommandHash
      || lease.leaseId !== previousLease?.leaseId
      || lease.generation !== previousLease?.generation + 1
      || lease.previousLeaseHash
        !== previousLease?.packageRecoveryDeletionLeaseHash
      || lease.fenceTokenHash === previousLease?.fenceTokenHash
      || Date.parse(lease.issuedAt) < Date.parse(renewCommand?.requestedAt || '')
      || Date.parse(lease.expiresAt) <= Date.parse(previousLease?.expiresAt || '')) {
      blockers.push('package_recovery_deletion_lease_renewal_binding_invalid');
    }
  }
  if (fenceToken !== null) {
    try {
      if (packageRecoveryDeletionLeaseFenceTokenHash(fenceToken)
        !== lease?.fenceTokenHash) {
        blockers.push('package_recovery_deletion_lease_fence_token_mismatch');
      }
    } catch {
      blockers.push('package_recovery_deletion_lease_fence_token_mismatch');
    }
  }
  if (observedAt !== null || minimumRemainingHorizonMs !== null) {
    if (!canonicalTime(observedAt)
      || !validHorizon(minimumRemainingHorizonMs)
      || Date.parse(lease?.issuedAt || '') > Date.parse(observedAt || '')
      || Date.parse(lease?.expiresAt || '') - Date.parse(observedAt || '')
        < minimumRemainingHorizonMs) {
      blockers.push('package_recovery_deletion_lease_horizon_invalid');
    }
  }
  return result(blockers);
}

function commandShape(action, minimumRemainingHorizonMs,
  localDeletedFenceHash, abortReasonHash) {
  if (action === 'assert' || action === 'renew') {
    return validHorizon(minimumRemainingHorizonMs)
      && localDeletedFenceHash === null && abortReasonHash === null;
  }
  if (action === 'commit') {
    return minimumRemainingHorizonMs === 0
      && validHash(localDeletedFenceHash) && abortReasonHash === null;
  }
  return action === 'abort_release'
    && minimumRemainingHorizonMs === 0
    && localDeletedFenceHash === null
    && validHash(abortReasonHash);
}

export function createPackageRecoveryDeletionLeaseCommand({
  lease,
  fenceToken,
  action,
  commandIdHash,
  requestedAt,
  minimumRemainingHorizonMs = 0,
  localDeletedFenceHash = null,
  abortReasonHash = null,
} = {}) {
  assertValid(
    verifyPackageRecoveryDeletionLease(lease, { fenceToken }),
    'package_recovery_deletion_lease_handle_invalid',
  );
  const payload = {
    version: 1,
    kind: 'PackageRecoveryDeletionLeaseCommand',
    action,
    challengeHash: lease.challengeHash,
    operationId: lease.operationId,
    deletionOperationHash: lease.deletionOperationHash,
    packageRecoveryDeletionLeaseHash: lease.packageRecoveryDeletionLeaseHash,
    leaseId: lease.leaseId,
    generation: lease.generation,
    fenceTokenHash: lease.fenceTokenHash,
    commandIdHash,
    requestedAt,
    minimumRemainingHorizonMs,
    localDeletedFenceHash,
    abortReasonHash,
  };
  const command = seal(
    'PackageRecoveryDeletionLeaseCommand',
    'packageRecoveryDeletionLeaseCommandHash',
    payload,
  );
  assertValid(
    verifyPackageRecoveryDeletionLeaseCommand(command, { lease, fenceToken }),
    'package_recovery_deletion_lease_command_invalid',
  );
  return command;
}

export function verifyPackageRecoveryDeletionLeaseCommand(command, {
  lease = null,
  fenceToken = null,
} = {}) {
  const blockers = [];
  const { packageRecoveryDeletionLeaseCommandHash = null, ...payload } = command || {};
  if (!hasExactPlainObjectKeys(command, COMMAND_KEYS)
    || command?.version !== 1
    || command.kind !== 'PackageRecoveryDeletionLeaseCommand'
    || !ACTIONS.has(command.action)
    || !validHash(command.challengeHash)
    || !OPERATION_ID.test(String(command.operationId || ''))
    || !validHash(command.deletionOperationHash)
    || !validHash(command.packageRecoveryDeletionLeaseHash)
    || !validHash(command.leaseId)
    || !Number.isSafeInteger(command.generation)
    || command.generation < 1
    || !validHash(command.fenceTokenHash)
    || !validHash(command.commandIdHash)
    || !canonicalTime(command.requestedAt)
    || !commandShape(command.action, command.minimumRemainingHorizonMs,
      command.localDeletedFenceHash, command.abortReasonHash)
    || !validHash(packageRecoveryDeletionLeaseCommandHash)
    || hashRecord('PackageRecoveryDeletionLeaseCommand', payload)
      !== packageRecoveryDeletionLeaseCommandHash) {
    blockers.push('package_recovery_deletion_lease_command_invalid');
  }
  if (lease && (!verifyPackageRecoveryDeletionLease(lease).valid
    || command?.challengeHash !== lease.challengeHash
    || command?.operationId !== lease.operationId
    || command?.deletionOperationHash !== lease.deletionOperationHash
    || command?.packageRecoveryDeletionLeaseHash
      !== lease.packageRecoveryDeletionLeaseHash
    || command?.leaseId !== lease.leaseId
    || command?.generation !== lease.generation
    || command?.fenceTokenHash !== lease.fenceTokenHash
    || Date.parse(command?.requestedAt || '') < Date.parse(lease.issuedAt))) {
    blockers.push('package_recovery_deletion_lease_command_binding_invalid');
  }
  if (fenceToken !== null) {
    try {
      if (packageRecoveryDeletionLeaseFenceTokenHash(fenceToken)
        !== command?.fenceTokenHash) {
        blockers.push('package_recovery_deletion_lease_fence_token_mismatch');
      }
    } catch {
      blockers.push('package_recovery_deletion_lease_fence_token_mismatch');
    }
  }
  return result(blockers);
}

const RECEIPT_STATUS = Object.freeze({
  assert: 'package_recovery_deletion_lease_asserted',
  commit: 'package_recovery_deletion_lease_committed',
  abort_release: 'package_recovery_deletion_lease_aborted_released',
});

export function createPackageRecoveryDeletionLeaseOperationReceipt({
  lease,
  command,
  checkedAt,
  providerAttestationHash,
} = {}) {
  assertValid(
    verifyPackageRecoveryDeletionLeaseCommand(command, { lease }),
    'package_recovery_deletion_lease_command_invalid',
  );
  if (!Object.hasOwn(RECEIPT_STATUS, command.action)) {
    throw new Error('package_recovery_deletion_lease_operation_action_invalid');
  }
  const payload = {
    version: 1,
    kind: 'PackageRecoveryDeletionLeaseOperationReceipt',
    status: RECEIPT_STATUS[command.action],
    action: command.action,
    challengeHash: lease.challengeHash,
    operationId: lease.operationId,
    deletionOperationHash: lease.deletionOperationHash,
    packageRecoveryDeletionLeaseHash: lease.packageRecoveryDeletionLeaseHash,
    leaseId: lease.leaseId,
    generation: lease.generation,
    fenceTokenHash: lease.fenceTokenHash,
    commandHash: command.packageRecoveryDeletionLeaseCommandHash,
    checkedAt,
    expiresAt: lease.expiresAt,
    authoritySnapshotHash: lease.authoritySnapshotHash,
    localDeletedFenceHash: command.localDeletedFenceHash,
    abortReasonHash: command.abortReasonHash,
    providerAttestationHash,
  };
  const receipt = seal(
    'PackageRecoveryDeletionLeaseOperationReceipt',
    'packageRecoveryDeletionLeaseOperationReceiptHash',
    payload,
  );
  assertValid(verifyPackageRecoveryDeletionLeaseOperationReceipt(receipt, {
    lease,
    command,
  }), 'package_recovery_deletion_lease_operation_receipt_invalid');
  return receipt;
}

export function verifyPackageRecoveryDeletionLeaseOperationReceipt(receipt, {
  lease = null,
  command = null,
  observedAt = null,
} = {}) {
  const blockers = [];
  const {
    packageRecoveryDeletionLeaseOperationReceiptHash = null,
    ...payload
  } = receipt || {};
  if (!hasExactPlainObjectKeys(receipt, OPERATION_RECEIPT_KEYS)
    || receipt?.version !== 1
    || receipt.kind !== 'PackageRecoveryDeletionLeaseOperationReceipt'
    || !Object.hasOwn(RECEIPT_STATUS, receipt.action)
    || receipt.status !== RECEIPT_STATUS[receipt.action]
    || !validHash(receipt.challengeHash)
    || !OPERATION_ID.test(String(receipt.operationId || ''))
    || !validHash(receipt.deletionOperationHash)
    || !validHash(receipt.packageRecoveryDeletionLeaseHash)
    || !validHash(receipt.leaseId)
    || !Number.isSafeInteger(receipt.generation)
    || receipt.generation < 1
    || !validHash(receipt.fenceTokenHash)
    || !validHash(receipt.commandHash)
    || !canonicalTime(receipt.checkedAt)
    || !canonicalTime(receipt.expiresAt)
    || !validHash(receipt.authoritySnapshotHash)
    || !commandShape(receipt.action,
      receipt.action === 'assert' ? 1 : 0,
      receipt.localDeletedFenceHash, receipt.abortReasonHash)
    || !validHash(receipt.providerAttestationHash)
    || !validHash(packageRecoveryDeletionLeaseOperationReceiptHash)
    || hashRecord('PackageRecoveryDeletionLeaseOperationReceipt', payload)
      !== packageRecoveryDeletionLeaseOperationReceiptHash) {
    blockers.push('package_recovery_deletion_lease_operation_receipt_invalid');
  }
  if (lease || command) {
    if (!verifyPackageRecoveryDeletionLease(lease).valid
      || !verifyPackageRecoveryDeletionLeaseCommand(command, { lease }).valid
      || receipt?.action !== command?.action
      || receipt?.challengeHash !== lease?.challengeHash
      || receipt?.operationId !== lease?.operationId
      || receipt?.deletionOperationHash !== lease?.deletionOperationHash
      || receipt?.packageRecoveryDeletionLeaseHash
        !== lease?.packageRecoveryDeletionLeaseHash
      || receipt?.leaseId !== lease?.leaseId
      || receipt?.generation !== lease?.generation
      || receipt?.fenceTokenHash !== lease?.fenceTokenHash
      || receipt?.commandHash
        !== command?.packageRecoveryDeletionLeaseCommandHash
      || receipt?.expiresAt !== lease?.expiresAt
      || receipt?.authoritySnapshotHash !== lease?.authoritySnapshotHash
      || receipt?.localDeletedFenceHash !== command?.localDeletedFenceHash
      || receipt?.abortReasonHash !== command?.abortReasonHash
      || Date.parse(receipt?.checkedAt || '') < Date.parse(command?.requestedAt || '')) {
      blockers.push('package_recovery_deletion_lease_operation_binding_invalid');
    }
  }
  if (observedAt !== null) {
    const allowsExpiredRelease = receipt?.action === 'abort_release';
    if (!canonicalTime(observedAt)
      || Date.parse(receipt?.checkedAt || '') > Date.parse(observedAt || '')
      || (!allowsExpiredRelease
        && Date.parse(observedAt || '') > Date.parse(receipt?.expiresAt || ''))
      || (receipt?.action === 'assert'
        && Date.parse(receipt?.expiresAt || '') - Date.parse(observedAt || '')
          < command?.minimumRemainingHorizonMs)) {
      blockers.push('package_recovery_deletion_lease_operation_horizon_invalid');
    }
  }
  return result(blockers);
}
