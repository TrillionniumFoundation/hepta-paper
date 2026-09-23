#!/usr/bin/env node
import path from 'node:path';

import {
  composeProductionDependencyHandoff,
} from '../../paper-composition/automation/production-dependency-handoff-composition.mjs';
import {
  composeAutomationReadinessDeploymentEnvironment,
} from '../../paper-composition/automation/deployment-environment-composition.mjs';
import { queryAutomationReadiness } from '../../paper-composition/automation/automation-readiness-query.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

const args = parseStrictCliArguments(process.argv.slice(2), {
  booleanFlags: [
    'help',
    'handoff',
    'json',
    'live-formal-sandbox-probe',
    'live-provider-canary',
    'live-release-attestor',
    'require-full-research',
    'require-fully-autonomous',
  ],
  valueFlags: ['deployment-environment-file', 'root', 'runtime-root'],
  positional: false,
});

if (args.help) {
  process.stdout.write(`${JSON.stringify({
    version: 2,
    kind: 'AutomationStatusUsage',
    usage: 'automation-status [--json] [--handoff] [--deployment-environment-file PATH] [--root PATH] [--runtime-root PATH] [--require-full-research] [--require-fully-autonomous] [--live-formal-sandbox-probe] [--live-provider-canary] [--live-release-attestor]',
    mutation: 'formal probe qualification receipt only with --live-formal-sandbox-probe',
    localObservationEffects: 'runtime-metadata-and-daemon-probes-may-change',
    externalAction: 'argument-dependent',
  }, null, 2)}\n`);
  process.exit(0);
}
const deploymentEnvironment = composeAutomationReadinessDeploymentEnvironment({
  baseEnvironment: process.env,
  filePath: args['deployment-environment-file'] || null,
});
const environment = deploymentEnvironment.environment;
const query = queryAutomationReadiness({
  root: args.root || environment.HEPTA_PAPER_ASSET_ROOT || defaultPaperAssetRoot(),
  runtimeRoot: args['runtime-root']
    || environment.HEPTA_PAPER_RUNTIME_ROOT || defaultPaperRuntimeRoot(),
  environment,
  allowMissingStore: args.handoff === true,
  liveProviderCanaryRequested: args['live-provider-canary'] === true,
  requireFullResearch: args['require-full-research'] === true,
  requireFullyAutonomous: args['require-fully-autonomous'] === true,
  activeFormalSandboxProbe: args['live-formal-sandbox-probe'] === true,
  activeReleaseAttestorVerification: args['live-release-attestor'] === true,
});
const readiness = Object.freeze({
  ...query.report,
  deploymentEnvironmentInspection: deploymentEnvironment.inspection,
});
let output = readiness;
if (args.handoff) {
  output = composeProductionDependencyHandoff({
    readiness,
    repositoryRoot,
    environment,
  });
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
// Exit 2 is the strict-acceptance semantic-not-ready channel. Unexpected
// exceptions still terminate with Node's infrastructure-failure exit code 1.
process.exitCode = query.exitCode === 0 ? 0 : 2;
