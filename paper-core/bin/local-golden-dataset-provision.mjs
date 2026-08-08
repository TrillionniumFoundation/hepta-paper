#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  executeLocalGoldenDatasetProvisioning,
  inspectLocalGoldenDatasetProvisioning,
} from '../../paper-composition/automation/local-golden-dataset-provisioning-composition.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';
import {
  defaultPaperAssetRoot,
  defaultPaperRuntimeRoot,
} from '../src/workspace-layout.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function isMainModule() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try { return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(modulePath); }
  catch { return path.resolve(process.argv[1]) === path.resolve(modulePath); }
}

export function localGoldenDatasetProvisioningUsage() {
  return [
    'Usage: local-golden-dataset-provision --action plan|execute [options]',
    '',
    'This provisions a signed dataset harness for one isolated local golden runtime.',
    'It can never establish academic promotion eligibility or external trust.',
    '',
    'Required:',
    '  --runtime-root PATH              Existing private isolated runtime root.',
    '  --control-root PATH              Existing private isolated control root.',
    '  --isolation-id ID                Stable local isolation identifier.',
    '  --dataset-name NAME              Dataset/benchmark identifier.',
    '  --dataset-root PATH              Immutable read-only dataset directory.',
    '  --dataset-license-id SPDX|LicenseRef-*',
    '  --split-assignments PATH         Complete train/validation/public path assignments.',
    '  --harness-definition PATH        Private host-only hidden harness JSON (mode 0600).',
    '  --analysis-protocol PATH         Canonical preregistered analysis protocol JSON.',
    '  --research-semantics PATH        Dataset research-semantics JSON.',
    '  --authority-trust-store PATH     Public-only local-purpose AuthorityTrustStore JSON.',
    '  --authority-private-key PATH     Dedicated local-purpose Ed25519 key outside output roots.',
    '  --authority-key-id ID            Active dataset_harness_operator key ID.',
    '  --signed-at ISO                  Deterministic authority signature time.',
    '  --expires-at ISO                 Expiry no more than 31 days after signed-at.',
    '  --mount-output PATH              JSON mount array below control-root.',
    '',
    'Execution:',
    '  --action plan                    Validate immutable inputs; perform no writes.',
    '  --action execute --execute       Publish no-clobber outputs atomically.',
    '  --plan-id sha256:...             Exact plan ID emitted by plan; required by execute.',
    '',
    'Production runtime, asset, trust, source and deployment roots are always rejected.',
    'No data is downloaded and no provider or external service is called.',
  ].join('\n');
}

export function parseLocalGoldenDatasetProvisioningArguments(argv = []) {
  const args = parseStrictCliArguments(argv, {
    booleanFlags: ['execute', 'help'],
    valueFlags: [
      'action', 'plan-id', 'runtime-root', 'control-root', 'isolation-id',
      'dataset-name', 'dataset-root', 'dataset-license-id', 'split-assignments',
      'harness-definition', 'analysis-protocol', 'research-semantics',
      'authority-trust-store', 'authority-private-key', 'authority-key-id',
      'signed-at', 'expires-at', 'mount-output',
    ],
    positional: false,
  });
  if (args.help) return Object.freeze({ help: true });
  const action = args.action || 'plan';
  if (!['plan', 'execute'].includes(action)) {
    throw new Error(`local_golden_dataset_provisioning_action_invalid:${action}`);
  }
  const required = [
    'runtime-root', 'control-root', 'isolation-id', 'dataset-name', 'dataset-root',
    'dataset-license-id', 'split-assignments', 'harness-definition',
    'analysis-protocol', 'research-semantics', 'authority-trust-store',
    'authority-private-key', 'authority-key-id', 'signed-at', 'expires-at',
    'mount-output',
  ];
  const missing = required.filter((name) => !args[name]);
  if (missing.length) throw new Error(`local_golden_dataset_provisioning_arguments_required:${missing.join(',')}`);
  if (action === 'plan' && (args.execute || args['plan-id'])) {
    throw new Error('local_golden_dataset_provisioning_execute_options_forbidden');
  }
  if (action === 'execute' && args.execute !== true) {
    throw new Error('local_golden_dataset_provisioning_execute_confirmation_required');
  }
  if (action === 'execute' && !SHA256.test(String(args['plan-id'] || ''))) {
    throw new Error('local_golden_dataset_provisioning_plan_id_required');
  }
  return Object.freeze({
    help: false,
    action,
    execute: args.execute === true,
    expectedPlanId: args['plan-id'] || null,
    runtimeRoot: path.resolve(args['runtime-root']),
    controlRoot: path.resolve(args['control-root']),
    isolationId: args['isolation-id'],
    datasetName: args['dataset-name'],
    datasetRoot: path.resolve(args['dataset-root']),
    datasetLicenseId: args['dataset-license-id'],
    splitAssignmentsPath: path.resolve(args['split-assignments']),
    harnessDefinitionPath: path.resolve(args['harness-definition']),
    analysisProtocolPath: path.resolve(args['analysis-protocol']),
    researchSemanticsPath: path.resolve(args['research-semantics']),
    authorityTrustStorePath: path.resolve(args['authority-trust-store']),
    authorityPrivateKeyPath: path.resolve(args['authority-private-key']),
    authorityKeyId: args['authority-key-id'],
    signedAt: args['signed-at'],
    expiresAt: args['expires-at'],
    mountOutputPath: path.resolve(args['mount-output']),
  });
}

export function runLocalGoldenDatasetProvisioning({
  argv = process.argv.slice(2),
  environment = process.env,
  now = new Date(),
} = {}) {
  const options = parseLocalGoldenDatasetProvisioningArguments(argv);
  if (options.help) return localGoldenDatasetProvisioningUsage();
  const protectedRoots = [
    defaultPaperAssetRoot(),
    defaultPaperRuntimeRoot(),
    environment.HEPTA_PAPER_ASSET_ROOT,
    environment.HEPTA_PAPER_RUNTIME_ROOT,
    environment.HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT,
  ].filter(Boolean);
  const command = {
    ...options,
    workspaceRoot,
    protectedRoots,
    now,
  };
  if (options.action === 'plan') {
    return inspectLocalGoldenDatasetProvisioning(command).plan;
  }
  return executeLocalGoldenDatasetProvisioning(command);
}

if (isMainModule()) {
  Promise.resolve().then(() => runLocalGoldenDatasetProvisioning()).then((report) => {
    process.stdout.write(`${typeof report === 'string' ? report : JSON.stringify(report, null, 2)}\n`);
    if (typeof report !== 'string' && report.ready !== true) process.exitCode = 2;
  }).catch((error) => {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  });
}
