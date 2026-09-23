#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  composeAutomationReadinessDeploymentEnvironment,
} from '../../paper-composition/automation/deployment-environment-composition.mjs';
import {
  queryFullProductionReadiness,
} from '../../paper-composition/automation/full-production-readiness-composition.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const modulePath = fileURLToPath(import.meta.url);

export function parseFullProductionReadinessArguments(argv) {
  return parseStrictCliArguments(argv, {
    booleanFlags: [
      'help',
      'json',
      'live-provider-canary',
      'live-release-attestor',
      'require-full-production',
    ],
    valueFlags: [
      'deployment-environment-file',
      'owner-acceptance-document',
      'owner-acceptance-document-sha256',
      'owner-trust-store',
      'owner-trust-store-sha256',
      'package-recovery-readiness-command',
      'package-recovery-readiness-command-sha256',
      'root',
      'runtime-root',
    ],
    positional: false,
  });
}

function usage() {
  return Object.freeze({
    version: 1,
    kind: 'FullProductionReadinessUsage',
    usage: 'full-production-readiness --owner-trust-store PATH --owner-trust-store-sha256 sha256:... --owner-acceptance-document PATH --owner-acceptance-document-sha256 sha256:... --package-recovery-readiness-command PATH --package-recovery-readiness-command-sha256 sha256:... [--root PATH] [--runtime-root PATH] [--live-provider-canary] [--live-release-attestor] [--require-full-production]',
    localObservationEffects: 'runtime-metadata-and-daemon-probes-may-change',
    externalAction: 'argument-dependent',
    semanticNotReadyExitCode: 2,
  });
}

export async function runFullProductionReadiness({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  environment = process.env,
  query = queryFullProductionReadiness,
} = {}) {
  const args = parseFullProductionReadinessArguments(argv);
  if (args.help) {
    const output = usage();
    stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return Object.freeze({ output, exitCode: 0 });
  }
  const deploymentEnvironment = composeAutomationReadinessDeploymentEnvironment({
    baseEnvironment: environment,
    filePath: args['deployment-environment-file'] || null,
  });
  const selectedEnvironment = deploymentEnvironment.environment;
  const output = await query({
    root: path.resolve(
      args.root || selectedEnvironment.HEPTA_PAPER_ASSET_ROOT || defaultPaperAssetRoot(),
    ),
    runtimeRoot: path.resolve(
      args['runtime-root']
        || selectedEnvironment.HEPTA_PAPER_RUNTIME_ROOT || defaultPaperRuntimeRoot(),
    ),
    packageRecoveryReadinessCommand:
      args['package-recovery-readiness-command'],
    packageRecoveryReadinessCommandSha256:
      args['package-recovery-readiness-command-sha256'],
    ownerTrustStore: args['owner-trust-store'],
    ownerTrustStoreSha256: args['owner-trust-store-sha256'],
    ownerAcceptanceDocument: args['owner-acceptance-document'],
    ownerAcceptanceDocumentSha256: args['owner-acceptance-document-sha256'],
    environment: selectedEnvironment,
    liveProviderCanaryRequested: args['live-provider-canary'] === true,
    activeReleaseAttestorVerification: args['live-release-attestor'] === true,
  });
  stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  const exitCode = args['require-full-production'] === true
    && output.fullProductionReady !== true ? 2 : 0;
  return Object.freeze({ output, exitCode });
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  runFullProductionReadiness().then(({ exitCode }) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
