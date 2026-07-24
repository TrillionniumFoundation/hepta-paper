import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAutonomousResearchAgendaProductionReceipt,
} from './autonomous-research-agenda-production-contract.mjs';
import {
  verifyExperimentReplayReceipt,
  verifyExperimentRunReceipt,
  verifySystemBenchmarkHarnessExecutionReceipt,
} from './experiment-run-contract.mjs';
import { verifyResearchAgendaIr } from './research-agenda-ir.mjs';
import { verifyVersionedExperimentIr } from './versioned-experiment-ir.mjs';
import {
  experimentResearchBindingMatchesContext,
  productionExperimentResearchBindingsMatch,
} from './experiment-research-binding-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const REPRODUCTION_NODE = /^(?:empirical-reproduce|revalidate-empirical-reproduce)(?:-|$)/;
const RECEIPT_KEYS = Object.freeze([
  'analysisProtocolHash', 'assuranceScope', 'authorityScope',
  'campaignBenchmarkSelectorHash', 'campaignPlanBenchmarkSelectorHash',
  'campaignId', 'campaignPlanHash', 'evidenceClass',
  'experimentDesignHash', 'experimentIrExecutionAuthorityReceiptHash',
  'experimentPlanHash', 'experimentReplayReceiptHash', 'externalActionPerformed',
  'kind', 'nodeId', 'nodeKind', 'originalEmpiricalPreDataAccessFreezeHash',
  'originalExperimentExecutionBindingHash', 'originalExperimentRunReceiptHash',
  'originalSystemBenchmarkHarnessExecutionReceiptHash',
  'originalVersionedExperimentIrHash', 'paperId', 'pluginPackageHash',
  'pluginRegistryHash', 'pluginStartupInspectionHash', 'profileId',
  'promotionScope', 'protocolFamily', 'replayEmpiricalPreDataAccessFreezeHash',
  'replayExperimentExecutionBindingHash', 'replayExperimentRunReceiptHash',
  'replaySystemBenchmarkHarnessExecutionReceiptHash',
  'replayVersionedExperimentIrHash', 'researchAgendaIrHash',
  'researchAgendaClaimBindingReceiptHash', 'proposalHash',
  'empiricalClaimRecordHash', 'dataRequirementsHash', 'estimandHash',
  'falsifiersHash', 'datasetResearchCompatibilityHash',
  'experimentResearchBindingHash', 'resourceFeasibilityHash',
  'sourceAgendaProductionReceiptHash', 'sourceProfileHash', 'status', 'version',
]);

function sha(value) {
  return SHA256.test(String(value || ''));
}

function campaignPlanSelectorHash(runReceipt) {
  return runReceipt?.benchmarkSelector?.benchmarkSelectorTemplateHash
    || runReceipt?.campaignBenchmarkSelectorHash || null;
}

function executionEvidence(experimentReplayReceipt) {
  if (!verifyExperimentReplayReceipt(experimentReplayReceipt)) return null;
  const originalRun = experimentReplayReceipt.originalRunReceipt;
  const replayRun = experimentReplayReceipt.replayRunReceipt;
  const originalHarness = originalRun?.harnessExecutionReceipt;
  const replayHarness = replayRun?.harnessExecutionReceipt;
  const originalIr = originalHarness?.experimentIr;
  const replayIr = replayHarness?.experimentIr;
  if (!verifyExperimentRunReceipt(originalRun)
    || !verifyExperimentRunReceipt(replayRun)
    || !verifySystemBenchmarkHarnessExecutionReceipt(originalHarness)
    || !verifySystemBenchmarkHarnessExecutionReceipt(replayHarness)
    || !verifyVersionedExperimentIr(originalIr)
    || !verifyVersionedExperimentIr(replayIr)
    || originalIr.version !== 3 || replayIr.version !== 3
    || originalRun.academicPromotionEligible !== true
    || replayRun.academicPromotionEligible !== true
    || originalRun.assuranceScope !== 'operator-authorized-hidden-evaluation-v1'
    || replayRun.assuranceScope !== 'operator-authorized-hidden-evaluation-v1'
    || originalRun.evidenceClass !== 'academic-experiment-evidence'
    || replayRun.evidenceClass !== 'academic-experiment-evidence'
    || originalRun.promotionScope !== 'academic-research-promotion'
    || replayRun.promotionScope !== 'academic-research-promotion'
    || originalIr.experimentPlanHash !== replayIr.experimentPlanHash
    || originalIr.profileId !== replayIr.profileId
    || originalIr.benchmarkFamily !== replayIr.benchmarkFamily
    || originalIr.sourceProfileHash !== replayIr.sourceProfileHash
    || originalIr.sourceAuthority?.registryHash !== replayIr.sourceAuthority?.registryHash
    || originalIr.sourceAuthority?.packageHash !== replayIr.sourceAuthority?.packageHash
    || originalIr.sourceAuthority?.startupInspectionHash
      !== replayIr.sourceAuthority?.startupInspectionHash
    || originalIr.design?.campaignBenchmarkSelectorHash
      !== replayIr.design?.campaignBenchmarkSelectorHash
    || originalIr.design?.experimentDesignHash !== replayIr.design?.experimentDesignHash
    || originalIr.analysisProtocol?.analysisProtocolHash
      !== replayIr.analysisProtocol?.analysisProtocolHash
    || !productionExperimentResearchBindingsMatch(
      originalIr.researchBinding,
      replayIr.researchBinding,
    )
    || campaignPlanSelectorHash(originalRun)
      !== campaignPlanSelectorHash(replayRun)
    || !sha(campaignPlanSelectorHash(originalRun))) return null;
  return Object.freeze({
    originalRun,
    replayRun,
    originalHarness,
    replayHarness,
    originalIr,
    replayIr,
  });
}

function canonicalContext({
  campaignId,
  paperId,
  campaignPlanHash,
  nodeId,
  nodeKind,
  researchAgendaIr,
  researchAgendaProducerReceipt,
  proposal,
  researchAgendaClaimBindingReceipt,
  experimentReplayReceipt,
} = {}) {
  const evidence = executionEvidence(experimentReplayReceipt);
  const selectedCampaignId = String(campaignId || '');
  const selectedPaperId = String(paperId || '');
  const selectedNodeId = String(nodeId || '');
  const selectedNodeKind = String(nodeKind || '');
  if (!selectedCampaignId || !selectedPaperId || !selectedNodeId
    || !REPRODUCTION_NODE.test(selectedNodeKind)
    || !sha(campaignPlanHash)
    || !verifyAutonomousResearchAgendaProductionReceipt(
      researchAgendaProducerReceipt,
    ).valid
    || !verifyResearchAgendaIr(researchAgendaIr, {
      agendaProductionReceipt: researchAgendaProducerReceipt,
    })
    || researchAgendaIr.paperId !== selectedPaperId
    || !evidence
    || evidence.originalIr.benchmarkFamily !== researchAgendaIr.protocolFamily
    || !experimentResearchBindingMatchesContext(
      evidence.originalIr.researchBinding,
      { researchAgendaIr, proposal, researchAgendaClaimBindingReceipt },
    )
    || !experimentResearchBindingMatchesContext(
      evidence.replayIr.researchBinding,
      { researchAgendaIr, proposal, researchAgendaClaimBindingReceipt },
    )
    || !String(evidence.originalRun.experimentAttemptId || '')
      .startsWith(`${selectedCampaignId}:`)
    || !String(evidence.replayRun.experimentAttemptId || '')
      .startsWith(`${selectedCampaignId}:${selectedNodeId}:`)) return null;
  return Object.freeze({
    campaignId: selectedCampaignId,
    paperId: selectedPaperId,
    campaignPlanHash: String(campaignPlanHash).toLowerCase(),
    nodeId: selectedNodeId,
    nodeKind: selectedNodeKind,
    researchAgendaIr,
    researchAgendaProducerReceipt,
    proposal,
    researchAgendaClaimBindingReceipt,
    experimentReplayReceipt,
    evidence,
  });
}

function payloadFromContext(context) {
  const {
    campaignId,
    paperId,
    campaignPlanHash,
    nodeId,
    nodeKind,
    researchAgendaIr,
    researchAgendaProducerReceipt,
    proposal,
    researchAgendaClaimBindingReceipt,
    experimentReplayReceipt,
    evidence: {
      originalRun, replayRun, originalHarness, replayHarness, originalIr, replayIr,
    },
  } = context;
  return Object.freeze({
    version: 2,
    kind: 'ExperimentIrExecutionAuthorityReceipt',
    status: 'experiment_ir_execution_authority_verified',
    authorityScope: 'agenda-claim-data-budget-plan-freeze-worker-harness-independent-replay-v2',
    campaignId,
    paperId,
    campaignPlanHash,
    nodeId,
    nodeKind,
    researchAgendaIrHash: researchAgendaIr.researchAgendaIrHash,
    researchAgendaClaimBindingReceiptHash:
      researchAgendaClaimBindingReceipt.researchAgendaClaimBindingReceiptHash,
    proposalHash: proposal.machineProposedScientificClaimSetHash,
    sourceAgendaProductionReceiptHash:
      researchAgendaProducerReceipt.autonomousResearchAgendaProductionReceiptHash,
    protocolFamily: researchAgendaIr.protocolFamily,
    profileId: originalIr.profileId,
    sourceProfileHash: originalIr.sourceProfileHash,
    pluginRegistryHash: originalIr.sourceAuthority.registryHash,
    pluginPackageHash: originalIr.sourceAuthority.packageHash,
    pluginStartupInspectionHash: originalIr.sourceAuthority.startupInspectionHash,
    experimentPlanHash: originalIr.experimentPlanHash,
    campaignBenchmarkSelectorHash: originalIr.design.campaignBenchmarkSelectorHash,
    campaignPlanBenchmarkSelectorHash: campaignPlanSelectorHash(originalRun),
    experimentDesignHash: originalIr.design.experimentDesignHash,
    analysisProtocolHash: originalIr.analysisProtocol.analysisProtocolHash,
    empiricalClaimRecordHash: originalIr.researchBinding.empiricalClaimRecordHash,
    dataRequirementsHash: originalIr.researchBinding.dataRequirementsHash,
    estimandHash: originalIr.researchBinding.estimandHash,
    falsifiersHash: originalIr.researchBinding.falsifiersHash,
    datasetResearchCompatibilityHash:
      originalIr.researchBinding.datasetResearchCompatibilityHash,
    experimentResearchBindingHash:
      originalIr.researchBinding.experimentResearchBindingHash,
    resourceFeasibilityHash:
      originalIr.researchBinding.resourceFeasibilityHash,
    originalVersionedExperimentIrHash: originalIr.versionedExperimentIrHash,
    replayVersionedExperimentIrHash: replayIr.versionedExperimentIrHash,
    originalExperimentExecutionBindingHash:
      originalIr.provenance.experimentExecutionBindingHash,
    replayExperimentExecutionBindingHash:
      replayIr.provenance.experimentExecutionBindingHash,
    originalEmpiricalPreDataAccessFreezeHash:
      originalHarness.empiricalPreDataAccessFreezeHash,
    replayEmpiricalPreDataAccessFreezeHash:
      replayHarness.empiricalPreDataAccessFreezeHash,
    originalSystemBenchmarkHarnessExecutionReceiptHash:
      originalHarness.systemBenchmarkHarnessExecutionReceiptHash,
    replaySystemBenchmarkHarnessExecutionReceiptHash:
      replayHarness.systemBenchmarkHarnessExecutionReceiptHash,
    originalExperimentRunReceiptHash: originalRun.experimentRunReceiptHash,
    replayExperimentRunReceiptHash: replayRun.experimentRunReceiptHash,
    experimentReplayReceiptHash: experimentReplayReceipt.experimentReplayReceiptHash,
    assuranceScope: originalRun.assuranceScope,
    evidenceClass: originalRun.evidenceClass,
    promotionScope: originalRun.promotionScope,
    externalActionPerformed: false,
  });
}

export function buildExperimentIrExecutionAuthorityReceipt(input = {}) {
  const context = canonicalContext(input);
  if (!context) throw new Error('experiment_ir_execution_authority_context_invalid');
  const payload = payloadFromContext(context);
  return Object.freeze({
    ...payload,
    experimentIrExecutionAuthorityReceiptHash: hashRecord(
      'ExperimentIrExecutionAuthorityReceipt', payload,
    ),
  });
}

export function verifyExperimentIrExecutionAuthorityReceipt(receipt, input = {}) {
  if (!hasExactObjectKeys(receipt, RECEIPT_KEYS)
    || receipt?.version !== 2
    || receipt?.kind !== 'ExperimentIrExecutionAuthorityReceipt'
    || receipt?.status !== 'experiment_ir_execution_authority_verified'
    || receipt?.authorityScope
      !== 'agenda-claim-data-budget-plan-freeze-worker-harness-independent-replay-v2'
    || receipt?.externalActionPerformed !== false) return false;
  try {
    return JSON.stringify(buildExperimentIrExecutionAuthorityReceipt(input))
      === JSON.stringify(receipt);
  } catch { return false; }
}
