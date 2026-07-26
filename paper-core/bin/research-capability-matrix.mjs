#!/usr/bin/env node
import { buildResearchCapabilityMatrix } from '../../paper-application/automation/research-capability-matrix.mjs';
import { queryAutomationReadiness } from '../../paper-composition/automation/automation-readiness-query.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const args = parseStrictCliArguments(process.argv.slice(2), {
  booleanFlags: ['help', 'json', 'require-production-ready'],
  valueFlags: ['root', 'runtime-root'],
  positional: false,
});

if (args.help) {
  process.stdout.write(`${JSON.stringify({
    version: 1,
    kind: 'ResearchCapabilityMatrixUsage',
    usage: 'research-capability-matrix [--json] [--root PATH] [--runtime-root PATH] [--require-production-ready]',
    mutation: 'no-canonical-state-write',
    localObservationEffects: 'runtime-metadata-and-daemon-probes-may-change',
    externalAction: 'local-runtime-observation',
  }, null, 2)}\n`);
  process.exit(0);
}

const query = queryAutomationReadiness({
  root: args.root || defaultPaperAssetRoot(),
  runtimeRoot: args['runtime-root'] || defaultPaperRuntimeRoot(),
});
const matrix = buildResearchCapabilityMatrix(query.report);
process.stdout.write(`${JSON.stringify(matrix, null, 2)}\n`);
if (args['require-production-ready'] === true && !matrix.fullyAutonomousProductionReady) {
  process.exitCode = 1;
}
