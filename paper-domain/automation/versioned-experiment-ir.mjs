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
  return SHA256.test(String(value || ''));
}

function positiveInteger(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function canonicalLineage(values) {
  if (!Array.isArray(values)) throw new Error('experiment_ir_failed_attempt_lineage_invalid');
  const lineage = values.map((value) => String(value).toLowerCase());
  if (lineage.some((value) => !sha(value)) || new Set(lineage).size !== lineage.length) {
    throw new Error('experiment_ir_failed_attempt_lineage_invalid');
  }
  return Object.freeze(lineage);
}

function resolvedDesign(profile, selector) {
  const design = selector?.experimentDesign;
  const seeds = Array.isArray(design?.seedSchedule)
    ? design.seedSchedule.map(Number) : [];
  const repetitions = Number(design?.minimumRepetitions);
  if (!sha(selector?.campaignBenchmarkSelectorHash)
    || !sha(selector?.experimentDesignHash)
    || selector.experimentDesignHash !== design?.experimentDesignHash
    || design?.benchmarkFamily !== profile.benchmarkFamily
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
  const version = Number(attemptVersion);
  const attemptId = String(experimentAttemptId || '');
  const lineage = canonicalLineage(failedAttemptLineageHashes);
  if (!attemptId || attemptId.length > 512 || !positiveInteger(version)
    || lineage.length !== version - 1
    || !sha(sourceLineageHash) || !sha(sourceMerkleHash)
    || !sha(sourceWorkspaceManifestHash)
    || !sha(armAdapterSet?.systemBenchmarkArmAdapterSetHash)
    || !Number.isFinite(Number(absoluteDeadlineEpochMs))
    || !positiveInteger(aggregateCpuSeconds) || !positiveInteger(memoryBytes)
    || !positiveInteger(maximumProcesses)) {
    throw new Error('experiment_ir_execution_binding_invalid');
  }
  const budget = Object.freeze({
    absoluteDeadlineEpochMs: Number(absoluteDeadlineEpochMs),
    aggregateCpuSeconds: Number(aggregateCpuSeconds),
    workerMemoryBytes: Number(memoryBytes),
    workerMaximumProcesses: Number(maximumProcesses),
    gpuRequired: Boolean(requiresGpu),
    ...(maximumWallTimeMs === null ? {} : {
      maximumWallTimeMs: Number(maximumWallTimeMs),
    }),
    ...(cpuCount === null ? {} : { cpuCount: Number(cpuCount) }),
    ...(executionEnvironment === null ? {} : {
      executionEnvironment: String(executionEnvironment),
    }),
  });
  const executionBindingPayload = {
    experimentAttemptId: attemptId,
    attemptVersion: version,
    failedAttemptLineageHashes: lineage,
    sourceLineageHash: String(sourceLineageHash).toLowerCase(),
    sourceMerkleHash: String(sourceMerkleHash).toLowerCase(),
    sourceWorkspaceManifestHash: String(sourceWorkspaceManifestHash).toLowerCase(),
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

/**
 * Compile the immutable, execution-resolved Experiment IR before any schedule is
 * materialized or benchmark data/challenge is consumed. The signed plugin
 * profile remains the semantic authority; the resolved selector, adapters,
 * dataset authorization, attempt lineage and resource budget are bound here.
 */
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
    version: researchBinding ? 3 : 2,
    kind: 'VersionedExperimentIR',
    irVersion: researchBinding ? 'experiment-ir-v3' : 'experiment-ir-v2',
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
  const researchResolved = value?.version === 3;
  if (!hasExactObjectKeys(value, researchResolved ? IR_V3_KEYS : IR_V2_KEYS)
    || ![2, 3].includes(value.version) || value.kind !== 'VersionedExperimentIR'
    || value.irVersion !== (researchResolved ? 'experiment-ir-v3' : 'experiment-ir-v2')
    || value.profileId !== profile.profileId
    || value.benchmarkFamily !== profile.benchmarkFamily
    || value.sourceProfileHash
      !== profile.autonomousEmpiricalFamilyPluginProfileHash
    || value.sourceAuthority?.productionAuthorized !== true
    || value.sourceAuthority?.canonicalProductionAuthority !== true
    || value.sourceAuthority?.signatureVerified !== true
    || value.runtimeRegistryMutationAllowed !== false
    || !sha(value.versionedExperimentIrHash)
    || !sha(value.experimentPlanHash)
    || !sha(value.provenance?.experimentExecutionBindingHash)
    || value.execution?.executionBinding?.experimentExecutionBindingHash
      !== value.provenance.experimentExecutionBindingHash
    || JSON.stringify(value.execution?.executionBinding)
      !== JSON.stringify(value.provenance)
    || value.design?.campaignBenchmarkSelectorHash === undefined
    || !sha(value.design?.campaignBenchmarkSelectorHash)
    || !sha(value.design?.experimentDesignHash)
    || !sha(value.design?.benchmarkHarnessHash)
    || !sha(value.design?.systemBenchmarkArmProtocolSetHash)
    || value.design?.scheduleCellCount !== value.design?.seedSchedule?.length
      * value.design?.repetitionsPerSeed * ARMS.length
    || value.stopping?.plannedScheduleCellCount !== value.design.scheduleCellCount
    || value.stopping?.plannedPairedCellCount !== value.design.pairedCellCount
    || value.stopping?.earlyStoppingAllowed !== false
    || JSON.stringify(value.design.arms) !== JSON.stringify(ARMS)
    || JSON.stringify(value.metrics) !== JSON.stringify(metricDefinitions(profile))
    || value.estimator?.analysisProtocolHash
      !== value.analysisProtocol?.analysisProtocolHash
    || value.dataset?.benchmarkFamily !== profile.benchmarkFamily
    || value.dataset?.evaluatorDescriptorHash !== profile.evaluatorDescriptorHash
    || value.dataset?.fixtureEvaluatorId !== profile.fixtureEvaluatorId
    || value.dataset?.responseField !== profile.responseField
    || value.dataset?.datasetAuthorizationSetHash
      !== value.provenance?.datasetAuthorizationSetHash
    || value.execution?.systemBenchmarkArmAdapterSetHash
      !== value.provenance?.systemBenchmarkArmAdapterSetHash
    || value.execution?.armAdapterSet?.systemBenchmarkArmAdapterSetHash
      !== value.execution?.systemBenchmarkArmAdapterSetHash
    || value.experimentId !== value.provenance?.experimentAttemptId
    || value.provenance?.failedAttemptLineageHashes?.length
      !== value.provenance?.attemptVersion - 1
    || (researchResolved && (!verifyExperimentResearchBinding(value.researchBinding)
      || value.researchBinding.protocolFamily !== value.benchmarkFamily
      || value.researchBinding.datasetCompatibility.datasetName
        !== value.dataset.datasetMountName
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
    if ([2, 3].includes(value?.version)) {
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
