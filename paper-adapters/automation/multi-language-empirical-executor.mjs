import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { assertEmpiricalExecutorPort } from '../../paper-ports/empirical-executor-port.mjs';
import { assertEmpiricalCachePort } from '../../paper-ports/empirical-cache-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { directoryMerkleHash } from '../runtime/os-sandboxed-worker-runner.mjs';

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

function containerAvailable(image) {
  if (!image) return false;
  return spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8', timeout: 5000 }).status === 0;
}

function imageIdentity(image) {
  if (!image) return null;
  const probe = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8', timeout: 5000 });
  return probe.status === 0 ? String(probe.stdout || '').trim() || image : image;
}

function cacheKey(spec, runtimeImage) {
  const sourceRoot = path.resolve(spec.sourceRoot || spec.cwd);
  const payload = {
    version: 1,
    language: String(spec.language || '').toLowerCase(),
    entrypoint: spec.entrypoint,
    args: spec.args || [],
    sourceMerkleHash: directoryMerkleHash(sourceRoot),
    runtimeImage: imageIdentity(runtimeImage?.image),
    requiresGpu: Boolean(spec.requiresGpu),
    env: Object.fromEntries(Object.entries(spec.env || {}).sort(([left], [right]) => left.localeCompare(right))),
    datasetMounts: (spec.datasetMounts || []).map((mount) => ({ name: mount.name, manifestHash: mount.manifestHash || null, readOnly: mount.readOnly !== false })),
    outputPaths: [...(spec.outputPaths || [])].map(String).sort(),
  };
  return hashRecord('EmpiricalExecutionCacheKey', payload);
}

export function createMultiLanguageEmpiricalExecutor({ workerRunner, runtimeImages = {}, cache = null } = {}) {
  if (!workerRunner?.run) throw new Error('WorkerRunnerPort is required');
  if (cache) assertEmpiricalCachePort(cache);
  return assertEmpiricalExecutorPort({
    version: 1,
    kind: 'MultiLanguageEmpiricalExecutor',
    executorId: 'multi-language-empirical-v1',
    capabilities() {
      return Object.freeze({
        languages: Object.fromEntries(Object.entries(LANGUAGE_COMMANDS).map(([language, command]) => [language, available(command.executable) || containerAvailable(runtimeImages[language]?.image)])),
        runtimeImages: Object.fromEntries(Object.entries(runtimeImages).map(([language, value]) => [language, { image: value.image, available: containerAvailable(value.image) }])),
        gpuDetected: spawnSync('nvidia-smi', ['-L'], { encoding: 'utf8', timeout: 5000 }).status === 0,
        sandbox: workerRunner.availability,
      });
    },
    execute(spec = {}) {
      const command = LANGUAGE_COMMANDS[String(spec.language || '').toLowerCase()];
      if (!command) return Object.freeze({ status: 'empirical_language_unsupported', blockers: ['empirical_language_unsupported'], language: spec.language });
      const runtimeImage = runtimeImages[String(spec.language || '').toLowerCase()] || null;
      if (!available(command.executable) && !containerAvailable(runtimeImage?.image)) return Object.freeze({ status: 'empirical_runtime_unavailable', blockers: [`runtime_unavailable:${command.executable}`], language: spec.language });
      const capability = this.capabilities();
      if (spec.requiresGpu && !capability.gpuDetected) return Object.freeze({ status: 'empirical_gpu_unavailable', blockers: ['gpu_required_but_unavailable'], language: spec.language });
      const useCache = Boolean(cache && spec.cachePolicy !== 'bypass' && (spec.datasetMounts || []).every((mount) => mount.manifestHash));
      const executionCacheKey = useCache ? cacheKey(spec, runtimeImage) : null;
      const cached = executionCacheKey && spec.outputDirectory ? cache.get(executionCacheKey, { outputDirectory: spec.outputDirectory }) : null;
      if (cached) {
        const payload = {
          version: 1,
          kind: 'MultiLanguageEmpiricalReceipt',
          language: spec.language,
          status: 'empirical_execution_completed',
          runnerReceiptHash: cached.runnerReceiptHash,
          artifacts: cached.artifacts,
          isolation: { cacheArtifactHashVerified: true },
          containerImage: runtimeImage?.image || null,
          datasetMounts: spec.datasetMounts || [],
          blockers: [],
          exitCode: 0,
          stdoutTail: '',
          stderrTail: '',
          cacheHit: true,
          executionCacheKey,
          externalActionPerformed: false,
        };
        return Object.freeze({ ...payload, multiLanguageEmpiricalReceiptHash: hashRecord('MultiLanguageEmpiricalReceipt', payload) });
      }
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
        containerImage: runtimeImage?.image || null,
        containerExecutable: runtimeImage?.executable || null,
        datasetMounts: spec.datasetMounts || [],
        memoryBytes: spec.memoryBytes,
        cpuSeconds: spec.cpuSeconds,
        maximumProcesses: spec.maximumProcesses,
      });
      const payload = {
        version: 1,
        kind: 'MultiLanguageEmpiricalReceipt',
        language: spec.language,
        status: result.ok ? 'empirical_execution_completed' : 'empirical_execution_failed',
        runnerReceiptHash: result.receiptHash || null,
        artifacts: result.artifacts || [],
        isolation: result.isolation || {},
        containerImage: result.containerImage || null,
        datasetMounts: result.datasetMounts || [],
        blockers: result.blockers || [],
        exitCode: result.exitCode ?? null,
        stdoutTail: String(result.stdout || '').slice(-4000),
        stderrTail: String(result.stderr || '').slice(-4000),
        externalActionPerformed: false,
        cacheHit: false,
        executionCacheKey,
      };
      if (result.ok && executionCacheKey && spec.outputDirectory && (result.artifacts || []).length) cache.put(executionCacheKey, { artifacts: result.artifacts, outputDirectory: spec.outputDirectory, runnerReceiptHash: result.receiptHash || null });
      return Object.freeze({ ...payload, multiLanguageEmpiricalReceiptHash: hashRecord('MultiLanguageEmpiricalReceipt', payload) });
    },
  });
}
