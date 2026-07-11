import { assertWorkflowStatePort } from '../../paper-ports/workflow-state-port.mjs';
import { sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function verifyRow(row) {
  if (!row) return null;
  let projection = null;
  try { projection = JSON.parse(row.state_json); } catch { /* reported below */ }
  const currentHash = projection ? hashRecord('PaperWorkflowStateProjection', projection) : null;
  const integrityVerified = Boolean(currentHash && currentHash === row.state_sha256);
  return Object.freeze({
    version: 1,
    kind: 'PaperWorkflowStateProjectionVerification',
    paperId: row.paper_id,
    status: integrityVerified ? 'workflow_state_projection_verified' : 'workflow_state_projection_corrupt',
    projection,
    storedHash: row.state_sha256,
    currentHash,
    integrityVerified,
    blockers: integrityVerified ? [] : ['workflow_state_projection_hash_mismatch'],
  });
}

export function createSqliteWorkflowStateStore({ store, clock, receiptLedger } = {}) {
  if (!store || !clock || !receiptLedger) throw new Error('Workflow state store requires StorePort, ClockPort and ReceiptLedgerPort');
  const api = {
    version: 1,
    kind: 'SqliteWorkflowStateStore',
    put({ paperId, mode, state, workflowReceiptHash = null, sourceReceiptHashes = [] } = {}) {
      if (!paperId || !mode || !state || typeof state !== 'object') {
        throw new Error('paperId, mode and state are required');
      }
      const paper = store.query(`SELECT slug FROM papers WHERE slug=${sqlText(paperId)} LIMIT 1;`).rows[0] || null;
      if (!paper) {
        return Object.freeze({
          version: 1,
          kind: 'PaperWorkflowStateProjectionWrite',
          paperId,
          status: 'workflow_state_projection_blocked',
          persisted: false,
          blockers: ['workflow_state_paper_not_registered'],
        });
      }
      const projection = {
        version: 1,
        kind: 'PaperWorkflowStateProjection',
        paperId,
        mode,
        state,
        workflowReceiptHash,
        sourceReceiptHashes: [...new Set(sourceReceiptHashes.filter(Boolean).map(String))].sort(),
        recordedAt: clock.nowIso(),
      };
      const projectionHash = hashRecord('PaperWorkflowStateProjection', projection);
      const result = store.execute(`INSERT INTO workflow_states(paper_id,state_json,state_sha256,updated_at) VALUES(${sqlText(paperId)},${sqlJson(projection)},${sqlText(projectionHash)},${sqlText(projection.recordedAt)}) ON CONFLICT(paper_id) DO UPDATE SET state_json=excluded.state_json,state_sha256=excluded.state_sha256,updated_at=excluded.updated_at;`);
      if (!result.ok) throw new Error(result.error || result.stderr || 'workflow_state_projection_write_failed');
      const receiptPayload = {
        version: 1,
        kind: 'PaperWorkflowStateProjectionReceipt',
        paperId,
        mode,
        status: 'workflow_state_projection_persisted',
        projectionHash,
        workflowReceiptHash,
        createdAt: projection.recordedAt,
        externalActionPerformed: false,
      };
      const receipt = {
        ...receiptPayload,
        paperWorkflowStateProjectionReceiptHash: hashRecord('PaperWorkflowStateProjectionReceipt', receiptPayload),
      };
      const ledger = receiptLedger.record(receipt, { stream: 'workflow-state', paperId });
      return Object.freeze({
        version: 1,
        kind: 'PaperWorkflowStateProjectionWrite',
        paperId,
        status: 'workflow_state_projection_persisted',
        persisted: true,
        projectionHash,
        receiptHash: receipt.paperWorkflowStateProjectionReceiptHash,
        ledgerReceiptId: ledger.receiptId,
        blockers: [],
      });
    },
    get(paperId) {
      if (!paperId) return null;
      const row = store.query(`SELECT paper_id,state_json,state_sha256,updated_at FROM workflow_states WHERE paper_id=${sqlText(paperId)} LIMIT 1;`).rows[0] || null;
      return verifyRow(row);
    },
    list({ limit = 100 } = {}) {
      return store.query(`SELECT paper_id,state_json,state_sha256,updated_at FROM workflow_states ORDER BY updated_at DESC,paper_id LIMIT ${Math.max(1, Math.min(1000, Number(limit) || 100))};`).rows.map(verifyRow);
    },
  };
  return assertWorkflowStatePort(api);
}
