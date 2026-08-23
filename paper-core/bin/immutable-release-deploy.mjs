#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectImmutableReleaseDeploymentExecutorBoundary as inspectExecutorBoundary,
} from './immutable-release-deploy-validation.mjs';

const ENTRYPOINT = fileURLToPath(import.meta.url);
const INSTALLED_LAUNCHER = '/usr/libexec/hepta-paper/hepta-immutable-release-deploy';
const SEALED_ROOT = '/opt/hepta-paper';
const RELEASE_STORE = '/opt/hepta-paper-releases';
const DEPLOYMENT_LOCK = '/run/hepta-paper-deployment/deployment.lock';

function codedError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

function safeError(error) {
  const candidate = String(error?.code || error?.message || 'immutable_release_deployment_failed');
  return /^[A-Za-z0-9_.:-]+$/u.test(candidate)
    ? candidate : 'immutable_release_deployment_failed';
}

export function inspectImmutableReleaseDeploymentExecutorBoundary({
  entrypointPath = ENTRYPOINT,
  launcherMarker = process.env.HEPTA_IMMUTABLE_DEPLOY_LAUNCHER,
  executorRoot = process.env.HEPTA_IMMUTABLE_DEPLOY_EXECUTOR_ROOT,
  inheritedLockFd = Number(process.env.HEPTA_IMMUTABLE_DEPLOY_LOCK_FD),
  effectiveUid = process.geteuid?.(),
  mountInfoText = fs.readFileSync('/proc/self/mountinfo', 'utf8'),
} = {}) {
  if (launcherMarker !== 'sealed-v1') {
    throw codedError('immutable_release_deployment_installed_launcher_required');
  }
  if (effectiveUid !== 0) throw codedError('immutable_release_deployment_root_required');
  // This runs before any repository module is dynamically imported. Keep all
  // trust-boundary constants fixed here; the validator itself is a pure,
  // read-only implementation used by deterministic tests.
  return inspectExecutorBoundary({
    entrypointPath,
    executorRoot,
    sealedRoot: SEALED_ROOT,
    releaseStore: RELEASE_STORE,
    deploymentLock: DEPLOYMENT_LOCK,
    inheritedLockFd,
    mountInfoText,
    installedLauncher: INSTALLED_LAUNCHER,
    expectedUid: 0,
    expectedGid: 0,
  });
}

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === ENTRYPOINT;
if (invokedAsScript) {
  try {
    const executorBoundary = inspectImmutableReleaseDeploymentExecutorBoundary();
    const { runImmutableReleaseDeploymentCli } = await import(
      '../../paper-composition/bootstrap/immutable-release-deployment-cli.mjs'
    );
    process.exitCode = await runImmutableReleaseDeploymentCli({ executorBoundary });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: safeError(error) })}\n`);
    process.exitCode = 126;
  }
}
