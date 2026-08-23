import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  evaluateCampaignReleaseTopology,
} from '../../paper-domain/automation/campaign-release-topology-policy.mjs';

export const ASSURANCE_AUTHORITY_QUERY = `SELECT
    c.campaign_id,c.paper_id,c.status AS campaign_status,
    c.revision AS campaign_revision,c.spec_json,
    n.node_id,n.kind AS node_kind,n.status AS node_status,n.attempt_id,
    n.round_index,n.lease_generation,n.node_revision,
    n.dependencies_json,n.spec_json AS node_spec_json,n.result_json,
    n.result_sha256,n.updated_at
  FROM campaign_nodes n
  JOIN paper_campaigns c ON c.campaign_id=n.campaign_id
  WHERE c.campaign_id=? AND (
    n.kind IN ('formal-verify','research-verify','gpu-scientific-execution')
    OR n.kind='empirical' OR n.kind LIKE 'empirical-%'
    OR n.kind='revalidate-empirical'
    OR n.kind LIKE 'revalidate-empirical-%'
  )
  ORDER BY n.node_id ASC;`;

export function parseAutomationReadinessJson(value) {
  try { return JSON.parse(String(value || '')); } catch { return null; }
}

export function sameAutomationReadinessJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const GPU_SCIENTIFIC_RESEARCH_BINDING_FIELDS = Object.freeze([
  'researchNodeId',
  'researchAttemptId',
  'researchLeaseGeneration',
  'researchRoundIndex',
  'researchNodeRevision',
  'researchNodeStatus',
  'researchResultHash',
]);

const GPU_SCIENTIFIC_SNAPSHOT_BINDING_FIELDS = Object.freeze([
  'campaignId',
  'paperId',
  'campaignStatus',
  'campaignRevision',
  'campaignPlanHash',
  ...GPU_SCIENTIFIC_RESEARCH_BINDING_FIELDS,
  'formalNodeId',
  'formalAttemptId',
  'formalLeaseGeneration',
  'formalRoundIndex',
  'formalNodeRevision',
  'formalNodeStatus',
  'formalResultHash',
  'nodeId',
  'nodeAttemptId',
  'nodeLeaseGeneration',
  'nodeRoundIndex',
  'nodeRevision',
  'nodeStatus',
  'executionResultHash',
  'artifactArchiveManifestHash',
  'qualificationEvidenceHash',
  'producerArchiveManifestHash',
  'gpuScientificCampaignQualificationAuthorityInspectionHash',
]);

function parseJson(value) {
  try { return JSON.parse(String(value || '')); } catch { return null; }
}

function sourceClosureTerminal(node) {
  return Boolean(node?.sourceClosureTerminal || node?.spec?.sourceClosureTerminal);
}

function sameCanonicalValue(left, right) {
  return hashRecord('AutomationReadinessCanonicalValue', left)
    === hashRecord('AutomationReadinessCanonicalValue', right);
}

function resolveCanonicalAuthorityTopology(plan, { requireFormal = false } = {}) {
  const nodes = Array.isArray(plan?.nodes) ? plan.nodes : [];
  const nodeIds = nodes.map((node) => node?.nodeId).filter(Boolean);
  const nodeById = new Map(nodes.map((node) => [node?.nodeId, node]));
  const releaseTopology = evaluateCampaignReleaseTopology({ nodes });
  const packages = nodes.filter((node) => (
    ['package', 'release-package'].includes(node?.kind)
  ));
  const packageNode = packages.length === 1 ? packages[0] : null;
  const packageTopology = packageNode
    ? releaseTopology.packageTopologies.find((candidate) => (
      candidate.packageNode.nodeId === packageNode.nodeId
    )) || null : null;
  const packageDependencies = (packageNode?.dependencies || [])
    .map((nodeId) => nodeById.get(nodeId)).filter(Boolean);
  const finalCompileNode = packageTopology?.finalCompileNode || null;
  const researchNode = packageTopology?.researchVerifyNode || null;
  const researchDependencies = (researchNode?.dependencies || [])
    .map((nodeId) => nodeById.get(nodeId)).filter(Boolean);
  const gpuNodes = researchDependencies.filter((node) => (
    node.kind === 'gpu-scientific-execution'
  ));
  const sourceClosureFormalNodes = nodes.filter((node) => (
    node?.kind === 'formal-verify' && sourceClosureTerminal(node)
  ));
  const gpuNode = gpuNodes.length === 1 ? gpuNodes[0] : null;
  const formalNode = sourceClosureFormalNodes.length === 1
    ? sourceClosureFormalNodes[0] : null;
  const ready = nodes.length > 0
    && nodeIds.length === nodes.length
    && new Set(nodeIds).size === nodes.length
    && packageNode
    && packageTopology
    && releaseTopology.status === 'campaign_release_topology_verified'
    && packageDependencies.length === (packageNode.dependencies || []).length
    && researchNode
    && finalCompileNode
    && researchDependencies.length === (researchNode.dependencies || []).length
    && gpuNode
    && (formalNode || !requireFormal)
    && gpuNode.nodeId === plan?.gpuScientificExecutionPlan?.nodeId;
  const blockers = ready ? [] : [
    'automation_readiness_canonical_plan_topology_invalid',
    ...releaseTopology.blockers,
  ];
  return Object.freeze({
    ready: Boolean(ready),
    releaseTopology,
    packageNode,
    packageTopology,
    finalCompileNode,
    researchNode,
    gpuNode,
    formalNode,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

function inspectCanonicalAuthorityRow(
  rows, planNode, blockerPrefix, plan, { required = true } = {},
) {
  const matches = planNode ? rows.filter((row) => (
    row?.node_id === planNode.nodeId
  )) : [];
  const row = matches.length === 1 ? matches[0] : null;
  const leaseGeneration = Number(row?.lease_generation);
  const nodeRevision = Number(row?.node_revision);
  const blockers = [];
  if (!row && required) blockers.push(`${blockerPrefix}_canonical_node_required`);
  if (matches.length > 1) blockers.push(`${blockerPrefix}_canonical_node_ambiguous`);
  if (row && (row.node_kind !== planNode.kind
    || row.campaign_id !== plan.campaignId
    || row.paper_id !== plan.paperId
    || Number(row.round_index) !== Number(planNode.roundIndex || 0)
    || !sameCanonicalValue(parseJson(row.dependencies_json), planNode.dependencies || [])
    || !sameCanonicalValue(parseJson(row.node_spec_json), planNode))) {
    blockers.push(`${blockerPrefix}_canonical_node_plan_binding_invalid`);
  }
  if (row && (!row.attempt_id
    || !Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1
    || !Number.isSafeInteger(nodeRevision) || nodeRevision < 0)) {
    blockers.push(`${blockerPrefix}_canonical_node_generation_invalid`);
  }
  if (row && row.node_status !== 'completed') {
    blockers.push(`${blockerPrefix}_canonical_node_not_completed`);
  }
  return Object.freeze({
    ready: blockers.length === 0,
    planNode,
    row,
    blockers: Object.freeze(blockers),
  });
}

export function inspectAutomationReadinessCanonicalAuthorityRows(
  plan, rows = [], { requireFormal = false } = {},
) {
  const { campaignPlanHash: planHash, ...planPayload } = plan || {};
  const planValid = plan?.kind === 'PaperCampaignPlan'
    && hashRecord('PaperCampaignPlan', planPayload) === planHash;
  const topology = planValid
    ? resolveCanonicalAuthorityTopology(plan, { requireFormal })
    : Object.freeze({
      ready: false,
      releaseTopology: null,
      packageNode: null,
      packageTopology: null,
      finalCompileNode: null,
      researchNode: null,
      gpuNode: null,
      formalNode: null,
      blockers: Object.freeze(['automation_readiness_canonical_plan_hash_invalid']),
    });
  const candidates = Array.isArray(rows) ? rows : [];
  const research = inspectCanonicalAuthorityRow(
    candidates, topology.researchNode, 'gpu_scientific_research', plan,
  );
  const gpu = inspectCanonicalAuthorityRow(
    candidates, topology.gpuNode, 'gpu_scientific_execution', plan,
  );
  const formal = inspectCanonicalAuthorityRow(
    candidates, topology.formalNode, 'autonomous_research_formal', plan,
    { required: requireFormal || Boolean(topology.formalNode) },
  );
  const blockers = Object.freeze([...new Set([
    ...topology.blockers,
    ...research.blockers,
    ...gpu.blockers,
    ...formal.blockers,
  ])]);
  return Object.freeze({
    ready: blockers.length === 0,
    planHash: planHash || null,
    topology,
    research,
    gpu,
    formal,
    blockers,
  });
}

export function sameGpuScientificInspectionSnapshot(left, right) {
  return Boolean(left && right)
    && left.ready === right.ready
    && GPU_SCIENTIFIC_SNAPSHOT_BINDING_FIELDS.every((field) => (
      left[field] === right[field]
    ));
}

export function gpuScientificCampaignSnapshotBlockers({
  row,
  planHash,
  campaignId,
  paperId,
  expectedAgendaAuthorityInspection = null,
} = {}) {
  const campaignStatus = row?.campaign_status || null;
  const campaignRevision = Number(row?.campaign_revision);
  const snapshotMismatch = expectedAgendaAuthorityInspection !== null
    && expectedAgendaAuthorityInspection !== undefined
    && (expectedAgendaAuthorityInspection.ready !== true
      || expectedAgendaAuthorityInspection.campaignId !== campaignId
      || expectedAgendaAuthorityInspection.paperId !== paperId
      || expectedAgendaAuthorityInspection.campaignStatus !== campaignStatus
      || Number(expectedAgendaAuthorityInspection.campaignRevision)
        !== campaignRevision
      || expectedAgendaAuthorityInspection.campaignPlanHash !== planHash);
  return Object.freeze([
    ...(!['running', 'completed'].includes(campaignStatus)
      ? ['gpu_scientific_current_campaign_status_invalid'] : []),
    ...(!Number.isSafeInteger(campaignRevision) || campaignRevision < 0
      ? ['gpu_scientific_current_campaign_revision_invalid'] : []),
    ...(snapshotMismatch
      ? ['gpu_scientific_agenda_authority_snapshot_mismatch'] : []),
  ]);
}

export function blockGpuScientificInspection(inspection, extraBlockers = []) {
  const blockers = Object.freeze([...new Set([
    ...(inspection?.blockers || []),
    ...extraBlockers,
  ])]);
  return Object.freeze({
    ...inspection,
    status: 'campaign_research_gpu_scientific_release_chain_blocked',
    ready: false,
    blockers,
  });
}

export function blockGpuScientificInspectionSnapshot(inspection) {
  return blockGpuScientificInspection(inspection, [
    'gpu_scientific_release_chain_snapshot_mismatch',
  ]);
}

export function gpuScientificInspectionMatchesResearchNode(
  inspection,
  researchNode,
  researchResult,
) {
  const resultHash = hashRecord('PaperCampaignNodeResult', researchResult);
  return inspection?.ready === true
    && inspection.researchNodeId === researchNode?.node_id
    && inspection.researchAttemptId === researchNode?.attempt_id
    && inspection.researchLeaseGeneration
      === Number(researchNode?.lease_generation)
    && inspection.researchRoundIndex === Number(researchNode?.round_index)
    && inspection.researchNodeRevision === Number(researchNode?.node_revision)
    && inspection.researchNodeStatus === researchNode?.node_status
    && inspection.researchResultHash === researchNode?.result_sha256
    && inspection.researchResultHash === resultHash
    && researchResult?.researchNodeId === researchNode?.node_id
    && researchResult?.researchAttemptId === researchNode?.attempt_id
    && researchResult?.researchLeaseGeneration
      === Number(researchNode?.lease_generation);
}
