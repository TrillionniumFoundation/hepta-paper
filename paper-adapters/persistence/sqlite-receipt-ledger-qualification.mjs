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
      const source = store.query(`SELECT receipt_id,stream,kind,writer_id,writer_kind,writer_trusted,issuer_policy_id,issuer_policy_hash FROM receipt_ledger WHERE receipt_id=${sqlText(receiptId)} LIMIT 1;`).rows[0];
      if (!source) throw new Error(`receipt_qualification_source_missing:${receiptId}`);
      const prior = store.query(`SELECT disposition FROM receipt_ledger_qualifications WHERE receipt_id=${sqlText(receiptId)} LIMIT 1;`).rows[0];
      if (prior) throw new Error(`receipt_qualification_is_monotonic:${prior.disposition}`);
      if (disposition === 'superseded' && !replacementReceiptId) throw new Error('receipt_supersession_replacement_required');
      if (disposition !== 'superseded' && replacementReceiptId) throw new Error('terminal_receipt_qualification_forbids_replacement');
      if (replacementReceiptId) {
        if (replacementReceiptId === receiptId) throw new Error('receipt_supersession_self_cycle');
        const replacement = store.query(`SELECT receipt_id,stream,kind,writer_id,writer_kind,writer_trusted,issuer_policy_id,issuer_policy_hash FROM receipt_ledger WHERE receipt_id=${sqlText(replacementReceiptId)} LIMIT 1;`).rows[0];
        if (!replacement) throw new Error(`receipt_qualification_replacement_missing:${replacementReceiptId}`);
        for (const field of ['stream', 'kind', 'writer_id', 'writer_kind', 'writer_trusted', 'issuer_policy_id', 'issuer_policy_hash']) {
          if ((source[field] ?? null) !== (replacement[field] ?? null)) throw new Error(`receipt_supersession_identity_mismatch:${field}`);
        }
        const cycle = store.query(`WITH RECURSIVE lineage(receipt_id) AS (
          SELECT ${sqlText(replacementReceiptId)}
          UNION
          SELECT q.replacement_receipt_id FROM receipt_ledger_qualifications q JOIN lineage l ON q.receipt_id=l.receipt_id
          WHERE q.disposition='superseded' AND q.replacement_receipt_id IS NOT NULL
        ) SELECT receipt_id FROM lineage WHERE receipt_id=${sqlText(receiptId)} LIMIT 1;`).rows[0];
        if (cycle) throw new Error('receipt_supersession_cycle');
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
      const result = store.execute(`INSERT INTO receipt_ledger_qualifications(qualification_id,receipt_id,disposition,reason,replacement_receipt_id,qualification_json,qualification_sha256,issuer_policy_id,created_at) VALUES(${sqlText(qualificationId)},${sqlText(receiptId)},${sqlText(disposition)},${sqlText(reason)},${replacementReceiptId ? sqlText(replacementReceiptId) : 'NULL'},${sqlJson(payload)},${sqlText(qualificationHash)},${sqlText(issuer.policyId)},${sqlText(payload.createdAt)});`);
      if (!result.ok) throw new Error(result.error || result.stderr || 'receipt_qualification_write_failed');
      return Object.freeze({ ...payload, qualificationId, qualificationHash });
    },
    latest(receiptId) {
      return store.query(`SELECT * FROM receipt_ledger_qualifications WHERE receipt_id=${sqlText(receiptId)} ORDER BY sequence DESC LIMIT 1;`).rows[0] || null;
    },
  });
}
