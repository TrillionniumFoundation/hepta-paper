import crypto from 'node:crypto';
import path from 'node:path';
import { selectReceiptHash } from '../../paper-domain/evidence/receipt-hash-selector.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { createFilesystemReportReceiptRepository } from './filesystem-report-receipt-repository.mjs';

// Report output is intentionally outside the operational SQLite trust plane.
// This ledger provides durable local provenance for report artifacts without
// creating, migrating, or writing the business database during a preview.
export function createFilesystemReportReceiptLedger({ scopeRoot, receiptRoot, clock } = {}) {
  if (!scopeRoot || !receiptRoot || !clock?.nowIso) throw new Error('report receipt ledger requires scopeRoot, receiptRoot and ClockPort');
  const root = path.resolve(receiptRoot);
  const repository = createFilesystemReportReceiptRepository({ scopeRoot, receiptRoot: root });
  return Object.freeze({
    version: 1,
    kind: 'FilesystemReportReceiptLedger',
    record(receipt, { stream = 'report-artifact-writes', paperId = null } = {}) {
      if (receipt?.kind !== 'ArtifactWriteReceipt' || stream !== 'artifact-writes') {
        throw new Error('report_receipt_kind_or_stream_forbidden');
      }
      const receiptHash = selectReceiptHash(receipt);
      const receiptId = `report-artifact:${receiptHash}`;
      const payload = {
        version: 1,
        kind: 'FilesystemReportReceiptLedgerEntry',
        receiptId,
        stream: 'report-artifact-writes',
        paperId,
        receiptKind: receipt.kind,
        receiptHash,
        receipt,
        recordedAt: clock.nowIso(),
        businessStoreMutated: false,
      };
      const entry = { ...payload, filesystemReportReceiptLedgerEntryHash: hashRecord('FilesystemReportReceiptLedgerEntry', payload) };
      const digest = crypto.createHash('sha256').update(receiptId).digest('hex');
      repository.putImmutable(`${digest}.json`, entry);
      return Object.freeze({
        receiptId,
        receiptHash,
        stream: payload.stream,
        paperId,
        environment: 'local-report-output',
        evidenceClass: 'report_artifact_provenance',
        writerId: 'filesystem-report-receipt-ledger',
        writerKind: 'local-report-output',
        writerTrusted: false,
      });
    },
  });
}
