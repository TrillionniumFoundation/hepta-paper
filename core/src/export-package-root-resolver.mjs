#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import { buildPackageRootResolverReport } from './package-root-resolver.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

function markdownFor(report) {
  const lines = [
    '# Package Root Resolver',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.resolverHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Package: ${report.packageName}`,
    `- Package link ready: ${report.summary.packageLinkReady}`,
    `- Resolver-ready channels: ${report.summary.resolverReadyChannels}/${report.summary.channelCount}`,
    `- Root import-ready channels: ${report.summary.rootImportReadyChannels}/${report.summary.channelCount}`,
    `- Deep import-blocked channels: ${report.summary.deepImportBlockedChannels}/${report.summary.channelCount}`,
    `- Zero-compatibility channels: ${report.summary.zeroCompatibilityChannels}/${report.summary.channelCount}`,
    `- Zero-compatibility invariant channels: ${report.summary.zeroCompatibilityInvariantChannels}/${report.summary.channelCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Workspace Link',
    '',
    `- Path: ${report.packageLink.path}`,
    `- Status: ${report.packageLink.status}`,
    `- Symlink: ${report.packageLink.isSymlink}`,
    `- Target: ${report.packageLink.resolvedTarget || 'null'}`,
    `- Expected: ${report.packageLink.expectedTarget}`,
    '',
    '## Channels',
    '',
    '| Channel | Status | CWD | Root import | Public | Compat | Deep src |',
    '| --- | --- | --- | --- | ---: | ---: | --- |',
    ...report.channels.map((channel) => (
      `| ${channel.channelId} | ${channel.status} | ${channel.cwd || 'null'} | ${channel.rootImport.ok ? 'ok' : channel.rootImport.errorCode || 'error'} | ${channel.rootImport.publicModuleCount ?? 'null'} | ${channel.rootImport.compatibilityModuleCount ?? 'null'} | ${channel.deepImport.ok ? 'not blocked' : channel.deepImport.errorCode || 'error'} |`
    )),
    '',
    '## Blockers',
    '',
    ...(report.blockers.length
      ? report.blockers.map((item) => `- ${item.code}${item.cwd ? ` ${item.cwd}` : ''}: ${item.notes}`)
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Local resolver smoke test only.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    report,
    fileId: 'package-root-resolver-latest.json',
    markdown: markdownFor(report),
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildPackageRootResolverReport();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    resolverHash: report.resolverHash,
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
