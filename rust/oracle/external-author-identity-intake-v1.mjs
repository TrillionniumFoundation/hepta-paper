#!/usr/bin/env node

// Small, read-only differential oracle for the Rust author verifier.  The
// oracle intentionally delegates to the incumbent composition and accepts
// only JSON arguments; it never creates a key, invokes a provider, or writes
// the supplied configuration.
import process from 'node:process';
import {
  composeProductionExternalAuthorityIntake,
} from '../../paper-composition/automation/production-external-authority-intake-composition.mjs';

const input = process.argv[2] ? JSON.parse(process.argv[2]) : {};
const now = input.now === undefined ? new Date() : new Date(input.now);
const report = composeProductionExternalAuthorityIntake({
  authorConfigPath: input.authorConfigPath ?? null,
  authorExpectedConfigurationHash: input.authorExpectedConfigurationHash ?? null,
  releaseAttestorConfigPath: null,
  releaseAttestorExpectedConfigurationHash: null,
  environment: input.environment ?? {},
  now,
});
process.stdout.write(`${JSON.stringify(report.author)}\n`);
