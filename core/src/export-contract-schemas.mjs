#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import {
  buildContractJsonSchema,
  summarizeContractJsonSchema,
  validateContractJsonSchemaSnapshot,
} from './contract-schema.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

function markdownFor({ snapshot, summary, validation }) {
  const lines = [
    '# Contract JSON Schemas',
    '',
    `Status: ${validation.status}`,
    `Hash: ${snapshot.schemaHash}`,
    `Generated: ${snapshot.createdAt}`,
    `Draft: ${snapshot.jsonSchemaDraft}`,
    '',
    '## Summary',
    '',
    `- Schemas: ${summary.schemaCount}`,
    `- Channel ids: ${summary.enumCounts.channelIds}`,
    `- Product lines: ${summary.enumCounts.productLineIds}`,
    `- Output modes: ${summary.enumCounts.outputModes}`,
    `- External actions: ${summary.enumCounts.externalActions}`,
    `- Core stages: ${summary.enumCounts.coreStages}`,
    '',
    '## Schemas',
    '',
    ...Object.keys(snapshot.schemas || {}).map((name) => `- ${name}`),
    '',
    '## Blockers',
    '',
    ...(validation.blockers.length
      ? validation.blockers.map((item) => `- ${item.code}: ${item.notes || ''}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Local schema export only.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, or platform state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(snapshot) {
  const summary = summarizeContractJsonSchema(snapshot);
  const validation = validateContractJsonSchemaSnapshot(snapshot);
  const report = {
    version: snapshot.version,
    kind: 'DesignProductionCoreContractJsonSchemaReport',
    ok: validation.ok,
    status: validation.status,
    generatedAt: snapshot.createdAt,
    snapshot,
    summary,
    validation,
    reportFiles: {
      json: 'design-production-core/reports/contract-schemas-latest.json',
      md: 'design-production-core/reports/contract-schemas-latest.md',
    },
    safety: snapshot.safety,
  };
  const reportFiles = writeLatestReportPair({
    fileId: 'contract-schemas-latest.json',
    report,
    markdown: markdownFor({ snapshot, summary, validation }),
  });
  return {
    report,
    latestJson: reportFiles.latestJson,
    latestMd: reportFiles.latestMd,
  };
}

function main() {
  const snapshot = buildContractJsonSchema();
  const { report, latestJson, latestMd } = writeReports(snapshot);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    schemaHash: snapshot.schemaHash,
    schemaCount: report.summary.schemaCount,
    blockers: report.validation.blockers.map((item) => item.code),
    reportFiles: {
      json: relativeToWorkspace(latestJson),
      md: relativeToWorkspace(latestMd),
    },
  }, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (isCliEntrypoint(import.meta.url)) main();
