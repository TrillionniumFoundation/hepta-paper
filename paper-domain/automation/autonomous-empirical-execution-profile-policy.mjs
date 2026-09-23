import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys as hasExactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import {
  SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES,
  SYSTEM_DATASET_ACCESS_SUPERVISOR,
} from './dataset-access-supervisor-policy.mjs';
import {
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PACKAGE,
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY,
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION,
  AUTONOMOUS_EMPIRICAL_PLUGIN_RUNTIME_LANGUAGES,
} from './autonomous-empirical-family-plugin-registry.mjs';
import {
  AUTONOMOUS_ANALYSIS_KERNEL_ABI,
  AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY,
  autonomousEmpiricalPluginCompatibilityFor,
  autonomousLanguageRuntimeRegistryEntryFor,
  buildLanguageRuntimeRegistryQualificationBinding,
  verifyLanguageRuntimeRegistryQualificationBinding,
} from './autonomous-language-runtime-kernel-registry.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const RUNTIME_CAPABILITY_INSPECTION_KEYS_V1 = Object.freeze([
  'assuranceScope',
  'autonomousEmpiricalRuntimeCapabilityInspectionHash',
  'kind',
  'languages',
  'runtimeFallbackAllowed',
  'status',
  'unavailableLanguages',
  'version',
].sort());
const RUNTIME_CAPABILITY_INSPECTION_KEYS_V2 = Object.freeze([
  ...RUNTIME_CAPABILITY_INSPECTION_KEYS_V1,
  'analysisKernelAbiHash',
  'languageRuntimeKernelRegistryHash',
].sort());
const LANGUAGE_CAPABILITY_KEYS_V1 = Object.freeze([
  'available',
  'datasetAccessSupervisor',
  'exactDigestVerified',
  'expectedDigest',
  'image',
  'language',
  'observedDigest',
  'runtimeType',
  'trustedDatasetSupervisorConfigured',
].sort());
const LANGUAGE_CAPABILITY_KEYS_V2 = Object.freeze([
  ...LANGUAGE_CAPABILITY_KEYS_V1,
  'analysisKernelAbiHash',
  'compatiblePluginProfileHashes',
  'runtimeRegistryEntryHash',
  'toolchainIdentityHash',
].sort());

const FAMILY_PROFILE_ENTRIES = Object.freeze(
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY.profiles
    .filter((profile) => profile.productionExecutable === true)
    .map((profile) => Object.freeze([
      profile.benchmarkFamily,
      profile.executionProfile.language,
    ])),
);

const FAMILY_PROFILES = Object.freeze(Object.fromEntries(FAMILY_PROFILE_ENTRIES.map(
  ([protocolFamily]) => [protocolFamily, AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY.profiles
    .find((profile) => profile.benchmarkFamily === protocolFamily).executionProfile],
)));

const RUNTIME_PINS = Object.freeze(Object.fromEntries(['python', 'r'].map((language) => {
  const runtime = SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES[language];
  return [language, Object.freeze({
    language,
    runtimeType: 'container',
    image: runtime.image,
    expectedDigest: runtime.imageDigest,
    datasetAccessSupervisor: Object.freeze({
      protocol: SYSTEM_DATASET_ACCESS_SUPERVISOR.protocol,
      path: SYSTEM_DATASET_ACCESS_SUPERVISOR.path,
      sha256: SYSTEM_DATASET_ACCESS_SUPERVISOR.sha256,
      workloadUid: SYSTEM_DATASET_ACCESS_SUPERVISOR.workloadUid,
    }),
  })];
})));

const POLICY_PAYLOAD = Object.freeze({
  version: 3,
  kind: 'AutonomousEmpiricalExecutionProfilePolicy',
  status: 'autonomous_empirical_execution_profile_policy_active',
  selector: 'exact-protocol-family-plugin-registry-v2',
  empiricalFamilyPluginRegistryHash:
    AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY
      .autonomousEmpiricalFamilyPluginRegistryHash,
  empiricalFamilyPluginPackageHash:
    AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PACKAGE
      .autonomousEmpiricalFamilyPluginPackageHash,
  empiricalFamilyPluginStartupInspectionHash:
    AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION
      .autonomousEmpiricalFamilyPluginStartupInspectionHash,
  empiricalPluginStartupAuthorityVerified:
    AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION.signatureVerified,
  familyProfiles: FAMILY_PROFILES,
  runtimePins: RUNTIME_PINS,
  languageRuntimeKernelRegistryHash:
    AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY
      .autonomousLanguageRuntimeKernelRegistryHash,
  analysisKernelAbiHash: AUTONOMOUS_ANALYSIS_KERNEL_ABI.analysisKernelAbiHash,
  exactlyOneExecutionProfileRequired: true,
  runtimeFallbackAllowed: false,
  callerOverrideAllowed: false,
});

export const AUTONOMOUS_EMPIRICAL_EXECUTION_PROFILE_POLICY = Object.freeze({
  ...POLICY_PAYLOAD,
  autonomousEmpiricalExecutionProfilePolicyHash:
    hashRecord('AutonomousEmpiricalExecutionProfilePolicy', POLICY_PAYLOAD),
});

export const AUTONOMOUS_EMPIRICAL_PROTOCOL_FAMILIES = Object.freeze(
  FAMILY_PROFILE_ENTRIES.map(([protocolFamily]) => protocolFamily),
);

function recordHashValid(record, kind, hashField) {
  if (!record || typeof record !== 'object' || !SHA256.test(String(record[hashField] || ''))) {
    return false;
  }
  const { [hashField]: claimedHash, ...payload } = record;
  return hashRecord(kind, payload) === claimedHash;
}

export function verifyAutonomousEmpiricalRuntimeCapabilityInspection(value, {
  requireRegisteredRuntime = false,
} = {}) {
  const registryBound = value?.version === 2;
  const expectedInspectionKeys = registryBound
    ? RUNTIME_CAPABILITY_INSPECTION_KEYS_V2 : RUNTIME_CAPABILITY_INSPECTION_KEYS_V1;
  const expectedLanguageKeys = registryBound
    ? LANGUAGE_CAPABILITY_KEYS_V2 : LANGUAGE_CAPABILITY_KEYS_V1;
  if (!hasExactKeys(value, expectedInspectionKeys)
    || !recordHashValid(
    value,
    'AutonomousEmpiricalRuntimeCapabilityInspection',
    'autonomousEmpiricalRuntimeCapabilityInspectionHash',
  ) || ![1, 2].includes(value?.version)
    || value?.kind !== 'AutonomousEmpiricalRuntimeCapabilityInspection'
    || value?.assuranceScope !== (registryBound
      ? 'registry-bound-local-pinned-container-runtime-preflight-v2'
      : 'local-pinned-container-runtime-preflight-v1')
    || (requireRegisteredRuntime && !registryBound)
    || (registryBound && (
      value.languageRuntimeKernelRegistryHash
        !== AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY
          .autonomousLanguageRuntimeKernelRegistryHash
      || value.analysisKernelAbiHash !== AUTONOMOUS_ANALYSIS_KERNEL_ABI.analysisKernelAbiHash
    ))
    || value?.runtimeFallbackAllowed !== false
    || !value?.languages || typeof value.languages !== 'object' || Array.isArray(value.languages)
    || JSON.stringify(Object.keys(value.languages).sort())
      !== JSON.stringify(AUTONOMOUS_EMPIRICAL_PLUGIN_RUNTIME_LANGUAGES)
    || !Array.isArray(value?.unavailableLanguages)) {
    return false;
  }
  const capabilitiesValid = AUTONOMOUS_EMPIRICAL_PLUGIN_RUNTIME_LANGUAGES
    .every((language) => {
      const capability = value.languages[language];
      const pin = RUNTIME_PINS[language];
      const registryEntry = autonomousLanguageRuntimeRegistryEntryFor({ language });
      return hasExactKeys(capability, expectedLanguageKeys)
        && capability?.language === language
        && capability?.runtimeType === pin.runtimeType
        && capability?.image === pin.image
        && capability?.expectedDigest === pin.expectedDigest
        && (capability.observedDigest === null || SHA256.test(String(capability.observedDigest)))
        && typeof capability?.exactDigestVerified === 'boolean'
        && capability.exactDigestVerified === (capability.observedDigest === pin.expectedDigest)
        && JSON.stringify(capability?.datasetAccessSupervisor)
          === JSON.stringify(pin.datasetAccessSupervisor)
        && capability?.trustedDatasetSupervisorConfigured === true
        && (!registryBound || (registryEntry
          && capability.runtimeRegistryEntryHash === registryEntry.runtimeRegistryEntryHash
          && capability.toolchainIdentityHash === registryEntry.toolchainIdentityHash
          && capability.analysisKernelAbiHash === registryEntry.analysisKernelAbiHash
          && JSON.stringify(capability.compatiblePluginProfileHashes)
            === JSON.stringify(registryEntry.allowedEmpiricalPluginProfiles
              .map((profile) => profile.profileHash))))
        && typeof capability?.available === 'boolean'
        && capability.available === (
          capability.exactDigestVerified && capability.trustedDatasetSupervisorConfigured
        );
    });
  if (!capabilitiesValid) return false;
  const expectedUnavailableLanguages = AUTONOMOUS_EMPIRICAL_PLUGIN_RUNTIME_LANGUAGES
    .filter((language) => value.languages[language].available !== true);
  return JSON.stringify(value.unavailableLanguages) === JSON.stringify(expectedUnavailableLanguages)
    && value.status === (expectedUnavailableLanguages.length
      ? 'autonomous_empirical_runtime_capability_partial_or_blocked'
      : 'autonomous_empirical_runtime_capability_ready');
}

export function selectAutonomousEmpiricalExecutionProfile({
  protocolFamily,
  runtimeCapabilityInspection = null,
  runtimeReproducibilityInspection = null,
  requireRegisteredRuntime = false,
  observedAt = null,
  minimumRemainingValidityMs = 0,
} = {}) {
  const family = String(protocolFamily || '');
  const profile = FAMILY_PROFILES[family];
  if (!profile) throw new Error('autonomous_empirical_execution_profile_family_unsupported');
  const capabilityReceiptValid = verifyAutonomousEmpiricalRuntimeCapabilityInspection(
    runtimeCapabilityInspection,
    { requireRegisteredRuntime },
  );
  const runtimeCapability = capabilityReceiptValid
    ? runtimeCapabilityInspection.languages[profile.language] : null;
  const runtimeRegistryEntry = autonomousLanguageRuntimeRegistryEntryFor({
    language: profile.language,
    benchmarkFamily: family,
  });
  const pluginCompatibility = autonomousEmpiricalPluginCompatibilityFor({
    language: profile.language,
    benchmarkFamily: family,
  });
  let runtimeRegistryQualificationBinding = null;
  if (runtimeReproducibilityInspection) {
    try {
      runtimeRegistryQualificationBinding = buildLanguageRuntimeRegistryQualificationBinding({
        runtimeReproducibilityInspection,
        now: observedAt,
        minimumRemainingValidityMs,
      });
    } catch { /* fail closed below when the binding is required */ }
  }
  const blockers = [];
  if (!capabilityReceiptValid) {
    blockers.push('autonomous_empirical_runtime_capability_inspection_invalid');
  } else if (runtimeCapability.available !== true) {
    blockers.push(`autonomous_empirical_runtime_language_unavailable:${profile.language}`);
  }
  if (!runtimeRegistryEntry || !pluginCompatibility) {
    blockers.push('autonomous_empirical_runtime_registry_plugin_compatibility_missing');
  }
  if (requireRegisteredRuntime && !runtimeRegistryQualificationBinding) {
    blockers.push('autonomous_empirical_runtime_reproducibility_qualification_required');
  }
  const payload = {
    version: 3,
    kind: 'AutonomousEmpiricalExecutionProfileSelection',
    status: blockers.length
      ? 'autonomous_empirical_execution_profile_blocked'
      : 'autonomous_empirical_execution_profile_ready',
    protocolFamily: family,
    executionProfile: profile,
    profileCount: 1,
    policyHash:
      AUTONOMOUS_EMPIRICAL_EXECUTION_PROFILE_POLICY
        .autonomousEmpiricalExecutionProfilePolicyHash,
    empiricalFamilyPluginRegistryHash:
      AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY
        .autonomousEmpiricalFamilyPluginRegistryHash,
    empiricalFamilyPluginPackageHash:
      AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PACKAGE
        .autonomousEmpiricalFamilyPluginPackageHash,
    empiricalFamilyPluginStartupInspectionHash:
      AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION
        .autonomousEmpiricalFamilyPluginStartupInspectionHash,
    empiricalPluginStartupAuthorityVerified:
      AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION.signatureVerified,
    registeredRuntimeRequired: requireRegisteredRuntime === true,
    runtimeRegistryBindingVerified: Boolean(runtimeRegistryEntry && pluginCompatibility
      && runtimeCapabilityInspection?.version === 2),
    languageRuntimeKernelRegistryHash:
      AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY
        .autonomousLanguageRuntimeKernelRegistryHash,
    analysisKernelAbiHash: AUTONOMOUS_ANALYSIS_KERNEL_ABI.analysisKernelAbiHash,
    selectedRuntimeRegistryEntryHash: runtimeRegistryEntry?.runtimeRegistryEntryHash || null,
    selectedToolchainIdentityHash: runtimeRegistryEntry?.toolchainIdentityHash || null,
    selectedEmpiricalPluginProfileHash: pluginCompatibility?.profileHash || null,
    runtimeRegistryQualificationBinding,
    runtimeRegistryQualificationBindingHash:
      runtimeRegistryQualificationBinding
        ?.autonomousLanguageRuntimeRegistryQualificationBindingHash || null,
    runtimeCapabilityInspectionHash: capabilityReceiptValid
      ? runtimeCapabilityInspection.autonomousEmpiricalRuntimeCapabilityInspectionHash : null,
    selectedRuntimeImage: runtimeCapability?.image || null,
    selectedRuntimeExpectedDigest: runtimeCapability?.expectedDigest || null,
    selectedRuntimeImageDigest: runtimeCapability?.observedDigest || null,
    selectedRuntimeExactDigestVerified: runtimeCapability?.exactDigestVerified === true,
    runtimeFallbackAllowed: false,
    runtimeFallbackPerformed: false,
    callerOverrideAllowed: false,
    blockers: Object.freeze(blockers),
  };
  return Object.freeze({
    ...payload,
    autonomousEmpiricalExecutionProfileSelectionHash:
      hashRecord('AutonomousEmpiricalExecutionProfileSelection', payload),
  });
}

export function verifyAutonomousEmpiricalExecutionProfileSelection(value, {
  protocolFamily = null,
  requireReady = false,
  runtimeCapabilityInspection = null,
  requireRuntimeCapabilityInspection = false,
  runtimeReproducibilityInspection = null,
  requireRegisteredRuntime = false,
  observedAt = null,
  minimumRemainingValidityMs = 0,
} = {}) {
  if (!recordHashValid(
    value,
    'AutonomousEmpiricalExecutionProfileSelection',
    'autonomousEmpiricalExecutionProfileSelectionHash',
  ) || value?.version !== 3 || value?.kind !== 'AutonomousEmpiricalExecutionProfileSelection'
    || !Object.hasOwn(FAMILY_PROFILES, value?.protocolFamily)
    || (protocolFamily && value.protocolFamily !== protocolFamily)
    || value?.profileCount !== 1
    || value?.policyHash !== AUTONOMOUS_EMPIRICAL_EXECUTION_PROFILE_POLICY
      .autonomousEmpiricalExecutionProfilePolicyHash
    || value?.empiricalFamilyPluginRegistryHash
      !== AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY
        .autonomousEmpiricalFamilyPluginRegistryHash
    || value?.empiricalFamilyPluginPackageHash
      !== AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PACKAGE
        .autonomousEmpiricalFamilyPluginPackageHash
    || value?.empiricalFamilyPluginStartupInspectionHash
      !== AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION
        .autonomousEmpiricalFamilyPluginStartupInspectionHash
    || value?.empiricalPluginStartupAuthorityVerified !== true
    || value?.languageRuntimeKernelRegistryHash
      !== AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY
        .autonomousLanguageRuntimeKernelRegistryHash
    || value?.analysisKernelAbiHash !== AUTONOMOUS_ANALYSIS_KERNEL_ABI.analysisKernelAbiHash
    || typeof value?.registeredRuntimeRequired !== 'boolean'
    || typeof value?.runtimeRegistryBindingVerified !== 'boolean'
    || (requireRegisteredRuntime && value?.registeredRuntimeRequired !== true)
    || (value?.registeredRuntimeRequired === true
      && (value?.runtimeRegistryBindingVerified !== true
        || !value?.runtimeRegistryQualificationBinding
        || !SHA256.test(String(value?.runtimeRegistryQualificationBindingHash || ''))))
    || value?.runtimeFallbackAllowed !== false || value?.runtimeFallbackPerformed !== false
    || value?.callerOverrideAllowed !== false
    || JSON.stringify(value?.executionProfile) !== JSON.stringify(FAMILY_PROFILES[value.protocolFamily])
    || !Array.isArray(value?.blockers)
    || !['autonomous_empirical_execution_profile_ready', 'autonomous_empirical_execution_profile_blocked']
      .includes(value?.status)
    || (value.status === 'autonomous_empirical_execution_profile_ready'
      && (value.blockers.length !== 0
        || !SHA256.test(String(value?.runtimeCapabilityInspectionHash || ''))
        || value?.selectedRuntimeImage !== RUNTIME_PINS[value.protocolFamily
          ? FAMILY_PROFILES[value.protocolFamily].language : '']?.image
        || value?.selectedRuntimeExpectedDigest !== RUNTIME_PINS[value.protocolFamily
          ? FAMILY_PROFILES[value.protocolFamily].language : '']?.expectedDigest
        || value?.selectedRuntimeImageDigest !== value?.selectedRuntimeExpectedDigest
        || value?.selectedRuntimeExactDigestVerified !== true
        || !SHA256.test(String(value?.selectedRuntimeRegistryEntryHash || ''))
        || !SHA256.test(String(value?.selectedToolchainIdentityHash || ''))
        || !SHA256.test(String(value?.selectedEmpiricalPluginProfileHash || ''))))
    || (requireReady && value?.status !== 'autonomous_empirical_execution_profile_ready')) {
    return false;
  }
  if (runtimeCapabilityInspection !== null) {
    if (!verifyAutonomousEmpiricalRuntimeCapabilityInspection(runtimeCapabilityInspection, {
      requireRegisteredRuntime: value.registeredRuntimeRequired,
    })) {
      return false;
    }
    const expected = selectAutonomousEmpiricalExecutionProfile({
      protocolFamily: value.protocolFamily,
      runtimeCapabilityInspection,
      runtimeReproducibilityInspection,
      requireRegisteredRuntime: value.registeredRuntimeRequired,
      observedAt,
      minimumRemainingValidityMs,
    });
    if (JSON.stringify(value) !== JSON.stringify(expected)) return false;
  } else if (requireRuntimeCapabilityInspection || requireReady) {
    return false;
  }
  if (value.registeredRuntimeRequired && !verifyLanguageRuntimeRegistryQualificationBinding(
    value.runtimeRegistryQualificationBinding,
    {
      runtimeReproducibilityInspection,
      now: observedAt,
      minimumRemainingValidityMs,
    },
  )) return false;
  return true;
}
