#!/usr/bin/env node
import path from 'node:path';

import {
  composeStrongGenericDomainCapabilityEvidenceStatus,
  convergeGenericDomainCapabilityEvidence,
} from '../../paper-composition/automation/generic-domain-capability-evidence-convergence.mjs';
import {
  defaultPaperAssetRoot,
  defaultPaperRuntimeRoot,
} from '../src/workspace-layout.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

function usage() {
  return [
    'Usage: node paper-core/bin/generic-domain-capability-evidence.mjs --action status|converge [options]',
    '',
    'converge discovers current persisted production authorities, runs formal-domain',
    'qualification only when required, and atomically publishes the verified aggregate.',
    'The command accepts no caller-supplied evidence. It re-verifies persisted production',
    'authorities and the current external Mathlib authority before atomic publication.',
    'Convergence obtains a dedicated external replay and separately signed independent',
    'review for the five formal-domain diagnostics. Status re-verifies current authority,',
    'semantic readiness, canonical evidence hash, and paper/campaign bindings without',
    'returning the persisted evidence or current candidate.',
  ].join('\n');
}

async function main() {
  const args = parseStrictCliArguments(process.argv.slice(2), {
    booleanFlags: ['help'],
    valueFlags: [
      'action', 'root', 'runtime-root', 'paper-id',
    ],
    positional: false,
  });
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const action = args.action || 'status';
  const paperId = String(args['paper-id'] || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/.test(paperId)) {
    throw new Error('generic_domain_capability_evidence_paper_id_required');
  }
  const runtimeRoot = path.resolve(args['runtime-root'] || defaultPaperRuntimeRoot());
  const root = path.resolve(args.root || defaultPaperAssetRoot());
  if (action === 'status') {
    const report = composeStrongGenericDomainCapabilityEvidenceStatus({
      root,
      runtimeRoot,
      paperId,
      environment: process.env,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ready) process.exitCode = 2;
    return;
  }
  if (action === 'converge') {
    const report = await convergeGenericDomainCapabilityEvidence({
      root,
      runtimeRoot,
      paperId,
      environment: process.env,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  throw new Error('generic_domain_capability_evidence_action_invalid');
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack || error)}\n`);
  process.exitCode = 1;
});
