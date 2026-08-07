import { spawnSync } from 'node:child_process';

import { resolvePinnedLakeExecutable } from '../../../paper-adapters/research-verify/pinned-lake-executable-resolver.mjs';
import {
  inspectConfiguredPinnedFormalSandboxRuntime,
  SYSTEM_PINNED_FORMAL_SANDBOX_RUNTIME_CONFIGURATION,
} from '../../../paper-adapters/research-verify/pinned-formal-sandbox-runtime-configuration.mjs';

export function trustedProductionLakePreflight({
  environment = process.env,
  expectedSandboxImageDigest =
    SYSTEM_PINNED_FORMAL_SANDBOX_RUNTIME_CONFIGURATION.imageDigest,
} = {}) {
  // The resolver performs fixed-layout, ownership and full content-Merkle
  // verification without executing elan or any toolchain byte.
  const runtime = resolvePinnedLakeExecutable({
    environment,
    forceContentRehash: true,
  });
  if (runtime.status !== 'formal_pinned_lake_resolved') {
    return { ready: false, reason: runtime.blockers.join(',') || runtime.status };
  }
  const probe = spawnSync(runtime.executable, ['--version'], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      LC_ALL: 'C',
      LANG: 'C',
      TZ: 'UTC',
      ELAN_HOME: runtime.elanHome,
      ELAN_TOOLCHAIN: runtime.toolchain,
    },
    timeout: 10_000,
    windowsHide: true,
  });
  if (probe.status !== 0 || probe.error) {
    return {
      ready: false,
      reason: String(
        probe.error?.message || probe.stderr || probe.stdout || 'lake_version_probe_failed',
      ).trim(),
    };
  }
  const afterProbe = resolvePinnedLakeExecutable({ environment });
  const identity = afterProbe.toolchainIdentity;
  if (afterProbe.status !== 'formal_pinned_lake_resolved'
    || identity?.status !== 'lean_toolchain_identity_verified'
    || identity.leanToolchainContentIdentityHash
      !== runtime.toolchainIdentity.leanToolchainContentIdentityHash
    || afterProbe.lakeExecutableHash !== runtime.lakeExecutableHash
    || afterProbe.leanExecutableHash !== runtime.leanExecutableHash) {
    return {
      ready: false,
      reason: afterProbe.blockers?.join(',') || identity?.blockers?.join(',')
        || 'formal_toolchain_identity_changed_during_version_probe',
    };
  }
  const formalSandbox = inspectConfiguredPinnedFormalSandboxRuntime({ environment });
  if (!formalSandbox.ready) {
    return {
      ready: false,
      reason: formalSandbox.blockers.join(',') || 'os_sandbox_runtime_unavailable',
    };
  }
  if (expectedSandboxImageDigest
    && formalSandbox.runtime?.imageDigest !== expectedSandboxImageDigest) {
    return { ready: false, reason: 'formal_sandbox_runtime_image_digest_mismatch' };
  }
  return {
    ready: true,
    runtime,
    identity,
    sandbox: formalSandbox.sandbox,
    formalSandboxRuntime: formalSandbox.runtime,
  };
}

export function trustedProductionLakeOrSkip(t, options = {}) {
  const preflight = trustedProductionLakePreflight(options);
  if (preflight.ready) return preflight;
  const environment = options.environment || process.env;
  if (environment.HEPTA_FORMAL_OPERATIONAL_MODE === 'strict'
    || environment.HEPTA_DYNAMIC_FORMAL_KERNEL_OPERATIONAL_MODE === 'strict') {
    throw new Error(`formal_operational_prerequisite_failed:${preflight.reason}`);
  }
  t.skip(`trusted production formal runtime unavailable: ${preflight.reason}`);
  return null;
}
