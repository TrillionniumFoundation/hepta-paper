import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { computeReadOnlyCoreGateHash } from './read-only-core-gate-validator.mjs';
import { writeTimestampedReportPair } from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function safeFalseSafety(extra = {}) {
  return {
    executesExternalAction: false,
    uploads: false,
    submits: false,
    sendsMessages: false,
    acceptsDelivery: false,
    pays: false,
    deploys: false,
    fetchesChannelState: false,
    appliesLocalStateTransition: false,
    grantsExecutionPermission: false,
    readyForExecution: false,
    ...extra,
  };
}

function listFiles(dirName, suffix) {
  const root = path.join(packageRoot, dirName);
  const files = [];
  function visit(dirPath) {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        files.push(path.relative(packageRoot, entryPath));
      }
    }
  }
  visit(root);
  return files.sort();
}

function compactOutput(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.length > 2400 ? `${text.slice(0, 2400)}...` : text;
}

function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text.startsWith('{')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function runNodeStep(name, args) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  const ok = !result.error && result.status === 0 && !result.signal;
  return {
    name,
    ok,
    command: ['node', ...args].join(' '),
    durationMs: Date.now() - startedAt,
    exitCode: result.status,
    signal: result.signal || null,
    error: result.error ? result.error.message : null,
    summary: ok ? parseJsonOutput(result.stdout) : null,
    stdout: ok ? null : compactOutput(result.stdout),
    stderr: ok ? null : compactOutput(result.stderr),
  };
}

function syntaxCheckStep() {
  const startedAt = Date.now();
  const failures = [];
  const files = listFiles('src', '.mjs');
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], {
      cwd: packageRoot,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0 || result.signal) {
      failures.push({
        file,
        exitCode: result.status,
        signal: result.signal || null,
        error: result.error ? result.error.message : null,
        stdout: compactOutput(result.stdout),
        stderr: compactOutput(result.stderr),
      });
    }
  }
  return {
    name: 'node_check_src',
    ok: failures.length === 0,
    durationMs: Date.now() - startedAt,
    fileCount: files.length,
    failures,
  };
}

function fixtureJsonStep() {
  const startedAt = Date.now();
  const failures = [];
  const files = listFiles('fixtures', '.json');
  for (const file of files) {
    try {
      JSON.parse(fs.readFileSync(path.join(packageRoot, file), 'utf8'));
    } catch (error) {
      failures.push({
        file,
        error: error.message,
      });
    }
  }
  return {
    name: 'fixture_json_parse',
    ok: failures.length === 0,
    durationMs: Date.now() - startedAt,
    fileCount: files.length,
    failures,
  };
}

function buildGateReport() {
  const startedAt = new Date().toISOString();
  const steps = [
    syntaxCheckStep(),
    fixtureJsonStep(),
    runNodeStep('selftest', ['src/selftest.mjs']),
    runNodeStep('export_samples', ['src/export-readonly-samples.mjs']),
    runNodeStep('validate_samples', ['src/validate-readonly-samples.mjs']),
  ];
  const ok = steps.every((step) => step.ok);
  const report = {
    version: 1,
    kind: 'ReadOnlyCoreGateReport',
    status: ok ? 'pass_readonly_core_gate' : 'fail_readonly_core_gate',
    ok,
    stepCount: steps.length,
    failedSteps: steps.filter((step) => !step.ok).map((step) => step.name),
    steps,
    safety: safeFalseSafety({
      localRegressionGateOnly: true,
      writesLocalGateReport: true,
      mayWriteLocalReportsViaExportSamples: true,
      externalRunnerMustRecheckApproval: true,
      externalRunnerMustRecheckEvidence: true,
      externalRunnerMustRecheckReplayGuard: true,
      externalRunnerMustRecheckChannelState: true,
    }),
    generatedAt: new Date().toISOString(),
    startedAt,
  };
  const gateHash = computeReadOnlyCoreGateHash(report);
  return {
    ...report,
    gateHash,
    hash: gateHash,
  };
}

function reportStamp(generatedAt) {
  return String(generatedAt || new Date().toISOString()).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function renderMarkdown(report) {
  const stepRows = report.steps.map((step) => [
    step.name,
    step.ok ? 'PASS' : 'FAIL',
    step.fileCount ?? '',
    step.exitCode ?? '',
    step.summary?.status || '',
    step.durationMs,
  ]);
  return [
    '# Read-only Core Gate',
    '',
    `Generated at: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Status: ${report.status}`,
    `- OK: ${report.ok ? 'yes' : 'no'}`,
    `- Gate hash: ${report.gateHash}`,
    `- Failed steps: ${report.failedSteps.length ? report.failedSteps.join(', ') : 'none'}`,
    '',
    '## Steps',
    '',
    '| Step | Result | Files | Exit | Child status | Duration ms |',
    '| --- | --- | ---: | ---: | --- | ---: |',
    ...stepRows.map((row) => `| ${row.join(' | ')} |`),
    '',
    '## Boundary',
    '',
    '- Local regression gate only.',
    '- May refresh local read-only reports.',
    '- No platform fetch, provider/model spend, live prepare, upload, submit, customer message, acceptance, payment, deployment, lifecycle state application, or execution permission.',
    '',
  ].join('\n');
}

function writeGateReport(report) {
  const stamp = reportStamp(report.generatedAt);
  const reportFiles = {
    json: 'reports/read-only-core-gate-latest.json',
    markdown: 'reports/read-only-core-gate-latest.md',
    timestampedJson: `reports/read-only-core-gate-${stamp}.json`,
    timestampedMarkdown: `reports/read-only-core-gate-${stamp}.md`,
  };
  const reportWithFiles = {
    ...report,
    reportFiles,
  };
  writeTimestampedReportPair({
    report: reportWithFiles,
    fileId: path.basename(reportFiles.json),
    markdownFileId: path.basename(reportFiles.markdown),
    timestampedFileId: path.basename(reportFiles.timestampedJson),
    timestampedMarkdownFileId: path.basename(reportFiles.timestampedMarkdown),
    markdown: renderMarkdown(reportWithFiles),
  });
  return reportFiles;
}

const report = buildGateReport();
const shouldWrite = !process.argv.includes('--stdout-only');
const reportFiles = shouldWrite ? writeGateReport(report) : null;
console.log(JSON.stringify({
  ...report,
  reportFiles,
}, null, 2));
if (!report.ok) process.exitCode = 1;
