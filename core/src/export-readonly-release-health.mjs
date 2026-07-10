import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReadOnlyReleaseHealthManifest } from './read-only-release-health-manifest.mjs';
import { validateReadOnlyCloseoutSummary } from './read-only-closeout-validator.mjs';
import { validateReadOnlyCoreGateReport } from './read-only-core-gate-validator.mjs';
import { writeTimestampedReportPair } from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = path.join(packageRoot, 'reports');
const defaultGatePath = path.join(reportsDir, 'read-only-core-gate-latest.json');
const defaultCloseoutPath = path.join(reportsDir, 'read-only-closeout-latest.json');
const packageJsonPath = path.join(packageRoot, 'package.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function reportStamp(generatedAt) {
  return String(generatedAt || new Date().toISOString()).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function releaseHealthReportFiles(generatedAt) {
  const stamp = reportStamp(generatedAt);
  return {
    json: 'reports/read-only-release-health-latest.json',
    markdown: 'reports/read-only-release-health-latest.md',
    timestampedJson: `reports/read-only-release-health-${stamp}.json`,
    timestampedMarkdown: `reports/read-only-release-health-${stamp}.md`,
  };
}

function renderMarkdown(manifest) {
  return [
    '# Read-only Release Health',
    '',
    `Generated at: ${manifest.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Status: ${manifest.status}`,
    `- OK: ${manifest.ok ? 'yes' : 'no'}`,
    `- Health hash: ${manifest.healthHash}`,
    `- Package: ${manifest.package.name}@${manifest.package.version}`,
    `- Gate hash: ${manifest.hashes.gateHash || 'missing'}`,
    `- Gate validation hash: ${manifest.hashes.gateValidationHash || 'missing'}`,
    `- Closeout summary hash: ${manifest.hashes.closeoutSummaryHash || 'missing'}`,
    `- Closeout validation hash: ${manifest.hashes.closeoutValidationHash || 'missing'}`,
    `- Public API modules: ${manifest.metrics.publicApiModules}`,
    `- Samples: ${manifest.metrics.sampleCount}`,
    `- Dispatch handoffs: ready=${manifest.metrics.dispatchReadyHandoffs}, blocked=${manifest.metrics.dispatchBlockedHandoffs}, total=${manifest.metrics.dispatchTotalHandoffs}`,
    `- Dashboard warnings: ${manifest.metrics.dashboardWarningCount}`,
    `- Blockers: ${manifest.blockers.length}`,
    `- Warnings: ${manifest.warnings.length}`,
    '',
    '## Checks',
    '',
    '| Check | OK | Status | Hash |',
    '| --- | --- | --- | --- |',
    ...manifest.checks.map((item) => `| ${item.name} | ${item.ok ? 'yes' : 'no'} | ${item.status || ''} | ${item.hash || ''} |`),
    '',
    '## Artifacts',
    '',
    `- Gate JSON: ${manifest.artifacts.gateReportFiles?.json || 'missing'}`,
    `- Gate Markdown: ${manifest.artifacts.gateReportFiles?.markdown || 'missing'}`,
    `- Closeout JSON: ${manifest.artifacts.closeoutReportFiles?.json || 'missing'}`,
    `- Closeout Markdown: ${manifest.artifacts.closeoutReportFiles?.markdown || 'missing'}`,
    `- Sample report: ${manifest.artifacts.sampleReport || 'missing'}`,
    '',
    '## Boundary',
    '',
    '- Dashboard health manifest only.',
    '- Reads local gate, closeout, and validation evidence only.',
    '- No platform fetch, provider/model spend, live prepare, upload, submit, customer message, acceptance, payment, deployment, lifecycle state application, or execution permission.',
    '',
  ].join('\n');
}

function writeManifest(manifest) {
  const files = manifest.artifacts.releaseHealthReportFiles || releaseHealthReportFiles(manifest.generatedAt);
  writeTimestampedReportPair({
    report: manifest,
    fileId: path.basename(files.json),
    markdownFileId: path.basename(files.markdown),
    timestampedFileId: path.basename(files.timestampedJson),
    timestampedMarkdownFileId: path.basename(files.timestampedMarkdown),
    markdown: renderMarkdown(manifest),
  });
}

function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith('-'));
  const gatePath = path.resolve(positional[0] || defaultGatePath);
  const closeoutPath = path.resolve(positional[1] || defaultCloseoutPath);
  let packageMeta = { name: 'design-production-core', version: '0.0.0' };
  try {
    packageMeta = readJson(packageJsonPath);
  } catch {
    packageMeta = { name: 'design-production-core', version: '0.0.0' };
  }

  let gateReport = null;
  let closeoutSummary = null;
  const readErrors = [];
  try {
    gateReport = readJson(gatePath);
  } catch (error) {
    readErrors.push(`gate report read failed: ${error.message}`);
  }
  try {
    closeoutSummary = readJson(closeoutPath);
  } catch (error) {
    readErrors.push(`closeout summary read failed: ${error.message}`);
  }

  const gateValidation = validateReadOnlyCoreGateReport({
    report: gateReport,
    actor: 'design-production-core.validate-readonly-core-gate',
  });
  const closeoutValidation = validateReadOnlyCloseoutSummary({
    summary: closeoutSummary,
    actor: 'design-production-core.validate-readonly-closeout',
  });
  const generatedAt = new Date().toISOString();
  const manifest = buildReadOnlyReleaseHealthManifest({
    gateReport,
    gateValidation,
    closeoutSummary,
    closeoutValidation,
    packageName: packageMeta.name,
    packageVersion: packageMeta.version,
    actor: 'design-production-core.export-readonly-release-health',
    generatedAt,
    reportFiles: releaseHealthReportFiles(generatedAt),
    readErrors,
  });

  if (!args.includes('--stdout-only')) {
    writeManifest(manifest);
  }

  console.log(JSON.stringify({
    ok: manifest.ok,
    status: manifest.status,
    healthHash: manifest.healthHash,
    gateHash: manifest.hashes.gateHash,
    closeoutSummaryHash: manifest.hashes.closeoutSummaryHash,
    closeoutValidationHash: manifest.hashes.closeoutValidationHash,
    metrics: manifest.metrics,
    blockers: manifest.blockers,
    warnings: manifest.warnings,
    reportFiles: manifest.artifacts.releaseHealthReportFiles,
    safety: manifest.safety,
  }, null, 2));

  if (!manifest.ok) process.exitCode = 1;
}

main();
