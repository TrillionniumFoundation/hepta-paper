#!/usr/bin/env node

import path from 'node:path';

import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';
import { defaultPaperRuntimeRoot, HEPTA_WORKSPACE_ROOT } from '../src/workspace-layout.mjs';
import {
  inspectPersonalSelfHostedLocalEvidence,
} from '../verification/personal-self-hosted-local-observation.mjs';

export function parsePersonalSelfHostedReadinessArguments(argv) {
  return parseStrictCliArguments(argv, {
    booleanFlags: ['help', 'json', 'require-ready', 'gpu-enabled'],
    valueFlags: [
      'root', 'runtime-root', 'cpu-receipt', 'gpu-receipt', 'now',
    ],
    positional: false,
  });
}

function usage() {
  return Object.freeze({
    version: 1,
    kind: 'PersonalSelfHostedReadinessUsage',
    usage: 'personal-self-hosted-readiness [--root CODE_WORKSPACE] [--runtime-root PATH] [--cpu-receipt PATH] [--gpu-enabled --gpu-receipt PATH] [--require-ready]',
    profile: 'personal-self-hosted-v1',
    scope: 'single-user-private-local-only',
    effects: 'read-only; runs immutable local DB inspection, source scan, and reads canonical scientific/formal receipts; never mints authority or performs external actions',
    localEvidenceInputs: Object.freeze({
      root: 'code workspace used for exact commit/provenance and tracked-source scan (defaults to HEPTA_WORKSPACE_ROOT or process.cwd())',
      database: 'personal-local-database status/ledger/backup/restore-drill (schema floor 25)',
      formal: 'HEPTA_FORMAL_OPERATIONAL_RECEIPT or runtime/formal-operational/formal-operational-receipt.json',
      cpu: 'HEPTA_PERSONAL_CPU_RECEIPT or the CPU-oracle fields in runtime/gpu-personal/personal-gpu-operational-receipt.json; CPU is always enabled and requires a current process-isolated oracle receipt',
      gpu: 'HEPTA_PERSONAL_GPU_RECEIPT or runtime/gpu-personal/personal-gpu-operational-receipt.json (required with --gpu-enabled; GPU adds same-device replay)',
      runtimeBoundary: 'runtime defaults to the external sibling HEPTA_PAPER_RUNTIME_ROOT and must not overlap the code workspace',
      credentials: 'direct tracked-source secret scan plus owner-only runtime directory mode; no hand-authored receipt',
      authorReviewer: 'not applicable: single-operator-no-review-workflow',
      slo: 'optional automatic local health diagnostic; no hand-authored receipt',
    }),
    notApplicable: Object.freeze([
      'independent-external-authority-roles',
      'hardware-kms-hsm',
      'local-author-review-session-separation',
      'offhost-worm-custody',
      'venue-portal-live-submission',
      'oci-registry-attestation',
      'kubernetes-release-digest',
    ]),
    exitCodes: Object.freeze({ ready: 0, blocked: 2, invalid: 1 }),
  });
}

export async function runPersonalSelfHostedReadiness({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  environment = process.env,
  inspect = inspectPersonalSelfHostedLocalEvidence,
} = {}) {
  const args = parsePersonalSelfHostedReadinessArguments(argv);
  if (args.help) {
    const output = usage();
    stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return Object.freeze({ output, exitCode: 0 });
  }
  const root = path.resolve(args.root || environment.HEPTA_WORKSPACE_ROOT || HEPTA_WORKSPACE_ROOT || process.cwd());
  const runtimeRoot = path.resolve(
    args['runtime-root'] || environment.HEPTA_PAPER_RUNTIME_ROOT || defaultPaperRuntimeRoot(),
  );
  const selectedEnvironment = {
    ...environment,
    ...(args['gpu-enabled'] === true ? { HEPTA_PERSONAL_GPU_ENABLED: 'true' } : {}),
    ...(args['cpu-receipt'] ? { HEPTA_PERSONAL_CPU_RECEIPT: path.resolve(args['cpu-receipt']) } : {}),
    ...(args['gpu-receipt'] ? { HEPTA_PERSONAL_GPU_RECEIPT: path.resolve(args['gpu-receipt']) } : {}),
  };
  const output = await inspect({
    workspaceRoot: root,
    runtimeRoot,
    environment: selectedEnvironment,
    now: args.now ? new Date(args.now) : new Date(),
  });
  stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  const exitCode = args['require-ready'] === true
    && output.personalSelfHostedProductionReady !== true ? 2 : 0;
  return Object.freeze({ output, exitCode });
}

if (process.argv[1] && path.resolve(process.argv[1])
  === path.resolve(new URL(import.meta.url).pathname)) {
  runPersonalSelfHostedReadiness().then(({ exitCode }) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
