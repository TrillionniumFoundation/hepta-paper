import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export const WORKFLOW_OPERATIONAL_AUTHORITY = Object.freeze({
  version: 1,
  authorityId: 'campaign-dag-v1',
  campaignTable: 'paper_campaigns',
  nodeTable: 'campaign_nodes',
  eventTable: 'campaign_events',
  batchRole: 'command_use_case_facade',
  paperStatusRole: 'canonical_read_projection',
  legacyWorkflowStateRole: 'explicit_compatibility_projection',
});

export function buildWorkflowAuthorityLineage({
  paperId,
  mode,
  execute = false,
  workflowReceiptHash = null,
  campaignId = null,
  campaignPlanHash = null,
  legacyProjectionRequested = false,
  recordedAt,
} = {}) {
  if (!paperId || !mode || !recordedAt) throw new Error('workflow authority lineage requires paperId, mode and recordedAt');
  if (execute && (!campaignId || !campaignPlanHash)) {
    throw new Error('workflow authority lineage requires campaignId and campaignPlanHash for execution');
  }
  const legacyProjectionAuthorized = Boolean(execute && legacyProjectionRequested);
  const payload = {
    version: 1,
    kind: 'WorkflowAuthorityLineageReceipt',
    status: execute ? 'workflow_authority_lineage_recorded' : 'workflow_authority_lineage_previewed',
    paperId,
    mode,
    campaignId,
    campaignPlanHash,
    workflowReceiptHash,
    operationalAuthority: WORKFLOW_OPERATIONAL_AUTHORITY.authorityId,
    operationalAuthorityTables: [
      WORKFLOW_OPERATIONAL_AUTHORITY.campaignTable,
      WORKFLOW_OPERATIONAL_AUTHORITY.nodeTable,
      WORKFLOW_OPERATIONAL_AUTHORITY.eventTable,
    ],
    batchRole: WORKFLOW_OPERATIONAL_AUTHORITY.batchRole,
    paperStatusRole: WORKFLOW_OPERATIONAL_AUTHORITY.paperStatusRole,
    legacyWorkflowStateRole: WORKFLOW_OPERATIONAL_AUTHORITY.legacyWorkflowStateRole,
    legacyProjectionRequested: Boolean(legacyProjectionRequested),
    legacyProjectionAuthorized,
    recordedAt,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    workflowAuthorityLineageReceiptHash: hashRecord('WorkflowAuthorityLineageReceipt', payload),
  });
}

export function assertLegacyWorkflowProjectionAuthorized(lineage) {
  if (lineage?.kind !== 'WorkflowAuthorityLineageReceipt'
    || lineage?.operationalAuthority !== WORKFLOW_OPERATIONAL_AUTHORITY.authorityId
    || lineage?.legacyWorkflowStateRole !== WORKFLOW_OPERATIONAL_AUTHORITY.legacyWorkflowStateRole
    || lineage?.legacyProjectionAuthorized !== true) {
    throw new Error('legacy_workflow_projection_not_authorized');
  }
  return lineage;
}

export function buildCanonicalPaperStatusReadProjection({ paperId, observedStatus = null, state = null, recordedAt } = {}) {
  if (!paperId || !recordedAt) throw new Error('canonical paper status projection requires paperId and recordedAt');
  return Object.freeze({
    version: 1,
    kind: 'CanonicalPaperStatusReadProjection',
    paperId,
    status: observedStatus || state?.stage || state?.readinessStatus || 'unknown',
    source: 'papers.status',
    role: WORKFLOW_OPERATIONAL_AUTHORITY.paperStatusRole,
    operationalAuthority: WORKFLOW_OPERATIONAL_AUTHORITY.authorityId,
    recordedAt,
  });
}
