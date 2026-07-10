#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  READ_ONLY_REPORT_CHAIN_STAGES,
  buildReadOnlyReportChain,
} from './read-only-report-chain.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = path.join(packageRoot, 'reports');

function readPackageScripts() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  return Object.keys(packageJson.scripts || {}).sort((left, right) => left.localeCompare(right));
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

const READ_ONLY_REPORT_HASH_KEYS_BY_FILE_ID = Object.freeze({
  'read-only-core-gate-latest.json': Object.freeze(['gateHash']),
  'read-only-closeout-latest.json': Object.freeze(['summaryHash']),
  'read-only-release-health-latest.json': Object.freeze(['healthHash']),
  'read-only-release-verification-latest.json': Object.freeze(['verificationHash']),
  'read-only-release-archive-latest.json': Object.freeze(['archiveHash']),
  'read-only-release-archive-closeout-latest.json': Object.freeze(['archiveCloseoutHash']),
});

function valueAtPath(source = {}, keyPath) {
  if (!keyPath) return null;
  return keyPath.split('.').reduce((value, key) => value?.[key], source) || null;
}

export function reportHash(report = {}, fileId = null) {
  for (const key of READ_ONLY_REPORT_HASH_KEYS_BY_FILE_ID[fileId] || []) {
    const value = valueAtPath(report, key);
    if (value) return value;
  }
  return null;
}

function readReportBindings() {
  const bindings = {};
  for (const fileId of READ_ONLY_REPORT_CHAIN_STAGES.flatMap((stage) => stage.reportFileIds)) {
    const filePath = path.join(reportsDir, fileId);
    const report = readJson(filePath);
    bindings[fileId] = {
      exists: Boolean(report),
      ok: report?.ok === true || report?.validationOk === true || /^ready_|^pass_/.test(String(report?.status || '')),
      status: report?.status || null,
      hash: reportHash(report || {}, fileId),
      blockerCount: Array.isArray(report?.blockers) ? report.blockers.length : 0,
      metrics: report?.metrics || {},
      file: relativeToWorkspace(filePath),
    };
  }
  return bindings;
}

export function buildReadOnlyReportChainReport({ generatedAt = new Date().toISOString() } = {}) {
  return buildReadOnlyReportChain({
    packageScriptIds: readPackageScripts(),
    reportBindings: readReportBindings(),
    generatedAt,
  });
}

function markdownFor(chain) {
  const lines = [
    '# Read-Only Report Chain',
    '',
    `Status: ${chain.status}`,
    `Hash: ${chain.chainHash}`,
    `Generated: ${chain.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Stages: ${chain.summary.passedStages}/${chain.summary.stageCount} passed`,
    `- Module bindings: ${chain.summary.moduleBindingCount}`,
    `- Package scripts: ${chain.summary.packageScriptCount}`,
    `- Report files: ${chain.summary.reportFileCount}`,
    `- Dispatch handoffs: ${chain.summary.dispatchReadyHandoffs}/${chain.summary.dispatchTotalHandoffs} ready; ${chain.summary.dispatchBlockedHandoffs} blocked`,
    `- Dispatch metric binding: ${chain.summary.readOnlyDispatchMetricCount}/${chain.summary.expectedReadOnlyDispatchMetricCount} ok=${chain.summary.readOnlyDispatchMetricsOk}`,
    `- Dashboard warnings/blockers: ${chain.summary.dashboardWarningCount}/${chain.summary.dashboardBlockerCount}`,
    '',
    '## Stages',
    '',
    '| Order | Stage | Status | Modules | Scripts | Reports |',
    '| ---: | --- | --- | ---: | --- | --- |',
    ...chain.stages.map((stage) => {
      const reports = stage.reports.map((report) => `${report.fileId}:${report.status || 'missing'}`).join('<br>');
      return `| ${stage.order} | ${stage.stageId} | ${stage.status} | ${stage.moduleBindings.length} | ${stage.packageScriptIds.join('<br>')} | ${reports} |`;
    }),
    '',
    '## Module Bindings',
    '',
    '| Module | Stage | Role | Exports |',
    '| --- | --- | --- | --- |',
    ...chain.moduleBindings.map((binding) => `| ${binding.moduleId} | ${binding.stageId} | ${binding.role} | ${binding.exportIds.join('<br>')} |`),
    '',
    '## Blockers',
    '',
    ...(chain.blockers.length
      ? chain.blockers.map((item) => `- ${item.code}: ${item.notes}`)
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Local read-only report chain only.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(chain) {
  return writeLatestReportPair({
    fileId: 'read-only-report-chain-latest.json',
    report: chain,
    markdown: markdownFor(chain),
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const chain = buildReadOnlyReportChainReport();
  const reportFiles = writeReports(chain);
  process.stdout.write(`${JSON.stringify({
    ok: chain.ok,
    status: chain.status,
    chainHash: chain.chainHash,
    summary: chain.summary,
    blockers: chain.blockers.map((item) => item.code),
    reportFiles: {
      json: relativeToWorkspace(reportFiles.latestJson),
      md: relativeToWorkspace(reportFiles.latestMd),
    },
  }, null, 2)}\n`);
  if (strict && !chain.ok) process.exitCode = 1;
}

if (isCliEntrypoint(import.meta.url)) main();
