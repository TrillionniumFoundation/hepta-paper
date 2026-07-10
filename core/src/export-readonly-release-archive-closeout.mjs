import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReadOnlyReleaseArchiveCloseoutBundle } from './read-only-release-archive-closeout-bundle.mjs';
import { validateReadOnlyReleaseArchiveManifest } from './read-only-release-archive-validator.mjs';
import { writeTimestampedReportPair } from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = path.join(packageRoot, 'reports');
const defaultReleaseArchivePath = path.join(reportsDir, 'read-only-release-archive-latest.json');
const packageJsonPath = path.join(packageRoot, 'package.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function reportStamp(generatedAt) {
  return String(generatedAt || new Date().toISOString()).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function releaseArchiveCloseoutReportFiles(generatedAt) {
  const stamp = reportStamp(generatedAt);
  return {
    json: 'reports/read-only-release-archive-closeout-latest.json',
    markdown: 'reports/read-only-release-archive-closeout-latest.md',
    timestampedJson: `reports/read-only-release-archive-closeout-${stamp}.json`,
    timestampedMarkdown: `reports/read-only-release-archive-closeout-${stamp}.md`,
  };
}

function renderMarkdown(bundle) {
  return [
    '# Read-only Release Archive Closeout',
    '',
    `Generated at: ${bundle.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Status: ${bundle.status}`,
    `- OK: ${bundle.ok ? 'yes' : 'no'}`,
    `- Ready for archive: ${bundle.readyForArchive ? 'yes' : 'no'}`,
    `- Archive closeout hash: ${bundle.archiveCloseoutHash}`,
    `- Archive hash: ${bundle.hashes.archiveHash || 'missing'}`,
    `- Archive validation hash: ${bundle.hashes.releaseArchiveValidationHash || 'missing'}`,
    `- Verification hash: ${bundle.hashes.verificationHash || 'missing'}`,
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
    `- Release archive JSON: ${bundle.artifacts.releaseArchiveReportFiles?.json || 'missing'}`,
    `- Release archive Markdown: ${bundle.artifacts.releaseArchiveReportFiles?.markdown || 'missing'}`,
    '',
    '## Boundary',
    '',
    '- Dashboard/archive closeout bundle only.',
    '- Reads local release archive and validation evidence only.',
    '- No platform fetch, provider/model spend, live prepare, upload, submit, customer message, acceptance, payment, deployment, lifecycle state application, or execution permission.',
    '',
  ].join('\n');
}

function writeBundle(bundle) {
  const files = bundle.artifacts.releaseArchiveCloseoutReportFiles || releaseArchiveCloseoutReportFiles(bundle.generatedAt);
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
  const releaseArchivePath = path.resolve(positional[0] || defaultReleaseArchivePath);
  let packageMeta = { name: 'design-production-core', version: '0.0.0' };
  try {
    packageMeta = readJson(packageJsonPath);
  } catch {
    packageMeta = { name: 'design-production-core', version: '0.0.0' };
  }

  let releaseArchiveManifest = null;
  const readErrors = [];
  try {
    releaseArchiveManifest = readJson(releaseArchivePath);
  } catch (error) {
    readErrors.push(`release archive manifest read failed: ${error.message}`);
  }

  const releaseArchiveValidation = validateReadOnlyReleaseArchiveManifest({
    manifest: releaseArchiveManifest,
    actor: 'design-production-core.validate-readonly-release-archive',
  });
  const generatedAt = new Date().toISOString();
  const bundle = buildReadOnlyReleaseArchiveCloseoutBundle({
    releaseArchiveManifest,
    releaseArchiveValidation,
    packageName: packageMeta.name,
    packageVersion: packageMeta.version,
    actor: 'design-production-core.export-readonly-release-archive-closeout',
    generatedAt,
    reportFiles: releaseArchiveCloseoutReportFiles(generatedAt),
    readErrors,
  });

  if (!args.includes('--stdout-only')) {
    writeBundle(bundle);
  }

  console.log(JSON.stringify({
    ok: bundle.ok,
    status: bundle.status,
    archiveCloseoutHash: bundle.archiveCloseoutHash,
    archiveHash: bundle.hashes.archiveHash,
    releaseArchiveValidationHash: bundle.hashes.releaseArchiveValidationHash,
    metrics: bundle.metrics,
    blockers: bundle.blockers,
    warnings: bundle.warnings,
    reportFiles: bundle.artifacts.releaseArchiveCloseoutReportFiles,
    safety: bundle.safety,
  }, null, 2));

  if (!bundle.ok) process.exitCode = 1;
}

main();
