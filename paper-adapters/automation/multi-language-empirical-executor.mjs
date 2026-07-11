import { spawnSync } from 'node:child_process';
import { assertEmpiricalExecutorPort } from '../../paper-ports/empirical-executor-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const LANGUAGE_COMMANDS = Object.freeze({
  python: { executable: 'python3', args: (spec) => [spec.entrypoint, ...(spec.args || [])] },
  node: { executable: process.execPath, args: (spec) => [spec.entrypoint, ...(spec.args || [])] },
  r: { executable: 'Rscript', args: (spec) => [spec.entrypoint, ...(spec.args || [])] },
  julia: { executable: 'julia', args: (spec) => ['--project=@.', spec.entrypoint, ...(spec.args || [])] },
  lean: { executable: 'lake', args: (spec) => spec.entrypoint ? ['env', 'lean', spec.entrypoint] : ['build'] },
  latex: { executable: 'latexmk', args: (spec) => ['-pdf', '-interaction=nonstopmode', '-halt-on-error', spec.entrypoint] },
});

function available(executable) {
  return spawnSync('which', [executable], { encoding: 'utf8', timeout: 3000 }).status === 0;
}

export function createMultiLanguageEmpiricalExecutor({ workerRunner } = {}) {
  if (!workerRunner?.run) throw new Error('WorkerRunnerPort is required');
  return assertEmpiricalExecutorPort({
    version: 1,
    kind: 'MultiLanguageEmpiricalExecutor',
    executorId: 'multi-language-empirical-v1',
    capabilities() {
      return Object.freeze({
        languages: Object.fromEntries(Object.entries(LANGUAGE_COMMANDS).map(([language, command]) => [language, available(command.executable)])),
        gpuDetected: spawnSync('nvidia-smi', ['-L'], { encoding: 'utf8', timeout: 5000 }).status === 0,
        sandbox: workerRunner.availability,
      });
    },
    execute(spec = {}) {
      const command = LANGUAGE_COMMANDS[String(spec.language || '').toLowerCase()];
      if (!command) return Object.freeze({ status: 'empirical_language_unsupported', blockers: ['empirical_language_unsupported'], language: spec.language });
      if (!available(command.executable)) return Object.freeze({ status: 'empirical_runtime_unavailable', blockers: [`runtime_unavailable:${command.executable}`], language: spec.language });
      const capability = this.capabilities();
      if (spec.requiresGpu && !capability.gpuDetected) return Object.freeze({ status: 'empirical_gpu_unavailable', blockers: ['gpu_required_but_unavailable'], language: spec.language });
      const result = workerRunner.run({
        executable: command.executable,
        args: command.args(spec),
        cwd: spec.cwd,
        sourceRoot: spec.sourceRoot || spec.cwd,
        timeoutMs: spec.timeoutMs,
        outputPaths: spec.outputPaths || [],
        outputDirectory: spec.outputDirectory,
        requiresGpu: Boolean(spec.requiresGpu),
        env: spec.env || {},
      });
      const payload = {
        version: 1,
        kind: 'MultiLanguageEmpiricalReceipt',
        language: spec.language,
        status: result.ok ? 'empirical_execution_completed' : 'empirical_execution_failed',
        runnerReceiptHash: result.receiptHash || null,
        artifacts: result.artifacts || [],
        isolation: result.isolation || {},
        blockers: result.blockers || [],
        exitCode: result.exitCode ?? null,
        stdoutTail: String(result.stdout || '').slice(-4000),
        stderrTail: String(result.stderr || '').slice(-4000),
        externalActionPerformed: false,
      };
      return Object.freeze({ ...payload, multiLanguageEmpiricalReceiptHash: hashRecord('MultiLanguageEmpiricalReceipt', payload) });
    },
  });
}
