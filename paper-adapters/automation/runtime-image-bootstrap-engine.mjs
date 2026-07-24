import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { restrictedChildEnvironment } from './bounded-child-process.mjs';
import {
  inspectDockerRuntimeImageManifest,
} from './docker-runtime-image-manifest-inspection.mjs';

export const PINNED_RUNTIME_IMAGE_BOOTSTRAP_PLATFORM = 'linux/amd64';
export const PINNED_RUNTIME_IMAGE_BOOTSTRAP_SOURCE_DATE_EPOCH = '1733097600';
export const RUNTIME_IMAGE_BOOTSTRAP_REPOSITORY_ROOT = fileURLToPath(
  new URL('../../', import.meta.url),
);

const LOCAL_DOCKER_HOST = 'unix:///var/run/docker.sock';

export function executeRuntimeImageBootstrapCommand({
  executable,
  args,
  spawnSyncImpl,
  environment,
  timeoutMs,
  errorPrefix,
  maximumBytes = 64 * 1024 * 1024,
} = {}) {
  const result = spawnSyncImpl(executable, args, {
    cwd: RUNTIME_IMAGE_BOOTSTRAP_REPOSITORY_ROOT,
    encoding: null,
    timeout: timeoutMs,
    maxBuffer: maximumBytes,
    env: { ...environment },
  });
  if (result?.status !== 0 || result?.error || result?.signal) {
    const detail = Buffer.from(
      result?.stderr || result?.error?.message || result?.signal || '',
    ).toString('utf8').slice(-2_000).replaceAll(/\s+/g, ' ').trim();
    throw new Error(`${errorPrefix}_command_failed:${executable}:${args[0]}:${detail}`);
  }
  return Buffer.from(result.stdout || '');
}

export function resolveLocalRuntimeImageBootstrapEnvironment({
  environment,
  errorPrefix,
} = {}) {
  if (environment?.DOCKER_CONTEXT
    || (environment?.DOCKER_HOST && environment.DOCKER_HOST !== LOCAL_DOCKER_HOST)) {
    throw new Error(`${errorPrefix}_remote_docker_endpoint_forbidden`);
  }
  return restrictedChildEnvironment({
    source: environment,
    overrides: { DOCKER_HOST: LOCAL_DOCKER_HOST },
  });
}

export function canonicalPinnedRuntimeImageBuildArguments({
  archivePath,
  runtime,
  contextPath,
  errorPrefix,
} = {}) {
  if (!path.isAbsolute(String(archivePath || ''))) {
    throw new Error(`${errorPrefix}_archive_path_absolute_required`);
  }
  return Object.freeze([
    'buildx', 'build',
    '--progress=plain',
    '--platform', PINNED_RUNTIME_IMAGE_BOOTSTRAP_PLATFORM,
    '--no-cache',
    '--pull=false',
    '--provenance=false',
    '--sbom=false',
    '--build-arg',
    `SOURCE_DATE_EPOCH=${PINNED_RUNTIME_IMAGE_BOOTSTRAP_SOURCE_DATE_EPOCH}`,
    '--output', `type=oci,dest=${archivePath},rewrite-timestamp=true`,
    '--tag', runtime.image,
    contextPath,
  ]);
}

export function bootstrapPinnedRuntimeImage({
  mode,
  archivePath,
  spawnSyncImpl,
  environment,
  runtime,
  archiveName,
  temporaryPrefix,
  buildArguments,
  inspectArchive,
  errorPrefix,
  receiptKind,
  completedStatus,
  receiptHashField,
  receiptIdentity = {},
} = {}) {
  if (!['archive', 'build'].includes(mode)) {
    throw new Error(`${errorPrefix}_mode_invalid`);
  }
  const childEnvironment = resolveLocalRuntimeImageBootstrapEnvironment({
    environment,
    errorPrefix,
  });
  const temporaryRoot = mode === 'build'
    ? fs.mkdtempSync(path.join(os.tmpdir(), temporaryPrefix)) : null;
  const effectiveArchive = mode === 'build'
    ? path.join(temporaryRoot, archiveName)
    : path.resolve(String(archivePath || ''));
  let buildAttempted = false;
  let loadAttempted = false;
  try {
    if (mode === 'build') {
      buildAttempted = true;
      executeRuntimeImageBootstrapCommand({
        executable: 'docker',
        args: buildArguments(effectiveArchive),
        spawnSyncImpl,
        environment: childEnvironment,
        timeoutMs: 2 * 60 * 60 * 1_000,
        errorPrefix,
      });
    }
    const archiveInspection = inspectArchive({
      archivePath: effectiveArchive,
      spawnSyncImpl,
      environment,
    });
    loadAttempted = true;
    executeRuntimeImageBootstrapCommand({
      executable: 'docker',
      args: ['load', '--input', effectiveArchive],
      spawnSyncImpl,
      environment: childEnvironment,
      timeoutMs: 10 * 60 * 1_000,
      errorPrefix,
    });
    const manifestInspection = inspectDockerRuntimeImageManifest({
      image: runtime.image,
      expectedManifestDigest: runtime.imageDigest,
      spawnSyncImpl,
      environment,
      timeoutMs: 30_000,
    });
    if (!manifestInspection.ready) {
      throw new Error(
        `${errorPrefix}_post_load_preflight_failed:${manifestInspection.blockers.join(',')}`,
      );
    }
    const payload = Object.freeze({
      version: 1,
      kind: receiptKind,
      status: completedStatus,
      ...receiptIdentity,
      mode,
      image: runtime.image,
      expectedManifestDigest: runtime.imageDigest,
      observedManifestDigest: manifestInspection.observedManifestDigest,
      descriptorMediaType: manifestInspection.descriptorMediaType,
      platform: manifestInspection.observedPlatform,
      buildAttempted,
      loadAttempted,
      archivePrevalidated: archiveInspection.readyToLoad,
      runtimeFallbackAllowed: false,
      blockers: Object.freeze([]),
    });
    return Object.freeze({
      ...payload,
      [receiptHashField]: hashRecord(receiptKind, payload),
    });
  } finally {
    if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
