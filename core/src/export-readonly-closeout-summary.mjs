import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReadOnlyCloseoutSummary } from './read-only-closeout-summary.mjs';
import { validateReadOnlyCoreGateReport } from './read-only-core-gate-validator.mjs';
import { writeTimestampedReportPair } from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = path.join(packageRoot, 'reports');
const defaultGatePath = path.join(reportsDir, 'read-only-core-gate-latest.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function reportStamp(generatedAt) {
  return String(generatedAt || new Date().toISOString()).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function renderMarkdown(summary) {
  return [
    '# Read-only Closeout Summary',
    '',
    `Generated at: ${summary.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Status: ${summary.status}`,
    `- OK: ${summary.ok ? 'yes' : 'no'}`,
    `- Summary hash: ${summary.summaryHash}`,
    `- Gate hash: ${summary.hashes.gateHash || 'missing'}`,
    `- Gate validation hash: ${summary.hashes.gateValidationHash || 'missing'}`,
    `- Failed steps: ${summary.metrics.failedStepCount}`,
    `- Public API modules: ${summary.metrics.publicApiModules}`,
    `- Samples: ${summary.metrics.sampleCount}`,
    `- Dispatch handoffs: ready=${summary.metrics.dispatchReadyHandoffs}, blocked=${summary.metrics.dispatchBlockedHandoffs}, total=${summary.metrics.dispatchTotalHandoffs}`,
    `- Dashboard warnings: ${summary.metrics.dashboardWarningCount}`,
    `- Blockers: ${summary.blockers.length}`,
    `- Warnings: ${summary.warnings.length}`,
    '',
    '## Artifacts',
    '',
    `- Gate JSON: ${summary.artifacts.gateReportFiles?.json || 'missing'}`,
    `- Gate Markdown: ${summary.artifacts.gateReportFiles?.markdown || 'missing'}`,
    `- Sample report: ${summary.artifacts.sampleReport || 'missing'}`,
    '',
    '## Boundary',
    '',
    '- Dashboard summary only.',
    '- Reads local gate/sample report evidence only.',
    '- No platform fetch, provider/model spend, live prepare, upload, submit, customer message, acceptance, payment, deployment, lifecycle state application, or execution permission.',
    '',
  ].join('\n');
}

function writeSummary(summary) {
  const stamp = reportStamp(summary.generatedAt);
  const reportFiles = {
    json: 'reports/read-only-closeout-latest.json',
    markdown: 'reports/read-only-closeout-latest.md',
    timestampedJson: `reports/read-only-closeout-${stamp}.json`,
    timestampedMarkdown: `reports/read-only-closeout-${stamp}.md`,
  };
  const summaryWithFiles = {
    ...summary,
    reportFiles,
  };
  writeTimestampedReportPair({
    report: summaryWithFiles,
    fileId: path.basename(reportFiles.json),
    markdownFileId: path.basename(reportFiles.markdown),
    timestampedFileId: path.basename(reportFiles.timestampedJson),
    timestampedMarkdownFileId: path.basename(reportFiles.timestampedMarkdown),
    markdown: renderMarkdown(summaryWithFiles),
  });
  return summaryWithFiles;
}

function main() {
  const requestedPath = process.argv.find((arg, index) => index > 1 && !arg.startsWith('-'));
  const gatePath = path.resolve(requestedPath || defaultGatePath);
  let gateReport = null;
  let readError = null;
  try {
    gateReport = readJson(gatePath);
  } catch (error) {
    readError = error;
  }

  const gateValidation = validateReadOnlyCoreGateReport({
    report: gateReport,
    actor: 'design-production-core.validate-readonly-core-gate',
  });
  const summary = buildReadOnlyCloseoutSummary({
    gateReport,
    gateValidation,
    actor: 'design-production-core.export-readonly-closeout-summary',
  });
  const shouldWrite = !process.argv.includes('--stdout-only');
  const output = shouldWrite ? writeSummary(summary) : summary;

  console.log(JSON.stringify({
    ok: output.ok,
    status: output.status,
    summaryHash: output.summaryHash,
    gateHash: output.hashes.gateHash,
    gateValidationHash: output.hashes.gateValidationHash,
    metrics: output.metrics,
    blockers: [
      ...(readError ? [{ level: 'error', code: 'gate_report_read_failed', notes: readError.message }] : []),
      ...output.blockers,
    ],
    warnings: output.warnings,
    reportFiles: output.reportFiles || null,
    safety: output.safety,
  }, null, 2));

  if (!output.ok) process.exitCode = 1;
}

main();
