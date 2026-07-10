#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import { buildPackageRootSymbolMinimizationReport } from './package-root-symbol-minimization.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

function markdownFor(report) {
  const lines = [
    '# Package Root Symbol Minimization',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.symbolMinimizationHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Source manifest ok: ${report.sourceSymbolManifest.ok}`,
    `- Source manifest hash: ${report.sourceSymbolManifest.hash}`,
    `- Channels: ${report.summary.passingChannels}/${report.summary.channelCount} passing`,
    `- Imported symbols: ${report.summary.importedSymbolCount}`,
    `- Unique imported symbols: ${report.summary.uniqueImportedSymbolCount}`,
    `- Manifest symbols: ${report.summary.manifestSymbolCount}`,
    `- Unique manifest symbols: ${report.summary.uniqueManifestSymbolCount}`,
    `- Exact-current manifest symbols: ${report.summary.exactCurrentManifestSymbolCount}`,
    `- Unused allowed symbols: ${report.summary.unusedAllowedSymbolCount}`,
    `- Shrinkable symbols: ${report.summary.shrinkableSymbolCount}`,
    `- Shrinkable channels: ${report.summary.shrinkableChannelCount}`,
    `- Minimization ready: ${report.summary.minimizationReady}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Channels',
    '',
    '| Channel | Status | Manifest | Exact current | Unused | Shrinkable |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
    ...report.channels.map((channel) => `| ${channel.channelId} | ${channel.status} | ${channel.manifestSymbolCount} | ${channel.proposedSymbolCount} | ${channel.unusedAllowedSymbols.length} | ${channel.shrinkableSymbolCount} |`),
    '',
    '## Unused Allowed Symbols',
    '',
    ...report.channels.flatMap((channel) => [
      `### ${channel.label}`,
      '',
      ...(channel.unusedAllowedSymbols.length
        ? channel.unusedAllowedSymbols.map((symbol) => `- ${symbol}`)
        : ['- none']),
      '',
    ]),
    '## Exact Current Proposal',
    '',
    ...report.channels.flatMap((channel) => [
      `### ${channel.label}`,
      '',
      ...channel.proposedAllowedSymbols.map((symbol) => `- ${symbol}`),
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
    '- Report-only exact-current manifest plan.',
    '- Does not edit channel files or the symbol manifest.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    report,
    fileId: 'package-root-symbol-minimization-latest.json',
    markdown: markdownFor(report),
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildPackageRootSymbolMinimizationReport();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    symbolMinimizationHash: report.symbolMinimizationHash,
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
