import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCodexAgentExecutor } from '../../paper-adapters/automation/codex-agent-executor.mjs';
import { createOllamaStructuredAgentExecutor } from '../../paper-adapters/automation/ollama-structured-agent-executor.mjs';
import { createCampaignNodeExecutor } from '../../paper-adapters/automation/campaign-node-executor.mjs';
import { createIsolatedAgentExecutor } from '../../paper-adapters/automation/isolated-agent-executor.mjs';
import { sanitizeGeneratedLatex } from '../../paper-adapters/automation/generated-latex-sanitizer.mjs';
import { createMultiLanguageEmpiricalExecutor } from '../../paper-adapters/automation/multi-language-empirical-executor.mjs';
import { createFilesystemEmpiricalCacheRepository } from '../../paper-adapters/automation/empirical-cache-repository.mjs';
import { createOsSandboxedWorkerRunner, fileSha256Hash } from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import { buildExecutorCapabilities } from '../../paper-ports/executor-capabilities.mjs';
import { runBoundedChildProcess } from '../../paper-adapters/automation/bounded-child-process.mjs';

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

test('Codex and isolated wrappers fail closed when a read-only agent mutates files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-read-only-agent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'main.tex'), 'before\n');
  const shim = path.join(root, 'codex-shim.sh');
  fs.writeFileSync(shim, '#!/bin/sh\ncat >/dev/null\nprintf "changed\\n" > main.tex\nprintf \'{"status":"completed"}\\n\'\n');
  fs.chmodSync(shim, 0o755);
  const codex = createCodexAgentExecutor({ codexBinary: shim, timeoutMs: 5000 });
  await assert.rejects(
    () => codex.execute({ role: 'reviewer', workspacePath: source, instructions: 'review', sandbox: 'read-only' }),
    (error) => error.retryable === false && error.receipt?.blockers?.includes('read_only_agent_modified_workspace'),
  );

  fs.writeFileSync(path.join(source, 'main.tex'), 'before\n');
  const delegate = {
    version: 1,
    kind: 'FixtureAgentExecutor',
    executorId: 'fixture-read-only-liar',
    capabilities: () => buildExecutorCapabilities({ executorId: 'fixture-read-only-liar', sandboxModes: ['read-only'], networkPolicy: 'none', receiptKinds: ['AgentExecutionReceipt'] }),
    async execute(input) {
      fs.writeFileSync(path.join(input.workspacePath, 'main.tex'), 'mutated\n');
      return { status: 'agent_execution_completed', agentExecutionReceiptHash: 'sha256:fixture' };
    },
  };
  const isolated = createIsolatedAgentExecutor({ delegate, isolationRoot: path.join(root, 'isolated'), keepFailedWorkspaces: false });
  await assert.rejects(
    () => isolated.execute({ workspacePath: source, role: 'reviewer', sandbox: 'read-only' }),
    (error) => error.retryable === false && error.message === 'read_only_agent_modified_workspace',
  );
  assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'before\n');
});

test('bounded child process captures hashes while capping retained output', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-bounded-process-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await runBoundedChildProcess({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write("x".repeat(8192))'],
    cwd: root,
    timeoutMs: 5000,
    maximumCapturedBytes: 256,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.length, 256);
  assert.equal(result.stdoutBytes, 8192);
  assert.equal(result.outputTruncated, true);
  assert.match(result.stdoutHash, /^sha256:[a-f0-9]{64}$/);
});

test('isolated agent workspace excludes research-data binaries and oversized files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-agent-content-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'main.tex'), 'before\n');
  fs.writeFileSync(path.join(source, 'scan.nii.gz'), Buffer.alloc(1024, 1));
  fs.writeFileSync(path.join(source, 'large.csv'), Buffer.alloc(8 * 1024 * 1024 + 1, 2));
  const derived = path.join(source, 'derived-data');
  fs.mkdirSync(derived);
  fs.writeFileSync(path.join(derived, 'part-a.bin'), Buffer.alloc(33 * 1024 * 1024, 3));
  fs.writeFileSync(path.join(derived, 'part-b.bin'), Buffer.alloc(33 * 1024 * 1024, 4));
  const delegate = {
    version: 1,
    kind: 'FixtureAgentExecutor',
    executorId: 'fixture-agent',
    capabilities: () => buildExecutorCapabilities({ executorId: 'fixture-agent', sandboxModes: ['read-only', 'workspace-write'], networkPolicy: 'none', receiptKinds: ['AgentExecutionReceipt'] }),
    async execute(input) {
      assert.equal(fs.existsSync(path.join(input.workspacePath, 'scan.nii.gz')), false);
      assert.equal(fs.existsSync(path.join(input.workspacePath, 'large.csv')), false);
      assert.equal(fs.existsSync(path.join(input.workspacePath, 'derived-data')), false);
      fs.writeFileSync(path.join(input.workspacePath, 'main.tex'), 'after\n');
      return { status: 'agent_execution_completed', agentExecutionReceiptHash: 'sha256:fixture' };
    },
  };
  const executor = createIsolatedAgentExecutor({ delegate, isolationRoot: path.join(root, 'isolated'), keepFailedWorkspaces: false });
  const receipt = await executor.execute({ workspacePath: source, role: 'writer' });
  assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'after\n');
  assert.equal(receipt.workspaceContentPolicy.researchDataBinaryExcluded, true);
  assert.deepEqual(receipt.workspaceContentPolicy.oversizedTopLevelDirectories, ['derived-data']);
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
  const receipt = executor.execute({ language: 'python', entrypoint: 'run.py', cwd: source, sourceRoot: source, outputDirectory: output, outputPaths: ['results.json'], timeoutMs: 120000 });
  assert.equal(receipt.status, 'empirical_execution_completed', JSON.stringify({ blockers: receipt.blockers, exitCode: receipt.exitCode, stderrTail: receipt.stderrTail }));
  assert.equal(receipt.isolation.kernelNetworkIsolationVerified, true);
  assert.equal(receipt.artifacts.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'results.json'), 'utf8')), { metric: 0.91 });
});

test('sandbox injects only declared dataset environment paths and read-only mounts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-dataset-environment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const dataset = path.join(root, 'trial.csv');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'run.py'), 'print(1)\n');
  fs.writeFileSync(dataset, 'subject,value\n1,2\n');
  let command = [];
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'],
    allowedRoots: [source],
    allowedDatasetRoots: [root],
    probe: { available: true, backend: 'bubblewrap', status: 'os_sandbox_available' },
    executor(_launcher, args) { command = args; return { status: 0, stdout: '', stderr: '' }; },
  });
  const receipt = runner.run({
    executable: 'python3',
    args: ['run.py'],
    cwd: source,
    sourceRoot: source,
    env: { HEPTA_DATASET_TRIAL: '/datasets/trial', UNDECLARED_SECRET: 'must-not-pass' },
    datasetMounts: [{ name: 'trial', source: dataset, readOnly: true, manifestHash: fileSha256Hash(dataset), licenseId: 'CC-BY-4.0' }],
  });
  assert.equal(receipt.ok, true);
  assert.ok(command.includes('HEPTA_DATASET_TRIAL'));
  assert.ok(command.includes('/datasets/trial'));
  assert.equal(command.some((value) => String(value).includes('UNDECLARED_SECRET')), false);
  assert.equal(receipt.datasetMounts[0].sourceType, 'file');
  assert.equal(receipt.datasetMounts[0].fileName, 'trial.csv');
});

test('empirical cache is source-bound and verifies artifact hashes before replay', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-empirical-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'run.py'), 'print("fixture")\n');
  let runs = 0;
  const workerRunner = {
    availability: { available: true },
    run(spec) {
      runs += 1;
      fs.mkdirSync(spec.outputDirectory, { recursive: true });
      const content = '{"metric":1}\n';
      fs.writeFileSync(path.join(spec.outputDirectory, 'results.json'), content);
      return { ok: true, receiptHash: 'sha256:runner', artifacts: [{ path: 'results.json', sha256: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`, bytes: Buffer.byteLength(content) }], isolation: { kernelNetworkIsolationVerified: true }, datasetMounts: [], exitCode: 0 };
    },
  };
  const executor = createMultiLanguageEmpiricalExecutor({ workerRunner, cache: createFilesystemEmpiricalCacheRepository({ root: path.join(root, 'cache') }) });
  const spec = { language: 'python', entrypoint: 'run.py', cwd: source, sourceRoot: source, outputDirectory: output, outputPaths: ['results.json'] };
  assert.equal(executor.execute(spec).cacheHit, false);
  fs.rmSync(output, { recursive: true, force: true });
  const replay = executor.execute(spec);
  assert.equal(replay.cacheHit, true);
  assert.equal(runs, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'results.json'), 'utf8')).metric, 1);
  const cacheArtifact = fs.readdirSync(path.join(root, 'cache')).map((entry) => path.join(root, 'cache', entry, 'artifacts', 'results.json')).find((candidate) => fs.existsSync(candidate));
  fs.writeFileSync(cacheArtifact, '{"metric":999}\n');
  fs.rmSync(output, { recursive: true, force: true });
  assert.equal(executor.execute(spec).cacheHit, false);
  assert.equal(runs, 2);
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
  fs.writeFileSync(path.join(root, 'run.py'), 'import os\nfixture = os.environ["HEPTA_DATASET_FIXTURE"]\nraise RuntimeError("fixture")\n');
  let empiricalCalls = 0;
  const executor = createCampaignNodeExecutor({
    runtimeRoot: path.join(root, 'runtime'),
    empiricalExecutor: {
      execute(spec) {
        empiricalCalls += 1;
        assert.equal(spec.env.HEPTA_OUTPUT_DIR, '/output');
        if (empiricalCalls === 1) return { status: 'empirical_execution_failed', blockers: ['os_sandbox_command_failed'], stderrTail: 'RuntimeError: fixture' };
        fs.mkdirSync(spec.outputDirectory, { recursive: true });
        fs.writeFileSync(path.join(spec.outputDirectory, 'results.json'), JSON.stringify({ score: 1 }));
        fs.writeFileSync(path.join(spec.outputDirectory, 'results.csv'), 'score\n1\n');
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
  assert.equal(receipt.status, 'automation_repair_execution_completed');
  assert.equal(receipt.runnerReceiptHash, 'sha256:runner');
  assert.equal(receipt.containerImage, 'fixture:locked');
  assert.equal(receipt.isolation.gpuDeviceIsolationVerified, true);
  assert.equal(receipt.datasetMounts[0].manifestHash, 'sha256:data');
});

test('campaign executor repairs successful commands that violate the metric artifact contract', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-empirical-artifact-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.tex'), 'fixture');
  fs.writeFileSync(path.join(root, 'run.R'), 'quit(status=0)\n');
  let calls = 0;
  let repaired = false;
  const executor = createCampaignNodeExecutor({
    runtimeRoot: path.join(root, 'runtime'),
    empiricalExecutor: { execute(spec) {
      calls += 1;
      if (repaired) {
        fs.mkdirSync(spec.outputDirectory, { recursive: true });
        fs.writeFileSync(path.join(spec.outputDirectory, 'results.json'), '{"metric":1}\n');
        fs.writeFileSync(path.join(spec.outputDirectory, 'results.csv'), 'metric\n1\n');
      }
      return { status: 'empirical_execution_completed', multiLanguageEmpiricalReceiptHash: `sha256:run-${calls}`, artifacts: [] };
    } },
    agentExecutor: { async execute(input) {
      assert.equal(input.role, 'empirical-artifact-contract-repair');
      assert.match(input.instructions, /HEPTA_OUTPUT_DIR/);
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
  assert.equal(receipt.status, 'automation_repair_execution_completed');
  assert.equal(receipt.empiricalResultContractStatus, 'empirical_result_schema_verified');
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
