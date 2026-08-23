import { assertReceiptLedgerPort } from '../../paper-ports/receipt-ledger-port.mjs';
import { failClosedStoreQueries, sqlText, sqlJson } from '../../paper-ports/store-port.mjs';
import { selectReceiptHash } from '../../paper-domain/evidence/receipt-hash-selector.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { resolveReceiptWriterCapability } from './receipt-issuer-policy.mjs';
import {
  NATIVE_STORE_LEDGER_STATEMENT_IDS,
} from './native-store-ledger-mutation-plan.mjs';

export const receiptHash = selectReceiptHash;

const RECEIPT_LEDGER_MUTATION = Symbol('sqlite-receipt-ledger-mutation');
const DIRECT_PACKAGE_RECEIPT_KINDS = new Set([
  'PackageLifecycleRecordingIntent',
  'PackageLifecycleReceipt',
  'PackageExactRestoreDrillReceipt',
  'PackageRetentionRecoveryReceipt',
  'PackageRetentionLegalHoldReceipt',
]);

function packageDeletionWriterSelector(receipt) {
  if (DIRECT_PACKAGE_RECEIPT_KINDS.has(receipt?.kind)) {
    return Object.freeze({
      packagePath: receipt.packagePath,
      ...(receipt.packageLifecycleReceiptHash ? {
        packageLifecycleReceiptHash: receipt.packageLifecycleReceiptHash,
      } : {}),
    });
  }
  if (receipt?.kind === 'PackageSupersessionReceipt') {
    return Object.freeze({
      packageLifecycleReceiptHash: receipt.predecessorLifecycleReceiptHash,
      packagePath: receipt.successorPackagePath,
    });
  }
  return null;
}

export function preparedSqliteReceiptLedgerMutation(prepared) {
  const mutation = prepared?.[RECEIPT_LEDGER_MUTATION];
  if (!mutation || !Array.isArray(mutation.parameters)
    || mutation.parameters.length !== 17) {
    throw new Error('receipt_ledger_prepared_mutation_invalid');
  }
  return mutation;
}

export function createSqliteReceiptLedger({ store: suppliedStore, clock, writerIdentity = null, issuerCapability = null } = {}) {
  if (!suppliedStore) throw new Error('Receipt ledger store is required');
  if (!clock) throw new Error('Receipt ledger clock is required');
  const store = failClosedStoreQueries(suppliedStore);
  if (writerIdentity?.trusted === true) throw new Error('raw_trusted_writer_identity_forbidden');
  const query = (sql) => store.query(sql);
  const issued = resolveReceiptWriterCapability(issuerCapability);
  if (issuerCapability && !issued) throw new Error('receipt_issuer_capability_invalid');
  const writer = Object.freeze(issued ? {
    writerId: issued.writerId,
    writerKind: issued.writerKind,
    trusted: true,
    allowedKinds: issued.allowedKinds,
    allowedStreams: issued.allowedStreams,
    issuerPolicyId: issued.policyId,
    issuerPolicyHash: issued.issuerPolicyHash,
    issuerAssurance: issued.assurance,
  } : {
    writerId: writerIdentity?.writerId || 'untrusted-caller',
    writerKind: writerIdentity?.writerKind || 'untrusted',
    trusted: false,
    allowedKinds: Object.freeze([...(writerIdentity?.allowedKinds || [])].map(String)),
    allowedStreams: Object.freeze([...(writerIdentity?.allowedStreams || [])].map(String)),
    issuerPolicyId: null,
    issuerPolicyHash: null,
    issuerAssurance: 'untrusted',
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
    const sql = `INSERT${strictInsert ? '' : ' OR IGNORE'} INTO receipt_ledger(receipt_id,stream,paper_id,kind,status,receipt_json,receipt_sha256,created_at,environment,evidence_class,release_commit,writer_id,writer_kind,writer_trusted,issuer_policy_id,issuer_policy_hash,issuer_assurance) VALUES(${sqlText(id)},${sqlText(stream)},${paperId ? sqlText(paperId) : 'NULL'},${sqlText(receipt.kind)},${sqlText(receipt.status || 'recorded')},${sqlJson(receipt)},${sqlText(hash)},${sqlText(createdAt)},${sqlText(environment)},${sqlText(evidenceClass)},${releaseCommit ? sqlText(releaseCommit) : 'NULL'},${sqlText(writer.writerId)},${sqlText(writer.writerKind)},${writer.trusted ? 1 : 0},${writer.issuerPolicyId ? sqlText(writer.issuerPolicyId) : 'NULL'},${writer.issuerPolicyHash ? sqlText(writer.issuerPolicyHash) : 'NULL'},${sqlText(writer.issuerAssurance)});`;
    const prepared = {
      receiptId: id,
      receiptHash: hash,
      stream,
      paperId,
      createdAt,
      environment,
      evidenceClass,
      releaseCommit,
      writerId: writer.writerId,
      writerKind: writer.writerKind,
      writerTrusted: writer.trusted,
      issuerPolicyId: writer.issuerPolicyId,
      issuerPolicyHash: writer.issuerPolicyHash,
      issuerAssurance: writer.issuerAssurance,
      sql,
    };
    Object.defineProperty(prepared, RECEIPT_LEDGER_MUTATION, {
      enumerable: false,
      value: Object.freeze({
        strictInsert: Boolean(strictInsert),
        parameters: Object.freeze([
          id,
          stream,
          paperId,
          receipt.kind,
          receipt.status || 'recorded',
          JSON.stringify(receipt),
          hash,
          createdAt,
          environment,
          evidenceClass,
          releaseCommit,
          writer.writerId,
          writer.writerKind,
          writer.trusted ? 1 : 0,
          writer.issuerPolicyId,
          writer.issuerPolicyHash,
          writer.issuerAssurance,
        ]),
      }),
    });
    return Object.freeze(prepared);
  };
  return assertReceiptLedgerPort({
    version: 1,
    kind: 'SqliteReceiptLedger',
    prepare,
    record(receipt, options = {}) {
      const prepared = prepare(receipt, options);
      const targetedSelector = packageDeletionWriterSelector(receipt);
      if (typeof store.mutate === 'function') {
        const mutation = preparedSqliteReceiptLedgerMutation(prepared);
        const coordinated = store.mutate({
          databaseRole: 'native-store',
          operationId: 'native-store.receipt-ledger.record.v1',
          authorizationReceiptHashes: [],
          sideEffectReservationHashes: [],
          ...(targetedSelector ? {
            packageDeletionWriterSelector: targetedSelector,
          } : {}),
          mutate(transaction) {
            return transaction.run(
              mutation.strictInsert
                ? NATIVE_STORE_LEDGER_STATEMENT_IDS.insertReceipt
                : NATIVE_STORE_LEDGER_STATEMENT_IDS.insertReceiptOrIgnore,
              ...mutation.parameters,
            ).changes;
          },
        });
        const finalized = coordinated?.status
          === 'externally_fenced_sqlite_mutation_finalized';
        const unchanged = coordinated?.status
          === 'externally_fenced_sqlite_mutation_no_change'
          && coordinated.value === 0 && mutation.strictInsert === false;
        if ((!finalized && !unchanged)
          || (finalized && coordinated.value !== 1)) {
          throw new Error('receipt_ledger_external_mutation_receipt_invalid');
        }
        const { sql: _sql, ...recorded } = prepared;
        return Object.freeze(recorded);
      }
      const result = store.execute(prepared.sql, targetedSelector ? {
        packageDeletionWriterSelector: targetedSelector,
      } : undefined);
      if (!result.ok) throw new Error(result.error || result.stderr || 'receipt_ledger_write_failed');
      const { sql: _sql, ...recorded } = prepared;
      return Object.freeze(recorded);
    },
    getRawForAudit(receiptId) {
      return query(`SELECT * FROM receipt_ledger WHERE receipt_id=${sqlText(receiptId)} LIMIT 1;`).rows[0] || null;
    },
    listRawForAudit({
      stream = null, paperId = null, environment = null, evidenceClass = null,
      limit = 100, offset = 0,
    } = {}) {
      const filters = [
        ...(stream ? [`stream=${sqlText(stream)}`] : []),
        ...(paperId ? [`paper_id=${sqlText(paperId)}`] : []),
        ...(environment ? [`environment=${sqlText(environment)}`] : []),
        ...(evidenceClass ? [`evidence_class=${sqlText(evidenceClass)}`] : []),
      ];
      const boundedLimit = Math.max(1, Math.min(1000, Math.trunc(Number(limit) || 100)));
      const boundedOffset = Math.max(0, Math.min(10_000_000, Math.trunc(Number(offset) || 0)));
      return query(`SELECT * FROM receipt_ledger${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''} ORDER BY created_at DESC, receipt_id DESC LIMIT ${boundedLimit} OFFSET ${boundedOffset};`).rows;
    },
    get(receiptId) {
      return query(`SELECT * FROM effective_receipt_ledger WHERE receipt_id=${sqlText(receiptId)} LIMIT 1;`).rows[0] || null;
    },
    resolveEffective(receiptId, { maxDepth = 16 } = {}) {
      const visited = new Set();
      const lineage = [];
      let currentReceiptId = receiptId;
      for (let depth = 0; depth < Math.max(1, Math.min(64, Number(maxDepth) || 16)); depth += 1) {
        if (visited.has(currentReceiptId)) return Object.freeze({ status: 'effective_receipt_resolution_blocked', receiptRow: null, lineage, blockers: ['trusted_receipt_replacement_cycle'] });
        visited.add(currentReceiptId);
        const row = query(`SELECT * FROM effective_receipt_ledger WHERE receipt_id=${sqlText(currentReceiptId)} LIMIT 1;`).rows[0] || null;
        if (!row) return Object.freeze({ status: 'effective_receipt_resolution_blocked', receiptRow: null, lineage, blockers: ['trusted_receipt_ledger_row_missing'] });
        if (Number(row.effective_receipt_usable ?? 1) === 1) return Object.freeze({ status: 'effective_receipt_resolved', receiptRow: row, lineage, blockers: [] });
        const qualification = query(`SELECT * FROM receipt_ledger_qualifications WHERE receipt_id=${sqlText(currentReceiptId)} LIMIT 1;`).rows[0] || null;
        if (!qualification) return Object.freeze({ status: 'effective_receipt_resolution_blocked', receiptRow: row, lineage, blockers: ['trusted_receipt_qualification_missing'] });
        let payload = null;
        try { payload = JSON.parse(qualification.qualification_json); } catch { /* fail closed below */ }
        const qualificationHashValid = Boolean(payload)
          && hashRecord('ReceiptLedgerQualification', payload) === qualification.qualification_sha256
          && payload.receiptId === currentReceiptId
          && (payload.replacementReceiptId || null) === (qualification.replacement_receipt_id || null);
        if (!qualificationHashValid) return Object.freeze({ status: 'effective_receipt_resolution_blocked', receiptRow: row, lineage, blockers: ['trusted_receipt_qualification_hash_invalid'] });
        lineage.push(Object.freeze({ receiptId: currentReceiptId, disposition: qualification.disposition, replacementReceiptId: qualification.replacement_receipt_id || null, qualificationHash: qualification.qualification_sha256 }));
        if (qualification.disposition !== 'superseded' || !qualification.replacement_receipt_id) {
          return Object.freeze({ status: 'effective_receipt_resolution_blocked', receiptRow: row, lineage, blockers: [`trusted_receipt_qualified_${qualification.disposition || 'unusable'}`] });
        }
        currentReceiptId = qualification.replacement_receipt_id;
      }
      return Object.freeze({ status: 'effective_receipt_resolution_blocked', receiptRow: null, lineage, blockers: ['trusted_receipt_replacement_depth_exceeded'] });
    },
    list({
      stream = null, paperId = null, environment = null, evidenceClass = null,
      includeQualified = false, limit = 100, offset = 0,
    } = {}) {
      const filters = [
        ...(stream ? [`stream=${sqlText(stream)}`] : []),
        ...(paperId ? [`paper_id=${sqlText(paperId)}`] : []),
        ...(environment ? [`environment=${sqlText(environment)}`] : []),
        ...(evidenceClass ? [`evidence_class=${sqlText(evidenceClass)}`] : []),
        ...(!includeQualified ? ['effective_receipt_usable=1'] : []),
      ];
      const boundedLimit = Math.max(1, Math.min(1000, Math.trunc(Number(limit) || 100)));
      const boundedOffset = Math.max(0, Math.min(10_000_000, Math.trunc(Number(offset) || 0)));
      return query(`SELECT * FROM effective_receipt_ledger${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''} ORDER BY created_at DESC, receipt_id DESC LIMIT ${boundedLimit} OFFSET ${boundedOffset};`).rows;
    },
  });
}
