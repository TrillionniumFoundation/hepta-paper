import { assertReceiptLedgerPort } from '../../paper-ports/receipt-ledger-port.mjs';
import { sqlText, sqlJson } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function receiptHash(receipt) {
  return receipt.receiptHash
    || receipt.writeReceiptHash
    || receipt.jobReceiptHash
    || Object.entries(receipt).reverse().find(([key]) => key.endsWith('ReceiptHash'))?.[1]
    || hashRecord(receipt.kind || 'Receipt', receipt);
}

export function createSqliteReceiptLedger({ store, clock, writerIdentity = null } = {}) {
  if (!store) throw new Error('Receipt ledger store is required');
  if (!clock) throw new Error('Receipt ledger clock is required');
  const writer = Object.freeze({
    writerId: writerIdentity?.writerId || 'untrusted-caller',
    writerKind: writerIdentity?.writerKind || 'untrusted',
    trusted: writerIdentity?.trusted === true,
    allowedKinds: Object.freeze([...(writerIdentity?.allowedKinds || [])].map(String)),
    allowedStreams: Object.freeze([...(writerIdentity?.allowedStreams || [])].map(String)),
  });
  const prepare = (receipt, {
    stream = 'default',
    paperId = null,
    environment = process.env.HEPTA_EVIDENCE_ENVIRONMENT || 'production',
    evidenceClass = process.env.HEPTA_EVIDENCE_CLASS || 'runtime_unclassified',
    releaseCommit = process.env.HEPTA_RELEASE_COMMIT || null,
    strictInsert = false,
  } = {}) => {
    if (!receipt?.kind) throw new Error('Ledger receipt kind is required');
    if (writer.allowedKinds.length && !writer.allowedKinds.includes(receipt.kind)) {
      throw new Error(`receipt issuer kind forbidden:${receipt.kind}`);
    }
    if (writer.allowedStreams.length && !writer.allowedStreams.includes(stream)) {
      throw new Error(`receipt issuer stream forbidden:${stream}`);
    }
    const hash = receiptHash(receipt);
    const id = `${stream}:${hash}`;
    const createdAt = receipt.createdAt || clock.nowIso();
    const sql = `INSERT${strictInsert ? '' : ' OR IGNORE'} INTO receipt_ledger(receipt_id,stream,paper_id,kind,status,receipt_json,receipt_sha256,created_at,environment,evidence_class,release_commit,writer_id,writer_kind,writer_trusted) VALUES(${sqlText(id)},${sqlText(stream)},${paperId ? sqlText(paperId) : 'NULL'},${sqlText(receipt.kind)},${sqlText(receipt.status || 'recorded')},${sqlJson(receipt)},${sqlText(hash)},${sqlText(createdAt)},${sqlText(environment)},${sqlText(evidenceClass)},${releaseCommit ? sqlText(releaseCommit) : 'NULL'},${sqlText(writer.writerId)},${sqlText(writer.writerKind)},${writer.trusted ? 1 : 0});`;
    return Object.freeze({ receiptId: id, receiptHash: hash, stream, paperId, createdAt, environment, evidenceClass, releaseCommit, writerId: writer.writerId, writerKind: writer.writerKind, writerTrusted: writer.trusted, sql });
  };
  return assertReceiptLedgerPort({
    version: 1,
    kind: 'SqliteReceiptLedger',
    prepare,
    record(receipt, options = {}) {
      const prepared = prepare(receipt, options);
      const result = store.execute(prepared.sql);
      if (!result.ok) throw new Error(result.error || result.stderr || 'receipt_ledger_write_failed');
      const { sql: _sql, ...recorded } = prepared;
      return Object.freeze(recorded);
    },
    get(receiptId) {
      return store.query(`SELECT * FROM receipt_ledger WHERE receipt_id=${sqlText(receiptId)} LIMIT 1;`).rows[0] || null;
    },
    list({ stream = null, paperId = null, environment = null, evidenceClass = null, limit = 100 } = {}) {
      const filters = [
        ...(stream ? [`stream=${sqlText(stream)}`] : []),
        ...(paperId ? [`paper_id=${sqlText(paperId)}`] : []),
        ...(environment ? [`environment=${sqlText(environment)}`] : []),
        ...(evidenceClass ? [`evidence_class=${sqlText(evidenceClass)}`] : []),
      ];
      return store.query(`SELECT * FROM receipt_ledger${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(1000, Number(limit) || 100))};`).rows;
    },
  });
}
