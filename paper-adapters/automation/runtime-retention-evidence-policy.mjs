import fs from 'node:fs';
import path from 'node:path';
import { receiptIssuerPolicies } from '../persistence/receipt-issuer-policy.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { readRegularJsonFileSync } from '../runtime/pinned-file-reader.mjs';
import {
  listRuntimeRetentionEntries,
  retentionMemberHash,
} from './runtime-retention-scope-repository.mjs';

const STORE_ADMIN_POLICY = receiptIssuerPolicies()['store-administrator'];

function receiptJson(row) {
  try {
    return JSON.parse(row?.receipt_json || '');
  } catch {
    return null;
  }
}

function ledgerIdentity(receiptLedger, receipt, evidenceClass) {
  if (!receipt?.kind) return Object.freeze({ receiptHash: null, receiptId: null });
  if (typeof receiptLedger?.prepare === 'function') {
    try {
      const prepared = receiptLedger.prepare(receipt, {
        stream: 'store-admin',
        environment: 'administrative',
        evidenceClass,
      });
      return Object.freeze({ receiptHash: prepared.receiptHash, receiptId: prepared.receiptId });
    } catch {
      return Object.freeze({ receiptHash: hashRecord(receipt.kind, receipt), receiptId: null });
    }
  }
  const receiptHash = hashRecord(receipt.kind, receipt);
  return Object.freeze({ receiptHash, receiptId: `store-admin:${receiptHash}` });
}

export function trustedRetentionIssuerRow(row, {
  policyId,
  policy,
  stream = 'store-admin',
  evidenceClass,
  kind,
  receiptId,
  receiptHash,
  status,
}) {
  return Boolean(row
    && row.receipt_id === receiptId
    && row.receipt_sha256 === receiptHash
    && row.stream === stream
    && row.kind === kind
    && row.status === status
    && row.environment === 'administrative'
    && row.evidence_class === evidenceClass
    && Number(row.effective_receipt_usable) === 1
    && Number(row.writer_trusted) === 1
    && row.writer_id === policy.writerId
    && row.writer_kind === policy.writerKind
    && row.issuer_policy_id === policyId
    && row.issuer_policy_hash === policy.issuerPolicyHash
    && row.issuer_assurance === policy.assurance);
}

export function verifyBackupRetentionEvidence(entry, receiptLedger) {
  const blockers = [];
  const expectedSourcePath = path.resolve(path.dirname(entry.path), '..', 'hepta-paper.sqlite');
  const receiptPath = entry.companionPaths?.find((candidate) => candidate.endsWith('.sqlite.receipt.json')) || null;
  const restoreReceiptPath = entry.companionPaths?.find((candidate) => candidate.endsWith('.sqlite.restore-drill.receipt.json')) || null;
  const receipt = receiptPath ? readRegularJsonFileSync(receiptPath) : null;
  const restoreReceipt = restoreReceiptPath ? readRegularJsonFileSync(restoreReceiptPath) : null;
  const backupHash = fs.existsSync(entry.path) ? retentionMemberHash(entry.path) : null;
  if (!receipt) blockers.push('backup_receipt_missing_or_invalid');
  if (receipt?.version !== 1) blockers.push('backup_receipt_version_invalid');
  if (receipt?.kind !== 'HeptaStoreBackupReceipt') blockers.push('backup_receipt_kind_invalid');
  if (receipt?.status !== 'hepta_store_backup_recorded') blockers.push('backup_receipt_status_invalid');
  if (receipt && path.resolve(String(receipt.sourcePath || '')) !== expectedSourcePath) blockers.push('backup_receipt_source_path_mismatch');
  if (receipt && path.resolve(String(receipt.backupPath || '')) !== path.resolve(entry.path)) blockers.push('backup_receipt_path_mismatch');
  if (receipt?.backupSha256 !== backupHash) blockers.push('backup_receipt_hash_mismatch');
  if (receipt && Number(receipt.bytes) !== fs.statSync(entry.path).size) blockers.push('backup_receipt_size_mismatch');

  const backupIdentity = receipt ? ledgerIdentity(receiptLedger, receipt, 'backup') : { receiptHash: null, receiptId: null };
  const backupReceiptHash = backupIdentity.receiptHash;
  const backupReceiptId = backupIdentity.receiptId;
  const effective = backupReceiptId && receiptLedger?.get ? receiptLedger.get(backupReceiptId) : null;
  const effectiveJson = receiptJson(effective);
  if (!effective || Number(effective.effective_receipt_usable) !== 1) blockers.push('backup_effective_ledger_receipt_missing');
  if (effective && !trustedRetentionIssuerRow(effective, {
    policyId: 'store-administrator',
    policy: STORE_ADMIN_POLICY,
    evidenceClass: 'backup',
    kind: 'HeptaStoreBackupReceipt',
    receiptId: backupReceiptId,
    receiptHash: backupReceiptHash,
    status: receipt?.status,
  })) blockers.push('backup_effective_ledger_receipt_mismatch');
  if (effective && !effectiveJson) blockers.push('backup_effective_ledger_json_invalid');
  if (effectiveJson && ledgerIdentity(receiptLedger, effectiveJson, 'backup').receiptHash !== backupReceiptHash) blockers.push('backup_effective_ledger_json_hash_invalid');

  if (!restoreReceipt) blockers.push('backup_restore_drill_receipt_missing_or_invalid');
  const restoreIdentity = restoreReceipt ? ledgerIdentity(receiptLedger, restoreReceipt, 'restore_drill') : { receiptHash: null, receiptId: null };
  const restoreRow = restoreIdentity.receiptId && receiptLedger?.get ? receiptLedger.get(restoreIdentity.receiptId) : null;
  const restoreJson = receiptJson(restoreRow);
  const backupCreatedAt = Date.parse(receipt?.createdAt || '');
  const restorePerformedAt = Date.parse(restoreReceipt?.performedAt || '');
  const restorePayloadValid = restoreReceipt?.version === 2
    && restoreReceipt.kind === 'HeptaStoreRestoreDrillReceipt'
    && restoreReceipt.status === 'hepta_store_restore_drill_passed'
    && path.resolve(String(restoreReceipt.backupPath || '')) === path.resolve(entry.path)
    && restoreReceipt.backupSha256 === backupHash
    && restoreReceipt.backupLedgerReceiptSha256 === backupReceiptHash
    && restoreReceipt.backupLedgerReceiptId === backupReceiptId
    && restoreReceipt.hashMatches === true
    && restoreReceipt.quickCheck === 'ok'
    && Number(restoreReceipt.foreignKeyViolationCount) === 0
    && restoreReceipt.productionStoreMutated === false
    && Number.isFinite(backupCreatedAt)
    && Number.isFinite(restorePerformedAt)
    && restorePerformedAt >= backupCreatedAt;
  if (restoreReceipt && !restorePayloadValid) blockers.push('backup_restore_drill_receipt_invalid');
  if (restoreRow && !trustedRetentionIssuerRow(restoreRow, {
    policyId: 'store-administrator',
    policy: STORE_ADMIN_POLICY,
    evidenceClass: 'restore_drill',
    kind: 'HeptaStoreRestoreDrillReceipt',
    receiptId: restoreIdentity.receiptId,
    receiptHash: restoreIdentity.receiptHash,
    status: restoreReceipt?.status,
  })) blockers.push('backup_restore_drill_ledger_receipt_mismatch');
  if (restoreRow && !restoreJson) blockers.push('backup_restore_drill_ledger_json_invalid');
  if (restoreJson && ledgerIdentity(receiptLedger, restoreJson, 'restore_drill').receiptHash !== restoreIdentity.receiptHash) blockers.push('backup_restore_drill_ledger_json_hash_invalid');
  if (!restoreRow || !restorePayloadValid || !trustedRetentionIssuerRow(restoreRow, {
    policyId: 'store-administrator',
    policy: STORE_ADMIN_POLICY,
    evidenceClass: 'restore_drill',
    kind: 'HeptaStoreRestoreDrillReceipt',
    receiptId: restoreIdentity.receiptId,
    receiptHash: restoreIdentity.receiptHash,
    status: restoreReceipt?.status,
  })) blockers.push('backup_matching_restore_drill_missing');

  return Object.freeze({
    verified: blockers.length === 0,
    blockers,
    backupHash,
    backupReceiptHash,
    backupReceiptId,
    expectedSourcePath,
    restoreDrillReceiptId: restoreRow?.receipt_id || null,
  });
}

function recoverableBackupState(runtimeRoot, receiptLedger) {
  const { entries } = listRuntimeRetentionEntries(runtimeRoot, 'backups');
  const evidence = new Map(entries.map((entry) => [entry.path, verifyBackupRetentionEvidence(entry, receiptLedger)]));
  const recoverable = entries.filter((entry) => evidence.get(entry.path)?.verified === true);
  return Object.freeze({ entries, evidence, recoverable });
}

export function verifyBackupDeletionMinimum(runtimeRoot, entry, receiptLedger, minimumRecoverableGenerations) {
  if (!fs.existsSync(entry.path)) return Object.freeze({ allowed: true, recoverableCount: null, blockers: [] });
  const state = recoverableBackupState(runtimeRoot, receiptLedger);
  const currentEvidence = state.evidence.get(path.resolve(entry.path)) || state.evidence.get(entry.path);
  const minimum = Math.max(0, Number(minimumRecoverableGenerations || 0));
  const blockers = [];
  if (currentEvidence?.verified !== true) blockers.push(...(currentEvidence?.blockers || ['backup_retention_evidence_invalid']));
  if (state.recoverable.length - 1 < minimum) blockers.push('backup_minimum_recoverable_generations_would_be_violated');
  return Object.freeze({ allowed: blockers.length === 0, recoverableCount: state.recoverable.length, blockers });
}
