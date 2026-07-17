import { safeJsonParse } from '../../workflow-kernel/runtime/data-utils.mjs';
import { assertRefereeIssueQueryPort } from '../../paper-ports/referee-issue-query-port.mjs';
import { assertParameterizedStorePort } from '../../paper-ports/store-port.mjs';

function requirePaperId(paperId) {
  const value = String(paperId || '').trim();
  if (!value) throw new Error('RefereeIssueQueryPort paperId is required');
  return value;
}

function resultRows(result, operation) {
  if (!result?.ok) throw new Error(result?.error || result?.stderr || `referee_issue_query_${operation}_failed`);
  return result.rows || [];
}

function mapIssue(row = {}) {
  return Object.freeze({
    requestId: Number(row.request_id),
    paperId: String(row.slug || ''),
    requestKey: String(row.request_key || ''),
    matrixRank: Number(row.matrix_rank || 0),
    status: String(row.status || ''),
    riskClass: String(row.risk_class || ''),
    objection: String(row.objection || ''),
    sourceLocator: String(row.source_locator || ''),
    evidenceLocator: String(row.evidence_locator || ''),
    proposedFix: String(row.proposed_fix || ''),
    evidenceNeeded: String(row.evidence_needed || ''),
    verification: String(row.verification || ''),
    patchScope: String(row.patch_scope || ''),
    sourceBatchId: String(row.source_batch_id || ''),
    sourcePatchId: row.source_patch_id == null ? null : Number(row.source_patch_id),
    sourceReportPath: String(row.source_report_path || ''),
    sourceRequestPath: String(row.source_request_path || ''),
    evidenceStatus: String(row.evidence_status || ''),
    evidenceRelevanceStatus: String(row.evidence_relevance_status || ''),
    assignee: String(row.assignee || ''),
    stateReason: String(row.state_reason || ''),
    lastTransitionAt: String(row.last_transition_at || ''),
    workerPatchId: row.worker_patch_id == null ? null : Number(row.worker_patch_id),
    verificationLogPath: String(row.verification_log_path || ''),
    clusterKey: String(row.cluster_key || ''),
    clusterLabel: String(row.cluster_label || ''),
    clusterRank: Number(row.cluster_rank || 0),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
    metadata: safeJsonParse(row.metadata_json || '{}', {}),
  });
}

export function createSqliteRefereeIssueQuery({ store } = {}) {
  const ownedStore = assertParameterizedStorePort(store);
  return assertRefereeIssueQueryPort(Object.freeze({
    version: 1,
    kind: 'SqliteRefereeIssueQueryAdapter',
    countOpenByPaperId(paperId) {
      const rows = resultRows(ownedStore.query(
        'SELECT count(*) AS count FROM referee_revision_requests WHERE slug=? AND status NOT IN (?,?);',
        [requirePaperId(paperId), 'resolved', 'closed'],
      ), 'count_open');
      return Number(rows[0]?.count || 0);
    },
    listOpenByPaperId(paperId, { limit = 100 } = {}) {
      const boundedLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
      return resultRows(ownedStore.query(
        `SELECT * FROM referee_revision_requests
         WHERE slug=? AND status NOT IN (?,?)
         ORDER BY matrix_rank,request_id LIMIT ?;`,
        [requirePaperId(paperId), 'resolved', 'closed', boundedLimit],
      ), 'list_open').map(mapIssue);
    },
  }));
}
