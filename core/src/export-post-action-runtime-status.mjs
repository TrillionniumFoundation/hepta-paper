#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  POST_ACTION_RUNTIME_STATUS_STAGES,
  buildPostActionRuntimeStatus,
} from './post-action-runtime-status.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = path.join(packageRoot, 'reports');

function readJsonReport(fileId) {
  const filePath = path.join(reportsDir, fileId);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readReportBindings() {
  return Object.fromEntries(POST_ACTION_RUNTIME_STATUS_STAGES.flatMap((stage) => {
    const report = readJsonReport(stage.reportFileId);
    return [
      [stage.stageId, report],
      [stage.reportFileId, report],
    ];
  }));
}

function markdownFor(report) {
  const lines = [
    '# Post-Action Runtime Status',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.postActionRuntimeStatusHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Stages passed: ${report.summary.passedStages}/${report.summary.stageCount}`,
    `- Routes/action classes: ${report.summary.routeCount}/${report.summary.actionClassCount}`,
    `- Completed routes: ${report.summary.completedRouteCount}`,
    `- External/internal runner locations: ${report.summary.externalWorkspaceRunnerCount}/${report.summary.internalWorkspaceRunnerCount}`,
    `- Upstream hash bindings: ${report.summary.upstreamBindingOkCount}/${report.summary.upstreamBindingCount}`,
    `- Required summary metrics: ${report.summary.requiredSummaryMetricOkCount}/${report.summary.requiredSummaryMetricCount}`,
    `- Final stage: ${report.summary.finalStageId}`,
    `- Final hash: ${report.summary.finalHash}`,
    `- Blockers: ${report.blockers.length}`,
    '',
    '## Stages',
    '',
    '| Stage | Status | Routes | Completed | Required metrics | Hash | Ready |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.stages.map((stage) => [
      `| ${stage.stageId}`,
      stage.status || 'missing',
      stage.routeCount ?? 'null',
      stage.completionCount ?? 'null',
      stage.requiredSummaryMetrics.length
        ? `${stage.requiredSummaryMetrics.filter((summaryMetric) => summaryMetric.ok).length}/${stage.requiredSummaryMetrics.length}`
        : 'n/a',
      stage.hash || 'null',
      stage.readyForDownstream ? 'yes' : 'no',
      '|',
    ].join(' | ')),
    '',
    '## Blockers',
    '',
    ...(report.blockers.length
      ? report.blockers.map((item) => `- ${item.stageId || 'runtime'} ${item.code}: ${item.notes || ''}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Summarizes existing local reports only.',
    '- Does not read channel state, run adapters, consume queues, dispatch runners, upload, submit, send messages, pay, accept, deploy, call providers/models, mutate lifecycle state, or grant execution permission.',
  ];
  return `${lines.join('\n')}\n`;
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildPostActionRuntimeStatus({
    reportBindings: readReportBindings(),
  });
  const reportFiles = writeLatestReportPair({
    report,
    fileId: 'post-action-runtime-status-latest.json',
    markdown: markdownFor(report),
  });

  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    postActionRuntimeStatusHash: report.postActionRuntimeStatusHash,
    summary: report.summary,
    blockers: report.blockers.map((blocker) => blocker.code),
    reportFiles: {
      json: relativeToWorkspace(reportFiles.latestJson),
      md: relativeToWorkspace(reportFiles.latestMd),
    },
  }, null, 2)}\n`);
  if (strict && !report.ok) process.exit(1);
}

if (isCliEntrypoint(import.meta.url)) main();
