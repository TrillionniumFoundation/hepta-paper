import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReadOnlyReleaseVerificationBundle } from './read-only-release-verification-validator.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultReportPath = path.join(packageRoot, 'reports', 'read-only-release-verification-latest.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main() {
  const requestedPath = process.argv.find((arg, index) => index > 1 && !arg.startsWith('-'));
  const reportPath = path.resolve(requestedPath || defaultReportPath);
  let bundle = null;
  let readError = null;
  try {
    bundle = readJson(reportPath);
  } catch (error) {
    readError = error;
  }

  const validation = validateReadOnlyReleaseVerificationBundle({
    bundle,
    actor: 'design-production-core.validate-readonly-release-verification',
  });
  const blockers = [
    ...(readError ? [{ level: 'error', code: 'release_verification_report_read_failed', notes: readError.message }] : []),
    ...validation.blockers,
  ];
  const ok = !readError && validation.ok === true;

  console.log(JSON.stringify({
    ok,
    status: ok ? validation.status : 'fail_readonly_release_verification_validation',
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
