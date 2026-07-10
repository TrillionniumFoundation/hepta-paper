#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import { buildPackageRootSymbolManifestReport } from './package-root-symbol-manifest.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

function markdownFor(report) {
  const lines = [
    '# Package Root Symbol Manifest',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.symbolManifestHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Channels: ${report.summary.passingChannels}/${report.summary.channelCount} passing`,
    `- Imported symbols: ${report.summary.importedSymbolCount}`,
    `- Unique imported symbols: ${report.summary.uniqueImportedSymbolCount}`,
    `- Manifest symbols: ${report.summary.manifestSymbolCount}`,
    `- Namespace imports: ${report.summary.namespaceImportCount}`,
    `- Default imports: ${report.summary.defaultImportCount}`,
    `- Unallowed symbols: ${report.summary.unallowedSymbolCount}`,
    `- Missing package exports: ${report.summary.missingPackageExportCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Channels',
    '',
    '| Channel | Status | Imports | Unique | Manifest | Unallowed | Missing exports | Namespace | Default |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.channels.map((channel) => `| ${channel.channelId} | ${channel.status} | ${channel.importedSymbolCount} | ${channel.uniqueImportedSymbolCount} | ${channel.manifestSymbolCount} | ${channel.unallowedSymbolCount} | ${channel.missingPackageExportCount} | ${channel.namespaceImportCount} | ${channel.defaultImportCount} |`),
    '',
    '## Imported Symbols',
    '',
    ...report.channels.flatMap((channel) => [
      `### ${channel.label}`,
      '',
      ...channel.importedSymbols.map((symbol) => `- ${symbol}`),
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
    '- Local package-root named import scan only.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    report,
    fileId: 'package-root-symbol-manifest-latest.json',
    markdown: markdownFor(report),
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildPackageRootSymbolManifestReport();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    symbolManifestHash: report.symbolManifestHash,
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
