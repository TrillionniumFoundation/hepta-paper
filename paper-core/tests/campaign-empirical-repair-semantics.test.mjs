import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCampaignNodeExecutor } from '../../paper-composition/automation/campaign-node-execution-composition.mjs';
import { createIsolatedAgentExecutor } from '../../paper-adapters/automation/isolated-agent-executor.mjs';
import { buildExecutorCapabilities } from '../../paper-ports/executor-capabilities.mjs';
import {
  empiricalResultContractTechnicalRepairEligible,
  empiricalTechnicalRepairEligible,
} from '../../paper-application/automation/campaign-empirical-node-orchestrator.mjs';
import { buildCampaignAgentExecutionRequest } from '../../paper-application/automation/campaign-agent-policy.mjs';
import {
  assertOutcomeBoundBenchmarkSourceUnchanged,
  assertOutcomeBoundManuscriptMutationAllowed,
} from '../../paper-application/automation/campaign-confirmatory-lineage-policy.mjs';
import { buildCampaignModeNodes } from '../../paper-domain/automation/campaign-mode-graph.mjs';

test('empirical auto-repair eligibility is technical-only and excludes scientific or authority outcomes', () => {
  assert.equal(empiricalTechnicalRepairEligible({
    status: 'empirical_execution_completed', scientificVerdict: 'negative', blockers: [],
  }, { language: 'python' }), false);
  assert.equal(empiricalTechnicalRepairEligible({
    status: 'empirical_execution_completed', scientificVerdict: 'inconclusive',
    scientificFindings: ['analysis_independent_unit_count_insufficient'], blockers: [],
  }, { language: 'python' }), false);
  assert.equal(empiricalTechnicalRepairEligible({
    status: 'empirical_execution_completed', blockers: ['os_sandbox_command_failed'],
    harnessExecutionReceipt: { analysisProtocolEvaluation: { scientificVerdict: 'inconclusive' } },
  }, { language: 'python' }), false);
  assert.equal(empiricalTechnicalRepairEligible({
    status: 'empirical_execution_failed', failureClass: 'technical_failure', repairEligible: true,
    blockers: ['analysis_property_oracle_unverified'],
  }, { language: 'python' }), false);
  assert.equal(empiricalTechnicalRepairEligible({
    status: 'empirical_execution_failed', blockers: ['os_sandbox_command_failed'],
  }, { language: 'python' }), true);
  assert.equal(empiricalResultContractTechnicalRepairEligible({
    blockers: ['empirical_metric_inconsistent:mean_score'],
  }), false);
  assert.equal(empiricalResultContractTechnicalRepairEligible({
    blockers: ['empirical_results_json_missing', 'empirical_results_csv_missing'],
  }), true);
});

test('outcome-informed revision cannot mutate empirical code or reopen confirmatory source repair', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-outcome-bound-revision-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'main.tex'), 'negative result\n');
  fs.writeFileSync(path.join(source, 'run.py'), 'print("frozen")\n');
  const request = buildCampaignAgentExecutionRequest({
    campaign: { campaignId: 'campaign', paperId: 'paper', spec: { datasetMounts: [] } },
    node: { nodeId: 'revise', kind: 'revise', role: 'reviser', roundIndex: 1 },
    workspace: source,
    manuscript: 'main.tex',
    reviews: [],
    empiricalOutcomeObserved: true,
    executionBudget: { remainingTokenCount: 1024, remainingWallTimeMs: 30_000 },
  });
  assert.match(request.instructions, /negative, non-significant, or inconclusive result must remain reportable/i);
  assert.equal(request.context.empiricalOutcomeObserved, true);
  const delegate = {
    version: 1,
    kind: 'OutcomeMutationFixtureAgent',
    executorId: 'outcome-mutation-fixture',
    capabilities: () => buildExecutorCapabilities({
      executorId: 'outcome-mutation-fixture', sandboxModes: ['workspace-write'],
      networkPolicy: 'none', receiptKinds: ['AgentExecutionReceipt'],
    }),
    async execute(input) {
      fs.writeFileSync(path.join(input.workspacePath, 'main.tex'), 'faithful negative interpretation\n');
      fs.writeFileSync(path.join(input.workspacePath, 'run.py'), 'print("tuned after outcome")\n');
      return { status: 'agent_execution_completed', agentExecutionReceiptHash: 'sha256:fixture' };
    },
  };
  const isolated = createIsolatedAgentExecutor({
    delegate,
    isolationRoot: path.join(root, 'isolated'),
    keepFailedWorkspaces: false,
  });
  await assert.rejects(() => isolated.execute(request), /workspace_mutation_forbidden:run\.py/);
  assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'negative result\n');
  assert.equal(fs.readFileSync(path.join(source, 'run.py'), 'utf8'), 'print("frozen")\n');
  assert.equal(assertOutcomeBoundManuscriptMutationAllowed({
    changedPaths: ['main.tex', 'proof_status.md'], manuscript: 'main.tex',
  }), true);
  assert.throws(() => assertOutcomeBoundManuscriptMutationAllowed({
    changedPaths: ['main.tex', 'experiments/run.py'], manuscript: 'main.tex',
  }), (error) => error.message === 'campaign_outcome_informed_empirical_mutation_forbidden:experiments/run.py'
    && error.retryable === false);

  const hash = (character) => `sha256:${character.repeat(64)}`;
  const anchorFreeze = {
    analysisProtocolHash: hash('a'),
    systemBenchmarkArmProtocolSetHash: hash('b'),
    systemBenchmarkArmAdapterSetHash: hash('c'),
  };
  assert.equal(assertOutcomeBoundBenchmarkSourceUnchanged({
    anchorFreeze,
    analysisProtocolHash: hash('a'),
    systemBenchmarkArmProtocolSetHash: hash('b'),
    systemBenchmarkArmAdapterSetHash: hash('c'),
  }), true);
  assert.throws(() => assertOutcomeBoundBenchmarkSourceUnchanged({
    anchorFreeze,
    analysisProtocolHash: hash('a'),
    systemBenchmarkArmProtocolSetHash: hash('b'),
    systemBenchmarkArmAdapterSetHash: hash('d'),
  }), (error) => error.message === 'campaign_outcome_informed_empirical_source_mutation_forbidden'
    && error.retryable === false);

  const nodes = buildCampaignModeNodes({
    campaignId: 'campaign', mode: 'full-campaign', rounds: 1, reviewers: 1,
    executionProfiles: [{ label: 'python', language: 'python', requiresGpu: false }],
    executionIntent: { mode: 'execute' }, empiricalRequested: true, applyManuscript: true,
  });
  const sealedKinds = nodes.filter((node) => /^(?:empirical-reproduce|revalidate-(?:code|empirical))/.test(node.kind));
  assert.ok(sealedKinds.length >= 4);
  assert.equal(sealedKinds.every((node) => node.sourceMutationPolicy === 'forbid'), true);
});

test('campaign executor repairs a failed empirical command before completing the node', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-empirical-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.tex'), 'fixture');
  fs.writeFileSync(path.join(root, 'run.py'), 'import os\nfixture = os.environ["HEPTA_DATASET_FIXTURE"]\nwith open(fixture, "rb") as dataset: dataset.read(1)\nraise RuntimeError("fixture")\n');
  let empiricalCalls = 0;
  const empiricalSpecs = [];
  const executor = createCampaignNodeExecutor({
    runtimeRoot: path.join(root, 'runtime'),
    empiricalExecutor: {
      execute(spec) {
        empiricalCalls += 1;
        empiricalSpecs.push(spec);
        assert.equal(spec.env.HEPTA_OUTPUT_DIR, '/output');
        assert.equal(spec.requireSeparateOutputRoot, true);
        if (empiricalCalls === 1) return { status: 'empirical_execution_failed', blockers: ['os_sandbox_command_failed'], stderrTail: 'RuntimeError: fixture' };
        fs.mkdirSync(spec.outputDirectory, { recursive: true });
        fs.writeFileSync(path.join(spec.outputDirectory, 'results.json'), JSON.stringify({ score: 1 }));
        fs.writeFileSync(path.join(spec.outputDirectory, 'results.csv'), 'metric,value\nscore,1\n');
        return {
          status: 'empirical_execution_completed',
          multiLanguageEmpiricalReceiptHash: 'sha256:empirical',
          runnerReceiptHash: 'sha256:runner',
          artifacts: [],
          isolation: { gpuDeviceIsolationVerified: true },
          containerImage: 'fixture:locked',
          datasetMounts: [{ name: 'fixture', manifestHash: 'sha256:data', licenseId: 'MIT', readOnly: true }],
        };
      },
    },
    agentExecutor: {
      async execute(input) {
        assert.equal(input.role, 'empirical-code-repair');
        assert.match(input.instructions, /RuntimeError: fixture/);
        assert.match(input.instructions, /metric,value/);
        assert.match(input.instructions, /positive or significant result/i);
        assert.deepEqual(input.isolationExcludes, ['/datasets/fixture']);
        assert.equal(input.isolationPolicy.skipSourceSymlinks, true);
        return { agentExecutionReceiptHash: 'sha256:repair' };
      },
    },
  });
  const receipt = await executor.execute({
    campaign: { campaign_id: 'campaign', paper_id: 'paper', spec: { sourceWorkspace: root, languages: ['python'], datasetMounts: [{ name: 'fixture', source: '/datasets/fixture', readOnly: true, manifestHash: `sha256:${'a'.repeat(64)}`, licenseId: 'MIT' }] } },
    node: { node_id: 'node', kind: 'empirical', roundIndex: 0 },
    allNodes: [],
  });
  assert.equal(empiricalCalls, 2);
  assert.equal(empiricalSpecs[0].empiricalAttemptVersion, 1);
  assert.equal(empiricalSpecs[1].empiricalAttemptVersion, 2);
  assert.equal(empiricalSpecs[1].env.HEPTA_EXPERIMENT_ATTEMPT_ID, 'campaign:node:direct:v2');
  assert.equal(empiricalSpecs[1].failedAttemptLineageHashes.length, 1);
  assert.notEqual(empiricalSpecs[1].sourceLineageHash, empiricalSpecs[0].sourceLineageHash);
  assert.equal(receipt.status, 'automation_repair_execution_completed');
  assert.equal(receipt.empiricalAttemptVersion, 2);
  assert.equal(receipt.failedAttemptLineage.length, 1);
  assert.equal(receipt.failedAttemptLineage[0].failureClass, 'technical_failure');
  assert.equal(receipt.failedAttemptLineageHashes[0], receipt.failedAttemptLineage[0].empiricalFailedAttemptLineageHash);
  assert.equal(receipt.runnerReceiptHash, 'sha256:runner');
  assert.equal(receipt.containerImage, 'fixture:locked');
  assert.equal(receipt.isolation.gpuDeviceIsolationVerified, true);
  assert.equal(receipt.datasetMounts[0].manifestHash, 'sha256:data');
});

test('campaign executor preserves a negative scientific outcome without invoking code repair', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-negative-empirical-outcome-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.tex'), 'fixture\n');
  fs.writeFileSync(path.join(root, 'run.py'), 'print("negative fixture")\n');
  let empiricalCalls = 0;
  let agentCalls = 0;
  const executor = createCampaignNodeExecutor({
    runtimeRoot: path.join(root, 'runtime'),
    empiricalExecutor: { execute(spec) {
      empiricalCalls += 1;
      fs.mkdirSync(spec.outputDirectory, { recursive: true });
      fs.writeFileSync(path.join(spec.outputDirectory, 'results.json'), '{"effect":0}\n');
      fs.writeFileSync(path.join(spec.outputDirectory, 'results.csv'), 'metric,value\neffect,0\n');
      return {
        status: 'empirical_execution_completed',
        executionStatus: 'empirical_execution_completed',
        integrityStatus: 'empirical_integrity_verified',
        scientificVerdict: 'negative',
        scientificFindings: ['analysis_confirmatory_hypothesis_not_supported:fixture'],
        multiLanguageEmpiricalReceiptHash: `sha256:${'d'.repeat(64)}`,
        artifacts: [],
      };
    } },
    agentExecutor: { async execute() { agentCalls += 1; throw new Error('negative results must not trigger repair'); } },
  });
  const receipt = await executor.execute({
    campaign: { campaignId: 'negative-campaign', paperId: 'negative-paper', spec: { sourceWorkspace: root, languages: ['python'], metricSchema: { minimumMetricCount: 1 } } },
    node: { nodeId: 'negative-node', kind: 'empirical', roundIndex: 0, spec: { language: 'python' } },
    allNodes: [],
  });
  assert.equal(empiricalCalls, 1);
  assert.equal(agentCalls, 0);
  assert.equal(receipt.status, 'empirical_execution_completed');
  assert.equal(receipt.scientificVerdict, 'negative');
  assert.equal(receipt.empiricalResultContractStatus, 'empirical_result_schema_verified');
});

test('campaign executor repairs successful commands that violate the metric artifact contract', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-empirical-artifact-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.tex'), 'fixture');
  fs.writeFileSync(path.join(root, 'run.R'), 'quit(status=0)\n');
  let calls = 0;
  let repaired = false;
  const artifactSpecs = [];
  const executor = createCampaignNodeExecutor({
    runtimeRoot: path.join(root, 'runtime'),
    empiricalExecutor: { execute(spec) {
      calls += 1;
      artifactSpecs.push(spec);
      if (repaired) {
        fs.mkdirSync(spec.outputDirectory, { recursive: true });
        fs.writeFileSync(path.join(spec.outputDirectory, 'results.json'), '{"metric":1}\n');
        fs.writeFileSync(path.join(spec.outputDirectory, 'results.csv'), 'metric,value\nmetric,1\n');
      }
      return { status: 'empirical_execution_completed', multiLanguageEmpiricalReceiptHash: `sha256:run-${calls}`, artifacts: [] };
    } },
    agentExecutor: { async execute(input) {
      assert.equal(input.role, 'empirical-artifact-contract-repair');
      assert.match(input.instructions, /HEPTA_OUTPUT_DIR/);
      assert.match(input.instructions, /metric,value/);
      assert.match(input.instructions, /positive\/significant result/i);
      repaired = true;
      return { agentExecutionReceiptHash: 'sha256:artifact-repair' };
    } },
  });
  const receipt = await executor.execute({
    campaign: { campaign_id: 'campaign', paper_id: 'paper', spec: { sourceWorkspace: root, languages: ['r'], metricSchema: { minimumMetricCount: 1 } } },
    node: { node_id: 'node', kind: 'empirical', roundIndex: 0, spec: { language: 'r' } },
    allNodes: [],
  });
  assert.equal(calls, 2);
  assert.equal(artifactSpecs[0].empiricalAttemptVersion, 1);
  assert.equal(artifactSpecs[1].empiricalAttemptVersion, 2);
  assert.equal(artifactSpecs[1].failedAttemptLineageHashes.length, 1);
  assert.equal(receipt.status, 'automation_repair_execution_completed');
  assert.equal(receipt.empiricalAttemptVersion, 2);
  assert.equal(receipt.failedAttemptLineage.length, 1);
  assert.equal(receipt.empiricalResultContractStatus, 'empirical_result_schema_verified');
});
