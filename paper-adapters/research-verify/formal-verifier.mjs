import path from 'node:path';
import { assertFormalVerifierPort } from '../../paper-ports/formal-verifier-port.mjs';
import { FORMAL_ASSURANCE_LADDER } from '../../paper-domain/research/formal-verifier-policy.mjs';
import { createOsSandboxedWorkerRunner } from '../runtime/os-sandboxed-worker-runner.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';

export function createLeanFormalVerifier({ sourceRoot, executable = 'lean', commandRunner = null } = {}) {
  const runner = commandRunner || createOsSandboxedWorkerRunner({
    allowedExecutables: [executable],
    allowedRoots: [sourceRoot],
  });
  return assertFormalVerifierPort({
    version: 1,
    kind: 'LeanFormalVerifierAdapter',
    verifierId: 'lean-os-sandbox-check-v2',
    ...FORMAL_ASSURANCE_LADDER.singleFileLean,
    verify({ inputRecords = [], parameters = {} } = {}) {
      const blockers = [];
      if (inputRecords.length !== 1) blockers.push('lean_verifier_requires_exactly_one_input');
      const input = inputRecords[0];
      if (input && path.extname(input.absolutePath).toLowerCase() !== '.lean') blockers.push('lean_verifier_input_extension_invalid');
      const sourceRead = input ? readScopedFileSync({ scopeRoot: sourceRoot, candidate: input.absolutePath }) : null;
      if (sourceRead?.status !== 'scoped_file_read_verified') blockers.push('lean_verifier_input_unreadable');
      if (input?.hash && sourceRead?.hash !== input.hash) blockers.push('lean_verifier_input_hash_mismatch');
      const source = sourceRead?.content?.toString('utf8') || '';
      if (/\bsorry\b|\badmit\b|\bby\s+exact\s+Classical\.choice\b/i.test(source)) blockers.push('lean_verifier_untrusted_proof_placeholder');
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
      const output = `${execution.stdout || ''}\n${execution.stderr || ''}`;
      const outputBlockers = /\bsorryAx\b|declaration uses ['"]sorry['"]|\badmit\b/i.test(output) ? ['lean_verifier_untrusted_proof_placeholder'] : [];
      return {
        status: execution.ok && !outputBlockers.length ? 'formal_verifier_passed' : 'formal_verifier_blocked',
        verifierId: 'lean-os-sandbox-check-v2',
        input: { path: input.path, hash: input.hash },
        exitCode: execution.exitCode,
        stdout: execution.stdout,
        stderr: execution.stderr,
        blockers: execution.ok && !outputBlockers.length ? [] : [...outputBlockers, ...(execution.blockers || []), 'lean_verification_failed'],
        safety: execution.isolation || execution.safety || null,
      };
    },
  });
}
