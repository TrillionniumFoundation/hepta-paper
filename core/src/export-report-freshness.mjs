#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_FRESHNESS_GATE_REPORT,
  REPORT_FRESHNESS_REQUIRED_REPORTS,
  buildReportFreshnessReport,
} from './report-freshness.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = path.join(packageRoot, 'reports');

const REPORT_HASH_ALIAS_KEYS_BY_FILE_ID = Object.freeze({
  'contract-schemas-latest.json': Object.freeze(['snapshot.schemaHash']),
  'package-root-import-migration-latest.json': Object.freeze(['migrationHash']),
  'package-root-import-regression-latest.json': Object.freeze(['regressionHash']),
  'selftest-lanes-latest.json': Object.freeze(['reportHash']),
  'report-retention-latest.json': Object.freeze(['retentionHash']),
  [REPORT_FRESHNESS_GATE_REPORT.fileId]: Object.freeze(['gateHash']),
});

const REPORT_HASH_KEY_PREFIXES = Object.freeze([
  'report',
  'integrationGate',
  'integration',
  'packageRoot',
  'package',
  'channelImport',
  'compatibility',
  'readOnlyReport',
]);

const BASE_REPORT_HASH_KEYS = Object.freeze([
  'freshnessHash',
  'freshnessRegressionHash',
  'inventoryConsistencyHash',
  'schemaContractHash',
  'retentionRegressionHash',
  'toolingHash',
  'checkpointHash',
  'policyHash',
  'chainHash',
  'reportHash',
  'gateHash',
  'auditHash',
  'allowlistHash',
  'resolverHash',
  'migrationHash',
  'regressionHash',
  'symbolManifestHash',
  'symbolRegressionHash',
  'symbolMinimizationHash',
  'schemaHash',
  'surfaceHash',
  'retentionHash',
  'snapshot.schemaHash',
]);

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length))];
}

function lowerInitial(value) {
  return value ? `${value.slice(0, 1).toLowerCase()}${value.slice(1)}` : null;
}

function prefixedAlias(hashKey, prefix) {
  if (!hashKey?.startsWith(prefix)) return null;
  return lowerInitial(hashKey.slice(prefix.length));
}

function reportHashKeysForSpec(spec = {}) {
  return uniqueStrings([
    spec.gateSummaryHashKey || null,
    ...REPORT_HASH_KEY_PREFIXES.map((prefix) => prefixedAlias(spec.gateSummaryHashKey || '', prefix)),
    ...(REPORT_HASH_ALIAS_KEYS_BY_FILE_ID[spec.fileId] || []),
  ]);
}

const DEFAULT_REPORT_HASH_KEYS = Object.freeze(uniqueStrings([
  ...BASE_REPORT_HASH_KEYS,
  ...REPORT_FRESHNESS_REQUIRED_REPORTS.flatMap((spec) => reportHashKeysForSpec(spec)),
  ...reportHashKeysForSpec(REPORT_FRESHNESS_GATE_REPORT),
]));

const REPORT_FRESHNESS_SPECS_BY_FILE_ID = new Map([
  ...REPORT_FRESHNESS_REQUIRED_REPORTS,
  REPORT_FRESHNESS_GATE_REPORT,
].map((spec) => [spec.fileId, spec]));

function valueAtPath(source = {}, keyPath) {
  if (!keyPath) return null;
  return keyPath.split('.').reduce((value, key) => value?.[key], source) || null;
}

export function reportHash(report = {}, hashKeys = DEFAULT_REPORT_HASH_KEYS) {
  const keys = Array.isArray(hashKeys) ? hashKeys : [hashKeys];
  for (const key of keys) {
    const value = valueAtPath(report, key);
    if (value) return value;
  }
  return null;
}

export function reportHashKeysForFileId(fileId) {
  const spec = REPORT_FRESHNESS_SPECS_BY_FILE_ID.get(fileId);
  return spec ? reportHashKeysForSpec(spec) : DEFAULT_REPORT_HASH_KEYS;
}

export function reportHashForFileId(report = {}, fileId) {
  return reportHash(report, reportHashKeysForFileId(fileId));
}

function reportOk(report = {}) {
  return report?.ok === true
    || report?.validationOk === true
    || /^pass_|^ready_/.test(String(report?.status || ''));
}

function readReportBinding(spec) {
  const fileId = spec.fileId;
  const filePath = path.join(reportsDir, fileId);
  const report = readJson(filePath);
  return {
    exists: Boolean(report),
    ok: reportOk(report),
    status: report?.status || null,
    hash: reportHash(report || {}, reportHashKeysForSpec(spec)),
    blockerCount: Array.isArray(report?.blockers) ? report.blockers.length : 0,
    generatedAt: report?.generatedAt || null,
    file: relativeToWorkspace(filePath),
    report,
  };
}

function readReportBindings() {
  const bindings = {};
  for (const spec of [
    ...REPORT_FRESHNESS_REQUIRED_REPORTS,
    REPORT_FRESHNESS_GATE_REPORT,
  ]) {
    bindings[spec.fileId] = readReportBinding(spec);
  }
  return bindings;
}

export function buildReportFreshnessLatest({
  generatedAt = new Date().toISOString(),
  includeGateReport = true,
} = {}) {
  const bindings = readReportBindings();
  return buildReportFreshnessReport({
    reportBindings: bindings,
    gateReport: bindings[REPORT_FRESHNESS_GATE_REPORT.fileId]?.report || null,
    includeGateReport,
    generatedAt,
  });
}

function markdownFor(report) {
  const lines = [
    '# Report Freshness',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.freshnessHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Reports ok: ${report.summary.okReportCount}/${report.summary.reportCount}`,
    `- Include integration gate report: ${report.summary.includeGateReport}`,
    `- Gate report ok: ${report.summary.gateReportOk}`,
    `- Gate file hash match: ${report.summary.gateReportHashMatchesFile}`,
    `- Gate hash matches: ${report.summary.gateHashMatchCount}/${report.summary.comparableGateReportCount}`,
    `- Gate hash mismatches: ${report.summary.gateHashMismatchCount}`,
    `- Missing reports: ${report.summary.missingReportCount}`,
    `- Not-ok reports: ${report.summary.notOkReportCount}`,
    `- Missing hashes: ${report.summary.missingHashCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Reports',
    '',
    '| Report | Status | Hash | Gate summary key | Gate hash | Match |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.reports.map((item) => `| ${item.fileId} | ${item.status} | ${item.hash || 'null'} | ${item.gateSummaryHashKey || 'none'} | ${item.expectedGateHash || 'null'} | ${item.gateHashMatches} |`),
    '',
    '## Blockers',
    '',
    ...(report.blockers.length
      ? report.blockers.map((item) => `- ${item.code} ${item.fileId || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Local report freshness check only.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function writeReportFreshnessReports(report) {
  return writeLatestReportPair({
    report,
    fileId: 'report-freshness-latest.json',
    markdown: markdownFor(report),
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const includeGateReport = !process.argv.includes('--skip-gate');
  const report = buildReportFreshnessLatest({ includeGateReport });
  const reportFiles = writeReportFreshnessReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    freshnessHash: report.freshnessHash,
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
