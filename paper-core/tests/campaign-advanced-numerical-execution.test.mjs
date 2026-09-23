import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resourcesForCampaignNode } from '../../paper-application/automation/resource-governor.mjs';

import {
  createCampaignAdvancedNumericalExecutionAdapter,
} from '../../paper-adapters/automation/campaign-advanced-numerical-execution-adapter.mjs';
import {
  advancedNumericalCampaignPluginInput,
  buildAdvancedNumericalCampaignExecutionPlan,
  buildAdvancedNumericalCampaignTypedInput,
  buildAdvancedNumericalPluginRuntimeIdentity,
  verifyAdvancedNumericalCampaignExecutionPlan,
  verifyCampaignAdvancedNumericalExecutionResult,
} from '../../paper-domain/automation/advanced-numerical-campaign-execution-contract.mjs';
import {
  buildCampaignBenchmarkSelector,
} from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import { buildCampaignModeNodes } from '../../paper-domain/automation/campaign-mode-graph.mjs';
import { buildPaperCampaignPlan } from '../../paper-domain/automation/campaign-plan.mjs';
import { versionedExperimentIrFor } from '../../paper-domain/automation/versioned-experiment-ir.mjs';
import {
  ADVANCED_NUMERICAL_GPU_DEVICE_ISOLATION_SCOPE,
  ADVANCED_NUMERICAL_GPU_MEMORY_LIMIT_SCOPE,
  ADVANCED_NUMERICAL_PLUGIN_ANALYSIS_FAMILIES,
  compileAdvancedNumericalPluginDescriptor,
} from '../../paper-domain/research/advanced-numerical-plugin-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord('CampaignAdvancedNumericalExecutionTest', { label });
const CAMPAIGN_ID = 'advanced-campaign';
const PAPER_ID = 'advanced-paper';
const NODE_ID = `${CAMPAIGN_ID}:0:advanced-numerical-analysis`;
const FAMILY = 'ml_algorithm_benchmark';

function descriptor() {
  return compileAdvancedNumericalPluginDescriptor({
    pluginId: 'fixture.advanced-numerical',
    pluginVersion: '1.0.0',
    analysisFamily: 'linear-algebra',
    runtime: {
      language: 'python',
      executable: 'python3',
      executableHash: H('python'),
      packageClosureHash: H('packages'),
    },
    entrypoint: { relativePath: 'plugin.py', sha256: H('entrypoint') },
    sourceIdentity: {
      merkleHash: H('source-merkle'),
      workspaceManifestHash: H('source-manifest'),
    },
    limits: {
      timeoutMs: 30_000,
      cpuSeconds: 10,
      memoryBytes: 256 * 1024 * 1024,
      maximumProcesses: 8,
      maximumOutputBytes: 1024 * 1024,
      maximumCapturedBytes: 128 * 1024,
    },
    networkPolicy: 'none',
    assuranceContracts: {
      oracle: { kind: 'independent-numeric-oracle-v1', contractHash: H('oracle') },
      replay: { kind: 'deterministic-process-replay-v1', contractHash: H('replay') },
      uncertainty: { kind: 'typed-uncertainty-report-v1', contractHash: H('uncertainty') },
    },
  });
}

function gpuDescriptor() {
  return compileAdvancedNumericalPluginDescriptor({
    ...descriptor(),
    version: 2,
    runtime: {
      language: 'python',
      executable: 'python',
      executableHash: H('gpu-python'),
      packageClosureHash: H('gpu-image'),
      runtimeProfile: 'pythonGpu',
      requiresGpu: true,
      containerImage: 'hepta/python-gpu:0.15.0',
      containerImageDigest: H('gpu-image'),
      containerExecutable: 'python',
      gpuDeviceSelector: 'GPU-a33875b7-7eb7-679e-df08-19227d3decee',
      cpuFallbackPolicy: 'forbidden',
      gpuDeviceIsolationScope: ADVANCED_NUMERICAL_GPU_DEVICE_ISOLATION_SCOPE,
      gpuMemoryLimitBytes: null,
      gpuMemoryLimitEnforced: false,
      gpuMemoryLimitScope: ADVANCED_NUMERICAL_GPU_MEMORY_LIMIT_SCOPE,
    },
    advancedNumericalPluginDescriptorHash: undefined,
  });
}

function runtimeIdentity() {
  return buildAdvancedNumericalPluginRuntimeIdentity({
    configurationVersion: 1,
    configurationHash: H('configuration'),
    signedBundleHash: H('signed-bundle'),
    dependencyFileHashes: {
      signedBundleFileHash: H('bundle-file'),
      trustStoreFileHash: H('trust-store-file'),
    },
  });
}

function analysisProtocol() {
  const selector = buildCampaignBenchmarkSelector({ benchmarkId: FAMILY });
  return Object.freeze({
    ...selector.experimentDesign.analysisProtocol,
    analysisProtocolHash: selector.experimentDesign.analysisProtocolHash,
  });
}

function executionPlan() {
  return buildAdvancedNumericalCampaignExecutionPlan({
    campaignId: CAMPAIGN_ID,
    paperId: PAPER_ID,
    versionedExperimentIr: versionedExperimentIrFor(FAMILY),
    analysisProtocol: analysisProtocol(),
    pluginDescriptor: descriptor(),
    pluginRuntimeIdentity: runtimeIdentity(),
    typedInput: buildAdvancedNumericalCampaignTypedInput({
      schemaId: 'linear-system-v1',
      schemaHash: H('input-schema'),
      value: { matrix: [[2, 0], [0, 3]], vector: [4, 9] },
    }),
    seed: 1729,
  });
}

function pluginReceipt(plan, { qualified = true, ordinal = 1 } = {}) {
  const payload = {
    version: 1,
    kind: 'AdvancedNumericalPluginExecutionReceipt',
    status: qualified
      ? 'advanced_numerical_plugin_execution_completed_qualified'
      : 'advanced_numerical_plugin_execution_completed_unqualified',
    pluginId: plan.pluginDescriptor.pluginId,
    analysisFamily: plan.pluginDescriptor.analysisFamily,
    pluginDescriptorHash: plan.pluginDescriptorHash,
    signedBundleHash: plan.pluginRuntimeIdentity.signedBundleHash,
    requestHash: H(`request:${ordinal}`),
    resultHash: H(`result:${ordinal}`),
    workerReceiptHash: H(`worker:${ordinal}`),
    workerReceipt: { fixture: true, ordinal },
    result: { fixture: true, ordinal },
    productionQualified: qualified,
    qualificationStatementHash: qualified ? H('qualification') : null,
    qualificationEvidenceBundleHash: qualified ? H('qualification-evidence') : null,
    qualificationInspectionHash: qualified ? H('qualification-inspection') : null,
    qualificationRequirement: qualified ? null
      : 'signed-reference-replay-oracle-uncertainty-and-scientific-evidence-required',
    blockers: Object.freeze([]),
  };
  return Object.freeze({
    ...payload,
    advancedNumericalPluginExecutionReceiptHash:
      hashRecord('AdvancedNumericalPluginExecutionReceipt', payload),
  });
}

function runtimeFixture(t, plan, { qualified = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-campaign-advanced-'));
  const outputRoot = path.join(root, 'outputs');
  fs.mkdirSync(outputRoot);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const runner = Object.freeze({
    version: 1,
    kind: 'AdvancedNumericalPluginRunner',
    capabilities: () => Object.freeze({
      analysisFamilies: ADVANCED_NUMERICAL_PLUGIN_ANALYSIS_FAMILIES,
      outOfProcess: true,
      signedPlugins: true,
      resourceLimits: true,
      networkPolicy: 'none',
      productionQualified: qualified,
    }),
    async run() {
      calls += 1;
      return pluginReceipt(plan, { qualified, ordinal: calls });
    },
  });
  const runtime = {
    runner,
    verifiedBundle: { signedBundleHash: plan.pluginRuntimeIdentity.signedBundleHash },
    runtimeConfiguration: {
      configuration: { version: plan.pluginRuntimeIdentity.configurationVersion },
      configurationHash: plan.pluginRuntimeIdentity.configurationHash,
      dependencyFileHashes: plan.pluginRuntimeIdentity.dependencyFileHashes,
      outputRoot,
    },
  };
  return {
    root,
    outputRoot,
    execution: createCampaignAdvancedNumericalExecutionAdapter({ runtime }),
    calls: () => calls,
  };
}

function campaignAndNode(plan, { attemptId = 'attempt-1', leaseGeneration = 1 } = {}) {
  const campaign = Object.freeze({
    campaignId: CAMPAIGN_ID,
    paperId: PAPER_ID,
    spec: Object.freeze({
      campaignPlanHash: H('campaign-plan'),
      advancedNumericalExecutionPlan: plan,
    }),
  });
  const node = Object.freeze({
    nodeId: NODE_ID,
    kind: 'advanced-numerical-analysis',
    attemptId,
    leaseGeneration,
    advancedNumericalExecutionPlanHash:
      plan.advancedNumericalCampaignExecutionPlanHash,
  });
  return { campaign, node };
}

test('advanced numerical GPU profiles consume the campaign GPU lease budget', () => {
  const campaign = { spec: { workerMemoryBytes: 512 * 1024 * 1024 } };
  const cpu = resourcesForCampaignNode(campaign, {
    kind: 'advanced-numerical-analysis',
    spec: { requiresGpu: false },
  });
  const gpu = resourcesForCampaignNode(campaign, {
    kind: 'advanced-numerical-analysis',
    spec: { requiresGpu: true },
  });
  assert.equal(cpu.cpu, 1);
  assert.equal(cpu.gpu, 0);
  assert.equal(gpu.cpu, 1);
  assert.equal(gpu.gpu, 1);
});

test('advanced numerical campaign plan binds IR, protocol, plugin/config, typed input, seed and budget', () => {
  const plan = executionPlan();
  assert.equal(verifyAdvancedNumericalCampaignExecutionPlan(plan, {
    campaignId: CAMPAIGN_ID,
    paperId: PAPER_ID,
    nodeId: NODE_ID,
  }), true);
  for (const mutate of [
    (value) => { value.seed += 1; },
    (value) => { value.typedInput.value.vector[0] += 1; },
    (value) => { value.pluginRuntimeIdentity.configurationHash = H('other-config'); },
    (value) => { value.versionedExperimentIr.design.seedSchedule[0] += 1; },
  ]) {
    const tampered = structuredClone(plan);
    mutate(tampered);
    assert.equal(verifyAdvancedNumericalCampaignExecutionPlan(tampered), false);
  }
  const smallerBudget = { ...descriptor().limits, timeoutMs: 29_999 };
  assert.throws(() => buildAdvancedNumericalCampaignExecutionPlan({
    ...plan,
    budget: smallerBudget,
  }), /advanced_numerical_campaign_budget_invalid/);
  const oversizedTypedInput = buildAdvancedNumericalCampaignTypedInput({
    schemaId: 'oversized-composed-input-v1',
    schemaHash: H('oversized-input-schema'),
    value: { padding: 'x'.repeat(31 * 1024) },
  });
  assert.throws(() => buildAdvancedNumericalCampaignExecutionPlan({
    ...plan,
    typedInput: oversizedTypedInput,
  }), /advanced_numerical_campaign_plugin_input_too_large/);
});

test('GPU plan v2 binds the pinned container, UUID selector and honest VRAM authority', () => {
  const pluginDescriptor = gpuDescriptor();
  const plan = buildAdvancedNumericalCampaignExecutionPlan({
    campaignId: CAMPAIGN_ID,
    paperId: PAPER_ID,
    versionedExperimentIr: versionedExperimentIrFor(FAMILY),
    analysisProtocol: analysisProtocol(),
    pluginDescriptor,
    pluginRuntimeIdentity: buildAdvancedNumericalPluginRuntimeIdentity({
      configurationVersion: 2,
      configurationHash: H('gpu-configuration'),
      signedBundleHash: H('gpu-signed-bundle'),
      dependencyFileHashes: {
        signedBundleFileHash: H('gpu-bundle-file'),
        trustStoreFileHash: H('gpu-trust-store-file'),
      },
    }),
    typedInput: buildAdvancedNumericalCampaignTypedInput({
      schemaId: 'poisson-2d-manufactured-v1',
      schemaHash: H('pde-input-schema'),
      value: { gridSizes: [31, 63, 127] },
    }),
    seed: 1729,
  });
  assert.equal(plan.version, 2);
  assert.equal(plan.gpuRuntimeAuthority.containerImageDigest,
    pluginDescriptor.runtime.containerImageDigest);
  assert.equal(plan.gpuRuntimeAuthority.gpuMemoryLimitEnforced, false);
  assert.equal(advancedNumericalCampaignPluginInput(plan).gpuRuntimeAuthority,
    plan.gpuRuntimeAuthority);
  assert.equal(verifyAdvancedNumericalCampaignExecutionPlan(plan), true);

  const drifted = structuredClone(plan);
  drifted.gpuRuntimeAuthority.cpuFallbackPolicy = 'allowed';
  drifted.advancedNumericalCampaignExecutionPlanHash = hashRecord(
    'AdvancedNumericalCampaignExecutionPlan',
    Object.fromEntries(Object.entries(drifted).filter(([key]) => (
      key !== 'advancedNumericalCampaignExecutionPlanHash'
    ))),
  );
  assert.equal(verifyAdvancedNumericalCampaignExecutionPlan(drifted), false);
  assert.throws(() => buildAdvancedNumericalCampaignExecutionPlan({
    ...plan,
    pluginRuntimeIdentity: runtimeIdentity(),
  }), /execution_plan_invalid/);
});

test('full campaign graph inserts the optional node only for a verified plan and binds release dependencies', () => {
  const plan = executionPlan();
  const paperTask = Object.freeze({
    version: 'fixture',
    kind: 'PaperTask',
    paperId: PAPER_ID,
    taskKey: `paper:${PAPER_ID}`,
    semanticIdentityHash: H('paper-task'),
    sourceWorkspace: '/tmp/advanced-paper',
    evidenceRefs: Object.freeze([]),
  });
  const campaignPlan = buildPaperCampaignPlan({
    paperId: PAPER_ID,
    sourceWorkspace: '/tmp/advanced-paper',
    campaignId: CAMPAIGN_ID,
    maxRounds: 1,
    refereeCount: 2,
    languages: ['latex'],
    paperTask,
    paperState: { evidenceRefs: [] },
    advancedNumericalExecutionPlan: plan,
  });
  const advanced = campaignPlan.nodes.find((node) => (
    node.kind === 'advanced-numerical-analysis'
  ));
  const finalCompile = campaignPlan.nodes.find((node) => node.kind === 'final-compile');
  const researchVerify = campaignPlan.nodes.find((node) => node.kind === 'research-verify');
  assert.equal(advanced.advancedNumericalExecutionPlanHash,
    plan.advancedNumericalCampaignExecutionPlanHash);
  assert.equal(advanced.sourceMutationPolicy, 'forbid');
  assert.ok(finalCompile.dependencies.includes(advanced.nodeId));
  assert.ok(researchVerify.dependencies.includes(advanced.nodeId));

  const tampered = structuredClone(plan);
  tampered.typedInput.value.vector[0] += 1;
  assert.throws(() => buildCampaignModeNodes({
    campaignId: CAMPAIGN_ID,
    mode: 'full-campaign',
    rounds: 1,
    reviewers: 2,
    executionProfiles: [],
    executionIntent: {},
    empiricalRequested: false,
    applyManuscript: false,
    researchVerificationRequired: true,
    advancedNumericalExecutionPlan: tampered,
  }), /campaign_advanced_numerical_execution_plan_invalid/);
});

test('campaign adapter is attempt/lease-bound, idempotent, no-clobber, and recovery uses a new evidence identity', async (t) => {
  const plan = executionPlan();
  const fixture = runtimeFixture(t, plan, { qualified: true });
  const workspace = path.join(fixture.root, 'workspace');
  fs.mkdirSync(workspace);
  const firstIdentity = campaignAndNode(plan);
  const first = await fixture.execution.execute({
    ...firstIdentity,
    plan,
    workspace,
  });
  const replay = await fixture.execution.execute({
    ...firstIdentity,
    plan,
    workspace,
  });
  assert.deepEqual(replay, first);
  assert.equal(fixture.calls(), 1);
  assert.equal(verifyCampaignAdvancedNumericalExecutionResult(first, {
    ...firstIdentity,
    plan,
    requirePromotionEligible: true,
  }), true);

  const recoveredIdentity = campaignAndNode(plan, {
    attemptId: 'attempt-2',
    leaseGeneration: 2,
  });
  const recovered = await fixture.execution.execute({
    ...recoveredIdentity,
    plan,
    workspace,
  });
  assert.equal(fixture.calls(), 2);
  assert.notEqual(
    recovered.advancedNumericalCampaignExecutionReceiptHash,
    first.advancedNumericalCampaignExecutionReceiptHash,
  );
  assert.deepEqual(recovered.materializedPaths, []);

  const wrongLease = { ...recoveredIdentity.node, leaseGeneration: 3 };
  assert.equal(verifyCampaignAdvancedNumericalExecutionResult(recovered, {
    campaign: recoveredIdentity.campaign,
    node: wrongLease,
    plan,
  }), false);
});

test('unqualified execution remains evidence but is ineligible for promotion', async (t) => {
  const plan = executionPlan();
  const fixture = runtimeFixture(t, plan, { qualified: false });
  const workspace = path.join(fixture.root, 'workspace');
  fs.mkdirSync(workspace);
  const identity = campaignAndNode(plan);
  const result = await fixture.execution.execute({ ...identity, plan, workspace });
  assert.equal(result.status,
    'campaign_advanced_numerical_execution_completed_unqualified');
  assert.equal(result.productionQualified, false);
  assert.equal(result.promotionEligible, false);
  assert.ok(result.blockers.includes(
    'advanced_numerical_plugin_production_qualification_required',
  ));
  assert.equal(verifyCampaignAdvancedNumericalExecutionResult(result, {
    ...identity,
    plan,
    requirePromotionEligible: true,
  }), false);
});
