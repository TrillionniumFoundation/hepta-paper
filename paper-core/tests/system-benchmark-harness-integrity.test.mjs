import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  importAnalysisProtocolRunBindingForTest,
  importExperimentRunContractForTest,
  importMultiLanguageEmpiricalExecutorForTest,
  importSystemBenchmarkHarnessForTest,
  withRawEventRecomputationSandboxFixtureForTest,
  withRawEventRecomputationSandboxRunnerForTest,
  withSystemBenchmarkWallClockForTest,
} from './support/raw-event-recomputation-sandbox-test-seam.mjs';
import { signAuthorityDocument } from '../../paper-adapters/authority/authority-signatures.mjs';
import { authorizeOperatorDatasetMount } from '../../paper-adapters/automation/operator-dataset-harness-reader.mjs';
import { resolveSystemBenchmarkArmAdapterSet } from '../../paper-adapters/automation/system-benchmark-arm-adapter-repository.mjs';
import { inspectStrictDatasetManifest } from '../../paper-adapters/runtime/execution-snapshot.mjs';
import {
  createOsSandboxedWorkerRunnerForTest as createOsSandboxedWorkerRunner,
} from './support/os-sandboxed-worker-runner-test-driver.mjs';
import { selectAndValidateWorkerEnvironment } from '../../paper-adapters/runtime/worker-environment-policy.mjs';
import { buildCampaignBenchmarkSelector, verifyCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import {
  buildCampaignBenchmarkSchedule,
  buildDatasetAuthorizationSet,
  verifyOsSandboxWorkerReceipt,
  verifySystemBenchmarkHarnessExecutionReceipt as
    verifyProductionSystemBenchmarkHarnessExecutionReceipt,
} from '../../paper-domain/automation/experiment-run-contract.mjs';
import {
  buildSystemBenchmarkArmBatchChallenge,
  decodeSystemBenchmarkArmBatchChallengeEnvironment,
  SYSTEM_BENCHMARK_ARM_BATCH_CHALLENGE_MAXIMUM_PARTS,
  systemBenchmarkArmBatchChallengeEnvironment,
} from '../../paper-domain/automation/system-benchmark-challenge.mjs';
import {
  SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION,
  SYSTEM_BENCHMARK_HARNESS_ROOTS,
  SYSTEM_BENCHMARK_HARNESS_TARGETS,
} from '../../paper-domain/automation/system-benchmark-harness-identity.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { buildEmpiricalEnvironmentBom } from '../../paper-domain/automation/environment-bom-contract.mjs';
import {
  SYSTEM_BENCHMARK_CPU_BUDGET_SEMANTICS,
  verifySystemBenchmarkHarnessResourceBudget,
} from '../../paper-domain/automation/system-benchmark-resource-budget-contract.mjs';
import { buildCanonicalAnalysisProtocol } from '../../paper-domain/automation/analysis-protocol-contract.mjs';
import {
  validateOperatorDatasetHarnessDefinition,
  validateOperatorDatasetSplitManifest,
} from '../../paper-domain/automation/operator-dataset-harness-contract.mjs';
import {
  createRawEventRecomputationSandboxTestFixture,
} from './support/raw-event-recomputation-sandbox-fixture.mjs';

const {
  executeSystemBenchmarkHarness,
  verifySystemBenchmarkHarnessExecutionReceipt,
} =
  await importSystemBenchmarkHarnessForTest();
const {
  verifyProcessIsolatedSystemBenchmarkRecomputationEvidence,
} = await importAnalysisProtocolRunBindingForTest();
const { createMultiLanguageEmpiricalExecutor } =
  await importMultiLanguageEmpiricalExecutorForTest();
const {
  buildExperimentRunReceipt: buildFixtureExperimentRunReceipt,
  verifyExperimentRunReceipt: verifyFixtureExperimentRunReceipt,
} = await importExperimentRunContractForTest();
const REPOSITORY_ROOT = process.cwd();
const IDENTITY_EXCLUSIONS = new Set([
  'paper-domain/automation/system-benchmark-harness-identity.mjs',
  'workflow-kernel/system-benchmark-harness-implementation-manifest.mjs',
]);
const REQUIRED_ROOTS = Object.freeze([
  'paper-domain/automation/campaign-benchmark-selector.mjs',
  'paper-domain/automation/experiment-run-contract.mjs',
  'paper-domain/automation/empirical-contract.mjs',
  'paper-adapters/automation/system-benchmark-harness.mjs',
  'paper-adapters/automation/system-benchmark-result-repository.mjs',
  'paper-adapters/automation/multi-language-empirical-executor.mjs',
  'paper-adapters/automation/empirical-contract-reader.mjs',
  'paper-adapters/runtime/os-sandboxed-worker-runner.mjs',
  'paper-adapters/runtime/dataset-runtime-access-receipt.mjs',
  'paper-adapters/research-verify/raw-event-artifact-recomputation-verifier.mjs',
  'paper-adapters/research-verify/system-benchmark-primitive-fixture-resolver.mjs',
  'paper-adapters/research-verify/independent-system-benchmark-recomputation-worker.mjs',
  'paper-adapters/research-verify/independent-typed-numeric-oracle-recomputation-worker.mjs',
  'paper-adapters/automation/operator-dataset-harness-reader.mjs',
  'paper-adapters/artifacts/artifact-write-receipt-verifier.mjs',
  'paper-domain/research/experiment-registry-authority.mjs',
]);

function localImports(relativePath) {
  const absolute = path.join(REPOSITORY_ROOT, relativePath);
  const source = fs.readFileSync(absolute, 'utf8');
  const specifiers = [];
  const pattern = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    if (!match[1].startsWith('.')) continue;
    const resolved = path.resolve(path.dirname(absolute), match[1]);
    const candidate = path.extname(resolved) ? resolved : `${resolved}.mjs`;
    assert.equal(fs.existsSync(candidate), true, `missing local import ${match[1]} from ${relativePath}`);
    specifiers.push(path.relative(REPOSITORY_ROOT, candidate).split(path.sep).join('/'));
  }
  return specifiers;
}

function implementationClosure() {
  const pending = [...REQUIRED_ROOTS];
  const visited = new Set();
  while (pending.length) {
    const relative = pending.pop();
    if (visited.has(relative) || IDENTITY_EXCLUSIONS.has(relative)) continue;
    visited.add(relative);
    for (const imported of localImports(relative)) {
      if (!IDENTITY_EXCLUSIONS.has(imported)) pending.push(imported);
    }
  }
  return [...visited].sort();
}

function workerReceipt({ batch, content, datasetMounts = [], processOrdinal = null }) {
  const artifacts = [{ path: 'observation.json', sha256: hashBytes(content), bytes: content.length }];
  const receiptDatasetMounts = datasetMounts.map((mount) => ({ ...mount, target: `/datasets/${mount.name}` }));
  const authorizationSet = buildDatasetAuthorizationSet(receiptDatasetMounts);
  const bindings = {
    HEPTA_BENCHMARK_ID: batch.benchmarkId,
    HEPTA_BENCHMARK_SELECTOR_HASH: batch.selectorHash,
    HEPTA_EXPERIMENT_DESIGN_HASH: batch.designHash,
    HEPTA_BENCHMARK_HARNESS_HASH: batch.harnessHash,
    HEPTA_EXPERIMENT_RUN_ID: batch.experimentAttemptId,
    HEPTA_EXPERIMENT_ATTEMPT_ID: batch.executionAttemptId,
    HEPTA_EXPERIMENT_ARM: batch.arm,
    HEPTA_EXPERIMENT_ARM_PROTOCOL_ID: batch.armProtocol.protocolId,
    HEPTA_EXPERIMENT_ARM_PROTOCOL_HASH: batch.systemBenchmarkArmProtocolHash,
    HEPTA_EXPERIMENT_ARM_PROTOCOL_SET_HASH: batch.armProtocolSetHash,
    HEPTA_EXPERIMENT_ARM_ADAPTER_PATH: batch.armAdapter.relativePath,
    HEPTA_EXPERIMENT_ARM_ADAPTER_HASH: batch.armAdapter.sourceHash,
    HEPTA_EXPERIMENT_ARM_ADAPTER_SET_HASH: batch.armAdapterSetHash,
    HEPTA_PRE_DATA_ACCESS_FREEZE_HASH: batch.empiricalPreDataAccessFreezeHash,
    HEPTA_EXPERIMENT_IR_HASH: batch.versionedExperimentIrHash,
    ...(batch.executionMode === 'academic-per-cell-process-v1' ? {
      HEPTA_EXPERIMENT_SEED: String(batch.cells[0].seed),
      HEPTA_EXPERIMENT_REPETITION: String(batch.cells[0].repetition),
      HEPTA_HARNESS_CELL_ID: batch.cells[0].cellId,
      HEPTA_SEED: String(batch.cells[0].seed),
      PYTHONHASHSEED: String(batch.cells[0].seed),
    } : {}),
    ...systemBenchmarkArmBatchChallengeEnvironment(batch.challenge),
    HEPTA_DATASET_AUTHORIZATION_SET_HASH: authorizationSet.datasetAuthorizationSetHash,
  };
  const limits = {
    timeoutMs: batch.resourceBudget.timeoutMs,
    memoryBytes: batch.resourceBudget.memoryBytes,
    cpuSeconds: batch.resourceBudget.cpuSeconds,
    maximumPids: batch.resourceBudget.maximumProcesses,
    maximumOutputBytes: 256 * 1024 * 1024,
    maximumCapturedBytes: 4 * 1024 * 1024,
  };
  const environmentBom = buildEmpiricalEnvironmentBom({
    platform: {
      operatingSystem: 'linux', architecture: 'x64', kernelReleaseHash: `sha256:${'4'.repeat(64)}`,
      cpu: { modelHash: `sha256:${'5'.repeat(64)}`, flagsHash: `sha256:${'6'.repeat(64)}`, logicalProcessorCount: 1, observation: 'fixture' },
    },
    runtime: {
      type: 'host', identityHash: `sha256:${'3'.repeat(64)}`, language: 'python',
      hostExecutableHash: `sha256:${'7'.repeat(64)}`,
      packageClosure: { basis: 'unobserved', identityHash: null, manifestHash: null, observedPackageCount: 0 },
    },
    gpu: { required: false, status: 'not_required', deviceCount: 0 },
    numericRuntime: { threads: {}, dynamicThreadingDisabled: false, explicitSingleThreadPolicy: false, policyObservation: 'fixture' },
    limits,
    determinism: { classification: 'unknown' },
    buildReproducibility: { status: 'not_assessed' },
    observedClaims: ['fixture-runtime-identity'],
    unobservedClaims: ['package-closure'],
  });
  const executionProcessIdentity = processOrdinal === null ? null : {
    version: 1,
    kind: 'OsSandboxWorkerProcessIdentity',
    processInvocationId: hashRecord('SystemBenchmarkFixtureProcessInvocation', {
      executionAttemptId: batch.executionAttemptId,
      processOrdinal,
    }),
    launcherPid: 10_000 + processOrdinal,
  };
  const datasetAccessPayload = receiptDatasetMounts.length ? {
    version: 2,
    kind: 'DatasetRuntimeAccessReceipt',
    status: 'dataset_runtime_access_verified',
    tracer: 'host-supervisor-strace-open-read-v2',
    traceAuthority: 'host-supervisor-outside-child-mount-namespace-v1',
    readObservationAssurance: 'positive-return-byte-observation-not-computational-use-proof-v1',
    traceSha256: hashRecord('SystemBenchmarkFixtureDatasetTrace', {
      executionAttemptId: batch.executionAttemptId,
    }),
    datasets: receiptDatasetMounts.map((mount) => ({
      name: mount.name,
      target: `/datasets/${mount.name}`,
      manifestHash: mount.manifestHash,
      operatorAuthorizationHash: mount.operatorAuthorizationHash || null,
      workerExposureManifestHash: mount.splitManifestHash || null,
      hostOnlyHarnessMounted: false,
      forbiddenReadObserved: false,
      readObserved: true,
      positiveReadObservationEventCount: 1,
      positiveReadBytesObserved: 1,
      positiveReadObservationHash: hashRecord('SystemBenchmarkFixturePositiveRead', {
        executionAttemptId: batch.executionAttemptId,
        datasetName: mount.name,
      }),
    })),
    blockers: [],
  } : null;
  const payload = {
    version: 4,
    kind: 'OsSandboxWorkerReceipt',
    evidenceClass: 'verification-fixture-v1',
    productionEvidenceEligible: false,
    runnerId: 'bubblewrap-kernel-isolation-worker-v4',
    backend: 'bubblewrap',
    status: 'os_sandbox_worker_passed',
    sourceMerkleHashBefore: `sha256:${'1'.repeat(64)}`,
    sourceMerkleHashAfter: `sha256:${'1'.repeat(64)}`,
    sourceWorkspaceManifestHashBefore: `sha256:${'2'.repeat(64)}`,
    sourceWorkspaceManifestHashAfter: `sha256:${'2'.repeat(64)}`,
    workSourceMerkleHash: `sha256:${'1'.repeat(64)}`,
    workWorkspaceManifestHash: `sha256:${'2'.repeat(64)}`,
    limits,
    runtimeIdentityType: 'host',
    runtimeIdentityHash: `sha256:${'3'.repeat(64)}`,
    ...(executionProcessIdentity ? {
      executionProcessIdentity,
      executionProcessIdentityHash: hashRecord('OsSandboxWorkerProcessIdentity', executionProcessIdentity),
    } : {}),
    environmentBom,
    environmentBomHash: environmentBom.environmentBomHash,
    environmentBindingHash: hashRecord('WorkerEnvironmentBinding', bindings),
    executionBindings: bindings,
    datasetAuthorizationSetHash: authorizationSet.datasetAuthorizationSetHash,
    datasetMounts: receiptDatasetMounts,
    datasetAccessReceipt: datasetAccessPayload ? {
      ...datasetAccessPayload,
      datasetRuntimeAccessReceiptHash: hashRecord('DatasetRuntimeAccessReceipt', datasetAccessPayload),
    } : null,
    artifacts,
    artifactManifestHash: hashRecord('OsSandboxWorkerArtifactManifest', artifacts),
    isolation: { kernelNetworkIsolationVerified: true, sourceReadOnlyVerified: true, ephemeralWorkRootVerified: true, separateOutputRootVerified: true, gpuAccessRequested: false, memoryLimitVerified: true, memoryLimitScope: 'process-address-space-not-descendant-tree-v1', cpuLimitVerified: true, cpuLimitScope: 'process-thread-group-not-descendant-tree-v1', processLimitVerified: true, processLimitMechanism: 'rlimit-nproc', processLimitScope: 'real-uid-concurrent-processes-not-sandbox-local-v1', resourceLimitsVerified: true },
    externalActionPerformed: false,
  };
  return { ok: true, ...payload, receiptHash: hashRecord('OsSandboxWorkerReceipt', payload), blockers: [] };
}

function responseDocument(batch, { ignoreArm = false, dropLastCell = false } = {}) {
  const cells = batch.challenge.cells.map(({ cellId, challenge }) => ({
    cellId,
    systemBenchmarkCellChallengeHash: challenge.systemBenchmarkCellChallengeHash,
    responses: challenge.cases.map((item) => {
      let prediction = 0;
      if (!ignoreArm && batch.arm === 'treatment') prediction = item.input.primary + (0.35 * item.input.secondary) >= 0 ? 1 : 0;
      else if (!ignoreArm && batch.arm === 'ablation') prediction = item.input.secondary >= 0 ? 1 : 0;
      else if (batch.arm === 'baseline') prediction = item.referenceResponse;
      return { caseId: item.caseId, prediction };
    }),
  }));
  if (dropLastCell) cells.pop();
  return Buffer.from(`${JSON.stringify({
    version: 1,
    kind: 'CampaignBenchmarkArmBatchResponses',
    systemBenchmarkArmBatchChallengeHash: batch.challenge.systemBenchmarkArmBatchChallengeHash,
    cells,
  })}\n`);
}

function adapterSet(protocolSet, { identical = false } = {}) {
  const adapters = protocolSet.protocols.map((protocol, index) => ({
    version: 1,
    kind: 'SystemBenchmarkArmAdapterIdentity',
    arm: protocol.arm,
    relativePath: `run.${protocol.arm}.py`,
    sourceHash: `sha256:${(identical ? 'a' : String(index + 1)).repeat(64)}`,
    systemBenchmarkArmProtocolHash: protocol.systemBenchmarkArmProtocolHash,
    sourceReadReceiptHash: `sha256:${String(index + 4).repeat(64)}`,
  }));
  const payload = { version: 1, kind: 'SystemBenchmarkArmAdapterSet', entrypointConvention: 'sibling-arm-entrypoints-v1', adapters };
  return { ...payload, systemBenchmarkArmAdapterSetHash: hashRecord('SystemBenchmarkArmAdapterSet', payload) };
}

function academicHarnessFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-system-benchmark-academic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const datasetRoot = path.join(root, 'dataset');
  const runtimeRoot = path.join(root, 'runtime');
  const outputDirectory = path.join(root, 'output');
  fs.mkdirSync(datasetRoot);
  fs.mkdirSync(runtimeRoot);
  fs.mkdirSync(outputDirectory);
  fs.writeFileSync(path.join(datasetRoot, 'train.csv'), 'feature,label\n1,1\n');
  const inspection = inspectStrictDatasetManifest(datasetRoot, datasetRoot);
  assert.deepEqual(inspection.blockers, []);

  const benchmarkId = 'academic-system-harness-coverage';
  const seedSchedule = [17, 23, 31, 43];
  const minimumRepetitions = 8;
  const cells = seedSchedule.flatMap((seed) => Array.from(
    { length: minimumRepetitions },
    (_, repetitionIndex) => ({
      seed,
      repetition: repetitionIndex + 1,
      cases: Array.from({ length: 8 }, (_, caseIndex) => {
        const primary = caseIndex < 4 ? -1 : 1;
        const secondary = repetitionIndex % 2 ? -0.2 : 0.2;
        const label = primary + (0.35 * secondary) >= 0 ? 1 : 0;
        return {
          caseId: hashRecord('AcademicSystemHarnessCoverageCase', {
            seed,
            repetition: repetitionIndex + 1,
            caseIndex,
          }),
          input: { primary, secondary },
          ablationInput: { secondary },
          referenceResponse: 0,
          oracle: { label, robustLabel: label },
        };
      }),
    }),
  ));
  const definition = {
    version: 1,
    kind: 'OperatorAuthorizedDatasetBenchmarkHarness',
    benchmarkId,
    benchmarkFamily: 'ml_algorithm_benchmark',
    seedSchedule,
    minimumRepetitions,
    cells,
  };
  const definitionHash = validateOperatorDatasetHarnessDefinition(definition, { benchmarkId })
    .operatorDatasetHarnessDefinitionHash;
  const splitManifest = {
    version: 1,
    kind: 'OperatorDatasetSplitManifest',
    datasetName: benchmarkId,
    datasetManifestHash: inspection.hash,
    entries: inspection.entries.filter((entry) => entry.type === 'file').map((entry) => ({
      path: entry.relative,
      sha256: entry.hash,
      split: 'train',
    })),
  };
  const splitManifestHash = validateOperatorDatasetSplitManifest(splitManifest, {
    datasetName: benchmarkId,
    datasetManifestHash: inspection.hash,
  }).operatorDatasetSplitManifestHash;
  const familyDesign = buildCampaignBenchmarkSelector({
    benchmarkId: definition.benchmarkFamily,
    datasetMounts: [],
  }).experimentDesign;
  const builtAnalysisProtocol = buildCanonicalAnalysisProtocol({
    benchmarkId,
    benchmarkFamily: definition.benchmarkFamily,
    requiredMetrics: familyDesign.requiredMetrics,
    metricSpecs: familyDesign.metricSpecs,
  });
  const { analysisProtocolHash, ...analysisProtocol } = builtAnalysisProtocol;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const now = new Date();
  const authority = signAuthorityDocument({
    version: 2,
    kind: 'OperatorDatasetHarnessAuthority',
    datasetName: benchmarkId,
    datasetManifestHash: inspection.hash,
    datasetLicenseId: 'CC-BY-4.0',
    datasetSplitManifestHash: splitManifestHash,
    benchmarkHarnessDefinitionHash: definitionHash,
    benchmarkFamily: definition.benchmarkFamily,
    seedSchedule,
    minimumRepetitions,
    analysisProtocolHash,
    workerExposurePolicy: 'signed-complete-dataset-file-manifest-v1',
    signedAt: new Date(now.getTime() - 60_000).toISOString(),
    expiresAt: new Date(now.getTime() + (24 * 60 * 60 * 1000)).toISOString(),
  }, {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    keyId: 'academic-system-harness-key',
    role: 'dataset_harness_operator',
  });
  const trustStore = {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [{
      keyId: 'academic-system-harness-key',
      subjectId: 'academic-system-harness-operator',
      algorithm: 'ed25519',
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      roles: ['dataset_harness_operator'],
      status: 'active',
    }],
  };
  const envelopePath = path.join(root, 'host-only-envelope.json');
  fs.writeFileSync(envelopePath, `${JSON.stringify({
    version: 2,
    kind: 'OperatorDatasetHarnessEnvelope',
    authority,
    splitManifest,
    harnessDefinition: definition,
    analysisProtocol,
  })}\n`, { mode: 0o600 });
  const mount = authorizeOperatorDatasetMount({
    name: benchmarkId,
    source: datasetRoot,
    readOnly: true,
    manifestHash: inspection.hash,
    licenseId: 'CC-BY-4.0',
  }, {
    envelopePath,
    authorityTrustStore: trustStore,
    runtimeRoot,
    persistPrivateEnvelope: true,
    now,
  });
  const selector = buildCampaignBenchmarkSelector({ benchmarkId, datasetMounts: [mount] });
  return { benchmarkId, mount, outputDirectory, runtimeRoot, selector, trustStore };
}

function runFixtureHarness(t, { ignoreArm = false, dropLastCell = false, tamperProtocol = false, malformedRunnerReceipt = null, identicalAdapters = false, runId = 'fixture-experiment-attempt', attemptVersion = 1, failedAttemptLineageHashes = [], absoluteDeadlineEpochMs, aggregateCpuSeconds, memoryBytes, maximumProcesses, nowEpochMs, legacyNowEpochMs, legacyRunRawEventRecomputation, rawEventRecomputationSandboxWorkerRunner = createRawEventRecomputationSandboxTestFixture() } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-system-benchmark-integrity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const selector = buildCampaignBenchmarkSelector({ benchmarkId: 'ml_algorithm_benchmark', datasetMounts: [] });
  const adapters = adapterSet(selector.experimentDesign.benchmarkHarness.armProtocolSet, { identical: identicalAdapters });
  let invocationCount = 0;
  const resourceBudgets = [];
  const receipt = withSystemBenchmarkWallClockForTest(
    nowEpochMs || (() => 0),
    () => withRawEventRecomputationSandboxRunnerForTest(
      rawEventRecomputationSandboxWorkerRunner,
      () => executeSystemBenchmarkHarness({
    benchmarkSelector: selector,
    datasetMounts: [],
    experimentAttemptId: runId,
    attemptVersion,
    failedAttemptLineageHashes,
    sourceLineageHash: `sha256:${'c'.repeat(64)}`,
    sourceMerkleHash: `sha256:${'1'.repeat(64)}`,
    sourceWorkspaceManifestHash: `sha256:${'2'.repeat(64)}`,
    outputDirectory: root,
    armAdapterSet: adapters,
    ...(legacyRunRawEventRecomputation === undefined
      ? {} : { runRawEventRecomputation: legacyRunRawEventRecomputation }),
    ...(legacyNowEpochMs === undefined ? {} : { nowEpochMs: legacyNowEpochMs }),
    ...(absoluteDeadlineEpochMs === undefined ? {} : { absoluteDeadlineEpochMs }),
    ...(aggregateCpuSeconds === undefined ? {} : { aggregateCpuSeconds }),
    ...(memoryBytes === undefined ? {} : { memoryBytes }),
    ...(maximumProcesses === undefined ? {} : { maximumProcesses }),
    runArmBatch({ batch, outputDirectory }) {
      invocationCount += 1;
      resourceBudgets.push(batch.resourceBudget);
      const effectiveBatch = {
        ...batch,
        benchmarkId: selector.benchmarkId,
        selectorHash: selector.campaignBenchmarkSelectorHash,
        designHash: selector.experimentDesignHash,
        harnessHash: selector.experimentDesign.benchmarkHarnessHash,
        resourceBudget: batch.resourceBudget,
      };
      if (tamperProtocol && batch.arm === 'baseline') effectiveBatch.systemBenchmarkArmProtocolHash = `sha256:${'f'.repeat(64)}`;
      const content = responseDocument(batch, { ignoreArm, dropLastCell: dropLastCell && batch.arm === 'treatment' });
      const worker = workerReceipt({ batch: effectiveBatch, content });
      fs.mkdirSync(outputDirectory, { recursive: true });
      fs.writeFileSync(path.join(outputDirectory, 'observation.json'), content);
      return malformedRunnerReceipt && batch.arm === 'treatment'
        ? malformedRunnerReceipt : worker;
    },
      }),
    ),
  );
  return { receipt, invocationCount, resourceBudgets, outputDirectory: root };
}

function rehashIndependentProcessEvidence(independent) {
  const assurance = independent.processIsolatedRawEventRecomputationAssurance;
  const worker = assurance.workerReceipt;
  const {
    processIsolatedRawEventRecomputationWorkerReceiptHash: ignoredWorkerHash,
    ...workerPayload
  } = worker;
  void ignoredWorkerHash;
  worker.processIsolatedRawEventRecomputationWorkerReceiptHash = hashRecord(
    'ProcessIsolatedRawEventRecomputationWorkerReceipt', workerPayload,
  );
  assurance.workerReceiptHash = worker
    .processIsolatedRawEventRecomputationWorkerReceiptHash;
  const sandbox = assurance.osSandboxWorkerReceipt;
  sandbox.stdout = JSON.stringify(worker);
  const {
    ok: ignoredSandboxOk,
    receiptHash: ignoredSandboxHash,
    blockers: ignoredSandboxBlockers,
    ...sandboxPayload
  } = sandbox;
  void ignoredSandboxOk;
  void ignoredSandboxHash;
  void ignoredSandboxBlockers;
  sandbox.receiptHash = hashRecord('OsSandboxWorkerReceipt', sandboxPayload);
  assurance.osSandboxWorkerReceiptHash = sandbox.receiptHash;
  const {
    processIsolatedRawEventRecomputationAssuranceHash: ignoredAssuranceHash,
    ...assurancePayload
  } = assurance;
  void ignoredAssuranceHash;
  assurance.processIsolatedRawEventRecomputationAssuranceHash = hashRecord(
    'ProcessIsolatedRawEventRecomputationAssurance', assurancePayload,
  );
  independent.independenceContractHash = assurance
    .processIsolatedRawEventRecomputationAssuranceHash;
  independent.processIsolatedWorkerReceiptHash = assurance.workerReceiptHash;
  const {
    independentRawEventRecomputationAssuranceHash: ignoredIndependentHash,
    ...independentPayload
  } = independent;
  void ignoredIndependentHash;
  independent.independentRawEventRecomputationAssuranceHash = hashRecord(
    'IndependentRawEventRecomputationAssurance', independentPayload,
  );
  return independent;
}

test('R arm adapters reject top-level caller-frame path discovery before execution', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-r-arm-adapter-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'experiments'));
  fs.writeFileSync(path.join(root, 'experiments', 'run.treatment.R'), 'source(file.path(dirname(normalizePath(sys.frame(1)$ofile)), "run.R"))\n');
  fs.writeFileSync(path.join(root, 'experiments', 'run.baseline.R'), 'source("experiments/run.R")\n# baseline\n');
  fs.writeFileSync(path.join(root, 'experiments', 'run.ablation.R'), 'source("experiments/run.R")\n# ablation\n');
  const selector = buildCampaignBenchmarkSelector({ benchmarkId: 'ml_algorithm_benchmark', datasetMounts: [] });
  const result = resolveSystemBenchmarkArmAdapterSet({
    sourceRoot: root,
    entrypoint: 'experiments/run.R',
    protocolSet: selector.experimentDesign.benchmarkHarness.armProtocolSet,
  });
  assert.equal(result.status, 'system_benchmark_arm_adapters_blocked');
  assert.ok(result.blockers.includes(
    'benchmark_arm_adapter_source_invalid:treatment:r_top_level_caller_frame_path_discovery_forbidden',
  ));
});

test('benchmark harness fails before dispatch when its absolute deadline or aggregate CPU budget cannot cover every execution unit', (t) => {
  let legacyClockReads = 0;
  const expired = runFixtureHarness(t, {
    absoluteDeadlineEpochMs: 1000,
    nowEpochMs: () => 1000,
    legacyNowEpochMs() { legacyClockReads += 1; return 0; },
  });
  assert.equal(expired.invocationCount, 0);
  assert.equal(legacyClockReads, 0);
  assert.ok(expired.receipt.blockers.includes('benchmark_harness_absolute_deadline_exhausted'));
  const cpuExhausted = runFixtureHarness(t, { aggregateCpuSeconds: 2 });
  assert.equal(cpuExhausted.invocationCount, 0);
  assert.ok(cpuExhausted.receipt.blockers.includes('benchmark_harness_aggregate_cpu_budget_exhausted'));
});

test('benchmark harness fails closed on hostile or malformed arm receipts', (t) => {
  for (const malformedRunnerReceipt of [
    { blockers: 'not-an-array', artifacts: 'not-an-array' },
    new Proxy({}, { get() { throw new Error('hostile_arm_receipt'); } }),
  ]) {
    const execution = runFixtureHarness(t, { malformedRunnerReceipt });
    assert.equal(execution.receipt.status, 'system_benchmark_harness_blocked');
    assert.ok(execution.receipt.blockers.some(
      (blocker) => blocker.startsWith('benchmark_arm_batch_runner_receipt_invalid:')
        || blocker.startsWith('benchmark_arm_batch_execution_threw:'),
    ));
  }
});

test('benchmark harness keeps per-unit wall-time limits reproducible while enforcing its absolute deadline', (t) => {
  const observedTimes = [0, 10, 20];
  let timeReadCount = 0;
  const execution = runFixtureHarness(t, {
    absoluteDeadlineEpochMs: 300_000,
    nowEpochMs: () => observedTimes[Math.min(timeReadCount++, observedTimes.length - 1)],
  });
  assert.equal(
    execution.receipt.status,
    'system_benchmark_harness_verified',
    JSON.stringify(execution.receipt.blockers),
  );
  assert.deepEqual(
    execution.resourceBudgets.map((budget) => budget.timeoutMs),
    [100_000, 100_000, 100_000],
  );
  assert.ok(execution.resourceBudgets.every(
    (budget) => budget.absoluteDeadlineEpochMs === 300_000,
  ));
});

test('benchmark harness caps raw-event recomputation wall time and preserves cleanup reserve', (t) => {
  const capturedTimeouts = [];
  const fixture = createRawEventRecomputationSandboxTestFixture();
  const rawEventRecomputationSandboxWorkerRunner = Object.freeze({
    run(spec) {
      capturedTimeouts.push(spec.timeoutMs);
      return fixture.run(spec);
    },
  });
  const capped = runFixtureHarness(t, {
    absoluteDeadlineEpochMs: 900_000,
    nowEpochMs: () => 0,
    rawEventRecomputationSandboxWorkerRunner,
  });
  assert.equal(capped.receipt.status, 'system_benchmark_harness_verified');
  assert.deepEqual(capturedTimeouts, [300_000]);

  capturedTimeouts.length = 0;
  const narrowed = runFixtureHarness(t, {
    absoluteDeadlineEpochMs: 200_000,
    nowEpochMs: () => 0,
    rawEventRecomputationSandboxWorkerRunner,
  });
  assert.equal(narrowed.receipt.status, 'system_benchmark_harness_verified');
  assert.deepEqual(capturedTimeouts, [110_000]);
});

test('benchmark harness ignores the removed outer recomputation callback seam', (t) => {
  let legacyInvocationCount = 0;
  const execution = runFixtureHarness(t, {
    legacyRunRawEventRecomputation() {
      legacyInvocationCount += 1;
      throw new Error('removed_recomputation_callback_must_not_run');
    },
  });
  assert.equal(execution.receipt.status, 'system_benchmark_harness_verified');
  assert.equal(legacyInvocationCount, 0);
});

test('benchmark harness does not start raw-event recomputation without cleanup reserve', (t) => {
  let recomputationInvocationCount = 0;
  const execution = runFixtureHarness(t, {
    absoluteDeadlineEpochMs: 90_000,
    nowEpochMs: () => 0,
    rawEventRecomputationSandboxWorkerRunner: {
      run() {
        recomputationInvocationCount += 1;
        throw new Error('raw_event_recomputation_must_not_start');
      },
    },
  });
  assert.equal(execution.invocationCount, 3);
  assert.equal(recomputationInvocationCount, 0);
  assert.equal(execution.receipt.status, 'system_benchmark_harness_blocked');
  assert.equal(execution.receipt.executionStatus, 'system_benchmark_execution_completed');
  assert.equal(execution.receipt.scientificVerdict, 'not_evaluable');
  assert.deepEqual(execution.receipt.artifacts, []);
  assert.ok(execution.receipt.blockers.includes(
    'benchmark_raw_event_recomputation_deadline_exhausted',
  ));
  assert.equal(
    execution.receipt.independentRawEventRecomputationAssurance.status,
    'independent_raw_event_recomputation_assurance_blocked',
  );
  assert.equal(
    execution.receipt.independentRawEventRecomputationAssurance
      .processIsolatedRawEventRecomputationAssurance,
    null,
  );
});

test('benchmark harness reserves recomputation CPU and narrows every worker resource limit', (t) => {
  const capturedOptions = [];
  const fixture = createRawEventRecomputationSandboxTestFixture();
  const memoryBytes = 64 * 1024 * 1024;
  const execution = runFixtureHarness(t, {
    aggregateCpuSeconds: 10,
    memoryBytes,
    maximumProcesses: 3,
    rawEventRecomputationSandboxWorkerRunner: {
      run(spec) {
        capturedOptions.push({
          timeoutMs: spec.timeoutMs,
          cpuSeconds: spec.cpuSeconds,
          memoryBytes: spec.memoryBytes,
          maximumProcesses: spec.maximumProcesses,
        });
        return fixture.run(spec);
      },
    },
  });
  assert.equal(execution.receipt.status, 'system_benchmark_harness_verified');
  assert.equal(execution.receipt.allocatedCpuSeconds, 3);
  assert.equal(execution.receipt.cpuBudgetSemantics, SYSTEM_BENCHMARK_CPU_BUDGET_SEMANTICS);
  assert.ok(execution.resourceBudgets.every((budget) => budget.cpuSeconds === 1));
  assert.deepEqual(capturedOptions, [{
    timeoutMs: 300_000,
    cpuSeconds: 7,
    memoryBytes,
    maximumProcesses: 3,
  }]);
  const recomputationBudget = execution.receipt.independentRawEventRecomputationAssurance
    .processIsolatedRawEventRecomputationAssurance.resourceBudget;
  assert.equal(execution.receipt.allocatedCpuSeconds + recomputationBudget.cpuSeconds, 10);
  assert.equal(recomputationBudget.memoryBytes, memoryBytes);
  assert.equal(recomputationBudget.maximumProcesses, 3);
  assert.equal(verifySystemBenchmarkHarnessExecutionReceipt(execution.receipt), true);
  assert.equal(
    verifyProductionSystemBenchmarkHarnessExecutionReceipt(execution.receipt),
    false,
  );
  assert.equal(verifySystemBenchmarkHarnessResourceBudget({
    ...execution.receipt,
    cpuBudgetSemantics: 'process-tree-cumulative-cpu-v1',
  }, { executionUnitCount: execution.resourceBudgets.length }), false);
});

test('benchmark harness rejects a sandbox receipt claiming authority above its request', (t) => {
  const fixture = createRawEventRecomputationSandboxTestFixture();
  const execution = runFixtureHarness(t, {
    absoluteDeadlineEpochMs: 200_000,
    nowEpochMs: () => 0,
    rawEventRecomputationSandboxWorkerRunner: {
      run(spec) {
        return fixture.run({
          ...spec,
          timeoutMs: 300_000,
        });
      },
    },
  });
  assert.equal(execution.receipt.status, 'system_benchmark_harness_blocked');
  assert.ok(execution.receipt.blockers.includes(
    'independent_raw_event_recomputation_process:raw_event_recomputation_os_sandbox_resource_budget_mismatch',
  ));
  assert.equal(
    execution.receipt.independentRawEventRecomputationAssurance.processIndependent,
    false,
  );
});

test('benchmark harness rejects recomputation that settles inside its cleanup reserve', (t) => {
  let now = 0;
  const fixture = createRawEventRecomputationSandboxTestFixture();
  const execution = runFixtureHarness(t, {
    absoluteDeadlineEpochMs: 300_000,
    nowEpochMs: () => now,
    rawEventRecomputationSandboxWorkerRunner: {
      run(spec) {
        const receipt = fixture.run(spec);
        now = 250_000;
        return receipt;
      },
    },
  });
  assert.equal(execution.receipt.status, 'system_benchmark_harness_blocked');
  assert.ok(execution.receipt.blockers.includes(
    'benchmark_raw_event_recomputation_deadline_exhausted',
  ));
  assert.equal(
    execution.receipt.independentRawEventRecomputationAssurance.status,
    'independent_raw_event_recomputation_assurance_blocked',
  );
});

test('academic recomputation evidence rejects hash-consistent nested manifest and request forgeries', (t) => {
  const verified = runFixtureHarness(t).receipt
    .independentRawEventRecomputationAssurance;
  assert.equal(
    verifyProcessIsolatedSystemBenchmarkRecomputationEvidence(verified),
    true,
  );
  const mutations = [
    ['request hash detached from worker request', (independent) => {
      independent.processIsolatedRawEventRecomputationAssurance.requestHash =
        hashRecord('ForgedRawEventRecomputationRequest', {});
    }],
    ['worker manifest bytes detached from its canonical hash', (independent) => {
      independent.processIsolatedRawEventRecomputationAssurance.workerReceipt
        .manifest.maximumAbsoluteResidual = 1;
    }],
    ['canonical nested manifest detached from independent manifest', (independent) => {
      const assurance = independent.processIsolatedRawEventRecomputationAssurance;
      const manifest = assurance.workerReceipt.manifest;
      manifest.cells[0].metrics.mean_score += 0.125;
      const { rawEventRecomputationManifestHash: ignoredHash, ...payload } = manifest;
      void ignoredHash;
      manifest.rawEventRecomputationManifestHash = hashRecord(
        'RawEventRecomputationManifest', payload,
      );
      assurance.workerReceipt.rawEventRecomputationManifestHash =
        manifest.rawEventRecomputationManifestHash;
      assurance.rawEventRecomputationManifestHash =
        manifest.rawEventRecomputationManifestHash;
    }],
    ['independent assurance schema downgrade', (independent) => {
      independent.version = 1;
    }],
    ['verified worker carrying blockers', (independent) => {
      independent.processIsolatedRawEventRecomputationAssurance
        .workerReceipt.blockers = ['forged_worker_blocker'];
    }],
    ['passed sandbox receipt carrying blockers', (independent) => {
      independent.processIsolatedRawEventRecomputationAssurance
        .osSandboxWorkerReceipt.blockers = ['forged_sandbox_blocker'];
    }],
  ];
  for (const [label, mutate] of mutations) {
    const forged = structuredClone(verified);
    mutate(forged);
    rehashIndependentProcessEvidence(forged);
    assert.equal(
      verifyProcessIsolatedSystemBenchmarkRecomputationEvidence(forged),
      false,
      label,
    );
  }
});

test('benchmark harness rolls back published results when receipt signing reaches the deadline', (t) => {
  let clockReads = 0;
  const deadline = 300_000;
  const execution = runFixtureHarness(t, {
    absoluteDeadlineEpochMs: deadline,
    nowEpochMs: () => (clockReads++ < 10 ? 0 : deadline),
  });
  assert.equal(execution.receipt.status, 'system_benchmark_harness_blocked');
  assert.ok(execution.receipt.blockers.includes('benchmark_harness_absolute_deadline_exhausted'));
  assert.equal(execution.receipt.scientificVerdict, 'not_evaluable');
  assert.equal(execution.receipt.resultDocument, null);
  assert.equal(execution.receipt.csvDocument, null);
  assert.equal(execution.receipt.resultJsonHash, null);
  assert.equal(execution.receipt.resultCsvHash, null);
  assert.deepEqual(execution.receipt.artifacts, []);
  for (const name of ['results.json', 'results.csv', 'raw-events.ndjson']) {
    assert.equal(fs.existsSync(path.join(execution.outputDirectory, name)), false, name);
  }
});

test('benchmark harness resource receipt is bound directly to immutable Experiment IR authority', (t) => {
  const execution = runFixtureHarness(t);
  const options = { executionUnitCount: execution.resourceBudgets.length };
  assert.equal(verifySystemBenchmarkHarnessResourceBudget(execution.receipt, options), true);
  for (const [field, value] of [
    ['absoluteDeadlineEpochMs', execution.receipt.absoluteDeadlineEpochMs + 1],
    ['aggregateCpuSeconds', execution.receipt.aggregateCpuSeconds + 1],
    ['workerMemoryBytes', execution.receipt.workerMemoryBytes + 1],
    ['workerMaximumProcesses', execution.receipt.workerMaximumProcesses + 1],
    ['gpuRequired', !execution.receipt.gpuRequired],
  ]) {
    assert.equal(verifySystemBenchmarkHarnessResourceBudget({
      ...execution.receipt,
      [field]: value,
    }, options), false, field);
  }
});

test('academic harness proves signed dataset use and serial process isolation per cell', async (t) => {
  const fixture = academicHarnessFixture(t);
  const adapters = adapterSet(fixture.selector.experimentDesign.benchmarkHarness.armProtocolSet);
  let invocationCount = 0;
  let activeCount = 0;
  let maximumActiveCount = 0;
  const receipt = await withRawEventRecomputationSandboxFixtureForTest(
    () => executeSystemBenchmarkHarness({
    benchmarkSelector: fixture.selector,
    datasetMounts: [fixture.mount],
    experimentAttemptId: 'academic-system-harness-attempt',
    sourceLineageHash: `sha256:${'c'.repeat(64)}`,
    sourceMerkleHash: `sha256:${'1'.repeat(64)}`,
    sourceWorkspaceManifestHash: `sha256:${'2'.repeat(64)}`,
    outputDirectory: fixture.outputDirectory,
    armAdapterSet: adapters,
    operatorDatasetAuthorityTrustStore: fixture.trustStore,
    runtimeRoot: fixture.runtimeRoot,
    absoluteDeadlineEpochMs: 120_000,
    async runArmBatch({ batch, outputDirectory }) {
      invocationCount += 1;
      const processOrdinal = invocationCount;
      activeCount += 1;
      maximumActiveCount = Math.max(maximumActiveCount, activeCount);
      await new Promise((resolve) => setImmediate(resolve));
      const effectiveBatch = {
        ...batch,
        benchmarkId: fixture.selector.benchmarkId,
        selectorHash: fixture.selector.campaignBenchmarkSelectorHash,
        designHash: fixture.selector.experimentDesignHash,
        harnessHash: fixture.selector.experimentDesign.benchmarkHarnessHash,
      };
      const content = responseDocument(batch);
      fs.mkdirSync(outputDirectory, { recursive: true });
      fs.writeFileSync(path.join(outputDirectory, 'observation.json'), content);
      const receipt = workerReceipt({
        batch: effectiveBatch,
        content,
        datasetMounts: [fixture.mount],
        processOrdinal,
      });
      activeCount -= 1;
      return receipt;
    },
    }), { nowEpochMs: () => 0 },
  );
  assert.equal(receipt.status, 'system_benchmark_harness_verified', JSON.stringify(receipt.blockers));
  assert.equal(receipt.executionIsolationMode, 'academic-per-cell-process-v1');
  assert.equal(invocationCount, receipt.scheduleCellCount);
  assert.equal(receipt.processExecutionCount, receipt.scheduleCellCount);
  assert.equal(maximumActiveCount, 1);
  assert.ok(receipt.armBatchExecutions.every(
    (batch) => batch.resourceBudget.timeoutMs === 60_000,
  ));
  assert.equal(receipt.datasetEvaluationDependencyReceipt.status, 'dataset_evaluation_dependency_verified');
  assert.equal(new Set(receipt.armBatchExecutions.map((batch) => batch.executionProcessIdentityHash)).size,
    receipt.scheduleCellCount);
  assert.equal(receipt.experimentIr.version, 4);
  assert.equal(receipt.academicPromotionEligible, false);
  assert.equal(verifySystemBenchmarkHarnessExecutionReceipt(receipt), true);
  const forged = structuredClone(receipt);
  forged.academicPromotionEligible = true;
  forged.resultDocument.academicPromotionEligible = true;
  const { systemBenchmarkHarnessExecutionReceiptHash: ignoredHash, ...forgedPayload } = forged;
  void ignoredHash;
  forged.systemBenchmarkHarnessExecutionReceiptHash = hashRecord(
    'SystemBenchmarkHarnessExecutionReceipt', forgedPayload,
  );
  assert.equal(verifySystemBenchmarkHarnessExecutionReceipt(forged), false);
  const rawArtifactWritePayload = {
    version: 2,
    kind: 'ArtifactWriteReceipt',
    role: 'campaign-experiment-raw-events:primary',
    path: `raw-events-${receipt.rawEventArtifactHash.slice('sha256:'.length)}.ndjson`,
    hash: receipt.rawEventArtifactHash,
    bytes: receipt.rawEventArtifactBytes,
    contentType: 'application/octet-stream',
    contentAddress: receipt.rawEventArtifactHash,
    immutableObject: true,
    atomic: true,
  };
  const runReceipt = buildFixtureExperimentRunReceipt({
    resultDocument: receipt.resultDocument,
    csvDocument: receipt.csvDocument,
    benchmarkSelector: fixture.selector,
    datasetMounts: [fixture.mount],
    executionReceiptHash: receipt.systemBenchmarkHarnessExecutionReceiptHash,
    runtimeIdentityHash: receipt.runtimeIdentityHash,
    sourceMerkleHash: receipt.sourceMerkleHash,
    sourceWorkspaceManifestHash: receipt.sourceWorkspaceManifestHash,
    cacheHit: false,
    resultJsonHash: receipt.resultJsonHash,
    resultCsvHash: receipt.resultCsvHash,
    experimentAttemptId: receipt.experimentAttemptId,
    harnessExecutionReceipt: receipt,
    sourceLineageHash: receipt.sourceLineageHash,
    rawArtifactWriteReceipt: {
      ...rawArtifactWritePayload,
      writeReceiptHash: hashRecord('ArtifactWriteReceipt', rawArtifactWritePayload),
      ledgerReceiptId: `artifact-writes:${receipt.experimentAttemptId}`,
    },
  });
  assert.equal(verifyFixtureExperimentRunReceipt(runReceipt), true);
  assert.equal(runReceipt.academicPromotionEligible, false);
  assert.equal(runReceipt.evidenceClass, 'software-conformance-evidence');
  assert.equal(runReceipt.promotionScope, 'software-conformance-only');
});

test('local dataset harness keeps hidden evaluation while using one bounded process per arm', async (t) => {
  const fixture = academicHarnessFixture(t);
  const adapters = adapterSet(fixture.selector.experimentDesign.benchmarkHarness.armProtocolSet);
  let invocationCount = 0;
  const receipt = await withRawEventRecomputationSandboxFixtureForTest(
    () => executeSystemBenchmarkHarness({
    benchmarkSelector: fixture.selector,
    datasetMounts: [fixture.mount],
    experimentAttemptId: 'local-system-harness-attempt',
    sourceLineageHash: `sha256:${'c'.repeat(64)}`,
    sourceMerkleHash: `sha256:${'1'.repeat(64)}`,
    sourceWorkspaceManifestHash: `sha256:${'2'.repeat(64)}`,
    outputDirectory: fixture.outputDirectory,
    armAdapterSet: adapters,
    operatorDatasetAuthorityTrustStore: fixture.trustStore,
    runtimeRoot: fixture.runtimeRoot,
    absoluteDeadlineEpochMs: 120_000,
    localOnly: true,
    async runArmBatch({ batch, outputDirectory }) {
      invocationCount += 1;
      const effectiveBatch = {
        ...batch,
        benchmarkId: fixture.selector.benchmarkId,
        selectorHash: fixture.selector.campaignBenchmarkSelectorHash,
        designHash: fixture.selector.experimentDesignHash,
        harnessHash: fixture.selector.experimentDesign.benchmarkHarnessHash,
      };
      const content = responseDocument(batch);
      fs.mkdirSync(outputDirectory, { recursive: true });
      fs.writeFileSync(path.join(outputDirectory, 'observation.json'), content);
      return workerReceipt({
        batch: effectiveBatch,
        content,
        datasetMounts: [fixture.mount],
        processOrdinal: invocationCount,
      });
    },
    }), { nowEpochMs: () => 0 },
  );
  assert.equal(receipt.status, 'system_benchmark_harness_verified', JSON.stringify(receipt.blockers));
  assert.equal(receipt.executionIsolationMode, 'local-authorized-per-arm-batch-process-v1');
  assert.equal(receipt.executionAssuranceProfile, 'local-bounded-hidden-evaluation-v1');
  assert.equal(receipt.academicPromotionEligible, false);
  assert.equal(invocationCount, 3);
  assert.equal(receipt.processExecutionCount, 3);
  assert.equal(receipt.datasetEvaluationDependencyReceipt.status,
    'dataset_evaluation_dependency_verified');
  assert.equal(verifySystemBenchmarkHarnessExecutionReceipt(receipt), true);
});

test('implementation manifest is the exact byte-hashed transitive empirical promotion closure', () => {
  assert.deepEqual(SYSTEM_BENCHMARK_HARNESS_ROOTS, REQUIRED_ROOTS);
  const closure = implementationClosure();
  assert.deepEqual(SYSTEM_BENCHMARK_HARNESS_TARGETS.map((target) => target.path), closure);
  assert.deepEqual(SYSTEM_BENCHMARK_HARNESS_TARGETS.map((target) => ({
    ...target,
    sha256: hashBytes(fs.readFileSync(path.join(REPOSITORY_ROOT, target.path))),
  })), SYSTEM_BENCHMARK_HARNESS_TARGETS);
  assert.equal(SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION.systemBenchmarkHarnessImplementationHash, hashRecord('SystemBenchmarkHarnessImplementationManifest', {
    version: 2,
    kind: 'SystemBenchmarkHarnessImplementationManifest',
    roots: SYSTEM_BENCHMARK_HARNESS_ROOTS,
    targets: SYSTEM_BENCHMARK_HARNESS_TARGETS,
  }));
});

test('every built-in arm batch carries its inference-powered schedule in bounded authenticated environment chunks', () => {
  for (const benchmarkId of [
    'ml_algorithm_benchmark',
    'rl_stochastic_control_benchmark',
    'econometrics_panel_benchmark',
    'finance_asset_pricing_benchmark',
    'operations_optimization_benchmark',
  ]) {
    const selector = buildCampaignBenchmarkSelector({ benchmarkId, datasetMounts: [] });
    const schedule = buildCampaignBenchmarkSchedule(selector);
    for (const arm of ['treatment', 'baseline', 'ablation']) {
      const cells = schedule.filter((cell) => cell.arm === arm);
      const built = buildSystemBenchmarkArmBatchChallenge({ protocol: cells[0].armProtocol, cells });
      const environment = systemBenchmarkArmBatchChallengeEnvironment(built.challenge);
      assert.equal(built.challenge.scheduleCellCount,
        selector.experimentDesign.seedSchedule.length * selector.experimentDesign.minimumRepetitions);
      assert.ok(Number(environment.HEPTA_BENCHMARK_CHALLENGE_PART_COUNT)
        <= SYSTEM_BENCHMARK_ARM_BATCH_CHALLENGE_MAXIMUM_PARTS);
      assert.equal(Array.from({ length: Number(environment.HEPTA_BENCHMARK_CHALLENGE_PART_COUNT) }, (_, index) => (
        Buffer.byteLength(environment[`HEPTA_BENCHMARK_CHALLENGE_JSON_PART_${index + 1}`]) <= 60 * 1024
      )).every(Boolean), true);
      assert.deepEqual(decodeSystemBenchmarkArmBatchChallengeEnvironment(environment), built.challenge);
    }
  }
});

test('arm batch environment rejects missing, extra, and hash-tampered chunks before execution', () => {
  const selector = buildCampaignBenchmarkSelector({ benchmarkId: 'ml_algorithm_benchmark', datasetMounts: [] });
  const cells = buildCampaignBenchmarkSchedule(selector).filter((cell) => cell.arm === 'treatment');
  const built = buildSystemBenchmarkArmBatchChallenge({ protocol: cells[0].armProtocol, cells });
  const environment = systemBenchmarkArmBatchChallengeEnvironment(built.challenge);
  assert.deepEqual(selectAndValidateWorkerEnvironment({ env: environment }).blockers, []);
  const missing = { ...environment };
  delete missing.HEPTA_BENCHMARK_CHALLENGE_JSON_PART_1;
  assert.deepEqual(selectAndValidateWorkerEnvironment({ env: missing }).blockers, ['worker_benchmark_arm_batch_challenge_binding_invalid']);
  const extra = { ...environment, HEPTA_BENCHMARK_CHALLENGE_JSON_PART_4: '{}' };
  assert.deepEqual(selectAndValidateWorkerEnvironment({ env: extra }).blockers, ['worker_benchmark_arm_batch_challenge_binding_invalid']);
  const tampered = { ...environment, HEPTA_BENCHMARK_CHALLENGE_HASH: `sha256:${'f'.repeat(64)}` };
  assert.deepEqual(selectAndValidateWorkerEnvironment({ env: tampered }).blockers, ['worker_benchmark_arm_batch_challenge_binding_invalid']);
});

test('repository-owned challenges and hidden oracles bind candidate arm responses and raw-event evidence', (t) => {
  const fixtureRun = runFixtureHarness(t);
  const verified = fixtureRun.receipt;
  assert.equal(verified.status, 'system_benchmark_harness_verified', JSON.stringify(verified.blockers));
  assert.equal(verified.executionStatus, 'system_benchmark_execution_completed');
  assert.equal(verified.integrityStatus, 'system_benchmark_integrity_verified');
  assert.equal(verified.scientificVerdict, 'positive');
  assert.equal(verified.preDataAccessFreeze.protocolFrozenBeforeDataAccess, true);
  assert.equal(verified.preDataAccessFreeze.codeFrozenBeforeDataAccess, true);
  assert.equal(verified.preDataAccessFreeze.sourceMerkleHash, `sha256:${'1'.repeat(64)}`);
  assert.equal(fixtureRun.invocationCount, 3, 'one isolated invocation per arm is required');
  assert.equal(verified.scheduleCellCount, 105);
  assert.equal(verified.cells.length, 105);
  const pairedSchedule = new Map();
  for (const cell of verified.cells) pairedSchedule.set(`${cell.seed}:${cell.repetition}`, (pairedSchedule.get(`${cell.seed}:${cell.repetition}`) || 0) + 1);
  assert.equal(pairedSchedule.size, 35);
  assert.equal([...pairedSchedule.values()].every((count) => count === 3), true, 'every seed/repetition must contain all three arms');
  assert.equal(verified.armBatchExecutions.length, 3);
  assert.equal(verified.armBatchExecutions.every((batch) => batch.scheduleCellCount === 35
    && verifyOsSandboxWorkerReceipt(batch.runnerReceipt)), true, 'fixture arm-batch worker receipt invalid');
  assert.equal(new Set(verified.armBatchExecutions.map((batch) => batch.runnerReceiptHash)).size, 3);
  const selectorCheck = verifyCampaignBenchmarkSelector(verified.benchmarkSelector, { benchmarkId: verified.benchmarkId, datasetMounts: verified.datasetAuthorizations });
  assert.equal(selectorCheck.valid, true, JSON.stringify(selectorCheck.blockers));
  assert.equal(verified.systemBenchmarkArmProtocolSetHash, verified.benchmarkSelector.experimentDesign.benchmarkHarness.systemBenchmarkArmProtocolSetHash);
  for (const batch of verified.armBatchExecutions) {
    assert.equal(batch.runnerReceipt.executionBindings.HEPTA_EXPERIMENT_ARM_PROTOCOL_HASH, batch.systemBenchmarkArmProtocolHash);
    assert.equal(batch.runnerReceipt.executionBindings.HEPTA_EXPERIMENT_ARM_PROTOCOL_SET_HASH, verified.systemBenchmarkArmProtocolSetHash);
    assert.equal(batch.runnerReceipt.executionBindings.HEPTA_PRE_DATA_ACCESS_FREEZE_HASH,
      verified.empiricalPreDataAccessFreezeHash);
  }
  assert.equal(verifySystemBenchmarkHarnessExecutionReceipt(verified), true);
  assert.equal(verified.version, 5);
  assert.ok(Number.isSafeInteger(verified.resultPersistenceCompletedAtEpochMs));
  assert.ok(Number.isSafeInteger(verified.receiptFinalizedAtEpochMs));
  assert.ok(verified.resultPersistenceCompletedAtEpochMs <= verified.receiptFinalizedAtEpochMs);
  assert.ok(verified.receiptFinalizedAtEpochMs < verified.absoluteDeadlineEpochMs);
  for (const mutate of [
    (receipt) => { receipt.version = 4; },
    (receipt) => { receipt.resultPersistenceCompletedAtEpochMs = null; },
    (receipt) => { receipt.resultPersistenceCompletedAtEpochMs = receipt.absoluteDeadlineEpochMs; },
    (receipt) => { receipt.receiptFinalizedAtEpochMs = receipt.resultPersistenceCompletedAtEpochMs - 1; },
    (receipt) => { receipt.receiptFinalizedAtEpochMs = receipt.absoluteDeadlineEpochMs; },
  ]) {
    const forged = structuredClone(verified);
    mutate(forged);
    const { systemBenchmarkHarnessExecutionReceiptHash: ignoredHash, ...forgedPayload } = forged;
    void ignoredHash;
    forged.systemBenchmarkHarnessExecutionReceiptHash = hashRecord(
      'SystemBenchmarkHarnessExecutionReceipt', forgedPayload,
    );
    assert.equal(verifySystemBenchmarkHarnessExecutionReceipt(forged), false);
  }
  const cachedHashTamper = structuredClone(verified);
  cachedHashTamper.rawEventArtifactHash = `sha256:${'d'.repeat(64)}`;
  assert.equal(
    verifySystemBenchmarkHarnessExecutionReceipt(cachedHashTamper),
    false,
    'receipt self-hash must be recomputed before a verified-hash cache lookup',
  );
  assert.equal(new Set(verified.cells.map((cell) => cell.systemBenchmarkArmProtocolHash)).size, 3);
  assert.equal(new Set(verified.cells.map((cell) => cell.systemBenchmarkArmProtocolExecutionReceiptHash)).size, verified.cells.length);
  assert.equal(new Set(verified.cells.map((cell) => cell.armBatchExecutionReceiptHash)).size, 3);
  assert.equal(verified.cells.every((cell) => cell.runnerReceipt === undefined && cell.runnerReceiptHash === undefined), true);
  assert.equal(verified.cells.every((cell) => cell.rawEvents === undefined && /^sha256:[0-9a-f]{64}$/.test(cell.rawEventArtifactHash)), true);
  assert.equal(verified.artifacts.some((artifact) => artifact.path === 'raw-events.ndjson'
    && artifact.sha256 === verified.rawEventArtifactHash && artifact.bytes === verified.rawEventArtifactBytes), true);
  assert.equal(
    verified.independentRawEventRecomputationAssurance.status,
    'independent_raw_event_recomputation_assurance_verified',
  );
  assert.equal(
    verified.independentRawEventRecomputationAssurance.assuranceScope,
    'os-sandboxed-process-independent-implementation-v1',
  );
  assert.equal(
    verified.independentRawEventRecomputationAssurance.processIndependent,
    true,
  );
  assert.notEqual(
    verified.independentRawEventRecomputationAssurance.processIsolatedWorkerPid,
    process.pid,
  );
  assert.equal(
    verified.independentRawEventRecomputationAssurance
      .processIsolatedRawEventRecomputationAssurance.processIndependent,
    true,
  );
  assert.notEqual(
    verified.independentRawEventRecomputationAssurance.producerImplementationHash,
    verified.independentRawEventRecomputationAssurance.verifierImplementationHash,
  );
  assert.equal(
    verified.analysisObservationAuthority.independentResidualRecomputationVerified,
    true,
  );
  assert.equal(
    verified.datasetEvaluationDependencyReceipt,
    null,
    'synthetic conformance runs must not claim operator-dataset evaluation dependency',
  );
  assert.equal(verified.resultDocument.datasetEvaluationDependencyReceipt, null);

  const rawTamper = structuredClone(verified);
  rawTamper.rawEventArtifactHash = `sha256:${'e'.repeat(64)}`;
  const { systemBenchmarkHarnessExecutionReceiptHash: ignoredReceiptHash, ...rawTamperPayload } = rawTamper;
  void ignoredReceiptHash;
  rawTamper.systemBenchmarkHarnessExecutionReceiptHash = hashRecord('SystemBenchmarkHarnessExecutionReceipt', rawTamperPayload);
  assert.equal(verifySystemBenchmarkHarnessExecutionReceipt(rawTamper), false, 'raw artifact hash tamper must fail');

  const recomputationTamper = structuredClone(verified);
  recomputationTamper.rawEventRecomputationManifest.cells[0].metrics.mean_score += 0.25;
  const { rawEventRecomputationManifestHash: ignoredRecomputationHash, ...recomputationPayload } = recomputationTamper.rawEventRecomputationManifest;
  void ignoredRecomputationHash;
  recomputationTamper.rawEventRecomputationManifest.rawEventRecomputationManifestHash = hashRecord('RawEventRecomputationManifest', recomputationPayload);
  const { systemBenchmarkHarnessExecutionReceiptHash: ignoredRecomputationOuterHash, ...recomputationOuterPayload } = recomputationTamper;
  void ignoredRecomputationOuterHash;
  recomputationTamper.systemBenchmarkHarnessExecutionReceiptHash = hashRecord('SystemBenchmarkHarnessExecutionReceipt', recomputationOuterPayload);
  assert.equal(verifySystemBenchmarkHarnessExecutionReceipt(recomputationTamper), false, 'raw-event recomputation manifest tamper must fail');

  const independentAssuranceTamper = structuredClone(verified);
  independentAssuranceTamper.independentRawEventRecomputationAssurance
    .verifierImplementationHash = independentAssuranceTamper
      .independentRawEventRecomputationAssurance.producerImplementationHash;
  const {
    independentRawEventRecomputationAssuranceHash: ignoredIndependentAssuranceHash,
    ...independentAssurancePayload
  } = independentAssuranceTamper.independentRawEventRecomputationAssurance;
  void ignoredIndependentAssuranceHash;
  independentAssuranceTamper.independentRawEventRecomputationAssurance
    .independentRawEventRecomputationAssuranceHash = hashRecord(
      'IndependentRawEventRecomputationAssurance',
      independentAssurancePayload,
    );
  const {
    systemBenchmarkHarnessExecutionReceiptHash: ignoredIndependentOuterHash,
    ...independentOuterPayload
  } = independentAssuranceTamper;
  void ignoredIndependentOuterHash;
  independentAssuranceTamper.systemBenchmarkHarnessExecutionReceiptHash = hashRecord(
    'SystemBenchmarkHarnessExecutionReceipt',
    independentOuterPayload,
  );
  assert.equal(
    verifySystemBenchmarkHarnessExecutionReceipt(independentAssuranceTamper),
    false,
    'same producer/verifier implementation cannot claim independent recomputation',
  );

  const batchTamper = structuredClone(verified);
  batchTamper.armBatchExecutions[0].cellIds = batchTamper.armBatchExecutions[0].cellIds.slice(1);
  const { systemBenchmarkArmBatchExecutionReceiptHash: ignoredBatchHash, ...batchPayload } = batchTamper.armBatchExecutions[0];
  void ignoredBatchHash;
  batchTamper.armBatchExecutions[0].systemBenchmarkArmBatchExecutionReceiptHash = hashRecord('SystemBenchmarkArmBatchExecutionReceipt', batchPayload);
  const { systemBenchmarkHarnessExecutionReceiptHash: ignoredBatchOuterHash, ...batchOuterPayload } = batchTamper;
  void ignoredBatchOuterHash;
  batchTamper.systemBenchmarkHarnessExecutionReceiptHash = hashRecord('SystemBenchmarkHarnessExecutionReceipt', batchOuterPayload);
  assert.equal(verifySystemBenchmarkHarnessExecutionReceipt(batchTamper), false, 'batch schedule tamper must fail');

  const incompleteBatch = runFixtureHarness(t, { dropLastCell: true }).receipt;
  assert.equal(incompleteBatch.status, 'system_benchmark_harness_blocked');
  assert.ok(incompleteBatch.blockers.some((blocker) => blocker.includes('benchmark_arm_batch_response_document_shape_invalid')));

  const ignored = runFixtureHarness(t, { ignoreArm: true }).receipt;
  assert.equal(ignored.status, 'system_benchmark_harness_verified');
  assert.equal(ignored.executionStatus, 'system_benchmark_execution_completed');
  assert.equal(ignored.integrityStatus, 'system_benchmark_integrity_verified');
  assert.equal(ignored.scientificVerdict, 'negative');
  assert.deepEqual(ignored.blockers, []);
  assert.ok(ignored.scientificFindings.some((finding) => finding.startsWith('analysis_confirmatory_hypothesis_not_supported:')));
  assert.equal(ignored.artifacts.length, 3, 'negative results must retain JSON, CSV, and raw-event artifacts');
  assert.equal(verifySystemBenchmarkHarnessExecutionReceipt(ignored), true);

  const freezeTamper = structuredClone(ignored);
  freezeTamper.preDataAccessFreeze.analysisProtocolHash = `sha256:${'f'.repeat(64)}`;
  const { systemBenchmarkHarnessExecutionReceiptHash: ignoredFreezeHash, ...freezePayload } = freezeTamper;
  void ignoredFreezeHash;
  freezeTamper.systemBenchmarkHarnessExecutionReceiptHash = hashRecord('SystemBenchmarkHarnessExecutionReceipt', freezePayload);
  assert.equal(verifySystemBenchmarkHarnessExecutionReceipt(freezeTamper), false, 'protocol/code freeze tamper must fail');

  const failedAttemptLineageHash = hashRecord('SystemBenchmarkRepairFailureFixture', { attempt: 1 });
  const repaired = runFixtureHarness(t, {
    runId: 'fixture-experiment-attempt:v2',
    attemptVersion: 2,
    failedAttemptLineageHashes: [failedAttemptLineageHash],
  }).receipt;
  assert.equal(repaired.status, 'system_benchmark_harness_verified');
  assert.equal(repaired.preDataAccessFreeze.attemptVersion, 2);
  assert.deepEqual(repaired.preDataAccessFreeze.failedAttemptLineageHashes, [failedAttemptLineageHash]);
  assert.equal(verifySystemBenchmarkHarnessExecutionReceipt(repaired), true);

  const tampered = runFixtureHarness(t, { tamperProtocol: true }).receipt;
  assert.equal(tampered.status, 'system_benchmark_harness_blocked');
  assert.ok(tampered.blockers.some((blocker) => blocker.startsWith('benchmark_arm_batch_identity_binding_invalid:')));

  const aliases = runFixtureHarness(t, { identicalAdapters: true }).receipt;
  assert.equal(aliases.status, 'system_benchmark_harness_blocked');
  assert.ok(aliases.blockers.includes('benchmark_harness_arm_adapter_set_invalid'));

  assert.throws(() => buildCampaignBenchmarkSelector({
    benchmarkId: 'operator-dataset',
    datasetMounts: [{
      name: 'operator-dataset', readOnly: true, manifestHash: `sha256:${'a'.repeat(64)}`,
      splitManifestHash: `sha256:${'b'.repeat(64)}`, licenseId: 'CC-BY-4.0',
    }],
  }), /campaign_benchmark_dataset_authorization_invalid/);
});

test('host sandbox executes exactly three arm batches or reports the unavailable isolation backend', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-system-benchmark-real-batch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'output');
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(root, 'main.tex'), 'fixture\n');
  const adapterSource = (arm) => `// ${arm} arm batch fixture\nimport fs from 'node:fs';\nconst count=Number(process.env.HEPTA_BENCHMARK_CHALLENGE_PART_COUNT);\nconst batch=JSON.parse(Array.from({length:count},(_,i)=>process.env['HEPTA_BENCHMARK_CHALLENGE_JSON_PART_'+(i+1)]).join(''));\nconst cells=batch.cells.map(({cellId,challenge})=>({cellId,systemBenchmarkCellChallengeHash:challenge.systemBenchmarkCellChallengeHash,responses:challenge.cases.map(item=>{let prediction=0;if(batch.arm==='treatment')prediction=item.input.primary+(0.35*item.input.secondary)>=0?1:0;else if(batch.arm==='ablation')prediction=item.input.secondary>=0?1:0;else prediction=item.referenceResponse;return {caseId:item.caseId,[challenge.responseField]:prediction};})}));\nfs.writeFileSync('observation.json',JSON.stringify({version:1,kind:'CampaignBenchmarkArmBatchResponses',systemBenchmarkArmBatchChallengeHash:batch.systemBenchmarkArmBatchChallengeHash,cells})+'\\n');\n`;
  fs.writeFileSync(path.join(root, 'run.mjs'), 'void 0;\n');
  for (const arm of ['treatment', 'baseline', 'ablation']) fs.writeFileSync(path.join(root, `run.${arm}.mjs`), adapterSource(arm));
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: [process.execPath],
    allowedRoots: [root],
    allowedOutputRoots: [output],
  });
  if (!runner.availability.available || runner.availability.backend !== 'bubblewrap') {
    assert.equal(runner.availability.available === true && runner.availability.backend === 'bubblewrap', false);
    assert.ok(runner.availability.status || runner.availability.reason || runner.availability.blockers);
    t.diagnostic(`host sandbox unavailable: ${JSON.stringify(runner.availability)}`);
    return;
  }
  const selector = buildCampaignBenchmarkSelector({ benchmarkId: 'ml_algorithm_benchmark', datasetMounts: [] });
  const executor = createMultiLanguageEmpiricalExecutor({
    workerRunner: runner,
  });
  const receipt = await withRawEventRecomputationSandboxFixtureForTest(
    () => executor.execute({
    language: 'node',
    entrypoint: 'run.mjs',
    cwd: root,
    sourceRoot: root,
    outputDirectory: output,
    env: { HEPTA_EXPERIMENT_ATTEMPT_ID: 'real-host-batch-attempt' },
    sourceLineageHash: hashBytes(fs.readFileSync(path.join(root, 'main.tex'))),
    benchmarkSelector: selector,
    }),
  );
  assert.equal(receipt.status, 'empirical_execution_completed', JSON.stringify(receipt.blockers));
  assert.equal(receipt.harnessExecutionReceipt.armBatchExecutionCount, 3);
  assert.equal(receipt.harnessExecutionReceipt.armBatchExecutions.length, 3);
  assert.equal(receipt.harnessExecutionReceipt.scheduleCellCount, 105);
});
