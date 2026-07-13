import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function parseStoredReceipt(row) {
  try { return JSON.parse(row?.receipt_json || '{}'); } catch { return null; }
}

function selfHashField(receipt = {}) {
  if (receipt.kind === 'ArtifactWriteReceipt') return 'writeReceiptHash';
  if (receipt.kind === 'NativeResearchWorkerExecutionReceipt') return 'nativeResearchWorkerExecutionReceiptHash';
  if (receipt.receiptHash) return 'receiptHash';
  if (receipt.jobReceiptHash) return 'jobReceiptHash';
  return null;
}

export function recomputeReceiptHash(receipt = {}) {
  const field = selfHashField(receipt);
  if (!field) return null;
  const { [field]: _claimed, ledgerReceiptId: _ledgerReceiptId, ...payload } = receipt;
  return hashRecord(receipt.kind || 'Receipt', payload);
}

export function verifyTrustedLedgerReceipt({
  receipt,
  ledgerReceiptId = null,
  receiptLedger,
  expectedKinds = [],
  expectedStatuses = [],
  expectedStreams = [],
  expectedWriterIds = [],
  expectedWriterKinds = [],
  requireTrustedWriter = true,
} = {}) {
  const blockers = [];
  if (!receiptLedger || typeof receiptLedger.get !== 'function') blockers.push('trusted_receipt_ledger_required');
  if (!receipt || typeof receipt !== 'object') blockers.push('trusted_receipt_missing');
  if (!ledgerReceiptId) blockers.push('trusted_receipt_ledger_id_missing');
  const effectiveResolution = receiptLedger && ledgerReceiptId && typeof receiptLedger.resolveEffective === 'function'
    ? receiptLedger.resolveEffective(ledgerReceiptId)
    : null;
  blockers.push(...(effectiveResolution?.blockers || []));
  const row = effectiveResolution?.receiptRow || (receiptLedger && ledgerReceiptId ? receiptLedger.get(ledgerReceiptId) : null);
  if (!row) blockers.push('trusted_receipt_ledger_entry_missing');
  const stored = parseStoredReceipt(row);
  if (!stored) blockers.push('trusted_receipt_ledger_payload_invalid');
  if (expectedKinds.length && !expectedKinds.includes(receipt?.kind)) blockers.push('trusted_receipt_kind_invalid');
  if (expectedStatuses.length && !expectedStatuses.includes(receipt?.status)) blockers.push('trusted_receipt_status_invalid');
  if (expectedStreams.length && !expectedStreams.includes(row?.stream)) blockers.push('trusted_receipt_stream_invalid');
  if (!effectiveResolution && row && Number(row.effective_receipt_usable ?? 1) !== 1) {
    blockers.push(`trusted_receipt_qualified_${row.effective_disposition || 'unusable'}`);
  }
  if (requireTrustedWriter && Number(row?.writer_trusted || 0) !== 1) blockers.push('trusted_receipt_writer_untrusted');
  if (requireTrustedWriter && (!row?.writer_id || !row?.writer_kind)) blockers.push('trusted_receipt_writer_identity_missing');
  if (requireTrustedWriter && (!row?.issuer_policy_id || !row?.issuer_policy_hash)) blockers.push('trusted_receipt_issuer_capability_missing');
  if (requireTrustedWriter && ['untrusted', 'legacy_unclassified'].includes(row?.issuer_assurance)) blockers.push('trusted_receipt_issuer_assurance_invalid');
  if (expectedWriterIds.length && !expectedWriterIds.includes(row?.writer_id)) blockers.push('trusted_receipt_writer_id_invalid');
  if (expectedWriterKinds.length && !expectedWriterKinds.includes(row?.writer_kind)) blockers.push('trusted_receipt_writer_kind_invalid');
  const hashField = selfHashField(receipt || {});
  const claimedHash = hashField ? receipt?.[hashField] : null;
  const recomputedHash = receipt ? recomputeReceiptHash(receipt) : null;
  if (!claimedHash || claimedHash !== recomputedHash) blockers.push('trusted_receipt_hash_invalid');
  if (!effectiveResolution && row && row.receipt_id !== ledgerReceiptId) blockers.push('trusted_receipt_ledger_identity_mismatch');
  if (row && claimedHash !== row.receipt_sha256) blockers.push('trusted_receipt_ledger_hash_mismatch');
  const { ledgerReceiptId: _providedLedgerReceiptId, ...providedPayload } = receipt || {};
  if (stored && JSON.stringify(stored) !== JSON.stringify(providedPayload)) blockers.push('trusted_receipt_ledger_payload_mismatch');
  return Object.freeze({
    version: 1,
    kind: 'TrustedLedgerReceiptVerification',
    status: blockers.length ? 'trusted_ledger_receipt_blocked' : 'trusted_ledger_receipt_verified',
    ledgerReceiptId,
    receiptKind: receipt?.kind || null,
    receiptHash: claimedHash || null,
    stream: row?.stream || null,
    writerId: row?.writer_id || null,
    writerKind: row?.writer_kind || null,
    writerTrusted: Number(row?.writer_trusted || 0) === 1,
    issuerPolicyId: row?.issuer_policy_id || null,
    issuerPolicyHash: row?.issuer_policy_hash || null,
    issuerAssurance: row?.issuer_assurance || null,
    effectiveDisposition: row?.effective_disposition || null,
    effectiveReplacementReceiptId: row?.effective_replacement_receipt_id || null,
    qualificationHash: row?.effective_qualification_sha256 || null,
    effectiveLineage: effectiveResolution?.lineage || [],
    blockers: [...new Set(blockers)],
  });
}
