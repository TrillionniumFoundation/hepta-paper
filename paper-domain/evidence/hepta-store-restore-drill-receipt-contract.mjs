import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const PASSED = 'hepta_store_restore_drill_passed';
const BLOCKED = 'hepta_store_restore_drill_blocked';
const LEDGER_SUBJECT_ROLE = 'administrative_ledger_subject';
const COMPLETION_ROLE = 'completion';

const LEGACY_V2_KEYS = Object.freeze([
  'backupLedgerReceiptId', 'backupLedgerReceiptSha256', 'backupPath', 'backupSha256',
  'foreignKeyViolationCount', 'hashMatches', 'kind', 'performedAt',
  'productionStoreMutated', 'quickCheck', 'status', 'version',
]);

const V3_LEDGER_SUBJECT_KEYS = Object.freeze([
  'backupLedgerReceiptId', 'backupLedgerReceiptSha256', 'backupPath', 'backupSha256',
  'businessProjectionComparisonPerformed', 'concurrentBusinessStateChangesAttested',
  'foreignKeyViolationCount', 'hashMatches', 'kind', 'liveDatabaseHashMethod',
  'liveDatabaseSha256Before', 'performedAt', 'quickCheck', 'receiptRole',
  'restoreDrillAdministrativeWritePerformed', 'restoreDrillBusinessWritePerformed',
  'status', 'version', 'writerQuiescenceAttested',
]);

const V3_COMPLETION_KEYS = Object.freeze([
  ...V3_LEDGER_SUBJECT_KEYS,
  'administrativeLedgerReceipt', 'completionReceiptSha256',
  'diagnosticAfterHashAssurance', 'diagnosticAfterHashLedgerAuthenticated',
  'diagnosticLiveDatabaseSha256After',
]);

const LEDGER_IDENTITY_KEYS = Object.freeze(['receiptId', 'receiptSha256']);

function canonicalInstant(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validRestoreResult(receipt, { requireBlockedEvidence = false } = {}) {
  const foreignKeyViolationCount = receipt?.foreignKeyViolationCount;
  const checksPassed = receipt?.hashMatches === true
    && receipt?.quickCheck === 'ok'
    && foreignKeyViolationCount === 0;
  return [PASSED, BLOCKED].includes(receipt?.status)
    && (receipt.status !== PASSED || checksPassed)
    && (!requireBlockedEvidence || receipt.status !== BLOCKED || !checksPassed)
    && typeof receipt?.hashMatches === 'boolean'
    && typeof receipt?.quickCheck === 'string'
    && receipt.quickCheck.length > 0
    && (foreignKeyViolationCount === null
      || (Number.isSafeInteger(foreignKeyViolationCount) && foreignKeyViolationCount >= 0));
}

function validBackupBinding(receipt) {
  return typeof receipt?.backupPath === 'string'
    && receipt.backupPath.length > 0
    && SHA256.test(String(receipt.backupSha256 || ''))
    && SHA256.test(String(receipt.backupLedgerReceiptSha256 || ''))
    && receipt.backupLedgerReceiptId
      === `store-admin:${receipt.backupLedgerReceiptSha256}`
    && canonicalInstant(receipt.performedAt);
}

function ledgerSubjectFromCompletion(receipt) {
  return Object.freeze(Object.fromEntries(V3_LEDGER_SUBJECT_KEYS.map((key) => [
    key,
    key === 'receiptRole' ? LEDGER_SUBJECT_ROLE : receipt?.[key],
  ])));
}

function validV3LedgerSubject(receipt) {
  return hasExactObjectKeys(receipt, V3_LEDGER_SUBJECT_KEYS)
    && receipt.version === 3
    && receipt.kind === 'HeptaStoreRestoreDrillReceipt'
    && receipt.receiptRole === LEDGER_SUBJECT_ROLE
    && receipt.liveDatabaseHashMethod === 'sqlite_online_backup_sha256_v1'
    && SHA256.test(String(receipt.liveDatabaseSha256Before || ''))
    && receipt.restoreDrillBusinessWritePerformed === false
    && receipt.restoreDrillAdministrativeWritePerformed === true
    && receipt.concurrentBusinessStateChangesAttested === false
    && receipt.writerQuiescenceAttested === false
    && receipt.businessProjectionComparisonPerformed === false
    && validBackupBinding(receipt)
    && validRestoreResult(receipt, { requireBlockedEvidence: true });
}

export function buildHeptaStoreRestoreDrillLedgerSubjectV3({
  status,
  backupPath,
  backupSha256,
  backupLedgerReceiptSha256,
  backupLedgerReceiptId,
  hashMatches,
  quickCheck,
  foreignKeyViolationCount,
  performedAt,
  liveDatabaseSha256Before,
} = {}) {
  const receipt = Object.freeze({
    version: 3,
    kind: 'HeptaStoreRestoreDrillReceipt',
    receiptRole: LEDGER_SUBJECT_ROLE,
    status,
    backupPath,
    backupSha256,
    backupLedgerReceiptSha256,
    backupLedgerReceiptId,
    hashMatches,
    quickCheck,
    foreignKeyViolationCount,
    performedAt,
    liveDatabaseHashMethod: 'sqlite_online_backup_sha256_v1',
    liveDatabaseSha256Before,
    restoreDrillBusinessWritePerformed: false,
    restoreDrillAdministrativeWritePerformed: true,
    concurrentBusinessStateChangesAttested: false,
    writerQuiescenceAttested: false,
    businessProjectionComparisonPerformed: false,
  });
  if (!validV3LedgerSubject(receipt)) {
    throw new Error('hepta_store_restore_drill_ledger_subject_invalid');
  }
  return receipt;
}

export function buildHeptaStoreRestoreDrillCompletionReceiptV3({
  ledgerSubject,
  diagnosticLiveDatabaseSha256After,
  ledgerReceipt,
} = {}) {
  if (!validV3LedgerSubject(ledgerSubject)
    || !SHA256.test(String(diagnosticLiveDatabaseSha256After || ''))
    || diagnosticLiveDatabaseSha256After === ledgerSubject.liveDatabaseSha256Before) {
    throw new Error('hepta_store_restore_drill_diagnostic_after_hash_invalid');
  }
  const expectedLedgerReceiptSha256 = hashRecord(
    'HeptaStoreRestoreDrillReceipt',
    ledgerSubject,
  );
  const administrativeLedgerReceipt = Object.freeze({
    receiptId: ledgerReceipt?.receiptId,
    receiptSha256: ledgerReceipt?.receiptHash,
  });
  if (administrativeLedgerReceipt.receiptSha256 !== expectedLedgerReceiptSha256
    || administrativeLedgerReceipt.receiptId
      !== `store-admin:${expectedLedgerReceiptSha256}`) {
    throw new Error('hepta_store_restore_drill_ledger_identity_invalid');
  }
  const payload = Object.freeze({
    ...ledgerSubject,
    receiptRole: COMPLETION_ROLE,
    diagnosticLiveDatabaseSha256After,
    diagnosticAfterHashAssurance: 'completion_self_hash_only',
    diagnosticAfterHashLedgerAuthenticated: false,
    administrativeLedgerReceipt,
  });
  const receipt = Object.freeze({
    ...payload,
    completionReceiptSha256: hashRecord(
      'HeptaStoreRestoreDrillCompletionReceiptV3',
      payload,
    ),
  });
  const verification = verifyHeptaStoreRestoreDrillReceipt(receipt);
  if (!verification.valid) {
    throw new Error(`hepta_store_restore_drill_completion_receipt_invalid:${verification.blockers.join(',')}`);
  }
  return receipt;
}

export function verifyHeptaStoreRestoreDrillReceipt(receipt) {
  if (receipt?.version === 2) {
    const valid = hasExactObjectKeys(receipt, LEGACY_V2_KEYS)
      && receipt.kind === 'HeptaStoreRestoreDrillReceipt'
      && receipt.productionStoreMutated === false
      && validBackupBinding(receipt)
      && validRestoreResult(receipt);
    return Object.freeze({
      valid,
      version: 2,
      legacy: true,
      ledgerSubject: valid ? receipt : null,
      administrativeLedgerReceipt: null,
      completionSelfHashValid: null,
      diagnosticAfterHashAssurance: null,
      diagnosticAfterHashLedgerAuthenticated: null,
      blockers: valid ? [] : ['hepta_store_restore_drill_legacy_v2_invalid'],
    });
  }

  const blockers = [];
  if (!hasExactObjectKeys(receipt, V3_COMPLETION_KEYS)
    || receipt?.version !== 3
    || receipt?.kind !== 'HeptaStoreRestoreDrillReceipt'
    || receipt?.receiptRole !== COMPLETION_ROLE) {
    blockers.push('hepta_store_restore_drill_v3_shape_invalid');
  }
  const ledgerSubject = ledgerSubjectFromCompletion(receipt);
  const ledgerSubjectValid = validV3LedgerSubject(ledgerSubject);
  if (!ledgerSubjectValid) {
    blockers.push('hepta_store_restore_drill_v3_ledger_subject_invalid');
  }
  const diagnosticAfterHashValid = SHA256.test(
    String(receipt?.diagnosticLiveDatabaseSha256After || ''),
  )
    && receipt?.diagnosticLiveDatabaseSha256After !== receipt?.liveDatabaseSha256Before
    && receipt?.diagnosticAfterHashAssurance === 'completion_self_hash_only'
    && receipt?.diagnosticAfterHashLedgerAuthenticated === false;
  if (!diagnosticAfterHashValid) {
    blockers.push('hepta_store_restore_drill_v3_diagnostic_after_hash_invalid');
  }
  const expectedLedgerReceiptSha256 = ledgerSubjectValid
    ? hashRecord('HeptaStoreRestoreDrillReceipt', ledgerSubject) : null;
  const ledgerIdentityValid = hasExactObjectKeys(
    receipt?.administrativeLedgerReceipt,
    LEDGER_IDENTITY_KEYS,
  )
    && receipt?.administrativeLedgerReceipt?.receiptSha256 === expectedLedgerReceiptSha256
    && receipt?.administrativeLedgerReceipt?.receiptId
      === `store-admin:${expectedLedgerReceiptSha256}`;
  if (!ledgerIdentityValid) {
    blockers.push('hepta_store_restore_drill_v3_ledger_identity_invalid');
  }
  const { completionReceiptSha256, ...completionPayload } = receipt || {};
  const completionSelfHashValid = SHA256.test(String(completionReceiptSha256 || ''))
    && completionReceiptSha256 === hashRecord(
      'HeptaStoreRestoreDrillCompletionReceiptV3',
      completionPayload,
    );
  if (!completionSelfHashValid) {
    blockers.push('hepta_store_restore_drill_v3_completion_hash_invalid');
  }
  return Object.freeze({
    valid: blockers.length === 0,
    version: receipt?.version ?? null,
    legacy: false,
    ledgerSubject: ledgerSubjectValid ? ledgerSubject : null,
    administrativeLedgerReceipt: ledgerIdentityValid
      ? receipt.administrativeLedgerReceipt : null,
    completionSelfHashValid,
    diagnosticAfterHashAssurance: diagnosticAfterHashValid
      ? receipt.diagnosticAfterHashAssurance : null,
    diagnosticAfterHashLedgerAuthenticated: false,
    blockers: Object.freeze(blockers),
  });
}
