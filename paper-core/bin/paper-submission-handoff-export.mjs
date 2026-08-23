#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  executeSubmissionHandoffExport,
} from '../../paper-composition/submission/submission-handoff-export-composition.mjs';
import {
  defaultPaperAssetRoot,
  defaultPaperRuntimeRoot,
} from '../src/workspace-layout.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

export function parseSubmissionHandoffExportArguments(argv = []) {
  return parseStrictCliArguments(argv, {
    booleanFlags: ['help'],
    valueFlags: [
      'bundle-root',
      'campaign-id',
      'request',
      'root',
      'runtime-root',
    ],
    positional: false,
  });
}

function usage() {
  return Object.freeze({
    version: 1,
    kind: 'SubmissionHandoffExportUsage',
    usage: 'hepta-paper operator submission-handoff-export -- --campaign-id <id> --bundle-root <path> --request <json> [--root <path>] [--runtime-root <path>]',
    mutation: 'explicit-local-filesystem-export-only',
    authoritativeInput: 'read-only-current-campaign-release-query-plus-operator-supplied-bound-request',
    externalAction: 'none',
    networkUse: 'none',
    providerDispatch: 'forbidden',
  });
}

export async function runSubmissionHandoffExportCommand({
  argv = [],
  stdout = process.stdout,
  execute = executeSubmissionHandoffExport,
  assetRoot = defaultPaperAssetRoot(),
  runtimeRoot = defaultPaperRuntimeRoot(),
} = {}) {
  const args = parseSubmissionHandoffExportArguments(argv);
  if (args.help) {
    stdout.write(`${JSON.stringify(usage(), null, 2)}\n`);
    return Object.freeze({ exitCode: 0, receipt: null });
  }
  const campaignId = String(args['campaign-id'] || '').trim();
  const bundleRoot = String(args['bundle-root'] || '').trim();
  const requestPath = String(args.request || '').trim();
  if (!campaignId) throw new Error('submission_handoff_export_campaign_id_required');
  if (!bundleRoot) throw new Error('submission_handoff_export_bundle_root_required');
  if (!requestPath) throw new Error('submission_handoff_export_request_path_required');
  const receipt = await execute({
    campaignId,
    root: path.resolve(args.root || assetRoot),
    runtimeRoot: path.resolve(args['runtime-root'] || runtimeRoot),
    bundleRoot: path.resolve(bundleRoot),
    requestPath: path.resolve(requestPath),
  });
  stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  return Object.freeze({
    exitCode: receipt.status === 'submission_handoff_export_completed' ? 0 : 2,
    receipt,
  });
}

async function main() {
  try {
    const result = await runSubmissionHandoffExportCommand({
      argv: process.argv.slice(2),
    });
    process.exitCode = result.exitCode;
  } catch (error) {
    const blockers = error?.receipt?.blockers?.length
      ? error.receipt.blockers
      : [String(error?.code || error?.message
        || 'submission_handoff_export_failed')];
    const payload = {
      version: 1,
      kind: 'SubmissionHandoffExportCommandFailure',
      status: 'submission_handoff_export_blocked',
      blockers,
      networkActionPerformed: false,
      providerActionPerformed: false,
      externalActionPerformed: false,
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) await main();
