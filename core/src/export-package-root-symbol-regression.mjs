#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import { buildPackageRootSymbolRegressionReport } from './package-root-symbol-regression.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

function markdownFor(report) {
  const lines = [
    '# Package Root Symbol Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.symbolRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Symbol manifest ok: ${report.summary.symbolManifestOk}`,
    `- Namespace imports: ${report.summary.namespaceImportCount}`,
    `- Default imports: ${report.summary.defaultImportCount}`,
    `- Unallowed symbols: ${report.summary.unallowedSymbolCount}`,
    `- Missing package exports: ${report.summary.missingPackageExportCount}`,
    `- Namespace blockers: ${report.summary.namespaceBlockerCount}`,
    `- Default blockers: ${report.summary.defaultBlockerCount}`,
    `- Unallowed symbol blockers: ${report.summary.unallowedBlockerCount}`,
    `- Missing export blockers: ${report.summary.missingExportBlockerCount}`,
    `- Symbol manifest blockers: ${report.summary.symbolManifestBlockerCount}`,
    `- Regression blockers: ${report.summary.blockerCount}`,
    '',
    '## Fixture',
    '',
    '| Channel | File | Import |',
    '| --- | --- | --- |',
    ...Object.entries(report.fixture.channels).flatMap(([channelId, records]) => records.map((record) => (
      `| ${channelId} | ${record.file} | \`${record.importText.replace(/`/g, '\\`')}\` |`
    ))),
    '',
    '## Symbol Manifest Blockers',
    '',
    ...(report.symbolManifestRegression.blockers.length
      ? report.symbolManifestRegression.blockers.map((item) => `- ${item.code}${item.file ? ` ${item.file}:${item.line}` : ''}${item.importedName ? ` ${item.importedName}` : ''}`)
      : ['- none']),
    '',
    '## Regression Blockers',
    '',
    ...(report.blockers.length
      ? report.blockers.map((item) => `- ${item.code}: ${item.notes}`)
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Synthetic fixture only.',
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
    fileId: 'package-root-symbol-regression-latest.json',
    markdown: markdownFor(report),
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildPackageRootSymbolRegressionReport();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    symbolRegressionHash: report.symbolRegressionHash,
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
