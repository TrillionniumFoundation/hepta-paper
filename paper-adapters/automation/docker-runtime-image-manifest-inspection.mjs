import { spawnSync } from 'node:child_process';
import { restrictedChildEnvironment } from './bounded-child-process.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SUPPORTED_MANIFEST_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.manifest.v1+json',
]);
const LOCAL_DOCKER_HOST = 'unix:///var/run/docker.sock';

function normalizeDigest(value) {
  const digest = String(value || '').trim().toLowerCase();
  return SHA256.test(digest) ? digest : null;
}

function parsePlatform(value) {
  const [os, architecture, ...remainder] = String(value || '').split('/');
  return os && architecture && remainder.length === 0
    ? Object.freeze({ os, architecture }) : null;
}

export function inspectDockerRuntimeImageManifest({
  image,
  expectedManifestDigest,
  expectedPlatform = 'linux/amd64',
  dockerExecutable = 'docker',
  spawnSyncImpl = spawnSync,
  timeoutMs = 10_000,
  environment = process.env,
} = {}) {
  const expectedDigest = normalizeDigest(expectedManifestDigest);
  const platform = parsePlatform(expectedPlatform);
  const dockerContextConfigured = Boolean(environment?.DOCKER_CONTEXT);
  const configuredDockerHost = String(environment?.DOCKER_HOST || '');
  const dockerHostLocal = !configuredDockerHost
    || configuredDockerHost === LOCAL_DOCKER_HOST;
  const endpointPermitted = !dockerContextConfigured && dockerHostLocal;
  const childEnvironment = restrictedChildEnvironment({
    source: environment,
    overrides: { DOCKER_HOST: LOCAL_DOCKER_HOST },
  });
  let probe = null;
  if (endpointPermitted) try {
    probe = spawnSyncImpl(
      dockerExecutable,
      ['image', 'inspect', String(image || '')],
      {
        encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024,
        env: { ...childEnvironment },
      },
    );
  } catch { probe = null; }

  let document = null;
  try {
    const parsed = JSON.parse(String(probe?.stdout || ''));
    document = Array.isArray(parsed) && parsed.length === 1
      && parsed[0] && typeof parsed[0] === 'object' && !Array.isArray(parsed[0])
      ? parsed[0] : null;
  } catch { document = null; }

  const observedManifestDigest = normalizeDigest(document?.Descriptor?.digest);
  const observedLegacyId = normalizeDigest(document?.Id);
  const descriptorMediaType = typeof document?.Descriptor?.mediaType === 'string'
    ? document.Descriptor.mediaType : null;
  const observedPlatform = document && typeof document.Os === 'string'
    && typeof document.Architecture === 'string'
    ? `${document.Os}/${document.Architecture}` : null;
  const present = probe?.status === 0 && document !== null;
  const descriptorDigestVerified = present && expectedDigest !== null
    && observedManifestDigest === expectedDigest;
  const descriptorMediaTypeVerified = present
    && SUPPORTED_MANIFEST_MEDIA_TYPES.has(descriptorMediaType);
  const platformVerified = present && platform !== null
    && document.Os === platform.os && document.Architecture === platform.architecture;
  const ready = descriptorDigestVerified && descriptorMediaTypeVerified && platformVerified;
  const blockers = [];
  if (!String(image || '').trim() || !expectedDigest || !platform) {
    blockers.push('docker_runtime_image_manifest_expectation_invalid');
  }
  if (!endpointPermitted) blockers.push('docker_runtime_image_remote_endpoint_forbidden');
  if (!present) blockers.push('docker_runtime_image_manifest_inspection_failed');
  else {
    if (!observedManifestDigest) blockers.push('docker_runtime_image_descriptor_digest_missing');
    else if (!descriptorDigestVerified) blockers.push('docker_runtime_image_manifest_digest_mismatch');
    if (!descriptorMediaTypeVerified) blockers.push('docker_runtime_image_manifest_media_type_invalid');
    if (!platformVerified) blockers.push('docker_runtime_image_platform_mismatch');
  }

  return Object.freeze({
    version: 1,
    kind: 'DockerRuntimeImageManifestInspection',
    endpointLocality: Object.freeze({
      configuredHostPresent: Boolean(configuredDockerHost),
      contextConfigured: dockerContextConfigured,
      effectiveHostKind: 'local_unix_socket',
      local: endpointPermitted,
      remote: !endpointPermitted,
    }),
    processActionAttempted: endpointPermitted,
    daemonActionAttempted: endpointPermitted,
    containerActionAttempted: false,
    image: String(image || ''),
    expectedManifestDigest: expectedDigest,
    observedManifestDigest,
    observedLegacyId,
    descriptorMediaType,
    expectedPlatform: platform ? `${platform.os}/${platform.architecture}` : null,
    observedPlatform,
    present,
    descriptorDigestVerified,
    descriptorMediaTypeVerified,
    platformVerified,
    ready,
    legacyImageIdAcceptedAsManifestIdentity: false,
    blockers: Object.freeze([...new Set(blockers)].sort()),
  });
}

export const DOCKER_RUNTIME_IMAGE_MANIFEST_MEDIA_TYPES = Object.freeze(
  [...SUPPORTED_MANIFEST_MEDIA_TYPES].sort(),
);
