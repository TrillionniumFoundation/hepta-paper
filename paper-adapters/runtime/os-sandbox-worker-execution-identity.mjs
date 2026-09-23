import path from 'node:path';

import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';
import {
  inspectDockerImageDigest,
  normalizeContainerImageDigest,
  resolveExecutable,
  resolveExecutableInvocationPath,
} from './sandbox-backend-probe.mjs';
import { explicitContainerRuntimeIdentityPayload } from './dataset-supervisor-policy-adapter.mjs';
import { createWorkerExecutionIdentityIssuer } from './worker-execution-identity-issuer.mjs';

export function inspectWorkerExecutableHash(resolvedExecutable) {
  try { return resolvedExecutable ? sha256FileSync(resolvedExecutable) : null; }
  catch { return null; }
}

export function prepareWorkerExecutableIdentityAllowlist({
  allowedExecutables = [],
  expectedExecutableHashes = {},
} = {}) {
  const expectedExecutableHashEntries = expectedExecutableHashes instanceof Map
    ? [...expectedExecutableHashes.entries()]
    : Object.entries(expectedExecutableHashes || {});
  const trustedExecutableHashes = new Map(expectedExecutableHashEntries.map(([candidate, hash]) => {
    const resolved = resolveExecutable(candidate);
    const expected = String(hash || '').toLowerCase();
    if (!resolved || !/^sha256:[0-9a-f]{64}$/.test(expected)) {
      throw new Error('worker_expected_executable_hash_invalid');
    }
    return [resolved, expected];
  }));
  const allowedExecutableEntries = allowedExecutables.map((value) => Object.freeze({
    requested: String(value),
    invocationPath: resolveExecutableInvocationPath(value),
    resolvedExecutable: resolveExecutable(value),
    expectedHash: trustedExecutableHashes.get(resolveExecutable(value)) || null,
  }));
  if ([...trustedExecutableHashes.keys()].some((candidate) => (
    !allowedExecutableEntries.some((entry) => entry.resolvedExecutable === candidate)
  ))) {
    throw new Error('worker_expected_executable_not_allowlisted');
  }
  return (executable) => {
    const requested = String(executable || '');
    const invocationPath = resolveExecutableInvocationPath(executable);
    const resolvedExecutable = resolveExecutable(executable);
    const entry = allowedExecutableEntries.find((candidate) => candidate.requested === requested
      && candidate.invocationPath === invocationPath
      && candidate.resolvedExecutable === resolvedExecutable) || null;
    return Object.freeze({
      requested,
      invocationPath,
      resolvedExecutable,
      entry,
      allowlisted: Boolean(entry && invocationPath && resolvedExecutable),
    });
  };
}

export function createWorkerExecutionRuntimeIdentityResolver({
  availability,
  backend,
  containerImages,
  docker,
  dockerImage,
  imageDigestResolver = null,
  issuedExecutionIdentities,
  resolveAllowedExecutable,
  runnerId,
  trustedDatasetSupervisors,
} = {}) {
  const resolveImageDigest = imageDigestResolver
    || ((image) => inspectDockerImageDigest(docker, image));
  const issueExecutionIdentity = createWorkerExecutionIdentityIssuer(
    issuedExecutionIdentities,
  );
  return ({ executable, containerImage = null, containerExecutable = null } = {}) => {
    const allowedExecutable = resolveAllowedExecutable(executable);
    const resolvedExecutable = allowedExecutable.resolvedExecutable;
    const executableInvocationPath = allowedExecutable.invocationPath;
    const executableInvocationName = path.basename(String(executable || ''));
    const executableAllowlisted = allowedExecutable.allowlisted;
    if (containerImage) {
      const requestedImage = String(containerImage);
      const digest = normalizeContainerImageDigest(requestedImage)
        || normalizeContainerImageDigest(resolveImageDigest(requestedImage));
      return issueExecutionIdentity(explicitContainerRuntimeIdentityPayload({
        requestedImage,
        digest,
        containerExecutable,
        runnerId,
        allowedImages: containerImages,
        trustedDatasetSupervisors,
      }));
    }
    if (backend === 'docker') {
      const probedDigest = availability.image === dockerImage
        ? normalizeContainerImageDigest(availability.imageDigest)
        : null;
      const digest = probedDigest || normalizeContainerImageDigest(dockerImage)
        || normalizeContainerImageDigest(resolveImageDigest(dockerImage));
      const hostExecutableHash = inspectWorkerExecutableHash(resolvedExecutable);
      return issueExecutionIdentity({
        version: 1,
        kind: 'WorkerExecutionRuntimeIdentity',
        runtimeType: 'container',
        executionClass: 'hybrid-docker',
        runnerId,
        backend: 'docker',
        requestedImage: dockerImage,
        digest,
        containerExecutable: null,
        hostExecutable: resolvedExecutable,
        hostExecutableHash,
        executableInvocationPath,
        executableInvocationName,
        available: Boolean(digest && hostExecutableHash),
        allowlisted: executableAllowlisted,
        cacheable: false,
        hybridHostRuntime: true,
      });
    }
    const identityExecutableHash = inspectWorkerExecutableHash(resolvedExecutable);
    const payload = {
      version: 1,
      kind: 'HostRuntimeIdentity',
      runtimeType: 'host',
      executionClass: 'host',
      runnerId,
      backend,
      executable: String(executable || ''),
      executableInvocationPath,
      executableInvocationName,
      resolvedExecutable,
      executableHash: identityExecutableHash,
      available: Boolean(identityExecutableHash),
      allowlisted: executableAllowlisted,
    };
    return issueExecutionIdentity({ ...payload, cacheable: false });
  };
}
