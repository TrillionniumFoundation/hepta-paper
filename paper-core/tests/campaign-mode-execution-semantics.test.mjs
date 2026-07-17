import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCampaignNodeExecutor } from '../../paper-composition/automation/campaign-node-execution-composition.mjs';
import { createCampaignResearchVerifier } from '../../paper-adapters/automation/campaign-research-verifier.mjs';
import { createMultiLanguageEmpiricalExecutor } from '../../paper-adapters/automation/multi-language-empirical-executor.mjs';
import { executeSystemBenchmarkHarness } from '../../paper-adapters/automation/system-benchmark-harness.mjs';
import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { composeArtifactReceiptLedger } from '../../paper-composition/bootstrap/receipt-ledger-composition.mjs';
import { buildBatchCampaignCommand } from '../../paper-application/automation/batch-campaign-command.mjs';
import { createPaperTask } from '../../paper-domain/contracts/workflow-contracts.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { buildDatasetAuthorizationSet } from '../../paper-domain/automation/experiment-run-contract.mjs';
import { systemBenchmarkArmBatchChallengeEnvironment } from '../../paper-domain/automation/system-benchmark-challenge.mjs';
import { buildEmpiricalEnvironmentBom } from '../../paper-domain/automation/environment-bom-contract.mjs';
import { empiricalClaimDeclarationsFromAnalysisProtocol } from '../../paper-domain/automation/analysis-protocol-contract.mjs';

function fixture(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'paper');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'main.tex'), '\\documentclass{article}\n\\begin{document}Fixture\\end{document}\n');
  const paperTask = createPaperTask({
    paperId: 'paper-1',
    title: 'Fixture paper',
    venueTarget: 'Fixture Journal',
    sourceWorkspace: workspace,
    mainTex: path.join(workspace, 'main.tex'),
  });
  const targetScopeReceipt = Object.freeze({
    status: 'target_scope_verified',
    requestedPaperIds: Object.freeze(['paper-1']),
    selectedPaperIds: Object.freeze(['paper-1']),
    inventorySource: 'fixture',
    inventoryFallback: null,
  });
  return { root, workspace, runtimeRoot, paperTask, targetScopeReceipt };
}

function campaignFor(command) {
  return Object.freeze({
    campaignId: command.campaignId,
    paperId: command.paperId,
    spec: command.campaignPlan,
  });
}

function fixtureRunnerReceipt({ spec, outputDirectory, requiredMetrics, datasetMounts = [], resourceBudget = null }) {
  void requiredMetrics;
  const challenge = JSON.parse(Array.from({ length: Number(spec.env.HEPTA_BENCHMARK_CHALLENGE_PART_COUNT) }, (_, index) => (
    spec.env[`HEPTA_BENCHMARK_CHALLENGE_JSON_PART_${index + 1}`]
  )).join(''));
  const cells = challenge.cells.map(({ cellId, challenge: cellChallenge }) => ({
    cellId,
    systemBenchmarkCellChallengeHash: cellChallenge.systemBenchmarkCellChallengeHash,
    responses: cellChallenge.cases.map((item) => {
      let prediction = 0;
      if (challenge.arm === 'treatment') prediction = item.input.primary + (0.35 * item.input.secondary) >= 0 ? 1 : 0;
      else if (challenge.arm === 'ablation') prediction = item.input.secondary >= 0 ? 1 : 0;
      else prediction = item.referenceResponse;
      return { caseId: item.caseId, [cellChallenge.responseField]: prediction };
    }),
  }));
  const observation = `${JSON.stringify({
    version: 1, kind: 'CampaignBenchmarkArmBatchResponses',
    systemBenchmarkArmBatchChallengeHash: challenge.systemBenchmarkArmBatchChallengeHash, cells,
  })}\n`;
  fs.writeFileSync(path.join(outputDirectory, 'observation.json'), observation);
  const artifacts = [{ path: 'observation.json', sha256: hashBytes(observation), bytes: Buffer.byteLength(observation) }];
  const datasetAccessPayload = datasetMounts.length ? {
    version: 2,
    kind: 'DatasetRuntimeAccessReceipt',
    status: 'dataset_runtime_access_verified',
    tracer: 'host-supervisor-strace-open-read-v2',
    traceAuthority: 'host-supervisor-outside-child-mount-namespace-v1',
    readObservationAssurance: 'positive-return-byte-observation-not-computational-use-proof-v1',
    traceSha256: `sha256:${'5'.repeat(64)}`,
    datasets: datasetMounts.map((mount) => ({
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
      positiveReadObservationHash: `sha256:${'6'.repeat(64)}`,
    })),
    blockers: [],
  } : null;
  const sourceMerkleHash = spec.expectedSourceMerkleHash || `sha256:${'1'.repeat(64)}`;
  const sourceWorkspaceManifestHash = spec.expectedSourceWorkspaceManifestHash || `sha256:${'2'.repeat(64)}`;
  const datasetAuthorizationSet = buildDatasetAuthorizationSet(datasetMounts);
  const receiptDatasetMounts = datasetMounts.map((mount) => ({ ...mount, target: `/datasets/${mount.name}` }));
  const limits = {
    timeoutMs: Number(resourceBudget?.timeoutMs ?? 120_000),
    memoryBytes: Number(resourceBudget?.memoryBytes ?? 1024 * 1024 * 1024),
    cpuSeconds: Number(resourceBudget?.cpuSeconds ?? 120),
    maximumPids: Number(resourceBudget?.maximumProcesses ?? 128),
    maximumOutputBytes: 256 * 1024 * 1024,
    maximumCapturedBytes: 4 * 1024 * 1024,
  };
  const environmentBom = buildEmpiricalEnvironmentBom({
    platform: {
      operatingSystem: 'linux', architecture: 'x64', kernelReleaseHash: `sha256:${'7'.repeat(64)}`,
      cpu: { modelHash: `sha256:${'8'.repeat(64)}`, flagsHash: `sha256:${'9'.repeat(64)}`, logicalProcessorCount: 1, observation: 'fixture' },
    },
    runtime: {
      type: 'host', identityHash: `sha256:${'4'.repeat(64)}`, language: 'python', hostExecutableHash: `sha256:${'a'.repeat(64)}`,
      packageClosure: { basis: 'unobserved', identityHash: null, manifestHash: null, observedPackageCount: 0 },
    },
    gpu: { required: false, status: 'not_required', deviceCount: 0 },
    numericRuntime: { threads: {}, dynamicThreadingDisabled: false, explicitSingleThreadPolicy: false, policyObservation: 'fixture' },
    limits, determinism: { classification: 'unknown' }, buildReproducibility: { status: 'not_assessed' },
    observedClaims: ['fixture-runtime-identity'], unobservedClaims: ['package-closure'],
  });
  const payload = {
    version: 4,
    kind: 'OsSandboxWorkerReceipt',
    runnerId: 'fixture-kernel-isolation-worker-v4',
    status: 'os_sandbox_worker_passed',
    sourceMerkleHashBefore: sourceMerkleHash,
    sourceMerkleHashAfter: sourceMerkleHash,
    sourceWorkspaceManifestHashBefore: sourceWorkspaceManifestHash,
    sourceWorkspaceManifestHashAfter: sourceWorkspaceManifestHash,
    workSourceMerkleHash: sourceMerkleHash,
    workWorkspaceManifestHash: sourceWorkspaceManifestHash,
    limits, runtimeIdentityType: 'host', runtimeIdentityHash: `sha256:${'4'.repeat(64)}`,
    environmentBom, environmentBomHash: environmentBom.environmentBomHash,
    environmentBindingHash: hashRecord('WorkerEnvironmentBinding', spec.env),
    executionBindings: spec.env,
    datasetAuthorizationSetHash: datasetAuthorizationSet.datasetAuthorizationSetHash,
    artifacts,
    artifactManifestHash: hashRecord('OsSandboxWorkerArtifactManifest', artifacts),
    datasetMounts: receiptDatasetMounts,
    datasetAccessReceipt: datasetAccessPayload
      ? { ...datasetAccessPayload, datasetRuntimeAccessReceiptHash: hashRecord('DatasetRuntimeAccessReceipt', datasetAccessPayload) }
      : null,
    isolation: {
      kernelNetworkIsolationVerified: true,
      sourceReadOnlyVerified: true,
      ephemeralWorkRootVerified: true,
      separateOutputRootVerified: true,
      gpuAccessRequested: Boolean(resourceBudget?.requiresGpu),
    },
  };
  return Object.freeze({ ok: true, ...payload, receiptHash: hashRecord('OsSandboxWorkerReceipt', payload), blockers: [] });
}

function fixtureHarnessExecution(spec, selector, datasetMounts = []) {
  const adapterPayload = {
    version: 1,
    kind: 'SystemBenchmarkArmAdapterSet',
    entrypointConvention: 'sibling-arm-entrypoints-v1',
    adapters: selector.experimentDesign.benchmarkHarness.armProtocolSet.protocols.map((protocol, index) => ({
      version: 1, kind: 'SystemBenchmarkArmAdapterIdentity', arm: protocol.arm,
      relativePath: `experiments/run.${protocol.arm}.py`, sourceHash: `sha256:${String(index + 1).repeat(64)}`,
      systemBenchmarkArmProtocolHash: protocol.systemBenchmarkArmProtocolHash,
      sourceReadReceiptHash: `sha256:${String(index + 4).repeat(64)}`,
    })),
  };
  const armAdapterSet = { ...adapterPayload, systemBenchmarkArmAdapterSetHash: hashRecord('SystemBenchmarkArmAdapterSet', adapterPayload) };
  const harnessExecutionReceipt = executeSystemBenchmarkHarness({
    benchmarkSelector: selector,
    datasetMounts,
    experimentAttemptId: spec.env.HEPTA_EXPERIMENT_ATTEMPT_ID,
    sourceLineageHash: spec.sourceLineageHash,
    sourceMerkleHash: `sha256:${'1'.repeat(64)}`,
    sourceWorkspaceManifestHash: `sha256:${'2'.repeat(64)}`,
    outputDirectory: spec.outputDirectory,
    armAdapterSet,
    runArmBatch({ outputDirectory, batch }) {
      return fixtureRunnerReceipt({
        spec: {
          expectedSourceMerkleHash: `sha256:${'1'.repeat(64)}`,
          expectedSourceWorkspaceManifestHash: `sha256:${'2'.repeat(64)}`,
          env: {
            ...spec.env,
            HEPTA_EXPERIMENT_RUN_ID: spec.env.HEPTA_EXPERIMENT_ATTEMPT_ID,
            HEPTA_EXPERIMENT_ATTEMPT_ID: `${spec.env.HEPTA_EXPERIMENT_ATTEMPT_ID}:arm:${batch.arm}`,
            HEPTA_EXPERIMENT_ARM: batch.arm,
            HEPTA_EXPERIMENT_ARM_PROTOCOL_ID: batch.armProtocol.protocolId,
            HEPTA_EXPERIMENT_ARM_PROTOCOL_HASH: batch.systemBenchmarkArmProtocolHash,
            HEPTA_EXPERIMENT_ARM_PROTOCOL_SET_HASH: selector.experimentDesign.benchmarkHarness.systemBenchmarkArmProtocolSetHash,
            HEPTA_EXPERIMENT_ARM_ADAPTER_PATH: batch.armAdapter.relativePath,
            HEPTA_EXPERIMENT_ARM_ADAPTER_HASH: batch.armAdapter.sourceHash,
            HEPTA_EXPERIMENT_ARM_ADAPTER_SET_HASH: batch.armAdapterSetHash,
            HEPTA_PRE_DATA_ACCESS_FREEZE_HASH: batch.empiricalPreDataAccessFreezeHash,
            ...systemBenchmarkArmBatchChallengeEnvironment(batch.challenge),
          },
        },
        outputDirectory,
        requiredMetrics: selector.experimentDesign.requiredMetrics,
        datasetMounts,
        resourceBudget: batch.resourceBudget,
      });
    },
  });
  return Object.freeze({
    status: 'empirical_execution_completed',
    runnerReceiptHash: harnessExecutionReceipt.systemBenchmarkHarnessExecutionReceiptHash,
    harnessExecutionReceipt,
    runtimeIdentityHash: harnessExecutionReceipt.runtimeIdentityHash,
    sourceMerkleHash: harnessExecutionReceipt.sourceMerkleHash,
    sourceWorkspaceManifestHash: harnessExecutionReceipt.sourceWorkspaceManifestHash,
    sourceLineageHash: harnessExecutionReceipt.sourceLineageHash,
    artifacts: harnessExecutionReceipt.artifacts,
    cacheHit: false,
    blockers: [],
  });
}

test('research-verify command executes the active evidence and contract verifier, never a planning agent', async (t) => {
  const roots = fixture(t, 'hepta-campaign-research-mode-');
  fs.writeFileSync(path.join(roots.workspace, 'claim-evidence-result.json'), `${JSON.stringify({
    claims: [{ id: 'claim:fixture', text: 'Fixture claim' }],
    proof_obligations: [{ id: 'proof:fixture', text: 'Check fixture claim' }],
    evidence: [{ id: 'evidence:fixture', path: 'claim-evidence-result.json', claim_ids: ['claim:fixture'] }],
    reproducibility: [{ id: 'repro:fixture', text: 'seed:17' }],
  })}\n`);
  const command = buildBatchCampaignCommand({
    paperTask: roots.paperTask,
    paperState: { evidenceRefs: [] },
    sourceWorkspace: roots.workspace,
    mode: 'research-verify',
    targetScopeReceipt: roots.targetScopeReceipt,
  });
  assert.deepEqual(command.campaignPlan.nodes.map((node) => node.kind), ['research-verify']);
  assert.equal(
    command.campaignPlan.researchVerificationInput.paperSemanticIdentityHash,
    roots.paperTask.semanticIdentityHash,
  );
  let agentCalls = 0;
  const authoritativeNode = { ...command.campaignPlan.nodes[0], attemptId: 'attempt-1', leaseGeneration: 1, dependencies: [] };
  const executor = createCampaignNodeExecutor({
    runtimeRoot: roots.runtimeRoot,
    researchVerifier: createCampaignResearchVerifier({
      runtimeRoot: roots.runtimeRoot,
      clock: { now: () => new Date('2026-07-14T00:00:00.000Z') },
      campaignStore: { listNodes: () => [authoritativeNode] },
    }),
    agentExecutor: { async execute() { agentCalls += 1; throw new Error('research_verify_must_not_use_agent'); } },
    empiricalExecutor: { execute() { throw new Error('research_verify_must_not_use_empirical_executor'); } },
  });
  const node = authoritativeNode;
  await assert.rejects(
    () => executor.execute({ campaign: campaignFor(command), node: { ...node, spec: node }, allNodes: [] }),
    (error) => error.message.startsWith('campaign_research_verification_blocked:') && error.retryable === false,
  );
  assert.equal(agentCalls, 0);

  const missingVerifier = createCampaignNodeExecutor({
    runtimeRoot: roots.runtimeRoot,
    agentExecutor: { async execute() { throw new Error('not_expected'); } },
    empiricalExecutor: { execute() { throw new Error('not_expected'); } },
  });
  await assert.rejects(
    () => missingVerifier.execute({ campaign: campaignFor(command), node: { ...node, spec: node }, allNodes: [] }),
    (error) => error.message === 'campaign_research_verifier_required' && error.retryable === false,
  );
});

test('benchmark selector is consumed from batch command through plan and empirical executor request/result', async (t) => {
  const roots = fixture(t, 'hepta-campaign-benchmark-mode-');
  fs.mkdirSync(path.join(roots.workspace, 'experiments'));
  fs.writeFileSync(path.join(roots.workspace, 'experiments', 'run.py'), 'import os\nassert os.environ["HEPTA_BENCHMARK_ID"] == "ml_algorithm_benchmark"\n');
  const command = buildBatchCampaignCommand({
    paperTask: roots.paperTask,
    paperState: { evidenceRefs: [] },
    sourceWorkspace: roots.workspace,
    mode: 'empirical-analysis',
    targetScopeReceipt: roots.targetScopeReceipt,
    benchmarkId: 'ml_algorithm_benchmark',
  });
  const selector = command.campaignPlan.benchmarkSelector;
  assert.equal(selector.selectorType, 'builtin_benchmark_suite');
  assert.equal(command.campaignPlan.executionIntent.benchmarkSelectorHash, selector.campaignBenchmarkSelectorHash);
  const protocol = {
    ...selector.experimentDesign.analysisProtocol,
    analysisProtocolHash: selector.experimentDesign.analysisProtocolHash,
  };
  const declarations = empiricalClaimDeclarationsFromAnalysisProtocol(protocol);
  fs.writeFileSync(path.join(roots.workspace, 'main.tex'), [
    '\\documentclass{article}',
    '\\begin{document}',
    ...declarations.flatMap((declaration, index) => [
      `% HEPTA_EMPIRICAL_CLAIM_BEGIN ${JSON.stringify(declaration)}`,
      `Confirmatory benchmark claim ${index + 1}.`,
      `% HEPTA_EMPIRICAL_CLAIM_END ${declaration.claimId}`,
    ]),
    '\\end{document}',
    '',
  ].join('\n'));
  let empiricalRequest = null;
  const clock = {
    now: () => new Date('2026-07-15T00:00:00.000Z'),
    nowIso: () => '2026-07-15T00:00:00.000Z',
  };
  const store = createDefaultPaperStore({ root: roots.root, runtimeRoot: roots.runtimeRoot });
  t.after(() => store.close?.());
  const artifactReceiptLedger = composeArtifactReceiptLedger({ store, clock });
  const artifactRepositoryFactory = (scopeRoot) => createFilesystemArtifactRepository({
    scopeRoot,
    casRoot: path.join(roots.runtimeRoot, 'artifact-cas'),
    receiptLedger: artifactReceiptLedger,
    clock,
  });
  const executor = createCampaignNodeExecutor({
    runtimeRoot: roots.runtimeRoot,
    artifactRepositoryFactory,
    agentExecutor: { async execute() { throw new Error('agent_not_expected'); } },
    empiricalExecutor: { execute(spec) {
      empiricalRequest = spec;
      fs.mkdirSync(spec.outputDirectory, { recursive: true });
      const execution = fixtureHarnessExecution(spec, spec.benchmarkSelector, []);
      assert.equal(execution.harnessExecutionReceipt.status, 'system_benchmark_harness_verified', JSON.stringify(execution.harnessExecutionReceipt.blockers));
      return execution;
    } },
  });
  const node = command.campaignPlan.nodes.find((candidate) => candidate.kind === 'empirical');
  const result = await executor.execute({ campaign: campaignFor(command), node: { ...node, spec: node, attemptId: 'attempt-1' }, allNodes: [] });
  assert.equal(empiricalRequest.benchmarkSelector.benchmarkSelectorTemplateHash, selector.campaignBenchmarkSelectorHash);
  assert.notEqual(empiricalRequest.benchmarkSelector.campaignBenchmarkSelectorHash, selector.campaignBenchmarkSelectorHash);
  assert.equal(empiricalRequest.env.HEPTA_BENCHMARK_ID, 'ml_algorithm_benchmark');
  assert.equal(empiricalRequest.env.HEPTA_BENCHMARK_SELECTOR_HASH, empiricalRequest.benchmarkSelector.campaignBenchmarkSelectorHash);
  assert.equal(empiricalRequest.env.HEPTA_EXPERIMENT_DESIGN_HASH, empiricalRequest.benchmarkSelector.experimentDesignHash);
  assert.equal(result.campaignBenchmarkSelectorHash, empiricalRequest.benchmarkSelector.campaignBenchmarkSelectorHash);

  await assert.rejects(
    () => executor.execute({
      campaign: { ...campaignFor(command), spec: { ...command.campaignPlan, benchmarkSelector: null } },
      node: { ...node, spec: node, attemptId: 'attempt-2' },
      allNodes: [],
    }),
    (error) => error.retryable === false && error.message.startsWith('campaign_empirical_benchmark_selector_invalid:'),
  );
  let repairCalls = 0;
  const unavailableExecutor = createCampaignNodeExecutor({
    runtimeRoot: roots.runtimeRoot,
    agentExecutor: { async execute() { repairCalls += 1; return { status: 'unexpected-repair' }; } },
    empiricalExecutor: { execute() {
      return { status: 'empirical_execution_failed', blockers: ['worker_dataset_access_trusted_supervisor_backend_unavailable'] };
    } },
  });
  await assert.rejects(
    () => unavailableExecutor.execute({ campaign: campaignFor(command), node: { ...node, spec: node, attemptId: 'attempt-unavailable' }, allNodes: [] }),
    (error) => error.retryable === false && error.message.includes('worker_dataset_access_trusted_supervisor_backend_unavailable'),
  );
  assert.equal(repairCalls, 0);
});

test('multi-language empirical executor forwards the selector to all three system-owned arm batches', async (t) => {
  const roots = fixture(t, 'hepta-multi-language-harness-mode-');
  fs.writeFileSync(path.join(roots.workspace, 'run.mjs'), 'void 0;\n');
  for (const [index, arm] of ['treatment', 'baseline', 'ablation'].entries()) {
    fs.writeFileSync(path.join(roots.workspace, `run.${arm}.mjs`), `// ${arm} ${index}\n`);
  }
  const selector = Object.freeze({
    version: 1,
    kind: 'CampaignBenchmarkSelector',
    benchmarkId: 'ml_algorithm_benchmark',
    selectorType: 'builtin_benchmark_suite',
    datasetMountName: null,
    datasetManifestHash: null,
    datasetLicenseId: null,
    readOnlyDataset: null,
    campaignBenchmarkSelectorHash: 'placeholder',
  });
  const { buildCampaignBenchmarkSelector } = await import('../../paper-domain/automation/campaign-benchmark-selector.mjs');
  const verifiedSelector = buildCampaignBenchmarkSelector({ benchmarkId: selector.benchmarkId });
  let workerRequest = null;
  const executor = createMultiLanguageEmpiricalExecutor({
    workerRunner: {
      availability: { available: true },
      run(spec) {
        workerRequest = spec;
        return fixtureRunnerReceipt({
          spec,
          outputDirectory: spec.outputDirectory,
          requiredMetrics: verifiedSelector.experimentDesign.requiredMetrics,
        });
      },
    },
  });
  const receipt = await executor.execute({
    language: 'node',
    entrypoint: 'run.mjs',
    cwd: roots.workspace,
    sourceRoot: roots.workspace,
    outputDirectory: path.join(roots.root, 'output'),
    env: { HEPTA_EXPERIMENT_ATTEMPT_ID: 'fixture:empirical:attempt-1' },
    sourceLineageHash: hashBytes(fs.readFileSync(path.join(roots.workspace, 'main.tex'))),
    benchmarkSelector: verifiedSelector,
  });
  assert.equal(workerRequest.env.HEPTA_BENCHMARK_ID, verifiedSelector.benchmarkId);
  assert.equal(workerRequest.env.HEPTA_EXPERIMENT_DESIGN_HASH, verifiedSelector.experimentDesignHash);
  assert.equal(workerRequest.env.HEPTA_BENCHMARK_SELECTOR_HASH, verifiedSelector.campaignBenchmarkSelectorHash);
  assert.equal(receipt.campaignBenchmarkSelectorHash, verifiedSelector.campaignBenchmarkSelectorHash);
  const blocked = executor.execute({
    language: 'node',
    entrypoint: 'run.mjs',
    cwd: roots.workspace,
    env: { HEPTA_BENCHMARK_ID: 'unbound' },
  });
  assert.equal(blocked.status, 'empirical_benchmark_selector_invalid');
});
