import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyExperimentIrExecutionAuthorityReceipt,
} from '../../paper-domain/automation/experiment-ir-execution-authority-contract.mjs';
import {
  verifyAutonomousResearchAgendaProductionReceipt,
} from '../../paper-domain/automation/autonomous-research-agenda-production-contract.mjs';
import { verifyResearchAgendaIr } from '../../paper-domain/automation/research-agenda-ir.mjs';

function parseJson(value) {
  try { return JSON.parse(String(value || '')); } catch { return null; }
}

function verifiedCandidate(row, expected = {}) {
  const plan = parseJson(row?.spec_json);
  const result = parseJson(row?.result_json);
  const { campaignPlanHash: claimedPlanHash, ...planPayload } = plan || {};
  const authority = result?.experimentIrExecutionAuthorityReceipt || null;
  const replay = result?.experimentReplayReceipt || null;
  const preparation = plan?.autonomousResearchPreparation || null;
  const agendaReceipt = preparation?.researchAgendaProducerReceipt || null;
  const agendaIr = preparation?.researchAgendaIr || null;
  const replayHarness = replay?.replayRunReceipt?.harnessExecutionReceipt || null;
  if (plan?.kind !== 'PaperCampaignPlan'
    || row?.campaign_id !== plan?.campaignId
    || row?.paper_id !== plan?.paperId
    || row?.node_status !== 'completed'
    || row?.node_id !== authority?.nodeId
    || row?.node_kind !== authority?.nodeKind
    || hashRecord('PaperCampaignPlan', planPayload) !== claimedPlanHash
    || hashRecord('PaperCampaignNodeResult', result) !== row?.result_sha256
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
    || (expected.protocolFamily && authority.protocolFamily !== expected.protocolFamily)) {
    return null;
  }
  return Object.freeze({
    campaignId: row.campaign_id,
    paperId: row.paper_id,
    nodeId: row.node_id,
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
  const query = store?.query?.(`SELECT
      c.campaign_id,c.paper_id,c.spec_json,c.updated_at AS campaign_updated_at,
      n.node_id,n.kind AS node_kind,n.status AS node_status,n.result_json,
      n.result_sha256,n.updated_at AS node_updated_at
    FROM campaign_nodes n
    JOIN paper_campaigns c ON c.campaign_id=n.campaign_id
    WHERE n.status='completed'
      AND json_extract(n.result_json,'$.experimentIrExecutionAuthorityReceipt')
        IS NOT NULL
    ORDER BY n.updated_at DESC,n.node_id ASC LIMIT 128;`);
  if (!query?.ok) {
    return Object.freeze({
      status: 'experiment_ir_execution_authority_unavailable',
      ready: false,
      statusReadOnly: true,
      campaignId: null,
      paperId: null,
      nodeId: null,
      receipt: null,
      experimentReplayReceipt: null,
      originalHarnessExecutionReceipt: null,
      experimentHarnessExecutionReceipt: null,
      blockers: Object.freeze(['experiment_ir_execution_authority_query_failed']),
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
  });
  const candidate = query.rows
    .map((row) => verifiedCandidate(row, expected))
    .find(Boolean) || null;
  return Object.freeze({
    status: candidate
      ? 'experiment_ir_execution_authority_verified'
      : 'experiment_ir_execution_authority_not_persisted',
    ready: Boolean(candidate),
    statusReadOnly: true,
    campaignId: candidate?.campaignId || null,
    paperId: candidate?.paperId || null,
    nodeId: candidate?.nodeId || null,
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
    blockers: Object.freeze(candidate
      ? [] : ['experiment_ir_execution_authority_not_persisted']),
  });
}
