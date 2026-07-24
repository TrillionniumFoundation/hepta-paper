import fs from 'node:fs';
import path from 'node:path';

import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { createPinnedFormalSandboxRuntime } from './pinned-formal-sandbox-runtime-contract.mjs';
import {
  normalizeContainerImageDigest,
  probeOsSandbox,
} from '../runtime/sandbox-backend-probe.mjs';

export { createPinnedFormalSandboxRuntime } from './pinned-formal-sandbox-runtime-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const CONFIG_KEYS = Object.freeze([
  'configurationHash', 'image', 'imageDigest', 'kind', 'version',
]);

export function buildPinnedFormalSandboxRuntimeConfiguration({
  image,
  imageDigest,
} = {}) {
  const runtime = createPinnedFormalSandboxRuntime({ image, imageDigest });
  const payload = Object.freeze({
    version: 1,
    kind: 'PinnedFormalSandboxRuntimeConfiguration',
    image: runtime.image,
    imageDigest: runtime.imageDigest,
  });
  return Object.freeze({
    ...payload,
    configurationHash: hashRecord('PinnedFormalSandboxRuntimeConfiguration', payload),
  });
}

export const SYSTEM_PINNED_FORMAL_SANDBOX_RUNTIME_CONFIGURATION =
  buildPinnedFormalSandboxRuntimeConfiguration({
    image: 'alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc',
    imageDigest: 'sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc',
  });

export function readPinnedFormalSandboxRuntimeConfiguration({
  configPath,
  expectedConfigurationHash,
} = {}) {
  const candidate = path.resolve(String(configPath || ''));
  const expected = String(expectedConfigurationHash || '').toLowerCase();
  if (!SHA256.test(expected)) {
    throw new Error('formal_sandbox_runtime_configuration_hash_required');
  }
  let parsed;
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
      throw new Error('invalid');
    }
    parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
  } catch {
    throw new Error('formal_sandbox_runtime_configuration_file_invalid');
  }
  let rebuilt;
  try { rebuilt = buildPinnedFormalSandboxRuntimeConfiguration(parsed); }
  catch (error) {
    throw new Error(`formal_sandbox_runtime_configuration_invalid:${error?.message || error}`);
  }
  if (!hasExactObjectKeys(parsed, CONFIG_KEYS)
    || JSON.stringify(rebuilt) !== JSON.stringify(parsed)
    || rebuilt.configurationHash !== expected) {
    throw new Error('formal_sandbox_runtime_configuration_verification_failed');
  }
  return rebuilt;
}

export function configuredPinnedFormalSandboxRuntime({
  environment = process.env,
  allowSystemDefault = true,
} = {}) {
  const configPath = String(environment.HEPTA_FORMAL_SANDBOX_RUNTIME_CONFIG || '').trim();
  if (!configPath) {
    return allowSystemDefault
      ? SYSTEM_PINNED_FORMAL_SANDBOX_RUNTIME_CONFIGURATION
      : null;
  }
  return readPinnedFormalSandboxRuntimeConfiguration({
    configPath,
    expectedConfigurationHash: String(
      environment.HEPTA_FORMAL_SANDBOX_RUNTIME_CONFIG_HASH || '',
    ).trim(),
  });
}

export function inspectConfiguredPinnedFormalSandboxRuntime({
  environment = process.env,
  allowSystemDefault = true,
  probeRuntime = true,
  spawnSyncImpl = undefined,
} = {}) {
  try {
    const configuration = configuredPinnedFormalSandboxRuntime({
      environment,
      allowSystemDefault,
    });
    const sandbox = configuration && probeRuntime ? probeOsSandbox({
      dockerImage: configuration.image,
      environment,
      ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
    }) : null;
    const blockers = configuration ? [] : ['formal_sandbox_runtime_configuration_missing'];
    if (configuration && probeRuntime && sandbox?.available !== true) {
      blockers.push(`formal_sandbox_runtime_unavailable:${sandbox?.detail || 'unknown'}`);
    }
    if (configuration && probeRuntime && sandbox?.backend === 'docker'
      && normalizeContainerImageDigest(sandbox.imageDigest) !== configuration.imageDigest) {
      blockers.push('formal_sandbox_runtime_image_digest_mismatch');
    }
    return Object.freeze({
      version: 1,
      kind: 'PinnedFormalSandboxRuntimeConfigurationInspection',
      status: blockers.length
        ? 'formal_sandbox_runtime_configuration_blocked'
        : 'formal_sandbox_runtime_configuration_ready',
      ready: blockers.length === 0,
      configurationHash: configuration?.configurationHash || null,
      image: configuration?.image || null,
      imageDigest: configuration?.imageDigest || null,
      runtime: configuration ? createPinnedFormalSandboxRuntime(configuration) : null,
      systemDefault: !String(
        environment.HEPTA_FORMAL_SANDBOX_RUNTIME_CONFIG || '',
      ).trim(),
      sandbox,
      blockers: Object.freeze(blockers),
    });
  } catch (error) {
    return Object.freeze({
      version: 1,
      kind: 'PinnedFormalSandboxRuntimeConfigurationInspection',
      status: 'formal_sandbox_runtime_configuration_blocked',
      ready: false,
      configurationHash: null,
      image: null,
      imageDigest: null,
      runtime: null,
      blockers: Object.freeze([String(error?.message || error)]),
    });
  }
}
