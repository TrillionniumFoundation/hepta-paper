import path from 'node:path';
import { PAPER_BATCH_MODES } from '../../paper-domain/workflow/mode-registry.mjs';
import { parseStrictCliArguments } from './strict-cli-arguments.mjs';

const COMMON_BOOLEAN_FLAGS = Object.freeze(new Set([
  'json',
  'help',
  'write-report',
  'execute',
  'include-retired',
  'include-quarantined',
  'materialize-source',
  'stage-inventory',
  'apply-manuscript',
]));

const PAPER_PRODUCTION_VALUE_FLAGS = Object.freeze([
  'root',
  'runtime-root',
  'mode',
  'limit',
  'inventory-source',
  'max-rounds',
  'target',
  'venue',
  'dataset-root',
  'dataset',
  'benchmark-id',
  'benchmark',
  'dataset-license',
  'dataset-authorization',
  'dataset-harness',
  'quality-profile',
  'languages',
  'idea',
  'discipline',
  'title',
  'paper-type',
  'risk-preference',
  'scientific-claim-document',
  'approval-document',
]);

function optionalPositiveInteger(args, key, fallback = null) {
  if (args[key] === undefined) return fallback;
  const value = Number(args[key]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid_positive_integer:${key}`);
  return value;
}

function optionalSha256(args, key) {
  if (args[key] === undefined) return null;
  const value = String(args[key]);
  if (!/^sha256:[0-9a-f]{64}$/i.test(value)) throw new Error(`invalid_sha256:${key}`);
  return value;
}

export function parsePaperProductionArgs(argv) {
  return parseStrictCliArguments(argv, {
    booleanFlags: [...COMMON_BOOLEAN_FLAGS],
    valueFlags: PAPER_PRODUCTION_VALUE_FLAGS,
    repeatableValueFlags: ['paper', 'material', 'constraint'],
    positional: true,
    maximumPositionals: 1,
    removedFlags: {
      'legacy-workflow-projection': 'legacy_workflow_projection_removed_use_compat_script',
      approved: 'proposal_boolean_approval_removed_use_approval_document',
    },
  });
}

export function buildPaperBatchCliOptions(args, {
  defaultRoot,
  defaultRuntimeRoot,
} = {}) {
  return Object.freeze({
    root: args.root ? path.resolve(args.root) : defaultRoot,
    runtimeRoot: args['runtime-root'] ? path.resolve(args['runtime-root']) : defaultRuntimeRoot,
    mode: args.mode || PAPER_BATCH_MODES.INVENTORY,
    limit: optionalPositiveInteger(args, 'limit'),
    paperIds: args.paper || [],
    includeRetired: Boolean(args['include-retired']),
    includeQuarantined: Boolean(args['include-quarantined']),
    inventorySource: args['inventory-source'] || 'auto',
    execute: Boolean(args.execute),
    writeReport: Boolean(args['write-report']),
    maxRounds: optionalPositiveInteger(args, 'max-rounds', 6),
    targetOverride: args.target || args.venue || null,
    datasetRoot: args['dataset-root'] || args.dataset || null,
    benchmarkId: args['benchmark-id'] || args.benchmark || null,
    datasetLicenseId: args['dataset-license'] || null,
    datasetAuthorizationHash: optionalSha256(args, 'dataset-authorization'),
    datasetHarnessEnvelope: args['dataset-harness'] ? path.resolve(args['dataset-harness']) : null,
    applyManuscript: Boolean(args['apply-manuscript']),
    qualityProfile: args['quality-profile'] || null,
    languages: String(args.languages || 'python,latex').split(',').map((language) => language.trim()).filter(Boolean),
  });
}
