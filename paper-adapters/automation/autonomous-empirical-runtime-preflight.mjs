import { spawnSync } from 'node:child_process';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { inspectDockerRuntimeImageManifest } from './docker-runtime-image-manifest-inspection.mjs';
import { AUTOMATION_RUNTIME_IMAGES } from './runtime-image-registry.mjs';

function inspectImage(runtime, spawnSyncImpl) {
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
    language: runtime === AUTOMATION_RUNTIME_IMAGES.r ? 'r' : 'python',
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
    available: exactDigestVerified && trustedDatasetSupervisorConfigured,
  });
}

export function preflightAutonomousEmpiricalRuntimes({
  spawnSyncImpl = spawnSync,
} = {}) {
  const languages = Object.freeze({
    python: inspectImage(AUTOMATION_RUNTIME_IMAGES.python, spawnSyncImpl),
    r: inspectImage(AUTOMATION_RUNTIME_IMAGES.r, spawnSyncImpl),
  });
  const unavailableLanguages = Object.freeze(Object.entries(languages)
    .filter(([, capability]) => !capability.available)
    .map(([language]) => language));
  const payload = {
    version: 1,
    kind: 'AutonomousEmpiricalRuntimeCapabilityInspection',
    status: unavailableLanguages.length
      ? 'autonomous_empirical_runtime_capability_partial_or_blocked'
      : 'autonomous_empirical_runtime_capability_ready',
    assuranceScope: 'local-pinned-container-runtime-preflight-v1',
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
