#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import { buildChannelImportAllowlist } from './channel-import-allowlist.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

function markdownFor(report) {
  const lines = [
    '# Channel Import Allowlist',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.allowlistHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Channels: ${report.summary.passingChannels}/${report.summary.channelCount} passing`,
    `- Imports: ${report.summary.importCount}`,
    `- Stable relative imports: ${report.summary.stableRelativeImportCount}`,
    `- Package root imports: ${report.summary.packageRootImportCount}`,
    `- Package deep src imports: ${report.summary.packageDeepSrcImportCount}`,
    `- Compatibility imports: ${report.summary.compatibilityImportCount}`,
    `- Internal imports: ${report.summary.internalImportCount}`,
    `- Unallowed stable imports: ${report.summary.unallowedStableImportCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Channels',
    '',
    '| Channel | Status | Imports | Stable relative | Package root | Package deep src | Compatibility | Internal | Unallowed stable |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.channels.map((channel) => `| ${channel.channelId} | ${channel.status} | ${channel.importCount} | ${channel.stableRelativeImportCount} | ${channel.packageRootImportCount} | ${channel.packageDeepSrcImportCount} | ${channel.compatibilityImportCount} | ${channel.internalImportCount} | ${channel.unallowedStableImportCount} |`),
    '',
    '## Allowed Modules',
    '',
    ...report.channels.flatMap((channel) => [
      `### ${channel.label}`,
      '',
      ...channel.allowedCoreModuleIds.map((moduleId) => `- ${moduleId}`),
      '',
    ]),
    '## Blockers',
    '',
    ...(report.blockers.length
      ? report.blockers.map((item) => `- ${item.code}${item.file ? ` ${item.file}:${item.line}` : ''}: ${item.notes}`)
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Local import scan only.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    report,
    fileId: 'channel-import-allowlist-latest.json',
    markdown: markdownFor(report),
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildChannelImportAllowlist();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    allowlistHash: report.allowlistHash,
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
