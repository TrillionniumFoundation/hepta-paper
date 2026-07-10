import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReadOnlyReleaseArchiveManifest } from './read-only-release-archive-manifest.mjs';
import { validateReadOnlyReleaseVerificationBundle } from './read-only-release-verification-validator.mjs';
import { writeTimestampedReportPair } from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = path.join(packageRoot, 'reports');
const defaultReleaseVerificationPath = path.join(reportsDir, 'read-only-release-verification-latest.json');
const packageJsonPath = path.join(packageRoot, 'package.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function reportStamp(generatedAt) {
  return String(generatedAt || new Date().toISOString()).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function releaseArchiveReportFiles(generatedAt) {
  const stamp = reportStamp(generatedAt);
  return {
    json: 'reports/read-only-release-archive-latest.json',
    markdown: 'reports/read-only-release-archive-latest.md',
    timestampedJson: `reports/read-only-release-archive-${stamp}.json`,
    timestampedMarkdown: `reports/read-only-release-archive-${stamp}.md`,
  };
}

function renderMarkdown(manifest) {
  return [
    '# Read-only Release Archive',
    '',
    `Generated at: ${manifest.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Status: ${manifest.status}`,
    `- OK: ${manifest.ok ? 'yes' : 'no'}`,
    `- Ready for archive: ${manifest.readyForArchive ? 'yes' : 'no'}`,
    `- Archive hash: ${manifest.archiveHash}`,
    `- Verification hash: ${manifest.hashes.verificationHash || 'missing'}`,
    `- Verification validation hash: ${manifest.hashes.releaseVerificationValidationHash || 'missing'}`,
    `- Health hash: ${manifest.hashes.healthHash || 'missing'}`,
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
    `- Release verification JSON: ${manifest.artifacts.releaseVerificationReportFiles?.json || 'missing'}`,
    `- Release verification Markdown: ${manifest.artifacts.releaseVerificationReportFiles?.markdown || 'missing'}`,
    '',
    '## Boundary',
    '',
    '- Dashboard/archive manifest only.',
    '- Reads local release verification and validation evidence only.',
    '- No platform fetch, provider/model spend, live prepare, upload, submit, customer message, acceptance, payment, deployment, lifecycle state application, or execution permission.',
    '',
  ].join('\n');
}

function writeManifest(manifest) {
  const files = manifest.artifacts.releaseArchiveReportFiles || releaseArchiveReportFiles(manifest.generatedAt);
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
  const releaseVerificationPath = path.resolve(positional[0] || defaultReleaseVerificationPath);
  let packageMeta = { name: 'design-production-core', version: '0.0.0' };
  try {
    packageMeta = readJson(packageJsonPath);
  } catch {
    packageMeta = { name: 'design-production-core', version: '0.0.0' };
  }

  let releaseVerificationBundle = null;
  const readErrors = [];
  try {
    releaseVerificationBundle = readJson(releaseVerificationPath);
  } catch (error) {
    readErrors.push(`release verification bundle read failed: ${error.message}`);
  }

  const releaseVerificationValidation = validateReadOnlyReleaseVerificationBundle({
    bundle: releaseVerificationBundle,
    actor: 'design-production-core.validate-readonly-release-verification',
  });
  const generatedAt = new Date().toISOString();
  const manifest = buildReadOnlyReleaseArchiveManifest({
    releaseVerificationBundle,
    releaseVerificationValidation,
    packageName: packageMeta.name,
    packageVersion: packageMeta.version,
    actor: 'design-production-core.export-readonly-release-archive',
    generatedAt,
    reportFiles: releaseArchiveReportFiles(generatedAt),
    readErrors,
  });

  if (!args.includes('--stdout-only')) {
    writeManifest(manifest);
  }

  console.log(JSON.stringify({
    ok: manifest.ok,
    status: manifest.status,
    archiveHash: manifest.archiveHash,
    verificationHash: manifest.hashes.verificationHash,
    releaseVerificationValidationHash: manifest.hashes.releaseVerificationValidationHash,
    metrics: manifest.metrics,
    blockers: manifest.blockers,
    warnings: manifest.warnings,
    reportFiles: manifest.artifacts.releaseArchiveReportFiles,
    safety: manifest.safety,
  }, null, 2));

  if (!manifest.ok) process.exitCode = 1;
}

main();
