import path from 'node:path';
import { assertFormalVerifierPort } from '../../paper-ports/formal-verifier-port.mjs';
import { createOsSandboxedWorkerRunner } from '../runtime/os-sandboxed-worker-runner.mjs';

export function createLeanFormalVerifier({ sourceRoot, executable = 'lean', commandRunner = null } = {}) {
  const runner = commandRunner || createOsSandboxedWorkerRunner({
    allowedExecutables: [executable],
    allowedRoots: [sourceRoot],
  });
  return assertFormalVerifierPort({
    version: 1,
    kind: 'LeanFormalVerifierAdapter',
    verifierId: 'lean-os-sandbox-check-v2',
    verify({ inputRecords = [], parameters = {} } = {}) {
      const blockers = [];
      if (inputRecords.length !== 1) blockers.push('lean_verifier_requires_exactly_one_input');
      const input = inputRecords[0];
      if (input && path.extname(input.absolutePath).toLowerCase() !== '.lean') blockers.push('lean_verifier_input_extension_invalid');
      if (blockers.length) return { status: 'formal_verifier_blocked', blockers };
      const execution = runner.run({
        executable,
        args: ['--error=warning', input.absolutePath],
        cwd: sourceRoot,
        timeoutMs: Math.min(Number(parameters.timeoutMs || 60000), 120000),
        env: {
          ELAN_HOME: process.env.ELAN_HOME || `${process.env.HOME || ''}/.elan`,
          ELAN_TOOLCHAIN: process.env.ELAN_TOOLCHAIN || 'leanprover/lean4:v4.30.0',
        },
      });
      return {
        status: execution.ok ? 'formal_verifier_passed' : 'formal_verifier_blocked',
        verifierId: 'lean-os-sandbox-check-v2',
        input: { path: input.path, hash: input.hash },
        exitCode: execution.exitCode,
        stdout: execution.stdout,
        stderr: execution.stderr,
        blockers: execution.ok ? [] : [...(execution.blockers || []), 'lean_verification_failed'],
        safety: execution.isolation || execution.safety || null,
      };
    },
  });
}
