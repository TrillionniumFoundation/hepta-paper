import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_ABI,
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PACKAGE,
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PRODUCTION_PROFILES,
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY,
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION,
  AUTONOMOUS_EMPIRICAL_PLUGIN_RUNTIME_LANGUAGES,
} from './autonomous-empirical-family-plugin-registry.mjs';
import {
  RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE,
  RUNTIME_IMAGE_REPRODUCIBILITY_MAXIMUM_AGE_MS,
} from './runtime-image-reproducibility-receipt-contract.mjs';
import {
  SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES,
} from './dataset-access-supervisor-policy.mjs';
import {
  SYSTEM_BENCHMARK_EVALUATOR_REGISTRY,
} from './system-benchmark-evaluator-abi.mjs';
import {
  SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION,
} from './system-benchmark-harness-identity.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ENTRY_KEYS = Object.freeze([
  'allowedEmpiricalPluginAbiHash', 'allowedEmpiricalPluginPackageHash',
  'allowedEmpiricalPluginProfiles', 'allowedEmpiricalPluginRegistryHash',
  'analysisKernelAbiHash', 'containerExecutable', 'image', 'imageManifestDigest',
  'kind', 'language', 'requiresGpu', 'runtimeFallbackAllowed', 'runtimeProfile',
  'runtimeRegistryEntryHash', 'runtimeType', 'toolchain', 'toolchainIdentityHash',
  'version',
]);
const PLUGIN_COMPATIBILITY_KEYS = Object.freeze([
  'benchmarkFamily', 'evaluatorDescriptorHash', 'executionAdapterId', 'profileHash',
  'profileId', 'requiresGpu',
]);
const TOOLCHAIN_KEYS = Object.freeze([
  'implementation', 'identityAuthority', 'language', 'version',
]);
const ABI_KEYS = Object.freeze([
  'analysisKernelAbiHash', 'analysisProtocolContractVersions',
  'deterministicEvaluatorRegistryRequired', 'empiricalPluginAbiHash',
  'evaluatorRegistryHash', 'harnessImplementationHash', 'kind',
  'runtimeRegistryMutationAllowed', 'scope', 'version',
]);
const REGISTRY_KEYS = Object.freeze([
  'activePluginScopeHash', 'analysisKernelAbi', 'analysisKernelAbiHash', 'entries',
  'fallbackRuntimeAllowed', 'kind', 'languages', 'pluginPackageHash',
  'pluginRegistryHash', 'pluginStartupInspectionHash', 'registrySchema', 'scope', 'status',
  'formalAndManuscriptRuntimesCovered',
  'unregisteredKernelAbiAllowed', 'unregisteredLanguageAllowed',
  'unregisteredRuntimeAllowed', 'version', 'autonomousLanguageRuntimeKernelRegistryHash',
]);

const TOOLCHAINS = Object.freeze({
  python: Object.freeze({
    language: 'python',
    implementation: 'cpython',
    version: '3.12.7',
    identityAuthority: 'content-addressed-container-image-manifest-v1',
  }),
  r: Object.freeze({
    language: 'r',
    implementation: 'gnu-r',
    version: '4.4.2',
    identityAuthority: 'content-addressed-container-image-manifest-v1',
  }),
});

function denseArray(value, minimum = 1, maximum = 256) {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
    && value.length >= minimum && value.length <= maximum
    && Object.keys(value).length === value.length;
}

function canonicalProfileCompatibility(profile) {
  return Object.freeze({
    profileId: profile.profileId,
    benchmarkFamily: profile.benchmarkFamily,
    profileHash: profile.autonomousEmpiricalFamilyPluginProfileHash,
    executionAdapterId: profile.executionAdapterId,
    evaluatorDescriptorHash: profile.evaluatorDescriptorHash,
    requiresGpu: profile.executionProfile.requiresGpu,
  });
}

const ANALYSIS_KERNEL_ABI_PAYLOAD = Object.freeze({
  version: 1,
  kind: 'AutonomousAnalysisKernelAbi',
  scope: 'empirical-analysis-python-r-only-v1',
  analysisProtocolContractVersions: Object.freeze([2]),
  evaluatorRegistryHash:
    SYSTEM_BENCHMARK_EVALUATOR_REGISTRY.systemBenchmarkEvaluatorRegistryHash,
  harnessImplementationHash:
    SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION.systemBenchmarkHarnessImplementationHash,
  empiricalPluginAbiHash:
    AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_ABI.autonomousEmpiricalFamilyPluginAbiHash,
  deterministicEvaluatorRegistryRequired: true,
  runtimeRegistryMutationAllowed: false,
});

export const AUTONOMOUS_ANALYSIS_KERNEL_ABI = Object.freeze({
  ...ANALYSIS_KERNEL_ABI_PAYLOAD,
  analysisKernelAbiHash: hashRecord(
    'AutonomousAnalysisKernelAbi',
    ANALYSIS_KERNEL_ABI_PAYLOAD,
  ),
});

function verifyAnalysisKernelAbi(value) {
  if (!hasExactObjectKeys(value, ABI_KEYS)
    || value.version !== 1 || value.kind !== 'AutonomousAnalysisKernelAbi'
    || !denseArray(value.analysisProtocolContractVersions)
    || value.analysisProtocolContractVersions.some((version) => version !== 2)
    || !SHA256.test(String(value.analysisKernelAbiHash || ''))) return false;
  const { analysisKernelAbiHash, ...payload } = value;
  return hashRecord('AutonomousAnalysisKernelAbi', payload) === analysisKernelAbiHash
    && JSON.stringify(value) === JSON.stringify(AUTONOMOUS_ANALYSIS_KERNEL_ABI);
}

function runtimeEntry(language) {
  const runtime = SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES[language];
  const toolchain = TOOLCHAINS[language];
  const compatibleProfiles = AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PRODUCTION_PROFILES
    .filter((profile) => profile.executionProfile.language === language)
    .map(canonicalProfileCompatibility)
    .sort((left, right) => left.benchmarkFamily.localeCompare(right.benchmarkFamily));
  if (!runtime || !toolchain || compatibleProfiles.length === 0) {
    throw new Error(`autonomous_language_runtime_registry_entry_missing:${language}`);
  }
  const toolchainIdentityHash = hashRecord('AutonomousRuntimeToolchainIdentity', {
    ...toolchain,
    imageManifestDigest: runtime.imageDigest,
    containerExecutable: runtime.containerExecutable,
  });
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousLanguageRuntimeRegistryEntry',
    language,
    runtimeProfile: `${language}-scientific-container-v1`,
    runtimeType: 'container',
    image: runtime.image,
    imageManifestDigest: runtime.imageDigest,
    containerExecutable: runtime.containerExecutable,
    toolchain,
    toolchainIdentityHash,
    analysisKernelAbiHash: AUTONOMOUS_ANALYSIS_KERNEL_ABI.analysisKernelAbiHash,
    allowedEmpiricalPluginAbiHash:
      AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_ABI.autonomousEmpiricalFamilyPluginAbiHash,
    allowedEmpiricalPluginPackageHash:
      AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PACKAGE
        .autonomousEmpiricalFamilyPluginPackageHash,
    allowedEmpiricalPluginRegistryHash:
      AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY
        .autonomousEmpiricalFamilyPluginRegistryHash,
    allowedEmpiricalPluginProfiles: Object.freeze(compatibleProfiles),
    requiresGpu: false,
    runtimeFallbackAllowed: false,
  });
  return Object.freeze({
    ...payload,
    runtimeRegistryEntryHash: hashRecord(
      'AutonomousLanguageRuntimeRegistryEntry',
      payload,
    ),
  });
}

function buildRegistry() {
  const languages = Object.freeze([...AUTONOMOUS_EMPIRICAL_PLUGIN_RUNTIME_LANGUAGES]);
  const entries = Object.freeze(languages.map(runtimeEntry));
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousLanguageRuntimeKernelRegistry',
    status: 'autonomous_language_runtime_kernel_registry_ready',
    registrySchema: 'hepta-language-runtime-analysis-kernel-v1',
    scope: 'empirical-analysis-python-r-only-v1',
    formalAndManuscriptRuntimesCovered: false,
    languages,
    entries,
    analysisKernelAbi: AUTONOMOUS_ANALYSIS_KERNEL_ABI,
    analysisKernelAbiHash: AUTONOMOUS_ANALYSIS_KERNEL_ABI.analysisKernelAbiHash,
    pluginPackageHash:
      AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PACKAGE
        .autonomousEmpiricalFamilyPluginPackageHash,
    pluginRegistryHash:
      AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY
        .autonomousEmpiricalFamilyPluginRegistryHash,
    pluginStartupInspectionHash:
      AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION
        .autonomousEmpiricalFamilyPluginStartupInspectionHash,
    activePluginScopeHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .runtimeImageReproducibilityActivePluginScopeHash,
    unregisteredLanguageAllowed: false,
    unregisteredRuntimeAllowed: false,
    unregisteredKernelAbiAllowed: false,
    fallbackRuntimeAllowed: false,
  });
  return Object.freeze({
    ...payload,
    autonomousLanguageRuntimeKernelRegistryHash: hashRecord(
      'AutonomousLanguageRuntimeKernelRegistry',
      payload,
    ),
  });
}

export const AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY = buildRegistry();

function pluginCompatibilityValid(value, entry) {
  return hasExactObjectKeys(value, PLUGIN_COMPATIBILITY_KEYS)
    && typeof value.profileId === 'string'
    && typeof value.benchmarkFamily === 'string'
    && SHA256.test(String(value.profileHash || ''))
    && SHA256.test(String(value.evaluatorDescriptorHash || ''))
    && typeof value.executionAdapterId === 'string'
    && typeof value.requiresGpu === 'boolean'
    && entry.allowedEmpiricalPluginProfiles.some((candidate) => (
      JSON.stringify(candidate) === JSON.stringify(value)
    ));
}

function registryEntryValid(entry) {
  if (!hasExactObjectKeys(entry, ENTRY_KEYS)
    || entry.version !== 1 || entry.kind !== 'AutonomousLanguageRuntimeRegistryEntry'
    || !hasExactObjectKeys(entry.toolchain, TOOLCHAIN_KEYS)
    || entry.toolchain.language !== entry.language
    || !denseArray(entry.allowedEmpiricalPluginProfiles)
    || entry.allowedEmpiricalPluginProfiles.some((profile) => (
      !pluginCompatibilityValid(profile, entry)
    ))
    || entry.runtimeFallbackAllowed !== false
    || entry.requiresGpu !== false
    || !SHA256.test(String(entry.runtimeRegistryEntryHash || ''))) return false;
  const { runtimeRegistryEntryHash, ...payload } = entry;
  return hashRecord('AutonomousLanguageRuntimeRegistryEntry', payload)
    === runtimeRegistryEntryHash;
}

export function verifyAutonomousLanguageRuntimeKernelRegistry(value) {
  if (!hasExactObjectKeys(value, REGISTRY_KEYS)
    || value?.version !== 1 || value?.kind !== 'AutonomousLanguageRuntimeKernelRegistry'
    || value?.status !== 'autonomous_language_runtime_kernel_registry_ready'
    || !denseArray(value?.languages) || !denseArray(value?.entries)
    || value.entries.some((entry) => !registryEntryValid(entry))
    || !verifyAnalysisKernelAbi(value.analysisKernelAbi)
    || value.analysisKernelAbiHash !== value.analysisKernelAbi.analysisKernelAbiHash
    || !SHA256.test(String(value.autonomousLanguageRuntimeKernelRegistryHash || ''))) {
    return false;
  }
  const { autonomousLanguageRuntimeKernelRegistryHash, ...payload } = value;
  return hashRecord('AutonomousLanguageRuntimeKernelRegistry', payload)
      === autonomousLanguageRuntimeKernelRegistryHash
    && JSON.stringify(value) === JSON.stringify(AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY);
}

export function autonomousLanguageRuntimeRegistryEntryFor({
  language,
  benchmarkFamily = null,
} = {}) {
  if (!verifyAutonomousLanguageRuntimeKernelRegistry(
    AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY,
  )) return null;
  const entry = AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY.entries
    .find((candidate) => candidate.language === String(language || '').toLowerCase()) || null;
  if (!entry || (benchmarkFamily && !entry.allowedEmpiricalPluginProfiles
    .some((profile) => profile.benchmarkFamily === benchmarkFamily))) return null;
  return entry;
}

export function autonomousEmpiricalPluginCompatibilityFor({
  language,
  benchmarkFamily,
} = {}) {
  const entry = autonomousLanguageRuntimeRegistryEntryFor({ language, benchmarkFamily });
  return entry?.allowedEmpiricalPluginProfiles
    .find((profile) => profile.benchmarkFamily === benchmarkFamily) || null;
}

export function verifyRuntimeReproducibilityInspectionForLanguageRuntimeRegistry(
  inspection,
  { now = null, minimumRemainingValidityMs = 0 } = {},
) {
  const minimumValidity = Number(minimumRemainingValidityMs);
  if (inspection?.version !== 2
    || inspection?.kind !== 'RuntimeImageReproducibilityReceiptInspection'
    || inspection?.status !== 'runtime_image_reproducibility_verified'
    || inspection?.ready !== true || inspection?.receiptAccepted !== true
    || !SHA256.test(String(inspection?.receiptHash || ''))
    || !Array.isArray(inspection?.blockers) || inspection.blockers.length !== 0
    || JSON.stringify(inspection.requiredProfiles)
      !== JSON.stringify(RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE.requiredProfiles)
    || inspection.empiricalFamilyPluginPackageHash
      !== AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY.pluginPackageHash
    || inspection.empiricalFamilyPluginRegistryHash
      !== AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY.pluginRegistryHash
    || inspection.empiricalFamilyPluginStartupInspectionHash
      !== AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY.pluginStartupInspectionHash
    || inspection.runtimeImageReproducibilityActivePluginScopeHash
      !== AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY.activePluginScopeHash
    || JSON.stringify(inspection.activeProductionProfileHashes)
      !== JSON.stringify(RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .activeProductionProfileHashes)
    || inspection.privateSigningKeyLoadedByController !== false
    || inspection.twoIndependentExternalVerifiersRequired !== true
    || inspection.ociIndexManifestConfigAndLayerBlobDigestsCompared !== true
    || inspection.canonicalContextTarMetadataPolicyRequired !== true
    || inspection.canonicalContextTarMetadataAttested !== true
    || !Number.isFinite(minimumValidity) || minimumValidity < 0
    || !inspection.registeredImageDigests || !inspection.definitionManifestHashes
    || !inspection.inputClosureHashes) return false;
  for (const entry of AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY.entries) {
    if (inspection.registeredImageDigests[entry.language] !== entry.imageManifestDigest
      || !SHA256.test(String(inspection.definitionManifestHashes[entry.language] || ''))
      || !SHA256.test(String(inspection.inputClosureHashes[entry.language] || ''))) return false;
  }
  const issuedAt = Date.parse(String(inspection.issuedAt || ''));
  const expiresAt = Date.parse(String(inspection.expiresAt || ''));
  const observedAt = now instanceof Date ? now.getTime() : Date.parse(String(now || ''));
  return Number.isFinite(issuedAt)
    && Number.isFinite(expiresAt)
    && Number.isFinite(observedAt)
    && new Date(issuedAt).toISOString() === inspection.issuedAt
    && new Date(expiresAt).toISOString() === inspection.expiresAt
    && expiresAt > issuedAt
    && expiresAt - issuedAt <= RUNTIME_IMAGE_REPRODUCIBILITY_MAXIMUM_AGE_MS
    && observedAt >= issuedAt
    && expiresAt - observedAt > minimumValidity;
}

export function buildLanguageRuntimeRegistryQualificationBinding({
  runtimeReproducibilityInspection,
  now = null,
  minimumRemainingValidityMs = 0,
} = {}) {
  if (!verifyRuntimeReproducibilityInspectionForLanguageRuntimeRegistry(
    runtimeReproducibilityInspection,
    { now, minimumRemainingValidityMs },
  )) throw new Error('autonomous_runtime_registry_reproducibility_qualification_invalid');
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousLanguageRuntimeRegistryQualificationBinding',
    status: 'autonomous_language_runtime_registry_qualified',
    registryHash:
      AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY
        .autonomousLanguageRuntimeKernelRegistryHash,
    analysisKernelAbiHash: AUTONOMOUS_ANALYSIS_KERNEL_ABI.analysisKernelAbiHash,
    runtimeReproducibilityReceiptHash: runtimeReproducibilityInspection.receiptHash,
    runtimeReproducibilityExpiresAt: runtimeReproducibilityInspection.expiresAt,
    qualificationScope: 'empirical-analysis-python-r-only-v1',
    activePluginScopeHash:
      runtimeReproducibilityInspection.runtimeImageReproducibilityActivePluginScopeHash,
    registeredImageDigests: Object.freeze(Object.fromEntries(
      AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY.entries.map((entry) => [
        entry.language,
        runtimeReproducibilityInspection.registeredImageDigests[entry.language],
      ]),
    )),
    runtimeRegistryDeclarationTreatedAsQualification: false,
    externalReproducibilityReceiptRequired: true,
  });
  return Object.freeze({
    ...payload,
    autonomousLanguageRuntimeRegistryQualificationBindingHash: hashRecord(
      'AutonomousLanguageRuntimeRegistryQualificationBinding',
      payload,
    ),
  });
}

export function verifyLanguageRuntimeRegistryQualificationBinding(
  binding,
  { runtimeReproducibilityInspection, now = null, minimumRemainingValidityMs = 0 } = {},
) {
  if (!binding || !runtimeReproducibilityInspection) return false;
  try {
    return JSON.stringify(binding) === JSON.stringify(
      buildLanguageRuntimeRegistryQualificationBinding({
        runtimeReproducibilityInspection,
        now,
        minimumRemainingValidityMs,
      }),
    );
  } catch { return false; }
}
