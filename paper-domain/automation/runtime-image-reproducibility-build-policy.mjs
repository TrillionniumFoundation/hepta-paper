export const RUNTIME_IMAGE_REPRODUCIBILITY_CANONICAL_BUILD = Object.freeze({
  platform: 'linux/amd64',
  sourceDateEpoch: 1733097600,
  buildArgs: Object.freeze({}),
  dockerfileFrontend:
    'docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e',
});

const CANONICAL_CONTEXT_TAR_METADATA_POLICY = Object.freeze({
  version: 1,
  kind: 'RuntimeImageCanonicalContextTarMetadataPolicy',
  archiveFormat: 'posix-ustar',
  entryOrder: 'lexicographic-path',
  uid: 0,
  gid: 0,
  uname: '',
  gname: '',
  mtime: RUNTIME_IMAGE_REPRODUCIBILITY_CANONICAL_BUILD.sourceDateEpoch,
  xattrsIncluded: false,
  deviceEntriesIncluded: false,
});

export function runtimeImageReproducibilityCanonicalContextTarMetadataPolicy({
  sourceDateEpoch,
} = {}) {
  if (sourceDateEpoch !== RUNTIME_IMAGE_REPRODUCIBILITY_CANONICAL_BUILD.sourceDateEpoch) {
    throw new Error('runtime_reproducibility_context_tar_metadata_policy_drift');
  }
  return CANONICAL_CONTEXT_TAR_METADATA_POLICY;
}

export function matchesRuntimeImageReproducibilityCanonicalContextTarMetadataPolicy(
  value,
) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join('\0')
      === Object.keys(CANONICAL_CONTEXT_TAR_METADATA_POLICY).sort().join('\0')
    && Object.entries(CANONICAL_CONTEXT_TAR_METADATA_POLICY)
      .every(([key, expected]) => value[key] === expected);
}

export function matchesRuntimeImageReproducibilityDockerfileFrontend(value) {
  return value === RUNTIME_IMAGE_REPRODUCIBILITY_CANONICAL_BUILD.dockerfileFrontend;
}

export function matchesRuntimeImageReproducibilityCanonicalBuild({
  platform,
  sourceDateEpoch,
  buildArgs,
} = {}) {
  return platform === RUNTIME_IMAGE_REPRODUCIBILITY_CANONICAL_BUILD.platform
    && sourceDateEpoch === RUNTIME_IMAGE_REPRODUCIBILITY_CANONICAL_BUILD.sourceDateEpoch
    && buildArgs && typeof buildArgs === 'object' && !Array.isArray(buildArgs)
    && Object.getPrototypeOf(buildArgs) === Object.prototype
    && Object.keys(buildArgs).length === 0;
}
