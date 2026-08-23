#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runProductionStrictNpmAudit,
} from '../../paper-composition/bootstrap/strict-npm-audit-composition.mjs';

export function runStrictNpmAuditCli({
  argv = process.argv.slice(2),
  run = runProductionStrictNpmAudit,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    stderr.write('Usage: strict-npm-audit\n');
    return 64;
  }
  try {
    const result = run();
    stdout.write(result.stdout);
    stderr.write(result.stderr);
    return 0;
  } catch (error) {
    if (error?.stdout) stdout.write(error.stdout);
    if (error?.stderr) stderr.write(error.stderr);
    stderr.write(`${String(error?.code || error?.message || error)}\n`);
    return Number.isSafeInteger(error?.exitStatus) && error.exitStatus > 0
      ? error.exitStatus : 1;
  }
}

const ENTRYPOINT = fileURLToPath(import.meta.url);
const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === ENTRYPOINT;
if (invokedAsScript) process.exitCode = runStrictNpmAuditCli();
