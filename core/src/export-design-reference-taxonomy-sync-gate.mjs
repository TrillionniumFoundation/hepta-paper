#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import { buildDesignReferenceTaxonomySyncGate } from './design-reference-taxonomy-sync-gate.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

function markdownFor(report) {
  const lines = [
    '# Design Reference Taxonomy Sync Gate',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.taxonomySyncGateHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Core industries: ${report.summary.coreIndustryCount}`,
    `- ZBJ taxonomy industries: ${report.summary.zbjIndustryCount}`,
    `- ZBJ refpacks: ${report.summary.zbjRefpackCount}`,
    `- Missing in core: ${report.summary.missingInCoreCount}`,
    `- Missing in ZBJ: ${report.summary.missingInZbjCount}`,
    `- Taxonomy industries without refpack: ${report.summary.taxonomyIndustryMissingRefpackCount}`,
    `- Refpacks outside taxonomy: ${report.summary.refpackIndustryNotInTaxonomyCount}`,
    `- Warnings: ${report.summary.warningCount}`,
    '',
    '## Sentinel Packs',
    '',
    ...Object.entries(report.requiredSentinelPacks || {}).map(([industryId, refpackId]) => `- ${industryId}: ${refpackId}`),
    '',
    '## Blockers',
    '',
    ...(report.blockers.length
      ? report.blockers.map((item) => `- ${item.code} ${item.industryId || item.refpackId || item.filePath || ''}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Reads local sibling source snapshots only.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '- Does not grant external execution permission.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildDesignReferenceTaxonomySyncGate();
  const reportFiles = writeLatestReportPair({
    report,
    fileId: 'design-reference-taxonomy-sync-gate-latest.json',
    markdown: markdownFor(report),
  });
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    taxonomySyncGateHash: report.taxonomySyncGateHash,
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
