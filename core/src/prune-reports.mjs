import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './hash-utils.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

export const REPORT_RETENTION_VERSION = 1;

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(packageRoot, '..');
const reportsDir = path.join(packageRoot, 'reports');
const archiveDir = path.join(workspaceRoot, 'state', 'design-production-core', 'reports-archive');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function relative(filePath) {
  return path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
}

export function isKeptReport(name) {
  return name === 'README.md' || /-latest\.(json|md)$/.test(name);
}

function uniqueDestination(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const ext = path.extname(filePath);
  const stem = filePath.slice(0, -ext.length);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${stem}-${index}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot allocate archive filename for ${filePath}`);
}

function listReportFiles() {
  if (!fs.existsSync(reportsDir)) return [];
  return fs.readdirSync(reportsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export function buildReportRetentionPlan({
  fileNames = listReportFiles(),
  reportsDirPath = reportsDir,
  archiveDirPath = archiveDir,
} = {}) {
  const files = [...fileNames].sort((left, right) => left.localeCompare(right));
  const keep = files.filter(isKeptReport);
  const archive = files.filter((name) => !isKeptReport(name));
  return {
    version: REPORT_RETENTION_VERSION,
    kind: 'ReportRetentionPlan',
    reportsDir: relative(reportsDirPath),
    archiveDir: relative(archiveDirPath),
    keep,
    archive,
    safety: {
      localOnly: true,
      deletesFiles: false,
      movesToArchive: true,
      executesExternalAction: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      pays: false,
      acceptsDelivery: false,
      deploys: false,
    },
  };
}

export function buildReportRetentionResult({
  plan = buildReportRetentionPlan(),
  dryRun = false,
  generatedAt = new Date().toISOString(),
  moved = plan.archive.map((name) => ({
    name,
    source: `${plan.reportsDir}/${name}`,
    destination: `${plan.archiveDir}/${name}`,
  })),
  blockers = [],
} = {}) {
  const result = {
    version: REPORT_RETENTION_VERSION,
    kind: 'ReportRetentionResult',
    status: blockers.length ? 'blocked_report_retention' : 'pass_report_retention',
    ok: blockers.length === 0,
    dryRun: Boolean(dryRun),
    generatedAt,
    reportsDir: plan.reportsDir,
    archiveDir: plan.archiveDir,
    keptCount: plan.keep.length,
    archivedCount: moved.length,
    kept: plan.keep,
    moved,
    blockers,
    safety: plan.safety,
  };
  const retentionHash = digest({
    version: result.version,
    kind: result.kind,
    status: result.status,
    dryRun: result.dryRun,
    reportsDir: result.reportsDir,
    archiveDir: result.archiveDir,
    kept: result.kept,
    moved: result.moved,
    blockers: result.blockers,
    safety: result.safety,
  });
  return {
    ...result,
    retentionHash,
    hash: retentionHash,
  };
}

export function applyReportRetentionPlan({
  dryRun = false,
  generatedAt = new Date().toISOString(),
} = {}) {
  ensureDir(reportsDir);
  ensureDir(archiveDir);
  const plan = buildReportRetentionPlan();
  const moved = [];
  const blockers = [];
  for (const name of plan.archive) {
    const source = path.join(reportsDir, name);
    const destination = uniqueDestination(path.join(archiveDir, name));
    try {
      if (!dryRun) fs.renameSync(source, destination);
      moved.push({
        name,
        source: relative(source),
        destination: relative(destination),
      });
    } catch (error) {
      blockers.push({
        code: 'archive_move_failed',
        notes: `${name}: ${error.message}`,
      });
    }
  }
  return buildReportRetentionResult({
    plan,
    dryRun,
    generatedAt,
    moved,
    blockers,
  });
}

function markdownFor(result) {
  const lines = [
    '# Report Retention',
    '',
    `Status: ${result.status}`,
    `Hash: ${result.retentionHash}`,
    `Generated: ${result.generatedAt}`,
    `Dry run: ${result.dryRun}`,
    '',
    '## Counts',
    '',
    `- Kept: ${result.keptCount}`,
    `- Archived: ${result.archivedCount}`,
    `- Archive dir: ${result.archiveDir}`,
    '',
    '## Blockers',
    '',
    ...(result.blockers.length
      ? result.blockers.map((item) => `- ${item.code}: ${item.notes}`)
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Local report retention only.',
    '- Moves old timestamped reports to archive; does not delete files.',
    '- No external action or platform state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(result) {
  return writeLatestReportPair({
    report: result,
    fileId: 'report-retention-latest.json',
    markdown: markdownFor(result),
  });
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const result = applyReportRetentionPlan({ dryRun });
  const reportFiles = writeReports(result);
  process.stdout.write(`${JSON.stringify({
    ok: result.ok,
    status: result.status,
    dryRun: result.dryRun,
    retentionHash: result.retentionHash,
    keptCount: result.keptCount,
    archivedCount: result.archivedCount,
    blockers: result.blockers.map((item) => item.code),
    reportFiles: {
      json: relativeToWorkspace(reportFiles.latestJson),
      md: relativeToWorkspace(reportFiles.latestMd),
    },
  }, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (isCliEntrypoint(import.meta.url)) main();
