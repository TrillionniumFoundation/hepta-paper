import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildCampaignEmpiricalAttemptId,
} from '../../paper-domain/automation/campaign-empirical-attempt-identity.mjs';
import {
  verifyExperimentIrExecutionAuthorityReceipt,
} from '../../paper-domain/automation/experiment-ir-execution-authority-contract.mjs';
import {
  verifyAutonomousResearchAgendaProductionReceipt,
} from '../../paper-domain/automation/autonomous-research-agenda-production-contract.mjs';
import { verifyResearchAgendaIr } from '../../paper-domain/automation/research-agenda-ir.mjs';

const REPLAY_NODE = /^(?:empirical-reproduce|revalidate-empirical-reproduce)(?:-|$)/;
const ORIGINAL_EMPIRICAL_NODE = /^(?:empirical|revalidate-empirical)(?:$|-(?!reproduce(?:-|$)))/;

const EXPERIMENT_AUTHORITY_QUERY = `SELECT
      c.campaign_id,c.paper_id,c.status AS campaign_status,
      c.revision AS campaign_revision,c.spec_json,
      n.node_id,n.kind AS node_kind,n.status AS node_status,n.attempt_id,
      n.round_index,n.lease_generation,n.node_revision,
      n.dependencies_json,n.spec_json AS node_spec_json,n.result_json,
      n.result_sha256,n.updated_at AS node_updated_at,
      json_extract(
        n.result_json,'$.experimentIrExecutionAuthorityReceiptHash'
      ) AS experiment_ir_execution_authority_receipt_hash
    FROM paper_campaigns c
    LEFT JOIN campaign_nodes n ON n.campaign_id=c.campaign_id
      AND (n.kind='empirical' OR n.kind LIKE 'empirical-%'
        OR n.kind='revalidate-empirical'
        OR n.kind LIKE 'revalidate-empirical-%')
    WHERE c.campaign_id=?
    ORDER BY n.node_id ASC;`;

function parseJson(value) {
  try { return JSON.parse(String(value || '')); } catch { return null; }
}

function sameCanonicalValue(left, right) {
  return hashRecord('AutomationReadinessCanonicalValue', left)
    === hashRecord('AutomationReadinessCanonicalValue', right);
}

function sourceClosureTerminal(node) {
  return Boolean(node?.sourceClosureTerminal || node?.spec?.sourceClosureTerminal);
}

function canonicalExperimentTopology(plan) {
  const nodes = Array.isArray(plan?.nodes) ? plan.nodes : [];
  const nodeIds = nodes.map((node) => node?.nodeId).filter(Boolean);
  const nodeById = new Map(nodes.map((node) => [node?.nodeId, node]));
  const packageNodes = nodes.filter((node) => (
    ['package', 'release-package'].includes(node?.kind)
  ));
  const packageNode = packageNodes.length === 1 ? packageNodes[0] : null;
  const packageDependencies = (packageNode?.dependencies || [])
    .map((nodeId) => nodeById.get(nodeId)).filter(Boolean);
  const researchNodes = packageDependencies.filter((node) => (
    node.kind === 'research-verify'
  ));
  const researchNode = researchNodes.length === 1 ? researchNodes[0] : null;
  const researchDependencies = (researchNode?.dependencies || [])
    .map((nodeId) => nodeById.get(nodeId)).filter(Boolean);
  const replayNodes = researchDependencies.filter((candidate) => (
    REPLAY_NODE.test(String(candidate?.kind || ''))
  )).sort((left, right) => (
    Number(sourceClosureTerminal(right)) - Number(sourceClosureTerminal(left))
    || Number(right.roundIndex || 0) - Number(left.roundIndex || 0)
    || String(right.nodeId || '').localeCompare(String(left.nodeId || ''))
  ));
  const replayNode = replayNodes[0] || null;
  const replayDependencies = (replayNode?.dependencies || [])
    .map((nodeId) => nodeById.get(nodeId)).filter(Boolean);
  const originalNodes = replayDependencies.filter((node) => (
    ORIGINAL_EMPIRICAL_NODE.test(String(node?.kind || ''))
  ));
  const originalNode = originalNodes.length === 1 ? originalNodes[0] : null;
  const ready = plan?.kind === 'PaperCampaignPlan'
    && plan?.autonomousResearchPreparation?.launchMode === 'production-run'
    && nodes.length > 0
    && nodeIds.length === nodes.length
    && new Set(nodeIds).size === nodes.length
    && packageNode
    && packageDependencies.length === (packageNode.dependencies || []).length
    && researchNode
    && researchDependencies.length === (researchNode.dependencies || []).length
    && replayNode
    && replayDependencies.length === (replayNode.dependencies || []).length
    && replayDependencies.length === 1
    && originalNode;
  return Object.freeze({
    ready: Boolean(ready),
    packageNode,
    researchNode,
    replayNode,
    originalNode,
    blockers: Object.freeze(ready ? [] : [
      'experiment_ir_execution_current_replay_topology_invalid',
    ]),
  });
}

function inspectPlanNodeRow(rows, planNode, plan, blockerPrefix) {
  const matches = planNode ? rows.filter((row) => (
    row?.node_id === planNode.nodeId
  )) : [];
  const row = matches.length === 1 ? matches[0] : null;
  const leaseGeneration = Number(row?.lease_generation);
  const nodeRevision = Number(row?.node_revision);
  const blockers = [];
  if (!row) blockers.push(`${blockerPrefix}_node_required`);
  if (matches.length > 1) blockers.push(`${blockerPrefix}_node_ambiguous`);
  if (row && (row.campaign_id !== plan.campaignId
    || row.paper_id !== plan.paperId
    || row.node_kind !== planNode.kind
    || Number(row.round_index) !== Number(planNode.roundIndex || 0)
    || !sameCanonicalValue(parseJson(row.dependencies_json), planNode.dependencies || [])
    || !sameCanonicalValue(parseJson(row.node_spec_json), planNode))) {
    blockers.push(`${blockerPrefix}_plan_binding_invalid`);
  }
  if (row && (!row.attempt_id
    || !Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1
    || !Number.isSafeInteger(nodeRevision) || nodeRevision < 0)) {
    blockers.push(`${blockerPrefix}_generation_invalid`);
  }
  if (row && row.node_status !== 'completed') {
    blockers.push(`${blockerPrefix}_not_completed`);
  }
  if (row?.node_status === 'completed') {
    const result = parseJson(row.result_json);
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || hashRecord('PaperCampaignNodeResult', result) !== row.result_sha256) {
      blockers.push(`${blockerPrefix}_result_identity_invalid`);
    }
  }
  return Object.freeze({
    ready: blockers.length === 0,
    planNode,
    row,
    blockers: Object.freeze(blockers),
  });
}

export function inspectAutomationReadinessCanonicalExperimentRows(
  plan, rows = [],
) {
  const { campaignPlanHash: planHash, ...planPayload } = plan || {};
  const planValid = plan?.kind === 'PaperCampaignPlan'
    && hashRecord('PaperCampaignPlan', planPayload) === planHash;
  const topology = planValid
    ? canonicalExperimentTopology(plan)
    : Object.freeze({
      ready: false,
      replayNode: null,
      originalNode: null,
      blockers: Object.freeze([
        'experiment_ir_execution_current_campaign_plan_invalid',
      ]),
    });
  const candidates = Array.isArray(rows) ? rows : [];
  const replay = inspectPlanNodeRow(
    candidates,
    topology.replayNode,
    plan,
    'experiment_ir_execution_current_replay',
  );
  const original = inspectPlanNodeRow(
    candidates,
    topology.originalNode,
    plan,
    'experiment_ir_execution_current_original',
  );
  const blockers = Object.freeze([...new Set([
    ...topology.blockers,
    ...replay.blockers,
    ...original.blockers,
  ])]);
  return Object.freeze({
    ready: blockers.length === 0,
    planHash: planHash || null,
    topology,
    replay,
    original,
    blockers,
  });
}

function persistedExperimentNodeSnapshot(row) {
  return Object.freeze({
    nodeId: row?.node_id || null,
    attemptId: row?.attempt_id || null,
    leaseGeneration: Number(row?.lease_generation),
    roundIndex: Number(row?.round_index),
    revision: Number(row?.node_revision),
    status: row?.node_status || null,
    resultHash: row?.result_sha256 || null,
  });
}

export function automationReadinessExperimentInspectionMatchesRows(
  inspection,
  canonicalRows,
) {
  if (inspection?.ready !== true || canonicalRows?.ready !== true) return false;
  const expected = Object.freeze({
    replay: Object.freeze({
      nodeId: inspection.nodeId,
      attemptId: inspection.nodeAttemptId,
      leaseGeneration: Number(inspection.nodeLeaseGeneration),
      roundIndex: Number(inspection.nodeRoundIndex),
      revision: Number(inspection.nodeRevision),
      status: inspection.nodeStatus,
      resultHash: inspection.resultHash,
    }),
    original: Object.freeze({
      nodeId: inspection.originalNodeId,
      attemptId: inspection.originalNodeAttemptId,
      leaseGeneration: Number(inspection.originalNodeLeaseGeneration),
      roundIndex: Number(inspection.originalNodeRoundIndex),
      revision: Number(inspection.originalNodeRevision),
      status: inspection.originalNodeStatus,
      resultHash: inspection.originalResultHash,
    }),
  });
  const current = Object.freeze({
    replay: persistedExperimentNodeSnapshot(canonicalRows.replay.row),
    original: persistedExperimentNodeSnapshot(canonicalRows.original.row),
  });
  return hashRecord('AutomationReadinessExperimentAuthoritySnapshot', current)
    === hashRecord('AutomationReadinessExperimentAuthoritySnapshot', expected);
}

function verifiedCandidate(row, originalRow, expected = {}) {
  const plan = parseJson(row?.spec_json);
  const result = parseJson(row?.result_json);
  const originalResult = parseJson(originalRow?.result_json);
  const { campaignPlanHash: claimedPlanHash, ...planPayload } = plan || {};
  const authority = result?.experimentIrExecutionAuthorityReceipt || null;
  const replay = result?.experimentReplayReceipt || null;
  const preparation = plan?.autonomousResearchPreparation || null;
  const agendaReceipt = preparation?.researchAgendaProducerReceipt || null;
  const agendaIr = preparation?.researchAgendaIr || null;
  const replayHarness = replay?.replayRunReceipt?.harnessExecutionReceipt || null;
  const originalRun = replay?.originalRunReceipt || null;
  const replayRun = replay?.replayRunReceipt || null;
  let originalAttemptId = null;
  let replayAttemptId = null;
  try {
    originalAttemptId = buildCampaignEmpiricalAttemptId({
      campaignId: row?.campaign_id,
      nodeId: originalRow?.node_id,
      attemptId: originalRow?.attempt_id,
      attemptVersion: originalRun?.preDataAccessFreeze?.attemptVersion || 1,
    });
    replayAttemptId = buildCampaignEmpiricalAttemptId({
      campaignId: row?.campaign_id,
      nodeId: row?.node_id,
      attemptId: row?.attempt_id,
      attemptVersion: replayRun?.preDataAccessFreeze?.attemptVersion || 1,
    });
  } catch { return null; }
  if (plan?.kind !== 'PaperCampaignPlan'
    || row?.campaign_status !== expected.campaignStatus
    || Number(row?.campaign_revision) !== expected.campaignRevision
    || row?.campaign_id !== plan?.campaignId
    || row?.paper_id !== plan?.paperId
    || row?.node_status !== 'completed'
    || row?.node_id !== authority?.nodeId
    || row?.node_kind !== authority?.nodeKind
    || hashRecord('PaperCampaignPlan', planPayload) !== claimedPlanHash
    || hashRecord('PaperCampaignNodeResult', result) !== row?.result_sha256
    || hashRecord('PaperCampaignNodeResult', originalResult)
      !== originalRow?.result_sha256
    || !verifyAutonomousResearchAgendaProductionReceipt(agendaReceipt).valid
    || !verifyResearchAgendaIr(agendaIr, { agendaProductionReceipt: agendaReceipt })
    || !verifyExperimentIrExecutionAuthorityReceipt(authority, {
      campaignId: row.campaign_id,
      paperId: row.paper_id,
      campaignPlanHash: claimedPlanHash,
      nodeId: row.node_id,
      nodeKind: row.node_kind,
      researchAgendaIr: agendaIr,
      researchAgendaProducerReceipt: agendaReceipt,
      proposal: preparation?.proposal,
      researchAgendaClaimBindingReceipt: preparation?.agendaClaimBindingReceipt,
      experimentReplayReceipt: replay,
    })
    || result?.experimentIrExecutionAuthorityReceiptHash
      !== authority.experimentIrExecutionAuthorityReceiptHash
    || result?.experimentRunReceipt?.experimentRunReceiptHash
      !== authority.replayExperimentRunReceiptHash
    || originalResult?.experimentRunReceipt?.experimentRunReceiptHash
      !== authority.originalExperimentRunReceiptHash
    || originalRun?.experimentAttemptId !== originalAttemptId
    || replayRun?.experimentAttemptId !== replayAttemptId
    || result?.harnessExecutionReceipt?.systemBenchmarkHarnessExecutionReceiptHash
      !== authority.replaySystemBenchmarkHarnessExecutionReceiptHash
    || result?.versionedExperimentIrHash !== authority.replayVersionedExperimentIrHash
    || result?.experimentIr?.versionedExperimentIrHash
      !== authority.replayVersionedExperimentIrHash
    || replayHarness?.systemBenchmarkHarnessExecutionReceiptHash
      !== authority.replaySystemBenchmarkHarnessExecutionReceiptHash
    || plan?.executionIntent?.benchmarkSelectorHash
      !== authority.campaignPlanBenchmarkSelectorHash
    || plan?.benchmarkSelector?.campaignBenchmarkSelectorHash
      !== authority.campaignPlanBenchmarkSelectorHash
    || (expected.campaignId && row.campaign_id !== expected.campaignId)
    || (expected.paperId && row.paper_id !== expected.paperId)
    || (expected.campaignPlanHash && claimedPlanHash !== expected.campaignPlanHash)
    || (expected.researchAgendaIrHash
      && agendaIr.researchAgendaIrHash !== expected.researchAgendaIrHash)
    || (expected.researchAgendaProducerReceiptHash
      && agendaReceipt?.autonomousResearchAgendaProductionReceiptHash
        !== expected.researchAgendaProducerReceiptHash)
    || (expected.protocolFamily && authority.protocolFamily !== expected.protocolFamily)) {
    return null;
  }
  return Object.freeze({
    campaignId: row.campaign_id,
    paperId: row.paper_id,
    nodeId: row.node_id,
    nodeAttemptId: row.attempt_id,
    nodeLeaseGeneration: Number(row.lease_generation),
    nodeRoundIndex: Number(row.round_index),
    nodeRevision: Number(row.node_revision),
    nodeStatus: row.node_status,
    resultHash: row.result_sha256,
    originalNodeId: originalRow.node_id,
    originalNodeAttemptId: originalRow.attempt_id,
    originalNodeLeaseGeneration: Number(originalRow.lease_generation),
    originalNodeRoundIndex: Number(originalRow.round_index),
    originalNodeRevision: Number(originalRow.node_revision),
    originalNodeStatus: originalRow.node_status,
    originalResultHash: originalRow.result_sha256,
    campaignPlanHash: claimedPlanHash,
    researchAgendaIr: agendaIr,
    researchAgendaProducerReceipt: agendaReceipt,
    receipt: authority,
    experimentReplayReceipt: replay,
    originalHarnessExecutionReceipt:
      replay.originalRunReceipt.harnessExecutionReceipt,
    experimentHarnessExecutionReceipt: replayHarness,
    updatedAt: row.node_updated_at || row.campaign_updated_at || null,
  });
}

export function inspectPersistedExperimentIrExecutionAuthority({
  store,
  agendaAuthorityInspection = null,
} = {}) {
  const query = store?.query?.(
    EXPERIMENT_AUTHORITY_QUERY,
    [agendaAuthorityInspection?.campaignId || null],
  );
  if (!query?.ok) {
    return Object.freeze({
      status: 'experiment_ir_execution_authority_unavailable',
      ready: false,
      statusReadOnly: true,
      campaignId: null,
      paperId: null,
      nodeId: null,
      nodeAttemptId: null,
      nodeLeaseGeneration: null,
      nodeRoundIndex: null,
      nodeRevision: null,
      nodeStatus: null,
      resultHash: null,
      originalNodeId: null,
      originalNodeAttemptId: null,
      originalNodeLeaseGeneration: null,
      originalNodeRoundIndex: null,
      originalNodeRevision: null,
      originalNodeStatus: null,
      originalResultHash: null,
      receipt: null,
      experimentReplayReceipt: null,
      originalHarnessExecutionReceipt: null,
      experimentHarnessExecutionReceipt: null,
      blockers: Object.freeze(['experiment_ir_execution_authority_query_failed']),
    });
  }
  if (agendaAuthorityInspection?.ready !== true) {
    return Object.freeze({
      status: 'experiment_ir_execution_authority_not_persisted',
      ready: false,
      statusReadOnly: true,
      campaignId: null,
      paperId: null,
      nodeId: null,
      nodeAttemptId: null,
      nodeLeaseGeneration: null,
      nodeRoundIndex: null,
      nodeRevision: null,
      nodeStatus: null,
      resultHash: null,
      originalNodeId: null,
      originalNodeAttemptId: null,
      originalNodeLeaseGeneration: null,
      originalNodeRoundIndex: null,
      originalNodeRevision: null,
      originalNodeStatus: null,
      originalResultHash: null,
      campaignPlanHash: null,
      researchAgendaIr: null,
      researchAgendaProducerReceipt: null,
      receipt: null,
      experimentReplayReceipt: null,
      originalHarnessExecutionReceipt: null,
      experimentHarnessExecutionReceipt: null,
      blockers: Object.freeze([
        'experiment_ir_execution_current_agenda_authority_required',
      ]),
    });
  }
  const expected = Object.freeze({
    campaignId: agendaAuthorityInspection?.campaignId || null,
    paperId: agendaAuthorityInspection?.paperId || null,
    campaignPlanHash: agendaAuthorityInspection?.campaignPlanHash || null,
    researchAgendaIrHash:
      agendaAuthorityInspection?.researchAgendaIr?.researchAgendaIrHash || null,
    protocolFamily:
      agendaAuthorityInspection?.researchAgendaProducerReceipt
        ?.selectedProtocolFamily || null,
    researchAgendaProducerReceiptHash:
      agendaAuthorityInspection?.researchAgendaProducerReceiptHash
      || agendaAuthorityInspection?.researchAgendaProducerReceipt
        ?.autonomousResearchAgendaProductionReceiptHash || null,
    campaignStatus: agendaAuthorityInspection?.campaignStatus || null,
    campaignRevision: Number(agendaAuthorityInspection?.campaignRevision),
  });
  const rows = (query.rows || []).filter((row) => (
    row.campaign_id === expected.campaignId
      && row.paper_id === expected.paperId
  ));
  const plan = parseJson(rows[0]?.spec_json);
  const canonicalRows = inspectAutomationReadinessCanonicalExperimentRows(
    plan,
    rows,
  );
  const candidate = canonicalRows.ready
    ? verifiedCandidate(
      canonicalRows.replay.row,
      canonicalRows.original.row,
      expected,
    ) : null;
  const blockers = candidate ? [] : canonicalRows.ready
    ? ['experiment_ir_execution_current_replay_authority_invalid']
    : canonicalRows.blockers;
  return Object.freeze({
    status: candidate
      ? 'experiment_ir_execution_authority_verified'
      : 'experiment_ir_execution_authority_not_persisted',
    ready: Boolean(candidate),
    statusReadOnly: true,
    campaignId: candidate?.campaignId || null,
    paperId: candidate?.paperId || null,
    nodeId: candidate?.nodeId || null,
    nodeAttemptId: candidate?.nodeAttemptId || null,
    nodeLeaseGeneration: candidate?.nodeLeaseGeneration ?? null,
    nodeRoundIndex: candidate?.nodeRoundIndex ?? null,
    nodeRevision: candidate?.nodeRevision ?? null,
    nodeStatus: candidate?.nodeStatus || null,
    resultHash: candidate?.resultHash || null,
    originalNodeId: candidate?.originalNodeId || null,
    originalNodeAttemptId: candidate?.originalNodeAttemptId || null,
    originalNodeLeaseGeneration:
      candidate?.originalNodeLeaseGeneration ?? null,
    originalNodeRoundIndex: candidate?.originalNodeRoundIndex ?? null,
    originalNodeRevision: candidate?.originalNodeRevision ?? null,
    originalNodeStatus: candidate?.originalNodeStatus || null,
    originalResultHash: candidate?.originalResultHash || null,
    campaignPlanHash: candidate?.campaignPlanHash || null,
    researchAgendaIr: candidate?.researchAgendaIr || null,
    researchAgendaProducerReceipt:
      candidate?.researchAgendaProducerReceipt || null,
    receipt: candidate?.receipt || null,
    experimentReplayReceipt: candidate?.experimentReplayReceipt || null,
    originalHarnessExecutionReceipt:
      candidate?.originalHarnessExecutionReceipt || null,
    experimentHarnessExecutionReceipt:
      candidate?.experimentHarnessExecutionReceipt || null,
    blockers: Object.freeze(blockers),
  });
}
