#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import { buildPackageRootImportRegressionReport } from './package-root-import-regression.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

function markdownFor(report) {
  const lines = [
    '# Package Root Import Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.regressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Expected bad imports: ${report.summary.expectedBadImportCount}`,
    `- Allowlist ok: ${report.summary.allowlistOk}`,
    `- Allowlist stable relative imports: ${report.summary.allowlistStableRelativeImportCount}`,
    `- Allowlist relative blockers: ${report.summary.allowlistRelativeBlockerCount}`,
    `- Migration ok: ${report.summary.migrationOk}`,
    `- Migration allowlist blockers: ${report.summary.migrationAllowlistBlockerCount}`,
    `- Migration non-migratable imports: ${report.summary.migrationNonMigratableImportCount}`,
    `- Migration non-migratable blockers: ${report.summary.migrationNonMigratableBlockerCount}`,
    `- Docs files scanned: ${report.summary.docsScannedFileCount}`,
    `- Docs import examples: ${report.summary.docsImportExampleCount}`,
    `- Docs forbidden core-src import examples: ${report.summary.docsForbiddenImportExampleCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Fixture',
    '',
    `- Forbidden blocker: ${report.fixture.forbiddenRelativeBlockerCode}`,
    '',
    '| Channel | File | Import |',
    '| --- | --- | --- |',
    ...Object.entries(report.fixture.channels).flatMap(([channelId, records]) => records.map((record) => (
      `| ${channelId} | ${record.file} | \`${record.importText.replace(/`/g, '\\`')}\` |`
    ))),
    '',
    '## Allowlist Blockers',
    '',
    ...(report.allowlistRegression.blockers.length
      ? report.allowlistRegression.blockers.map((item) => `- ${item.code}${item.file ? ` ${item.file}:${item.line}` : ''}`)
      : ['- none']),
    '',
    '## Migration Blockers',
    '',
    ...(report.migrationRegression.blockers.length
      ? report.migrationRegression.blockers.map((item) => `- ${item.code}${item.file ? ` ${item.file}:${item.line}` : ''}`)
      : ['- none']),
    '',
    '## Docs Import Policy',
    '',
    `- Scanned files: ${report.docsImportPolicy.scannedFileCount}`,
    `- Import examples: ${report.docsImportPolicy.importExampleCount}`,
    `- Forbidden import examples: ${report.docsImportPolicy.forbiddenImportExampleCount}`,
    '',
    ...(report.docsImportPolicy.forbiddenImportExamples.length
      ? report.docsImportPolicy.forbiddenImportExamples.map((item) => `- ${item.file}:${item.line} \`${item.specifier}\``)
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
    '- Scans Markdown import examples without editing docs.',
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
    fileId: 'package-root-import-regression-latest.json',
    markdown: markdownFor(report),
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildPackageRootImportRegressionReport();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    regressionHash: report.regressionHash,
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
