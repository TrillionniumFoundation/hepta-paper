import { receiptIssuerPolicies } from '../persistence/receipt-issuer-policy.mjs';
import { trustedRetentionIssuerRow } from './runtime-retention-evidence-policy.mjs';

const POLICY = receiptIssuerPolicies()['runtime-retention'];
const STREAM = 'runtime-retention';
const ENVIRONMENT = 'administrative';
const PAGE_SIZE = 1000;
const MAX_OFFSET = 9_999_000;

function ledgerIdentity(retentionReceiptLedger, receipt, evidenceClass) {
  if (!retentionReceiptLedger || typeof retentionReceiptLedger.prepare !== 'function') {
    throw new Error('runtime_retention_trusted_ledger_required');
  }
  const prepared = retentionReceiptLedger.prepare(receipt, {
    stream: STREAM,
    environment: ENVIRONMENT,
    evidenceClass,
  });
  if (prepared.writerTrusted !== true
    || prepared.issuerPolicyId !== 'runtime-retention'
    || prepared.issuerPolicyHash !== POLICY.issuerPolicyHash) {
    throw new Error('runtime_retention_trusted_ledger_required');
  }
  return prepared;
}

export function assertRuntimeRetentionTrustedLedger(retentionReceiptLedger) {
  ledgerIdentity(retentionReceiptLedger, { kind: 'RuntimeRetentionIntent' }, 'retention_intent');
}

export function assertTrustedRetentionReceipt(retentionReceiptLedger, receipt, evidenceClass) {
  const identity = ledgerIdentity(retentionReceiptLedger, receipt, evidenceClass);
  const row = retentionReceiptLedger.get(identity.receiptId);
  const trusted = trustedRetentionIssuerRow(row, {
    policyId: 'runtime-retention',
    policy: POLICY,
    stream: STREAM,
    evidenceClass,
    kind: receipt.kind,
    receiptId: identity.receiptId,
    receiptHash: identity.receiptHash,
    status: receipt.status,
  });
  if (!trusted) throw new Error('runtime_retention_trusted_receipt_missing_or_invalid');
  return Object.freeze({ receiptId: identity.receiptId, receiptHash: identity.receiptHash });
}

export function recordTrustedRetentionReceipt(retentionReceiptLedger, receipt, evidenceClass) {
  ledgerIdentity(retentionReceiptLedger, receipt, evidenceClass);
  retentionReceiptLedger.record(receipt, {
    stream: STREAM,
    environment: ENVIRONMENT,
    evidenceClass,
  });
  return assertTrustedRetentionReceipt(retentionReceiptLedger, receipt, evidenceClass);
}

function scanTombstoneRows(retentionReceiptLedger) {
  if (typeof retentionReceiptLedger?.list !== 'function') {
    throw new Error('runtime_retention_trusted_ledger_query_required');
  }
  const rows = [];
  const receiptIds = new Set();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = retentionReceiptLedger.list({
      stream: STREAM,
      environment: ENVIRONMENT,
      evidenceClass: 'retention_tombstone',
      includeQualified: true,
      limit: PAGE_SIZE,
      offset,
    });
    if (!Array.isArray(page) || page.length > PAGE_SIZE) {
      throw new Error('runtime_retention_tombstone_ledger_scan_invalid');
    }
    for (const row of page) {
      if (!row?.receipt_id || receiptIds.has(row.receipt_id)) {
        throw new Error('runtime_retention_tombstone_ledger_scan_unstable');
      }
      receiptIds.add(row.receipt_id);
      rows.push(row);
    }
    if (page.length < PAGE_SIZE) break;
    if (offset >= MAX_OFFSET) throw new Error('runtime_retention_tombstone_ledger_scan_bound_exceeded');
  }
  return rows;
}

function tombstoneRows(retentionReceiptLedger) {
  const first = scanTombstoneRows(retentionReceiptLedger);
  const second = scanTombstoneRows(retentionReceiptLedger);
  const identity = (rows) => JSON.stringify(rows.map((row) => [
    row.receipt_id,
    row.receipt_sha256,
    row.created_at,
    row.effective_receipt_usable,
  ]));
  if (identity(first) !== identity(second)) {
    throw new Error('runtime_retention_tombstone_ledger_scan_unstable');
  }
  return first;
}

export function findUniqueTrustedRetentionTombstone(retentionReceiptLedger, intent) {
  const expectedIntentReceiptId = `runtime-retention:${intent.runtimeRetentionIntentReceiptHash}`;
  const matches = [];
  for (const row of tombstoneRows(retentionReceiptLedger)) {
    if (row?.kind !== 'RuntimeRetentionReceipt') continue;
    let receipt;
    try { receipt = JSON.parse(row.receipt_json); } catch {
      throw new Error('runtime_retention_tombstone_ledger_json_invalid');
    }
    const refersToIntent = receipt?.intentHash === intent.runtimeRetentionIntentReceiptHash
      || receipt?.intentReceiptId === expectedIntentReceiptId;
    if (!refersToIntent) continue;
    if (receipt.intentHash !== intent.runtimeRetentionIntentReceiptHash
      || receipt.intentReceiptId !== expectedIntentReceiptId) {
      throw new Error('runtime_retention_tombstone_ledger_lineage_conflict');
    }
    const trusted = assertTrustedRetentionReceipt(
      retentionReceiptLedger,
      receipt,
      'retention_tombstone',
    );
    if (trusted.receiptId !== row.receipt_id || trusted.receiptHash !== row.receipt_sha256) {
      throw new Error('runtime_retention_tombstone_ledger_identity_conflict');
    }
    matches.push(Object.freeze(receipt));
  }
  if (matches.length > 1) throw new Error('runtime_retention_tombstone_ledger_ambiguous');
  return matches[0] || null;
}
