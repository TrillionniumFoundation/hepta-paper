import fs from 'node:fs';
import path from 'node:path';
import { receiptIssuerPolicies } from '../persistence/receipt-issuer-policy.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  descriptorSha256HashSync,
  openPinnedRegularFileSync,
  samePinnedFileIdentity,
} from '../runtime/pinned-file-reader.mjs';
import { verifyHeptaStoreRestoreDrillReceipt } from '../../paper-domain/evidence/hepta-store-restore-drill-receipt-contract.mjs';
import {
  listPinnedRuntimeRetentionEntries,
  listRuntimeRetentionEntries,
  pinnedRetentionMemberPath,
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

function backupReadPath(entry, candidate, { pinned = null, runtimeRoot = null } = {}) {
  if (!pinned) return candidate;
  return pinnedRetentionMemberPath(
    pinned,
    runtimeRoot || path.resolve(path.dirname(entry.path), '..'),
    'backups',
    candidate,
  );
}

function lstatIfPresent(candidate) {
  try { return fs.lstatSync(candidate); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function serializableFileIdentity(stat) {
  if (!stat) return null;
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    uid: String(stat.uid),
    gid: String(stat.gid),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

function parseDescriptorJson(descriptor) {
  try { return JSON.parse(fs.readFileSync(descriptor, 'utf8')); } catch { return null; }
}

function openBackupGenerationInspection(
  entry,
  { pinned = null, runtimeRoot = null } = {},
) {
  const receiptPath = entry.companionPaths?.find(
    (candidate) => candidate.endsWith('.sqlite.receipt.json'),
  ) || null;
  const restoreReceiptPath = entry.companionPaths?.find(
    (candidate) => candidate.endsWith('.sqlite.restore-drill.receipt.json'),
  ) || null;
  const declarations = [
    ['backup', entry.path],
    ['backup_receipt', receiptPath],
    ['restore_drill_receipt', restoreReceiptPath],
  ];
  const members = [];
  try {
    for (const [role, logicalPath] of declarations) {
      if (!logicalPath) {
        members.push(Object.freeze({ role, logicalPath, readPath: null, pinnedFile: null }));
        continue;
      }
      const readPath = backupReadPath(entry, logicalPath, { pinned, runtimeRoot });
      let pinnedFile = null;
      try {
        pinnedFile = openPinnedRegularFileSync(readPath, {
          errorCode: 'backup_generation_member_not_regular',
        });
      } catch {
        // Missing or unsafe members are represented in evidence blockers below.
      }
      members.push(Object.freeze({ role, logicalPath, readPath, pinnedFile }));
    }
  } catch (error) {
    for (const member of members) {
      if (member.pinnedFile) fs.closeSync(member.pinnedFile.descriptor);
    }
    throw error;
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const member of members) {
      if (member.pinnedFile) fs.closeSync(member.pinnedFile.descriptor);
    }
  };
  try {
    const byRole = new Map(members.map((member) => [member.role, member]));
    const backup = byRole.get('backup')?.pinnedFile || null;
    const receipt = byRole.get('backup_receipt')?.pinnedFile || null;
    const restoreReceipt = byRole.get('restore_drill_receipt')?.pinnedFile || null;
    const backupHash = backup ? descriptorSha256HashSync(backup.descriptor) : null;
    const backupReceipt = receipt ? parseDescriptorJson(receipt.descriptor) : null;
    const restoreDrillReceipt = restoreReceipt
      ? parseDescriptorJson(restoreReceipt.descriptor) : null;
    const generationIdentity = hashRecord(
      'RuntimeRetentionBackupGenerationIdentity',
      members.map((member) => ({
        role: member.role,
        path: member.logicalPath ? path.resolve(member.logicalPath) : null,
        identity: serializableFileIdentity(member.pinnedFile?.opened),
      })),
    );
    const assertStable = () => {
      if (closed) throw new Error('backup_generation_inspection_closed');
      for (const member of members) {
        if (!member.pinnedFile) continue;
        let atPath;
        try { atPath = fs.lstatSync(member.readPath, { bigint: true }); } catch {
          throw new Error('backup_generation_changed_while_reading');
        }
        const after = fs.fstatSync(member.pinnedFile.descriptor, { bigint: true });
        if (!samePinnedFileIdentity(member.pinnedFile.opened, after)
          || !samePinnedFileIdentity(after, atPath)) {
          throw new Error('backup_generation_changed_while_reading');
        }
      }
      return true;
    };
    return {
      backupHash,
      backupReceipt,
      restoreDrillReceipt,
      backupStat: backup?.opened || null,
      generationIdentity,
      assertStable,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

function verifyOpenedBackupRetentionEvidence(entry, receiptLedger, inspection) {
  const blockers = [];
  const expectedSourcePath = path.resolve(path.dirname(entry.path), '..', 'hepta-paper.sqlite');
  const backupStat = inspection.backupStat;
  const receipt = inspection.backupReceipt;
  const restoreReceipt = inspection.restoreDrillReceipt;
  const backupHash = inspection.backupHash;
  if (!backupStat?.isFile()) {
    blockers.push('backup_file_missing_or_unsafe');
  }
  if (!receipt) blockers.push('backup_receipt_missing_or_invalid');
  if (receipt?.version !== 1) blockers.push('backup_receipt_version_invalid');
  if (receipt?.kind !== 'HeptaStoreBackupReceipt') blockers.push('backup_receipt_kind_invalid');
  if (receipt?.status !== 'hepta_store_backup_recorded') blockers.push('backup_receipt_status_invalid');
  if (receipt && path.resolve(String(receipt.sourcePath || '')) !== expectedSourcePath) blockers.push('backup_receipt_source_path_mismatch');
  if (receipt && path.resolve(String(receipt.backupPath || '')) !== path.resolve(entry.path)) blockers.push('backup_receipt_path_mismatch');
  if (receipt?.backupSha256 !== backupHash) blockers.push('backup_receipt_hash_mismatch');
  if (receipt && Number(receipt.bytes) !== Number(backupStat?.size)) {
    blockers.push('backup_receipt_size_mismatch');
  }

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
  const restoreVerification = restoreReceipt
    ? verifyHeptaStoreRestoreDrillReceipt(restoreReceipt) : null;
  const restoreLedgerSubject = restoreVerification?.ledgerSubject || null;
  const derivedRestoreIdentity = restoreLedgerSubject
    ? ledgerIdentity(receiptLedger, restoreLedgerSubject, 'restore_drill')
    : { receiptHash: null, receiptId: null };
  const declaredRestoreIdentity = restoreVerification?.administrativeLedgerReceipt || null;
  const restoreIdentity = Object.freeze({
    receiptHash: declaredRestoreIdentity?.receiptSha256
      || derivedRestoreIdentity.receiptHash,
    receiptId: declaredRestoreIdentity?.receiptId || derivedRestoreIdentity.receiptId,
  });
  const restoreLedgerIdentityValid = restoreVerification?.legacy === true
    || (declaredRestoreIdentity?.receiptSha256 === derivedRestoreIdentity.receiptHash
      && declaredRestoreIdentity?.receiptId === derivedRestoreIdentity.receiptId);
  const restoreRow = restoreIdentity.receiptId && receiptLedger?.get ? receiptLedger.get(restoreIdentity.receiptId) : null;
  const restoreJson = receiptJson(restoreRow);
  const backupCreatedAt = Date.parse(receipt?.createdAt || '');
  const restorePerformedAt = Date.parse(restoreReceipt?.performedAt || '');
  const restoreCausalScopeValid = restoreVerification?.legacy === true
    || (restoreLedgerSubject?.restoreDrillBusinessWritePerformed === false
      && restoreLedgerSubject?.restoreDrillAdministrativeWritePerformed === true
      && restoreLedgerSubject?.concurrentBusinessStateChangesAttested === false
      && restoreLedgerSubject?.writerQuiescenceAttested === false
      && restoreLedgerSubject?.businessProjectionComparisonPerformed === false
      && restoreVerification?.diagnosticAfterHashAssurance
        === 'completion_self_hash_only'
      && restoreVerification?.diagnosticAfterHashLedgerAuthenticated === false);
  const restorePayloadValid = restoreVerification?.valid === true
    && restoreLedgerIdentityValid
    && restoreCausalScopeValid
    && restoreReceipt.status === 'hepta_store_restore_drill_passed'
    && path.resolve(String(restoreReceipt.backupPath || '')) === path.resolve(entry.path)
    && restoreReceipt.backupSha256 === backupHash
    && restoreReceipt.backupLedgerReceiptSha256 === backupReceiptHash
    && restoreReceipt.backupLedgerReceiptId === backupReceiptId
    && restoreReceipt.hashMatches === true
    && restoreReceipt.quickCheck === 'ok'
    && Number(restoreReceipt.foreignKeyViolationCount) === 0
    && Number.isFinite(backupCreatedAt)
    && Number.isFinite(restorePerformedAt)
    && restorePerformedAt >= backupCreatedAt;
  if (restoreReceipt && !restorePayloadValid) blockers.push('backup_restore_drill_receipt_invalid');
  const restoreIssuerTrusted = trustedRetentionIssuerRow(restoreRow, {
    policyId: 'store-administrator',
    policy: STORE_ADMIN_POLICY,
    evidenceClass: 'restore_drill',
    kind: 'HeptaStoreRestoreDrillReceipt',
    receiptId: restoreIdentity.receiptId,
    receiptHash: restoreIdentity.receiptHash,
    status: restoreLedgerSubject?.status,
  });
  if (restoreRow && !restoreIssuerTrusted) blockers.push('backup_restore_drill_ledger_receipt_mismatch');
  if (restoreRow && !restoreJson) blockers.push('backup_restore_drill_ledger_json_invalid');
  if (restoreJson && (ledgerIdentity(receiptLedger, restoreJson, 'restore_drill').receiptHash
    !== restoreIdentity.receiptHash
    || hashRecord('HeptaStoreRestoreDrillReceipt', restoreJson)
      !== hashRecord('HeptaStoreRestoreDrillReceipt', restoreLedgerSubject))) {
    blockers.push('backup_restore_drill_ledger_json_hash_invalid');
  }
  if (!restoreRow || !restorePayloadValid || !restoreIssuerTrusted) {
    blockers.push('backup_matching_restore_drill_missing');
  }

  inspection.assertStable();

  return Object.freeze({
    verified: blockers.length === 0,
    blockers,
    backupHash,
    backupReceiptHash,
    backupReceiptId,
    generationIdentity: inspection.generationIdentity,
    expectedSourcePath,
    restoreDrillReceiptId: restoreRow?.receipt_id || null,
    restoreDrillCausalScope: restoreVerification?.legacy === false ? Object.freeze({
      businessWritePerformed: restoreLedgerSubject?.restoreDrillBusinessWritePerformed,
      administrativeWritePerformed:
        restoreLedgerSubject?.restoreDrillAdministrativeWritePerformed,
      concurrentBusinessStateChangesAttested:
        restoreLedgerSubject?.concurrentBusinessStateChangesAttested,
      writerQuiescenceAttested: restoreLedgerSubject?.writerQuiescenceAttested,
      businessProjectionComparisonPerformed:
        restoreLedgerSubject?.businessProjectionComparisonPerformed,
    }) : null,
    restoreDrillDiagnosticAfterHash: restoreVerification?.legacy === false
      ? Object.freeze({
        sha256: restoreReceipt?.diagnosticLiveDatabaseSha256After || null,
        assurance: restoreVerification.diagnosticAfterHashAssurance,
        ledgerAuthenticated: false,
      }) : null,
  });
}

export function verifyBackupRetentionEvidence(
  entry,
  receiptLedger,
  { pinned = null, runtimeRoot = null, generationInspection = null } = {},
) {
  const ownedInspection = generationInspection === null;
  const inspection = generationInspection || openBackupGenerationInspection(
    entry,
    { pinned, runtimeRoot },
  );
  try {
    return verifyOpenedBackupRetentionEvidence(entry, receiptLedger, inspection);
  } finally {
    if (ownedInspection) inspection.close();
  }
}

function recoverableBackupState(runtimeRoot, receiptLedger, { pinned = null } = {}) {
  const { entries } = pinned
    ? listPinnedRuntimeRetentionEntries(runtimeRoot, 'backups', pinned)
    : listRuntimeRetentionEntries(runtimeRoot, 'backups');
  const inspections = [];
  try {
    for (const entry of entries) {
      inspections.push(Object.freeze({
        entry,
        inspection: openBackupGenerationInspection(entry, { pinned, runtimeRoot }),
      }));
    }
    const evidence = new Map(inspections.map(({ entry, inspection }) => [
      entry.path,
      verifyBackupRetentionEvidence(entry, receiptLedger, {
        pinned,
        runtimeRoot,
        generationInspection: inspection,
      }),
    ]));
    for (const { inspection } of inspections) inspection.assertStable();
    const recoverable = entries.filter(
      (entry) => evidence.get(entry.path)?.verified === true,
    );
    return Object.freeze({ entries, evidence, recoverable });
  } finally {
    for (const { inspection } of inspections) inspection.close();
  }
}

export function verifyBackupDeletionMinimum(
  runtimeRoot,
  entry,
  receiptLedger,
  minimumRecoverableGenerations,
  { pinned = null, requireCurrentMinimum = false } = {},
) {
  const targetReadPath = backupReadPath(entry, entry.path, { pinned, runtimeRoot });
  const targetPresent = lstatIfPresent(targetReadPath) !== null;
  if (!targetPresent && !requireCurrentMinimum) {
    return Object.freeze({
      allowed: true, recoverableCount: null, recoverableCountAfter: null, blockers: [],
    });
  }
  const state = recoverableBackupState(runtimeRoot, receiptLedger, { pinned });
  const currentEvidence = state.evidence.get(path.resolve(entry.path)) || state.evidence.get(entry.path);
  const minimum = Math.max(0, Number(minimumRecoverableGenerations || 0));
  const blockers = [];
  if (targetPresent && currentEvidence?.verified !== true) {
    blockers.push(...(currentEvidence?.blockers || ['backup_retention_evidence_invalid']));
  }
  const recoverableCountAfter = state.recoverable.filter(
    (candidate) => path.resolve(candidate.path) !== path.resolve(entry.path),
  ).length;
  if (recoverableCountAfter < minimum) {
    blockers.push('backup_minimum_recoverable_generations_would_be_violated');
  }
  return Object.freeze({
    allowed: blockers.length === 0,
    recoverableCount: state.recoverable.length,
    recoverableCountAfter,
    blockers,
  });
}
