#!/usr/bin/env node
import { inspectWorkspaceReleaseState } from '../src/release-state-repository.mjs';

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === '--help') {
    return Object.freeze({ help: true, requiredState: null });
  }
  let requiredState = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--require-state') throw new Error(`unknown_cli_option:${argument}`);
    if (requiredState !== null) throw new Error('duplicate_cli_option:--require-state');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('missing_cli_option_value:--require-state');
    if (value !== 'release_ready') throw new Error(`release_state_requirement_override_forbidden:${value}`);
    requiredState = value;
    index += 1;
  }
  return Object.freeze({ help: false, requiredState });
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    kind: 'ReleaseStateCheckCliError',
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exit(2);
}

if (options.help) {
  process.stdout.write(`${JSON.stringify({
    kind: 'ReleaseStateCheckUsage',
    usage: 'node paper-core/bin/release-state-check.mjs [--require-state release_ready]',
  }, null, 2)}\n`);
  process.exit(0);
}

const releaseStateSnapshot = inspectWorkspaceReleaseState();
const inspected = releaseStateSnapshot.releaseState;
const requirementError = options.requiredState !== null && inspected.state !== options.requiredState
  ? `required_release_state_mismatch:${options.requiredState}:${inspected.state || 'invalid'}`
  : null;
const result = Object.freeze({
  ...inspected,
  ok: inspected.ok && requirementError === null,
  requiredState: options.requiredState,
  workspaceReleaseStateSnapshotHash: releaseStateSnapshot.workspaceReleaseStateSnapshotHash,
  errors: Object.freeze(requirementError === null
    ? [...inspected.errors]
    : [...inspected.errors, requirementError]),
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
