#!/usr/bin/env node
import { runLegacyWorkflowProjectionBatch } from '../../paper-composition/compat/legacy-paper-batch-application.mjs';
import { renderBatchConsole } from '../src/paper-batch-runner.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import {
  buildPaperBatchCliOptions,
  parsePaperProductionArgs,
} from '../src/paper-production-cli-options.mjs';

function usage() {
  return `Usage:
  npm run compat:legacy-workflow-projection -- --mode <MODE> [--paper SLUG] [--execute] [--write-report] [--json]

This is an explicit non-authoritative compatibility command. It is not part of
the supported production operator graph.
`;
}

async function main() {
  const args = parsePaperProductionArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (!args.mode) throw new Error('legacy_workflow_projection_mode_required');
  const options = buildPaperBatchCliOptions(args, {
    defaultRoot: defaultPaperAssetRoot(),
    defaultRuntimeRoot: defaultPaperRuntimeRoot(),
  });
  const report = await runLegacyWorkflowProjectionBatch(options);
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : renderBatchConsole(report));
}

main().catch((error) => {
  process.stderr.write(error?.stack ? `${error.stack}\n` : `${String(error)}\n`);
  process.exitCode = 1;
});
