#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReleaseActionCommand,
  buildReleaseEnvironment,
  inspectComposedProductionReleaseEnvironment,
  inspectReleaseEnvironmentLauncherBoundary,
  parseReleaseEnvironmentArguments,
  releaseEnvironmentUsage,
  replaceProcessEnvironment,
  runReleaseAction,
} from '../../paper-composition/bootstrap/release-environment-composition.mjs';
import { inspectWorkspaceReleaseState } from '../src/release-state-repository.mjs';

function safeError(error) {
  const message = String(error?.code || error?.message || 'release_environment_failed');
  return /^[A-Za-z0-9_.:-]+$/u.test(message)
    ? message
    : 'release_environment_failed';
}

function createScratchRoot() {
  const root = fs.mkdtempSync('/tmp/hepta-paper-release-env-');
  fs.chmodSync(root, 0o700);
  for (const child of ['cache', 'config', 'home', 'npm-cache', 'tmp']) {
    fs.mkdirSync(path.join(root, child), { mode: 0o700 });
  }
  return root;
}

function removeScratchRoot(root) {
  try {
    fs.rmSync(root, { force: true, maxRetries: 2, recursive: true, retryDelay: 50 });
  } catch {
    process.stderr.write('release_environment_scratch_cleanup_failed\n');
  }
}

function writeError(stream, kind, error) {
  stream.write(`${JSON.stringify({
    ok: false,
    kind,
    error: safeError(error),
  })}\n`);
}

export function runReleaseEnvironmentCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  entrypointPath = fileURLToPath(import.meta.url),
  inspectLauncherBoundary = inspectReleaseEnvironmentLauncherBoundary,
  inspectEnvironment = inspectComposedProductionReleaseEnvironment,
  inspectReleaseState = inspectWorkspaceReleaseState,
  buildCommand = buildReleaseActionCommand,
  executeAction = runReleaseAction,
  replaceEnvironment = replaceProcessEnvironment,
} = {}) {
  let options;
  try {
    options = parseReleaseEnvironmentArguments(argv);
  } catch (error) {
    writeError(stderr, 'ReleaseEnvironmentCliError', error);
    return 2;
  }

  if (options.help) {
    stdout.write(`${JSON.stringify(releaseEnvironmentUsage(), null, 2)}\n`);
    return 0;
  }

  try {
    inspectLauncherBoundary({ action: options.action });
  } catch (error) {
    writeError(stderr, 'ReleaseEnvironmentCliError', error);
    return 2;
  }

  const scratchRoot = createScratchRoot();
  const environment = buildReleaseEnvironment({
    scratchRoot,
    action: options.action,
  });
  replaceEnvironment(environment);
  try {
    const inspection = inspectEnvironment({
      action: options.action,
      entrypointPath,
      inspectReleaseState,
    });
    const command = buildCommand({
      action: options.action,
      manifestPath: options.manifestPath,
    });
    stdout.write(`release_environment_preflight=${JSON.stringify(inspection)}\n`);
    return executeAction({ command, environment });
  } catch (error) {
    writeError(stderr, 'ReleaseEnvironmentError', error);
    return 2;
  } finally {
    removeScratchRoot(scratchRoot);
  }
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) process.exitCode = runReleaseEnvironmentCli();
