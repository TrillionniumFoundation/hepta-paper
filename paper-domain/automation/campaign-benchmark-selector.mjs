import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION } from './system-benchmark-harness-identity.mjs';
import { isDatasetLicenseId } from './empirical-contract.mjs';
import { buildSystemBenchmarkArmProtocolSet, verifySystemBenchmarkArmProtocolSet } from './system-benchmark-arm-protocol.mjs';
import {
  analysisProtocolMatchesEmpiricalClaimUniverse,
  bindAnalysisProtocolToEmpiricalClaimUniverse,
  buildCanonicalAnalysisProtocol,
  verifyAnalysisProtocol,
} from './analysis-protocol-contract.mjs';
import { verifyEmpiricalClaimUniverse } from '../research/empirical-claim-contract.mjs';
import {
  academicAnalysisIndependentUnitCount,
  isSeedClusterInferenceProfile,
} from './academic-analysis-inference-profile.mjs';
import {
  isOperatorDatasetBenchmarkFamily,
  validateOperatorDatasetAuthorityDocument,
} from './operator-dataset-harness-contract.mjs';
import {
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PACKAGE,
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY,
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION,
} from './autonomous-empirical-family-plugin-registry.mjs';

const BUILTIN_BENCHMARKS = Object.freeze(Object.fromEntries(
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY.profiles.map((profile) => [
    profile.benchmarkFamily,
    Object.freeze({
      seedSchedule: profile.seedSchedule,
      minimumRepetitions: profile.minimumRepetitions,
      requiredMetrics: profile.requiredMetrics,
    }),
  ]),
));
const BUILTIN_BENCHMARK_IDS = new Set(Object.keys(BUILTIN_BENCHMARKS));

const METRIC_SPECS = Object.freeze(Object.fromEntries(
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY.profiles.map((profile) => [
    profile.benchmarkFamily,
    profile.metricSpecs,
  ]),
));

const BENCHMARK_HARNESS_VERSION = 1;

function expandedDeterministicSeedSchedule(seedSchedule, requiredCount, benchmarkFamily) {
  const expanded = [...seedSchedule];
  const seen = new Set(expanded);
  for (let index = 0; expanded.length < requiredCount; index += 1) {
    const digest = hashRecord('AcademicAnalysisBuiltinSeedSchedule', { benchmarkFamily, index });
    const candidate = Number.parseInt(digest.slice('sha256:'.length, 'sha256:'.length + 12), 16);
    if (!seen.has(candidate)) {
      seen.add(candidate);
      expanded.push(candidate);
    }
  }
  return Object.freeze(expanded);
}

function benchmarkHarness(benchmarkId, profile, datasetMount) {
  const armProtocolSet = buildSystemBenchmarkArmProtocolSet({
    benchmarkId,
    datasetBacked: Boolean(datasetMount),
    benchmarkFamily: datasetMount?.benchmarkFamily || null,
  });
  const payload = {
    version: BENCHMARK_HARNESS_VERSION,
    kind: 'CampaignBenchmarkHarness',
    harnessId: datasetMount ? 'authorized-dataset-comparison-v1' : `builtin-${benchmarkId}-v1`,
    benchmarkId,
    observationSchema: 'repository-challenge-keyed-candidate-responses-v1',
    aggregation: 'repository-evaluator-from-hidden-oracle-events-v1',
    fixtureAuthority: 'repository-owned-deterministic-public-challenge-with-host-held-oracle-v1',
    assuranceScope: datasetMount ? 'operator-authorized-hidden-evaluation-v1' : 'synthetic-conformance-only-not-academic-promotion-v1',
    arms: ['treatment', 'baseline', 'ablation'],
    requiredMetrics: [...profile.requiredMetrics],
    metricSpecs: profile.metricSpecs,
    seedSchedule: [...profile.seedSchedule],
    minimumRepetitions: profile.minimumRepetitions,
    armProtocolSet,
    systemBenchmarkArmProtocolSetHash: armProtocolSet.systemBenchmarkArmProtocolSetHash,
    systemBenchmarkHarnessImplementationHash: SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION.systemBenchmarkHarnessImplementationHash,
    empiricalFamilyPluginRegistryHash:
      AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY
        .autonomousEmpiricalFamilyPluginRegistryHash,
    empiricalFamilyPluginPackageHash:
      AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PACKAGE
        .autonomousEmpiricalFamilyPluginPackageHash,
    empiricalFamilyPluginStartupInspectionHash:
      AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION
        .autonomousEmpiricalFamilyPluginStartupInspectionHash,
  };
  return Object.freeze({ ...payload, benchmarkHarnessHash: hashRecord('CampaignBenchmarkHarness', payload) });
}

function buildExperimentDesign(benchmarkId, datasetMount, empiricalClaimUniverse = null) {
  const benchmarkFamily = datasetMount?.benchmarkFamily || benchmarkId;
  const baseProfile = BUILTIN_BENCHMARKS[benchmarkFamily];
  const metricSpecs = METRIC_SPECS[benchmarkFamily];
  if (!baseProfile || !metricSpecs) {
    throw new Error('campaign_benchmark_family_plugin_unavailable');
  }
  const primaryMetric = baseProfile.requiredMetrics[0];
  const profile = Object.freeze({
    ...baseProfile,
    ...(datasetMount ? {
      seedSchedule: [...datasetMount.benchmarkSeedSchedule],
      minimumRepetitions: datasetMount.benchmarkMinimumRepetitions,
    } : {}),
    metricSpecs,
  });
  const templateAnalysisProtocol = datasetMount
    ? Object.freeze({ ...datasetMount.analysisProtocol, analysisProtocolHash: datasetMount.analysisProtocolHash })
    : buildCanonicalAnalysisProtocol({
      benchmarkId,
      benchmarkFamily,
      requiredMetrics: profile.requiredMetrics,
      metricSpecs,
    });
  const builtAnalysisProtocol = empiricalClaimUniverse
    ? bindAnalysisProtocolToEmpiricalClaimUniverse(templateAnalysisProtocol, empiricalClaimUniverse)
    : templateAnalysisProtocol;
  if (!verifyAnalysisProtocol(builtAnalysisProtocol, {
    benchmarkId,
    benchmarkFamily,
    requiredMetrics: profile.requiredMetrics,
    metricSpecs,
  })) throw new Error('campaign_analysis_protocol_invalid');
  if (empiricalClaimUniverse
    && !analysisProtocolMatchesEmpiricalClaimUniverse(builtAnalysisProtocol, empiricalClaimUniverse)) {
    throw new Error('campaign_analysis_protocol_empirical_claim_universe_mismatch');
  }
  const {
    analysisProtocolHash: analysisProtocolTemplateHash,
    ...analysisProtocolTemplate
  } = templateAnalysisProtocol;
  const { analysisProtocolHash, ...analysisProtocol } = builtAnalysisProtocol;
  const inferenceProfile = Object.freeze({
    ...analysisProtocol.inferenceProfile,
    inferenceProfileHash: analysisProtocol.inferenceProfileHash,
  });
  const requiredIndependentUnits = analysisProtocol.power.requiredPairedObservations;
  const clusterInference = isSeedClusterInferenceProfile(inferenceProfile);
  const scheduledSeeds = clusterInference && !datasetMount
    ? expandedDeterministicSeedSchedule(profile.seedSchedule, requiredIndependentUnits, benchmarkFamily)
    : profile.seedSchedule;
  const requiredRepetitions = clusterInference ? profile.minimumRepetitions : Math.ceil(
    requiredIndependentUnits / scheduledSeeds.length,
  );
  const proposedRepetitions = datasetMount
    ? profile.minimumRepetitions
    : Math.max(profile.minimumRepetitions, requiredRepetitions);
  const proposedIndependentUnits = academicAnalysisIndependentUnitCount({
    inferenceProfile,
    seedSchedule: scheduledSeeds,
    minimumRepetitions: proposedRepetitions,
  });
  if ((datasetMount && proposedIndependentUnits < requiredIndependentUnits)
    || (clusterInference && scheduledSeeds.length < requiredIndependentUnits)) {
    throw new Error('campaign_analysis_protocol_schedule_underpowered');
  }
  const scheduledProfile = Object.freeze({
    ...profile,
    seedSchedule: scheduledSeeds,
    minimumRepetitions: proposedRepetitions,
  });
  const harness = benchmarkHarness(benchmarkId, scheduledProfile, datasetMount);
  const datasetSplitIdentityHash = datasetMount?.splitManifestHash || hashRecord('BuiltinBenchmarkHiddenEvaluationFixture', { benchmarkId, version: 1 });
  const payload = {
    version: 3,
    kind: 'CampaignExperimentDesign',
    benchmarkId,
    benchmarkFamily,
    protocol: datasetMount ? 'authorized_dataset_comparison' : 'builtin_controlled_benchmark',
    assuranceScope: datasetMount ? 'operator-authorized-hidden-evaluation-v1' : 'synthetic-conformance-only-not-academic-promotion-v1',
    seedSchedule: scheduledProfile.seedSchedule,
    minimumRepetitions: scheduledProfile.minimumRepetitions,
    requiredMetrics: scheduledProfile.requiredMetrics,
    metricSpecs,
    primaryMetric,
    analysisProtocol,
    analysisProtocolHash,
    ...(empiricalClaimUniverse ? {
      analysisProtocolTemplate: Object.freeze(analysisProtocolTemplate),
      analysisProtocolTemplateHash,
    } : {}),
    analysisProtocolAuthority: empiricalClaimUniverse
      ? (datasetMount
        ? 'operator-signed-template-plus-system-owned-manuscript-claim-binding-v1'
        : 'repository-template-plus-system-owned-manuscript-claim-binding-v1')
      : (datasetMount
        ? 'operator-signed-dataset-harness-authority-v1'
        : 'repository-owned-synthetic-conformance-protocol-v1'),
    requireBaseline: true,
    requireAblation: true,
    statisticalAnalysisPolicy: Object.freeze({
      aggregation: 'system-arithmetic-mean-and-paired-normal-ci-v1',
      confidenceLevel: 0.95,
      alpha: 0.05,
      minimumPower: 0.8,
      minimumEffect: 0,
      minimumStandardizedEffect: 0.5,
      requiredPairedObservations: 32,
      powerModel: 'predeclared-standardized-effect-normal-approximation-v1',
      powerAlphaAdjustment: 'holm-first-step-two-hypotheses-v1',
      multipleComparisonPolicy: 'holm-bonferroni-v1',
      requireDirectionalBaselineImprovement: true,
      requireDirectionalAblationImprovement: true,
    }),
    datasetSplitPolicy: datasetMount ? 'operator-signed-complete-worker-exposure-manifest-v1' : 'repository-owned-hidden-evaluation-fixture-v1',
    datasetSplitIdentityHash,
    datasetLeakagePolicy: datasetMount ? 'signed-worker-exposure-manifest-host-only-oracle-v1' : 'public-input-host-held-oracle-no-label-exposure-v1',
    datasetManifestHash: datasetMount?.manifestHash || null,
    datasetLicenseId: datasetMount?.licenseId || null,
    datasetOperatorAuthorizationHash: datasetMount?.operatorAuthorizationHash || null,
    operatorDatasetAuthorityDocumentHash: datasetMount?.operatorDatasetAuthorityDocumentHash || null,
    datasetSplitManifestHash: datasetMount?.splitManifestHash || null,
    operatorDatasetHarnessDefinitionHash: datasetMount?.benchmarkHarnessDefinitionHash || null,
    operatorDatasetHarnessDocumentHash: datasetMount?.benchmarkHarnessDocumentHash || null,
    benchmarkHarness: harness,
    benchmarkHarnessHash: harness.benchmarkHarnessHash,
  };
  return Object.freeze({ ...payload, experimentDesignHash: hashRecord('CampaignExperimentDesign', payload) });
}

function normalizedBenchmarkId(value) {
  const benchmarkId = String(value ?? '').trim();
  if (!benchmarkId) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(benchmarkId)) {
    throw new Error('campaign_benchmark_id_invalid');
  }
  return benchmarkId;
}

export function buildCampaignBenchmarkSelector({ benchmarkId = null, datasetMounts = [], empiricalClaimUniverse = null } = {}) {
  const id = normalizedBenchmarkId(benchmarkId);
  if (!id) return null;
  if (empiricalClaimUniverse && !verifyEmpiricalClaimUniverse(empiricalClaimUniverse)) {
    throw new Error('campaign_empirical_claim_universe_invalid');
  }
  const environmentNames = new Set();
  for (const mount of datasetMounts || []) {
    const environmentName = `HEPTA_DATASET_${String(mount?.name || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'DATASET'}`;
    if (environmentNames.has(environmentName)) throw new Error(`campaign_dataset_environment_name_collision:${environmentName}`);
    environmentNames.add(environmentName);
  }
  const matches = (datasetMounts || []).filter((mount) => mount?.name === id);
  if (matches.length > 1) throw new Error(`campaign_benchmark_selector_ambiguous:${id}`);
  const datasetMount = matches[0] || null;
  if (!datasetMount && !BUILTIN_BENCHMARK_IDS.has(id)) {
    throw new Error(`campaign_benchmark_selector_unsupported:${id}`);
  }
  let datasetAuthority = null;
  if (datasetMount) {
    try {
      datasetAuthority = validateOperatorDatasetAuthorityDocument(datasetMount.operatorDatasetAuthority, {
        datasetName: datasetMount.name,
        datasetManifestHash: datasetMount.manifestHash,
      });
    } catch { /* rejected by the aggregate authorization gate below */ }
  }
  if (datasetMount && (datasetMount.readOnly !== true || !/^sha256:[0-9a-f]{64}$/i.test(String(datasetMount.manifestHash || ''))
    || !/^sha256:[0-9a-f]{64}$/i.test(String(datasetMount.splitManifestHash || ''))
    || !isDatasetLicenseId(datasetMount.licenseId)
    || !/^sha256:[0-9a-f]{64}$/i.test(String(datasetMount.operatorAuthorizationHash || ''))
    || !/^sha256:[0-9a-f]{64}$/i.test(String(datasetMount.operatorDatasetAuthorityDocumentHash || ''))
    || !datasetAuthority
    || datasetAuthority.operatorDatasetAuthorityDocumentHash !== datasetMount.operatorDatasetAuthorityDocumentHash
    || datasetMount.operatorAuthorizationHash !== datasetMount.operatorDatasetAuthorityDocumentHash
    || datasetAuthority.authority.datasetSplitManifestHash !== datasetMount.splitManifestHash
    || datasetAuthority.authority.datasetLicenseId !== datasetMount.licenseId
    || !/^sha256:[0-9a-f]{64}$/i.test(String(datasetMount.benchmarkHarnessDefinitionHash || ''))
    || datasetAuthority.authority.benchmarkHarnessDefinitionHash !== datasetMount.benchmarkHarnessDefinitionHash
    || !/^sha256:[0-9a-f]{64}$/i.test(String(datasetMount.analysisProtocolHash || ''))
    || datasetAuthority.authority.analysisProtocolHash !== datasetMount.analysisProtocolHash
    || !verifyAnalysisProtocol({ ...datasetMount.analysisProtocol, analysisProtocolHash: datasetMount.analysisProtocolHash }, {
      benchmarkId: id,
      benchmarkFamily: datasetMount.benchmarkFamily,
    })
    || !/^sha256:[0-9a-f]{64}$/i.test(String(datasetMount.benchmarkHarnessDocumentHash || ''))
    || !isOperatorDatasetBenchmarkFamily(datasetMount.benchmarkFamily)
    || !Array.isArray(datasetMount.benchmarkSeedSchedule) || datasetMount.benchmarkSeedSchedule.length < 1
    || !Number.isSafeInteger(Number(datasetMount.benchmarkMinimumRepetitions)))) {
    throw new Error(`campaign_benchmark_dataset_authorization_invalid:${id}`);
  }
  const experimentDesign = buildExperimentDesign(id, datasetMount, empiricalClaimUniverse);
  const templateSelector = empiricalClaimUniverse
    ? buildCampaignBenchmarkSelector({ benchmarkId: id, datasetMounts, empiricalClaimUniverse: null })
    : null;
  const payload = {
    version: 3,
    kind: 'CampaignBenchmarkSelector',
    benchmarkId: id,
    selectorType: datasetMount ? 'authorized_dataset_mount' : 'builtin_benchmark_suite',
    assuranceScope: experimentDesign.assuranceScope,
    datasetMountName: datasetMount?.name || null,
    datasetManifestHash: datasetMount?.manifestHash || null,
    datasetLicenseId: datasetMount?.licenseId || null,
    datasetOperatorAuthorizationHash: datasetMount?.operatorAuthorizationHash || null,
    operatorDatasetAuthorityDocumentHash: datasetMount?.operatorDatasetAuthorityDocumentHash || null,
    datasetSplitManifestHash: datasetMount?.splitManifestHash || null,
    operatorDatasetHarnessDefinitionHash: datasetMount?.benchmarkHarnessDefinitionHash || null,
    operatorDatasetHarnessDocumentHash: datasetMount?.benchmarkHarnessDocumentHash || null,
    analysisProtocol: experimentDesign.analysisProtocol,
    analysisProtocolHash: experimentDesign.analysisProtocolHash,
    benchmarkFamily: datasetMount?.benchmarkFamily || id,
    ...(empiricalClaimUniverse ? { empiricalClaimUniverse } : {}),
    ...(templateSelector ? { benchmarkSelectorTemplateHash: templateSelector.campaignBenchmarkSelectorHash } : {}),
    readOnlyDataset: datasetMount ? datasetMount.readOnly === true : null,
    experimentDesign,
    experimentDesignHash: experimentDesign.experimentDesignHash,
  };
  return Object.freeze({
    ...payload,
    campaignBenchmarkSelectorHash: hashRecord('CampaignBenchmarkSelector', payload),
  });
}

export function verifyCampaignBenchmarkSelector(selector, { benchmarkId = null, datasetMounts = [] } = {}) {
  const blockers = [];
  if (!selector || selector.version !== 3 || selector.kind !== 'CampaignBenchmarkSelector') {
    blockers.push('campaign_benchmark_selector_shape_invalid');
  }
  let expected = null;
  try {
    expected = buildCampaignBenchmarkSelector({
      benchmarkId: benchmarkId || selector?.benchmarkId,
      datasetMounts,
      empiricalClaimUniverse: selector?.empiricalClaimUniverse || null,
    });
  } catch (error) {
    blockers.push(String(error?.message || 'campaign_benchmark_selector_invalid'));
  }
  if (expected && selector?.campaignBenchmarkSelectorHash !== expected.campaignBenchmarkSelectorHash) {
    blockers.push('campaign_benchmark_selector_hash_invalid');
  }
  if (expected && selector?.benchmarkId !== expected.benchmarkId) {
    blockers.push('campaign_benchmark_selector_id_mismatch');
  }
  if (selector?.experimentDesign) {
    const { experimentDesignHash: suppliedDesignHash, ...suppliedDesignPayload } = selector.experimentDesign;
    if (hashRecord('CampaignExperimentDesign', suppliedDesignPayload) !== suppliedDesignHash
      || suppliedDesignHash !== selector.experimentDesignHash) {
      blockers.push('campaign_experiment_design_hash_invalid');
    }
    if (!verifyAnalysisProtocol({
      ...selector.experimentDesign.analysisProtocol,
      analysisProtocolHash: selector.experimentDesign.analysisProtocolHash,
    }, {
      benchmarkId: selector.benchmarkId,
      benchmarkFamily: selector.experimentDesign.benchmarkFamily,
      requiredMetrics: selector.experimentDesign.requiredMetrics,
      metricSpecs: selector.experimentDesign.metricSpecs,
    }) || selector.analysisProtocolHash !== selector.experimentDesign.analysisProtocolHash
      || JSON.stringify(selector.analysisProtocol) !== JSON.stringify(selector.experimentDesign.analysisProtocol)) {
      blockers.push('campaign_analysis_protocol_invalid');
    }
    const harness = selector.experimentDesign.benchmarkHarness;
    if (!harness || harness.kind !== 'CampaignBenchmarkHarness') {
      blockers.push('campaign_benchmark_harness_missing');
    } else {
      const { benchmarkHarnessHash: suppliedHarnessHash, ...suppliedHarnessPayload } = harness;
      if (hashRecord('CampaignBenchmarkHarness', suppliedHarnessPayload) !== suppliedHarnessHash
        || suppliedHarnessHash !== selector.experimentDesign.benchmarkHarnessHash) {
        blockers.push('campaign_benchmark_harness_hash_invalid');
      }
      if (!verifySystemBenchmarkArmProtocolSet(harness.armProtocolSet, {
        benchmarkId: selector.benchmarkId,
        datasetBacked: selector.selectorType === 'authorized_dataset_mount',
        benchmarkFamily: selector.experimentDesign.benchmarkFamily,
      }) || harness.systemBenchmarkArmProtocolSetHash !== harness.armProtocolSet?.systemBenchmarkArmProtocolSetHash) {
        blockers.push('campaign_benchmark_arm_protocol_invalid');
      }
    }
  }
  if (expected && hashRecord('CampaignBenchmarkSelectorExpected', selector) !== hashRecord('CampaignBenchmarkSelectorExpected', expected)) {
    blockers.push('campaign_benchmark_selector_payload_mismatch');
  }
  return Object.freeze({ valid: blockers.length === 0, blockers: [...new Set(blockers)], expected });
}
