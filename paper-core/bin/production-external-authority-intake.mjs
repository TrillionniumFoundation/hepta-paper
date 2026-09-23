#!/usr/bin/env node
import {
  composeProductionExternalAuthorityIntake,
} from '../../paper-composition/automation/production-external-authority-intake-composition.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const args = parseStrictCliArguments(process.argv.slice(2), {
  booleanFlags: ['help', 'require-ready'],
  valueFlags: [
    'author-config',
    'author-config-hash',
    'release-attestor-config',
    'release-attestor-config-hash',
  ],
  positional: false,
});

if (args.help) {
  process.stdout.write(`${JSON.stringify({
    version: 1,
    kind: 'ProductionExternalAuthorityIntakeUsage',
    usage: 'production-external-authority-intake [--author-config PATH --author-config-hash sha256:...] [--release-attestor-config PATH --release-attestor-config-hash sha256:...] [--require-ready]',
    defaults: 'the four HEPTA_RESEARCH_*_CONFIG/_HASH environment variables',
    mutation: 'none',
    externalAction: 'none',
    serviceStateChange: 'none',
  }, null, 2)}\n`);
  process.exit(0);
}

const inspection = composeProductionExternalAuthorityIntake({
  authorConfigPath: args['author-config'] || null,
  authorExpectedConfigurationHash: args['author-config-hash'] || null,
  releaseAttestorConfigPath: args['release-attestor-config'] || null,
  releaseAttestorExpectedConfigurationHash:
    args['release-attestor-config-hash'] || null,
  environment: process.env,
});
process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
if (args['require-ready'] === true && inspection.readyForLiveVerification !== true) {
  process.exitCode = 2;
}
