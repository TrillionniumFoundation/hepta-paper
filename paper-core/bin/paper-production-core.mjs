#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  runPaperBatch,
  renderBatchConsole,
} from '../../paper-composition/batch/paper-batch-application.mjs';
import { ensureDir, readJsonIfExists } from '../../workflow-kernel/runtime/file-utils.mjs';
import {
  runPaperProposalAdapter,
  withArtifactWriteContext,
  writeJsonFile,
  writeTextFile,
} from '../../paper-composition/bootstrap/operator-artifact-composition.mjs';
import { bootstrapBatchInventoryContext } from '../../paper-composition/bootstrap/batch-inventory-context-bootstrap.mjs';
import { currentCodeProvenance } from '../src/code-provenance.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  defaultPaperAssetRoot,
  defaultPaperRuntimeRoot,
} from '../src/workspace-layout.mjs';
import {
  buildPaperBatchCliOptions,
  parsePaperProductionArgs,
} from '../src/paper-production-cli-options.mjs';

// Preserve the hash-bound migration target symbol after moving CLI parsing
// into its bounded helper. Runtime mode ownership remains in paper-domain.
export { PAPER_BATCH_MODES } from '../../paper-domain/workflow/mode-registry.mjs';

function usage() {
  return `Usage:
  paper-production-core batch-run --mode <inventory|local-build|local-package|research-verify|empirical-analysis|referee-review|referee-revise|local-review-loop|local-dry-run|reviewed-submit> [--limit N] [--paper SLUG] [--target VENUE] [--quality-profile PROFILE] [--dataset-root PATH] [--dataset-license SPDX] [--dataset-authorization sha256:...] [--benchmark-id ID] [--apply-manuscript] [--inventory-source auto|hepta|sqlite|yaml] [--max-rounds N] [--json] [--write-report] [--execute]

  Compatibility alias: --mode referee-autopilot maps to local-review-loop and has no academic acceptance authority.
  Unsupported production vocabulary: journal-manage, venue-resolve, source-adapt. Preview and --execute both fail closed; use only an explicit compatibility entrypoint for legacy projection work.
  paper-production-core proposal --idea TEXT [--discipline NAME] [--venue NAME] [--title TEXT] [--paper SLUG] [--paper-type TYPE] [--material TEXT] [--constraint TEXT] [--scientific-claim-document PATH] [--approval-document PATH] [--materialize-source] [--stage-inventory] [--json] [--write-report]
  paper-production-core selftest
`;
}

function renderProposalConsole(report) {
  const proposal = report.proposalEnvelope?.proposal || {};
  return [
    'paper-production-core proposal',
    JSON.stringify(report.summary),
    '',
    `title: ${proposal.tentativeTitle || ''}`,
    `central_thesis: ${proposal.centralThesis || ''}`,
    '',
    'contribution_claims:',
    ...(proposal.contributionClaims || []).map((item) => `- ${item}`),
    '',
  ].join('\n');
}

async function writeProposalReport({ runtimeRoot = defaultPaperRuntimeRoot(), report }) {
  await ensureDir(path.join(runtimeRoot, 'reports'));
  const stamp = report.generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const paperId = report.summary.paperId || 'paper_proposal';
  const base = path.join(runtimeRoot, 'reports', `paper-proposal-${paperId}-${stamp}`);
  const latest = path.join(runtimeRoot, 'reports', 'paper-proposal-latest');
  const md = [
    '# Paper Proposal',
    '',
    '## Summary',
    '',
    '```json',
    JSON.stringify(report.summary, null, 2),
    '```',
    '',
    '## Proposal',
    '',
    '```json',
    JSON.stringify(report.proposalEnvelope?.proposal || {}, null, 2),
    '```',
    '',
    '## Review Gate',
    '',
    '```json',
    JSON.stringify(report.reviewGate || {}, null, 2),
    '```',
  ].join('\n');
  const codeProvenance = currentCodeProvenance();
  const boundReport = { ...report, codeProvenance };
  const reportHash = hashRecord('PaperProposalReport', boundReport);
  const pointer = {
    version: 1,
    kind: 'CurrentReportPointer',
    status: 'current_report_pointer',
    mode: 'proposal',
    reportPath: path.basename(base + '.json'),
    reportHash,
    generatedAt: report.generatedAt,
    validUntil: new Date(Date.parse(report.generatedAt) + 24 * 60 * 60 * 1000).toISOString(),
    codeProvenance,
  };
  await writeJsonFile(base + '.json', { ...boundReport, reportHash });
  await writeTextFile(base + '.md', md);
  await writeJsonFile(latest + '.json', pointer);
  await writeTextFile(latest + '.md', ['# Current report pointer', '', '```json', JSON.stringify(pointer, null, 2), '```', ''].join('\n'));
}

async function main() {
  const args = parsePaperProductionArgs(process.argv.slice(2));
  if (Object.hasOwn(args, 'legacy-workflow-projection')) {
    throw new Error('legacy_workflow_projection_removed_use_compat_script');
  }
  const command = args._[0];
  if (!command || args.help) {
    process.stdout.write(usage());
    return;
  }
  if (command === 'selftest') {
    const result = spawnSync('npm', ['test'], { cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'), stdio: 'inherit' });
    if (result.status !== 0) process.exitCode = result.status || 1;
    return;
  }
  if (command === 'proposal') {
    const root = args.root ? path.resolve(args.root) : defaultPaperAssetRoot();
    const runtimeRoot = args['runtime-root'] ? path.resolve(args['runtime-root']) : defaultPaperRuntimeRoot();
    const approvalDocumentPath = args['approval-document']
      ? path.resolve(args['approval-document'])
      : null;
    const scientificClaimDocumentPath = args['scientific-claim-document']
      ? path.resolve(args['scientific-claim-document'])
      : null;
    const approvalDocument = approvalDocumentPath
      ? await readJsonIfExists(approvalDocumentPath)
      : null;
    const scientificClaimDocument = scientificClaimDocumentPath
      ? await readJsonIfExists(scientificClaimDocumentPath)
      : null;
    if (approvalDocumentPath && !approvalDocument) throw new Error('proposal_approval_document_not_found');
    if (scientificClaimDocumentPath && !scientificClaimDocument) {
      throw new Error('proposal_scientific_claim_document_not_found');
    }
    const proposalWrites = Boolean(args['materialize-source'] || args['stage-inventory'] || args['write-report']);
    const context = bootstrapBatchInventoryContext({
      root,
      runtimeRoot,
      mode: 'proposal',
      execute: false,
      writeReport: Boolean(args['write-report']),
      readOnly: !proposalWrites,
      allowMissingReadOnlyStore: !proposalWrites,
    });
    let report;
    try {
      report = await withArtifactWriteContext(context.services, async () => {
        const proposal = await runPaperProposalAdapter({
          root,
          runtimeRoot,
          idea: args.idea,
          paperId: (args.paper || [])[0] || null,
          title: args.title || null,
          discipline: args.discipline || null,
          venue: args.venue || null,
          paperType: args['paper-type'] || null,
          materials: args.material || [],
          constraints: args.constraint || [],
          riskPreference: args['risk-preference'] || null,
          scientificClaimDocument,
          approvalDocument,
          materializeSource: Boolean(args['materialize-source']),
          stageInventory: Boolean(args['stage-inventory']),
        });
        if (args['write-report']) await writeProposalReport({ root, runtimeRoot, report: proposal });
        return proposal;
      });
    } finally {
      context.services.persistenceSession.close?.();
    }
    process.stdout.write(args.json ? JSON.stringify(report, null, 2) + '\n' : renderProposalConsole(report));
    return;
  }
  if (command !== 'batch-run') {
    throw new Error(`Unknown command: ${command}`);
  }
  const batchOptions = buildPaperBatchCliOptions(args, {
    defaultRoot: defaultPaperAssetRoot(),
    defaultRuntimeRoot: defaultPaperRuntimeRoot(),
  });
  const report = await runPaperBatch(batchOptions);
  process.stdout.write(args.json ? JSON.stringify(report, null, 2) + '\n' : renderBatchConsole(report));
}

main().catch((error) => {
  process.stderr.write((error && error.stack) ? error.stack + '\n' : String(error) + '\n');
  process.exitCode = 1;
});
