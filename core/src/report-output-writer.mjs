import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(packageRoot, '..');
const reportsDir = path.join(packageRoot, 'reports');

function ensureTrailingNewline(text) {
  const value = String(text);
  return value.endsWith('\n') ? value : `${value}\n`;
}

export function assertSafeReportFileId(fileId, {
  extension,
  requireLatest = false,
  label = 'report fileId',
} = {}) {
  const value = String(fileId || '');
  if (!value) {
    throw new TypeError(`${label} is required.`);
  }
  if (
    value.includes('\0')
    || value.includes('/')
    || value.includes('\\')
    || path.isAbsolute(value)
    || value !== path.basename(value)
  ) {
    throw new TypeError(`${label} must be a single safe filename.`);
  }
  if (extension && !value.endsWith(extension)) {
    throw new TypeError(`${label} must end with ${extension}.`);
  }
  const latestSuffix = extension ? `-latest${extension}` : '-latest';
  if (requireLatest && !value.endsWith(latestSuffix)) {
    throw new TypeError(`${label} must be a latest report filename.`);
  }
  return value;
}

function writeFileAndReadBack(filePath, contents) {
  fs.writeFileSync(filePath, contents);
  const written = fs.readFileSync(filePath, 'utf8');
  if (written !== contents) {
    throw new Error(`report write/readback mismatch: ${relativeToWorkspace(filePath)}`);
  }
}

export function relativeToWorkspace(filePath) {
  return path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
}

export function writeLatestReportPair({
  report,
  fileId,
  markdown,
  markdownFileId,
  outputDir = reportsDir,
} = {}) {
  if (!report || typeof report !== 'object') {
    throw new TypeError('writeLatestReportPair requires a report object.');
  }
  if (typeof markdown !== 'string') {
    throw new TypeError('writeLatestReportPair requires markdown text.');
  }
  const safeFileId = assertSafeReportFileId(fileId, {
    extension: '.json',
    requireLatest: true,
    label: 'writeLatestReportPair JSON fileId',
  });
  const safeMarkdownFileId = assertSafeReportFileId(markdownFileId || safeFileId.replace(/\.json$/, '.md'), {
    extension: '.md',
    requireLatest: true,
    label: 'writeLatestReportPair Markdown fileId',
  });
  fs.mkdirSync(outputDir, { recursive: true });
  const latestJson = path.join(outputDir, safeFileId);
  const latestMd = path.join(outputDir, safeMarkdownFileId);
  writeFileAndReadBack(latestJson, `${JSON.stringify(report, null, 2)}\n`);
  writeFileAndReadBack(latestMd, ensureTrailingNewline(markdown));
  return { latestJson, latestMd };
}

export function writeTimestampedReportPair({
  report,
  fileId,
  timestampedFileId,
  markdown,
  markdownFileId,
  timestampedMarkdownFileId,
  outputDir = reportsDir,
} = {}) {
  if (!report || typeof report !== 'object') {
    throw new TypeError('writeTimestampedReportPair requires a report object.');
  }
  if (typeof markdown !== 'string') {
    throw new TypeError('writeTimestampedReportPair requires markdown text.');
  }
  const safeFileId = assertSafeReportFileId(fileId, {
    extension: '.json',
    requireLatest: true,
    label: 'writeTimestampedReportPair latest JSON fileId',
  });
  const safeMarkdownFileId = assertSafeReportFileId(markdownFileId || safeFileId.replace(/\.json$/, '.md'), {
    extension: '.md',
    requireLatest: true,
    label: 'writeTimestampedReportPair latest Markdown fileId',
  });
  const safeTimestampedFileId = assertSafeReportFileId(timestampedFileId, {
    extension: '.json',
    label: 'writeTimestampedReportPair timestamped JSON fileId',
  });
  const safeTimestampedMarkdownFileId = assertSafeReportFileId(timestampedMarkdownFileId || safeTimestampedFileId.replace(/\.json$/, '.md'), {
    extension: '.md',
    label: 'writeTimestampedReportPair timestamped Markdown fileId',
  });
  fs.mkdirSync(outputDir, { recursive: true });
  const latestJson = path.join(outputDir, safeFileId);
  const latestMd = path.join(outputDir, safeMarkdownFileId);
  const timestampedJson = path.join(outputDir, safeTimestampedFileId);
  const timestampedMd = path.join(outputDir, safeTimestampedMarkdownFileId);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdownText = ensureTrailingNewline(markdown);
  writeFileAndReadBack(latestJson, json);
  writeFileAndReadBack(timestampedJson, json);
  writeFileAndReadBack(latestMd, markdownText);
  writeFileAndReadBack(timestampedMd, markdownText);
  return { latestJson, latestMd, timestampedJson, timestampedMd };
}
