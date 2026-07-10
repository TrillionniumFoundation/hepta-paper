#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORE_COMPATIBILITY_MODULES,
  CORE_PUBLIC_MODULES,
} from './index.mjs';
import { summarizeCompatibilityExportPolicy } from './compatibility-export-policy.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readPackageScripts() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  return Object.keys(packageJson.scripts || {}).sort((left, right) => left.localeCompare(right));
}

export function buildCompatibilityPolicyReport({ generatedAt = new Date().toISOString() } = {}) {
  return summarizeCompatibilityExportPolicy({
    publicModules: CORE_PUBLIC_MODULES,
    compatibilityModules: CORE_COMPATIBILITY_MODULES,
    scriptIds: readPackageScripts(),
    generatedAt,
  });
}

function markdownFor(report) {
  const lines = [
    '# Compatibility Export Policy',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.policyHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Entries: ${report.summary.entryCount}`,
    `- Compatibility modules: ${report.summary.compatibilityModuleCount}`,
    `- Freeze cap: ${report.summary.freezeMax}`,
    `- Zero compatibility invariant: ${report.summary.zeroCompatibilityInvariant ? 'true' : 'false'}`,
    `- Remaining allowed growth: ${report.summary.freezeRemainingGrowth}`,
    `- Covered compatibility modules: ${report.summary.coveredCompatibilityModuleCount}`,
    `- Blockers: ${report.validation.blockerCount}`,
    '',
    '## Removal Phases',
    '',
    ...Object.entries(report.summary.byRemovalPhase).map(([phase, count]) => `- ${phase}: ${count}`),
    '',
    '## Groups',
    '',
    ...Object.entries(report.summary.byGroup).map(([group, count]) => `- ${group}: ${count}`),
    '',
    '## Entries',
    '',
    '| Module | Group | Status | Removal phase | Replacement |',
    '| --- | --- | --- | --- | --- |',
    ...report.entries.map((entry) => {
      const replacements = [
        ...entry.replacementModuleIds.map((moduleId) => `module:${moduleId}`),
        ...entry.replacementScriptIds.map((scriptId) => `script:${scriptId}`),
      ].join('<br>');
      return `| ${entry.moduleId} | ${entry.group} | ${entry.status} | ${entry.removalPhase} | ${replacements || entry.replacementSurface} |`;
    }),
    '',
    '## Blockers',
    '',
    ...(report.validation.blockers.length
      ? report.validation.blockers.map((item) => `- ${item.code} ${item.moduleId || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Local compatibility export policy only.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, or platform state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    fileId: 'compatibility-export-policy-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildCompatibilityPolicyReport();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    policyHash: report.policyHash,
    summary: report.summary,
    blockers: report.validation.blockers.map((item) => item.code),
    reportFiles: {
      json: relativeToWorkspace(reportFiles.latestJson),
      md: relativeToWorkspace(reportFiles.latestMd),
    },
  }, null, 2)}\n`);
  if (strict && !report.ok) process.exitCode = 1;
}

if (isCliEntrypoint(import.meta.url)) main();
