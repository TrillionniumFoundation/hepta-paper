import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAutonomousResearchAgendaProductionReceipt,
  buildAutonomousResearchAgendaProductionRequest,
} from '../../paper-domain/automation/autonomous-research-agenda-production-contract.mjs';
import {
  buildDeterministicAutonomousHypothesisDraft,
  createAutonomousHypothesisGenerationReceipt,
  createMachineProposedScientificClaimSet,
  selectMachineGeneratedAutonomousResearchAgenda,
} from '../../paper-domain/automation/autonomous-research-proposal-contract.mjs';
import { buildCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import {
  buildCanonicalAnalysisProtocol,
} from '../../paper-domain/automation/analysis-protocol-contract.mjs';
import {
  experimentResearchBindingMatchesContext,
  productionExperimentResearchBindingsMatch,
} from '../../paper-domain/automation/experiment-research-binding-contract.mjs';
import { buildDatasetAuthorizationSet } from '../../paper-domain/automation/experiment-run-contract.mjs';
import {
  buildEmpiricalPreDataAccessFreeze,
  verifyEmpiricalPreDataAccessFreeze,
} from '../../paper-domain/automation/empirical-pre-data-access-freeze.mjs';
import { compareExperimentReplayRuns } from '../../paper-domain/automation/experiment-replay-comparison.mjs';
import {
  validateOperatorDatasetAuthorityDocument,
  validateOperatorDatasetResearchSemantics,
} from '../../paper-domain/automation/operator-dataset-harness-contract.mjs';
import {
  buildResearchAgendaClaimBindingReceipt,
} from '../../paper-domain/automation/research-agenda-claim-binding-contract.mjs';
import { buildResearchAgendaIr } from '../../paper-domain/automation/research-agenda-ir.mjs';
import {
  autonomousEmpiricalFamilyPluginProfileFor,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';
import {
  buildResolvedVersionedExperimentIr,
  verifyVersionedExperimentIr,
} from '../../paper-domain/automation/versioned-experiment-ir.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const FAMILY = 'ml_algorithm_benchmark';
const H = (label) => hashRecord('VersionedExperimentIrV3Test', { label });

function researchContext({
  paperId = 'experiment-ir-v3-paper',
  population = 'Rows admitted by the signed dataset contract.',
  estimand = 'Paired mean primary-metric difference.',
  requiredVariables = ['outcome', 'treatment_assignment'],
} = {}) {
  const objective = 'Evaluate a bounded registered treatment against the signed baseline.';
  const request = buildAutonomousResearchAgendaProductionRequest({
    paperId,
    allowedProtocolFamilies: [FAMILY],
  });
  const agentPayload = {
    version: 1,
    kind: 'AgentExecutionReceipt',
    status: 'agent_execution_completed',
    agentId: 'experiment-ir-v3-agenda-producer',
    providerMode: 'fixture-provider',
    resolvedModel: 'fixture-model',
    promptHash: H(`prompt:${paperId}`),
  };
  const researchAgendaProducerReceipt = buildAutonomousResearchAgendaProductionReceipt({
    request,
    selectedObjective: objective,
    selectedProtocolFamily: FAMILY,
    agentExecutionReceipt: {
      ...agentPayload,
      agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', agentPayload),
    },
    producerId: agentPayload.agentId,
    generatedAt: '2026-07-23T00:00:00.000Z',
  });
  const agendaSelectionReceipt = selectMachineGeneratedAutonomousResearchAgenda({
    paperId,
    researchAgendaProducerReceipt,
  });
  const draft = buildDeterministicAutonomousHypothesisDraft({ objective, protocolFamily: FAMILY });
  const generationReceipt = createAutonomousHypothesisGenerationReceipt({
    draft,
    principalId: 'experiment-ir-v3-hypothesis-producer',
    generatedAt: '2026-07-23T00:00:00.000Z',
  });
  const proposal = createMachineProposedScientificClaimSet({
    paperId,
    objective,
    protocolFamily: FAMILY,
    draft,
    generationReceipt,
    agendaSelectionReceipt,
    createdAt: '2026-07-23T00:00:00.000Z',
  });
  const researchAgendaIr = buildResearchAgendaIr({
    agendaProductionReceipt: researchAgendaProducerReceipt,
    researchQuestion: 'Does the registered treatment improve the signed primary metric?',
    primaryClaim: draft.empiricalHypothesis.statement,
    dataRequirements: {
      population,
      intervention: 'Registered treatment implementation.',
      comparator: 'Registered baseline implementation.',
      estimand,
      requiredVariables,
      datasetConstraints: ['read-only signed dataset mount', 'no post-freeze filtering'],
    },
    falsifiers: ['Non-positive paired primary-metric difference.'],
    negativeBoundaries: ['No claim outside the signed dataset population.'],
    formalTargets: [draft.formalSupportClaim.statement],
    priorArtQueryPlan: ['Search the registered intervention and estimand together.'],
    venueConstraints: {
      paperType: 'research_article',
      requiredSections: ['methods', 'results', 'limitations'],
      artifactRequired: true,
      anonymousReviewRequired: true,
    },
    resourceFeasibility: {
      maximumWallTimeMs: 3_600_000,
      maximumMemoryBytes: 4_294_967_296,
      maximumCpuCount: 4,
      executionEnvironment: 'signed-docker-runtime-v1',
    },
  });
  const researchAgendaClaimBindingReceipt = buildResearchAgendaClaimBindingReceipt({
    researchAgendaIr,
    proposal,
  });
  return Object.freeze({
    researchAgendaIr,
    proposal,
    researchAgendaClaimBindingReceipt,
    researchAgendaProducerReceipt,
  });
}

function datasetFixture() {
  const familySelector = buildCampaignBenchmarkSelector({ benchmarkId: FAMILY });
  const analysisProtocol = buildCanonicalAnalysisProtocol({
    benchmarkId: 'experiment-ir-v3-dataset',
    benchmarkFamily: FAMILY,
    requiredMetrics: familySelector.experimentDesign.requiredMetrics,
    metricSpecs: familySelector.experimentDesign.metricSpecs,
  });
  const semantics = validateOperatorDatasetResearchSemantics({
    version: 1,
    kind: 'OperatorDatasetResearchSemantics',
    population: 'Rows admitted by the signed dataset contract.',
    variables: ['outcome', 'treatment_assignment', 'covariate'],
    intervention: 'Registered treatment implementation.',
    comparator: 'Registered baseline implementation.',
    estimands: ['Paired mean primary-metric difference.'],
    datasetConstraints: ['read-only signed dataset mount', 'no post-freeze filtering'],
    eligibleSplits: ['train', 'validation'],
  });
  const authority = validateOperatorDatasetAuthorityDocument({
    version: 3,
    kind: 'OperatorDatasetHarnessAuthority',
    datasetName: 'experiment-ir-v3-dataset',
    datasetManifestHash: H('dataset-manifest'),
    datasetLicenseId: 'CC-BY-4.0',
    datasetSplitManifestHash: H('split-manifest'),
    benchmarkHarnessDefinitionHash: H('harness-definition'),
    analysisProtocolHash: analysisProtocol.analysisProtocolHash,
    researchSemantics: semantics.researchSemantics,
    benchmarkFamily: FAMILY,
    seedSchedule: familySelector.experimentDesign.seedSchedule,
    minimumRepetitions: familySelector.experimentDesign.minimumRepetitions,
    workerExposurePolicy: 'signed-complete-dataset-file-manifest-v1',
    signedAt: '2026-07-23T00:00:00.000Z',
    expiresAt: '2026-07-24T00:00:00.000Z',
    signatures: [{
      keyId: 'fixture-key',
      role: 'dataset_harness_operator',
      algorithm: 'ed25519',
      value: 'fixture-signature',
    }],
  });
  const mount = Object.freeze({
    name: authority.authority.datasetName,
    source: '/fixture/dataset',
    readOnly: true,
    manifestHash: authority.authority.datasetManifestHash,
    licenseId: authority.authority.datasetLicenseId,
    operatorAuthorizationHash: authority.operatorDatasetAuthorityDocumentHash,
    operatorDatasetAuthorityDocumentHash: authority.operatorDatasetAuthorityDocumentHash,
    operatorDatasetAuthority: authority.authority,
    operatorDatasetResearchSemantics: semantics.researchSemantics,
    operatorDatasetResearchSemanticsHash: semantics.operatorDatasetResearchSemanticsHash,
    splitManifestHash: authority.authority.datasetSplitManifestHash,
    benchmarkHarnessDocumentHash: H('harness-envelope'),
    benchmarkHarnessDefinitionHash: authority.authority.benchmarkHarnessDefinitionHash,
    analysisProtocol: Object.freeze(Object.fromEntries(Object.entries(analysisProtocol)
      .filter(([key]) => key !== 'analysisProtocolHash'))),
    analysisProtocolHash: analysisProtocol.analysisProtocolHash,
    benchmarkFamily: FAMILY,
    benchmarkSeedSchedule: familySelector.experimentDesign.seedSchedule,
    benchmarkMinimumRepetitions: familySelector.experimentDesign.minimumRepetitions,
  });
  return Object.freeze({
    mount,
    selector: buildCampaignBenchmarkSelector({
      benchmarkId: mount.name,
      datasetMounts: [mount],
    }),
    datasetAuthorizationSet: buildDatasetAuthorizationSet([mount]),
  });
}

function adapterSet(selector) {
  const protocols = selector.experimentDesign.benchmarkHarness.armProtocolSet.protocols;
  const payload = {
    version: 1,
    kind: 'SystemBenchmarkArmAdapterSet',
    adapters: protocols.map((protocol) => Object.freeze({
      kind: 'SystemBenchmarkArmAdapterIdentity',
      arm: protocol.arm,
      relativePath: `adapter.${protocol.arm}.py`,
      sourceHash: H(`adapter:${protocol.arm}`),
      systemBenchmarkArmProtocolHash: protocol.systemBenchmarkArmProtocolHash,
    })),
  };
  return Object.freeze({
    ...payload,
    systemBenchmarkArmAdapterSetHash: hashRecord('SystemBenchmarkArmAdapterSet', payload),
  });
}

function resolvedIr(context, {
  attemptId = 'campaign:node:attempt-1',
  maximumWallTimeMs = 1_200_000,
  memoryBytes = 1_073_741_824,
  cpuCount = 1,
  aggregateCpuSeconds = 1_200,
} = {}) {
  const dataset = datasetFixture();
  return buildResolvedVersionedExperimentIr(
    autonomousEmpiricalFamilyPluginProfileFor(FAMILY),
    {
      selector: dataset.selector,
      armAdapterSet: adapterSet(dataset.selector),
      datasetAuthorizationSet: dataset.datasetAuthorizationSet,
      experimentAttemptId: attemptId,
      sourceLineageHash: H('source-lineage'),
      sourceMerkleHash: H('source-merkle'),
      sourceWorkspaceManifestHash: H('source-manifest'),
      absoluteDeadlineEpochMs: 1_800_000_000_000,
      maximumWallTimeMs,
      aggregateCpuSeconds,
      memoryBytes,
      maximumProcesses: 64,
      cpuCount,
      executionEnvironment: 'signed-docker-runtime-v1',
      researchContext: context,
    },
  );
}

test('resolved ExperimentIR v3 binds agenda, empirical claim, data semantics, split, and budget', () => {
  const context = researchContext();
  const ir = resolvedIr(context);
  assert.equal(ir.version, 3);
  assert.equal(ir.irVersion, 'experiment-ir-v3');
  assert.equal(verifyVersionedExperimentIr(ir), true);
  assert.equal(ir.researchBinding.productionGenericEligible, true);
  assert.equal(ir.researchBinding.empiricalClaimRecordHash,
    context.researchAgendaClaimBindingReceipt.empiricalClaimRecordHash);
  assert.equal(ir.researchBinding.datasetCompatibility.compatible, true);
  assert.equal(ir.researchBinding.executionBudget.maximumWallTimeMs, 1_200_000);
});

test('same-family agenda with a wrong required variable is rejected', () => {
  assert.throws(() => resolvedIr(researchContext({
    requiredVariables: ['outcome', 'unavailable_assignment'],
  })), /experiment_research_dataset_required_variable_missing/);
});

test('same-family agenda with a wrong population is rejected', () => {
  assert.throws(() => resolvedIr(researchContext({
    population: 'A different same-family population.',
  })), /experiment_research_dataset_population_mismatch/);
});

test('same-family agenda with a wrong estimand is rejected', () => {
  assert.throws(() => resolvedIr(researchContext({
    estimand: 'An unrelated same-family estimand.',
  })), /experiment_research_dataset_estimand_mismatch/);
});

test('execution budget exceeding agenda resource feasibility is rejected', () => {
  assert.throws(() => resolvedIr(researchContext(), {
    memoryBytes: 4_294_967_297,
  }), /experiment_research_resource_feasibility_exceeded/);
  assert.throws(() => resolvedIr(researchContext(), {
    maximumWallTimeMs: 3_600_001,
    aggregateCpuSeconds: 1,
  }), /experiment_research_resource_feasibility_exceeded/);
});

test('cross-agenda original/replay binding is rejected even within the same family', () => {
  const first = researchContext({ paperId: 'experiment-ir-v3-paper-a' });
  const second = researchContext({ paperId: 'experiment-ir-v3-paper-b' });
  const original = resolvedIr(first, { attemptId: 'campaign:primary:attempt-1' });
  const replay = resolvedIr(second, { attemptId: 'campaign:replay:attempt-1' });
  assert.equal(productionExperimentResearchBindingsMatch(
    original.researchBinding,
    replay.researchBinding,
  ), false);
  assert.equal(experimentResearchBindingMatchesContext(
    original.researchBinding,
    second,
  ), false);
  assert.notEqual(original.experimentPlanHash, replay.experimentPlanHash);
  const comparison = compareExperimentReplayRuns({
    originalRunReceipt: {
      experimentAttemptId: 'campaign:primary:attempt-1',
      executionReceiptHash: H('original-execution'),
      harnessExecutionReceipt: {
        environmentBindingHash: H('original-environment'),
        experimentIr: original,
      },
      observations: [],
      requiredMetrics: [],
    },
    replayRunReceipt: {
      experimentAttemptId: 'campaign:replay:attempt-1',
      executionReceiptHash: H('replay-execution'),
      harnessExecutionReceipt: {
        environmentBindingHash: H('replay-environment'),
        experimentIr: replay,
      },
      observations: [],
      requiredMetrics: [],
    },
    absoluteTolerance: 0,
    relativeTolerance: 0,
  });
  assert.ok(comparison.identityBlockers.includes(
    'experiment_replay_identity_mismatch:experimentResearchBinding',
  ));
});

test('v3 pre-data freeze exposes and verifies the agenda/data binding hashes', () => {
  const ir = resolvedIr(researchContext());
  const freeze = buildEmpiricalPreDataAccessFreeze({
    experimentAttemptId: ir.experimentId,
    versionedExperimentIrHash: ir.versionedExperimentIrHash,
    experimentResearchBindingHash:
      ir.researchBinding.experimentResearchBindingHash,
    datasetResearchCompatibilityHash:
      ir.researchBinding.datasetResearchCompatibilityHash,
    campaignBenchmarkSelectorHash: ir.design.campaignBenchmarkSelectorHash,
    experimentDesignHash: ir.design.experimentDesignHash,
    analysisProtocolHash: ir.analysisProtocol.analysisProtocolHash,
    systemBenchmarkArmProtocolSetHash: ir.design.systemBenchmarkArmProtocolSetHash,
    systemBenchmarkArmAdapterSetHash: ir.execution.systemBenchmarkArmAdapterSetHash,
    sourceMerkleHash: ir.provenance.sourceMerkleHash,
    sourceWorkspaceManifestHash: ir.provenance.sourceWorkspaceManifestHash,
    sourceLineageHash: ir.provenance.sourceLineageHash,
  });
  assert.equal(freeze.version, 3);
  assert.equal(verifyEmpiricalPreDataAccessFreeze(freeze), true);
  assert.equal(verifyEmpiricalPreDataAccessFreeze({
    ...freeze,
    experimentResearchBindingHash: H('cross-agenda-binding'),
  }), false);
});

test('resolved v2 remains verifiable compatibility evidence but has no generic research authority', () => {
  const dataset = datasetFixture();
  const ir = buildResolvedVersionedExperimentIr(
    autonomousEmpiricalFamilyPluginProfileFor(FAMILY),
    {
      selector: dataset.selector,
      armAdapterSet: adapterSet(dataset.selector),
      datasetAuthorizationSet: dataset.datasetAuthorizationSet,
      experimentAttemptId: 'compat:attempt-1',
      sourceLineageHash: H('compat-lineage'),
      sourceMerkleHash: H('compat-merkle'),
      sourceWorkspaceManifestHash: H('compat-manifest'),
      absoluteDeadlineEpochMs: 1_800_000_000_000,
      aggregateCpuSeconds: 1200,
      memoryBytes: 1_073_741_824,
      maximumProcesses: 64,
    },
  );
  assert.equal(ir.version, 2);
  assert.equal(verifyVersionedExperimentIr(ir), true);
  assert.equal(Object.hasOwn(ir, 'researchBinding'), false);
});
