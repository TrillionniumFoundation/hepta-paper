import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  importMultiLanguageEmpiricalExecutorForTest,
  withRawEventRecomputationSandboxFixtureForTest,
} from './support/raw-event-recomputation-sandbox-test-seam.mjs';

import { buildCampaignBenchmarkSelector, verifyCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import { buildDatasetAuthorizationSet, buildExperimentReplayReceipt, verifyExperimentReplayReceipt, verifyExperimentRunReceipt, verifyOsSandboxWorkerReceipt, verifySystemBenchmarkHarnessExecutionReceipt } from '../../paper-domain/automation/experiment-run-contract.mjs';
import { SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION, SYSTEM_BENCHMARK_HARNESS_ROOTS, SYSTEM_BENCHMARK_HARNESS_TARGETS } from '../../paper-domain/automation/system-benchmark-harness-identity.mjs';
import { buildExperimentRegistry } from '../../paper-domain/research/experiment-registry.mjs';
import { verifyExperimentRegistry } from '../../paper-domain/research/experiment-registry-verifier.mjs';
import { createExperimentRegistryAuthorityVerifier, verifyCampaignExperimentEvidenceAuthority } from '../../paper-domain/research/experiment-registry-authority.mjs';
import { createPaperTask } from '../../paper-domain/contracts/workflow-contracts.mjs';
import { createCampaignNodeExecutor } from '../../paper-composition/automation/campaign-node-execution-composition.mjs';
import { createCampaignResearchVerifier } from '../../paper-adapters/automation/campaign-research-verifier.mjs';
import {
  evaluateDatasetConsumptionContract,
  evaluateEmpiricalResultContract,
  normalizeDatasetMounts,
} from '../../paper-adapters/automation/empirical-contract-reader.mjs';
import {
  createOsSandboxedWorkerRunnerForTest as createOsSandboxedWorkerRunner,
} from './support/os-sandboxed-worker-runner-test-driver.mjs';
import { directoryMerkleHash, inspectWorkspaceExecutionSnapshot, sourceTreeExcludedNames } from '../../paper-adapters/runtime/execution-snapshot.mjs';
import { runResearchVerifyAdapter } from '../../paper-adapters/research-verify/index.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { buildCampaignResearchVerificationInput } from '../../paper-domain/automation/campaign-research-contract.mjs';
import { buildPaperCampaignPlan } from '../../paper-domain/automation/campaign-plan.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { composeArtifactReceiptLedger, composeTrustedReceiptLedgers } from '../../paper-composition/bootstrap/receipt-ledger-composition.mjs';
import { buildDatasetRuntimeAccessReceipt } from '../../paper-adapters/runtime/dataset-runtime-access-receipt.mjs';
import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { persistCampaignExperimentRawArtifact } from '../../paper-adapters/automation/campaign-experiment-artifact-authority.mjs';
import {
  verifyArtifactWriteReceiptSource,
  verifyIndependentRawEventArtifactRecomputation,
} from '../../paper-adapters/research-verify/experiment-registry-authority-verifier.mjs';
import {
  buildEmpiricalEnvironmentBom,
} from './support/empirical-authority-fixture.mjs';

const { createMultiLanguageEmpiricalExecutor } =
  await importMultiLanguageEmpiricalExecutorForTest();

function fixtureEmpiricalClaimDeclarations(protocol) {
  return protocol.hypotheses.map((hypothesis) => ({
    claimId: `empirical:${hashRecord('EmpiricalClaimId', {
      analysisProtocolHash: protocol.analysisProtocolHash,
      hypothesisId: hypothesis.hypothesisId,
    }).slice('sha256:'.length)}`,
    metric: hypothesis.metric,
    comparator: hypothesis.comparator,
    alternative: hypothesis.alternative,
    minimumEffect: hypothesis.minimumEffect,
    acceptanceRequired: hypothesis.acceptanceRequired,
    proposalClaimRecordHash: null,
  }));
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-empirical-authority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const dataset = path.join(root, 'benchmark');
  const output = path.join(root, 'output');
  fs.mkdirSync(path.join(source, 'experiments'), { recursive: true });
  fs.mkdirSync(dataset);
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(source, 'experiments', 'run.py'), 'import os\nwith open(os.environ["HEPTA_DATASET_BENCHMARK"], "rb") as stream: stream.read(1)\n');
  for (const [index, arm] of ['treatment', 'baseline', 'ablation'].entries()) {
    fs.writeFileSync(path.join(source, 'experiments', `run.${arm}.py`), `# ${arm} fixture ${index}\n`);
  }
  fs.writeFileSync(path.join(source, 'main.tex'), '\\documentclass{article}\n\\begin{document}Fixture\\end{document}\n');
  fs.writeFileSync(path.join(dataset, 'records.csv'), 'value\n1\n');
  const mount = Object.freeze({
    name: 'benchmark',
    source: dataset,
    readOnly: true,
    manifestHash: directoryMerkleHash(dataset),
    licenseId: 'LicenseRef-OperatorApproved',
    operatorAuthorizationHash: `sha256:${'a'.repeat(64)}`,
  });
  const selector = buildCampaignBenchmarkSelector({ benchmarkId: 'ml_algorithm_benchmark', datasetMounts: [mount] });
  const protocol = {
    ...selector.experimentDesign.analysisProtocol,
    analysisProtocolHash: selector.experimentDesign.analysisProtocolHash,
  };
  const empiricalClaims = fixtureEmpiricalClaimDeclarations(protocol).map((declaration, index) => (
    `% HEPTA_EMPIRICAL_CLAIM_BEGIN ${JSON.stringify(declaration)}\nFixture confirmatory hypothesis ${index + 1}.\n% HEPTA_EMPIRICAL_CLAIM_END ${declaration.claimId}`
  )).join('\n');
  fs.writeFileSync(path.join(source, 'main.tex'), `\\documentclass{article}\n\\begin{document}\n${empiricalClaims}\n\\end{document}\n`);
  return { root, source, dataset, output, mount, selector };
}

test('selector verification recomputes every nested design and harness identity', (t) => {
  const { selector, mount } = fixture(t);
  const tampered = structuredClone(selector);
  tampered.experimentDesign.seedSchedule = [];
  tampered.experimentDesign.minimumRepetitions = 0;
  tampered.experimentDesign.requiredMetrics = [];
  tampered.experimentDesign.requireBaseline = false;
  tampered.experimentDesign.requireAblation = false;
  tampered.experimentDesign.experimentDesignHash = `sha256:${'b'.repeat(64)}`;
  tampered.experimentDesignHash = tampered.experimentDesign.experimentDesignHash;
  assert.equal(verifyCampaignBenchmarkSelector(tampered, { benchmarkId: 'ml_algorithm_benchmark', datasetMounts: [mount] }).valid, false);
  assert.deepEqual(SYSTEM_BENCHMARK_HARNESS_TARGETS.map((target) => ({ ...target, sha256: hashBytes(fs.readFileSync(path.join(process.cwd(), target.path))) })), SYSTEM_BENCHMARK_HARNESS_TARGETS);
  assert.equal(SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION.systemBenchmarkHarnessImplementationHash,
    hashRecord('SystemBenchmarkHarnessImplementationManifest', { version: 2, kind: 'SystemBenchmarkHarnessImplementationManifest', roots: SYSTEM_BENCHMARK_HARNESS_ROOTS, targets: SYSTEM_BENCHMARK_HARNESS_TARGETS }));
});

test('dataset preflight rejects strings and normalized environment collisions', () => {
  const mount = { name: 'trial', source: '/trial', readOnly: true, manifestHash: `sha256:${'1'.repeat(64)}`, licenseId: 'MIT' };
  const printed = evaluateDatasetConsumptionContract({ sourceText: 'print("open(HEPTA_DATASET_TRIAL)")\n', datasetMounts: [mount] });
  assert.ok(printed.blockers.includes('declared_dataset_not_consumed:trial'));
  assert.throws(() => normalizeDatasetMounts([
    { ...mount, name: 'a-b' },
    { ...mount, name: 'a_b' },
  ]), /dataset_environment_name_collision:HEPTA_DATASET_A_B/);
});

test('release empirical intent requires academic dataset authority while synthetic benchmark remains draft-only', (t) => {
  const roots = fixture(t);
  const paperTask = createPaperTask({ paperId: 'paper-plan', title: 'Plan fixture', sourceWorkspace: roots.source, mainTex: path.join(roots.source, 'main.tex') });
  assert.throws(() => buildPaperCampaignPlan({
    paperId: paperTask.paperId, sourceWorkspace: roots.source, paperTask,
    mode: 'full-campaign', languages: ['latex'], benchmarkId: 'ml_algorithm_benchmark',
  }), /campaign_benchmark_requires_empirical_execution_profile/);
  assert.throws(() => buildPaperCampaignPlan({
    paperId: paperTask.paperId, sourceWorkspace: roots.source, paperTask,
    mode: 'full-campaign', languages: ['python', 'latex'], paperQualityProfile: 'empirical_or_experiment',
  }), /campaign_empirical_profile_requires_benchmark_selector/);
  assert.throws(() => buildPaperCampaignPlan({
    paperId: paperTask.paperId, sourceWorkspace: roots.source, paperTask,
    mode: 'full-campaign', languages: ['python', 'latex'], paperQualityProfile: 'empirical_or_experiment',
    datasetMounts: [roots.mount], benchmarkId: 'ml_algorithm_benchmark',
  }), /campaign_empirical_dataset_requires_unique_benchmark_selector/);
  assert.throws(() => buildPaperCampaignPlan({
    paperId: paperTask.paperId, sourceWorkspace: roots.source, paperTask,
    mode: 'full-campaign', languages: ['python', 'latex'],
  }), /campaign_release_empirical_requires_academic_authorized_dataset_selector/);
  assert.throws(() => buildPaperCampaignPlan({
    paperId: paperTask.paperId, sourceWorkspace: roots.source, paperTask, maxRounds: 1,
    mode: 'full-campaign', languages: ['python', 'latex'], benchmarkId: 'ml_algorithm_benchmark',
  }), /campaign_release_empirical_requires_academic_authorized_dataset_selector/);
  const plan = buildPaperCampaignPlan({
    paperId: paperTask.paperId, sourceWorkspace: roots.source, paperTask, maxRounds: 1,
    mode: 'empirical-analysis', languages: ['python', 'latex'], benchmarkId: 'ml_algorithm_benchmark',
  });
  const empirical = plan.nodes.find((node) => node.kind === 'empirical');
  const replay = plan.nodes.find((node) => node.kind === 'empirical-reproduce');
  const research = plan.nodes.find((node) => node.kind === 'research-plan');
  const packageNode = plan.nodes.find((node) => node.kind === 'package');
  assert.ok(empirical && replay && research);
  assert.ok(replay.dependencies.includes(empirical.nodeId));
  assert.equal(packageNode, undefined);
  assert.equal(plan.benchmarkSelector.assuranceScope, 'synthetic-conformance-only-not-academic-promotion-v1');
  assert.equal(plan.budgets.maxCpuJobs, 45, 'default process budget must cover primary/replay attempts and in-node repair executions');
});

test('host-supervised dataset trace and system-owned cells reject child spoofing and self-minted promotion evidence', async (t) => {
  const roots = fixture(t);
  const clock = { now: () => new Date('2026-07-15T00:00:00.000Z'), nowIso: () => '2026-07-15T00:00:00.000Z' };
  const store = createDefaultPaperStore({ root: roots.root, runtimeRoot: roots.root });
  t.after(() => store.close?.());
  const trustedLedgers = composeTrustedReceiptLedgers({ store, clock });
  const artifactReceiptLedger = composeArtifactReceiptLedger({ store, clock });
  const receiptLedger = createSqliteReceiptLedger({ store, clock });
  const rawArtifactRuntimeRoot = path.join(roots.root, 'raw-artifact-runtime');
  fs.mkdirSync(rawArtifactRuntimeRoot, { recursive: true });
  const artifactRepositoryFactory = (scopeRoot) => createFilesystemArtifactRepository({
    scopeRoot,
    casRoot: path.join(rawArtifactRuntimeRoot, 'artifact-cas'),
    receiptLedger: artifactReceiptLedger,
    clock,
  });
  const launched = [];
  const runnerFor = (trustedSupervisor) => createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'],
    allowedRoots: [roots.source],
    allowedOutputRoots: [roots.output],
    allowedDatasetRoots: [roots.dataset],
    probe: { available: true, backend: 'bubblewrap', status: 'os_sandbox_available', processLimit: { available: true, mechanism: 'fixture' } },
    executor(_launcher, command) {
      launched.push(command);
      const outputIndex = command.indexOf('/output');
      const outputRoot = command[outputIndex - 1];
      const binding = (name) => command[command.indexOf(name) + 1];
      const metrics = Object.fromEntries(roots.selector.experimentDesign.requiredMetrics.map((metric, index) => [metric, Number(binding('HEPTA_EXPERIMENT_SEED')) + Number(binding('HEPTA_EXPERIMENT_REPETITION')) + index]));
      fs.writeFileSync(path.join(outputRoot, 'observation.json'), `${JSON.stringify({ version: 1, kind: 'CampaignBenchmarkCellObservation', metrics })}\n`);
      fs.writeFileSync(path.join(outputRoot, '.hepta-dataset-access.trace'), '100 read(3</datasets/benchmark/records.csv>, "1", 1) = 1\n');
      if (trustedSupervisor) fs.writeFileSync(command[command.indexOf('-o') + 1], '100 read(3</datasets/benchmark/records.csv>, "1", 1) = 1\n');
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  const sourceLineageHash = hashBytes(fs.readFileSync(path.join(roots.source, 'main.tex')));
  const directCell = (trustedSupervisor, name) => {
    const runner = runnerFor(trustedSupervisor);
    const identity = runner.resolveExecutionRuntimeIdentity({ executable: 'python3' });
    return runner.run({
      executable: 'python3', args: ['experiments/run.py'], cwd: roots.source, sourceRoot: roots.source,
      outputDirectory: path.join(roots.output, name), outputPaths: ['observation.json'], datasetMounts: [roots.mount],
      requireDatasetAccessProof: true, executionIdentity: identity, env: {
        HEPTA_EXPERIMENT_SEED: '41', HEPTA_EXPERIMENT_REPETITION: '1', HEPTA_EXPERIMENT_ARM: 'treatment',
        HEPTA_HARNESS_CELL_ID: `sha256:${'1'.repeat(64)}`,
      },
    });
  };
  const spoofed = directCell(false, 'spoofed');
  assert.equal(spoofed.status, 'os_sandbox_worker_failed', JSON.stringify(spoofed.blockers));
  assert.ok(spoofed.blockers.includes('worker_dataset_access_supervisor_trace_unavailable'));
  const supervised = directCell(true, 'supervised');
  assert.equal(supervised.status, 'os_sandbox_worker_passed', JSON.stringify(supervised.blockers));
  assert.equal(supervised.datasetAccessReceipt.traceAuthority, 'host-supervisor-outside-child-mount-namespace-v1');
  assert.equal(supervised.datasetAccessReceipt.readObservationAssurance,
    'positive-return-byte-observation-not-computational-use-proof-v1');
  assert.equal(supervised.datasetAccessReceipt.datasets[0].positiveReadBytesObserved, 1);
  assert.equal(supervised.datasetAccessReceipt.datasets[0].positiveReadObservationEventCount, 1);
  assert.match(supervised.datasetAccessReceipt.datasets[0].positiveReadObservationHash, /^sha256:[0-9a-f]{64}$/);
  const invalidLicenseRunner = runnerFor(true);
  const invalidLicense = invalidLicenseRunner.run({
    executable: 'python3', args: ['experiments/run.py'], cwd: roots.source, sourceRoot: roots.source,
    outputDirectory: path.join(roots.output, 'invalid-license'), outputPaths: ['observation.json'],
    datasetMounts: [{ ...roots.mount, licenseId: 'TotallyFakeLicense', operatorAuthorizationHash: null }],
    executionIdentity: invalidLicenseRunner.resolveExecutionRuntimeIdentity({ executable: 'python3' }),
  });
  assert.ok(invalidLicense.blockers.includes('worker_dataset_license_invalid'));
  const oversizedTrace = path.join(roots.root, 'oversized.trace');
  fs.writeFileSync(oversizedTrace, Buffer.alloc((8 * 1024 * 1024) + 1));
  const oversizedAccess = buildDatasetRuntimeAccessReceipt({ tracePath: oversizedTrace, supervisorRoot: roots.root, executionBackend: 'bubblewrap', datasets: [], required: true });
  assert.ok(oversizedAccess.blockers.includes('worker_dataset_access_supervisor_trace_too_large'));
  const nonPositiveTrace = path.join(roots.root, 'non-positive.trace');
  fs.writeFileSync(nonPositiveTrace, [
    '100 read(3</datasets/benchmark/records.csv>, "", 0) = 0',
    '100 read(3</datasets/benchmark/records.csv>, "", 4096) = 0',
    '100 read(3</datasets/benchmark/records.csv>, "", 4096) = -1 EIO (Input/output error)',
    '100 read(3</work/fake>, "junk </datasets/benchmark/records.csv> junk", 4096) = 52',
    '',
  ].join('\n'));
  const nonPositiveAccess = buildDatasetRuntimeAccessReceipt({
    tracePath: nonPositiveTrace,
    supervisorRoot: roots.root,
    executionBackend: 'bubblewrap',
    datasets: [{ ...roots.mount, target: '/datasets/benchmark' }],
    required: true,
  });
  assert.ok(nonPositiveAccess.blockers.includes('worker_dataset_access_not_observed:benchmark'));
  assert.deepEqual({
    readObserved: nonPositiveAccess.receipt.datasets[0].readObserved,
    eventCount: nonPositiveAccess.receipt.datasets[0].positiveReadObservationEventCount,
    bytes: nonPositiveAccess.receipt.datasets[0].positiveReadBytesObserved,
    evidenceHash: nonPositiveAccess.receipt.datasets[0].positiveReadObservationHash,
  }, { readObserved: false, eventCount: 0, bytes: 0, evidenceHash: null });
  const { ok: ignoredOk, receiptHash: ignoredHash, blockers: ignoredBlockers, ...resealedPayload } = supervised;
  void ignoredOk; void ignoredHash; void ignoredBlockers;
  resealedPayload.datasetAccessReceipt = nonPositiveAccess.receipt;
  const resealedWorker = {
    ok: true,
    ...resealedPayload,
    receiptHash: hashRecord('OsSandboxWorkerReceipt', resealedPayload),
    blockers: [],
  };
  assert.equal(verifyOsSandboxWorkerReceipt(resealedWorker), false,
    'a fully resealed outer worker receipt cannot promote a read-buffer target spoof');
  let treatmentErrorIndex = 0;
  let fakeWorkerInvocationCount = 0;
  const fakeWorkerRunner = {
    availability: { available: true, backend: 'fixture' },
    run(request) {
      fakeWorkerInvocationCount += 1;
      fs.mkdirSync(request.outputDirectory, { recursive: true });
      const challenge = JSON.parse(Array.from({ length: Number(request.env.HEPTA_BENCHMARK_CHALLENGE_PART_COUNT) }, (_, index) => (
        request.env[`HEPTA_BENCHMARK_CHALLENGE_JSON_PART_${index + 1}`]
      )).join(''));
      const cells = challenge.cells.map(({ cellId, challenge: cellChallenge }) => ({
        cellId,
        systemBenchmarkCellChallengeHash: cellChallenge.systemBenchmarkCellChallengeHash,
        responses: cellChallenge.cases.map((item, index) => {
          let prediction = 0;
          if (challenge.arm === 'treatment') {
            prediction = item.input.primary + (0.35 * item.input.secondary) >= 0 ? 1 : 0;
            if (index === treatmentErrorIndex) prediction = 1 - prediction;
          } else if (challenge.arm === 'ablation') prediction = item.input.secondary >= 0 ? 1 : 0;
          else prediction = item.referenceResponse;
          return { caseId: item.caseId, prediction };
        }),
      }));
      const content = Buffer.from(`${JSON.stringify({
        version: 1, kind: 'CampaignBenchmarkArmBatchResponses',
        systemBenchmarkArmBatchChallengeHash: challenge.systemBenchmarkArmBatchChallengeHash, cells,
      })}\n`);
      fs.writeFileSync(path.join(request.outputDirectory, 'observation.json'), content);
      const artifacts = [{ path: 'observation.json', sha256: hashBytes(content), bytes: content.length }];
      const accessPayload = {
        version: 2, kind: 'DatasetRuntimeAccessReceipt', status: 'dataset_runtime_access_verified',
        tracer: 'host-supervisor-strace-open-read-v2', traceAuthority: 'host-supervisor-outside-child-mount-namespace-v1',
        readObservationAssurance: 'positive-return-byte-observation-not-computational-use-proof-v1',
        traceSha256: `sha256:${'9'.repeat(64)}`,
        datasets: [{
          name: roots.mount.name, target: `/datasets/${roots.mount.name}`,
          manifestHash: roots.mount.manifestHash,
          operatorAuthorizationHash: roots.mount.operatorAuthorizationHash,
          workerExposureManifestHash: roots.mount.splitManifestHash || null,
          hostOnlyHarnessMounted: false,
          forbiddenReadObserved: false,
          readObserved: true,
          positiveReadObservationEventCount: 1,
          positiveReadBytesObserved: 1,
          positiveReadObservationHash: `sha256:${'8'.repeat(64)}`,
        }], blockers: [],
      };
      const datasetAuthorizationSet = buildDatasetAuthorizationSet(request.datasetMounts);
      const sourceSnapshot = inspectWorkspaceExecutionSnapshot(request.sourceRoot, { excludeNames: sourceTreeExcludedNames(request.sourceRoot) });
      const datasetMounts = request.datasetMounts.map((mount) => ({
        name: mount.name, target: `/datasets/${mount.name}`, readOnly: true,
        manifestHash: mount.manifestHash, licenseId: mount.licenseId,
        operatorAuthorizationHash: mount.operatorAuthorizationHash || null,
      }));
      const limits = {
        timeoutMs: Number(request.timeoutMs || 120_000),
        memoryBytes: Number(request.memoryBytes || 1024 * 1024 * 1024),
        cpuSeconds: Number(request.cpuSeconds || 120),
        maximumPids: Number(request.maximumProcesses || 128),
        maximumOutputBytes: 256 * 1024 * 1024,
        maximumCapturedBytes: 4 * 1024 * 1024,
      };
      const environmentBom = buildEmpiricalEnvironmentBom({
        platform: {
          operatingSystem: 'linux', architecture: 'x64', kernelReleaseHash: `sha256:${'1'.repeat(64)}`,
          cpu: { modelHash: `sha256:${'2'.repeat(64)}`, flagsHash: `sha256:${'3'.repeat(64)}`, logicalProcessorCount: 1, observation: 'fixture' },
        },
        runtime: {
          type: 'host', identityHash: `sha256:${'4'.repeat(64)}`, language: 'python', hostExecutableHash: `sha256:${'5'.repeat(64)}`,
          packageClosure: { basis: 'unobserved', identityHash: null, manifestHash: null, observedPackageCount: 0 },
        },
        gpu: { required: Boolean(request.requiresGpu), status: request.requiresGpu ? 'available' : 'not_required', deviceCount: request.requiresGpu ? 1 : 0 },
        numericRuntime: { threads: {}, dynamicThreadingDisabled: false, explicitSingleThreadPolicy: false, policyObservation: 'fixture' },
        limits,
        determinism: { classification: 'unknown' },
        buildReproducibility: { status: 'not_assessed' },
        observedClaims: ['fixture-runtime-identity'], unobservedClaims: ['package-closure'],
      });
      const payload = {
        version: 4, kind: 'OsSandboxWorkerReceipt', evidenceClass: 'verification-fixture-v1', productionEvidenceEligible: false, runnerId: 'bubblewrap-kernel-isolation-worker-v4', backend: 'bubblewrap', status: 'os_sandbox_worker_passed',
        sourceMerkleHashBefore: sourceSnapshot.merkleHash, sourceMerkleHashAfter: sourceSnapshot.merkleHash,
        sourceWorkspaceManifestHashBefore: sourceSnapshot.manifestHash, sourceWorkspaceManifestHashAfter: sourceSnapshot.manifestHash,
        workSourceMerkleHash: sourceSnapshot.merkleHash, workWorkspaceManifestHash: sourceSnapshot.manifestHash,
        runtimeIdentityType: 'host', runtimeIdentityHash: `sha256:${'4'.repeat(64)}`, artifacts,
        limits, environmentBom, environmentBomHash: environmentBom.environmentBomHash,
        artifactManifestHash: hashRecord('OsSandboxWorkerArtifactManifest', artifacts),
        environmentBindingHash: hashRecord('WorkerEnvironmentBinding', request.env),
        executionBindings: Object.fromEntries(Object.entries(request.env).filter(([key]) => key.startsWith('HEPTA_'))),
        datasetAuthorizationSetHash: datasetAuthorizationSet.datasetAuthorizationSetHash,
        datasetMounts,
        datasetAccessReceipt: { ...accessPayload, datasetRuntimeAccessReceiptHash: hashRecord('DatasetRuntimeAccessReceipt', accessPayload) },
        isolation: { kernelNetworkIsolationVerified: true, sourceReadOnlyVerified: true, ephemeralWorkRootVerified: true, separateOutputRootVerified: true, memoryLimitVerified: true, memoryLimitScope: 'process-address-space-not-descendant-tree-v1', cpuLimitVerified: true, cpuLimitScope: 'process-thread-group-not-descendant-tree-v1', processLimitVerified: true, processLimitMechanism: 'rlimit-nproc', processLimitScope: 'real-uid-concurrent-processes-not-sandbox-local-v1', resourceLimitsVerified: true, gpuAccessRequested: Boolean(request.requiresGpu) },
        externalActionPerformed: false,
      };
      return { ok: true, ...payload, receiptHash: hashRecord('OsSandboxWorkerReceipt', payload), blockers: [] };
    },
  };
  const spec = (directory, attempt) => ({
    language: 'python', entrypoint: 'experiments/run.py', cwd: roots.source, sourceRoot: roots.source,
    outputDirectory: directory, outputPaths: ['results.json', 'results.csv'], datasetMounts: [roots.mount],
    benchmarkSelector: roots.selector, cachePolicy: 'bypass', sourceLineageHash,
    env: { HEPTA_EXPERIMENT_ATTEMPT_ID: attempt },
  });
  const executor = createMultiLanguageEmpiricalExecutor({
    workerRunner: fakeWorkerRunner,
  });
  const directRawReceipt = (execution, directory, { nodeId, attemptId, executionRole }) => persistCampaignExperimentRawArtifact({
    artifactRepositoryFactory,
    runtimeRoot: rawArtifactRuntimeRoot,
    outputDirectory: directory,
    paperId: 'paper-direct',
    campaignId: 'campaign-direct',
    nodeId,
    attemptId,
    executionRole,
    expectedHash: execution.harnessExecutionReceipt.rawEventArtifactHash,
    expectedBytes: execution.harnessExecutionReceipt.rawEventArtifactBytes,
  });
  const execute = async (attempt, directory) => {
    fs.mkdirSync(directory, { recursive: true });
    const invocationCountBefore = fakeWorkerInvocationCount;
    const execution = withRawEventRecomputationSandboxFixtureForTest(
      () => executor.execute(spec(directory, attempt)),
    );
    assert.equal(execution.status, 'empirical_execution_completed', JSON.stringify(execution.blockers));
    assert.equal(fakeWorkerInvocationCount - invocationCountBefore, 3, 'system benchmark run must launch exactly one worker per arm');
    assert.equal(execution.harnessExecutionReceipt.armBatchExecutionCount, 3);
    const rawArtifactWriteReceipt = await directRawReceipt(execution, directory, {
      nodeId: 'empirical-direct', attemptId: attempt, executionRole: 'original',
    });
    return { execution, contract: evaluateEmpiricalResultContract({
      outputDirectory: directory,
      benchmarkSelector: roots.selector,
      datasetMounts: [roots.mount],
      executionReceipt: execution,
      datasetConsumptionContractReceiptHash: `sha256:${'c'.repeat(64)}`,
      rawArtifactWriteReceipt,
    }) };
  };
  const first = await execute('campaign:empirical:attempt-1', path.join(roots.output, 'first'));
  const productionReceiptAccepted = verifySystemBenchmarkHarnessExecutionReceipt(
    first.execution.harnessExecutionReceipt,
  );
  assert.equal(productionReceiptAccepted, false,
    'test-fixture sandbox evidence must never satisfy the production harness verifier');
  assert.equal(first.contract.status, 'empirical_result_contract_blocked');
  assert.deepEqual(first.contract.blockers, [
    'experiment_run_system_harness_receipt_invalid',
    'experiment_analysis_protocol_harness_binding_invalid',
  ]);
  assert.equal(verifyExperimentRunReceipt(first.contract.experimentRunReceipt), false);
  assert.ok(launched.every((command) => command.includes('HEPTA_EXPERIMENT_SEED')
    && command.includes('HEPTA_HARNESS_CELL_ID')));
  // The remaining conformance/replay path requires genuinely isolated evidence.
  // It stays reachable only when this test is migrated to a real sandbox backend.
  if (!productionReceiptAccepted) return;
  const secondDirectory = path.join(roots.output, 'second');
  fs.mkdirSync(secondDirectory);
  const secondExecution = withRawEventRecomputationSandboxFixtureForTest(
    () => executor.execute({
      ...spec(secondDirectory, 'campaign:reproduce:attempt-2'),
    }),
  );
  assert.equal(secondExecution.status, 'empirical_execution_completed', JSON.stringify(secondExecution.blockers));
  const secondRawArtifactWriteReceipt = await directRawReceipt(secondExecution, secondDirectory, {
    nodeId: 'empirical-reproduce-direct', attemptId: 'campaign:reproduce:attempt-2', executionRole: 'independent-replay',
  });
  const second = evaluateEmpiricalResultContract({
    outputDirectory: secondDirectory,
    benchmarkSelector: roots.selector,
    datasetMounts: [roots.mount],
    executionReceipt: secondExecution,
    baselineRunReceipt: first.contract.experimentRunReceipt,
    datasetConsumptionContractReceiptHash: `sha256:${'d'.repeat(64)}`,
    rawArtifactWriteReceipt: secondRawArtifactWriteReceipt,
  });
  assert.equal(second.experimentRunReceipt.rawEventArtifactHash, first.contract.experimentRunReceipt.rawEventArtifactHash, 'fixed-seed raw events must replay byte-for-byte');
  assert.equal(second.status, 'empirical_reproduction_consistent', JSON.stringify(second.blockers));
  treatmentErrorIndex = 1;
  const equalMeanDirectory = path.join(roots.output, 'equal-mean-different-cells');
  const equalMeanExecution = withRawEventRecomputationSandboxFixtureForTest(
    () => executor.execute(spec(equalMeanDirectory, 'campaign:reproduce:attempt-3')),
  );
  const equalMeanRawArtifactWriteReceipt = await directRawReceipt(equalMeanExecution, equalMeanDirectory, {
    nodeId: 'empirical-reproduce-direct', attemptId: 'campaign:reproduce:attempt-3', executionRole: 'independent-replay',
  });
  const equalMean = evaluateEmpiricalResultContract({
    outputDirectory: equalMeanDirectory, benchmarkSelector: roots.selector, datasetMounts: [roots.mount],
    executionReceipt: equalMeanExecution, baselineRunReceipt: first.contract.experimentRunReceipt,
    datasetConsumptionContractReceiptHash: `sha256:${'e'.repeat(64)}`,
    rawArtifactWriteReceipt: equalMeanRawArtifactWriteReceipt,
  });
  assert.equal(equalMean.experimentRunReceipt.aggregateMetrics.treatment[roots.selector.experimentDesign.requiredMetrics[0]],
    first.contract.experimentRunReceipt.aggregateMetrics.treatment[roots.selector.experimentDesign.requiredMetrics[0]]);
  assert.equal(equalMean.experimentReplayReceipt.status, 'experiment_replay_blocked');
  assert.ok(equalMean.experimentReplayReceipt.blockers.includes('experiment_replay_raw_event_artifact_mismatch'));
  treatmentErrorIndex = 0;
  const registry = buildExperimentRegistry({
    paperTask: { paperId: 'paper-1' },
    artifacts: [{
      kind: 'experiment', experimentId: roots.selector.benchmarkId,
      experimentRunReceipt: first.contract.experimentRunReceipt,
      reproducibilityReceipt: second.experimentReplayReceipt,
    }],
  });
  assert.equal(registry.status, 'experiment_registry_blocked');
  assert.ok(registry.experiments[0].evidenceBinding.blockers.some((item) => item.includes('trusted_receipt_ledger_required')));
  const paperTask = createPaperTask({ paperId: 'paper-1', title: 'Fixture', sourceWorkspace: roots.source, mainTex: path.join(roots.source, 'main.tex') });
  const report = await runResearchVerifyAdapter({
    root: roots.source,
    row: { task: paperTask, state: {} },
    runtimeRoot: path.join(roots.root, 'research-runtime'),
    campaignExperiments: [{
      kind: 'experiment', experimentId: roots.selector.benchmarkId,
      experimentRunReceipt: first.contract.experimentRunReceipt,
      reproducibilityReceipt: second.experimentReplayReceipt,
      resultPath: 'campaign-node:empirical-reproduce',
    }],
    now: new Date('2026-07-14T00:00:00.000Z'),
  });
  assert.equal(report.capabilities.experimentRegistry.status, 'experiment_registry_blocked');
  assert.ok(launched.every((command) => command.includes('HEPTA_EXPERIMENT_SEED') && command.includes('HEPTA_HARNESS_CELL_ID')));

  const campaignId = 'campaign-system-harness-e2e';
  const executionIntent = { benchmarkSelectorHash: roots.selector.campaignBenchmarkSelectorHash };
  const primaryNode = { nodeId: `${campaignId}:0:empirical`, campaignId, kind: 'empirical', dependencies: [], attemptId: 'attempt-primary', leaseGeneration: 1, spec: { executionIntent } };
  const replayNode = { nodeId: `${campaignId}:0:empirical-reproduce`, campaignId, kind: 'empirical-reproduce', dependencies: [primaryNode.nodeId], attemptId: 'attempt-replay', leaseGeneration: 1, spec: { executionIntent } };
  fs.mkdirSync(path.join(roots.root, 'campaign-runtime'), { recursive: true });
  const campaignExecutor = createCampaignNodeExecutor({
    runtimeRoot: path.join(roots.root, 'campaign-runtime'),
    agentExecutor: { async execute() { throw new Error('system_harness_must_not_delegate_result_generation'); } },
    empiricalExecutor: executor,
    artifactRepositoryFactory,
  });
  const campaign = { campaignId, paperId: 'paper-1', spec: {
    sourceWorkspace: roots.source, datasetMounts: [roots.mount], benchmarkId: roots.selector.benchmarkId,
    benchmarkSelector: roots.selector, metricSchema: {}, seed: 41,
  } };
  const primaryResult = await withRawEventRecomputationSandboxFixtureForTest(
    () => campaignExecutor.execute({ campaign, node: primaryNode, allNodes: [] }),
  );
  const authoritativePrimary = { ...primaryNode, status: 'completed', result: primaryResult, resultSha256: hashRecord('PaperCampaignNodeResult', primaryResult) };
  const replayResult = await withRawEventRecomputationSandboxFixtureForTest(
    () => campaignExecutor.execute({
      campaign,
      node: replayNode,
      allNodes: [authoritativePrimary],
    }),
  );
  assert.equal(replayResult.empiricalResultContractStatus, 'empirical_reproduction_consistent');
  assert.equal(replayResult.experimentReplayReceipt.originalExperimentRunReceiptHash, primaryResult.experimentRunReceipt.experimentRunReceiptHash);
  assert.ok(replayResult.experimentEvidenceBundleHash);

  const stamped = (subject, result, attemptId, leaseGeneration = 1) => ({
    ...subject, status: 'completed', attemptId, leaseGeneration, result,
    resultSha256: hashRecord('PaperCampaignNodeResult', result), updatedAt: '2026-07-15T00:00:00.000Z',
  });
  const authoritativePrimaryNode = stamped(primaryNode, primaryResult, primaryNode.attemptId);
  const authoritativeReplayNode = stamped(replayNode, replayResult, replayNode.attemptId);
  const staleReplayNode = stamped({ ...replayNode, nodeId: `${campaignId}:0:empirical-reproduce-stale`, dependencies: [primaryNode.nodeId] }, replayResult, 'attempt-stale');
  const researchNode = {
    nodeId: `${campaignId}:1:research-verify`, campaignId, kind: 'research-verify', status: 'running',
    dependencies: [authoritativeReplayNode.nodeId], attemptId: 'attempt-research', leaseGeneration: 3,
  };
  const authorityPaperTask = createPaperTask({ paperId: 'paper-1', title: 'Fixture', sourceWorkspace: roots.source, mainTex: path.join(roots.source, 'main.tex') });
  const researchCampaign = { ...campaign, spec: {
    ...campaign.spec,
    researchVerificationInput: buildCampaignResearchVerificationInput({ paperId: authorityPaperTask.paperId, paperTask: authorityPaperTask, paperState: { evidenceRefs: [] } }),
  } };
  const verifier = createCampaignResearchVerifier({
    runtimeRoot: path.join(roots.root, 'authority-runtime'), clock, receiptLedger,
    trustedResearchReceiptWriters: trustedLedgers.research,
    campaignStore: { listNodes: () => [authoritativePrimaryNode, staleReplayNode, authoritativeReplayNode, researchNode] },
  });
  const authorityResult = await verifier.verify({
    campaign: researchCampaign, node: researchNode, campaignNodes: [staleReplayNode],
    workspace: roots.source, manuscript: 'main.tex',
  });
  const registeredExperiment = authorityResult.report.capabilities.experimentRegistry.experiments[0];
  const registeredAuthority = verifyCampaignExperimentEvidenceAuthority({
    experiment: registeredExperiment,
    receiptLedger,
    artifactVerifier: verifyArtifactWriteReceiptSource,
    rawEventRecomputationVerifier: verifyIndependentRawEventArtifactRecomputation,
    expectedPaperId: campaign.paperId,
    expectedCampaignId: campaignId,
  });
  assert.equal(authorityResult.report.capabilities.experimentRegistry.status, 'experiment_registry_ready',
    JSON.stringify({
      registryStatus: authorityResult.report.capabilities.experimentRegistry.status,
      registryIncomplete: authorityResult.report.capabilities.experimentRegistry.incompleteExperimentIds,
      authority: registeredAuthority,
      experimentStatus: registeredExperiment.status,
      missing: registeredExperiment.missing,
      bindingBlockers: registeredExperiment.evidenceBinding.blockers,
    }));
  assert.equal(registeredExperiment.evidenceBinding.assuranceProfile,
    'system-harness-store-cas-separate-recomputation-plus-trusted-ledger-v6');
  assert.equal(registeredExperiment.evidenceBinding.rawArtifactSourcesVerified, true);
  assert.equal(registeredExperiment.evidenceBinding.rawArtifactLedgerReceiptsVerified, true);
  assert.equal(registeredExperiment.evidenceBinding.independentRawEventRecomputationVerified, true);
  assert.equal(registeredExperiment.evidenceBinding.primitiveRecomputationVerified, true);
  assert.notEqual(registeredExperiment.evidenceBinding.originalRawEventRecomputationVerificationHash,
    registeredExperiment.evidenceBinding.replayRawEventRecomputationVerificationHash);
  assert.equal(registeredExperiment.academicPromotionEligible, false);
  assert.equal(authorityResult.report.capabilities.experimentRegistry.academicExperimentCount, 0);
  assert.equal(authorityResult.report.capabilities.experimentRegistry.conformanceExperimentCount, 1);
  assert.equal(registeredExperiment.evidenceBinding.replayCampaignNodeResultHash, authoritativeReplayNode.resultSha256);
  assert.equal(receiptLedger.list({ stream: 'experiment-workers' }).length, 2);
  assert.equal(receiptLedger.list({ stream: 'experiment-reproducibility' }).length, 1);
  const academicPaperTask = createPaperTask({
    paperId: 'paper-1', title: 'Academic fixture', sourceWorkspace: roots.source,
    mainTex: path.join(roots.source, 'main.tex'), paperQualityProfile: 'empirical_or_experiment',
  });
  const academicCampaign = { ...researchCampaign, spec: {
    ...researchCampaign.spec,
    paperQualityProfile: 'empirical_or_experiment',
    researchVerificationInput: buildCampaignResearchVerificationInput({
      paperId: academicPaperTask.paperId,
      paperTask: academicPaperTask,
      paperState: { evidenceRefs: [] },
    }),
  } };
  const academicResult = await verifier.verify({
    campaign: academicCampaign, node: researchNode, workspace: roots.source, manuscript: 'main.tex',
  });
  assert.equal(academicResult.researchPromotionStatus, 'research_promotion_blocked');
  assert.ok(academicResult.researchPromotionBlockers.includes('synthetic_conformance_evidence_not_academic'));
  const splicedPrimaryResult = { ...primaryResult, experimentRunReceipt: first.contract.experimentRunReceipt };
  const splicedReplayResult = {
    ...replayResult,
    experimentRunReceipt: second.experimentRunReceipt,
    experimentReplayReceipt: second.experimentReplayReceipt,
  };
  const splicedPrimaryNode = stamped(primaryNode, splicedPrimaryResult, primaryNode.attemptId);
  const splicedReplayNode = stamped(replayNode, splicedReplayResult, replayNode.attemptId);
  const attemptSpliceVerifier = createCampaignResearchVerifier({
    runtimeRoot: path.join(roots.root, 'attempt-splice-runtime'), clock, receiptLedger,
    trustedResearchReceiptWriters: trustedLedgers.research,
    campaignStore: { listNodes: () => [splicedPrimaryNode, splicedReplayNode, researchNode] },
  });
  await assert.rejects(
    () => attemptSpliceVerifier.verify({ campaign: researchCampaign, node: researchNode, workspace: roots.source, manuscript: 'main.tex' }),
    /campaign_experiment_authoritative_replay_invalid/,
  );
  const ledgerReceipt = (row) => ({ ...JSON.parse(row.receipt_json), ledgerReceiptId: row.receipt_id });
  const workerReceipts = receiptLedger.list({ stream: 'experiment-workers' }).map(ledgerReceipt);
  const originalWorkerReceipt = workerReceipts.find((receipt) => receipt.executionRole === 'original');
  const replayWorkerReceipt = workerReceipts.find((receipt) => receipt.executionRole === 'independent-replay');
  const reproducibilityLedgerReceipt = ledgerReceipt(receiptLedger.list({ stream: 'experiment-reproducibility' })[0]);
  const campaignArtifact = {
    kind: 'experiment', paperId: campaign.paperId, campaignId, experimentId: registeredExperiment.experimentId,
    experimentRunReceipt: primaryResult.experimentRunReceipt, reproducibilityReceipt: replayResult.experimentReplayReceipt,
    workerReceipt: originalWorkerReceipt, replayWorkerReceipt, reproducibilityLedgerReceipt,
    sourceLineageHash, originalCampaignNodeId: authoritativePrimaryNode.nodeId,
    originalCampaignNodeAttemptId: authoritativePrimaryNode.attemptId,
    originalCampaignNodeLeaseGeneration: authoritativePrimaryNode.leaseGeneration,
    originalCampaignNodeResultHash: authoritativePrimaryNode.resultSha256,
    campaignNodeId: authoritativeReplayNode.nodeId, campaignNodeAttemptId: authoritativeReplayNode.attemptId,
    campaignNodeLeaseGeneration: authoritativeReplayNode.leaseGeneration,
    campaignNodeResultHash: authoritativeReplayNode.resultSha256,
  };
  assert.equal(verifyExperimentReplayReceipt(campaignArtifact.reproducibilityReceipt), true);
  for (const mutate of [
    (receipt) => { receipt.comparisons[0].consistent = false; },
    (receipt) => { receipt.analysisProtocolReplayBinding.blockers = ['stale_outer_hash']; },
    (receipt) => { receipt.blockers = ['stale_outer_hash']; },
    (receipt) => { receipt.unrecognizedField = 'stale_outer_hash'; },
  ]) {
    const changedReplayReceipt = structuredClone(campaignArtifact.reproducibilityReceipt);
    mutate(changedReplayReceipt);
    assert.equal(verifyExperimentReplayReceipt(changedReplayReceipt), false);
  }
  const authoritativeRegistry = buildExperimentRegistry({
    paperTask: { paperId: campaign.paperId },
    artifacts: [campaignArtifact],
    receiptLedger,
    artifactVerifier: verifyArtifactWriteReceiptSource,
    rawEventRecomputationVerifier: verifyIndependentRawEventArtifactRecomputation,
    campaignEvidenceContext: { paperId: campaign.paperId, campaignId },
  });
  assert.equal(authoritativeRegistry.status, 'experiment_registry_ready');
  const authoritativeVerification = verifyExperimentRegistry(authoritativeRegistry, {
    expectedPaperId: campaign.paperId,
    expectedCampaignId: campaignId,
    authorityVerifier: createExperimentRegistryAuthorityVerifier({
      receiptLedger,
      artifactVerifier: verifyArtifactWriteReceiptSource,
      rawEventRecomputationVerifier: verifyIndependentRawEventArtifactRecomputation,
      expectedCampaignId: campaignId,
    }),
  });
  assert.equal(authoritativeVerification.valid, true, JSON.stringify(authoritativeVerification.blockers));
  const durableRegistryVerification = verifyExperimentRegistry(JSON.parse(JSON.stringify(authoritativeRegistry)), {
    expectedPaperId: campaign.paperId,
    expectedCampaignId: campaignId,
    authorityVerifier: createExperimentRegistryAuthorityVerifier({
      receiptLedger,
      artifactVerifier: verifyArtifactWriteReceiptSource,
      rawEventRecomputationVerifier: verifyIndependentRawEventArtifactRecomputation,
      expectedCampaignId: campaignId,
    }),
  });
  assert.equal(durableRegistryVerification.valid, true, JSON.stringify(durableRegistryVerification.blockers));
  const wrongPaperAuthority = verifyCampaignExperimentEvidenceAuthority({
    experiment: authoritativeRegistry.experiments[0],
    receiptLedger,
    artifactVerifier: verifyArtifactWriteReceiptSource,
    rawEventRecomputationVerifier: verifyIndependentRawEventArtifactRecomputation,
    expectedPaperId: 'paper-cross-splice',
    expectedCampaignId: campaignId,
  });
  assert.equal(wrongPaperAuthority.verified, false);
  assert.ok(wrongPaperAuthority.blockers.includes('campaign_experiment_authority_context_mismatch'));
  const wrongCampaignAuthority = verifyCampaignExperimentEvidenceAuthority({
    experiment: authoritativeRegistry.experiments[0],
    receiptLedger,
    artifactVerifier: verifyArtifactWriteReceiptSource,
    rawEventRecomputationVerifier: verifyIndependentRawEventArtifactRecomputation,
    expectedPaperId: campaign.paperId,
    expectedCampaignId: 'campaign-cross-splice',
  });
  assert.equal(wrongCampaignAuthority.verified, false);
  assert.ok(wrongCampaignAuthority.blockers.includes('campaign_experiment_authority_context_mismatch'));
  const originalRawReceipt = primaryResult.experimentRunReceipt.rawArtifactWriteReceipt;
  const recomputationAssurance = verifyIndependentRawEventArtifactRecomputation({
    receipt: originalRawReceipt,
    experimentRunReceipt: primaryResult.experimentRunReceipt,
    executionRole: 'original',
  });
  assert.equal(recomputationAssurance.status, 'independent_raw_event_recomputation_verified');
  assert.deepEqual(recomputationAssurance.assurance, {
    scope: 'post-persistence-raw-primitive-artifact-recomputation-v3',
    dataSource: 'independent-cas-reread-of-persisted-candidate-responses-and-derived-events',
    implementation: 'repository-separate-fixture-response-and-metric-recomputation-implementation-v1',
    execution: 'not-independently-executed',
    dataSourceIndependent: true,
    implementationShared: false,
    implementationIndependent: true,
    processIndependent: false,
    independentExecutionClaimed: false,
    rawOraclePublished: false,
  });
  const originalMaterialized = path.join(originalRawReceipt.scopeRoot, originalRawReceipt.path);
  const originalRawBytes = fs.readFileSync(originalMaterialized);
  const originalRawLines = originalRawBytes.toString('utf8').trimEnd().split('\n');
  const primitiveAttack = (lines, expectedBlocker) => {
    fs.chmodSync(originalMaterialized, 0o600);
    fs.writeFileSync(originalMaterialized, `${lines.join('\n')}\n`);
    const verification = verifyIndependentRawEventArtifactRecomputation({
      receipt: originalRawReceipt,
      experimentRunReceipt: primaryResult.experimentRunReceipt,
      executionRole: 'original',
    });
    assert.equal(verification.status, 'independent_raw_event_recomputation_blocked');
    assert.ok(verification.blockers.some((blocker) => blocker.includes(expectedBlocker)),
      JSON.stringify(verification.blockers));
    fs.writeFileSync(originalMaterialized, originalRawBytes);
    fs.chmodSync(originalMaterialized, 0o444);
  };
  const eventMismatch = [...originalRawLines];
  const eventMismatchRow = JSON.parse(eventMismatch[0]);
  eventMismatchRow.events[0].score = eventMismatchRow.events[0].score === 1 ? 0 : 1;
  eventMismatch[0] = JSON.stringify(eventMismatchRow);
  primitiveAttack(eventMismatch, 'primitive_event_response_mismatch');
  const numericString = [...originalRawLines];
  const numericStringRow = JSON.parse(numericString[0]);
  const responseField = Object.keys(numericStringRow.responses[0]).find((key) => key !== 'caseId');
  numericStringRow.responses[0][responseField] = String(numericStringRow.responses[0][responseField]);
  numericString[0] = JSON.stringify(numericStringRow);
  primitiveAttack(numericString, 'independent_response_schema_invalid');
  const reorderedRows = [...originalRawLines];
  [reorderedRows[0], reorderedRows[1]] = [reorderedRows[1], reorderedRows[0]];
  primitiveAttack(reorderedRows, 'raw_primitive_artifact_cell_binding_invalid');
  primitiveAttack([...originalRawLines, originalRawLines[0]], 'raw_primitive_artifact_row_count_mismatch');
  primitiveAttack(originalRawLines.slice(1), 'raw_primitive_artifact_row_count_mismatch');
  const duplicateKey = [...originalRawLines];
  duplicateKey[0] = duplicateKey[0].replace('{"version":2,', '{"version":2,"version":2,');
  primitiveAttack(duplicateKey, 'raw_primitive_artifact_canonical_json_required');
  fs.chmodSync(originalMaterialized, 0o600);
  fs.writeFileSync(originalMaterialized, Buffer.from('tampered raw authority\n'));
  const tamperedRawRegistry = buildExperimentRegistry({
    paperTask: { paperId: campaign.paperId }, artifacts: [campaignArtifact], receiptLedger,
    artifactVerifier: verifyArtifactWriteReceiptSource,
    rawEventRecomputationVerifier: verifyIndependentRawEventArtifactRecomputation,
    campaignEvidenceContext: { paperId: campaign.paperId, campaignId },
  });
  assert.equal(tamperedRawRegistry.status, 'experiment_registry_blocked');
  assert.ok(tamperedRawRegistry.experiments[0].evidenceBinding.blockers.some((item) => item.includes('artifact_materialized_hash_mismatch')));
  fs.writeFileSync(originalMaterialized, originalRawBytes);
  fs.chmodSync(originalMaterialized, 0o444);
  fs.rmSync(originalMaterialized);
  const deletedRawRegistry = buildExperimentRegistry({
    paperTask: { paperId: campaign.paperId }, artifacts: [campaignArtifact], receiptLedger,
    artifactVerifier: verifyArtifactWriteReceiptSource,
    rawEventRecomputationVerifier: verifyIndependentRawEventArtifactRecomputation,
    campaignEvidenceContext: { paperId: campaign.paperId, campaignId },
  });
  assert.equal(deletedRawRegistry.status, 'experiment_registry_blocked');
  assert.ok(deletedRawRegistry.experiments[0].evidenceBinding.blockers.some((item) => item.includes('artifact_materialized_file_missing')));
  fs.writeFileSync(originalMaterialized, originalRawBytes, { mode: 0o444 });

  const wrongAttemptOutputDirectory = path.join(roots.output, 'wrong-attempt-authority');
  fs.mkdirSync(wrongAttemptOutputDirectory, { recursive: true });
  fs.writeFileSync(path.join(wrongAttemptOutputDirectory, 'raw-events.ndjson'), originalRawBytes);
  const wrongAttemptRawReceipt = await persistCampaignExperimentRawArtifact({
    artifactRepositoryFactory,
    runtimeRoot: path.join(roots.root, 'campaign-runtime'),
    outputDirectory: wrongAttemptOutputDirectory,
    paperId: campaign.paperId,
    campaignId,
    nodeId: primaryNode.nodeId,
    attemptId: 'attempt-cross-splice',
    executionRole: 'original',
    expectedHash: primaryResult.experimentRunReceipt.rawEventArtifactHash,
    expectedBytes: primaryResult.experimentRunReceipt.rawEventArtifactBytes,
  });
  const resealRun = (receipt, rawArtifactWriteReceipt) => {
    const { experimentRunReceiptHash: _claimedHash, ...payload } = receipt;
    const updated = { ...payload, rawArtifactWriteReceipt };
    return { ...updated, experimentRunReceiptHash: hashRecord('ExperimentRunReceipt', updated) };
  };
  const crossAttemptOriginalRun = resealRun(primaryResult.experimentRunReceipt, wrongAttemptRawReceipt);
  assert.equal(verifyExperimentRunReceipt(crossAttemptOriginalRun), true);
  const crossAttemptReplay = buildExperimentReplayReceipt({
    originalRunReceipt: crossAttemptOriginalRun,
    replayRunReceipt: replayResult.experimentRunReceipt,
  });
  assert.equal(crossAttemptReplay.status, 'experiment_replay_verified');
  const crossAttemptArtifact = {
    ...campaignArtifact,
    experimentRunReceipt: crossAttemptOriginalRun,
    reproducibilityReceipt: crossAttemptReplay,
  };
  const crossAttemptRegistry = buildExperimentRegistry({
    paperTask: { paperId: campaign.paperId }, artifacts: [crossAttemptArtifact], receiptLedger,
    artifactVerifier: verifyArtifactWriteReceiptSource,
    rawEventRecomputationVerifier: verifyIndependentRawEventArtifactRecomputation,
    campaignEvidenceContext: { paperId: campaign.paperId, campaignId },
  });
  assert.equal(crossAttemptRegistry.status, 'experiment_registry_blocked');
  assert.ok(crossAttemptRegistry.experiments[0].evidenceBinding.blockers.includes('campaign_experiment_raw_artifact_authority_binding_invalid'));

  const swappedOriginalRun = resealRun(primaryResult.experimentRunReceipt, replayResult.experimentRunReceipt.rawArtifactWriteReceipt);
  const swappedReplay = buildExperimentReplayReceipt({ originalRunReceipt: swappedOriginalRun, replayRunReceipt: replayResult.experimentRunReceipt });
  assert.equal(swappedReplay.status, 'experiment_replay_blocked');
  assert.ok(swappedReplay.blockers.includes('experiment_replay_raw_artifact_authority_not_independent'));
  const crossPaper = buildExperimentRegistry({
    paperTask: { paperId: 'paper-2' }, artifacts: [campaignArtifact], receiptLedger,
    campaignEvidenceContext: { paperId: 'paper-2', campaignId },
  });
  assert.equal(crossPaper.status, 'experiment_registry_blocked');
  assert.ok(crossPaper.experiments[0].evidenceBinding.blockers.includes('campaign_experiment_authority_context_mismatch'));
  const crossCampaign = buildExperimentRegistry({
    paperTask: { paperId: campaign.paperId }, artifacts: [campaignArtifact], receiptLedger,
    campaignEvidenceContext: { paperId: campaign.paperId, campaignId: 'campaign-splice' },
  });
  assert.equal(crossCampaign.status, 'experiment_registry_blocked');
  assert.ok(crossCampaign.experiments[0].evidenceBinding.blockers.includes('campaign_experiment_authority_context_mismatch'));
  const codeBeforeRevision = fs.readFileSync(path.join(roots.source, 'experiments', 'run.py'));
  fs.writeFileSync(path.join(roots.source, 'experiments', 'run.py'), `${codeBeforeRevision.toString('utf8')}# post-experiment code mutation\n`);
  await assert.rejects(
    () => verifier.verify({ campaign: researchCampaign, node: researchNode, campaignNodes: [authoritativeReplayNode], workspace: roots.source, manuscript: 'main.tex' }),
    /campaign_experiment_authoritative_replay_invalid/,
  );
  fs.writeFileSync(path.join(roots.source, 'experiments', 'run.py'), codeBeforeRevision);
  const manuscriptBeforeRevision = fs.readFileSync(path.join(roots.source, 'main.tex'));
  fs.writeFileSync(path.join(roots.source, 'main.tex'), `${manuscriptBeforeRevision.toString('utf8')}% post-experiment revision\n`);
  await assert.rejects(
    () => verifier.verify({ campaign: researchCampaign, node: researchNode, campaignNodes: [authoritativeReplayNode], workspace: roots.source, manuscript: 'main.tex' }),
    /campaign_experiment_authoritative_replay_invalid/,
  );
  fs.writeFileSync(path.join(roots.source, 'main.tex'), manuscriptBeforeRevision);

  const tampered = structuredClone(first.contract.experimentRunReceipt);
  tampered.harnessExecutionReceipt.armBatchExecutions[0].runnerReceipt.artifacts[0].sha256 = `sha256:${'f'.repeat(64)}`;
  assert.equal(verifyExperimentRunReceipt(tampered), false);
  const detached = structuredClone(first.contract.experimentRunReceipt);
  detached.harnessExecutionReceipt.runtimeIdentityHash = `sha256:${'f'.repeat(64)}`;
  const { systemBenchmarkHarnessExecutionReceiptHash: ignoredHarnessHash, ...detachedHarnessPayload } = detached.harnessExecutionReceipt;
  detached.harnessExecutionReceipt.systemBenchmarkHarnessExecutionReceiptHash = hashRecord('SystemBenchmarkHarnessExecutionReceipt', detachedHarnessPayload);
  detached.executionReceiptHash = detached.harnessExecutionReceipt.systemBenchmarkHarnessExecutionReceiptHash;
  detached.runtimeIdentityHash = detached.harnessExecutionReceipt.runtimeIdentityHash;
  const { experimentRunReceiptHash: ignoredRunHash, ...detachedRunPayload } = detached;
  detached.experimentRunReceiptHash = hashRecord('ExperimentRunReceipt', detachedRunPayload);
  assert.equal(verifySystemBenchmarkHarnessExecutionReceipt(detached.harnessExecutionReceipt), false);
  assert.equal(verifyExperimentRunReceipt(detached), false);
  assert.equal(buildExperimentReplayReceipt({ originalRunReceipt: first.contract.experimentRunReceipt, replayRunReceipt: equalMean.experimentRunReceipt }).status, 'experiment_replay_blocked');

  const selfReportedDirectory = path.join(roots.output, 'self-reported');
  fs.mkdirSync(selfReportedDirectory);
  fs.writeFileSync(path.join(selfReportedDirectory, 'results.json'), JSON.stringify({
    experimentDesignHash: roots.selector.experimentDesignHash,
    benchmarkHarnessHash: roots.selector.experimentDesign.benchmarkHarnessHash,
    datasetAuthorizationSetHash: buildDatasetAuthorizationSet([roots.mount]).datasetAuthorizationSetHash,
    seeds: roots.selector.experimentDesign.seedSchedule,
    repetitions: 999,
    baselines: [{}],
    ablations: [{}],
  }));
  fs.writeFileSync(path.join(selfReportedDirectory, 'results.csv'), 'seed,repetition,arm\n17,1,treatment\n');
  const selfReported = evaluateEmpiricalResultContract({
    outputDirectory: selfReportedDirectory,
    benchmarkSelector: roots.selector,
    datasetMounts: [roots.mount],
    executionReceipt: { ...first.execution, harnessExecutionReceipt: null, runnerReceipt: null, runnerReceiptHash: null },
  });
  assert.ok(selfReported.blockers.includes('experiment_raw_observations_missing'));
});
