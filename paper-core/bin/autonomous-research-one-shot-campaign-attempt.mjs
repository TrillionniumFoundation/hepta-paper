#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  composeFixedAutonomousResearchOneShotCampaignAttempt,
} from '../../paper-composition/automation/autonomous-research-one-shot-campaign-attempt-composition.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';
import {
  defaultPaperAssetRoot,
  defaultPaperRuntimeRoot,
} from '../src/workspace-layout.mjs';

const modulePath = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(modulePath), '..', '..');

export function usage() {
  return {
    version: 1,
    kind: 'AutonomousResearchOneShotCampaignAttemptUsage',
    usage: 'autonomous-research-one-shot-campaign-attempt --action execute|status [options]',
    actions: {
      execute: 'execute the fixed create-only Campaign 52 attempt through its append-only journal',
      status: 'inspect one exact attempt without provider, network, or campaign mutation',
    },
    options: {
      '--dataset-mount-file PATH': 'required for execute; exact JSON dataset mount array',
      '--attempt-id ID': 'required for status',
      '--root PATH': 'paper asset root',
      '--runtime-root PATH': 'canonical native runtime root',
      '--control-root PATH': 'dedicated sibling control-state root outside native runtime',
    },
    safety: {
      fixedCampaignId: 'autonomous-research:local-auto-20260730-52',
      protectedCampaignId: 'autonomous-research:local-auto-20260730-51',
      createOnly: true,
      prepareProviderFree: true,
      providerAndLaunchMarkersRequired: true,
      replayExternalActions: false,
      arbitraryProviderOverride: false,
      arbitraryCampaignOverride: false,
    },
  };
}

export function loadDatasetMounts(candidate) {
  if (!candidate) throw new Error('autonomous_research_one_shot_dataset_mount_file_required');
  const parsed = JSON.parse(fs.readFileSync(path.resolve(candidate), 'utf8'));
  if (!Array.isArray(parsed) || parsed.length < 1) {
    throw new Error('autonomous_research_one_shot_dataset_mounts_invalid');
  }
  return parsed;
}

export async function main({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  environment = process.env,
  composeAttempt = composeFixedAutonomousResearchOneShotCampaignAttempt,
  assetRoot = defaultPaperAssetRoot(),
  nativeRuntimeRoot = defaultPaperRuntimeRoot(),
} = {}) {
  const args = parseStrictCliArguments(argv, {
    booleanFlags: ['help'],
    valueFlags: [
      'action', 'root', 'runtime-root', 'control-root',
      'dataset-mount-file', 'attempt-id',
    ],
    positional: false,
  });
  if (args.help) {
    stdout.write(`${JSON.stringify(usage(), null, 2)}\n`);
    return;
  }
  const action = args.action || 'status';
  if (!['execute', 'status'].includes(action)) {
    throw new Error(`autonomous_research_one_shot_action_invalid:${action}`);
  }
  if (action === 'status' && !args['attempt-id']) {
    throw new Error('autonomous_research_one_shot_attempt_id_required');
  }
  const runtimeRoot = path.resolve(args['runtime-root'] || nativeRuntimeRoot);
  const controlRoot = path.resolve(args['control-root']
    || path.join(path.dirname(runtimeRoot), 'one-shot-campaign-control'));
  const report = await composeAttempt({
    action,
    workspaceRoot,
    root: path.resolve(args.root || assetRoot),
    runtimeRoot,
    controlRoot,
    datasetMounts: action === 'execute' ? loadDatasetMounts(args['dataset-mount-file']) : [],
    attemptId: args['attempt-id'] || null,
    environment,
  });
  stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (action === 'execute'
    && report.status !== 'autonomous_research_one_shot_campaign_attempt_terminal') {
    process.exitCode = 2;
  }
}

const invokedAsEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === modulePath;
if (invokedAsEntrypoint) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  });
}
