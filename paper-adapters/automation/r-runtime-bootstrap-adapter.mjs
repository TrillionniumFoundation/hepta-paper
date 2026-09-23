import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { AUTOMATION_RUNTIME_IMAGES } from './runtime-image-registry.mjs';
import {
  bootstrapPinnedRuntimeImage,
  canonicalPinnedRuntimeImageBuildArguments,
  executeRuntimeImageBootstrapCommand,
  PINNED_RUNTIME_IMAGE_BOOTSTRAP_PLATFORM as FIXED_PLATFORM,
  resolveLocalRuntimeImageBootstrapEnvironment,
  RUNTIME_IMAGE_BOOTSTRAP_REPOSITORY_ROOT as REPOSITORY_ROOT,
} from './runtime-image-bootstrap-engine.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const OCI_CONFIG = 'application/vnd.oci.image.config.v1+json';
const OCI_LAYER_PREFIX = 'application/vnd.oci.image.layer.v1.tar';
const R_CONTEXT = path.join(REPOSITORY_ROOT, 'runtime-images', 'r-scientific');

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function readArchiveEntry({ archivePath, entry, spawnSyncImpl, environment }) {
  return executeRuntimeImageBootstrapCommand({
    executable: 'tar',
    args: ['-xOf', archivePath, entry],
    spawnSyncImpl,
    environment,
    timeoutMs: 30_000,
    maximumBytes: 16 * 1024 * 1024,
    errorPrefix: 'r_runtime_bootstrap',
  });
}

function exactObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(bytes, blocker) {
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!exactObject(parsed)) throw new Error(blocker);
    return parsed;
  } catch {
    throw new Error(blocker);
  }
}

function runtimeTag(image) {
  const separator = image.lastIndexOf(':');
  if (separator <= image.lastIndexOf('/')) throw new Error('r_runtime_bootstrap_image_tag_required');
  return image.slice(separator + 1);
}

export function canonicalRRuntimeBuildArguments({ archivePath } = {}) {
  return canonicalPinnedRuntimeImageBuildArguments({
    archivePath,
    runtime: AUTOMATION_RUNTIME_IMAGES.r,
    contextPath: R_CONTEXT,
    errorPrefix: 'r_runtime_bootstrap',
  });
}

export function inspectPinnedRuntimeImageOciArchive({
  archivePath,
  runtime = AUTOMATION_RUNTIME_IMAGES.r,
  spawnSyncImpl = spawnSync,
  environment = process.env,
} = {}) {
  const resolvedArchive = path.resolve(String(archivePath || ''));
  const archiveStat = fs.lstatSync(resolvedArchive, { throwIfNoEntry: false });
  if (!archiveStat?.isFile() || archiveStat.isSymbolicLink()) {
    throw new Error('r_runtime_bootstrap_oci_archive_regular_file_required');
  }
  if (!SHA256.test(String(runtime?.imageDigest || '')) || !String(runtime?.image || '')) {
    throw new Error('r_runtime_bootstrap_registered_runtime_invalid');
  }
  const childEnvironment = resolveLocalRuntimeImageBootstrapEnvironment({
    environment,
    errorPrefix: 'r_runtime_bootstrap',
  });
  const indexBytes = readArchiveEntry({
    archivePath: resolvedArchive,
    entry: 'index.json',
    spawnSyncImpl,
    environment: childEnvironment,
  });
  const index = parseJson(indexBytes, 'r_runtime_bootstrap_oci_index_invalid');
  if (index.schemaVersion !== 2 || index.mediaType !== OCI_INDEX
    || !Array.isArray(index.manifests) || index.manifests.length !== 1) {
    throw new Error('r_runtime_bootstrap_oci_index_invalid');
  }
  const [descriptor] = index.manifests;
  const descriptorDigest = String(descriptor?.digest || '').toLowerCase();
  if (!exactObject(descriptor) || descriptor.mediaType !== OCI_MANIFEST
    || descriptorDigest !== runtime.imageDigest
    || descriptor?.platform?.os !== 'linux' || descriptor?.platform?.architecture !== 'amd64'
    || descriptor?.annotations?.['org.opencontainers.image.ref.name'] !== runtimeTag(runtime.image)) {
    throw new Error('r_runtime_bootstrap_registered_manifest_not_present');
  }
  const manifestBytes = readArchiveEntry({
    archivePath: resolvedArchive,
    entry: `blobs/sha256/${descriptorDigest.slice('sha256:'.length)}`,
    spawnSyncImpl,
    environment: childEnvironment,
  });
  if (sha256(manifestBytes) !== descriptorDigest || descriptor.size !== manifestBytes.length) {
    throw new Error('r_runtime_bootstrap_manifest_content_identity_mismatch');
  }
  const manifest = parseJson(manifestBytes, 'r_runtime_bootstrap_oci_manifest_invalid');
  if (manifest.schemaVersion !== 2 || manifest.mediaType !== OCI_MANIFEST
    || manifest?.config?.mediaType !== OCI_CONFIG
    || !SHA256.test(String(manifest?.config?.digest || ''))
    || !Number.isSafeInteger(manifest?.config?.size) || manifest.config.size <= 0
    || !Array.isArray(manifest.layers) || manifest.layers.length === 0
    || manifest.layers.some((layer) => !String(layer?.mediaType || '').startsWith(OCI_LAYER_PREFIX)
      || !SHA256.test(String(layer?.digest || ''))
      || !Number.isSafeInteger(layer?.size) || layer.size <= 0)) {
    throw new Error('r_runtime_bootstrap_oci_manifest_invalid');
  }
  return Object.freeze({
    archivePath: resolvedArchive,
    image: runtime.image,
    registeredManifestDigest: runtime.imageDigest,
    observedManifestDigest: descriptorDigest,
    descriptorMediaType: descriptor.mediaType,
    platform: FIXED_PLATFORM,
    archiveBytes: archiveStat.size,
    readyToLoad: true,
  });
}

export function inspectPinnedRRuntimeOciArchive(options = {}) {
  return inspectPinnedRuntimeImageOciArchive(options);
}

export function bootstrapPinnedRRuntimeImage({
  mode,
  archivePath = null,
  spawnSyncImpl = spawnSync,
  environment = process.env,
} = {}) {
  return bootstrapPinnedRuntimeImage({
    mode,
    archivePath,
    spawnSyncImpl,
    environment,
    runtime: AUTOMATION_RUNTIME_IMAGES.r,
    archiveName: 'r-scientific.oci.tar',
    temporaryPrefix: 'hepta-r-runtime-bootstrap-',
    buildArguments: (effectiveArchive) => canonicalRRuntimeBuildArguments({
      archivePath: effectiveArchive,
    }),
    inspectArchive: inspectPinnedRRuntimeOciArchive,
    errorPrefix: 'r_runtime_bootstrap',
    receiptKind: 'PinnedRRuntimeImageBootstrapReceipt',
    completedStatus: 'pinned_r_runtime_image_bootstrap_completed',
    receiptHashField: 'pinnedRRuntimeImageBootstrapReceiptHash',
  });
}

export function rRuntimeBootstrapUsage() {
  return Object.freeze({
    version: 1,
    kind: 'PinnedRRuntimeImageBootstrapUsage',
    usage: 'automation:runtime-bootstrap:r -- --build | --archive PATH',
    behavior: 'Builds the canonical OCI archive or imports an existing archive, validates the registered OCI manifest digest before docker load, then reruns local pinned-manifest inspection.',
    fixedImage: AUTOMATION_RUNTIME_IMAGES.r.image,
    fixedManifestDigest: AUTOMATION_RUNTIME_IMAGES.r.imageDigest,
    fixedPlatform: FIXED_PLATFORM,
    runtimeFallbackAllowed: false,
  });
}

export function blockedRRuntimeBootstrapReceipt(error) {
  return Object.freeze({
    version: 1,
    kind: 'PinnedRRuntimeImageBootstrapReceipt',
    status: 'pinned_r_runtime_image_bootstrap_blocked',
    expectedManifestDigest: AUTOMATION_RUNTIME_IMAGES.r.imageDigest,
    runtimeFallbackAllowed: false,
    blockers: Object.freeze([
      String(error?.message || 'r_runtime_bootstrap_failed').slice(0, 2_000),
    ]),
  });
}
