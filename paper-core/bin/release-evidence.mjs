#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSignedReleaseEvidence } from './release-evidence-bundle.mjs';
import { attestLegacyDeletionDrill } from './legacy-deletion-drill.mjs';
import {
  defaultLegacyPaperFactoryRoot,
  defaultPaperRuntimeRoot,
} from '../src/workspace-layout.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const modulePath = fileURLToPath(import.meta.url);
const defaultWorkspaceRoot = path.resolve(path.dirname(modulePath), '..', '..');

export function releaseEvidenceUsage() {
  return [
    'Usage: release-evidence --execute',
    '',
    '  --execute  Explicitly attest the deletion drill and publish signed release evidence.',
    '  --help     Show this help without reading keys or writing runtime evidence.',
  ].join('\n');
}

export function parseReleaseEvidenceArguments(argv = []) {
  const args = parseStrictCliArguments(argv, {
    booleanFlags: ['execute', 'help'],
    valueFlags: [],
    positional: false,
  });
  if (args.help) return Object.freeze({ help: true, execute: false });
  if (args.execute !== true) throw new Error('release_attestation_execute_required');
  return Object.freeze({ help: false, execute: true });
}

export async function runReleaseEvidenceCommand({
  argv = process.argv.slice(2),
  environment = process.env,
  workspaceRoot = defaultWorkspaceRoot,
  runtimeRoot = null,
  legacyRoot = null,
  attestDeletionDrill = attestLegacyDeletionDrill,
  writeEvidence = writeSignedReleaseEvidence,
} = {}) {
  const options = parseReleaseEvidenceArguments(argv);
  if (options.help) return releaseEvidenceUsage();
  if (environment.HEPTA_PAPER_RUNTIME_ISOLATED === '1') {
    throw new Error('release_attestation_forbidden_in_isolated_runtime');
  }
  const selectedRuntimeRoot = runtimeRoot || defaultPaperRuntimeRoot();
  const selectedLegacyRoot = legacyRoot || defaultLegacyPaperFactoryRoot();
  const deletionDrill = await attestDeletionDrill({
    workspaceRoot,
    runtimeRoot: selectedRuntimeRoot,
    legacyRoot: selectedLegacyRoot,
    environment,
  });
  const result = writeEvidence({
    runtimeRoot: selectedRuntimeRoot,
    legacyRoot: selectedLegacyRoot,
    workspaceRoot,
    environment,
    expectedReleaseStateSnapshotHash:
      deletionDrill.receipt.releaseStateSnapshotHash,
  });
  return Object.freeze({
    status: result.bundle.status,
    releaseEvidenceBundleHash: result.bundle.releaseEvidenceBundleHash,
    legacyDeletionDrillReceiptHash:
      deletionDrill.receipt.legacyPhysicalDeletionAndRestoreDrillReceiptHash,
    publicKeyFingerprint: result.signature.publicKeyFingerprint,
    outputRoot: result.root,
  });
}

const invokedAsEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === modulePath;
if (invokedAsEntrypoint) {
  try {
    const report = await runReleaseEvidenceCommand();
    process.stdout.write(`${typeof report === 'string'
      ? report : JSON.stringify(report, null, 2)}\n`);
    if (typeof report !== 'string' && report.status !== 'code_release_evidence_ready') {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  }
}
