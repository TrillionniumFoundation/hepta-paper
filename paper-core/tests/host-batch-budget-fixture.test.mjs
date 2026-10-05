import assert from 'node:assert/strict';
import test from 'node:test';
import { hostBatchFixtureBudget } from './support/host-batch-budget-fixture.mjs';
import { buildCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import { buildCampaignBenchmarkSchedule } from '../../paper-domain/automation/system-benchmark-schedule.mjs';
import { autonomousEmpiricalFamilyPluginProfileFor } from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';
import { allocateSystemBenchmarkVerifierCpuSeconds } from '../../paper-domain/automation/system-benchmark-resource-budget-contract.mjs';
import { buildExecutorCapabilities, evaluateExecutorCapabilityRequest } from '../../paper-ports/executor-capabilities.mjs';
const capabilities = buildExecutorCapabilities({ executorId: 'original-host-fixture-cap', sandboxModes: ['kernel-isolated'], networkPolicy: 'none', workspaceIsolation: true, languages: ['node'], maximumTimeoutMs: 120000, receiptKinds: ['OsSandboxWorkerReceipt'] });
test('same original 105 cells and three arms fit original per-worker caps without zero allocation', () => {
  const selector = buildCampaignBenchmarkSelector({ benchmarkId: 'ml_algorithm_benchmark', datasetMounts: [] });
  const schedule = buildCampaignBenchmarkSchedule(selector);
  assert.equal(schedule.length, 105);
  const arms = [...new Set(schedule.map(cell => cell.arm))];
  assert.deepEqual(arms, ['treatment', 'baseline', 'ablation']);
  for (const arm of arms) assert.equal(schedule.filter(cell => cell.arm === arm).length, 35);
  const budget = hostBatchFixtureBudget(1000);
  const profile = autonomousEmpiricalFamilyPluginProfileFor(selector.experimentDesign.benchmarkFamily);
  const verifier = allocateSystemBenchmarkVerifierCpuSeconds(budget.cpuSeconds, arms.length, { oracleAbi: { requiredOracleTypes: profile.typedOracleKinds } });
  assert.equal(verifier.typedNumericRequired, false);
  assert.equal(verifier.rawEventCpuSeconds, 120);
  const armCpu = Math.floor((budget.cpuSeconds - verifier.rawEventCpuSeconds - verifier.typedNumericCpuSeconds) / arms.length);
  const armWall = Math.floor((budget.absoluteDeadlineEpochMs - 1000) / arms.length);
  assert.equal(armCpu, 80); assert.equal(armWall, 40000);
  assert.equal(armCpu * arms.length + verifier.rawEventCpuSeconds, budget.cpuSeconds);
  assert.ok(armCpu > 0 && armCpu <= 120 && budget.memoryBytes <= 1024 * 1024 * 1024 && budget.maximumProcesses <= 128);
  assert.deepEqual(evaluateExecutorCapabilityRequest({ capabilities, request: { timeoutMs: armWall } }).blockers, []);
});
test('original per-worker timeout cap still refuses the old two-hour request and any excess', () => {
  for (const timeoutMs of [120001, 6 * 60 * 60 * 1000 / 3]) {
    assert.deepEqual(evaluateExecutorCapabilityRequest({ capabilities, request: { timeoutMs } }).blockers, ['executor_timeout_limit_exceeded']);
  }
  assert.deepEqual(evaluateExecutorCapabilityRequest({ capabilities, request: { timeoutMs: 120000 } }).blockers, []);
});
test('fixture deadline is finite, exact, bounded and never turns invalid input into a skip', () => {
  assert.equal(hostBatchFixtureBudget(5000).absoluteDeadlineEpochMs, 125000);
  for (const now of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => hostBatchFixtureBudget(now), /clock_invalid/);
});
