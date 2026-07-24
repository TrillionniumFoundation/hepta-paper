#!/usr/bin/env node
import path from 'node:path';

import {
  composeGenericDomainCapabilityEvidenceStatus,
} from '../../paper-composition/automation/generic-domain-capability-evidence-publication.mjs';
import {
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
    'review for the five formal-domain diagnostics; status performs no external action.',
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
  if (action === 'status') {
    const report = composeGenericDomainCapabilityEvidenceStatus({
      runtimeRoot,
      environment: process.env,
    });
    const observedPaperId = report.evidence
      ?.experimentIrExecutionAuthorityReceipt?.paperId || null;
    const paperBound = report.ready === true && observedPaperId === paperId;
    const output = Object.freeze({ ...report, paperId: observedPaperId, paperBound });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (!paperBound) process.exitCode = 1;
    return;
  }
  if (action === 'converge') {
    const report = await convergeGenericDomainCapabilityEvidence({
      root: path.resolve(args.root || defaultPaperAssetRoot()),
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
