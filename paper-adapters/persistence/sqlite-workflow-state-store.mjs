import { assertWorkflowStatePort } from '../../paper-ports/workflow-state-port.mjs';
import { failClosedStoreQueries, sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  NATIVE_STORE_LEDGER_STATEMENT_IDS,
} from './native-store-ledger-mutation-plan.mjs';
import { receiptIssuerPolicies } from './receipt-issuer-policy.mjs';
import {
  preparedSqliteReceiptLedgerMutation,
} from './sqlite-receipt-ledger.mjs';

const WORKFLOW_STATE_STREAM = 'workflow-state';
const WORKFLOW_STATE_ENVIRONMENT = 'administrative';
const WORKFLOW_STATE_EVIDENCE_CLASS = 'workflow_state_projection';
const WORKFLOW_STATE_POLICY = receiptIssuerPolicies()['workflow-state-projector'];
const WORKFLOW_STATE_LEDGER_COLUMNS = `state.*,
ledger.receipt_id,
ledger.stream AS receipt_stream,
ledger.paper_id AS receipt_paper_id,
ledger.kind AS receipt_kind,
ledger.status AS receipt_status,
ledger.receipt_json,
ledger.receipt_sha256,
ledger.created_at AS receipt_created_at,
ledger.environment AS receipt_environment,
ledger.evidence_class AS receipt_evidence_class,
ledger.writer_id AS receipt_writer_id,
ledger.writer_kind AS receipt_writer_kind,
ledger.writer_trusted AS receipt_writer_trusted,
ledger.issuer_policy_id AS receipt_issuer_policy_id,
ledger.issuer_policy_hash AS receipt_issuer_policy_hash,
ledger.issuer_assurance AS receipt_issuer_assurance,
ledger.effective_receipt_usable`;

function verifyRow(row) {
  if (!row) return null;
  let projection = null;
  try { projection = JSON.parse(row.state_json); } catch { /* reported below */ }
  const currentHash = projection ? hashRecord('PaperWorkflowStateProjection', projection) : null;
  const canonicalSourceHashes = Array.isArray(projection?.sourceReceiptHashes)
    ? [...new Set(projection.sourceReceiptHashes.filter(Boolean).map(String))].sort()
    : null;
  const projectionPayloadVerified = Boolean(projection
    && exactKeys(projection, ['version', 'kind', 'paperId', 'mode', 'state', 'workflowReceiptHash', 'sourceReceiptHashes', 'recordedAt'])
    && projection.version === 1
    && projection.kind === 'PaperWorkflowStateProjection'
    && projection.paperId === row.paper_id
    && typeof projection.mode === 'string'
    && projection.mode.length > 0
    && projection.state
    && typeof projection.state === 'object'
    && !Array.isArray(projection.state)
    && Array.isArray(projection.sourceReceiptHashes)
    && JSON.stringify(projection.sourceReceiptHashes) === JSON.stringify(canonicalSourceHashes)
    && typeof projection.recordedAt === 'string'
    && Number.isFinite(Date.parse(projection.recordedAt))
    && projection.recordedAt === row.updated_at);
  const projectionHashVerified = Boolean(projectionPayloadVerified && currentHash && currentHash === row.state_sha256);
  let ledgerReceipt = null;
  try { ledgerReceipt = JSON.parse(row.receipt_json); } catch { /* fail closed below */ }
  const { paperWorkflowStateProjectionReceiptHash: declaredReceiptHash = null, ...receiptPayload } = ledgerReceipt || {};
  const receiptPayloadVerified = Boolean(
    ledgerReceipt
    && exactKeys(ledgerReceipt, ['version', 'kind', 'paperId', 'mode', 'status', 'projectionHash', 'workflowReceiptHash', 'createdAt', 'externalActionPerformed', 'paperWorkflowStateProjectionReceiptHash'])
    && ledgerReceipt.version === 1
    && ledgerReceipt.kind === 'PaperWorkflowStateProjectionReceipt'
    && ledgerReceipt.status === 'workflow_state_projection_persisted'
    && ledgerReceipt.paperId === row.paper_id
    && ledgerReceipt.mode === projection?.mode
    && ledgerReceipt.projectionHash === row.state_sha256
    && (ledgerReceipt.workflowReceiptHash ?? null) === (projection?.workflowReceiptHash ?? null)
    && ledgerReceipt.createdAt === projection?.recordedAt
    && ledgerReceipt.externalActionPerformed === false
    && declaredReceiptHash === row.projection_receipt_sha256
    && hashRecord('PaperWorkflowStateProjectionReceipt', receiptPayload) === declaredReceiptHash);
  const ledgerAuthorityVerified = Boolean(
    receiptPayloadVerified
    && row.ledger_receipt_id
    && row.receipt_id === row.ledger_receipt_id
    && row.receipt_id === `${WORKFLOW_STATE_STREAM}:${declaredReceiptHash}`
    && row.receipt_stream === WORKFLOW_STATE_STREAM
    && row.receipt_paper_id === row.paper_id
    && row.receipt_kind === 'PaperWorkflowStateProjectionReceipt'
    && row.receipt_status === 'workflow_state_projection_persisted'
    && row.receipt_created_at === ledgerReceipt.createdAt
    && row.receipt_environment === WORKFLOW_STATE_ENVIRONMENT
    && row.receipt_evidence_class === WORKFLOW_STATE_EVIDENCE_CLASS
    && Number(row.effective_receipt_usable) === 1
    && declaredReceiptHash === row.receipt_sha256
    && Number(row.receipt_writer_trusted) === 1
    && row.receipt_writer_id === WORKFLOW_STATE_POLICY.writerId
    && row.receipt_writer_kind === WORKFLOW_STATE_POLICY.writerKind
    && row.receipt_issuer_policy_id === 'workflow-state-projector'
    && row.receipt_issuer_policy_hash === WORKFLOW_STATE_POLICY.issuerPolicyHash
    && row.receipt_issuer_assurance === WORKFLOW_STATE_POLICY.assurance
  );
  const ledgerHashVerified = receiptPayloadVerified && ledgerAuthorityVerified;
  const integrityVerified = projectionHashVerified && ledgerHashVerified;
  const blockers = [];
  if (!projectionHashVerified) blockers.push('workflow_state_projection_hash_mismatch');
  if (!ledgerHashVerified) blockers.push('workflow_state_projection_receipt_missing_or_invalid');
  return Object.freeze({
    version: 1,
    kind: 'PaperWorkflowStateProjectionVerification',
    paperId: row.paper_id,
    status: integrityVerified ? 'workflow_state_projection_verified' : 'workflow_state_projection_corrupt',
    projection,
    storedHash: row.state_sha256,
    currentHash,
    ledgerReceiptId: row.ledger_receipt_id || null,
    receiptHash: row.projection_receipt_sha256 || null,
    ledgerHashVerified,
    integrityVerified,
    blockers,
  });
}

export function createSqliteWorkflowStateStore({ store: suppliedStore, clock, receiptLedger } = {}) {
  if (!suppliedStore || !clock || !receiptLedger || typeof receiptLedger.prepare !== 'function') throw new Error('Workflow state store requires StorePort, ClockPort and a transactional ReceiptLedgerPort');
  const store = failClosedStoreQueries(suppliedStore);
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
      const prepared = receiptLedger.prepare(receipt, {
        stream: WORKFLOW_STATE_STREAM,
        paperId,
        environment: WORKFLOW_STATE_ENVIRONMENT,
        evidenceClass: WORKFLOW_STATE_EVIDENCE_CLASS,
        strictInsert: true,
      });
      if (prepared.receiptHash !== receipt.paperWorkflowStateProjectionReceiptHash
        || prepared.receiptId !== `${WORKFLOW_STATE_STREAM}:${receipt.paperWorkflowStateProjectionReceiptHash}`
        || prepared.stream !== WORKFLOW_STATE_STREAM
        || prepared.paperId !== paperId
        || prepared.environment !== WORKFLOW_STATE_ENVIRONMENT
        || prepared.evidenceClass !== WORKFLOW_STATE_EVIDENCE_CLASS
        || prepared.writerTrusted !== true
        || prepared.writerId !== WORKFLOW_STATE_POLICY.writerId
        || prepared.writerKind !== WORKFLOW_STATE_POLICY.writerKind
        || prepared.issuerPolicyId !== 'workflow-state-projector'
        || prepared.issuerPolicyHash !== WORKFLOW_STATE_POLICY.issuerPolicyHash
        || prepared.issuerAssurance !== WORKFLOW_STATE_POLICY.assurance) {
        throw new Error('workflow_state_trusted_writer_required');
      }
      if (typeof store.mutate === 'function') {
        const ledgerMutation = preparedSqliteReceiptLedgerMutation(prepared);
        if (ledgerMutation.strictInsert !== true) {
          throw new Error('workflow_state_strict_receipt_insert_required');
        }
        const coordinated = store.mutate({
          databaseRole: 'native-store',
          operationId: 'native-store.workflow-state-store.put.v1',
          authorizationReceiptHashes: [],
          sideEffectReservationHashes: [],
          mutate(transaction) {
            const ledgerChanges = transaction.run(
              NATIVE_STORE_LEDGER_STATEMENT_IDS.insertReceipt,
              ...ledgerMutation.parameters,
            ).changes;
            if (ledgerChanges !== 1) {
              throw new Error('workflow_state_receipt_insert_ambiguous');
            }
            const projectionChanges = transaction.run(
              NATIVE_STORE_LEDGER_STATEMENT_IDS.upsertWorkflowState,
              paperId,
              JSON.stringify(projection),
              projectionHash,
              projection.recordedAt,
              prepared.receiptId,
              receipt.paperWorkflowStateProjectionReceiptHash,
            ).changes;
            if (projectionChanges !== 1) {
              throw new Error('workflow_state_projection_write_ambiguous');
            }
            return Object.freeze({ ledgerChanges, projectionChanges });
          },
        });
        if (coordinated?.status !== 'externally_fenced_sqlite_mutation_finalized'
          || coordinated.value?.ledgerChanges !== 1
          || coordinated.value?.projectionChanges !== 1) {
          throw new Error('workflow_state_external_mutation_receipt_invalid');
        }
        return Object.freeze({
          version: 1,
          kind: 'PaperWorkflowStateProjectionWrite',
          paperId,
          status: 'workflow_state_projection_persisted',
          persisted: true,
          projectionHash,
          receiptHash: receipt.paperWorkflowStateProjectionReceiptHash,
          ledgerReceiptId: prepared.receiptId,
          blockers: [],
        });
      }
      const result = store.execute(`BEGIN IMMEDIATE;
${prepared.sql}
INSERT INTO workflow_states(paper_id,state_json,state_sha256,updated_at,ledger_receipt_id,projection_receipt_sha256)
VALUES(${sqlText(paperId)},${sqlJson(projection)},${sqlText(projectionHash)},${sqlText(projection.recordedAt)},${sqlText(prepared.receiptId)},${sqlText(receipt.paperWorkflowStateProjectionReceiptHash)})
ON CONFLICT(paper_id) DO UPDATE SET state_json=excluded.state_json,state_sha256=excluded.state_sha256,updated_at=excluded.updated_at,ledger_receipt_id=excluded.ledger_receipt_id,projection_receipt_sha256=excluded.projection_receipt_sha256;
COMMIT;`);
      if (!result.ok) throw new Error(result.error || result.stderr || 'workflow_state_projection_transaction_failed');
      return Object.freeze({
        version: 1,
        kind: 'PaperWorkflowStateProjectionWrite',
        paperId,
        status: 'workflow_state_projection_persisted',
        persisted: true,
        projectionHash,
        receiptHash: receipt.paperWorkflowStateProjectionReceiptHash,
        ledgerReceiptId: prepared.receiptId,
        blockers: [],
      });
    },
    get(paperId) {
      if (!paperId) return null;
      const row = store.query(`SELECT ${WORKFLOW_STATE_LEDGER_COLUMNS} FROM workflow_states state LEFT JOIN effective_receipt_ledger ledger ON ledger.receipt_id=state.ledger_receipt_id WHERE state.paper_id=${sqlText(paperId)} LIMIT 1;`).rows[0] || null;
      return verifyRow(row);
    },
    list({ limit = 100 } = {}) {
      return store.query(`SELECT ${WORKFLOW_STATE_LEDGER_COLUMNS} FROM workflow_states state LEFT JOIN effective_receipt_ledger ledger ON ledger.receipt_id=state.ledger_receipt_id ORDER BY state.updated_at DESC,state.paper_id LIMIT ${Math.max(1, Math.min(1000, Number(limit) || 100))};`).rows.map(verifyRow);
    },
  };
  return assertWorkflowStatePort(api);
}
