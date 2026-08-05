import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOllamaStructuredAgentExecutor } from '../../paper-adapters/automation/ollama-structured-agent-executor.mjs';
import { createCampaignNodeExecutor } from '../../paper-composition/automation/campaign-node-execution-composition.mjs';

test('structured Ollama adapter enforces schema and per-node output budgets', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-ollama-executor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.tex'), 'before\n');
  let request = null;
  const executor = createOllamaStructuredAgentExecutor({
    model: 'fixture-model',
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, json: async () => ({ response: JSON.stringify({ status: 'completed', summary: 'edited', edits: [{ path: 'main.tex', content: 'after\n' }], checks: [], blockers: [] }), done_reason: 'stop', prompt_eval_count: 29, eval_count: 23 }) };
    },
  });
  const receipt = await executor.execute({ role: 'writer', workspacePath: root, instructions: 'edit', outputTokenBudget: 777 });
  assert.equal(request.options.num_predict, 777);
  assert.equal(request.format.type, 'object');
  assert.equal(receipt.outputDoneReason, 'stop');
  assert.equal(receipt.outputTokenCount, 23);
  assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'after\n');
});

test('every campaign repair path forwards the nested lease AbortSignal and stops before retrying execution', async (t) => {
  const cases = [
    { name: 'dataset', language: 'python', role: 'dataset-consumption-contract-repair', source: 'print("fixture")\n', datasetMounts: [{ name: 'fixture', source: '/fixture.csv', readOnly: true, manifestHash: `sha256:${'a'.repeat(64)}`, licenseId: 'MIT' }], empiricalStatus: 'empirical_execution_completed', expectedEmpiricalCalls: 0 },
    { name: 'latex', language: 'latex', role: 'latex-repair', source: '\\documentclass{article}\n\\begin{document}fixture\\end{document}\n', empiricalStatus: 'empirical_execution_failed', expectedEmpiricalCalls: 1 },
    { name: 'empirical', language: 'python', role: 'empirical-code-repair', source: 'raise RuntimeError("fixture")\n', empiricalStatus: 'empirical_execution_failed', expectedEmpiricalCalls: 1 },
    { name: 'artifact', language: 'r', role: 'empirical-artifact-contract-repair', source: 'quit(status=0)\n', empiricalStatus: 'empirical_execution_completed', metricSchema: { minimumMetricCount: 1 }, expectedEmpiricalCalls: 1 },
  ];

  for (const fixture of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `hepta-${fixture.name}-repair-abort-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(root, 'main.tex'), fixture.language === 'latex' ? fixture.source : 'fixture\n');
    if (fixture.language === 'python') fs.writeFileSync(path.join(root, 'run.py'), fixture.source);
    if (fixture.language === 'r') fs.writeFileSync(path.join(root, 'run.R'), fixture.source);
    let empiricalCalls = 0;
    let agentAbortCount = 0;
    const nestedLost = new AbortController();
    const executor = createCampaignNodeExecutor({
      runtimeRoot: path.join(root, 'runtime'),
      empiricalExecutor: {
        async execute() {
          empiricalCalls += 1;
          return fixture.empiricalStatus === 'empirical_execution_completed'
            ? { status: fixture.empiricalStatus, multiLanguageEmpiricalReceiptHash: `sha256:${fixture.name}`, artifacts: [] }
            : { status: fixture.empiricalStatus, blockers: ['os_sandbox_command_failed'], stderrTail: `${fixture.name} fixture failure` };
        },
      },
      agentExecutor: {
        async execute(input) {
          assert.equal(input.role, fixture.role, fixture.name);
          assert.equal(input.signal, nestedLost.signal, fixture.name);
          return new Promise((resolve, reject) => {
            input.signal.addEventListener('abort', () => {
              agentAbortCount += 1;
              reject(new Error(String(input.signal.reason)));
            }, { once: true });
          });
        },
      },
    });
    const executionResources = {
      runNestedAgent(operation) {
        const pending = operation({ remainingTokenCount: 512, signal: nestedLost.signal });
        setImmediate(() => nestedLost.abort(`nested_${fixture.name}_resource_lease_lost`));
        return pending;
      },
    };

    await assert.rejects(
      () => executor.execute({
        campaign: { campaignId: `campaign-${fixture.name}`, paperId: `paper-${fixture.name}`, spec: { sourceWorkspace: root, languages: [fixture.language], datasetMounts: fixture.datasetMounts || [], metricSchema: fixture.metricSchema || {} } },
        node: { nodeId: `node-${fixture.name}`, kind: fixture.language === 'latex' ? 'compile' : 'empirical', roundIndex: 0, spec: { language: fixture.language } },
        allNodes: [],
        executionResources,
      }),
      new RegExp(`nested_${fixture.name}_resource_lease_lost`),
    );
    assert.equal(agentAbortCount, 1, fixture.name);
    assert.equal(empiricalCalls, fixture.expectedEmpiricalCalls, fixture.name);
  }
});
