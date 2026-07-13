import { sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { resolveReceiptWriterCapability } from './receipt-issuer-policy.mjs';

const DISPOSITIONS = new Set(['superseded', 'invalid', 'administrative_exported', 'retention_tombstone']);

export function createSqliteReceiptLedgerQualificationStore({ store, clock, issuerCapability } = {}) {
  if (!store || !clock) throw new Error('Receipt ledger qualification store and clock are required');
  const issuer = resolveReceiptWriterCapability(issuerCapability);
  if (!issuer || issuer.policyId !== 'ledger-administrator') throw new Error('ledger_administrator_capability_required');
  return Object.freeze({
    qualify({ receiptId, disposition, reason, replacementReceiptId = null } = {}) {
      if (!receiptId || !reason || !DISPOSITIONS.has(disposition)) throw new Error('receipt_qualification_invalid');
      const source = store.query(`SELECT receipt_id FROM receipt_ledger WHERE receipt_id=${sqlText(receiptId)} LIMIT 1;`).rows[0];
      if (!source) throw new Error(`receipt_qualification_source_missing:${receiptId}`);
      if (replacementReceiptId) {
        const replacement = store.query(`SELECT receipt_id FROM receipt_ledger WHERE receipt_id=${sqlText(replacementReceiptId)} LIMIT 1;`).rows[0];
        if (!replacement) throw new Error(`receipt_qualification_replacement_missing:${replacementReceiptId}`);
      }
      const payload = {
        version: 1,
        kind: 'ReceiptLedgerQualification',
        receiptId,
        disposition,
        reason,
        replacementReceiptId,
        issuerPolicyId: issuer.policyId,
        createdAt: clock.nowIso(),
      };
      const qualificationHash = hashRecord('ReceiptLedgerQualification', payload);
      const qualificationId = `qualification:${qualificationHash}`;
      const result = store.execute(`INSERT OR IGNORE INTO receipt_ledger_qualifications(qualification_id,receipt_id,disposition,reason,replacement_receipt_id,qualification_json,qualification_sha256,issuer_policy_id,created_at) VALUES(${sqlText(qualificationId)},${sqlText(receiptId)},${sqlText(disposition)},${sqlText(reason)},${replacementReceiptId ? sqlText(replacementReceiptId) : 'NULL'},${sqlJson(payload)},${sqlText(qualificationHash)},${sqlText(issuer.policyId)},${sqlText(payload.createdAt)});`);
      if (!result.ok) throw new Error(result.error || result.stderr || 'receipt_qualification_write_failed');
      return Object.freeze({ ...payload, qualificationId, qualificationHash });
    },
    latest(receiptId) {
      return store.query(`SELECT * FROM receipt_ledger_qualifications WHERE receipt_id=${sqlText(receiptId)} ORDER BY sequence DESC LIMIT 1;`).rows[0] || null;
    },
  });
}
