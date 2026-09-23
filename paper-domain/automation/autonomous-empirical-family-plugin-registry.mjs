import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  observeImmutableSignedBundleStartupTime,
  readImmutableSignedBundleConfiguration,
  verifyImmutableEd25519AuthorityDocument,
} from '../../workflow-kernel/runtime/immutable-signed-json-bundle.mjs';
import {
  SYSTEM_BENCHMARK_EVALUATOR_REGISTRY,
  systemBenchmarkEvaluatorDescriptorFor,
  verifySystemBenchmarkEvaluatorRegistry,
} from './system-benchmark-evaluator-abi.mjs';
import { TYPED_NUMERIC_ORACLE_TYPES } from '../research/typed-numeric-oracle-certificate.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const PROFILE_KEYS = Object.freeze([
  'benchmarkFamily', 'executionAdapterId', 'executionProfile', 'fixtureEvaluatorId',
  'inferenceMode', 'kind', 'metricSpecs', 'minimumRepetitions', 'primaryMetric',
  'profileId', 'requiredMetrics', 'responseField', 'secondaryMetric', 'seedSchedule',
  'typedOracleKinds', 'version',
]);
const EXECUTION_PROFILE_KEYS = Object.freeze(['label', 'language', 'requiresGpu']);
const METRIC_SPEC_KEYS = Object.freeze(['direction', 'maximum', 'minimum', 'unit']);
const INFERENCE_MODES = new Set(['seed-cluster', 'seed-repetition-cell']);
const LANGUAGES = new Set(['python', 'r']);
const PRODUCTION_EXECUTION_ADAPTER = 'repository-system-benchmark-harness-v1';
const MAXIMUM_PROFILES = 128;
const PACKAGE_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[A-Za-z0-9.-]{1,64})?$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const KNOWN_TYPED_ORACLE_KINDS = new Set(TYPED_NUMERIC_ORACLE_TYPES);
const ADVANCED_TYPED_ORACLE_KINDS = Object.freeze(TYPED_NUMERIC_ORACLE_TYPES.filter((kind) => (
  !['property-oracle-v1', 'residual-bound-v1'].includes(kind)
)));
const PACKAGE_KEYS = Object.freeze([
  'autonomousEmpiricalFamilyPluginPackageHash', 'dataOnly', 'evaluatorRegistryHash',
  'executablePayloadsAllowed', 'kind', 'packageId', 'packageVersion', 'pluginAbiHash',
  'registry', 'runtimeRegistryMutationAllowed', 'version',
]);
const AUTHORITY_KEYS = Object.freeze([
  'evaluatorRegistryHash', 'expiresAt', 'kind', 'packageHash', 'packageId',
  'packageVersion', 'pluginAbiHash', 'signatures', 'signedAt', 'version',
]);
let trustedStartupRegistry = null;
let trustedStartupProfilesByFamily = null;

function id(value) {
  const candidate = String(value || '').trim();
  return SAFE_ID.test(candidate) ? candidate : null;
}

function denseArray(value, minimum = 1, maximum = 256) {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
    && value.length >= minimum && value.length <= maximum
    && Object.keys(value).length === value.length;
}

function uniqueIds(values, maximum = 256) {
  if (!denseArray(values, 1, maximum)) return null;
  const selected = values.map(id);
  if (selected.some((value) => !value) || new Set(selected).size !== selected.length) return null;
  return Object.freeze([...selected]);
}

function metricSpecs(value, requiredMetrics) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...requiredMetrics].sort().join('\0')) return null;
  const selected = [];
  for (const metric of [...requiredMetrics].sort()) {
    const spec = value[metric];
    if (!hasExactObjectKeys(spec, METRIC_SPEC_KEYS)
      || !id(spec.unit) || !['maximize', 'minimize'].includes(spec.direction)
      || !Number.isFinite(Number(spec.minimum)) || !Number.isFinite(Number(spec.maximum))
      || Number(spec.minimum) > Number(spec.maximum)
      || Math.abs(Number(spec.minimum)) > 1e15 || Math.abs(Number(spec.maximum)) > 1e15) {
      return null;
    }
    selected.push([metric, Object.freeze({
      unit: String(spec.unit),
      direction: spec.direction,
      minimum: Number(spec.minimum),
      maximum: Number(spec.maximum),
    })]);
  }
  return Object.freeze(Object.fromEntries(selected));
}

function seedSchedule(value) {
  if (!denseArray(value, 1, 1_024)) return null;
  const selected = value.map(Number);
  if (selected.some((seed) => !Number.isSafeInteger(seed))
    || new Set(selected).size !== selected.length) return null;
  return Object.freeze(selected);
}

function compileProfile(value, evaluatorRegistry) {
  if (!hasExactObjectKeys(value, PROFILE_KEYS)
    || value.version !== 1 || value.kind !== 'AutonomousEmpiricalFamilyPluginProfile') {
    throw new Error('autonomous_empirical_family_plugin_profile_shape_invalid');
  }
  const benchmarkFamily = id(value.benchmarkFamily);
  const profileId = id(value.profileId);
  const executionAdapterId = id(value.executionAdapterId);
  const fixtureEvaluatorId = id(value.fixtureEvaluatorId);
  const responseField = id(value.responseField);
  const primaryMetric = id(value.primaryMetric);
  const secondaryMetric = id(value.secondaryMetric);
  const requiredMetrics = uniqueIds(value.requiredMetrics, 64);
  const typedOracleKinds = uniqueIds(value.typedOracleKinds, 32);
  const seeds = seedSchedule(value.seedSchedule);
  const executionProfile = value.executionProfile;
  const productionExecutable = executionAdapterId === PRODUCTION_EXECUTION_ADAPTER;
  const specs = requiredMetrics ? metricSpecs(value.metricSpecs, requiredMetrics) : null;
  const evaluator = benchmarkFamily
    ? systemBenchmarkEvaluatorDescriptorFor(benchmarkFamily, evaluatorRegistry) : null;
  if (!benchmarkFamily || !profileId || !executionAdapterId || !fixtureEvaluatorId
    || !responseField || !primaryMetric || !secondaryMetric || !requiredMetrics
    || !requiredMetrics.includes(primaryMetric) || !requiredMetrics.includes(secondaryMetric)
    || !typedOracleKinds || !typedOracleKinds.includes('property-oracle-v1')
    || !typedOracleKinds.includes('residual-bound-v1') || !seeds || !specs
    || typedOracleKinds.some((kind) => !KNOWN_TYPED_ORACLE_KINDS.has(kind))
    || !INFERENCE_MODES.has(value.inferenceMode)
    || !hasExactObjectKeys(executionProfile, EXECUTION_PROFILE_KEYS)
    || !LANGUAGES.has(executionProfile.language)
    || executionProfile.label !== executionProfile.language
    || typeof executionProfile.requiresGpu !== 'boolean'
    || (productionExecutable && executionProfile.requiresGpu === true)
    || !Number.isSafeInteger(Number(value.minimumRepetitions))
    || Number(value.minimumRepetitions) < 1 || Number(value.minimumRepetitions) > 10_000
    || !evaluator
    || evaluator.metrics.map((metric) => metric.metric).sort().join('\0')
      !== [...requiredMetrics].sort().join('\0')) {
    throw new Error('autonomous_empirical_family_plugin_profile_invalid');
  }
  const payload = {
    version: 1,
    kind: 'AutonomousEmpiricalFamilyPluginProfile',
    profileId,
    benchmarkFamily,
    executionProfile: Object.freeze({
      label: executionProfile.label,
      language: executionProfile.language,
      requiresGpu: executionProfile.requiresGpu,
    }),
    executionAdapterId,
    fixtureEvaluatorId,
    responseField,
    inferenceMode: value.inferenceMode,
    primaryMetric,
    secondaryMetric,
    requiredMetrics: Object.freeze([...requiredMetrics]),
    metricSpecs: specs,
    seedSchedule: seeds,
    minimumRepetitions: Number(value.minimumRepetitions),
    typedOracleKinds: Object.freeze([...typedOracleKinds].sort()),
    evaluatorDescriptorHash: evaluator.systemBenchmarkEvaluatorDescriptorHash,
    productionExecutable,
    runtimeRegistryMutationAllowed: false,
  };
  return Object.freeze({
    ...payload,
    autonomousEmpiricalFamilyPluginProfileHash:
      hashRecord('AutonomousEmpiricalFamilyPluginProfile', payload),
  });
}

export function compileAutonomousEmpiricalFamilyPluginRegistry(
  profiles,
  { evaluatorRegistry = SYSTEM_BENCHMARK_EVALUATOR_REGISTRY } = {},
) {
  if (!denseArray(profiles, 1, MAXIMUM_PROFILES)
    || !verifySystemBenchmarkEvaluatorRegistry(evaluatorRegistry)) {
    throw new Error('autonomous_empirical_family_plugin_registry_input_invalid');
  }
  const selected = Object.freeze(profiles.map((profile) => (
    compileProfile(profile, evaluatorRegistry)
  )).sort((left, right) => left.benchmarkFamily.localeCompare(right.benchmarkFamily)));
  if (new Set(selected.map((profile) => profile.profileId)).size !== selected.length
    || new Set(selected.map((profile) => profile.benchmarkFamily)).size !== selected.length) {
    throw new Error('autonomous_empirical_family_plugin_registry_duplicate');
  }
  const payload = {
    version: 1,
    kind: 'AutonomousEmpiricalFamilyPluginRegistry',
    status: selected.every((profile) => profile.productionExecutable)
      ? 'autonomous_empirical_family_plugin_registry_ready'
      : 'autonomous_empirical_family_plugin_registry_partial',
    evaluatorRegistryHash: evaluatorRegistry.systemBenchmarkEvaluatorRegistryHash,
    profileCount: selected.length,
    profiles: selected,
    runtimeRegistryMutationAllowed: false,
  };
  return Object.freeze({
    ...payload,
    autonomousEmpiricalFamilyPluginRegistryHash:
      hashRecord('AutonomousEmpiricalFamilyPluginRegistry', payload),
  });
}

export function verifyAutonomousEmpiricalFamilyPluginRegistry(
  registry,
  { evaluatorRegistry = SYSTEM_BENCHMARK_EVALUATOR_REGISTRY } = {},
) {
  if (registry === trustedStartupRegistry
    && evaluatorRegistry === SYSTEM_BENCHMARK_EVALUATOR_REGISTRY) return true;
  if (!registry || registry.version !== 1
    || registry.kind !== 'AutonomousEmpiricalFamilyPluginRegistry'
    || !Array.isArray(registry.profiles)) return false;
  try {
    const rebuilt = compileAutonomousEmpiricalFamilyPluginRegistry(
      registry.profiles.map((profile) => sourceProfileFromCompiledProfile(profile)),
      { evaluatorRegistry },
    );
    return JSON.stringify(rebuilt) === JSON.stringify(registry);
  } catch {
    return false;
  }
}

function sourceProfileFromCompiledProfile(profile) {
  const {
    autonomousEmpiricalFamilyPluginProfileHash,
    evaluatorDescriptorHash,
    productionExecutable,
    runtimeRegistryMutationAllowed,
    ...input
  } = profile || {};
  if (hashRecord('AutonomousEmpiricalFamilyPluginProfile', {
    ...input,
    evaluatorDescriptorHash,
    productionExecutable,
    runtimeRegistryMutationAllowed,
  }) !== autonomousEmpiricalFamilyPluginProfileHash) {
    throw new Error('autonomous_empirical_family_plugin_profile_hash_invalid');
  }
  return input;
}

const ABI_PAYLOAD = Object.freeze({
  version: 1,
  kind: 'AutonomousEmpiricalFamilyPluginAbi',
  profileContractVersion: 1,
  evaluatorRegistryHash: SYSTEM_BENCHMARK_EVALUATOR_REGISTRY
    .systemBenchmarkEvaluatorRegistryHash,
  pinnedRuntimeLanguages: Object.freeze(['python', 'r']),
  productionExecutionAdapterIds: Object.freeze([PRODUCTION_EXECUTION_ADAPTER]),
  dataOnly: true,
  executablePayloadsAllowed: false,
  runtimeRegistryMutationAllowed: false,
});

export const AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_ABI = Object.freeze({
  ...ABI_PAYLOAD,
  autonomousEmpiricalFamilyPluginAbiHash:
    hashRecord('AutonomousEmpiricalFamilyPluginAbi', ABI_PAYLOAD),
});

export function compileAutonomousEmpiricalFamilyPluginPackage({
  packageId,
  packageVersion,
  registry,
  pluginAbiHash = AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_ABI
    .autonomousEmpiricalFamilyPluginAbiHash,
} = {}) {
  const selectedPackageId = id(packageId);
  const selectedPackageVersion = String(packageVersion || '');
  if (!selectedPackageId || !PACKAGE_VERSION.test(selectedPackageVersion)
    || pluginAbiHash !== AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_ABI
      .autonomousEmpiricalFamilyPluginAbiHash
    || !verifyAutonomousEmpiricalFamilyPluginRegistry(registry)
    || registry.evaluatorRegistryHash
      !== AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_ABI.evaluatorRegistryHash) {
    throw new Error('autonomous_empirical_family_plugin_package_invalid');
  }
  const canonicalRegistry = compileAutonomousEmpiricalFamilyPluginRegistry(
    registry.profiles.map((profile) => sourceProfileFromCompiledProfile(profile)),
  );
  if (JSON.stringify(canonicalRegistry) !== JSON.stringify(registry)) {
    throw new Error('autonomous_empirical_family_plugin_package_registry_noncanonical');
  }
  const payload = {
    version: 1,
    kind: 'AutonomousEmpiricalFamilyPluginPackage',
    packageId: selectedPackageId,
    packageVersion: selectedPackageVersion,
    pluginAbiHash,
    evaluatorRegistryHash: registry.evaluatorRegistryHash,
    registry: canonicalRegistry,
    dataOnly: true,
    executablePayloadsAllowed: false,
    runtimeRegistryMutationAllowed: false,
  };
  return Object.freeze({
    ...payload,
    autonomousEmpiricalFamilyPluginPackageHash:
      hashRecord('AutonomousEmpiricalFamilyPluginPackage', payload),
  });
}

export function verifyAutonomousEmpiricalFamilyPluginPackage(value) {
  if (!hasExactObjectKeys(value, PACKAGE_KEYS)
    || value?.version !== 1 || value?.kind !== 'AutonomousEmpiricalFamilyPluginPackage'
    || value?.dataOnly !== true || value?.executablePayloadsAllowed !== false
    || value?.runtimeRegistryMutationAllowed !== false
    || !SHA256.test(String(value?.autonomousEmpiricalFamilyPluginPackageHash || ''))) {
    return false;
  }
  try {
    return JSON.stringify(compileAutonomousEmpiricalFamilyPluginPackage(value))
      === JSON.stringify(value);
  } catch { return false; }
}

export function verifyAutonomousEmpiricalFamilyPluginSignedBundle(bundle, {
  trustStore,
  now = null,
  source = 'external-startup-signed-bundle-v1',
  maximumAuthorityLifetimeMs = 366 * 24 * 60 * 60 * 1_000,
} = {}) {
  if (!hasExactObjectKeys(bundle, ['authority', 'kind', 'package', 'version'])
    || bundle?.version !== 1
    || bundle?.kind !== 'AutonomousEmpiricalFamilyPluginSignedBundle'
    || !verifyAutonomousEmpiricalFamilyPluginPackage(bundle.package)
    || !hasExactObjectKeys(bundle.authority, AUTHORITY_KEYS)
    || bundle.authority.version !== 1
    || bundle.authority.kind !== 'AutonomousEmpiricalFamilyPluginPackageAuthority'
    || bundle.authority.packageId !== bundle.package.packageId
    || bundle.authority.packageVersion !== bundle.package.packageVersion
    || bundle.authority.packageHash
      !== bundle.package.autonomousEmpiricalFamilyPluginPackageHash
    || bundle.authority.pluginAbiHash !== bundle.package.pluginAbiHash
    || bundle.authority.evaluatorRegistryHash !== bundle.package.evaluatorRegistryHash) {
    throw new Error('autonomous_empirical_family_plugin_signed_bundle_invalid');
  }
  if (!['external-startup-signed-bundle-v1', 'repository-builtin-signed-bundle-v1']
    .includes(source)) {
    throw new Error('autonomous_empirical_family_plugin_signed_bundle_source_invalid');
  }
  const canonicalPackage = compileAutonomousEmpiricalFamilyPluginPackage(bundle.package);
  const signature = verifyImmutableEd25519AuthorityDocument({
    document: bundle.authority,
    trustStore,
    requiredRole: 'empirical_plugin_authority',
    now,
    maximumLifetimeMs: maximumAuthorityLifetimeMs,
  });
  const productionProfiles = canonicalPackage.registry.profiles
    .filter((profile) => profile.productionExecutable === true);
  const advancedNumericalAnalysisFamilies = Object.freeze(productionProfiles
    .filter((profile) => ADVANCED_TYPED_ORACLE_KINDS.every((kind) => (
      profile.typedOracleKinds.includes(kind)
    )))
    .map((profile) => profile.benchmarkFamily)
    .sort());
  const inspectionPayload = {
    version: 1,
    kind: 'AutonomousEmpiricalFamilyPluginStartupInspection',
    status: 'autonomous_empirical_family_plugin_startup_ready',
    source,
    packageId: canonicalPackage.packageId,
    packageVersion: canonicalPackage.packageVersion,
    packageHash: canonicalPackage.autonomousEmpiricalFamilyPluginPackageHash,
    pluginAbiHash: canonicalPackage.pluginAbiHash,
    evaluatorRegistryHash: canonicalPackage.evaluatorRegistryHash,
    registryHash: canonicalPackage.registry.autonomousEmpiricalFamilyPluginRegistryHash,
    signatureVerified: signature.signatureVerified,
    signerKeyIds: Object.freeze(signature.verifiedSignatures.map(({ keyId }) => keyId).sort()),
    signerSubjectIds: Object.freeze(signature.verifiedSignatures
      .map(({ subjectId }) => subjectId).sort()),
    signerPublicKeySpkiHashes: Object.freeze(signature.verifiedSignatures
      .map(({ publicKeySpkiHash }) => publicKeySpkiHash).sort()),
    signedAt: signature.signedAt,
    expiresAt: signature.expiresAt,
    advancedTypedNumericOracleKinds: ADVANCED_TYPED_ORACLE_KINDS,
    advancedNumericalAnalysisFamilies,
    allProductionProfilesAdvancedNumericalAnalysisCovered:
      productionProfiles.length > 0
      && advancedNumericalAnalysisFamilies.length === productionProfiles.length,
    dataOnly: true,
    executablePayloadsAllowed: false,
    runtimeRegistryMutationAllowed: false,
    reloadAllowed: false,
  };
  return Object.freeze({
    package: canonicalPackage,
    registry: canonicalPackage.registry,
    startupInspection: Object.freeze({
      ...inspectionPayload,
      autonomousEmpiricalFamilyPluginStartupInspectionHash: hashRecord(
        'AutonomousEmpiricalFamilyPluginStartupInspection', inspectionPayload,
      ),
    }),
  });
}

export function autonomousEmpiricalFamilyPluginProfileFor(
  benchmarkFamily,
  registry = AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY,
) {
  if (registry === trustedStartupRegistry) {
    return trustedStartupProfilesByFamily.get(benchmarkFamily) || null;
  }
  if (!verifyAutonomousEmpiricalFamilyPluginRegistry(registry)) return null;
  return registry.profiles.find((profile) => profile.benchmarkFamily === benchmarkFamily) || null;
}

export const AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_BUILTIN_RAW_PROFILES = Object.freeze([
  Object.freeze({
    version: 1,
    kind: 'AutonomousEmpiricalFamilyPluginProfile',
    profileId: 'rl-stochastic-control-v1',
    benchmarkFamily: 'rl_stochastic_control_benchmark',
    executionProfile: Object.freeze({ label: 'python', language: 'python', requiresGpu: false }),
    executionAdapterId: PRODUCTION_EXECUTION_ADAPTER,
    fixtureEvaluatorId: 'repository-rl-stochastic-control-fixture-v1',
    responseField: 'action',
    inferenceMode: 'seed-cluster',
    primaryMetric: 'mean_return',
    secondaryMetric: 'tail_return',
    requiredMetrics: Object.freeze([
      'mean_return', 'tail_return', 'constraint_violation_rate', 'robustness_gap',
    ]),
    metricSpecs: Object.freeze({
      mean_return: Object.freeze({ unit: 'reward', direction: 'maximize', minimum: -1e9, maximum: 1e9 }),
      tail_return: Object.freeze({ unit: 'reward', direction: 'maximize', minimum: -1e9, maximum: 1e9 }),
      constraint_violation_rate: Object.freeze({ unit: 'ratio', direction: 'minimize', minimum: 0, maximum: 1 }),
      robustness_gap: Object.freeze({ unit: 'reward', direction: 'maximize', minimum: -1e9, maximum: 1e9 }),
    }),
    seedSchedule: Object.freeze([17, 23, 31, 43, 59]),
    minimumRepetitions: 2,
    typedOracleKinds: Object.freeze(['property-oracle-v1', 'residual-bound-v1']),
  }),
  Object.freeze({
    version: 1,
    kind: 'AutonomousEmpiricalFamilyPluginProfile',
    profileId: 'ml-algorithm-v1',
    benchmarkFamily: 'ml_algorithm_benchmark',
    executionProfile: Object.freeze({ label: 'python', language: 'python', requiresGpu: false }),
    executionAdapterId: PRODUCTION_EXECUTION_ADAPTER,
    fixtureEvaluatorId: 'repository-ml-algorithm-fixture-v1',
    responseField: 'prediction',
    inferenceMode: 'seed-repetition-cell',
    primaryMetric: 'mean_score',
    secondaryMetric: 'robustness_gap',
    requiredMetrics: Object.freeze([
      'mean_score', 'standard_error', 'baseline_gap', 'robustness_gap',
    ]),
    metricSpecs: Object.freeze({
      mean_score: Object.freeze({ unit: 'ratio', direction: 'maximize', minimum: 0, maximum: 1 }),
      standard_error: Object.freeze({ unit: 'ratio', direction: 'minimize', minimum: 0, maximum: 1 }),
      baseline_gap: Object.freeze({ unit: 'ratio', direction: 'maximize', minimum: -1, maximum: 1 }),
      robustness_gap: Object.freeze({ unit: 'ratio', direction: 'maximize', minimum: -1, maximum: 1 }),
    }),
    seedSchedule: Object.freeze([17, 23, 31, 43, 59]),
    minimumRepetitions: 7,
    typedOracleKinds: Object.freeze(['property-oracle-v1', 'residual-bound-v1']),
  }),
  Object.freeze({
    version: 1,
    kind: 'AutonomousEmpiricalFamilyPluginProfile',
    profileId: 'econometrics-panel-v1',
    benchmarkFamily: 'econometrics_panel_benchmark',
    executionProfile: Object.freeze({ label: 'r', language: 'r', requiresGpu: false }),
    executionAdapterId: PRODUCTION_EXECUTION_ADAPTER,
    fixtureEvaluatorId: 'repository-econometrics-panel-fixture-v1',
    responseField: 'estimate',
    inferenceMode: 'seed-cluster',
    primaryMetric: 'mean_effect',
    secondaryMetric: 'robustness_gap',
    requiredMetrics: Object.freeze([
      'mean_effect', 'standard_error', 'placebo_gap', 'robustness_gap',
    ]),
    metricSpecs: Object.freeze({
      mean_effect: Object.freeze({ unit: 'outcome-unit', direction: 'maximize', minimum: -1e6, maximum: 1e6 }),
      standard_error: Object.freeze({ unit: 'outcome-unit', direction: 'minimize', minimum: 0, maximum: 1e6 }),
      placebo_gap: Object.freeze({ unit: 'outcome-unit', direction: 'maximize', minimum: -1e6, maximum: 1e6 }),
      robustness_gap: Object.freeze({ unit: 'outcome-unit', direction: 'maximize', minimum: -1e6, maximum: 1e6 }),
    }),
    seedSchedule: Object.freeze([19, 29, 37, 47, 61]),
    minimumRepetitions: 2,
    typedOracleKinds: Object.freeze(['property-oracle-v1', 'residual-bound-v1']),
  }),
  Object.freeze({
    version: 1,
    kind: 'AutonomousEmpiricalFamilyPluginProfile',
    profileId: 'finance-asset-pricing-v1',
    benchmarkFamily: 'finance_asset_pricing_benchmark',
    executionProfile: Object.freeze({ label: 'r', language: 'r', requiresGpu: false }),
    executionAdapterId: PRODUCTION_EXECUTION_ADAPTER,
    fixtureEvaluatorId: 'repository-finance-asset-pricing-fixture-v1',
    responseField: 'position',
    inferenceMode: 'seed-cluster',
    primaryMetric: 'mean_return',
    secondaryMetric: 'tail_return',
    requiredMetrics: Object.freeze([
      'mean_return', 'tail_return', 'standard_error', 'robustness_gap',
    ]),
    metricSpecs: Object.freeze({
      mean_return: Object.freeze({ unit: 'decimal-return', direction: 'maximize', minimum: -10, maximum: 10 }),
      tail_return: Object.freeze({ unit: 'decimal-return', direction: 'maximize', minimum: -10, maximum: 10 }),
      standard_error: Object.freeze({ unit: 'decimal-return', direction: 'minimize', minimum: 0, maximum: 10 }),
      robustness_gap: Object.freeze({ unit: 'decimal-return', direction: 'maximize', minimum: -10, maximum: 10 }),
    }),
    seedSchedule: Object.freeze([13, 31, 41, 53, 67]),
    minimumRepetitions: 2,
    typedOracleKinds: Object.freeze(['property-oracle-v1', 'residual-bound-v1']),
  }),
  Object.freeze({
    version: 1,
    kind: 'AutonomousEmpiricalFamilyPluginProfile',
    profileId: 'operations-optimization-v1',
    benchmarkFamily: 'operations_optimization_benchmark',
    executionProfile: Object.freeze({ label: 'python', language: 'python', requiresGpu: false }),
    executionAdapterId: PRODUCTION_EXECUTION_ADAPTER,
    fixtureEvaluatorId: 'repository-operations-optimization-fixture-v1',
    responseField: 'decision',
    inferenceMode: 'seed-repetition-cell',
    primaryMetric: 'mean_score',
    secondaryMetric: 'constraint_violation_rate',
    requiredMetrics: Object.freeze([
      'mean_score', 'constraint_violation_rate', 'standard_error', 'robustness_gap',
    ]),
    metricSpecs: Object.freeze({
      mean_score: Object.freeze({ unit: 'objective-unit', direction: 'maximize', minimum: -1e12, maximum: 1e12 }),
      constraint_violation_rate: Object.freeze({ unit: 'ratio', direction: 'minimize', minimum: 0, maximum: 1 }),
      standard_error: Object.freeze({ unit: 'objective-unit', direction: 'minimize', minimum: 0, maximum: 1e12 }),
      robustness_gap: Object.freeze({ unit: 'objective-unit', direction: 'maximize', minimum: -1e12, maximum: 1e12 }),
    }),
    seedSchedule: Object.freeze([11, 23, 47, 71, 89]),
    minimumRepetitions: 7,
    typedOracleKinds: Object.freeze(['property-oracle-v1', 'residual-bound-v1']),
  }),
]);

export const AUTONOMOUS_EMPIRICAL_REGISTERED_SCALAR_RESPONSE_PROFILE_TEMPLATE =
  Object.freeze({
    version: 1,
    kind: 'AutonomousEmpiricalFamilyPluginProfile',
    profileId: 'registered-scalar-response-v1',
    benchmarkFamily: 'registered_scalar_response_benchmark',
    executionProfile: Object.freeze({ label: 'python', language: 'python', requiresGpu: false }),
    executionAdapterId: PRODUCTION_EXECUTION_ADAPTER,
    fixtureEvaluatorId: 'operator-authorized-registered-scalar-response-fixture-v1',
    responseField: 'response',
    inferenceMode: 'seed-repetition-cell',
    primaryMetric: 'mean_score',
    secondaryMetric: 'robustness_gap',
    requiredMetrics: Object.freeze([
      'mean_score', 'standard_error', 'constraint_violation_rate', 'robustness_gap',
    ]),
    metricSpecs: Object.freeze({
      mean_score: Object.freeze({
        unit: 'negative-squared-error', direction: 'maximize', minimum: -4e12, maximum: 0,
      }),
      standard_error: Object.freeze({
        unit: 'negative-squared-error', direction: 'minimize', minimum: 0, maximum: 4e12,
      }),
      constraint_violation_rate: Object.freeze({
        unit: 'ratio', direction: 'minimize', minimum: 0, maximum: 1,
      }),
      robustness_gap: Object.freeze({
        unit: 'negative-squared-error', direction: 'maximize', minimum: -4e12, maximum: 4e12,
      }),
    }),
    seedSchedule: Object.freeze([17, 23, 31, 43, 59]),
    minimumRepetitions: 7,
    typedOracleKinds: Object.freeze([...TYPED_NUMERIC_ORACLE_TYPES]),
  });

export const AUTONOMOUS_EMPIRICAL_PRODUCTION_BENCHMARK_FAMILIES = Object.freeze(
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_BUILTIN_RAW_PROFILES
    .map((profile) => profile.benchmarkFamily).sort(),
);

const BUILTIN_REGISTRY = compileAutonomousEmpiricalFamilyPluginRegistry(
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_BUILTIN_RAW_PROFILES,
);

const BUILTIN_PACKAGE = compileAutonomousEmpiricalFamilyPluginPackage({
  packageId: 'hepta.repository-builtin-empirical-families',
  packageVersion: '1.0.0',
  registry: BUILTIN_REGISTRY,
});

const BUILTIN_SIGNED_BUNDLE = Object.freeze({
  version: 1,
  kind: 'AutonomousEmpiricalFamilyPluginSignedBundle',
  package: BUILTIN_PACKAGE,
  authority: Object.freeze({
    version: 1,
    kind: 'AutonomousEmpiricalFamilyPluginPackageAuthority',
    packageId: BUILTIN_PACKAGE.packageId,
    packageVersion: BUILTIN_PACKAGE.packageVersion,
    packageHash: BUILTIN_PACKAGE.autonomousEmpiricalFamilyPluginPackageHash,
    pluginAbiHash: BUILTIN_PACKAGE.pluginAbiHash,
    evaluatorRegistryHash: BUILTIN_PACKAGE.evaluatorRegistryHash,
    signedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2100-01-01T00:00:00.000Z',
    signatures: Object.freeze([Object.freeze({
      keyId: 'hepta-repository-empirical-plugin-root-2026-v2',
      role: 'empirical_plugin_authority',
      algorithm: 'ed25519',
      value: 'fgs1QnNZWJh2Uv6QPagiX3HkRtrdNRlAjeLVipyTvsZFO+SlGQPGTUjlsfcEI6gYAe/kzYMvds+W5xy93CNIDg==',
    })]),
  }),
});

const BUILTIN_TRUST_STORE = Object.freeze({
  version: 1,
  kind: 'AuthorityTrustStore',
  keys: Object.freeze([Object.freeze({
    keyId: 'hepta-repository-empirical-plugin-root-2026-v2',
    subjectId: 'hepta-repository-release-authority',
    algorithm: 'ed25519',
    publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEASGAZgPKZB0eA5vgsTYem0plLa6SLbzjvvaw9+Yy8Sr0=\n-----END PUBLIC KEY-----\n',
    roles: Object.freeze(['empirical_plugin_authority']),
    status: 'active',
  })]),
});

const CONFIGURED_STARTUP_BUNDLE = readImmutableSignedBundleConfiguration({
  bundlePathEnvironmentVariable: 'HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE',
  trustStorePathEnvironmentVariable: 'HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE',
});
const STARTUP_OBSERVED_AT = observeImmutableSignedBundleStartupTime();

const STARTUP_PLUGIN_AUTHORITY = CONFIGURED_STARTUP_BUNDLE
  ? verifyAutonomousEmpiricalFamilyPluginSignedBundle(CONFIGURED_STARTUP_BUNDLE.bundle, {
    trustStore: CONFIGURED_STARTUP_BUNDLE.trustStore,
    source: CONFIGURED_STARTUP_BUNDLE.source,
    now: STARTUP_OBSERVED_AT,
  })
  : verifyAutonomousEmpiricalFamilyPluginSignedBundle(BUILTIN_SIGNED_BUNDLE, {
    trustStore: BUILTIN_TRUST_STORE,
    source: 'repository-builtin-signed-bundle-v1',
    maximumAuthorityLifetimeMs: null,
    now: STARTUP_OBSERVED_AT,
  });

trustedStartupRegistry = STARTUP_PLUGIN_AUTHORITY.registry;
trustedStartupProfilesByFamily = new Map(
  trustedStartupRegistry.profiles.map((profile) => [profile.benchmarkFamily, profile]),
);

export const AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PACKAGE =
  STARTUP_PLUGIN_AUTHORITY.package;

export const AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION =
  STARTUP_PLUGIN_AUTHORITY.startupInspection;

export const AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY =
  STARTUP_PLUGIN_AUTHORITY.registry;

export const AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PRODUCTION_PROFILES = Object.freeze(
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY.profiles
    .filter((profile) => profile.productionExecutable === true),
);

export const AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PROFILES = Object.freeze(
  Object.fromEntries(AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY.profiles.map((profile) => [
    profile.benchmarkFamily,
    profile,
  ])),
);

export const AUTONOMOUS_EMPIRICAL_PLUGIN_PROTOCOL_FAMILIES = Object.freeze(
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PRODUCTION_PROFILES
    .map((profile) => profile.benchmarkFamily),
);

export const AUTONOMOUS_EMPIRICAL_PLUGIN_RUNTIME_LANGUAGES = Object.freeze(
  [...new Set(AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PRODUCTION_PROFILES
    .map((profile) => profile.executionProfile.language))].sort(),
);

// GPU training is intentionally a separate artifact-oriented evidence ABI, not
// a scalar-response family smuggled through the system benchmark harness.
export * from '../research/deep-learning-gpu-production-contract.mjs';
