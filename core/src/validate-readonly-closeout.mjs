import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReadOnlyCloseoutSummary } from './read-only-closeout-validator.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultReportPath = path.join(packageRoot, 'reports', 'read-only-closeout-latest.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main() {
  const requestedPath = process.argv.find((arg, index) => index > 1 && !arg.startsWith('-'));
  const reportPath = path.resolve(requestedPath || defaultReportPath);
  let summary = null;
  let readError = null;
  try {
    summary = readJson(reportPath);
  } catch (error) {
    readError = error;
  }

  const validation = validateReadOnlyCloseoutSummary({
    summary,
    actor: 'design-production-core.validate-readonly-closeout',
  });
  const blockers = [
    ...(readError ? [{ level: 'error', code: 'closeout_report_read_failed', notes: readError.message }] : []),
    ...validation.blockers,
  ];
  const ok = !readError && validation.ok === true;

  console.log(JSON.stringify({
    ok,
    status: ok ? validation.status : 'fail_readonly_closeout_validation',
    report: path.relative(packageRoot, reportPath),
    validationHash: validation.validationHash,
    hashChecks: validation.hashChecks,
    metrics: validation.metrics,
    blockers,
    warnings: validation.warnings,
    safety: validation.safety,
  }, null, 2));

  if (!ok) process.exitCode = 1;
}

main();
