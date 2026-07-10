import { assertReceiptLedgerPort } from '../../paper-ports/receipt-ledger-port.mjs';
import { sqlText, sqlJson } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function receiptHash(receipt) {
  return receipt.receiptHash
    || receipt.writeReceiptHash
    || receipt.jobReceiptHash
    || Object.entries(receipt).reverse().find(([key]) => key.endsWith('ReceiptHash'))?.[1]
    || hashRecord(receipt.kind || 'Receipt', receipt);
}

export function createSqliteReceiptLedger({ store, clock } = {}) {
  if (!store) throw new Error('Receipt ledger store is required');
  if (!clock) throw new Error('Receipt ledger clock is required');
  return assertReceiptLedgerPort({
    version: 1,
    kind: 'SqliteReceiptLedger',
    record(receipt, { stream = 'default', paperId = null } = {}) {
      if (!receipt?.kind) throw new Error('Ledger receipt kind is required');
      const hash = receiptHash(receipt);
      const id = `${stream}:${hash}`;
      const createdAt = receipt.createdAt || clock.nowIso();
      const result = store.execute(`INSERT OR IGNORE INTO receipt_ledger(receipt_id,stream,paper_id,kind,status,receipt_json,receipt_sha256,created_at) VALUES(${sqlText(id)},${sqlText(stream)},${paperId ? sqlText(paperId) : 'NULL'},${sqlText(receipt.kind)},${sqlText(receipt.status || 'recorded')},${sqlJson(receipt)},${sqlText(hash)},${sqlText(createdAt)});`);
      if (!result.ok) throw new Error(result.error || result.stderr || 'receipt_ledger_write_failed');
      return Object.freeze({ receiptId: id, receiptHash: hash, stream, paperId, createdAt });
    },
    get(receiptId) {
      return store.query(`SELECT * FROM receipt_ledger WHERE receipt_id=${sqlText(receiptId)} LIMIT 1;`).rows[0] || null;
    },
    list({ stream = null, paperId = null, limit = 100 } = {}) {
      const filters = [
        ...(stream ? [`stream=${sqlText(stream)}`] : []),
        ...(paperId ? [`paper_id=${sqlText(paperId)}`] : []),
      ];
      return store.query(`SELECT * FROM receipt_ledger${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(1000, Number(limit) || 100))};`).rows;
    },
  });
}
