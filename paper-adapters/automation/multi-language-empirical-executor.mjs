import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertEmpiricalExecutorPort } from '../../paper-ports/empirical-executor-port.mjs';
import { assertEmpiricalCachePort } from '../../paper-ports/empirical-cache-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { inspectWorkspaceExecutionSnapshot, sourceTreeExcludedNames } from '../runtime/execution-snapshot.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';
import { verifyCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import { buildDatasetAuthorizationSet } from '../../paper-domain/automation/experiment-run-contract.mjs';
import { executeSystemBenchmarkEmpiricalRun } from './system-benchmark-empirical-execution.mjs';
import { selectAndValidateWorkerEnvironment } from '../runtime/worker-environment-policy.mjs';
import { buildEnvironmentBoundEmpiricalCacheKey, evaluateEmpiricalCacheReproducibility, verifyEmpiricalCacheReproducibilityDecision } from '../../paper-domain/automation/empirical-cache-reproducibility-policy.mjs';
import { verifyEmpiricalEnvironmentBom } from '../../paper-domain/automation/environment-bom-contract.mjs';
const LANGUAGE_COMMANDS = Object.freeze({
  python: { executable: 'python3', args: (spec) => [spec.entrypoint, ...(spec.args || [])] },
  node: { executable: process.execPath, args: (spec) => [spec.entrypoint, ...(spec.args || [])] },
  r: { executable: 'Rscript', args: (spec) => [spec.entrypoint, ...(spec.args || [])] },
  julia: { executable: 'julia', args: (spec) => ['--project=@.', spec.entrypoint, ...(spec.args || [])] },
  lean: { executable: 'lake', args: (spec) => spec.entrypoint ? ['env', 'lean', spec.entrypoint] : ['build'] },
  latex: {
    executable: 'latexmk',
    args: (spec) => [
      '-pdf',
      '-interaction=nonstopmode',
      '-halt-on-error',
      '-outdir=/output',
      spec.entrypoint,
    ],
  },
});
function available(executable) {
  return spawnSync('which', [executable], { encoding: 'utf8', timeout: 3000 }).status === 0;
}

function normalizeImageDigest(value) {
  const digest = String(value || '').trim().toLowerCase();
  return /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null;
}

function normalizeExecutionRuntimeIdentity(resolution) {
  if (!resolution || typeof resolution !== 'object') return null;
  const runtimeType = resolution.runtimeType === 'container' ? 'container' : resolution.runtimeType === 'host' ? 'host' : null;
  if (!runtimeType) return null;
  const digest = runtimeType === 'container' ? normalizeImageDigest(resolution.digest) : null;
  const runtimeIdentityHash = /^sha256:[0-9a-f]{64}$/.test(String(resolution.runtimeIdentityHash || ''))
    ? resolution.runtimeIdentityHash
    : null;
  return Object.freeze({
    runtimeType,
    runtimeIdentityHash,
    requestedImage: runtimeType === 'container' ? String(resolution.requestedImage || '') : null,
    digest,
    available: resolution.available === true && (runtimeType !== 'container' || Boolean(digest)) && Boolean(runtimeIdentityHash),
    allowlisted: resolution.allowlisted === true,
    cacheable: resolution.cacheable === true && Boolean(runtimeIdentityHash),
    capability: resolution,
  });
}

function legacyHostRuntimeIdentity(workerRunner, executable) {
  if (workerRunner?.availability?.backend === 'docker') return null;
  const payload = {
    version: 1,
    kind: 'LegacyHostRuntimeIdentity',
    runtimeType: 'host',
    runnerId: workerRunner?.runnerId || null,
    backend: workerRunner?.availability?.backend || 'host',
    executable: String(executable || ''),
    platform: process.platform,
    architecture: process.arch,
  };
  return Object.freeze({
    ...payload,
    runtimeIdentityHash: hashRecord('LegacyHostRuntimeIdentity', payload),
    available: available(executable),
    allowlisted: true,
    cacheable: false,
    capability: null,
  });
}

function executionSourceSnapshot(spec) {
  const sourceRoot = path.resolve(spec.sourceRoot || spec.cwd);
  const sourceDatasetRoots = (spec.datasetMounts || [])
    .map((mount) => mount.source)
    .filter(Boolean)
    .map((source) => path.resolve(source))
    .filter((source) => source !== sourceRoot && isPathWithin(sourceRoot, source));
  return inspectWorkspaceExecutionSnapshot(sourceRoot, {
    excludeRoots: sourceDatasetRoots,
    excludeNames: sourceTreeExcludedNames(sourceRoot),
  });
}

function nonDeterministicExecution(spec) {
  return spec?.nonDeterministic === true || spec?.deterministic === false;
}

function cacheDescriptor(spec, runtimeIdentity) {
  const sourceSnapshot = executionSourceSnapshot(spec);
  const payload = {
    version: 3,
    language: String(spec.language || '').toLowerCase(),
    entrypoint: spec.entrypoint,
    args: spec.args || [],
    sourceMerkleHash: sourceSnapshot.merkleHash,
    sourceWorkspaceManifestHash: sourceSnapshot.manifestHash,
    runtimeIdentity: Object.freeze({ runtimeType: runtimeIdentity.runtimeType, runtimeIdentityHash: runtimeIdentity.runtimeIdentityHash }),
    requiresGpu: Boolean(spec.requiresGpu),
    nonDeterministic: nonDeterministicExecution(spec),
    limits: {
      memoryBytes: Number(spec.memoryBytes || 0),
      cpuSeconds: Number(spec.cpuSeconds || 0),
      maximumProcesses: Number(spec.maximumProcesses || 0),
    },
    env: Object.fromEntries(Object.entries(spec.env || {}).sort(([left], [right]) => left.localeCompare(right))),
    datasetMounts: (spec.datasetMounts || []).map((mount) => ({ name: mount.name, manifestHash: mount.manifestHash || null, licenseId: mount.licenseId || null, operatorAuthorizationHash: mount.operatorAuthorizationHash || null, readOnly: mount.readOnly === true })),
    outputPaths: [...(spec.outputPaths || [])].map(String).sort(),
  };
  return Object.freeze({
    executionCacheKey: hashRecord('EmpiricalExecutionCacheKey', payload),
    sourceMerkleHash: sourceSnapshot.merkleHash,
    sourceWorkspaceManifestHash: sourceSnapshot.manifestHash,
    blockers: sourceSnapshot.blockers,
  });
}

function materializeVerifiedCachedArtifacts(cached, stagingRoot, outputDirectory) {
  const artifacts = Array.isArray(cached?.artifacts) ? cached.artifacts : [];
  const verified = [];
  for (const artifact of artifacts) {
    const relative = String(artifact?.path || '');
    const source = path.resolve(stagingRoot, relative);
    const destination = path.resolve(outputDirectory, relative);
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]+/).includes('..')
      || !isPathWithin(stagingRoot, source) || !isPathWithin(outputDirectory, destination)) {
      return Object.freeze({ ok: false, blockers: [`empirical_cache_artifact_path_unsafe:${relative || '<empty>'}`] });
    }
    let stat = null;
    let sourceHash = null;
    try {
      stat = fs.lstatSync(source);
      sourceHash = stat.isFile() && !stat.isSymbolicLink() ? sha256FileSync(source) : null;
    } catch { /* blocker below */ }
    if (!sourceHash || sourceHash !== artifact.sha256) {
      return Object.freeze({ ok: false, blockers: [`empirical_cache_artifact_hash_mismatch:${relative}`] });
    }
    verified.push({ artifact, source, destination });
  }
  try {
    for (const item of verified) {
      fs.mkdirSync(path.dirname(item.destination), { recursive: true });
      fs.copyFileSync(item.source, item.destination);
      if (sha256FileSync(item.destination) !== item.artifact.sha256) throw new Error(`empirical_cache_artifact_copy_mismatch:${item.artifact.path}`);
    }
  } catch (error) {
    return Object.freeze({ ok: false, blockers: [error?.message || 'empirical_cache_artifact_materialization_failed'] });
  }
  return Object.freeze({ ok: true, blockers: [] });
}

export function createMultiLanguageEmpiricalExecutor({
  workerRunner,
  runtimeImages = {},
  cache = null,
  operatorDatasetAuthorityTrustStore = null,
  runtimeRoot = null,
  runRawEventRecomputation = null,
} = {}) {
  if (!workerRunner?.run) throw new Error('WorkerRunnerPort is required');
  if (cache) assertEmpiricalCachePort(cache);
  const prepareRuntimeIdentity = (command, runtimeImage) => {
    if (typeof workerRunner.resolveExecutionRuntimeIdentity === 'function') {
      return normalizeExecutionRuntimeIdentity(workerRunner.resolveExecutionRuntimeIdentity({
        executable: command.executable,
        containerImage: runtimeImage?.image || null,
        containerExecutable: runtimeImage?.executable || null,
      }));
    }
    if (runtimeImage?.image) return null;
    return legacyHostRuntimeIdentity(workerRunner, command.executable);
  };
  return assertEmpiricalExecutorPort({
    version: 1,
    kind: 'MultiLanguageEmpiricalExecutor',
    executorId: 'multi-language-empirical-v1',
    capabilities() {
      const resolvedImages = Object.fromEntries(Object.entries(runtimeImages).map(([language, value]) => {
        try { return [language, prepareRuntimeIdentity(LANGUAGE_COMMANDS[language], value)]; } catch { return [language, null]; }
      }));
      return Object.freeze({
        languages: Object.fromEntries(Object.entries(LANGUAGE_COMMANDS).map(([language, command]) => [language, available(command.executable) || Boolean(resolvedImages[language]?.available && resolvedImages[language]?.allowlisted)])),
        runtimeImages: Object.fromEntries(Object.entries(runtimeImages).map(([language, value]) => [language, { image: value.image, digest: resolvedImages[language]?.digest || null, available: Boolean(resolvedImages[language]?.available && resolvedImages[language]?.allowlisted) }])),
        gpuDetected: spawnSync('nvidia-smi', ['-L'], { encoding: 'utf8', timeout: 5000 }).status === 0,
        sandbox: workerRunner.availability,
        academicEmpiricalReady: workerRunner.availability?.academicEmpiricalReady === true,
        academicEmpiricalReadinessReason: workerRunner.availability?.academicEmpiricalReadinessReason || 'academic_empirical_readiness_not_reported',
      });
    },
    execute(spec = {}) {
      const benchmarkSelector = spec.benchmarkSelector || null;
      const language = String(spec.language || '').toLowerCase();
      if (language === 'latex'
        && (benchmarkSelector || (spec.datasetMounts || []).length > 0)) {
        return Object.freeze({
          status: 'empirical_compile_authority_invalid',
          blockers: ['latex_compile_benchmark_or_dataset_authority_forbidden'],
          failureClass: 'authority_failure',
          repairEligible: false,
          language: spec.language,
        });
      }
      if (spec.requireSeparateOutputRoot === true && spec.env?.HEPTA_OUTPUT_DIR !== '/output') {
        return Object.freeze({
          status: 'empirical_output_contract_invalid',
          blockers: ['empirical_output_directory_binding_invalid'],
          language: spec.language,
        });
      }
      if (!benchmarkSelector && (spec.env?.HEPTA_BENCHMARK_ID || spec.env?.HEPTA_BENCHMARK_SELECTOR_HASH)) {
        return Object.freeze({
          status: 'empirical_benchmark_selector_invalid',
          blockers: ['campaign_benchmark_selector_required'],
          language: spec.language,
        });
      }
      if (benchmarkSelector) {
        const selectorVerification = verifyCampaignBenchmarkSelector(benchmarkSelector, {
          benchmarkId: benchmarkSelector.benchmarkId,
          datasetMounts: spec.datasetMounts || [],
        });
        if (!selectorVerification.valid) {
          return Object.freeze({
            status: 'empirical_benchmark_selector_invalid',
            blockers: selectorVerification.blockers,
            language: spec.language,
          });
        }
      }
      const effectiveEnv = {
        ...(spec.env || {}),
        ...(benchmarkSelector ? {
          HEPTA_BENCHMARK_ID: benchmarkSelector.benchmarkId,
          HEPTA_BENCHMARK_SELECTOR_HASH: benchmarkSelector.campaignBenchmarkSelectorHash,
          HEPTA_EXPERIMENT_DESIGN_HASH: benchmarkSelector.experimentDesignHash,
          HEPTA_EXPERIMENT_DESIGN_JSON: JSON.stringify(benchmarkSelector.experimentDesign),
          HEPTA_BENCHMARK_HARNESS_HASH: benchmarkSelector.experimentDesign.benchmarkHarnessHash,
          HEPTA_DATASET_AUTHORIZATION_SET_HASH: buildDatasetAuthorizationSet(spec.datasetMounts || []).datasetAuthorizationSetHash,
        } : {}),
      };
      const { permittedEnvironment, environmentBindingHash: expectedEnvironmentBindingHash } = selectAndValidateWorkerEnvironment({
        env: effectiveEnv,
        datasetAuthorizationSetHash: buildDatasetAuthorizationSet(spec.datasetMounts || []).datasetAuthorizationSetHash,
      });
      const command = LANGUAGE_COMMANDS[String(spec.language || '').toLowerCase()];
      if (!command) return Object.freeze({ status: 'empirical_language_unsupported', blockers: ['empirical_language_unsupported'], language: spec.language });
      if (spec.signal?.aborted) return Object.freeze({ status: 'empirical_execution_cancelled', blockers: ['empirical_execution_aborted'], language: spec.language });
      const runtimeImage = runtimeImages[String(spec.language || '').toLowerCase()] || null;
      let executionIdentity = null;
      try { executionIdentity = prepareRuntimeIdentity(command, runtimeImage); } catch { /* fail closed below */ }
      if (!executionIdentity?.available) {
        if (!runtimeImage?.image) return Object.freeze({ status: 'empirical_runtime_identity_unavailable', blockers: ['runtime_execution_identity_unavailable'], language: spec.language });
        return Object.freeze({ status: 'empirical_runtime_image_identity_unavailable', blockers: [`runtime_image_identity_unavailable:${runtimeImage.image}`], language: spec.language });
      }
      if (!executionIdentity.allowlisted) {
        return Object.freeze({ status: 'empirical_runtime_image_not_allowlisted', blockers: [`runtime_image_not_allowlisted:${runtimeImage.image}`], language: spec.language });
      }
      if (spec.requiresGpu && spawnSync('nvidia-smi', ['-L'], { encoding: 'utf8', timeout: 5000 }).status !== 0) return Object.freeze({ status: 'empirical_gpu_unavailable', blockers: ['gpu_required_but_unavailable'], language: spec.language });
      const effectiveDeterminismPolicy = spec.determinismPolicy || (nonDeterministicExecution(spec) ? 'nondeterministic' : 'unknown');
      const cacheEnvironmentBinding = !benchmarkSelector && cache && typeof workerRunner.prepareEnvironmentBom === 'function'
        ? workerRunner.prepareEnvironmentBom({ executionIdentity: executionIdentity.capability, language: spec.language, executable: runtimeImage?.executable || command.executable, requiresGpu: Boolean(spec.requiresGpu), determinismPolicy: effectiveDeterminismPolicy, deterministicSeed: spec.deterministicSeed ?? effectiveEnv.HEPTA_SEED ?? effectiveEnv.PYTHONHASHSEED ?? null, timeoutMs: spec.timeoutMs, memoryBytes: spec.memoryBytes, cpuSeconds: spec.cpuSeconds, maximumProcesses: spec.maximumProcesses, requestedMaximumOutputBytes: spec.maximumOutputBytes, env: Object.fromEntries(permittedEnvironment), runtimePackageClosure: spec.runtimePackageClosure || null, runtimeBuildReproducibility: runtimeImage?.buildReproducibility || null })
        : null;
      const cacheReproducibilityDecision = evaluateEmpiricalCacheReproducibility({ environmentBom: cacheEnvironmentBinding?.environmentBom, academic: Boolean(benchmarkSelector), cachePolicy: spec.cachePolicy || 'default' });
      const useCache = Boolean(!benchmarkSelector && cache && executionIdentity.cacheable && cacheEnvironmentBinding?.blockers.length === 0
        && cacheReproducibilityDecision.cacheAllowed && (spec.datasetMounts || []).every((mount) => mount.manifestHash));
      const executionCacheDescriptor = useCache ? cacheDescriptor({ ...spec, env: effectiveEnv }, executionIdentity) : null;
      const benchmarkSourceDescriptor = benchmarkSelector ? cacheDescriptor({ ...spec, env: effectiveEnv }, executionIdentity) : null;
      if (benchmarkSourceDescriptor?.blockers.length) {
        return Object.freeze({
          status: 'empirical_source_snapshot_unsafe',
          blockers: ['worker_workspace_execution_snapshot_unsafe', ...benchmarkSourceDescriptor.blockers],
          language: spec.language,
          cacheHit: false,
        });
      }
      if (executionCacheDescriptor?.blockers.length) {
        return Object.freeze({
          status: 'empirical_source_snapshot_unsafe',
          blockers: ['worker_workspace_execution_snapshot_unsafe', ...executionCacheDescriptor.blockers],
          language: spec.language,
          cacheHit: false,
        });
      }
      const baseCacheDescriptor = executionCacheDescriptor ? Object.freeze({ sourceBoundExecutionCacheKey: executionCacheDescriptor.executionCacheKey }) : null;
      const executionCacheKey = buildEnvironmentBoundEmpiricalCacheKey(baseCacheDescriptor, cacheReproducibilityDecision);
      let cacheReplayStagingRoot = null;
      let cached = null;
      if (executionCacheKey && spec.outputDirectory) {
        cacheReplayStagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-empirical-cache-replay-'));
        try { cached = cache.get(executionCacheKey, { outputDirectory: cacheReplayStagingRoot }); }
        catch { cached = null; }
        if (!cached) {
          fs.rmSync(cacheReplayStagingRoot, { recursive: true, force: true });
          cacheReplayStagingRoot = null;
        }
      }
      if (cached) {
        if (cached.environmentBom?.environmentBomHash !== cacheEnvironmentBinding?.environmentBomHash
          || !verifyEmpiricalCacheReproducibilityDecision(cached.cacheReproducibilityDecision, cached.environmentBom)
          || cached.cacheReproducibilityDecision.cacheReproducibilityDecisionHash !== cacheReproducibilityDecision.cacheReproducibilityDecisionHash) {
          fs.rmSync(cacheReplayStagingRoot, { recursive: true, force: true });
          cached = null;
          cacheReplayStagingRoot = null;
        }
      }
      if (cached) {
        const currentSourceSnapshot = executionSourceSnapshot(spec);
        if (currentSourceSnapshot.blockers.length
          || currentSourceSnapshot.merkleHash !== executionCacheDescriptor.sourceMerkleHash
          || currentSourceSnapshot.manifestHash !== executionCacheDescriptor.sourceWorkspaceManifestHash) {
          fs.rmSync(cacheReplayStagingRoot, { recursive: true, force: true });
          return Object.freeze({
            status: 'empirical_source_changed_during_cache_lookup',
            blockers: ['empirical_source_changed_during_cache_lookup', ...currentSourceSnapshot.blockers],
            language: spec.language,
            cacheHit: false,
            executionCacheKey,
          });
        }
        const materialized = materializeVerifiedCachedArtifacts(cached, cacheReplayStagingRoot, path.resolve(spec.outputDirectory));
        fs.rmSync(cacheReplayStagingRoot, { recursive: true, force: true });
        if (!materialized.ok) {
          return Object.freeze({
            status: 'empirical_cache_artifact_verification_failed',
            blockers: materialized.blockers,
            language: spec.language,
            cacheHit: false,
            executionCacheKey,
          });
        }
        const sourceSnapshotAfterMaterialization = executionSourceSnapshot(spec);
        if (sourceSnapshotAfterMaterialization.blockers.length
          || sourceSnapshotAfterMaterialization.merkleHash !== executionCacheDescriptor.sourceMerkleHash
          || sourceSnapshotAfterMaterialization.manifestHash !== executionCacheDescriptor.sourceWorkspaceManifestHash) {
          return Object.freeze({
            status: 'empirical_source_changed_during_cache_lookup',
            blockers: ['empirical_source_changed_during_cache_lookup', ...sourceSnapshotAfterMaterialization.blockers],
            language: spec.language,
            cacheHit: false,
            executionCacheKey,
          });
        }
        const payload = {
          version: 1,
          kind: 'MultiLanguageEmpiricalReceipt',
          language: spec.language,
          status: 'empirical_execution_completed',
          runnerReceiptHash: cached.runnerReceiptHash,
          artifacts: cached.artifacts,
          isolation: { cacheArtifactHashVerified: true },
          runtimeIdentityType: executionIdentity.runtimeType,
          runtimeIdentityHash: executionIdentity.runtimeIdentityHash,
          runtimeIdentityCacheable: executionIdentity.cacheable,
          containerImage: executionIdentity.runtimeType === 'container' ? executionIdentity.requestedImage : null,
          containerImageDigest: executionIdentity.runtimeType === 'container' ? executionIdentity.digest : null,
          datasetMounts: spec.datasetMounts || [],
          benchmarkSelector,
          campaignBenchmarkSelectorHash: benchmarkSelector?.campaignBenchmarkSelectorHash || null,
          experimentDesignHash: benchmarkSelector?.experimentDesignHash || null,
          benchmarkHarnessHash: benchmarkSelector?.experimentDesign?.benchmarkHarnessHash || null,
          datasetAuthorizationSetHash: buildDatasetAuthorizationSet(spec.datasetMounts || []).datasetAuthorizationSetHash,
          environmentBindingHash: expectedEnvironmentBindingHash,
          environmentBom: cached.environmentBom,
          environmentBomHash: cached.environmentBom?.environmentBomHash || null,
          cacheReproducibilityDecision: cached.cacheReproducibilityDecision,
          blockers: [],
          exitCode: 0,
          stdoutTail: '',
          stderrTail: '',
          cacheHit: true,
          executionCacheKey,
          sourceMerkleHash: executionCacheDescriptor.sourceMerkleHash,
          sourceWorkspaceManifestHash: executionCacheDescriptor.sourceWorkspaceManifestHash,
          cacheBypassReason: null,
          externalActionPerformed: false,
        };
        return Object.freeze({ ...payload, multiLanguageEmpiricalReceiptHash: hashRecord('MultiLanguageEmpiricalReceipt', payload) });
      }
      if (benchmarkSelector) {
        return executeSystemBenchmarkEmpiricalRun({ spec, benchmarkSelector, effectiveEnv, command, runtimeImage,
          executionIdentity, benchmarkSourceDescriptor, workerRunner, prepareRuntimeIdentity,
          operatorDatasetAuthorityTrustStore, runtimeRoot, runRawEventRecomputation });
      }
      const operation = () => workerRunner.run({
        executable: command.executable,
        args: command.args(spec),
        cwd: spec.cwd,
        sourceRoot: spec.sourceRoot || spec.cwd,
        timeoutMs: spec.timeoutMs,
        outputPaths: spec.outputPaths || [],
        outputDirectory: spec.outputDirectory,
        requiresGpu: Boolean(spec.requiresGpu),
        env: effectiveEnv,
        executionIdentity: executionIdentity.capability,
        containerImage: runtimeImage?.image || null,
        containerExecutable: runtimeImage?.executable || null,
        datasetMounts: spec.datasetMounts || [],
        requireDatasetAccessProof: Boolean(benchmarkSelector && (spec.datasetMounts || []).length),
        memoryBytes: spec.memoryBytes,
        cpuSeconds: spec.cpuSeconds,
        maximumProcesses: spec.maximumProcesses,
        expectedSourceMerkleHash: executionCacheDescriptor?.sourceMerkleHash || null,
        expectedSourceWorkspaceManifestHash: executionCacheDescriptor?.sourceWorkspaceManifestHash || null,
        requireSeparateOutputRoot: spec.requireSeparateOutputRoot === true,
        language: spec.language,
        determinismPolicy: effectiveDeterminismPolicy,
        deterministicSeed: spec.deterministicSeed ?? effectiveEnv.HEPTA_SEED ?? effectiveEnv.PYTHONHASHSEED ?? null,
        requestedMaximumOutputBytes: spec.maximumOutputBytes,
        runtimePackageClosure: spec.runtimePackageClosure || null,
        runtimeBuildReproducibility: runtimeImage?.buildReproducibility || null,
        signal: spec.signal || null,
      });
      const pending = typeof spec.runEmpiricalCell === 'function'
        ? spec.runEmpiricalCell(operation, { requiresGpu: Boolean(spec.requiresGpu) })
        : operation();
      const finish = (result) => {
        const cancelled = result.status === 'os_sandbox_worker_cancelled' || (result.blockers || []).includes('os_sandbox_command_aborted');
        const imageIdentityMismatch = executionIdentity.runtimeType === 'container' && result.containerImageDigest !== executionIdentity.digest;
        const runtimeIdentityMismatch = Boolean(executionIdentity.capability && result.runtimeIdentityHash !== executionIdentity.runtimeIdentityHash);
        const environmentBindingMismatch = Boolean(benchmarkSelector) && result.environmentBindingHash !== expectedEnvironmentBindingHash;
        const environmentBomInvalid = !cancelled && !verifyEmpiricalEnvironmentBom(result.environmentBom).valid;
        const environmentBomMismatch = Boolean(cacheEnvironmentBinding && (result.environmentBomHash !== cacheEnvironmentBinding.environmentBomHash));
        const executionSourceMismatch = Boolean(executionCacheDescriptor && (
          result.workSourceMerkleHash !== executionCacheDescriptor.sourceMerkleHash
          || result.workWorkspaceManifestHash !== executionCacheDescriptor.sourceWorkspaceManifestHash
        ));
        const executionSucceeded = Boolean(result.ok && !imageIdentityMismatch && !runtimeIdentityMismatch && !environmentBindingMismatch && !environmentBomInvalid && !environmentBomMismatch && !executionSourceMismatch);
        const effectiveCacheDecision = cacheEnvironmentBinding ? cacheReproducibilityDecision
          : evaluateEmpiricalCacheReproducibility({ environmentBom: result.environmentBom, academic: false, cachePolicy: spec.cachePolicy || 'default' });
        const payload = {
          version: 1,
          kind: 'MultiLanguageEmpiricalReceipt',
          language: spec.language,
          status: cancelled ? 'empirical_execution_cancelled' : executionSucceeded ? 'empirical_execution_completed' : 'empirical_execution_failed',
          runnerReceiptHash: result.receiptHash || null,
          runnerReceipt: result,
          artifacts: result.artifacts || [],
          isolation: result.isolation || {},
          runtimeIdentityType: executionIdentity.runtimeType,
          runtimeIdentityHash: executionIdentity.runtimeIdentityHash,
          runtimeIdentityCacheable: executionIdentity.cacheable,
          containerImage: executionIdentity.runtimeType === 'container' ? executionIdentity.requestedImage : null,
          containerImageDigest: executionIdentity.runtimeType === 'container' ? executionIdentity.digest : null,
          datasetMounts: result.datasetMounts || [],
          benchmarkSelector,
          campaignBenchmarkSelectorHash: benchmarkSelector?.campaignBenchmarkSelectorHash || null,
          experimentDesignHash: benchmarkSelector?.experimentDesignHash || null,
          benchmarkHarnessHash: benchmarkSelector?.experimentDesign?.benchmarkHarnessHash || null,
          datasetAuthorizationSetHash: buildDatasetAuthorizationSet(spec.datasetMounts || []).datasetAuthorizationSetHash,
          environmentBindingHash: result.environmentBindingHash || null,
          environmentBom: result.environmentBom || null,
          environmentBomHash: result.environmentBomHash || null,
          cacheReproducibilityDecision: effectiveCacheDecision,
          blockers: [...(result.blockers || []), ...(imageIdentityMismatch ? ['worker_container_image_identity_mismatch'] : []), ...(runtimeIdentityMismatch ? ['worker_execution_runtime_identity_mismatch'] : []), ...(environmentBindingMismatch ? ['worker_environment_binding_mismatch'] : []), ...(environmentBomInvalid ? ['worker_environment_bom_invalid'] : []), ...(environmentBomMismatch ? ['worker_environment_bom_mismatch'] : []), ...(executionSourceMismatch ? ['worker_execution_source_cache_identity_mismatch'] : [])],
          exitCode: result.exitCode ?? null,
          stdoutTail: String(result.stdout || '').slice(-4000),
          stderrTail: String(result.stderr || '').slice(-4000),
          externalActionPerformed: false,
          cacheHit: false,
          executionCacheKey,
          sourceMerkleHash: result.workSourceMerkleHash || null,
          sourceWorkspaceManifestHash: result.workWorkspaceManifestHash || null,
          cacheBypassReason: cache && !executionIdentity.cacheable ? 'runtime_identity_not_cacheable'
            : cache && !(spec.datasetMounts || []).every((mount) => mount.manifestHash) ? 'dataset_identity_not_cacheable'
              : cache ? effectiveCacheDecision.cacheBypassReason : null,
        };
        if (executionSucceeded && executionCacheKey && spec.outputDirectory && (result.artifacts || []).length) cache.put(executionCacheKey, { artifacts: result.artifacts, outputDirectory: spec.outputDirectory, runnerReceiptHash: result.receiptHash || null, environmentBom: result.environmentBom, cacheReproducibilityDecision: effectiveCacheDecision, baseCacheDescriptor });
        return Object.freeze({ ...payload, multiLanguageEmpiricalReceiptHash: hashRecord('MultiLanguageEmpiricalReceipt', payload) });
      };
      return typeof pending?.then === 'function' ? pending.then(finish) : finish(pending);
    },
  });
}
