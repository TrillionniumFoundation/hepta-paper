#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createMultiLanguageEmpiricalExecutor,
  AUTOMATION_RUNTIME_IMAGES,
} from '../../paper-composition/bootstrap/operator-automation-composition.mjs';
import {
  createOsSandboxedWorkerRunner,
  directoryMerkleHash,
} from '../../paper-composition/bootstrap/operator-runtime-composition.mjs';
import { PRODUCTION_LEAN_TOOLCHAIN } from '../../paper-domain/research/formal-verifier-policy.mjs';

const DEFAULT_STAGE_TIMEOUT_MS = 180_000;
const MAXIMUM_STAGE_TIMEOUT_MS = 10 * 60 * 1000;
const MINIMUM_STAGE_TIMEOUT_MS = 15_000;
const MINIMUM_COMPILE_TIMEOUT_MS = 1000;
export const RUNTIME_SMOKE_FIXTURE_ROOT = fileURLToPath(new URL(
  '../fixtures/automation-runtime-smoke', import.meta.url,
));
export const RUNTIME_SMOKE_STAGE_NAMES = Object.freeze([
  'pythonCpu', 'pythonGpu', 'rDatasetHelper', 'cudaGpu', 'lean', 'latex',
]);
export const RUNTIME_SMOKE_REPETITIONS = Object.freeze(['first', 'second']);
const FIXTURE_OPERATOR_AUTHORIZATION_HASH = 'sha256:7aab397a9266d35a4061f97e2d0405a2bbc79ee55ca4829ffc82179317a0267a';

function boundedTimeout(value, { minimum, maximum, blocker }) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const numeric = Number(raw);
  if (!Number.isSafeInteger(numeric) || numeric < minimum || numeric > maximum) {
    throw new Error(blocker);
  }
  return numeric;
}

function optionValue(argv, index, name) {
  const current = argv[index];
  if (current === name) {
    if (argv[index + 1] === undefined) throw new Error(`missing_cli_option_value:${name}`);
    return Object.freeze({ value: argv[index + 1], consumed: 2 });
  }
  if (current.startsWith(`${name}=`)) {
    return Object.freeze({ value: current.slice(name.length + 1), consumed: 1 });
  }
  return null;
}

export function parseRuntimeSmokeArguments(argv = [], environment = process.env) {
  let rAssetRoot = String(environment.HEPTA_R_ASSET_ROOT || '').trim() || path.join(
    RUNTIME_SMOKE_FIXTURE_ROOT, 'r-dataset',
  );
  let fixtureSource = environment.HEPTA_R_ASSET_ROOT ? 'operator-supplied' : 'repository-owned';
  let stageTimeoutMs = boundedTimeout(environment.HEPTA_RUNTIME_SMOKE_STAGE_TIMEOUT_MS, {
    minimum: MINIMUM_STAGE_TIMEOUT_MS,
    maximum: MAXIMUM_STAGE_TIMEOUT_MS,
    blocker: 'stage_timeout_ms_invalid',
  }) || DEFAULT_STAGE_TIMEOUT_MS;
  let compileTimeoutMs = boundedTimeout(environment.HEPTA_RUNTIME_SMOKE_COMPILE_TIMEOUT_MS, {
    minimum: MINIMUM_COMPILE_TIMEOUT_MS,
    maximum: MAXIMUM_STAGE_TIMEOUT_MS,
    blocker: 'compile_timeout_ms_invalid',
  }) || Math.min(stageTimeoutMs, 120_000);
  let keepFailedWorkspace = environment.HEPTA_RUNTIME_SMOKE_KEEP_FAILED_WORKSPACE === '1';
  let help = false;
  for (let index = 0; index < argv.length;) {
    const current = argv[index];
    if (current === '--help' || current === '-h') {
      help = true;
      index += 1;
      continue;
    }
    if (current === '--keep-failed-workspace') {
      keepFailedWorkspace = true;
      index += 1;
      continue;
    }
    const rAsset = optionValue(argv, index, '--r-asset-root');
    if (rAsset) {
      rAssetRoot = path.resolve(rAsset.value);
      fixtureSource = 'operator-supplied';
      index += rAsset.consumed;
      continue;
    }
    const stageTimeout = optionValue(argv, index, '--stage-timeout-ms');
    if (stageTimeout) {
      stageTimeoutMs = boundedTimeout(stageTimeout.value, {
        minimum: MINIMUM_STAGE_TIMEOUT_MS,
        maximum: MAXIMUM_STAGE_TIMEOUT_MS,
        blocker: 'stage_timeout_ms_invalid',
      });
      index += stageTimeout.consumed;
      continue;
    }
    const compileTimeout = optionValue(argv, index, '--compile-timeout-ms');
    if (compileTimeout) {
      compileTimeoutMs = boundedTimeout(compileTimeout.value, {
        minimum: MINIMUM_COMPILE_TIMEOUT_MS,
        maximum: MAXIMUM_STAGE_TIMEOUT_MS,
        blocker: 'compile_timeout_ms_invalid',
      });
      index += compileTimeout.consumed;
      continue;
    }
    throw new Error(`unknown_cli_option:${current}`);
  }
  return Object.freeze({
    rAssetRoot,
    fixtureSource,
    stageTimeoutMs,
    compileTimeoutMs,
    keepFailedWorkspace,
    help,
  });
}

export function createRuntimeSmokeProgressReporter({
  write = (line) => process.stderr.write(line),
  now = () => new Date(),
} = {}) {
  return (event) => write(`${JSON.stringify({
    version: 1,
    kind: 'AutomationRuntimeSmokeProgress',
    at: now().toISOString(),
    ...event,
  })}\n`);
}

function tail(value) {
  return String(value || '').slice(-4000);
}

function receiptPassed(receipt) {
  return Boolean(receipt && (
    receipt.ok === true
    || receipt.status === 'empirical_execution_completed'
    || receipt.status === 'runtime_probe_completed'
  ));
}

export function runtimeSmokeFailureContext(receipt = {}) {
  const runnerReceipt = receipt.runnerReceipt || {};
  const blockers = [...new Set([
    ...(receipt.blockers || []),
    ...(runnerReceipt.blockers || []),
  ].map(String))];
  const signal = receipt.signal ?? runnerReceipt.signal ?? null;
  const exitCode = receipt.exitCode ?? runnerReceipt.exitCode ?? null;
  return Object.freeze({
    status: receipt.status || 'automation_runtime_smoke_stage_failed',
    blockers,
    timedOut: blockers.some((blocker) => /tim(?:e|ed)[_-]?out/i.test(blocker)),
    signal,
    exitCode,
    stdoutTail: tail(receipt.stdoutTail ?? runnerReceipt.stdout),
    stderrTail: tail(receipt.stderrTail ?? runnerReceipt.stderr),
  });
}

function runtimeSmokeReceiptHash(receipt) {
  return receipt?.multiLanguageEmpiricalReceiptHash
    || receipt?.receiptHash
    || receipt?.runnerReceiptHash
    || null;
}

export async function runAuditedRuntimeSmokeAttempt({
  stageName,
  repetition,
  hardTimeoutMs,
  heartbeatIntervalMs = 5000,
  progress = createRuntimeSmokeProgressReporter(),
  execute,
} = {}) {
  const startedAt = Date.now();
  progress({ phase: 'stage_started', stageName, repetition, hardTimeoutMs });
  let hardTimeoutTriggered = false;
  let timeoutHandle = null;
  const heartbeatHandle = setInterval(() => progress({
    phase: 'stage_heartbeat',
    stageName,
    repetition,
    elapsedMs: Date.now() - startedAt,
  }), heartbeatIntervalMs);
  try {
    const timeout = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        hardTimeoutTriggered = true;
        const error = new Error('automation_runtime_smoke_stage_hard_timeout');
        error.code = 'AUTOMATION_RUNTIME_SMOKE_HARD_TIMEOUT';
        reject(error);
      }, hardTimeoutMs);
    });
    const receipt = await Promise.race([Promise.resolve().then(execute), timeout]);
    const passed = receiptPassed(receipt);
    const failure = passed ? null : runtimeSmokeFailureContext(receipt);
    progress({
      phase: passed ? 'stage_completed' : 'stage_failed',
      stageName,
      repetition,
      elapsedMs: Date.now() - startedAt,
      status: receipt?.status || null,
      receiptHash: runtimeSmokeReceiptHash(receipt),
      ...(failure ? { failure } : {}),
    });
    return Object.freeze({ passed, hardTimeoutTriggered, receipt, failure });
  } catch (error) {
    const failure = Object.freeze({
      status: 'automation_runtime_smoke_stage_exception',
      blockers: [tail(error?.message || 'automation_runtime_smoke_stage_exception')],
      timedOut: error?.code === 'AUTOMATION_RUNTIME_SMOKE_HARD_TIMEOUT',
      signal: null,
      exitCode: null,
      stdoutTail: '',
      stderrTail: '',
    });
    progress({
      phase: 'stage_failed',
      stageName,
      repetition,
      elapsedMs: Date.now() - startedAt,
      status: failure.status,
      failure,
    });
    return Object.freeze({ passed: false, hardTimeoutTriggered, receipt: null, failure });
  } finally {
    clearInterval(heartbeatHandle);
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function failedStageReceipt(stage, timeoutMs, error) {
  return Object.freeze({
    version: 1,
    kind: 'AutomationRuntimeSmokeStageReceipt',
    stage,
    status: 'runtime_probe_failed',
    ok: false,
    timeoutMs,
    blockers: [tail(error?.message || 'runtime_probe_failed')],
    externalActionPerformed: false,
  });
}

function runStage(stage, timeoutMs, action, reportProgress) {
  const startedAt = Date.now();
  reportProgress({ phase: 'stage_started', stageName: stage, hardTimeoutMs: timeoutMs });
  try {
    const result = action();
    if (typeof result?.then === 'function') throw new Error('automation_runtime_smoke_async_stage_forbidden');
    reportProgress({
      phase: receiptPassed(result) ? 'stage_completed' : 'stage_failed',
      stageName: stage,
      elapsedMs: Date.now() - startedAt,
      status: result?.status || (result?.ok === true ? 'completed' : 'failed'),
      receiptHash: runtimeSmokeReceiptHash(result),
    });
    return result;
  } catch (error) {
    const receipt = failedStageReceipt(stage, timeoutMs, error);
    reportProgress({
      phase: 'stage_failed',
      stageName: stage,
      elapsedMs: Date.now() - startedAt,
      status: receipt.status,
      blocker: receipt.blockers[0],
    });
    return receipt;
  }
}

function sha256File(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function commandReceipt({ stage, timeoutMs, result, artifacts = [] }) {
  const ok = result.status === 0 && !result.error;
  const timedOut = result.error?.code === 'ETIMEDOUT';
  return Object.freeze({
    version: 1,
    kind: 'AutomationRuntimeSmokeCommandReceipt',
    stage,
    status: ok ? 'runtime_probe_completed' : 'runtime_probe_failed',
    ok,
    timeoutMs,
    exitCode: result.status ?? null,
    signal: result.signal ?? null,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
    artifacts,
    blockers: ok ? [] : [timedOut ? 'runtime_probe_hard_timeout' : 'runtime_probe_command_failed'],
    externalActionPerformed: false,
  });
}

function runCommandStage({
  stage, timeoutMs, executable, args, cwd, env, reportProgress, artifacts = () => [],
}) {
  return runStage(stage, timeoutMs, () => {
    const result = spawnSync(executable, args, {
      cwd,
      env,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return commandReceipt({
      stage,
      timeoutMs,
      result,
      artifacts: result.status === 0 && !result.error ? artifacts() : [],
    });
  }, reportProgress);
}

function artifactIdentity(receipt) {
  return JSON.stringify((receipt?.artifacts || [])
    .map((item) => [item.path, item.sha256])
    .sort(([left], [right]) => left.localeCompare(right)));
}

function normalizedEmpiricalReceipt(receipt) {
  if (receipt?.status?.startsWith('empirical_')) return receipt;
  return Object.freeze({
    ...receipt,
    status: receipt?.ok ? 'empirical_execution_completed' : 'empirical_execution_failed',
  });
}

function resolveRFixtureRoot(configuration) {
  const resolved = fs.realpathSync(configuration.rAssetRoot);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('automation_runtime_smoke_r_fixture_root_invalid');
  }
  if (!fs.statSync(path.join(resolved, 'TBRL_functions.R')).isFile()) {
    throw new Error('automation_runtime_smoke_r_fixture_missing');
  }
  return Object.freeze({ root: resolved, source: configuration.fixtureSource });
}

function writeRuntimeSources(source) {
  const workloadRoot = path.join(RUNTIME_SMOKE_FIXTURE_ROOT, 'workload');
  for (const name of ['cpu.py', 'gpu.cu', 'gpu.py', 'actual_asset.R']) {
    fs.copyFileSync(path.join(workloadRoot, name), path.join(source, name));
  }
  fs.writeFileSync(path.join(source, 'lakefile.lean'), `import Lake
open Lake DSL
package heptaRuntimeSmoke
`);
  fs.writeFileSync(path.join(source, 'lean-toolchain'), `${PRODUCTION_LEAN_TOOLCHAIN}\n`);
  fs.writeFileSync(path.join(source, 'lake-manifest.json'), `${JSON.stringify({
    version: '1.1.0',
    packagesDir: '.lake/packages',
    packages: [],
    name: 'heptaRuntimeSmoke',
    lakeDir: '.lake',
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(source, 'RuntimeSmoke.lean'), `theorem runtimeSmokeAddition : 20 + 22 = 42 := by decide
#eval 6 * 7
`);
  fs.writeFileSync(path.join(source, 'runtime-smoke.tex'), `\\documentclass{article}
\\usepackage{amsmath,amsthm}
\\newtheorem{theorem}{Theorem}
\\begin{document}
\\begin{theorem}For $x=6$ and $y=7$, $xy=42$.\\end{theorem}
\\begin{proof}Direct numerical evaluation gives $6\\cdot7=42$.\\end{proof}
\\end{document}
`);
}

export function runAutomationRuntimeSmoke(configuration = parseRuntimeSmokeArguments()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-smoke-'));
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  const reportProgress = createRuntimeSmokeProgressReporter();
  let passed = false;
  try {
    const { stageTimeoutMs, compileTimeoutMs } = configuration;
    const rFixture = resolveRFixtureRoot(configuration);
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(output, { recursive: true });
    writeRuntimeSources(source);

    const gpuBinary = path.join(source, 'gpu-bench');
    const compileReceipt = runCommandStage({
      stage: 'cuda.compile',
      timeoutMs: compileTimeoutMs,
      executable: 'nvcc',
      args: ['-O2', path.join(source, 'gpu.cu'), '-o', gpuBinary],
      cwd: source,
      env: process.env,
      reportProgress,
    });
    const images = [
      AUTOMATION_RUNTIME_IMAGES.python.image,
      AUTOMATION_RUNTIME_IMAGES.pythonGpu.image,
      AUTOMATION_RUNTIME_IMAGES.r.image,
    ];
    const runner = createOsSandboxedWorkerRunner({
      allowedExecutables: receiptPassed(compileReceipt) ? [gpuBinary] : [],
      allowedRoots: [source],
      allowedOutputRoots: [output],
      allowedDatasetRoots: [rFixture.root],
      allowedContainerImages: images,
      allowGpu: true,
      maximumTimeoutMs: stageTimeoutMs,
      maximumMemoryBytes: 6 * 1024 * 1024 * 1024,
      maximumCpuSeconds: 600,
    });
    const execute = ({ language, entrypoint, image, requiresGpu = false, datasetMounts = [] }, suffix) => createMultiLanguageEmpiricalExecutor({
      workerRunner: runner,
      runtimeImages: { [language]: image },
    }).execute({
      language,
      entrypoint,
      cwd: source,
      sourceRoot: source,
      outputDirectory: path.join(output, suffix),
      outputPaths: ['results.json', 'results.csv'],
      requireSeparateOutputRoot: true,
      timeoutMs: stageTimeoutMs,
      requiresGpu,
      datasetMounts,
      env: {
        HEPTA_SEED: '42',
        HEPTA_OUTPUT_DIR: '/output',
        PYTHONHASHSEED: '42',
        OMP_NUM_THREADS: '1',
      },
      memoryBytes: requiresGpu ? 6 * 1024 * 1024 * 1024 : 3 * 1024 * 1024 * 1024,
      cpuSeconds: 600,
      cachePolicy: 'bypass',
    });
    const rDatasetMount = Object.freeze({
      name: 'runtime-smoke',
      source: rFixture.root,
      readOnly: true,
      manifestHash: directoryMerkleHash(rFixture.root),
      licenseId: 'LicenseRef-Hepta-Runtime-Smoke-Fixture',
      operatorAuthorizationHash: FIXTURE_OPERATOR_AUTHORIZATION_HASH,
    });
    const specs = [
      { name: 'pythonCpu', language: 'python', entrypoint: 'cpu.py', image: AUTOMATION_RUNTIME_IMAGES.python },
      {
        name: 'pythonGpu',
        language: 'python',
        entrypoint: 'gpu.py',
        image: AUTOMATION_RUNTIME_IMAGES.pythonGpu,
        requiresGpu: true,
      },
      {
        name: 'rDatasetHelper',
        language: 'r',
        entrypoint: 'actual_asset.R',
        image: AUTOMATION_RUNTIME_IMAGES.r,
        datasetMounts: [rDatasetMount],
      },
    ];
    const receipts = { cudaCompiler: compileReceipt };
    const replayReceipts = {};
    const reproducible = { cudaCompiler: receiptPassed(compileReceipt) };
    for (const spec of specs) {
      const first = runStage(
        `${spec.name}.first`, stageTimeoutMs,
        () => execute(spec, `${spec.name}-first`), reportProgress,
      );
      const second = runStage(
        `${spec.name}.second`, stageTimeoutMs,
        () => execute(spec, `${spec.name}-second`), reportProgress,
      );
      receipts[spec.name] = first;
      replayReceipts[spec.name] = second;
      reproducible[spec.name] = receiptPassed(first)
        && receiptPassed(second)
        && artifactIdentity(first) === artifactIdentity(second);
    }

    if (receiptPassed(compileReceipt)) {
      const runCuda = (suffix) => runner.run({
        executable: gpuBinary,
        args: [],
        cwd: source,
        sourceRoot: source,
        outputDirectory: path.join(output, suffix),
        outputPaths: ['results.json'],
        timeoutMs: stageTimeoutMs,
        requiresGpu: true,
        env: { HEPTA_OUTPUT_DIR: '/output' },
        memoryBytes: 1024 * 1024 * 1024,
        cpuSeconds: 120,
        containerImage: AUTOMATION_RUNTIME_IMAGES.pythonGpu.image,
        containerExecutable: './gpu-bench',
      });
      const cudaFirst = normalizedEmpiricalReceipt(runStage(
        'cudaGpu.first', stageTimeoutMs, () => runCuda('cudaGpu-first'), reportProgress,
      ));
      const cudaSecond = normalizedEmpiricalReceipt(runStage(
        'cudaGpu.second', stageTimeoutMs, () => runCuda('cudaGpu-second'), reportProgress,
      ));
      receipts.cudaGpu = cudaFirst;
      replayReceipts.cudaGpu = cudaSecond;
      reproducible.cudaGpu = receiptPassed(cudaFirst)
        && receiptPassed(cudaSecond)
        && artifactIdentity(cudaFirst) === artifactIdentity(cudaSecond);
    } else {
      receipts.cudaGpu = failedStageReceipt(
        'cudaGpu.first', stageTimeoutMs, new Error('cuda_fixture_compilation_failed'),
      );
      replayReceipts.cudaGpu = failedStageReceipt(
        'cudaGpu.second', stageTimeoutMs, new Error('cuda_fixture_compilation_failed'),
      );
      reproducible.cudaGpu = false;
      reportProgress({
        phase: 'stage_skipped', stageName: 'cudaGpu.first', blocker: 'cuda_fixture_compilation_failed',
      });
      reportProgress({
        phase: 'stage_skipped', stageName: 'cudaGpu.second', blocker: 'cuda_fixture_compilation_failed',
      });
    }

    const leanEnvironment = { ...process.env, ELAN_TOOLCHAIN: PRODUCTION_LEAN_TOOLCHAIN };
    const leanFirst = runCommandStage({
      stage: 'lean.first',
      timeoutMs: stageTimeoutMs,
      executable: 'lake',
      args: ['env', 'lean', 'RuntimeSmoke.lean'],
      cwd: source,
      env: leanEnvironment,
      reportProgress,
    });
    const leanSecond = runCommandStage({
      stage: 'lean.second',
      timeoutMs: stageTimeoutMs,
      executable: 'lake',
      args: ['env', 'lean', 'RuntimeSmoke.lean'],
      cwd: source,
      env: leanEnvironment,
      reportProgress,
    });
    receipts.lean = leanFirst;
    replayReceipts.lean = leanSecond;
    reproducible.lean = receiptPassed(leanFirst)
      && receiptPassed(leanSecond)
      && leanFirst.stdoutTail === leanSecond.stdoutTail;

    const latexEnvironment = {
      ...process.env,
      FORCE_SOURCE_DATE: '1',
      SOURCE_DATE_EPOCH: '946684800',
      TZ: 'UTC',
    };
    const latexBuildRoot = path.join(output, 'latex-build');
    const runLatex = (stage) => {
      const buildRoot = latexBuildRoot;
      fs.mkdirSync(buildRoot, { recursive: true });
      const pdf = path.join(buildRoot, 'runtime-smoke.pdf');
      return runCommandStage({
        stage,
        timeoutMs: stageTimeoutMs,
        executable: 'latexmk',
        args: [
          '-pdf',
          '-interaction=nonstopmode',
          '-halt-on-error',
          `-outdir=${buildRoot}`,
          'runtime-smoke.tex',
        ],
        cwd: source,
        env: latexEnvironment,
        reportProgress,
        artifacts: () => [{ path: 'runtime-smoke.pdf', sha256: sha256File(pdf) }],
      });
    };
    const latexFirst = runLatex('latex.first');
    fs.rmSync(latexBuildRoot, { recursive: true, force: true });
    const latexSecond = runLatex('latex.second');
    receipts.latex = latexFirst;
    replayReceipts.latex = latexSecond;
    reproducible.latex = receiptPassed(latexFirst)
      && receiptPassed(latexSecond)
      && artifactIdentity(latexFirst) === artifactIdentity(latexSecond);

    passed = Object.values(receipts).every(receiptPassed)
      && Object.values(replayReceipts).every(receiptPassed)
      && Object.values(reproducible).every(Boolean);
    process.stdout.write(`${JSON.stringify({
      status: passed ? 'automation_runtime_smoke_passed' : 'automation_runtime_smoke_failed',
      passed,
      stageTimeoutMs,
      rFixtureSource: rFixture.source,
      reproducible,
      receipts,
      replayReceipts,
      externalActionPerformed: false,
    }, null, 2)}\n`);
    if (!passed) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      status: 'automation_runtime_smoke_failed',
      passed: false,
      blocker: tail(error?.message || 'automation_runtime_smoke_failed'),
      externalActionPerformed: false,
    }, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    if (passed || !configuration.keepFailedWorkspace) {
      fs.rmSync(root, { recursive: true, force: true });
    } else {
      reportProgress({ phase: 'failed_workspace_retained', workspaceRoot: root });
    }
  }
}

export function runtimeSmokeHelp() {
  return `Usage: node paper-core/bin/automation-runtime-smoke.mjs [options]

Runs real Python, R, GPU/CUDA, Lean, and LaTeX probes twice. By default the R
dataset mount uses a repository-owned minimal R fixture.

Options:
  --r-asset-root PATH        Use an explicitly supplied read-only R fixture
  --stage-timeout-ms MS      Per-probe hard timeout (15000-600000)
  --compile-timeout-ms MS    CUDA compilation hard timeout (1000-600000)
  --keep-failed-workspace    Retain only a failed temporary smoke workspace
  --help                     Show this help

Progress is emitted as JSON Lines on stderr. The final receipt is JSON on stdout.
`;
}

const invokedAsEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsEntrypoint) {
  try {
    const configuration = parseRuntimeSmokeArguments(process.argv.slice(2), process.env);
    if (configuration.help) process.stdout.write(runtimeSmokeHelp());
    else runAutomationRuntimeSmoke(configuration);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      status: 'automation_runtime_smoke_failed',
      passed: false,
      blocker: tail(error?.message || 'automation_runtime_smoke_failed'),
      externalActionPerformed: false,
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
