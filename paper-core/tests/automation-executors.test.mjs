import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCodexAgentExecutor } from '../../paper-adapters/automation/codex-agent-executor.mjs';
import { createOllamaStructuredAgentExecutor } from '../../paper-adapters/automation/ollama-structured-agent-executor.mjs';
import { createCampaignNodeExecutor } from '../../paper-adapters/automation/campaign-node-executor.mjs';
import { sanitizeGeneratedLatex } from '../../paper-adapters/automation/generated-latex-sanitizer.mjs';
import { createMultiLanguageEmpiricalExecutor } from '../../paper-adapters/automation/multi-language-empirical-executor.mjs';
import { createOsSandboxedWorkerRunner } from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';

test('Codex agent adapter executes a real process and records workspace changes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-agent-executor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shim = path.join(root, 'codex-shim.sh');
  fs.writeFileSync(shim, '#!/bin/sh\ncat >/dev/null\nprintf "changed\\n" > agent-output.txt\nprintf \'{"status":"completed","summary":"ok","checksRun":[],"blockers":[]}\\n\'\n');
  fs.chmodSync(shim, 0o755);
  const executor = createCodexAgentExecutor({ codexBinary: shim, timeoutMs: 5000 });
  const receipt = await executor.execute({ role: 'writer', workspacePath: root, instructions: 'write a fixture', sandbox: 'workspace-write' });
  assert.equal(receipt.status, 'agent_execution_completed');
  assert.deepEqual(receipt.changedPaths, ['agent-output.txt']);
  assert.equal(receipt.externalActionPerformed, false);
});

test('multi-language empirical executor runs Python in kernel sandbox and persists declared outputs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-empirical-executor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  fs.mkdirSync(source);
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(source, 'run.py'), 'import json\njson.dump({"metric": 0.91}, open("results.json", "w"))\n');
  const runner = createOsSandboxedWorkerRunner({ allowedExecutables: ['python3'], allowedRoots: [source], allowedOutputRoots: [output] });
  const executor = createMultiLanguageEmpiricalExecutor({ workerRunner: runner });
  const receipt = executor.execute({ language: 'python', entrypoint: 'run.py', cwd: source, sourceRoot: source, outputDirectory: output, outputPaths: ['results.json'], timeoutMs: 10000 });
  assert.equal(receipt.status, 'empirical_execution_completed');
  assert.equal(receipt.isolation.kernelNetworkIsolationVerified, true);
  assert.equal(receipt.artifacts.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'results.json'), 'utf8')), { metric: 0.91 });
});

test('structured Ollama adapter enforces schema and per-node output budgets', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-ollama-executor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.tex'), 'before\n');
  let request = null;
  const executor = createOllamaStructuredAgentExecutor({
    model: 'fixture-model',
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, json: async () => ({ response: JSON.stringify({ status: 'completed', summary: 'edited', edits: [{ path: 'main.tex', content: 'after\n' }], checks: [], blockers: [] }), done_reason: 'stop', eval_count: 23 }) };
    },
  });
  const receipt = await executor.execute({ role: 'writer', workspacePath: root, instructions: 'edit', outputTokenBudget: 777 });
  assert.equal(request.options.num_predict, 777);
  assert.equal(request.format.type, 'object');
  assert.equal(receipt.outputDoneReason, 'stop');
  assert.equal(receipt.outputTokenCount, 23);
  assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'after\n');
});

test('campaign executor repairs a failed empirical command before completing the node', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-empirical-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.tex'), 'fixture');
  fs.writeFileSync(path.join(root, 'run.py'), 'raise RuntimeError("fixture")\n');
  let empiricalCalls = 0;
  const executor = createCampaignNodeExecutor({
    runtimeRoot: path.join(root, 'runtime'),
    empiricalExecutor: {
      execute() {
        empiricalCalls += 1;
        return empiricalCalls === 1
          ? { status: 'empirical_execution_failed', blockers: ['os_sandbox_command_failed'], stderrTail: 'RuntimeError: fixture' }
          : { status: 'empirical_execution_completed', multiLanguageEmpiricalReceiptHash: 'sha256:empirical' };
      },
    },
    agentExecutor: {
      async execute(input) {
        assert.equal(input.role, 'empirical-code-repair');
        assert.match(input.instructions, /RuntimeError: fixture/);
        return { agentExecutionReceiptHash: 'sha256:repair' };
      },
    },
  });
  const receipt = await executor.execute({
    campaign: { campaign_id: 'campaign', paper_id: 'paper', spec: { sourceWorkspace: root, languages: ['python'] } },
    node: { node_id: 'node', kind: 'empirical', roundIndex: 0 },
    allNodes: [],
  });
  assert.equal(empiricalCalls, 2);
  assert.equal(receipt.status, 'automation_repair_execution_completed');
});

test('generated LaTeX sanitizer converts model newline tokens and table row endings', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-latex-sanitizer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.tex'), '\\begin{tabular}{cc}\nA & B\\n \\hline\n\\end{tabular}\n**Observed**\\n\\end{document}\n');
  const receipt = sanitizeGeneratedLatex({ workspacePath: root, manuscriptPath: 'main.tex' });
  const source = fs.readFileSync(path.join(root, 'main.tex'), 'utf8');
  assert.equal(receipt.tableRowTerminatorReplacements, 1);
  assert.equal(receipt.literalNewlineReplacements, 1);
  assert.equal(receipt.markdownBoldReplacements, 1);
  assert.match(source, /A & B\\\\\n \\hline/);
  assert.match(source, /\\textbf\{Observed\}/);
});
