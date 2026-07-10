#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './hash-utils.mjs';
import {
  REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS,
  REPORT_BOOTSTRAP_SEED_REASON,
  buildBootstrapSeedReport,
} from './report-bootstrap-seed-regression.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = path.join(packageRoot, 'reports');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function reportHash(report = {}) {
  return report.auditHash
    || report.gateHash
    || report.toolingHash
    || report.freshnessHash
    || report.schemaContractHash
    || report.reportHash
    || null;
}

function reportOk(report = {}) {
  return report?.ok === true
    || /^pass_|^ready_/.test(String(report?.status || ''));
}

function isBootstrapSeed(report = {}) {
  return report?.bootstrapSeed === true
    || report?.summary?.bootstrapSeed === true
    || String(report?.status || '').includes('bootstrap');
}

function shouldWriteSeed(fileId, { force = false } = {}) {
  if (force) return { write: true, reason: 'force' };
  const report = readJson(path.join(reportsDir, fileId));
  if (!report) return { write: true, reason: 'missing' };
  if (!reportOk(report)) return { write: true, reason: 'not_ok' };
  if (isBootstrapSeed(report)) return { write: true, reason: 'existing_bootstrap_seed' };
  return {
    write: false,
    reason: 'already_ok_final_report',
    hash: reportHash(report),
    status: report.status || null,
  };
}

function markdownFor(report) {
  const lines = [
    `# Bootstrap Seed: ${report.fileId}`,
    '',
    `Status: ${report.status}`,
    `Hash: ${report.hash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Bootstrap seed: ${report.bootstrapSeed}`,
    `- Seed reason: ${report.seedReason}`,
    `- Replaced by final report: ${report.replacedByFinalReport}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Safety',
    '',
    '- Local bootstrap seed only.',
    '- Writes only allowlisted latest report files to break report self-reference cycles.',
    '- Must be overwritten by normal final report exporters in the same gate run.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeSeedReport(fileId, report) {
  return writeLatestReportPair({
    report,
    fileId,
    markdown: markdownFor(report),
  });
}

export function writeReportBootstrapSeeds({
  generatedAt = new Date().toISOString(),
  force = false,
} = {}) {
  const decisions = Object.fromEntries(REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS.map((fileId) => [
    fileId,
    shouldWriteSeed(fileId, { force }),
  ]));
  const reports = Object.fromEntries(Object.entries(decisions)
    .filter(([, decision]) => decision.write)
    .map(([fileId]) => [
      fileId,
      buildBootstrapSeedReport(fileId, { generatedAt }),
    ]));
  const reportFiles = Object.fromEntries(Object.entries(reports).map(([fileId, report]) => {
    const files = writeSeedReport(fileId, report);
    return [fileId, {
      json: relativeToWorkspace(files.latestJson),
      md: relativeToWorkspace(files.latestMd),
      hash: report.hash,
    }];
  }));
  const bootstrapSeedExportHash = digest({
    seedReason: REPORT_BOOTSTRAP_SEED_REASON,
    seededFileIds: Object.keys(reportFiles).sort(),
    seedHashes: Object.fromEntries(Object.entries(reportFiles).map(([fileId, files]) => [fileId, files.hash])),
  });
  return {
    ok: true,
    status: 'pass_report_bootstrap_seed_export',
    bootstrapSeedExportHash,
    generatedAt,
    seedReason: REPORT_BOOTSTRAP_SEED_REASON,
    force,
    seededFileCount: Object.keys(reportFiles).length,
    seededFileIds: Object.keys(reportFiles).sort(),
    skippedFileCount: Object.values(decisions).filter((decision) => !decision.write).length,
    skippedFileIds: Object.entries(decisions)
      .filter(([, decision]) => !decision.write)
      .map(([fileId]) => fileId)
      .sort(),
    decisions,
    reportFiles,
    safety: {
      localOnly: true,
      conditionalWrite: true,
      writesAllowlistedLatestReports: Object.keys(reportFiles).length > 0,
      allowedFileIds: [...REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS],
      executesExternalAction: false,
      providerSpend: false,
      browserAutomation: false,
      upload: false,
      submit: false,
      messaging: false,
      payment: false,
      acceptance: false,
      deployment: false,
      fetchesChannelState: false,
      appliesLocalStateTransition: false,
      grantsExecutionPermission: false,
    },
  };
}

function main() {
  const result = writeReportBootstrapSeeds({
    force: process.argv.includes('--force'),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isCliEntrypoint(import.meta.url)) main();
