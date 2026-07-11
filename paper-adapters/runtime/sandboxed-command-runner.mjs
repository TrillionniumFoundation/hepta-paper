import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertWorkerRunnerPort } from '../../paper-ports/worker-runner-port.mjs';

export function createSandboxedCommandRunner({
  runnerId = 'local-bounded-command-runner',
  allowedExecutables = [],
  allowedRoots = [],
  maximumTimeoutMs = 120000,
  maximumOutputBytes = 4 * 1024 * 1024,
} = {}) {
  const executableSet = new Set(allowedExecutables.map(String));
  const roots = allowedRoots.map((root) => path.resolve(root));
  return assertWorkerRunnerPort({
    version: 1,
    kind: 'SandboxedCommandRunnerAdapter',
    runnerId,
    run({ executable, args = [], cwd, timeoutMs = 30000, env = {} } = {}) {
      const resolvedCwd = path.resolve(cwd || '.');
      const blockers = [];
      if (!executableSet.has(String(executable))) blockers.push('worker_executable_not_allowlisted');
      if (!roots.some((root) => resolvedCwd === root || resolvedCwd.startsWith(root + path.sep))) {
        blockers.push('worker_cwd_outside_allowed_roots');
      }
      const boundedTimeoutMs = Math.max(1, Math.min(Number(timeoutMs || 30000), maximumTimeoutMs));
      if (blockers.length) {
        return { ok: false, status: 'sandbox_command_blocked', exitCode: null, stdout: '', stderr: '', blockers };
      }
      const result = spawnSync(String(executable), args.map(String), {
        cwd: resolvedCwd,
        encoding: 'utf8',
        timeout: boundedTimeoutMs,
        maxBuffer: maximumOutputBytes,
        env: {
          PATH: process.env.PATH || '',
          HOME: resolvedCwd,
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
          NO_PROXY: '*',
          no_proxy: '*',
          ...Object.fromEntries(Object.entries(env).filter(([key]) => ['LEAN_PATH', 'LAKE_HOME'].includes(key))),
        },
      });
      return {
        ok: result.status === 0 && !result.error,
        status: result.status === 0 && !result.error ? 'sandbox_command_passed' : 'sandbox_command_failed',
        exitCode: result.status,
        signal: result.signal || null,
        stdout: result.stdout || '',
        stderr: result.stderr || String(result.error?.message || ''),
        blockers: result.error ? ['sandbox_command_execution_error'] : [],
        safety: {
          executableAllowlisted: true,
          cwdBounded: true,
          timeoutMs: boundedTimeoutMs,
          outputBytesMaximum: maximumOutputBytes,
          networkDeniedByContract: true,
          kernelNetworkIsolationVerified: false,
          externalActionPerformed: false,
        },
      };
    },
  });
}
