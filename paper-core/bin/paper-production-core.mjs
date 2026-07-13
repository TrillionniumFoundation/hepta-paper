#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runPaperBatch, renderBatchConsole, PAPER_BATCH_MODES } from '../src/paper-batch-runner.mjs';
import { ensureDir } from '../src/runtime/file-utils.mjs';
import { writeJsonFile, writeTextFile } from '../../paper-adapters/artifacts/write-artifact.mjs';
import { runPaperProposalAdapter } from '../../paper-adapters/proposal/index.mjs';
import { bootstrapPaperExecutionContext } from '../../paper-application/bootstrap/service-bootstrap.mjs';
import { withArtifactWriteContext } from '../../paper-adapters/artifacts/artifact-write-context.mjs';
import { currentCodeProvenance } from '../src/code-provenance.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  defaultPaperAssetRoot,
  defaultPaperRuntimeRoot,
} from '../src/workspace-layout.mjs';

function usage() {
  return `Usage:
  paper-production-core batch-run --mode <inventory|local-build|local-package|research-verify|journal-manage|empirical-analysis|venue-resolve|source-adapt|referee-review|referee-revise|local-review-loop|local-dry-run|reviewed-submit|legacy-cleanup> [--limit N] [--paper SLUG] [--target VENUE] [--quality-profile PROFILE] [--dataset-root PATH] [--benchmark-id ID] [--apply-manuscript] [--inventory-source auto|hepta|yaml|legacy-sqlite] [--max-rounds N] [--json] [--write-report] [--execute]

  Compatibility alias: --mode referee-autopilot maps to local-review-loop and has no academic acceptance authority.
  paper-production-core proposal --idea TEXT [--discipline NAME] [--venue NAME] [--title TEXT] [--paper SLUG] [--paper-type TYPE] [--material TEXT] [--constraint TEXT] [--approved] [--materialize-source] [--stage-inventory] [--json] [--write-report]
  paper-production-core selftest
`;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (['json', 'write-report', 'execute', 'include-retired', 'include-quarantined', 'approved', 'materialize-source', 'stage-inventory', 'apply-manuscript'].includes(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    i += 1;
    if (['paper', 'material', 'constraint'].includes(key)) {
      args.paper = args.paper || [];
      if (key === 'paper') {
        args.paper.push(value);
      } else {
        args[key] = args[key] || [];
        args[key].push(value);
      }
    } else {
      args[key] = value;
    }
  }
  return args;
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

async function writeProposalReport({ root, runtimeRoot = defaultPaperRuntimeRoot(), report }) {
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
  const args = parseArgs(process.argv.slice(2));
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
    const context = bootstrapPaperExecutionContext({ root, runtimeRoot, mode: 'proposal', execute: Boolean(args['materialize-source']), writeReport: Boolean(args['write-report']) });
    const report = await withArtifactWriteContext(context.services, async () => {
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
        approved: Boolean(args.approved),
        materializeSource: Boolean(args['materialize-source']),
        stageInventory: Boolean(args['stage-inventory']),
      });
      if (args['write-report']) await writeProposalReport({ root, runtimeRoot, report: proposal });
      return proposal;
    });
    process.stdout.write(args.json ? JSON.stringify(report, null, 2) + '\n' : renderProposalConsole(report));
    return;
  }
  if (command !== 'batch-run') {
    throw new Error(`Unknown command: ${command}`);
  }
  const mode = args.mode || PAPER_BATCH_MODES.INVENTORY;
  const root = args.root ? path.resolve(args.root) : defaultPaperAssetRoot();
  const report = await runPaperBatch({
    root,
    runtimeRoot: args['runtime-root'] ? path.resolve(args['runtime-root']) : defaultPaperRuntimeRoot(),
    mode,
    limit: args.limit ? Number(args.limit) : null,
    paperIds: args.paper || [],
    includeRetired: Boolean(args['include-retired']),
    includeQuarantined: Boolean(args['include-quarantined']),
    inventorySource: args['inventory-source'] || 'auto',
    execute: Boolean(args.execute),
    writeReport: Boolean(args['write-report']),
    maxRounds: args['max-rounds'] ? Number(args['max-rounds']) : 6,
    targetOverride: args.target || args.venue || null,
    datasetRoot: args['dataset-root'] || args.dataset || null,
    benchmarkId: args['benchmark-id'] || args.benchmark || null,
    applyManuscript: Boolean(args['apply-manuscript']),
    qualityProfile: args['quality-profile'] || null,
  });
  process.stdout.write(args.json ? JSON.stringify(report, null, 2) + '\n' : renderBatchConsole(report));
}

main().catch((error) => {
  process.stderr.write((error && error.stack) ? error.stack + '\n' : String(error) + '\n');
  process.exitCode = 1;
});
