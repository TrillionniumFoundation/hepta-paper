#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChannelImportAllowlist } from './channel-import-allowlist.mjs';
import { buildPackageRootImportMigrationPlan } from './package-root-import-migration.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = path.join(packageRoot, 'reports');

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function markdownFor(report) {
  const lines = [
    '# Package Root Import Migration Plan',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.migrationHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Planned specifier: ${report.plannedSpecifier}`,
    `- Channels: ${report.summary.passingChannels}/${report.summary.channelCount} passing`,
    `- Current core imports: ${report.summary.currentCoreImportCount}`,
    `- Package root imports: ${report.summary.packageRootImportCount}`,
    `- Migratable relative imports: ${report.summary.migratableRelativeImportCount}`,
    `- Non-migratable imports: ${report.summary.nonMigratableImportCount}`,
    `- File plans: ${report.summary.filePlanCount}`,
    `- Review-merge files: ${report.summary.reviewMergeFileCount}`,
    `- Package root resolver-ready channels: ${report.summary.packageRootResolverReadyChannels}/${report.summary.channelCount}`,
    `- Rewrite-ready channels: ${report.summary.rewriteReadyChannels}/${report.summary.channelCount}`,
    `- Rewrite ready: ${report.summary.rewriteReady}`,
    `- Rewrite blockers: ${report.summary.rewriteBlockerCount}`,
    `- Package root resolver hash: ${report.summary.packageRootResolverHash || 'null'}`,
    `- Package surface hash: ${report.summary.packageSurfaceHash || 'null'}`,
    `- Channel allowlist hash: ${report.summary.allowlistHash || 'null'}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Channels',
    '',
    '| Channel | Imports | Package root | Migratable relative | File plans | Resolver | Rewrite ready | Modules |',
    '| --- | ---: | ---: | ---: | ---: | --- | --- | --- |',
    ...report.channels.map((channel) => `| ${channel.channelId} | ${channel.currentImportCount} | ${channel.packageRootImportCount} | ${channel.migratableRelativeImportCount} | ${channel.filePlanCount} | ${channel.packageRootResolver.status} | ${channel.rewriteReady} | ${channel.moduleIds.join(', ') || 'none'} |`),
    '',
    '## File Plans',
    '',
    '| Channel | File | Imports | Modules | Risk |',
    '| --- | --- | ---: | --- | --- |',
    ...report.channels.flatMap((channel) => channel.filePlans.map((filePlan) => (
      `| ${channel.channelId} | ${filePlan.file} | ${filePlan.importCount} | ${filePlan.modules.join(', ')} | ${filePlan.riskLevel} |`
    ))),
    '',
    '## Blockers',
    '',
    ...(report.blockers.length
      ? report.blockers.map((item) => `- ${item.code}${item.file ? ` ${item.file}:${item.line}` : ''}: ${item.notes}`)
      : ['- none']),
    '',
    '## Rewrite Blockers',
    '',
    ...(report.rewriteBlockers.length
      ? report.rewriteBlockers.map((item) => `- ${item.code} ${item.channelId}: ${item.notes}`)
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Report-only migration plan.',
    '- Does not rewrite channel files.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    report,
    fileId: 'package-root-import-migration-latest.json',
    markdown: markdownFor(report),
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const generatedAt = new Date().toISOString();
  const report = buildPackageRootImportMigrationPlan({
    channelImportAllowlist: buildChannelImportAllowlist({ generatedAt }),
    packageSurfaceReport: readJson(path.join(reportsDir, 'package-surface-latest.json')),
    generatedAt,
  });
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    migrationHash: report.migrationHash,
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
