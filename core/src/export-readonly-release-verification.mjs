import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReadOnlyReleaseVerificationBundle } from './read-only-release-verification-bundle.mjs';
import { validateReadOnlyReleaseHealthManifest } from './read-only-release-health-validator.mjs';
import { writeTimestampedReportPair } from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = path.join(packageRoot, 'reports');
const defaultReleaseHealthPath = path.join(reportsDir, 'read-only-release-health-latest.json');
const packageJsonPath = path.join(packageRoot, 'package.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function reportStamp(generatedAt) {
  return String(generatedAt || new Date().toISOString()).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function releaseVerificationReportFiles(generatedAt) {
  const stamp = reportStamp(generatedAt);
  return {
    json: 'reports/read-only-release-verification-latest.json',
    markdown: 'reports/read-only-release-verification-latest.md',
    timestampedJson: `reports/read-only-release-verification-${stamp}.json`,
    timestampedMarkdown: `reports/read-only-release-verification-${stamp}.md`,
  };
}

function renderMarkdown(bundle) {
  return [
    '# Read-only Release Verification',
    '',
    `Generated at: ${bundle.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Status: ${bundle.status}`,
    `- OK: ${bundle.ok ? 'yes' : 'no'}`,
    `- Verification hash: ${bundle.verificationHash}`,
    `- Health hash: ${bundle.hashes.healthHash || 'missing'}`,
    `- Release health validation hash: ${bundle.hashes.releaseHealthValidationHash || 'missing'}`,
    `- Public API modules: ${bundle.metrics.publicApiModules}`,
    `- Samples: ${bundle.metrics.sampleCount}`,
    `- Dispatch handoffs: ready=${bundle.metrics.dispatchReadyHandoffs}, blocked=${bundle.metrics.dispatchBlockedHandoffs}, total=${bundle.metrics.dispatchTotalHandoffs}`,
    `- Dashboard warnings: ${bundle.metrics.dashboardWarningCount}`,
    `- Blockers: ${bundle.blockers.length}`,
    `- Warnings: ${bundle.warnings.length}`,
    '',
    '## Checks',
    '',
    '| Check | OK | Status | Hash |',
    '| --- | --- | --- | --- |',
    ...bundle.checks.map((item) => `| ${item.name} | ${item.ok ? 'yes' : 'no'} | ${item.status || ''} | ${item.hash || ''} |`),
    '',
    '## Artifacts',
    '',
    `- Release health JSON: ${bundle.artifacts.releaseHealthReportFiles?.json || 'missing'}`,
    `- Release health Markdown: ${bundle.artifacts.releaseHealthReportFiles?.markdown || 'missing'}`,
    '',
    '## Boundary',
    '',
    '- Dashboard verification bundle only.',
    '- Reads local release health and validation evidence only.',
    '- No platform fetch, provider/model spend, live prepare, upload, submit, customer message, acceptance, payment, deployment, lifecycle state application, or execution permission.',
    '',
  ].join('\n');
}

function writeBundle(bundle) {
  const files = bundle.artifacts.releaseVerificationReportFiles || releaseVerificationReportFiles(bundle.generatedAt);
  writeTimestampedReportPair({
    report: bundle,
    fileId: path.basename(files.json),
    markdownFileId: path.basename(files.markdown),
    timestampedFileId: path.basename(files.timestampedJson),
    timestampedMarkdownFileId: path.basename(files.timestampedMarkdown),
    markdown: renderMarkdown(bundle),
  });
}

function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith('-'));
  const releaseHealthPath = path.resolve(positional[0] || defaultReleaseHealthPath);
  let packageMeta = { name: 'design-production-core', version: '0.0.0' };
  try {
    packageMeta = readJson(packageJsonPath);
  } catch {
    packageMeta = { name: 'design-production-core', version: '0.0.0' };
  }

  let releaseHealthManifest = null;
  const readErrors = [];
  try {
    releaseHealthManifest = readJson(releaseHealthPath);
  } catch (error) {
    readErrors.push(`release health manifest read failed: ${error.message}`);
  }

  const releaseHealthValidation = validateReadOnlyReleaseHealthManifest({
    manifest: releaseHealthManifest,
    actor: 'design-production-core.validate-readonly-release-health',
  });
  const generatedAt = new Date().toISOString();
  const bundle = buildReadOnlyReleaseVerificationBundle({
    releaseHealthManifest,
    releaseHealthValidation,
    packageName: packageMeta.name,
    packageVersion: packageMeta.version,
    actor: 'design-production-core.export-readonly-release-verification',
    generatedAt,
    reportFiles: releaseVerificationReportFiles(generatedAt),
    readErrors,
  });

  if (!args.includes('--stdout-only')) {
    writeBundle(bundle);
  }

  console.log(JSON.stringify({
    ok: bundle.ok,
    status: bundle.status,
    verificationHash: bundle.verificationHash,
    healthHash: bundle.hashes.healthHash,
    releaseHealthValidationHash: bundle.hashes.releaseHealthValidationHash,
    metrics: bundle.metrics,
    blockers: bundle.blockers,
    warnings: bundle.warnings,
    reportFiles: bundle.artifacts.releaseVerificationReportFiles,
    safety: bundle.safety,
  }, null, 2));

  if (!bundle.ok) process.exitCode = 1;
}

main();
