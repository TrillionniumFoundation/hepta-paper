import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { buildDatasetAuthorizationSet, verifySystemBenchmarkHarnessExecutionReceipt } from '../../paper-domain/automation/experiment-run-contract.mjs';
import { systemBenchmarkArmBatchChallengeEnvironment } from '../../paper-domain/automation/system-benchmark-challenge.mjs';
import { resolveSystemBenchmarkArmAdapterSet } from './system-benchmark-arm-adapter-repository.mjs';
import { executeSystemBenchmarkHarness } from './system-benchmark-harness.mjs';

export function executeSystemBenchmarkEmpiricalRun({
  spec,
  benchmarkSelector,
  effectiveEnv,
  command,
  runtimeImage,
  executionIdentity,
  benchmarkSourceDescriptor,
  workerRunner,
  prepareRuntimeIdentity,
  runRawEventRecomputation = null,
  operatorDatasetAuthorityTrustStore = null,
  runtimeRoot = null,
} = {}) {
  const resolvedAdapters = resolveSystemBenchmarkArmAdapterSet({
    sourceRoot: spec.sourceRoot || spec.cwd,
    entrypoint: spec.entrypoint,
    protocolSet: benchmarkSelector.experimentDesign.benchmarkHarness.armProtocolSet,
  });
  if (resolvedAdapters.status !== 'system_benchmark_arm_adapters_verified') {
    return Object.freeze({
      version: 2,
      kind: 'MultiLanguageEmpiricalReceipt',
      language: spec.language,
      status: 'empirical_execution_failed',
      executionStatus: 'empirical_execution_failed',
      integrityStatus: 'empirical_integrity_blocked',
      scientificVerdict: 'not_evaluable',
      failureClass: 'technical_failure',
      repairEligible: true,
      blockers: resolvedAdapters.blockers,
      harnessExecutionReceipt: null,
      externalActionPerformed: false,
    });
  }
  let firstExecutionIdentity = executionIdentity;
  const experimentAttemptId = String(effectiveEnv.HEPTA_EXPERIMENT_ATTEMPT_ID || '');
  const pendingHarness = executeSystemBenchmarkHarness({
    benchmarkSelector,
    datasetMounts: spec.datasetMounts || [],
    experimentAttemptId,
    attemptVersion: Number(spec.empiricalAttemptVersion || 1),
    failedAttemptLineageHashes: spec.failedAttemptLineageHashes || [],
    sourceLineageHash: spec.sourceLineageHash || null,
    sourceMerkleHash: benchmarkSourceDescriptor.sourceMerkleHash,
    sourceWorkspaceManifestHash: benchmarkSourceDescriptor.sourceWorkspaceManifestHash,
    outputDirectory: spec.outputDirectory,
    armAdapterSet: resolvedAdapters.adapterSet,
    operatorDatasetAuthorityTrustStore,
    runtimeRoot,
    ...(typeof runRawEventRecomputation === 'function'
      ? { runRawEventRecomputation } : {}),
    absoluteDeadlineEpochMs: spec.absoluteDeadlineEpochMs,
    aggregateCpuSeconds: spec.cpuSeconds,
    memoryBytes: spec.memoryBytes,
    maximumProcesses: spec.maximumProcesses,
    requiresGpu: Boolean(spec.requiresGpu),
    maximumWallTimeMs: spec.timeoutMs,
    cpuCount: Number(spec.cpuCount || 1),
    executionEnvironment: executionIdentity.runtimeType === 'container'
      ? 'signed-docker-runtime-v1' : 'signed-bubblewrap-runtime-v1',
    researchContext: spec.experimentResearchContext || null,
    localOnly: spec.localOnly === true,
    runArmBatch({ batch, outputDirectory }) {
      const batchIdentity = firstExecutionIdentity || prepareRuntimeIdentity(command, runtimeImage);
      firstExecutionIdentity = null;
      if (!batchIdentity?.available || !batchIdentity.allowlisted
        || batchIdentity.runtimeIdentityHash !== executionIdentity.runtimeIdentityHash) {
        return Object.freeze({ ok: false, status: 'os_sandbox_worker_blocked', blockers: ['benchmark_arm_batch_runtime_identity_unavailable'] });
      }
      const batchEnv = {
        ...effectiveEnv,
        HEPTA_EXPERIMENT_RUN_ID: experimentAttemptId,
        HEPTA_EXPERIMENT_ATTEMPT_ID: batch.executionAttemptId,
        HEPTA_EXPERIMENT_ARM: batch.arm,
        HEPTA_EXPERIMENT_ARM_PROTOCOL_ID: batch.armProtocol.protocolId,
        HEPTA_EXPERIMENT_ARM_PROTOCOL_HASH: batch.systemBenchmarkArmProtocolHash,
        HEPTA_EXPERIMENT_ARM_PROTOCOL_SET_HASH: benchmarkSelector.experimentDesign.benchmarkHarness.systemBenchmarkArmProtocolSetHash,
        HEPTA_EXPERIMENT_ARM_ADAPTER_PATH: batch.armAdapter.relativePath,
        HEPTA_EXPERIMENT_ARM_ADAPTER_HASH: batch.armAdapter.sourceHash,
        HEPTA_EXPERIMENT_ARM_ADAPTER_SET_HASH: resolvedAdapters.adapterSet.systemBenchmarkArmAdapterSetHash,
        HEPTA_PRE_DATA_ACCESS_FREEZE_HASH: batch.empiricalPreDataAccessFreezeHash,
        HEPTA_EXPERIMENT_IR_HASH: batch.versionedExperimentIrHash,
        ...(batch.experimentResearchBindingHash ? {
          HEPTA_EXPERIMENT_RESEARCH_BINDING_HASH:
            batch.experimentResearchBindingHash,
          HEPTA_DATASET_RESEARCH_COMPATIBILITY_HASH:
            batch.datasetResearchCompatibilityHash,
        } : {}),
        ...systemBenchmarkArmBatchChallengeEnvironment(batch.challenge),
      };
      delete batchEnv.HEPTA_SEED;
      delete batchEnv.PYTHONHASHSEED;
      if (batch.cells.length === 1) Object.assign(batchEnv, {
        HEPTA_SEED: String(batch.cells[0].seed),
        PYTHONHASHSEED: String(batch.cells[0].seed),
        HEPTA_EXPERIMENT_SEED: String(batch.cells[0].seed),
        HEPTA_EXPERIMENT_REPETITION: String(batch.cells[0].repetition),
        HEPTA_HARNESS_CELL_ID: batch.cells[0].cellId,
      });
      const operation = () => workerRunner.run({
        executable: command.executable,
        args: command.args({ ...spec, entrypoint: batch.armAdapter.relativePath }),
        cwd: spec.cwd,
        sourceRoot: spec.sourceRoot || spec.cwd,
        timeoutMs: batch.resourceBudget.timeoutMs,
        outputPaths: ['observation.json'],
        outputDirectory,
        requiresGpu: Boolean(spec.requiresGpu),
        env: batchEnv,
        executionIdentity: batchIdentity.capability,
        containerImage: runtimeImage?.image || null,
        containerExecutable: runtimeImage?.executable || null,
        datasetMounts: spec.datasetMounts || [],
        requireDatasetAccessProof: Boolean((spec.datasetMounts || []).length),
        memoryBytes: batch.resourceBudget.memoryBytes,
        cpuSeconds: batch.resourceBudget.cpuSeconds,
        maximumProcesses: batch.resourceBudget.maximumProcesses,
        expectedSourceMerkleHash: benchmarkSourceDescriptor.sourceMerkleHash,
        expectedSourceWorkspaceManifestHash: benchmarkSourceDescriptor.sourceWorkspaceManifestHash,
        signal: spec.signal || null,
      });
      return typeof spec.runEmpiricalCell === 'function'
        ? spec.runEmpiricalCell(operation, { requiresGpu: Boolean(spec.requiresGpu) })
        : operation();
    },
  });
  const finishHarness = (harnessReceipt) => {
    const succeeded = verifySystemBenchmarkHarnessExecutionReceipt(harnessReceipt);
    const payload = {
      version: 2,
      kind: 'MultiLanguageEmpiricalReceipt',
      language: spec.language,
      status: succeeded ? 'empirical_execution_completed' : 'empirical_execution_failed',
      executionStatus: harnessReceipt.executionStatus || (succeeded
        ? 'system_benchmark_execution_completed' : 'system_benchmark_execution_failed'),
      integrityStatus: harnessReceipt.integrityStatus || (succeeded
        ? 'system_benchmark_integrity_verified' : 'system_benchmark_integrity_blocked'),
      scientificVerdict: harnessReceipt.scientificVerdict || 'not_evaluable',
      scientificFindings: harnessReceipt.scientificFindings || [],
      failureClass: succeeded ? null : 'technical_failure',
      repairEligible: !succeeded,
      empiricalAttemptVersion: Number(spec.empiricalAttemptVersion || 1),
      failedAttemptLineageHashes: spec.failedAttemptLineageHashes || [],
      preDataAccessFreeze: harnessReceipt.preDataAccessFreeze || null,
      empiricalPreDataAccessFreezeHash: harnessReceipt.empiricalPreDataAccessFreezeHash || null,
      experimentIr: harnessReceipt.experimentIr || null,
      versionedExperimentIrHash: harnessReceipt.versionedExperimentIrHash || null,
      runnerReceiptHash: harnessReceipt.systemBenchmarkHarnessExecutionReceiptHash || null,
      runnerReceipt: null,
      harnessExecutionReceipt: harnessReceipt,
      artifacts: harnessReceipt.artifacts || [],
      isolation: { systemOwnedBenchmarkHarnessVerified: succeeded },
      runtimeIdentityType: executionIdentity.runtimeType,
      runtimeIdentityHash: harnessReceipt.runtimeIdentityHash || executionIdentity.runtimeIdentityHash,
      runtimeIdentityCacheable: false,
      containerImage: executionIdentity.runtimeType === 'container' ? executionIdentity.requestedImage : null,
      containerImageDigest: executionIdentity.runtimeType === 'container' ? executionIdentity.digest : null,
      datasetMounts: spec.datasetMounts || [],
      benchmarkSelector,
      campaignBenchmarkSelectorHash: benchmarkSelector.campaignBenchmarkSelectorHash,
      experimentDesignHash: benchmarkSelector.experimentDesignHash,
      benchmarkHarnessHash: benchmarkSelector.experimentDesign.benchmarkHarnessHash,
      datasetAuthorizationSetHash: buildDatasetAuthorizationSet(spec.datasetMounts || []).datasetAuthorizationSetHash,
      environmentBindingHash: harnessReceipt.environmentBindingHash || null,
      blockers: harnessReceipt.blockers || [],
      exitCode: succeeded ? 0 : null,
      stdoutTail: '',
      stderrTail: '',
      cacheHit: false,
      executionCacheKey: null,
      sourceMerkleHash: harnessReceipt.sourceMerkleHash || null,
      sourceWorkspaceManifestHash: harnessReceipt.sourceWorkspaceManifestHash || null,
      sourceLineageHash: harnessReceipt.sourceLineageHash || null,
      cacheBypassReason: 'system_owned_benchmark_harness',
      externalActionPerformed: false,
    };
    return Object.freeze({ ...payload, multiLanguageEmpiricalReceiptHash: hashRecord('MultiLanguageEmpiricalReceipt', payload) });
  };
  return typeof pendingHarness?.then === 'function' ? pendingHarness.then(finishHarness) : finishHarness(pendingHarness);
}
