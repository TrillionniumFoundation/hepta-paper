#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReportLineageTopologyReport,
} from './report-lineage-topology.mjs';
import {
  relativeToWorkspace,
  writeLatestReportPair,
} from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readPackageScripts() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  return Object.keys(packageJson.scripts || {});
}

function markdownFor(report) {
  const lines = [
    '# Report Lineage Topology',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.lineageTopologyHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual topology ok: ${report.summary.actualOk}`,
    `- Nodes: ${report.summary.nodeCount}`,
    `- Edges: ${report.summary.edgeCount}`,
    `- Required nodes: ${report.summary.nodeCount - report.summary.missingRequiredNodeCount}/${report.summary.requiredNodeCount}`,
    `- Gate steps: ${report.summary.gateStepCount}`,
    `- Checkpoint bindings: ${report.summary.checkpointBindingCount}`,
    `- Gate summary hash keys: ${report.summary.gateSummaryHashKeyCount}`,
    `- Package scripts: ${report.summary.packageScriptCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Nodes',
    '',
    '| Node | Report | Step | Hash key | Depends on |',
    '| --- | --- | --- | --- | --- |',
    ...report.topology.nodes.map((node) => `| ${node.nodeId} | ${node.fileId} | ${node.stepId || 'null'} | ${node.hashKey || 'null'} | ${node.dependsOn.join('<br>') || 'none'} |`),
    '',
    '## Scenarios',
    '',
    '| Scenario | Status | Expected blocker | Observed blockers |',
    '| --- | --- | --- | --- |',
    ...report.scenarios.map((scenario) => `| ${scenario.scenarioId} | ${scenario.status} | ${scenario.expectedBlockerCode} | ${scenario.observedBlockerCodes.join('<br>') || 'none'} |`),
    '',
    '## Blockers',
    '',
    ...(report.blockers.length
      ? report.blockers.map((item) => `- ${item.code} ${item.nodeId || item.fileId || item.scriptId || item.stepId || item.hashKey || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Reads local source and package metadata only.',
    '- Synthetic fixture proves missing required node, missing dependency, wrong order, cycle, missing script, missing checkpoint binding, and missing gate hash key fail closed.',
    '- Does not rewrite report files except this exported latest report.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    fileId: 'report-lineage-topology-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportLineageTopologyLatest({ generatedAt = new Date().toISOString() } = {}) {
  return buildReportLineageTopologyReport({
    gateSourceText: fs.readFileSync(path.join(packageRoot, 'src', 'integration-dependency-gate.mjs'), 'utf8'),
    checkpointSourceText: fs.readFileSync(path.join(packageRoot, 'src', 'export-architecture-checkpoint.mjs'), 'utf8'),
    packageScriptIds: readPackageScripts(),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportLineageTopologyLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    lineageTopologyHash: report.lineageTopologyHash,
    summary: report.summary,
    blockers: report.blockers.map((item) => item.code),
    reportFiles: {
      json: relativeToWorkspace(reportFiles.latestJson),
      md: relativeToWorkspace(reportFiles.latestMd),
    },
  }, null, 2)}\n`);
  if (strict && !report.ok) process.exitCode = 1;
}

if (isCliEntrypoint(import.meta.url)) main();
