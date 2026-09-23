import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY,
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION,
  autonomousEmpiricalFamilyPluginProfileFor,
} from './autonomous-empirical-family-plugin-registry.mjs';
import { TYPED_NUMERIC_ORACLE_TYPES } from '../research/typed-numeric-oracle-certificate.mjs';
import { verifyAnalysisProtocol } from './analysis-protocol-contract.mjs';
import {
  buildExperimentResearchBinding,
  verifyExperimentResearchBinding,
} from './experiment-research-binding-contract.mjs';
import {
  SYSTEM_BENCHMARK_CPU_BUDGET_SEMANTICS,
} from './system-benchmark-resource-budget-contract.mjs';
import { buildSystemBenchmarkArmProtocolSet, verifySystemBenchmarkArmAdapterSet } from './system-benchmark-arm-protocol.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ARMS = Object.freeze(['treatment', 'baseline', 'ablation']);
const IR_V2_KEYS = Object.freeze([
  'analysisProtocol', 'benchmarkFamily', 'dataset', 'design', 'estimator',
  'execution', 'experimentId', 'experimentPlanHash', 'irVersion', 'kind',
  'metrics', 'oracleAbi', 'profileId', 'provenance',
  'runtimeRegistryMutationAllowed', 'sourceAuthority', 'sourceProfileHash',
  'stopping', 'version', 'versionedExperimentIrHash',
]);
const IR_V3_KEYS = Object.freeze([...IR_V2_KEYS, 'researchBinding']);
const RESOLVED_BUDGET_KEYS = Object.freeze([
  'absoluteDeadlineEpochMs', 'aggregateCpuSeconds', 'cpuBudgetSemantics',
  'gpuRequired', 'workerMaximumProcesses', 'workerMemoryBytes',
]);
const RESEARCH_RESOLVED_BUDGET_KEYS = Object.freeze([
  ...RESOLVED_BUDGET_KEYS, 'cpuCount', 'executionEnvironment', 'maximumWallTimeMs',
]);
const keys = (value) => Object.freeze(value.split(' '));
const DESIGN_KEYS = keys('arms assignmentUnit benchmarkHarnessHash campaignBenchmarkSelectorHash comparisonMode designVersion experimentDesignHash pairedCellCount repetitionsPerSeed scheduleCellCount seedSchedule systemBenchmarkArmProtocolSetHash');
const DATASET_KEYS = keys('benchmarkFamily datasetAuthorizationSetHash datasetContractVersion datasetManifestHash datasetMountName datasetOperatorAuthorizationHash datasetSplitIdentityHash datasetSplitManifestHash evaluatorDescriptorHash fixtureEvaluatorId operatorDatasetAuthorityDocumentHash operatorDatasetHarnessDefinitionHash responseField runtimeNetworkAccessAllowed selectorType');
const EXECUTION_KEYS = keys('adapterId armAdapterSet budget executionBinding language requiresGpu systemBenchmarkArmAdapterSetHash');
const EXECUTION_BINDING_KEYS = keys('attemptVersion budget datasetAuthorizationSetHash experimentAttemptId experimentExecutionBindingHash failedAttemptLineageHashes sourceLineageHash sourceMerkleHash sourceWorkspaceManifestHash systemBenchmarkArmAdapterSetHash');
const ADAPTER_SET_KEYS = keys('adapters entrypointConvention kind systemBenchmarkArmAdapterSetHash version');
const ADAPTER_KEYS = keys('arm kind relativePath sourceHash sourceReadReceiptHash systemBenchmarkArmProtocolHash version');
const ESTIMATOR_KEYS = keys('analysisProtocolHash estimatorAbiVersion inferenceMode primaryMetric secondaryMetric');
const STOPPING_KEYS = keys('earlyStoppingAllowed mode plannedPairedCellCount plannedScheduleCellCount stoppingRuleVersion');
const ORACLE_ABI_KEYS = keys('candidateAuthoredValuesAccepted independentRecomputationRequired oracleAbiVersion requiredOracleTypes');
const SOURCE_AUTHORITY_KEYS = keys('canonicalProductionAuthority packageHash productionAuthorized profileRegistered registryHash signatureVerified startupInspectionHash');
const PROFILE_PAYLOAD_KEYS = Object.freeze([
  'benchmarkFamily', 'evaluatorDescriptorHash', 'executionAdapterId', 'executionProfile',
  'fixtureEvaluatorId', 'inferenceMode', 'kind', 'metricSpecs', 'minimumRepetitions',
  'primaryMetric', 'productionExecutable', 'profileId', 'requiredMetrics', 'responseField',
  'runtimeRegistryMutationAllowed', 'secondaryMetric', 'seedSchedule', 'typedOracleKinds',
  'version',
]);

function profileHashValid(profile) {
  if (!profile || !hasExactObjectKeys(profile, [
    ...PROFILE_PAYLOAD_KEYS, 'autonomousEmpiricalFamilyPluginProfileHash',
  ])) return false;
  const { autonomousEmpiricalFamilyPluginProfileHash, ...payload } = profile;
  return SHA256.test(String(autonomousEmpiricalFamilyPluginProfileHash || ''))
    && hashRecord('AutonomousEmpiricalFamilyPluginProfile', payload)
      === autonomousEmpiricalFamilyPluginProfileHash;
}

function sourceAuthority(profile, { registry, startupInspection } = {}) {
  const registered = registry?.profiles?.find((candidate) => (
    candidate.benchmarkFamily === profile.benchmarkFamily
      && candidate.autonomousEmpiricalFamilyPluginProfileHash
        === profile.autonomousEmpiricalFamilyPluginProfileHash
  ));
  const canonicalProductionAuthority = registry === AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY
    && startupInspection === AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION;
  const signatureVerified = canonicalProductionAuthority
    && startupInspection?.signatureVerified === true
    && startupInspection?.registryHash
      === registry?.autonomousEmpiricalFamilyPluginRegistryHash;
  return Object.freeze({
    registryHash: registry?.autonomousEmpiricalFamilyPluginRegistryHash || null,
    packageHash: startupInspection?.packageHash || null,
    startupInspectionHash:
      startupInspection?.autonomousEmpiricalFamilyPluginStartupInspectionHash || null,
    profileRegistered: Boolean(registered),
    canonicalProductionAuthority,
    signatureVerified,
    productionAuthorized: Boolean(
      registered && signatureVerified && profile.productionExecutable === true,
    ),
  });
}

function metricDefinitions(profile) {
  return Object.freeze(profile.requiredMetrics.map((metricId) => Object.freeze({
    metricId,
    role: metricId === profile.primaryMetric
      ? 'primary' : metricId === profile.secondaryMetric ? 'secondary' : 'diagnostic',
    ...profile.metricSpecs[metricId],
  })));
}

function sha(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function resolvedBudgetKeys(budget, researchResolved) {
  return researchResolved ? RESEARCH_RESOLVED_BUDGET_KEYS : Object.freeze([
    ...RESOLVED_BUDGET_KEYS,
    ...['cpuCount', 'executionEnvironment', 'maximumWallTimeMs']
      .filter((key) => Object.hasOwn(budget || {}, key)),
  ]);
}

function resolvedBudgetValid(budget, researchResolved) {
  return hasExactObjectKeys(budget, resolvedBudgetKeys(budget, researchResolved))
    && Number.isSafeInteger(budget.absoluteDeadlineEpochMs)
    && budget.absoluteDeadlineEpochMs >= 0
    && positiveInteger(budget.aggregateCpuSeconds)
    && budget.cpuBudgetSemantics === SYSTEM_BENCHMARK_CPU_BUDGET_SEMANTICS
    && typeof budget.gpuRequired === 'boolean'
    && positiveInteger(budget.workerMaximumProcesses)
    && positiveInteger(budget.workerMemoryBytes)
    && (!Object.hasOwn(budget, 'cpuCount') || positiveInteger(budget.cpuCount))
    && (!Object.hasOwn(budget, 'maximumWallTimeMs')
      || positiveInteger(budget.maximumWallTimeMs))
    && (!Object.hasOwn(budget, 'executionEnvironment')
      || (typeof budget.executionEnvironment === 'string'
        && budget.executionEnvironment.length > 0));
}

function armAdapterSetValid(adapterSet, protocolSet) {
  return hasExactObjectKeys(adapterSet, ADAPTER_SET_KEYS)
    && Array.isArray(adapterSet.adapters)
    && adapterSet.adapters.every((adapter) => hasExactObjectKeys(adapter, ADAPTER_KEYS))
    && verifySystemBenchmarkArmAdapterSet(adapterSet, protocolSet);
}

function resolvedProtocolSet(value) {
  const datasetBacked = value.dataset?.selectorType === 'authorized_dataset_mount';
  const benchmarkId = datasetBacked ? value.dataset?.datasetMountName : value.benchmarkFamily;
  if (value.analysisProtocol?.benchmarkId !== benchmarkId) return null;
  try {
    return buildSystemBenchmarkArmProtocolSet({
      benchmarkId,
      datasetBacked,
      benchmarkFamily: value.benchmarkFamily,
    });
  } catch { return null; }
}

function canonicalLineage(values) {
  if (!Array.isArray(values)) throw new Error('experiment_ir_failed_attempt_lineage_invalid');
  if (values.some((value) => typeof value !== 'string')) {
    throw new Error('experiment_ir_failed_attempt_lineage_invalid');
  }
  const lineage = values.map((value) => value.toLowerCase());
  if (lineage.some((value) => !sha(value)) || new Set(lineage).size !== lineage.length) {
    throw new Error('experiment_ir_failed_attempt_lineage_invalid');
  }
  return Object.freeze(lineage);
}

function resolvedDesign(profile, selector) {
  const design = selector?.experimentDesign;
  const seeds = Array.isArray(design?.seedSchedule)
    ? [...design.seedSchedule] : [];
  const repetitions = design?.minimumRepetitions;
  let expectedProtocolSet = null;
  try {
    expectedProtocolSet = buildSystemBenchmarkArmProtocolSet({
      benchmarkId: selector?.benchmarkId,
      datasetBacked: selector?.selectorType === 'authorized_dataset_mount',
      benchmarkFamily: profile.benchmarkFamily,
    });
  } catch { expectedProtocolSet = null; }
  if (!sha(selector?.campaignBenchmarkSelectorHash)
    || !sha(selector?.experimentDesignHash)
    || selector.experimentDesignHash !== design?.experimentDesignHash
    || design?.benchmarkFamily !== profile.benchmarkFamily
    || !expectedProtocolSet
    || expectedProtocolSet.systemBenchmarkArmProtocolSetHash
      !== design?.benchmarkHarness?.systemBenchmarkArmProtocolSetHash
    || JSON.stringify(expectedProtocolSet)
      !== JSON.stringify(design?.benchmarkHarness?.armProtocolSet)
    || !sha(design?.benchmarkHarnessHash)
    || !seeds.length || seeds.some((seed) => !Number.isSafeInteger(seed))
    || new Set(seeds).size !== seeds.length
    || !positiveInteger(repetitions)
    || JSON.stringify(design.requiredMetrics) !== JSON.stringify(profile.requiredMetrics)
    || hashRecord('VersionedExperimentIrMetricSpecsExpected', design.metricSpecs)
      !== hashRecord('VersionedExperimentIrMetricSpecsExpected', profile.metricSpecs)
    || !verifyAnalysisProtocol({
      ...design.analysisProtocol,
      analysisProtocolHash: design.analysisProtocolHash,
    }, {
      benchmarkId: selector.benchmarkId,
      benchmarkFamily: design.benchmarkFamily,
      requiredMetrics: design.requiredMetrics,
      metricSpecs: design.metricSpecs,
    })) {
    throw new Error('experiment_ir_resolved_design_invalid');
  }
  return Object.freeze({
    designVersion: 'resolved-three-arm-paired-seed-design-v2',
    arms: ARMS,
    assignmentUnit: 'seed-repetition-cell',
    comparisonMode: 'paired-within-seed-repetition',
    seedSchedule: Object.freeze(seeds),
    repetitionsPerSeed: repetitions,
    pairedCellCount: seeds.length * repetitions,
    scheduleCellCount: seeds.length * repetitions * ARMS.length,
    campaignBenchmarkSelectorHash: selector.campaignBenchmarkSelectorHash,
    experimentDesignHash: selector.experimentDesignHash,
    benchmarkHarnessHash: design.benchmarkHarnessHash,
    systemBenchmarkArmProtocolSetHash:
      design.benchmarkHarness?.systemBenchmarkArmProtocolSetHash || null,
  });
}

function resolvedDataset(profile, selector, datasetAuthorizationSet) {
  if (!sha(datasetAuthorizationSet?.datasetAuthorizationSetHash)
    || !Array.isArray(datasetAuthorizationSet?.datasets)) {
    throw new Error('experiment_ir_dataset_authorization_invalid');
  }
  const design = selector.experimentDesign;
  return Object.freeze({
    datasetContractVersion: 'resolved-system-benchmark-dataset-v2',
    selectorType: selector.selectorType,
    datasetMountName: selector.datasetMountName,
    benchmarkFamily: profile.benchmarkFamily,
    responseField: profile.responseField,
    fixtureEvaluatorId: profile.fixtureEvaluatorId,
    evaluatorDescriptorHash: profile.evaluatorDescriptorHash,
    datasetAuthorizationSetHash: datasetAuthorizationSet.datasetAuthorizationSetHash,
    datasetManifestHash: selector.datasetManifestHash,
    datasetSplitIdentityHash: design.datasetSplitIdentityHash,
    datasetSplitManifestHash: selector.datasetSplitManifestHash,
    datasetOperatorAuthorizationHash: selector.datasetOperatorAuthorizationHash,
    operatorDatasetAuthorityDocumentHash:
      selector.operatorDatasetAuthorityDocumentHash,
    operatorDatasetHarnessDefinitionHash:
      selector.operatorDatasetHarnessDefinitionHash,
    runtimeNetworkAccessAllowed: false,
  });
}

function resolvedExecution(profile, {
  armAdapterSet,
  armProtocolSet,
  datasetAuthorizationSet,
  experimentAttemptId,
  attemptVersion,
  failedAttemptLineageHashes,
  sourceLineageHash,
  sourceMerkleHash,
  sourceWorkspaceManifestHash,
  absoluteDeadlineEpochMs,
  aggregateCpuSeconds,
  memoryBytes,
  maximumProcesses,
  requiresGpu,
  maximumWallTimeMs = null,
  cpuCount = null,
  executionEnvironment = null,
}) {
  const version = attemptVersion;
  const attemptId = experimentAttemptId;
  const lineage = canonicalLineage(failedAttemptLineageHashes);
  if (typeof attemptId !== 'string' || !attemptId || attemptId.length > 512
    || !positiveInteger(version)
    || lineage.length !== version - 1
    || !sha(sourceLineageHash) || !sha(sourceMerkleHash)
    || !sha(sourceWorkspaceManifestHash)
    || !sha(datasetAuthorizationSet?.datasetAuthorizationSetHash)
    || !armAdapterSetValid(armAdapterSet, armProtocolSet)
    || !Number.isSafeInteger(absoluteDeadlineEpochMs) || absoluteDeadlineEpochMs < 0
    || !positiveInteger(aggregateCpuSeconds) || !positiveInteger(memoryBytes)
    || !positiveInteger(maximumProcesses)
    || typeof requiresGpu !== 'boolean'
    || requiresGpu !== profile.executionProfile.requiresGpu
    || (maximumWallTimeMs !== null && !positiveInteger(maximumWallTimeMs))
    || (cpuCount !== null && !positiveInteger(cpuCount))
    || (executionEnvironment !== null
      && (typeof executionEnvironment !== 'string' || !executionEnvironment))) {
    throw new Error('experiment_ir_execution_binding_invalid');
  }
  const budget = Object.freeze({
    absoluteDeadlineEpochMs,
    aggregateCpuSeconds,
    cpuBudgetSemantics: SYSTEM_BENCHMARK_CPU_BUDGET_SEMANTICS,
    workerMemoryBytes: memoryBytes,
    workerMaximumProcesses: maximumProcesses,
    gpuRequired: requiresGpu,
    ...(maximumWallTimeMs === null ? {} : {
      maximumWallTimeMs,
    }),
    ...(cpuCount === null ? {} : { cpuCount }),
    ...(executionEnvironment === null ? {} : {
      executionEnvironment,
    }),
  });
  const executionBindingPayload = {
    experimentAttemptId: attemptId,
    attemptVersion: version,
    failedAttemptLineageHashes: lineage,
    sourceLineageHash: sourceLineageHash.toLowerCase(),
    sourceMerkleHash: sourceMerkleHash.toLowerCase(),
    sourceWorkspaceManifestHash: sourceWorkspaceManifestHash.toLowerCase(),
    systemBenchmarkArmAdapterSetHash:
      armAdapterSet.systemBenchmarkArmAdapterSetHash,
    datasetAuthorizationSetHash:
      datasetAuthorizationSet.datasetAuthorizationSetHash,
    budget,
  };
  return Object.freeze({
    adapterId: profile.executionAdapterId,
    language: profile.executionProfile.language,
    requiresGpu: profile.executionProfile.requiresGpu,
    armAdapterSet: Object.freeze(structuredClone(armAdapterSet)),
    systemBenchmarkArmAdapterSetHash:
      armAdapterSet.systemBenchmarkArmAdapterSetHash,
    budget,
    executionBinding: Object.freeze({
      ...executionBindingPayload,
      experimentExecutionBindingHash: hashRecord(
        'VersionedExperimentExecutionBinding', executionBindingPayload,
      ),
    }),
  });
}

export function buildResolvedVersionedExperimentIr(profile, {
  selector,
  armAdapterSet,
  datasetAuthorizationSet,
  experimentAttemptId,
  attemptVersion = 1,
  failedAttemptLineageHashes = [],
  sourceLineageHash,
  sourceMerkleHash,
  sourceWorkspaceManifestHash,
  absoluteDeadlineEpochMs,
  aggregateCpuSeconds,
  memoryBytes,
  maximumProcesses,
  requiresGpu = false,
  maximumWallTimeMs = null,
  cpuCount = null,
  executionEnvironment = null,
  researchContext = null,
  registry = AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY,
  startupInspection = AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION,
} = {}) {
  if (!profileHashValid(profile)) throw new Error('experiment_ir_profile_invalid');
  const authority = sourceAuthority(profile, { registry, startupInspection });
  if (!authority.productionAuthorized) {
    throw new Error('experiment_ir_production_authority_required');
  }
  const design = resolvedDesign(profile, selector);
  const dataset = resolvedDataset(profile, selector, datasetAuthorizationSet);
  const execution = resolvedExecution(profile, {
    armAdapterSet,
    armProtocolSet: selector.experimentDesign.benchmarkHarness.armProtocolSet,
    datasetAuthorizationSet,
    experimentAttemptId,
    attemptVersion,
    failedAttemptLineageHashes,
    sourceLineageHash,
    sourceMerkleHash,
    sourceWorkspaceManifestHash,
    absoluteDeadlineEpochMs,
    aggregateCpuSeconds,
    memoryBytes,
    maximumProcesses,
    requiresGpu,
    maximumWallTimeMs,
    cpuCount,
    executionEnvironment,
  });
  const analysisProtocol = Object.freeze({
    ...selector.experimentDesign.analysisProtocol,
    analysisProtocolHash: selector.experimentDesign.analysisProtocolHash,
  });
  const researchBinding = researchContext === null ? null : buildExperimentResearchBinding({
    ...researchContext,
    selector,
    datasetAuthorizationSet,
    maximumWallTimeMs,
    memoryBytes,
    cpuCount,
    aggregateCpuSeconds,
    executionEnvironment,
    language: profile.executionProfile.language,
  });
  const boundDataset = researchBinding ? Object.freeze({
    ...dataset,
    datasetResearchCompatibilityHash:
      researchBinding.datasetResearchCompatibilityHash,
  }) : dataset;
  const planPayload = {
    sourceProfileHash: profile.autonomousEmpiricalFamilyPluginProfileHash,
    campaignBenchmarkSelectorHash: design.campaignBenchmarkSelectorHash,
    experimentDesignHash: design.experimentDesignHash,
    benchmarkHarnessHash: design.benchmarkHarnessHash,
    systemBenchmarkArmProtocolSetHash: design.systemBenchmarkArmProtocolSetHash,
    systemBenchmarkArmAdapterSetHash: execution.systemBenchmarkArmAdapterSetHash,
    datasetAuthorizationSetHash: dataset.datasetAuthorizationSetHash,
    analysisProtocolHash: analysisProtocol.analysisProtocolHash,
    seedSchedule: design.seedSchedule,
    repetitionsPerSeed: design.repetitionsPerSeed,
    ...(researchBinding ? {
      experimentResearchBindingHash: researchBinding.experimentResearchBindingHash,
      researchAgendaIrHash: researchBinding.researchAgendaIrHash,
      empiricalClaimRecordHash: researchBinding.empiricalClaimRecordHash,
      dataRequirementsHash: researchBinding.dataRequirementsHash,
      estimandHash: researchBinding.estimandHash,
      falsifiersHash: researchBinding.falsifiersHash,
      datasetResearchCompatibilityHash:
        researchBinding.datasetResearchCompatibilityHash,
    } : {}),
  };
  const experimentPlanHash = hashRecord('VersionedExperimentScientificPlan', planPayload);
  const payload = {
    version: researchBinding ? 5 : 4,
    kind: 'VersionedExperimentIR',
    irVersion: researchBinding ? 'experiment-ir-v5' : 'experiment-ir-v4',
    experimentId: String(experimentAttemptId),
    profileId: profile.profileId,
    benchmarkFamily: profile.benchmarkFamily,
    sourceProfileHash: profile.autonomousEmpiricalFamilyPluginProfileHash,
    sourceAuthority: authority,
    experimentPlanHash,
    design,
    estimator: Object.freeze({
      estimatorAbiVersion: 'resolved-analysis-protocol-v2',
      inferenceMode: profile.inferenceMode,
      primaryMetric: profile.primaryMetric,
      secondaryMetric: profile.secondaryMetric,
      analysisProtocolHash: analysisProtocol.analysisProtocolHash,
    }),
    metrics: metricDefinitions(profile),
    analysisProtocol,
    stopping: Object.freeze({
      stoppingRuleVersion: 'fixed-resolved-design-no-optional-stopping-v2',
      mode: 'fixed-schedule',
      plannedPairedCellCount: design.pairedCellCount,
      plannedScheduleCellCount: design.scheduleCellCount,
      earlyStoppingAllowed: false,
    }),
    dataset: boundDataset,
    oracleAbi: Object.freeze({
      oracleAbiVersion: 'typed-numeric-oracle-v1',
      requiredOracleTypes: Object.freeze([...profile.typedOracleKinds].sort()),
      candidateAuthoredValuesAccepted: false,
      independentRecomputationRequired: profile.typedOracleKinds.some((kind) => (
        !['property-oracle-v1', 'residual-bound-v1'].includes(kind)
      )),
    }),
    execution,
    provenance: execution.executionBinding,
    ...(researchBinding ? { researchBinding } : {}),
    runtimeRegistryMutationAllowed: false,
  };
  return Object.freeze({
    ...payload,
    versionedExperimentIrHash: hashRecord('VersionedExperimentIR', payload),
  });
}

function verifyResolvedIrShape(value, profile) {
  const researchResolved = value?.version === 5;
  const datasetBacked = value?.dataset?.selectorType === 'authorized_dataset_mount';
  const protocolSet = resolvedProtocolSet(value);
  const compatibility = value?.researchBinding?.datasetCompatibility;
  const advancedOracleRequired = profile.typedOracleKinds.some((kind) => (
    !['property-oracle-v1', 'residual-bound-v1'].includes(kind)
  ));
  if (!hasExactObjectKeys(value, researchResolved ? IR_V3_KEYS : IR_V2_KEYS)
    || ![4, 5].includes(value.version) || value.kind !== 'VersionedExperimentIR'
    || value.irVersion !== (researchResolved ? 'experiment-ir-v5' : 'experiment-ir-v4')
    || value.profileId !== profile.profileId
    || value.benchmarkFamily !== profile.benchmarkFamily
    || value.sourceProfileHash !== profile.autonomousEmpiricalFamilyPluginProfileHash
    || !hasExactObjectKeys(value.sourceAuthority, SOURCE_AUTHORITY_KEYS)
    || value.sourceAuthority?.productionAuthorized !== true
    || value.sourceAuthority?.canonicalProductionAuthority !== true
    || value.sourceAuthority?.signatureVerified !== true
    || value.runtimeRegistryMutationAllowed !== false
    || !sha(value.versionedExperimentIrHash)
    || !sha(value.experimentPlanHash)
    || !hasExactObjectKeys(value.design, DESIGN_KEYS)
    || value.design.designVersion !== 'resolved-three-arm-paired-seed-design-v2'
    || value.design.assignmentUnit !== 'seed-repetition-cell'
    || value.design.comparisonMode !== 'paired-within-seed-repetition'
    || !Array.isArray(value.design.seedSchedule) || !value.design.seedSchedule.length
    || value.design.seedSchedule.some((seed) => !Number.isSafeInteger(seed))
    || new Set(value.design.seedSchedule).size !== value.design.seedSchedule.length
    || !positiveInteger(value.design.repetitionsPerSeed)
    || value.design.pairedCellCount !== value.design.seedSchedule.length
      * value.design.repetitionsPerSeed
    || value.design.scheduleCellCount !== value.design.pairedCellCount * ARMS.length
    || JSON.stringify(value.design.arms) !== JSON.stringify(ARMS)
    || ![value.design.campaignBenchmarkSelectorHash, value.design.experimentDesignHash,
      value.design.benchmarkHarnessHash, value.design.systemBenchmarkArmProtocolSetHash].every(sha)
    || !protocolSet || protocolSet.systemBenchmarkArmProtocolSetHash
      !== value.design.systemBenchmarkArmProtocolSetHash
    || !hasExactObjectKeys(value.execution, EXECUTION_KEYS)
    || !hasExactObjectKeys(value.execution?.executionBinding, EXECUTION_BINDING_KEYS)
    || !hasExactObjectKeys(value.provenance, EXECUTION_BINDING_KEYS)
    || !resolvedBudgetValid(value.execution?.budget, researchResolved)
    || !armAdapterSetValid(value.execution?.armAdapterSet, protocolSet)
    || value.execution.adapterId !== profile.executionAdapterId
    || value.execution.language !== profile.executionProfile.language
    || value.execution.requiresGpu !== profile.executionProfile.requiresGpu
    || value.execution.requiresGpu !== value.execution.budget.gpuRequired
    || !sha(value.provenance?.experimentExecutionBindingHash)
    || value.execution?.executionBinding?.experimentExecutionBindingHash
      !== value.provenance.experimentExecutionBindingHash
    || JSON.stringify(value.execution?.budget)
      !== JSON.stringify(value.execution?.executionBinding?.budget)
    || JSON.stringify(value.execution?.budget)
      !== JSON.stringify(value.provenance?.budget)
    || JSON.stringify(value.execution?.executionBinding)
      !== JSON.stringify(value.provenance)
    || !hasExactObjectKeys(value.estimator, ESTIMATOR_KEYS)
    || value.estimator.estimatorAbiVersion !== 'resolved-analysis-protocol-v2'
    || value.estimator.inferenceMode !== profile.inferenceMode
    || value.estimator.primaryMetric !== profile.primaryMetric
    || value.estimator.secondaryMetric !== profile.secondaryMetric
    || value.estimator.analysisProtocolHash !== value.analysisProtocol?.analysisProtocolHash
    || !hasExactObjectKeys(value.stopping, STOPPING_KEYS)
    || value.stopping.stoppingRuleVersion !== 'fixed-resolved-design-no-optional-stopping-v2'
    || value.stopping.mode !== 'fixed-schedule'
    || value.stopping?.plannedScheduleCellCount !== value.design.scheduleCellCount
    || value.stopping?.plannedPairedCellCount !== value.design.pairedCellCount
    || value.stopping?.earlyStoppingAllowed !== false
    || !hasExactObjectKeys(value.oracleAbi, ORACLE_ABI_KEYS)
    || value.oracleAbi.oracleAbiVersion !== 'typed-numeric-oracle-v1'
    || value.oracleAbi.candidateAuthoredValuesAccepted !== false
    || value.oracleAbi.independentRecomputationRequired !== advancedOracleRequired
    || JSON.stringify(value.oracleAbi.requiredOracleTypes)
      !== JSON.stringify([...profile.typedOracleKinds].sort())
    || JSON.stringify(value.metrics) !== JSON.stringify(metricDefinitions(profile))
    || !hasExactObjectKeys(value.dataset, researchResolved
      ? [...DATASET_KEYS, 'datasetResearchCompatibilityHash'] : DATASET_KEYS)
    || !['builtin_benchmark_suite', 'authorized_dataset_mount'].includes(value.dataset.selectorType)
    || value.dataset.datasetContractVersion !== 'resolved-system-benchmark-dataset-v2'
    || value.dataset?.benchmarkFamily !== profile.benchmarkFamily
    || value.dataset?.evaluatorDescriptorHash !== profile.evaluatorDescriptorHash
    || value.dataset?.fixtureEvaluatorId !== profile.fixtureEvaluatorId
    || value.dataset?.responseField !== profile.responseField
    || value.dataset.runtimeNetworkAccessAllowed !== false
    || !sha(value.dataset.datasetAuthorizationSetHash)
    || !sha(value.dataset.datasetSplitIdentityHash)
    || (datasetBacked ? (
      typeof value.dataset.datasetMountName !== 'string' || !value.dataset.datasetMountName
      || ![value.dataset.datasetManifestHash, value.dataset.datasetSplitManifestHash,
        value.dataset.datasetOperatorAuthorizationHash,
        value.dataset.operatorDatasetAuthorityDocumentHash,
        value.dataset.operatorDatasetHarnessDefinitionHash].every(sha)
      || value.dataset.datasetOperatorAuthorizationHash
        !== value.dataset.operatorDatasetAuthorityDocumentHash
    ) : [value.dataset.datasetMountName, value.dataset.datasetManifestHash,
      value.dataset.datasetSplitManifestHash, value.dataset.datasetOperatorAuthorizationHash,
      value.dataset.operatorDatasetAuthorityDocumentHash,
      value.dataset.operatorDatasetHarnessDefinitionHash].some((item) => item !== null))
    || value.dataset?.datasetAuthorizationSetHash
      !== value.provenance?.datasetAuthorizationSetHash
    || value.execution?.systemBenchmarkArmAdapterSetHash
      !== value.provenance?.systemBenchmarkArmAdapterSetHash
    || value.execution?.armAdapterSet?.systemBenchmarkArmAdapterSetHash
      !== value.execution?.systemBenchmarkArmAdapterSetHash
    || typeof value.experimentId !== 'string' || !value.experimentId
    || value.experimentId !== value.provenance?.experimentAttemptId
    || !positiveInteger(value.provenance?.attemptVersion)
    || !Array.isArray(value.provenance?.failedAttemptLineageHashes)
    || value.provenance.failedAttemptLineageHashes.length !== value.provenance.attemptVersion - 1
    || value.provenance.failedAttemptLineageHashes.some((item) => !sha(item))
    || new Set(value.provenance.failedAttemptLineageHashes).size
      !== value.provenance.failedAttemptLineageHashes.length
    || ![value.provenance.sourceLineageHash, value.provenance.sourceMerkleHash,
      value.provenance.sourceWorkspaceManifestHash].every(sha)
    || (researchResolved && (!verifyExperimentResearchBinding(value.researchBinding)
      || !datasetBacked
      || value.researchBinding.protocolFamily !== value.benchmarkFamily
      || compatibility.datasetName !== value.dataset.datasetMountName
      || compatibility.datasetManifestHash !== value.dataset.datasetManifestHash
      || compatibility.datasetSplitManifestHash !== value.dataset.datasetSplitManifestHash
      || compatibility.datasetSplitIdentityHash !== value.dataset.datasetSplitIdentityHash
      || compatibility.selectorHash !== value.design.campaignBenchmarkSelectorHash
      || compatibility.operatorDatasetAuthorityDocumentHash
        !== value.dataset.operatorDatasetAuthorityDocumentHash
      || value.researchBinding.datasetResearchCompatibilityHash
        !== value.dataset.datasetResearchCompatibilityHash
      || value.researchBinding.executionBudget.maximumWallTimeMs
        !== value.execution.budget.maximumWallTimeMs
      || value.researchBinding.executionBudget.memoryBytes
        !== value.execution.budget.workerMemoryBytes
      || value.researchBinding.executionBudget.cpuCount
        !== value.execution.budget.cpuCount
      || value.researchBinding.executionBudget.aggregateCpuSeconds
        !== value.execution.budget.aggregateCpuSeconds
      || value.researchBinding.executionBudget.cpuBudgetSemantics
        !== value.execution.budget.cpuBudgetSemantics
      || value.researchBinding.executionBudget.executionEnvironment
        !== value.execution.budget.executionEnvironment))
    || (!researchResolved && value.dataset?.datasetResearchCompatibilityHash !== undefined)
    || !verifyAnalysisProtocol(value.analysisProtocol, {
      benchmarkId: value.analysisProtocol?.benchmarkId,
      benchmarkFamily: profile.benchmarkFamily,
      requiredMetrics: profile.requiredMetrics,
      metricSpecs: profile.metricSpecs,
    })) return false;
  const { versionedExperimentIrHash, ...payload } = value;
  const { experimentExecutionBindingHash, ...executionBindingPayload } = value.provenance;
  const expectedPlanHash = hashRecord('VersionedExperimentScientificPlan', {
    sourceProfileHash: value.sourceProfileHash,
    campaignBenchmarkSelectorHash: value.design.campaignBenchmarkSelectorHash,
    experimentDesignHash: value.design.experimentDesignHash,
    benchmarkHarnessHash: value.design.benchmarkHarnessHash,
    systemBenchmarkArmProtocolSetHash: value.design.systemBenchmarkArmProtocolSetHash,
    systemBenchmarkArmAdapterSetHash: value.execution.systemBenchmarkArmAdapterSetHash,
    datasetAuthorizationSetHash: value.dataset.datasetAuthorizationSetHash,
    analysisProtocolHash: value.analysisProtocol.analysisProtocolHash,
    seedSchedule: value.design.seedSchedule,
    repetitionsPerSeed: value.design.repetitionsPerSeed,
    ...(researchResolved ? {
      experimentResearchBindingHash: value.researchBinding.experimentResearchBindingHash,
      researchAgendaIrHash: value.researchBinding.researchAgendaIrHash,
      empiricalClaimRecordHash: value.researchBinding.empiricalClaimRecordHash,
      dataRequirementsHash: value.researchBinding.dataRequirementsHash,
      estimandHash: value.researchBinding.estimandHash,
      falsifiersHash: value.researchBinding.falsifiersHash,
      datasetResearchCompatibilityHash:
        value.researchBinding.datasetResearchCompatibilityHash,
    } : {}),
  });
  return hashRecord('VersionedExperimentExecutionBinding', executionBindingPayload)
      === experimentExecutionBindingHash
    && expectedPlanHash === value.experimentPlanHash
    && hashRecord('VersionedExperimentIR', payload) === versionedExperimentIrHash;
}

export function buildVersionedExperimentIr(profile, {
  registry = AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY,
  startupInspection = AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION,
  requireProductionAuthority = true,
} = {}) {
  if (!profileHashValid(profile)) throw new Error('experiment_ir_profile_invalid');
  const authority = sourceAuthority(profile, { registry, startupInspection });
  if (requireProductionAuthority && !authority.productionAuthorized) {
    throw new Error('experiment_ir_production_authority_required');
  }
  if (!Array.isArray(profile.requiredMetrics) || !Array.isArray(profile.seedSchedule)
    || !Array.isArray(profile.typedOracleKinds)
    || profile.typedOracleKinds.some((kind) => !TYPED_NUMERIC_ORACLE_TYPES.includes(kind))) {
    throw new Error('experiment_ir_profile_capability_invalid');
  }
  const payload = {
    version: 1,
    kind: 'VersionedExperimentIR',
    irVersion: 'experiment-ir-v1',
    experimentId: profile.profileId,
    benchmarkFamily: profile.benchmarkFamily,
    sourceProfileHash: profile.autonomousEmpiricalFamilyPluginProfileHash,
    sourceAuthority: authority,
    design: Object.freeze({
      designVersion: 'three-arm-paired-seed-design-v1',
      arms: ARMS,
      assignmentUnit: 'seed-repetition-cell',
      comparisonMode: 'paired-within-seed-repetition',
      seedSchedule: Object.freeze([...profile.seedSchedule]),
      repetitionsPerSeed: profile.minimumRepetitions,
    }),
    estimator: Object.freeze({
      estimatorAbiVersion: 'registered-analysis-protocol-v1',
      inferenceMode: profile.inferenceMode,
      primaryMetric: profile.primaryMetric,
      secondaryMetric: profile.secondaryMetric,
    }),
    metrics: metricDefinitions(profile),
    stopping: Object.freeze({
      stoppingRuleVersion: 'fixed-design-no-optional-stopping-v1',
      mode: 'fixed-schedule',
      plannedCellCount: profile.seedSchedule.length * profile.minimumRepetitions,
      earlyStoppingAllowed: false,
    }),
    dataset: Object.freeze({
      datasetContractVersion: 'registered-benchmark-dataset-v1',
      benchmarkFamily: profile.benchmarkFamily,
      responseField: profile.responseField,
      evaluatorDescriptorHash: profile.evaluatorDescriptorHash,
      runtimeNetworkAccessAllowed: false,
    }),
    oracleAbi: Object.freeze({
      oracleAbiVersion: 'typed-numeric-oracle-v1',
      requiredOracleTypes: Object.freeze([...profile.typedOracleKinds].sort()),
      candidateAuthoredValuesAccepted: false,
      independentRecomputationRequired: profile.typedOracleKinds.some((kind) => (
        !['property-oracle-v1', 'residual-bound-v1'].includes(kind)
      )),
    }),
    execution: Object.freeze({
      adapterId: profile.executionAdapterId,
      language: profile.executionProfile.language,
      requiresGpu: profile.executionProfile.requiresGpu,
    }),
    runtimeRegistryMutationAllowed: false,
  };
  return Object.freeze({
    ...payload,
    versionedExperimentIrHash: hashRecord('VersionedExperimentIR', payload),
  });
}

export function verifyVersionedExperimentIr(value, options) {
  try {
    const profile = options?.profile || autonomousEmpiricalFamilyPluginProfileFor(
      value?.benchmarkFamily,
    );
    if ([4, 5].includes(value?.version)) {
      if (!profileHashValid(profile) || !verifyResolvedIrShape(value, profile)) return false;
      const canonicalAuthority = sourceAuthority(profile, {
        registry: options?.registry || AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY,
        startupInspection: options?.startupInspection
          || AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION,
      });
      if (JSON.stringify(value.sourceAuthority) !== JSON.stringify(canonicalAuthority)) return false;
      if (options?.resolvedExecution) {
        return JSON.stringify(buildResolvedVersionedExperimentIr(profile, {
          ...options.resolvedExecution,
          registry: options?.registry || AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY,
          startupInspection: options?.startupInspection
            || AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION,
        })) === JSON.stringify(value);
      }
      return true;
    }
    return JSON.stringify(buildVersionedExperimentIr(profile, options))
      === JSON.stringify(value);
  } catch { return false; }
}

export function versionedExperimentIrFor(benchmarkFamily) {
  const profile = autonomousEmpiricalFamilyPluginProfileFor(benchmarkFamily);
  if (!profile) throw new Error('experiment_ir_benchmark_family_unsupported');
  return buildVersionedExperimentIr(profile);
}
