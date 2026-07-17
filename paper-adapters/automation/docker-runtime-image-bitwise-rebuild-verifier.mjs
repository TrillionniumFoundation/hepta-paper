import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  buildRuntimeImageBitwiseRebuildEvidence,
} from '../../paper-domain/automation/runtime-build-reproducibility-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function fileHash(filePath) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function definitionManifestHash(root, definitionPaths, manifestPrefix) {
  const records = definitionPaths.map((relativePath) => {
    const absolutePath = path.resolve(root, relativePath);
    const relative = path.relative(root, absolutePath).split(path.sep).join('/');
    if (!relative || relative.startsWith('../') || path.isAbsolute(relative)
      || !fs.statSync(absolutePath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`runtime_rebuild_definition_path_invalid:${relativePath}`);
    }
    return Object.freeze({
      path: [manifestPrefix, relative].filter(Boolean).join('/'),
      sha256: fileHash(absolutePath),
    });
  });
  return hashRecord('RuntimeImageBuildDefinitionManifest', records);
}

function run(spawnSyncImpl, executable, args, timeoutMs) {
  const result = spawnSyncImpl(executable, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result?.status !== 0) {
    const stderr = String(result?.stderr || result?.error?.message || '').slice(0, 2_000);
    throw new Error(`runtime_rebuild_docker_command_failed:${args[0]}:${stderr}`);
  }
  return result;
}

function inspectImage(spawnSyncImpl, dockerBinary, tag, timeoutMs) {
  const inspected = run(spawnSyncImpl, dockerBinary, ['image', 'inspect', tag], timeoutMs);
  let document;
  try { [document] = JSON.parse(String(inspected.stdout || '[]')); } catch {
    throw new Error('runtime_rebuild_docker_inspection_invalid_json');
  }
  const imageDigest = String(document?.Id || '').toLowerCase();
  const layers = document?.RootFS?.Layers;
  if (!SHA256.test(imageDigest) || !Array.isArray(layers) || !layers.length
    || layers.some((layer) => !SHA256.test(String(layer || '').toLowerCase()))) {
    throw new Error('runtime_rebuild_docker_inspection_invalid');
  }
  return Object.freeze({
    imageDigest,
    rootfsChainHash: hashRecord('DockerImageRootfsChain', {
      type: String(document.RootFS.Type || ''),
      layers: layers.map((layer) => String(layer).toLowerCase()),
    }),
  });
}

function removeProbeImage(spawnSyncImpl, dockerBinary, tag, timeoutMs) {
  try {
    spawnSyncImpl(dockerBinary, ['image', 'rm', '--force', tag], {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024,
    });
  } catch { /* best-effort cleanup after evidence capture */ }
}

export function observeLocalDockerRuntimeImageRootfsRepeatability({
  image,
  contextPath,
  definitionPaths,
  definitionManifestHash: expectedDefinitionManifestHash,
  dockerfile = 'Dockerfile',
  repositoryRoot = process.cwd(),
  dockerBinary = 'docker',
  spawnSyncImpl = spawnSync,
  randomUUID = crypto.randomUUID,
  clock = () => new Date(),
  timeoutMs = 2 * 60 * 60 * 1_000,
} = {}) {
  const sourceContext = path.resolve(repositoryRoot, String(contextPath || ''));
  const sourceRelative = path.relative(repositoryRoot, sourceContext);
  if (!String(image || '').trim() || !Array.isArray(definitionPaths) || !definitionPaths.length
    || sourceRelative.startsWith('../') || path.isAbsolute(sourceRelative)
    || !fs.statSync(sourceContext, { throwIfNoEntry: false })?.isDirectory()
    || !SHA256.test(String(expectedDefinitionManifestHash || '').toLowerCase())) {
    throw new Error('runtime_rebuild_configuration_invalid');
  }
  const expectedHash = String(expectedDefinitionManifestHash).toLowerCase();
  const manifestPrefix = sourceRelative.split(path.sep).join('/');
  if (definitionManifestHash(sourceContext, definitionPaths, manifestPrefix) !== expectedHash) {
    throw new Error('runtime_rebuild_source_definition_manifest_mismatch');
  }
  const builds = [];
  const probeTags = [];
  const buildRoots = [];
  try {
    for (const ordinal of ['first', 'second']) {
      const invocationId = `docker-rebuild:${ordinal}:${randomUUID()}`;
      const probeTag = `hepta/runtime-rebuild-probe:${randomUUID()}`.toLowerCase();
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `hepta-runtime-rebuild-${ordinal}-`));
      const isolatedContext = path.join(root, 'context');
      fs.cpSync(sourceContext, isolatedContext, { recursive: true, errorOnExist: true });
      const copiedHash = definitionManifestHash(isolatedContext, definitionPaths, manifestPrefix);
      if (copiedHash !== expectedHash) throw new Error('runtime_rebuild_isolated_copy_manifest_mismatch');
      buildRoots.push(root);
      probeTags.push(probeTag);
      run(spawnSyncImpl, dockerBinary, [
        'build', '--no-cache', '--pull=false', '--file', path.join(isolatedContext, dockerfile),
        '--tag', probeTag, isolatedContext,
      ], timeoutMs);
      const inspection = inspectImage(spawnSyncImpl, dockerBinary, probeTag, timeoutMs);
      builds.push(Object.freeze({
        invocationId,
        isolatedBuildRootIdentityHash: hashRecord('DockerIsolatedBuildRoot', {
          invocationId,
          definitionManifestHash: copiedHash,
          rootNonce: randomUUID(),
        }),
        buildInputClosureHash: copiedHash,
        cacheDisabled: true,
        imageDigest: inspection.imageDigest,
        rootfsChainHash: inspection.rootfsChainHash,
      }));
    }
    const observed = clock();
    const observedAt = observed instanceof Date ? observed.toISOString() : new Date(observed).toISOString();
    return buildRuntimeImageBitwiseRebuildEvidence({
      image,
      definitionManifestHash: expectedHash,
      firstBuild: builds[0],
      secondBuild: builds[1],
      observedAt,
    });
  } finally {
    for (const tag of probeTags) removeProbeImage(spawnSyncImpl, dockerBinary, tag, timeoutMs);
    for (const root of buildRoots) fs.rmSync(root, { recursive: true, force: true });
  }
}

/* Compatibility alias: this result is deliberately non-authoritative and can
   never satisfy production reproducibility or qualification readiness. */
export const verifyDockerRuntimeImageBitwiseRebuild =
  observeLocalDockerRuntimeImageRootfsRepeatability;
