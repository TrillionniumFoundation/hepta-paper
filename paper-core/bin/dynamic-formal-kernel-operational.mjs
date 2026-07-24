#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const result = spawnSync(process.execPath, [
  '--test',
  '--test-concurrency=1',
  'paper-core/tests/dynamic-formal-claim-kernel-e2e.test.mjs',
], {
  cwd: workspaceRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    HEPTA_DYNAMIC_FORMAL_KERNEL_OPERATIONAL_MODE: 'strict',
  },
  maxBuffer: 16 * 1024 * 1024,
});

if (result.error) throw result.error;
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
const skipped = String(result.stdout || '').match(/^# skipped (\d+)$/m);
if (result.status === 0 && (!skipped || Number(skipped[1]) !== 0)) {
  process.stderr.write('dynamic_formal_kernel_operational_skip_count_invalid\n');
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
