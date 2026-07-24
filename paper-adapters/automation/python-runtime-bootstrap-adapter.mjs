import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { inspectPinnedRuntimeImageOciArchive } from './r-runtime-bootstrap-adapter.mjs';
import { AUTOMATION_RUNTIME_IMAGES } from './runtime-image-registry.mjs';
import {
  bootstrapPinnedRuntimeImage,
  canonicalPinnedRuntimeImageBuildArguments,
  PINNED_RUNTIME_IMAGE_BOOTSTRAP_PLATFORM as FIXED_PLATFORM,
  RUNTIME_IMAGE_BOOTSTRAP_REPOSITORY_ROOT as REPOSITORY_ROOT,
} from './runtime-image-bootstrap-engine.mjs';

const PROFILE_CONFIGURATION = Object.freeze({
  python: Object.freeze({
    archiveName: 'python-scientific.oci.tar',
    contextPath: path.join(REPOSITORY_ROOT, 'runtime-images', 'python-scientific'),
  }),
  pythonGpu: Object.freeze({
    archiveName: 'python-gpu.oci.tar',
    contextPath: path.join(REPOSITORY_ROOT, 'runtime-images', 'python-gpu'),
  }),
});

function profileConfiguration(profile) {
  const normalized = String(profile || '').trim();
  const configuration = PROFILE_CONFIGURATION[normalized];
  if (!configuration) throw new Error('python_runtime_bootstrap_profile_invalid');
  return Object.freeze({
    profile: normalized,
    runtime: AUTOMATION_RUNTIME_IMAGES[normalized],
    ...configuration,
  });
}

function translateArchiveInspectionError(error) {
  const detail = String(error?.message || 'python_runtime_bootstrap_oci_archive_invalid')
    .replace(/^r_runtime_bootstrap_/, 'python_runtime_bootstrap_');
  const translated = new Error(detail);
  translated.cause = error;
  return translated;
}

export const PYTHON_RUNTIME_BOOTSTRAP_PROFILES = Object.freeze(
  Object.keys(PROFILE_CONFIGURATION),
);

export function canonicalPythonRuntimeBuildArguments({ profile, archivePath } = {}) {
  const configuration = profileConfiguration(profile);
  return canonicalPinnedRuntimeImageBuildArguments({
    archivePath,
    runtime: configuration.runtime,
    contextPath: configuration.contextPath,
    errorPrefix: 'python_runtime_bootstrap',
  });
}

export function inspectPinnedPythonRuntimeOciArchive({
  profile,
  archivePath,
  spawnSyncImpl = spawnSync,
  environment = process.env,
} = {}) {
  const configuration = profileConfiguration(profile);
  try {
    return inspectPinnedRuntimeImageOciArchive({
      archivePath,
      runtime: configuration.runtime,
      spawnSyncImpl,
      environment,
    });
  } catch (error) {
    throw translateArchiveInspectionError(error);
  }
}

export function bootstrapPinnedPythonRuntimeImage({
  profile,
  mode,
  archivePath = null,
  spawnSyncImpl = spawnSync,
  environment = process.env,
} = {}) {
  const configuration = profileConfiguration(profile);
  return bootstrapPinnedRuntimeImage({
    mode,
    archivePath,
    spawnSyncImpl,
    environment,
    runtime: configuration.runtime,
    archiveName: configuration.archiveName,
    temporaryPrefix: `hepta-${profile}-runtime-bootstrap-`,
    buildArguments: (effectiveArchive) => canonicalPythonRuntimeBuildArguments({
      profile,
      archivePath: effectiveArchive,
    }),
    inspectArchive: ({ archivePath: effectiveArchive, ...options }) => (
      inspectPinnedPythonRuntimeOciArchive({
        ...options,
        profile,
        archivePath: effectiveArchive,
      })
    ),
    errorPrefix: 'python_runtime_bootstrap',
    receiptKind: 'PinnedPythonRuntimeImageBootstrapReceipt',
    completedStatus: 'pinned_python_runtime_image_bootstrap_completed',
    receiptHashField: 'pinnedPythonRuntimeImageBootstrapReceiptHash',
    receiptIdentity: Object.freeze({ profile }),
  });
}

export function pythonRuntimeBootstrapUsage() {
  return Object.freeze({
    version: 1,
    kind: 'PinnedPythonRuntimeImageBootstrapUsage',
    usage: 'automation:runtime-bootstrap:python -- --profile python|pythonGpu --build | --archive PATH',
    behavior: 'Builds a canonical OCI archive or imports an existing archive, validates the registered OCI manifest digest before docker load, then reruns local pinned-manifest inspection.',
    profiles: Object.freeze(PYTHON_RUNTIME_BOOTSTRAP_PROFILES.map((profile) => Object.freeze({
      profile,
      image: AUTOMATION_RUNTIME_IMAGES[profile].image,
      fixedManifestDigest: AUTOMATION_RUNTIME_IMAGES[profile].imageDigest,
    }))),
    fixedPlatform: FIXED_PLATFORM,
    runtimeFallbackAllowed: false,
  });
}

export function blockedPythonRuntimeBootstrapReceipt(error, profile = null) {
  const configuration = PROFILE_CONFIGURATION[String(profile || '')]
    ? profileConfiguration(profile) : null;
  return Object.freeze({
    version: 1,
    kind: 'PinnedPythonRuntimeImageBootstrapReceipt',
    status: 'pinned_python_runtime_image_bootstrap_blocked',
    profile: configuration?.profile || null,
    expectedManifestDigest: configuration?.runtime.imageDigest || null,
    runtimeFallbackAllowed: false,
    blockers: Object.freeze([
      String(error?.message || 'python_runtime_bootstrap_failed').slice(0, 2_000),
    ]),
  });
}
