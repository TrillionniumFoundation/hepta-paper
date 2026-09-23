#!/usr/bin/env node
import { buildResearchCapabilityMatrix } from '../../paper-application/automation/research-capability-matrix.mjs';
import {
  composeAutomationReadinessDeploymentEnvironment,
} from '../../paper-composition/automation/deployment-environment-composition.mjs';
import { queryAutomationReadiness } from '../../paper-composition/automation/automation-readiness-query.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const args = parseStrictCliArguments(process.argv.slice(2), {
  booleanFlags: ['help', 'json', 'require-production-ready'],
  valueFlags: ['deployment-environment-file', 'root', 'runtime-root'],
  positional: false,
});

if (args.help) {
  process.stdout.write(`${JSON.stringify({
    version: 1,
    kind: 'ResearchCapabilityMatrixUsage',
    usage: 'research-capability-matrix [--json] [--deployment-environment-file PATH] [--root PATH] [--runtime-root PATH] [--require-production-ready]',
    mutation: 'no-canonical-state-write',
    localObservationEffects: 'runtime-metadata-and-daemon-probes-may-change',
    externalAction: 'local-runtime-observation',
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
});
const matrix = buildResearchCapabilityMatrix(Object.freeze({
  ...query.report,
  deploymentEnvironmentInspection: deploymentEnvironment.inspection,
}));
process.stdout.write(`${JSON.stringify(matrix, null, 2)}\n`);
if (args['require-production-ready'] === true && !matrix.fullyAutonomousProductionReady) {
  process.exitCode = 1;
}
