#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import { buildPromptProductionContractGate } from './prompt-production-contracts.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

function markdownFor(report) {
  const lines = [
    '# Prompt Production Contract Gate',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.promptProductionContractGateHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Pass fixture ok: ${report.summary.passFixtureOk}`,
    `- Negative scenarios blocked: ${report.summary.blockedNegativeScenarioCount}/${report.summary.negativeScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    `- Prompt compiler hash: ${report.passContract.promptCompilerHash || '-'}`,
    `- Readiness hash: ${report.passContract.readinessHash || '-'}`,
    `- Contract hash: ${report.passContract.promptProductionContractHash || '-'}`,
    '',
    '## Negative Scenarios',
    '',
    ...report.negativeScenarios.map((scenario) => `- ${scenario.ok ? 'FAIL' : 'PASS'} ${scenario.scenario}: ${scenario.blockerCodes.join(', ') || '-'}`),
    '',
    '## Blockers',
    '',
    ...(report.blockers.length
      ? report.blockers.map((blocker) => `- ${blocker.code}${blocker.notes ? `: ${blocker.notes}` : ''}`)
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Local fixture gate only.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, IM/message send, acceptance, payment, deployment, channel-state fetch, or state mutation.',
    '- Does not grant external execution permission.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildPromptProductionContractGate();
  const reportFiles = writeLatestReportPair({
    report,
    fileId: 'prompt-production-contract-gate-latest.json',
    markdown: markdownFor(report),
  });
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    promptProductionContractGateHash: report.promptProductionContractGateHash,
    summary: report.summary,
    blockers: report.blockers.map((blocker) => blocker.code),
    reportFiles: {
      json: relativeToWorkspace(reportFiles.latestJson),
      md: relativeToWorkspace(reportFiles.latestMd),
    },
  }, null, 2)}\n`);
  if (strict && !report.ok) process.exitCode = 1;
}

if (isCliEntrypoint(import.meta.url)) main();
