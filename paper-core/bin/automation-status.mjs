#!/usr/bin/env node
import { queryAutomationReadiness } from '../../paper-composition/automation/automation-readiness-query.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const args = parseStrictCliArguments(process.argv.slice(2), {
  booleanFlags: [
    'help',
    'live-provider-canary',
    'require-full-research',
    'require-fully-autonomous',
  ],
  valueFlags: ['root', 'runtime-root'],
  positional: false,
});

if (args.help) {
  process.stdout.write(`${JSON.stringify({
    version: 1,
    kind: 'AutomationStatusUsage',
    usage: 'automation-status [--root PATH] [--runtime-root PATH] [--require-full-research] [--require-fully-autonomous] [--live-provider-canary]',
    mutation: 'none',
  }, null, 2)}\n`);
  process.exit(0);
}
const query = queryAutomationReadiness({
  root: args.root || defaultPaperAssetRoot(),
  runtimeRoot: args['runtime-root'] || defaultPaperRuntimeRoot(),
  liveProviderCanaryRequested: args['live-provider-canary'] === true,
  requireFullResearch: args['require-full-research'] === true,
  requireFullyAutonomous: args['require-fully-autonomous'] === true,
  activeReleaseAttestorVerification: false,
});
process.stdout.write(`${JSON.stringify(query.report, null, 2)}\n`);
process.exitCode = query.exitCode;
