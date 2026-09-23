import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_BUILTIN_RAW_PROFILES,
  AUTONOMOUS_EMPIRICAL_REGISTERED_SCALAR_RESPONSE_PROFILE_TEMPLATE,
  compileAutonomousEmpiricalFamilyPluginPackage,
  compileAutonomousEmpiricalFamilyPluginRegistry,
} from './autonomous-empirical-family-plugin-registry.mjs';
import { TYPED_NUMERIC_ORACLE_TYPES } from '../research/typed-numeric-oracle-certificate.mjs';
import { buildVersionedExperimentIr } from './versioned-experiment-ir.mjs';

const TEMPLATE_KEYS = Object.freeze([
  'kind', 'packageId', 'packageVersion', 'profiles', 'version',
]);

export const AUTONOMOUS_EMPIRICAL_PLUGIN_AUTHORITY_ROLE =
  'empirical_plugin_authority';

export const AUTONOMOUS_ADVANCED_NUMERICAL_ORACLE_TYPES = Object.freeze(
  TYPED_NUMERIC_ORACLE_TYPES.filter((kind) => ![
    'property-oracle-v1', 'residual-bound-v1',
  ].includes(kind)),
);

function sourceProfile(profile) {
  return structuredClone(profile);
}

function advancedCoverage(registry) {
  const profiles = registry.profiles.map((profile) => Object.freeze({
    benchmarkFamily: profile.benchmarkFamily,
    profileId: profile.profileId,
    profileHash: profile.autonomousEmpiricalFamilyPluginProfileHash,
    coveredAdvancedOracleTypes: Object.freeze(
      AUTONOMOUS_ADVANCED_NUMERICAL_ORACLE_TYPES.filter((kind) => (
        profile.typedOracleKinds.includes(kind)
      )),
    ),
    fullAdvancedNumericalCoverage:
      AUTONOMOUS_ADVANCED_NUMERICAL_ORACLE_TYPES.every((kind) => (
        profile.typedOracleKinds.includes(kind)
      )),
  }));
  const payload = {
    version: 1,
    kind: 'AutonomousEmpiricalPluginAdvancedNumericalCoverage',
    requiredAdvancedOracleTypes: AUTONOMOUS_ADVANCED_NUMERICAL_ORACLE_TYPES,
    profileCount: profiles.length,
    profiles: Object.freeze(profiles),
    fullCoverageProfileCount:
      profiles.filter((profile) => profile.fullAdvancedNumericalCoverage).length,
    allProfilesAdvancedNumericalCoverage:
      profiles.every((profile) => profile.fullAdvancedNumericalCoverage),
  };
  return Object.freeze({
    ...payload,
    autonomousEmpiricalPluginAdvancedNumericalCoverageHash: hashRecord(
      'AutonomousEmpiricalPluginAdvancedNumericalCoverage', payload,
    ),
  });
}

export function createAutonomousAdvancedNumericalPluginReleaseTemplate({
  packageId = 'hepta.advanced-numerical-empirical-families',
  packageVersion = '1.0.0',
  benchmarkFamilies = ['ml_algorithm_benchmark'],
} = {}) {
  const requested = Array.isArray(benchmarkFamilies)
    ? benchmarkFamilies.map((value) => String(value || '').trim()) : [];
  const sourceByFamily = new Map(
    [
      ...AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_BUILTIN_RAW_PROFILES,
      AUTONOMOUS_EMPIRICAL_REGISTERED_SCALAR_RESPONSE_PROFILE_TEMPLATE,
    ].map((profile) => (
      [profile.benchmarkFamily, profile]
    )),
  );
  if (requested.length < 1 || new Set(requested).size !== requested.length
    || requested.some((family) => !sourceByFamily.has(family))) {
    throw new Error('autonomous_empirical_plugin_release_template_family_invalid');
  }
  return Object.freeze({
    version: 1,
    kind: 'AutonomousEmpiricalFamilyPluginReleaseTemplate',
    packageId: String(packageId || '').trim(),
    packageVersion: String(packageVersion || '').trim(),
    profiles: Object.freeze(requested.map((family) => Object.freeze({
      ...sourceProfile(sourceByFamily.get(family)),
      typedOracleKinds: TYPED_NUMERIC_ORACLE_TYPES,
    }))),
  });
}

export function buildAutonomousEmpiricalPluginReleasePlan(template) {
  if (!hasExactObjectKeys(template, TEMPLATE_KEYS)
    || template?.version !== 1
    || template?.kind !== 'AutonomousEmpiricalFamilyPluginReleaseTemplate') {
    throw new Error('autonomous_empirical_plugin_release_template_invalid');
  }
  const registry = compileAutonomousEmpiricalFamilyPluginRegistry(template.profiles);
  const pluginPackage = compileAutonomousEmpiricalFamilyPluginPackage({
    packageId: template.packageId,
    packageVersion: template.packageVersion,
    registry,
  });
  const coverage = advancedCoverage(registry);
  if (!coverage.allProfilesAdvancedNumericalCoverage) {
    throw new Error('autonomous_empirical_plugin_advanced_numerical_coverage_required');
  }
  const experimentIrs = Object.freeze(registry.profiles.map((profile) => (
    buildVersionedExperimentIr(profile, {
      registry,
      startupInspection: null,
      requireProductionAuthority: false,
    })
  )));
  const payload = {
    version: 1,
    kind: 'AutonomousEmpiricalPluginReleasePlan',
    packageId: pluginPackage.packageId,
    packageVersion: pluginPackage.packageVersion,
    packageHash: pluginPackage.autonomousEmpiricalFamilyPluginPackageHash,
    registryHash: registry.autonomousEmpiricalFamilyPluginRegistryHash,
    pluginAbiHash: pluginPackage.pluginAbiHash,
    evaluatorRegistryHash: pluginPackage.evaluatorRegistryHash,
    package: pluginPackage,
    advancedNumericalCoverage: coverage,
    experimentIrs,
    experimentIrProductionAuthorizationPending: experimentIrs.every((experimentIr) => (
      experimentIr.sourceAuthority.productionAuthorized === false
        && experimentIr.oracleAbi.independentRecomputationRequired === true
    )),
    releaseRequiresConfiguredExternalEd25519Authority: true,
    unsignedRepositoryTemplateIsAuthority: false,
  };
  return Object.freeze({
    ...payload,
    autonomousEmpiricalPluginReleasePlanHash: hashRecord(
      'AutonomousEmpiricalPluginReleasePlan', payload,
    ),
  });
}

export function verifyAutonomousEmpiricalPluginReleasePlan(plan) {
  try {
    const template = {
      version: 1,
      kind: 'AutonomousEmpiricalFamilyPluginReleaseTemplate',
      packageId: plan?.packageId,
      packageVersion: plan?.packageVersion,
      profiles: plan?.package?.registry?.profiles?.map((profile) => {
        const {
          autonomousEmpiricalFamilyPluginProfileHash,
          evaluatorDescriptorHash,
          productionExecutable,
          runtimeRegistryMutationAllowed,
          ...source
        } = profile;
        void autonomousEmpiricalFamilyPluginProfileHash;
        void evaluatorDescriptorHash;
        void productionExecutable;
        void runtimeRegistryMutationAllowed;
        return source;
      }),
    };
    return JSON.stringify(buildAutonomousEmpiricalPluginReleasePlan(template))
      === JSON.stringify(plan);
  } catch { return false; }
}
