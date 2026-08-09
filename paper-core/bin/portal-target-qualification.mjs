#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import {
  executePortalTargetQualificationImport,
  inspectPortalTargetQualification,
  planPortalTargetQualificationImport,
} from '../../paper-composition/submission/portal-target-qualification-composition.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const VALUE_FLAGS = Object.freeze([
  'action',
  'candidate',
  'candidate-hash',
  'plan-hash',
  'registry',
  'registry-hash',
  'trust-store',
  'trust-store-hash',
]);

function usage() {
  return Object.freeze({
    version: 1,
    kind: 'PortalTargetQualificationUsage',
    usage: [
      'portal-target-qualification --action status --registry PATH',
      '--trust-store PATH --trust-store-hash sha256:... [--registry-hash sha256:...]',
      'portal-target-qualification --action import-plan --registry PATH',
      '--candidate PATH --candidate-hash sha256:... --trust-store PATH',
      '--trust-store-hash sha256:...',
      'portal-target-qualification --action import-execute --execute',
      '--plan-hash sha256:... <the same import-plan arguments>',
    ].join(' '),
    environmentDefaults: Object.freeze({
      registry: 'HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY',
      registryHash: 'HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY_HASH',
      trustStore: 'HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE',
      trustStoreHash: 'HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE_HASH',
    }),
    constraints: Object.freeze([
      'Registry entries contain typed, independently signed, expiring, non-fixture evidence attestations for at most two targets.',
      'Ready status requires the exact semantic registry hash; successor generations bind predecessor and explicit revocation hashes.',
      'Import-plan and status are read-only; import-execute performs one local atomic registry write.',
      'No action performs a portal request, uses credentials, or creates or consumes a live commit permit.',
      'Final commit always requires a separate human-reviewed single-use authorization.',
    ]),
  });
}

function selected(args, flag, environmentName, environment = process.env) {
  return args[flag] || environment[environmentName] || null;
}

export function runPortalTargetQualificationCli({
  argv = process.argv.slice(2),
  environment = process.env,
  now = new Date(),
} = {}) {
  const args = parseStrictCliArguments(argv, {
    booleanFlags: ['execute', 'help', 'require-ready'],
    valueFlags: VALUE_FLAGS,
    positional: false,
  });
  if (args.help) return usage();
  const action = args.action || 'status';
  if (!['status', 'import-plan', 'import-execute'].includes(action)) {
    throw new Error(`portal_target_qualification_action_invalid:${action}`);
  }
  const common = {
    registryPath: selected(
      args,
      'registry',
      'HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY',
      environment,
    ),
    trustStorePath: selected(
      args,
      'trust-store',
      'HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE',
      environment,
    ),
    expectedTrustStoreHash: selected(
      args,
      'trust-store-hash',
      'HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE_HASH',
      environment,
    ),
    now,
  };
  if (action === 'status') {
    const inspection = inspectPortalTargetQualification({
      ...common,
      expectedRegistryHash: selected(
        args,
        'registry-hash',
        'HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY_HASH',
        environment,
      ),
    });
    return Object.freeze({
      report: inspection,
      exitCode: args['require-ready'] === true && inspection.ready !== true ? 2 : 0,
    });
  }
  const importOptions = {
    ...common,
    candidatePath: args.candidate || null,
    expectedCandidateFileHash: args['candidate-hash'] || null,
  };
  if (action === 'import-plan') {
    return planPortalTargetQualificationImport(importOptions);
  }
  if (args.execute !== true) {
    throw new Error('portal_target_qualification_import_execute_confirmation_required');
  }
  return executePortalTargetQualificationImport({
    ...importOptions,
    expectedPlanHash: args['plan-hash'] || null,
  });
}

function main() {
  const result = runPortalTargetQualificationCli();
  const report = result?.report || result;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (Number.isInteger(result?.exitCode)) process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  }
}
