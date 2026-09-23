import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  assertAutonomousResearchResourceBudgetClosure,
  completeAutonomousResearchResourceBudgets,
  inspectAutonomousResearchResourceBudgetClosure,
} from '../../paper-domain/automation/autonomous-research-resource-budget-policy.mjs';
import {
  evaluateAutonomousResearchLaunchModeGate,
  resolveAutonomousResearchProviderPricing,
} from '../../paper-domain/automation/autonomous-research-launch-mode-policy.mjs';
import {
  buildAutonomousResearchRecurringGoldenTemplate,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import {
  closeAutonomousResearchResourceBudgets,
} from '../../paper-composition/automation/autonomous-research-resource-budget-composition.mjs';
import {
  authorizedDatasetMount,
} from './autonomous-research-cold-start-e2e-support.mjs';

function preparation() {
  return Object.freeze({
    topologyTemplate: Object.freeze({ revisionRounds: 3, refereeCount: 3 }),
    empiricalExecutionProfileSelection: Object.freeze({
      executionProfile: Object.freeze({
        label: 'python', language: 'python', requiresGpu: false,
      }),
      autonomousEmpiricalExecutionProfileSelectionHash: hashRecord(
        'TestEmpiricalExecutionProfileSelection',
        { profile: 'python' },
      ),
    }),
    venueProfileSelection: Object.freeze({ venueId: 'test-venue' }),
  });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-resource-budget-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    campaignId: 'autonomous-research:budget-closure-test',
    loopPreparation: preparation(),
    datasetMounts: [authorizedDatasetMount(root, 'budget-closure-dataset')],
  };
}

test('full autonomous topology derives the complete agent and empirical cell budget', (t) => {
  const input = fixture(t);
  const blocked = inspectAutonomousResearchResourceBudgetClosure({
    ...input,
    budgets: { maxAgentCalls: 48, maxCpuJobs: 128, maxGpuJobs: 16 },
  });
  assert.equal(blocked.status, 'autonomous_research_resource_budget_blocked');
  assert.deepEqual(blocked.requiredBudgets, {
    maxAgentCalls: 201,
    maxCpuJobs: 7875,
    maxGpuJobs: 0,
  });
  assert.deepEqual(blocked.blockers, [
    'autonomous_research_resource_budget_insufficient:maxAgentCalls',
    'autonomous_research_resource_budget_insufficient:maxCpuJobs',
  ]);
});

test('unspecified resource budgets expand to the planned topology before launch', (t) => {
  const input = fixture(t);
  const preview = inspectAutonomousResearchResourceBudgetClosure({
    ...input,
    budgets: { maxAgentCalls: 48, maxCpuJobs: 128, maxGpuJobs: 16 },
  });
  const completed = completeAutonomousResearchResourceBudgets({
    requestedBudgets: {},
    effectiveBudgets: {
      maxWallTimeMs: 7_200_000,
      maxAgentCalls: 48,
      maxCpuJobs: 128,
      maxGpuJobs: 16,
      maxTokenCount: 300_000,
      maxCostUsd: 100,
      maxMemoryMiB: 8192,
    },
    requiredBudgets: preview.requiredBudgets,
  });
  assert.equal(completed.maxAgentCalls, 201);
  assert.equal(completed.maxCpuJobs, 7875);
  assert.equal(completed.maxGpuJobs, 16);
  assert.equal(assertAutonomousResearchResourceBudgetClosure({
    ...input, budgets: completed,
  }).status, 'autonomous_research_resource_budget_ready');
});

test('golden launch closes an unspecified budget while explicit underfunding stays blocked', (t) => {
  const input = fixture(t);
  const pricing = resolveAutonomousResearchProviderPricing({
    researchAuthorProvider: 'codex',
    researchAuthorModel: 'test-author',
    formalReviewerProvider: 'codex',
    formalReviewerModel: 'test-reviewer',
    researchAuthorMaximumCostPerCallUsd: 0.1,
    formalReviewerMaximumCostPerCallUsd: 0.1,
  });
  const initialGate = evaluateAutonomousResearchLaunchModeGate({
    launchMode: 'golden-bootstrap',
    action: 'launch',
    budgets: {},
    providerPricingInspection: pricing,
  });
  const closed = closeAutonomousResearchResourceBudgets({
    ...input,
    requestedBudgets: {},
    launchMode: 'golden-bootstrap',
    action: 'launch',
    launchModeGate: initialGate,
    providerPricingInspection: pricing,
  });
  assert.equal(closed.effectiveBudgets.maxAgentCalls, 201);
  assert.equal(closed.effectiveBudgets.maxCpuJobs, 7875);
  assert.equal(closed.resourceBudgetClosure.status,
    'autonomous_research_resource_budget_ready');

  assert.throws(() => closeAutonomousResearchResourceBudgets({
    ...input,
    requestedBudgets: { maxAgentCalls: 48, maxCpuJobs: 128 },
    launchMode: 'golden-bootstrap',
    action: 'launch',
    launchModeGate: initialGate,
    providerPricingInspection: pricing,
  }), /autonomous_research_resource_budget_insufficient:maxAgentCalls/);
});

test('recurring golden template signs topology-derived resource budgets', (t) => {
  const input = fixture(t);
  const recurring = buildAutonomousResearchRecurringGoldenTemplate({
    templateId: 'resource-budget-closure',
    epochDurationMs: 12 * 60 * 60 * 1000,
    objective: 'Continuously execute a bounded evidence-producing research campaign.',
    protocolFamily: 'ml_algorithm_benchmark',
    datasetMounts: input.datasetMounts,
    providerConfigurationHash: hashRecord('TestProviderConfiguration', { id: 'provider' }),
    revisionRounds: 3,
    refereeCount: 3,
  });
  assert.equal(recurring.budgets.maxAgentCalls, 201);
  assert.equal(recurring.budgets.maxCpuJobs, 7875);
});
