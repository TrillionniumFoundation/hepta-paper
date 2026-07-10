#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INTEGRATION_GATE_TOOLING_REPORT_FILE_IDS,
  buildIntegrationGateTooling,
} from './integration-gate-tooling.mjs';
import {
  CORE_COMPATIBILITY_MODULES,
  CORE_PUBLIC_MODULES,
} from './index.mjs';
import { reportHashForFileId } from './export-report-freshness.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = path.join(packageRoot, 'reports');

function readPackageJson() {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
}

function readPackageScripts(packageJson) {
  return Object.keys(packageJson.scripts || {}).sort((left, right) => left.localeCompare(right));
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readReportBindings() {
  const bindings = {};
  for (const fileId of INTEGRATION_GATE_TOOLING_REPORT_FILE_IDS) {
    const filePath = path.join(reportsDir, fileId);
    const report = readJson(filePath);
    bindings[fileId] = {
      exists: Boolean(report),
      ok: report?.ok === true || /^pass_|^ready_/.test(String(report?.status || '')),
      status: report?.status || null,
      hash: reportHashForFileId(report || {}, fileId),
      blockerCount: Array.isArray(report?.blockers) ? report.blockers.length : 0,
      file: relativeToWorkspace(filePath),
    };
  }
  return bindings;
}

export function buildIntegrationGateToolingReport({ generatedAt = new Date().toISOString() } = {}) {
  const packageJson = readPackageJson();
  return buildIntegrationGateTooling({
    publicModules: CORE_PUBLIC_MODULES,
    compatibilityModules: CORE_COMPATIBILITY_MODULES,
    scriptIds: readPackageScripts(packageJson),
    reportBindings: readReportBindings(),
    indexSource: fs.readFileSync(path.join(packageRoot, 'src', 'index.mjs'), 'utf8'),
    packageExports: packageJson.exports || {},
    generatedAt,
  });
}

function markdownFor(tooling) {
  const lines = [
    '# Integration Gate Tooling',
    '',
    `Status: ${tooling.status}`,
    `Hash: ${tooling.toolingHash}`,
    `Generated: ${tooling.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Stable module present: ${tooling.summary.stableModulePresent}`,
    `- CLI-only modules: ${tooling.summary.cliOnlyModuleCount}`,
    `- CLI-only modules still compatibility exports: ${tooling.summary.cliOnlyModulesStillCompatibilityExports.join(', ') || 'none'}`,
    `- Root audit export present: ${tooling.summary.rootAuditExportPresent}`,
    `- Package root export: ${tooling.summary.packageRootExport || 'null'}`,
    `- Package JSON export present: ${tooling.summary.packageJsonExportPresent}`,
    `- Package deep src exports: ${tooling.summary.packageDeepSrcExportCount}`,
    `- Package extra exports: ${tooling.summary.packageExtraExportCount}`,
    `- Package stable only: ${tooling.summary.packageStableOnly}`,
    `- Required scripts: ${tooling.summary.presentRequiredScriptCount}/${tooling.summary.requiredScriptCount}`,
    `- Reports ok: ${tooling.summary.okReportFileCount}/${tooling.summary.reportFileCount}`,
    `- Blockers: ${tooling.summary.blockerCount}`,
    '',
    '## Reports',
    '',
    '| Report | Status | Hash |',
    '| --- | --- | --- |',
    ...tooling.reports.map((report) => `| ${report.fileId} | ${report.status || 'missing'} | ${report.hash || 'null'} |`),
    '',
    '## Blockers',
    '',
    ...(tooling.blockers.length
      ? tooling.blockers.map((item) => `- ${item.code} ${item.moduleId || item.scriptId || item.fileId || item.exportKey || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Local architecture tooling metadata only.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(tooling) {
  return writeLatestReportPair({
    report: tooling,
    fileId: 'integration-gate-tooling-latest.json',
    markdown: markdownFor(tooling),
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const tooling = buildIntegrationGateToolingReport();
  const reportFiles = writeReports(tooling);
  process.stdout.write(`${JSON.stringify({
    ok: tooling.ok,
    status: tooling.status,
    toolingHash: tooling.toolingHash,
    summary: tooling.summary,
    blockers: tooling.blockers.map((item) => item.code),
    reportFiles: {
      json: relativeToWorkspace(reportFiles.latestJson),
      md: relativeToWorkspace(reportFiles.latestMd),
    },
  }, null, 2)}\n`);
  if (strict && !tooling.ok) process.exitCode = 1;
}

if (isCliEntrypoint(import.meta.url)) main();
