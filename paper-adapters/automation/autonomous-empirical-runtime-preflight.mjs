import { spawnSync } from 'node:child_process';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { inspectDockerRuntimeImageManifest } from './docker-runtime-image-manifest-inspection.mjs';
import { AUTOMATION_RUNTIME_IMAGES } from './runtime-image-registry.mjs';
import {
  AUTONOMOUS_EMPIRICAL_PLUGIN_RUNTIME_LANGUAGES,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';
import {
  AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY,
  autonomousLanguageRuntimeRegistryEntryFor,
} from '../../paper-domain/automation/autonomous-language-runtime-kernel-registry.mjs';

function inspectImage(language, runtime, spawnSyncImpl) {
  const registryEntry = autonomousLanguageRuntimeRegistryEntryFor({ language });
  if (!registryEntry) {
    throw new Error(`autonomous_empirical_runtime_registry_entry_missing:${language}`);
  }
  const manifestInspection = inspectDockerRuntimeImageManifest({
    image: runtime.image,
    expectedManifestDigest: runtime.imageDigest,
    spawnSyncImpl,
  });
  const observedDigest = manifestInspection.observedManifestDigest;
  const exactDigestVerified = manifestInspection.ready;
  const trustedDatasetSupervisorConfigured = Boolean(
    runtime.datasetAccessSupervisor?.path
      && runtime.datasetAccessSupervisor?.sha256
      && runtime.datasetAccessSupervisor?.protocol,
  );
  return Object.freeze({
    language,
    runtimeType: 'container',
    image: runtime.image,
    expectedDigest: runtime.imageDigest,
    observedDigest,
    exactDigestVerified,
    datasetAccessSupervisor: Object.freeze({
      protocol: runtime.datasetAccessSupervisor?.protocol || null,
      path: runtime.datasetAccessSupervisor?.path || null,
      sha256: runtime.datasetAccessSupervisor?.sha256 || null,
      workloadUid: runtime.datasetAccessSupervisor?.workloadUid || null,
    }),
    trustedDatasetSupervisorConfigured,
    runtimeRegistryEntryHash: registryEntry.runtimeRegistryEntryHash,
    toolchainIdentityHash: registryEntry.toolchainIdentityHash,
    analysisKernelAbiHash: registryEntry.analysisKernelAbiHash,
    compatiblePluginProfileHashes: Object.freeze(
      registryEntry.allowedEmpiricalPluginProfiles.map((profile) => profile.profileHash),
    ),
    available: exactDigestVerified && trustedDatasetSupervisorConfigured
      && runtime.image === registryEntry.image
      && runtime.imageDigest === registryEntry.imageManifestDigest
      && runtime.executable === registryEntry.containerExecutable,
  });
}

export function preflightAutonomousEmpiricalRuntimes({
  spawnSyncImpl = spawnSync,
} = {}) {
  if (AUTONOMOUS_EMPIRICAL_PLUGIN_RUNTIME_LANGUAGES.length === 0) {
    throw new Error('autonomous_empirical_runtime_active_language_required');
  }
  const languages = Object.freeze(Object.fromEntries(
    AUTONOMOUS_EMPIRICAL_PLUGIN_RUNTIME_LANGUAGES.map((language) => [
      language,
      inspectImage(language, AUTOMATION_RUNTIME_IMAGES[language], spawnSyncImpl),
    ]),
  ));
  const unavailableLanguages = Object.freeze(Object.entries(languages)
    .filter(([, capability]) => !capability.available)
    .map(([language]) => language));
  const payload = {
    version: 2,
    kind: 'AutonomousEmpiricalRuntimeCapabilityInspection',
    status: unavailableLanguages.length
      ? 'autonomous_empirical_runtime_capability_partial_or_blocked'
      : 'autonomous_empirical_runtime_capability_ready',
    assuranceScope: 'registry-bound-local-pinned-container-runtime-preflight-v2',
    languageRuntimeKernelRegistryHash:
      AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY
        .autonomousLanguageRuntimeKernelRegistryHash,
    analysisKernelAbiHash:
      AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY.analysisKernelAbiHash,
    languages,
    unavailableLanguages,
    runtimeFallbackAllowed: false,
  };
  return Object.freeze({
    ...payload,
    autonomousEmpiricalRuntimeCapabilityInspectionHash:
      hashRecord('AutonomousEmpiricalRuntimeCapabilityInspection', payload),
  });
}
