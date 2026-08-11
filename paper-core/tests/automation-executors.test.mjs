import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createCodexAgentExecutor } from '../../paper-adapters/automation/codex-agent-executor.mjs';
import { createIsolatedAgentExecutor } from '../../paper-adapters/automation/isolated-agent-executor.mjs';
import { createMultiLanguageEmpiricalExecutor } from '../../paper-adapters/automation/multi-language-empirical-executor.mjs';
import { AUTOMATION_RUNTIME_IMAGES } from '../../paper-adapters/automation/runtime-image-registry.mjs';
import { createOsSandboxedWorkerRunner } from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import { directoryMerkleHash, fileSha256Hash } from '../../paper-adapters/runtime/execution-snapshot.mjs';
import { buildExecutorCapabilities } from '../../paper-ports/executor-capabilities.mjs';
import { runBoundedChildProcess } from '../../paper-adapters/automation/bounded-child-process.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyIsolatedAgentMergeReceipt,
} from '../../paper-domain/evidence/isolated-agent-merge-receipt-contract.mjs';
import {
  buildAgentWorkspacePostimageBinding,
} from '../../paper-domain/evidence/agent-execution-receipt-contract.mjs';
import {
  empiricalCodeWorkspaceMutationPolicy,
  formalWorkspaceMutationPolicy,
} from '../../paper-application/automation/campaign-agent-policy.mjs';
import {
  fixtureContainerExecutionIdentity,
  withFixtureEnvironmentBom,
} from './empirical-environment-test-support.mjs';

function fixtureAgentReceipt(executorId, changedPaths) {
  const payload = {
    status: 'agent_execution_completed',
    executorId,
    changedPaths: Object.freeze([...changedPaths].sort()),
  };
  return Object.freeze({
    ...payload,
    agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload),
  });
}

test('policy-bound coder requests cannot execute through an unisolated provider backend', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-unisolated-coder-blocked-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shim = path.join(root, 'codex-shim.sh');
  fs.writeFileSync(shim, '#!/bin/sh\nprintf "unexpected\\n" > escaped.txt\n');
  fs.chmodSync(shim, 0o755);
  const executor = createCodexAgentExecutor({ codexBinary: shim, timeoutMs: 5000 });
  await assert.rejects(
    () => executor.execute({
      role: 'coder-python',
      workspacePath: root,
      instructions: 'write code',
      sandbox: 'workspace-write',
      requiredCapabilities: { workspaceIsolation: true },
      workspaceMutationPolicy: empiricalCodeWorkspaceMutationPolicy({ language: 'python' }),
    }),
    /executor_workspace_isolation_required/,
  );
  assert.equal(fs.existsSync(path.join(root, 'escaped.txt')), false);
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
      return fixtureAgentReceipt('fixture-read-only-liar', ['main.tex']);
    },
  };
  const isolated = createIsolatedAgentExecutor({ delegate, isolationRoot: path.join(root, 'isolated'), keepFailedWorkspaces: false });
  await assert.rejects(
    () => isolated.execute({ workspacePath: source, role: 'reviewer', sandbox: 'read-only' }),
    (error) => error.retryable === false && error.message === 'read_only_agent_modified_workspace',
  );
  assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'before\n');
});

test('formal author mutation policy rejects manuscript or canonical-spec edits before merging valid Lean changes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-author-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'main.tex'), 'authoritative manuscript\n');
  fs.writeFileSync(path.join(source, 'THEOREM_SPEC.json'), '{}\n');
  const delegate = {
    version: 1,
    kind: 'FixtureAgentExecutor',
    executorId: 'fixture-formal-author-policy',
    capabilities: () => buildExecutorCapabilities({
      executorId: 'fixture-formal-author-policy', sandboxModes: ['workspace-write'],
      networkPolicy: 'none', receiptKinds: ['AgentExecutionReceipt'],
    }),
    async execute(input) {
      fs.writeFileSync(path.join(input.workspacePath, 'Main.lean'), 'theorem valid : True := by trivial\n');
      fs.writeFileSync(path.join(input.workspacePath, 'main.tex'), 'weakened manuscript\n');
      return fixtureAgentReceipt('fixture-formal-author-policy', ['Main.lean', 'main.tex']);
    },
  };
  const isolated = createIsolatedAgentExecutor({
    delegate, isolationRoot: path.join(root, 'isolated'), keepFailedWorkspaces: false,
  });
  await assert.rejects(
    () => isolated.execute({
      workspacePath: source, role: 'formal-author', sandbox: 'workspace-write',
      workspaceMutationPolicy: formalWorkspaceMutationPolicy(),
    }),
    (error) => error.retryable === false && /workspace_mutation_forbidden:main\.tex/.test(error.message),
  );
  assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'authoritative manuscript\n');
  assert.equal(fs.existsSync(path.join(source, 'Main.lean')), false);
});

test('formal author mutation policy reserves worker-plan and Lake metadata for the host', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-host-owned-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'THEOREM_SPEC.json'), '{}\n');
  const delegate = {
    version: 1,
    kind: 'FixtureAgentExecutor',
    executorId: 'fixture-formal-host-owned-policy',
    capabilities: () => buildExecutorCapabilities({
      executorId: 'fixture-formal-host-owned-policy', sandboxModes: ['workspace-write'],
      networkPolicy: 'none', receiptKinds: ['AgentExecutionReceipt'],
    }),
    async execute(input) {
      const changedPaths = [
        'Main.lean', 'RESEARCH_WORKER_PLAN.json', 'lakefile.lean',
        'lake-manifest.json', 'lean-toolchain',
      ];
      for (const relative of changedPaths) {
        fs.writeFileSync(path.join(input.workspacePath, relative), 'agent-authored\n');
      }
      return fixtureAgentReceipt('fixture-formal-host-owned-policy', changedPaths);
    },
  };
  const isolated = createIsolatedAgentExecutor({
    delegate, isolationRoot: path.join(root, 'isolated'), keepFailedWorkspaces: false,
  });
  await assert.rejects(
    () => isolated.execute({
      workspacePath: source, role: 'formal-author', sandbox: 'workspace-write',
      workspaceMutationPolicy: formalWorkspaceMutationPolicy(),
    }),
    (error) => error.retryable === false
      && /workspace_mutation_forbidden:RESEARCH_WORKER_PLAN\.json/.test(error.message)
      && /workspace_mutation_forbidden:lakefile\.lean/.test(error.message)
      && /workspace_mutation_forbidden:lake-manifest\.json/.test(error.message)
      && /workspace_mutation_forbidden:lean-toolchain/.test(error.message),
  );
  assert.equal(fs.existsSync(path.join(source, 'Main.lean')), false);
  assert.equal(fs.existsSync(path.join(source, 'lakefile.lean')), false);
});

test('isolated merge fails closed before staging an unbounded descriptor batch', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-isolated-change-limit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'main.tex'), 'before\n');
  const delegate = {
    version: 1,
    kind: 'FixtureAgentExecutor',
    executorId: 'fixture-change-flood',
    capabilities: () => buildExecutorCapabilities({ executorId: 'fixture-change-flood', sandboxModes: ['workspace-write'], networkPolicy: 'none', receiptKinds: ['AgentExecutionReceipt'] }),
    async execute(input) {
      for (let index = 0; index < 129; index += 1) {
        fs.writeFileSync(path.join(input.workspacePath, `generated-${index}.txt`), `${index}\n`);
      }
      return fixtureAgentReceipt('fixture-agent', ['main.tex']);
    },
  };
  const isolated = createIsolatedAgentExecutor({ delegate, isolationRoot: path.join(root, 'isolated'), keepFailedWorkspaces: false });
  await assert.rejects(
    () => isolated.execute({ workspacePath: source, role: 'writer', sandbox: 'workspace-write' }),
    (error) => error.retryable === false && error.message === 'isolated_workspace_change_limit_exceeded:129:128',
  );
  assert.deepEqual(fs.readdirSync(source), ['main.tex']);
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

test('bounded child process does not spawn when its signal is already aborted', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-bounded-pre-abort-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controller = new AbortController();
  controller.abort('fixture_pre_cancelled');
  let spawnCalls = 0;
  const result = await runBoundedChildProcess({
    spawnImpl() { spawnCalls += 1; throw new Error('pre-aborted process must not spawn'); },
    executable: process.execPath,
    args: ['-e', 'process.exit(99)'],
    cwd: root,
    timeoutMs: 5000,
    signal: controller.signal,
  });
  assert.equal(spawnCalls, 0);
  assert.equal(result.aborted, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.stdoutBytes, 0);
});

test('bounded child process hard-kills a process group whose grandchild ignores SIGTERM', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-bounded-abort-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, 'late-output');
  const ready = path.join(root, 'grandchild-ready');
  const grandchildSource = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'late'),500);setInterval(()=>{},1000);`;
  const childSource = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(grandchildSource)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
  const controller = new AbortController();
  const pending = runBoundedChildProcess({ executable: process.execPath, args: ['-e', childSource], cwd: root, timeoutMs: 5000, signal: controller.signal, killGraceMs: 100 });
  const readyDeadline = Date.now() + 2000;
  while (!fs.existsSync(ready) && Date.now() < readyDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(ready), true);
  controller.abort('fixture_cancelled');
  const result = await pending;
  assert.equal(result.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(fs.existsSync(marker), false);
});

test('OS sandbox runner returns a cancelled receipt without executing a pre-aborted command', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-os-sandbox-pre-abort-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'input.txt'), 'fixture\n');
  const marker = path.join(source, 'must-not-exist');
  let syncExecutions = 0;
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: [process.execPath],
    allowedRoots: [source],
    probe: { available: true, backend: 'bubblewrap', status: 'os_sandbox_available' },
    executor() { syncExecutions += 1; return { status: 0, stdout: '', stderr: '' }; },
  });
  assert.equal(runner.version, 4);
  assert.equal('deprecatedRunInputs' in runner, false);
  const controller = new AbortController();
  controller.abort('operator_cancelled_before_dispatch');
  const receipt = await runner.run({ executable: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'late')`], cwd: source, sourceRoot: source, timeoutMs: 5000, signal: controller.signal });
  assert.equal(syncExecutions, 0);
  assert.equal(receipt.status, 'os_sandbox_worker_cancelled');
  assert.equal(receipt.ok, false);
  assert.ok(receipt.blockers.includes('os_sandbox_command_aborted'));
  assert.equal(fs.existsSync(marker), false);
});

test('multi-language empirical execution propagates AbortSignal and returns a cancelled receipt', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-empirical-abort-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'run.mjs'), 'setInterval(() => {}, 1000);\n');
  const workerRunner = withFixtureEnvironmentBom({
    availability: { available: true },
    async run(spec) {
      const result = await runBoundedChildProcess({ executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: root, timeoutMs: 5000, signal: spec.signal, killGraceMs: 100 });
      return { ok: false, status: result.aborted ? 'os_sandbox_worker_cancelled' : 'os_sandbox_worker_failed', exitCode: result.exitCode, blockers: result.aborted ? ['os_sandbox_command_aborted'] : ['os_sandbox_command_failed'] };
    },
  });
  const executor = createMultiLanguageEmpiricalExecutor({ workerRunner });
  const controller = new AbortController();
  const pending = executor.execute({ language: 'node', entrypoint: 'run.mjs', cwd: root, sourceRoot: root, timeoutMs: 5000, signal: controller.signal });
  setTimeout(() => controller.abort('operator_cancelled'), 50);
  const receipt = await pending;
  assert.equal(receipt.status, 'empirical_execution_cancelled');
  assert.deepEqual(receipt.blockers, ['os_sandbox_command_aborted']);
});

test('LaTeX execution writes every build artifact to the separate output root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-latex-output-root-'));
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  fs.mkdirSync(source);
  fs.mkdirSync(output);
  fs.writeFileSync(
    path.join(source, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}fixture\\end{document}\n',
  );
  let captured = null;
  const image = 'fixture/latex:locked';
  const digest = `sha256:${'c'.repeat(64)}`;
  const workerRunner = withFixtureEnvironmentBom({
    availability: { available: true, backend: 'bubblewrap' },
    resolveExecutionRuntimeIdentity() {
      return fixtureContainerExecutionIdentity({
        image,
        digest,
        executable: 'latexmk',
      });
    },
    run(spec) {
      captured = spec;
      return {
        ok: true,
        status: 'os_sandbox_worker_completed',
        blockers: [],
        artifacts: [{
          path: 'main.pdf',
          sha256: `sha256:${'b'.repeat(64)}`,
          bytes: 1,
        }],
        isolation: { separateOutputRootVerified: true },
        datasetMounts: [],
        runtimeIdentityHash: spec.executionIdentity.runtimeIdentityHash,
        containerImage: image,
        containerImageDigest: digest,
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
    },
  });
  const receipt = createMultiLanguageEmpiricalExecutor({
    workerRunner,
    runtimeImages: { latex: { image, executable: 'latexmk' } },
  }).execute({
    language: 'latex',
    entrypoint: 'main.tex',
    cwd: source,
    sourceRoot: source,
    outputDirectory: output,
    outputPaths: ['main.pdf'],
    requireSeparateOutputRoot: true,
    env: { HEPTA_OUTPUT_DIR: '/output' },
  });
  assert.equal(receipt.status, 'empirical_execution_completed', JSON.stringify(receipt));
  assert.deepEqual(captured.args, [
    '-pdf',
    '-interaction=nonstopmode',
    '-halt-on-error',
    '-outdir=/output',
    'main.tex',
  ]);
  assert.equal(captured.requireSeparateOutputRoot, true);
  assert.deepEqual(captured.outputPaths, ['main.pdf']);
});

test('LaTeX execution rejects benchmark and dataset authority before invoking a worker', () => {
  let workerCalls = 0;
  const workerRunner = withFixtureEnvironmentBom({
    availability: { available: true, backend: 'bubblewrap' },
    run() {
      workerCalls += 1;
      throw new Error('worker_must_not_run');
    },
  });
  const receipt = createMultiLanguageEmpiricalExecutor({ workerRunner }).execute({
    language: 'latex',
    entrypoint: 'main.tex',
    cwd: '/tmp',
    sourceRoot: '/tmp',
    outputDirectory: '/tmp/output',
    datasetMounts: [{ name: 'forbidden' }],
    benchmarkSelector: { forbidden: true },
    env: { HEPTA_OUTPUT_DIR: '/output' },
  });
  assert.equal(receipt.status, 'empirical_compile_authority_invalid');
  assert.equal(receipt.repairEligible, false);
  assert.deepEqual(receipt.blockers, ['latex_compile_benchmark_or_dataset_authority_forbidden']);
  assert.equal(workerCalls, 0);
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
  const automationResults = path.join(source, 'automation-results');
  fs.mkdirSync(automationResults);
  fs.writeFileSync(
    path.join(automationResults, 'EMPIRICAL_ASSERTION_AUTHORITY.json'),
    '{"kind":"EmpiricalAssertionAuthority"}\n',
  );
  const historicalResults = path.join(automationResults, 'historical-results.ndjson');
  fs.writeFileSync(historicalResults, '');
  fs.truncateSync(historicalResults, 64 * 1024 * 1024 + 1);
  const delegate = {
    version: 1,
    kind: 'FixtureAgentExecutor',
    executorId: 'fixture-agent',
    capabilities: () => buildExecutorCapabilities({ executorId: 'fixture-agent', sandboxModes: ['read-only', 'workspace-write'], networkPolicy: 'none', receiptKinds: ['AgentExecutionReceipt'] }),
    async execute(input) {
      assert.equal(fs.statSync(input.workspacePath).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(input.workspacePath, 'main.tex')).mode & 0o777, 0o600);
      assert.equal(fs.existsSync(path.join(input.workspacePath, 'scan.nii.gz')), false);
      assert.equal(fs.existsSync(path.join(input.workspacePath, 'large.csv')), false);
      assert.equal(fs.existsSync(path.join(input.workspacePath, 'derived-data')), false);
      assert.equal(
        fs.readFileSync(
          path.join(input.workspacePath, 'automation-results', 'EMPIRICAL_ASSERTION_AUTHORITY.json'),
          'utf8',
        ),
        '{"kind":"EmpiricalAssertionAuthority"}\n',
      );
      assert.equal(
        fs.existsSync(path.join(input.workspacePath, 'automation-results', 'historical-results.ndjson')),
        false,
      );
      fs.writeFileSync(path.join(input.workspacePath, 'main.tex'), 'after\n');
      return fixtureAgentReceipt('fixture-agent', ['main.tex']);
    },
  };
  const executor = createIsolatedAgentExecutor({ delegate, isolationRoot: path.join(root, 'isolated'), keepFailedWorkspaces: false });
  const receipt = await executor.execute({ workspacePath: source, role: 'writer' });
  assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'after\n');
  assert.equal(fs.statSync(path.join(root, 'isolated')).mode & 0o777, 0o700);
  assert.equal(receipt.workspaceContentPolicy.researchDataBinaryExcluded, true);
  assert.deepEqual(receipt.workspaceContentPolicy.oversizedTopLevelDirectories, [
    'automation-results',
    'derived-data',
  ]);
  assert.equal(verifyIsolatedAgentMergeReceipt(receipt.isolatedAgentMergeReceipt, {
    delegateAgentExecutionReceipt: receipt,
  }), true);
  const { isolatedAgentMergeReceiptHash: _mergeHash, ...mergePayload } =
    receipt.isolatedAgentMergeReceipt;
  const executorTamperPayload = { ...mergePayload, delegateExecutorId: 'attacker-executor' };
  const executorTamper = {
    ...executorTamperPayload,
    isolatedAgentMergeReceiptHash:
      hashRecord('IsolatedAgentMergeReceipt', executorTamperPayload),
  };
  assert.equal(verifyIsolatedAgentMergeReceipt(executorTamper, {
    delegateAgentExecutionReceipt: receipt,
  }), false);
  const pathTamperPayload = {
    ...mergePayload,
    sourcePostimage: [{ ...mergePayload.sourcePostimage[0], path: '../main.tex' }],
  };
  const pathTamper = {
    ...pathTamperPayload,
    isolatedAgentMergeReceiptHash:
      hashRecord('IsolatedAgentMergeReceipt', pathTamperPayload),
  };
  assert.equal(verifyIsolatedAgentMergeReceipt(pathTamper, {
    delegateAgentExecutionReceipt: receipt,
  }), false);

  const rehashMerge = ({ delegateReceipt, changedPaths, postimage, before, after }) => {
    const rows = (values) => [...values].sort((left, right) => left.path.localeCompare(right.path));
    const sourcePreimage = rows(before);
    const isolatedPreimage = rows(before);
    const isolatedPostimage = rows(after);
    const sourcePostimage = rows(after);
    const sourcePreimageManifestHash = hashRecord(
      'IsolatedAgentWorkspaceSnapshot', sourcePreimage,
    );
    const isolatedPreimageManifestHash = hashRecord(
      'IsolatedAgentWorkspaceSnapshot', isolatedPreimage,
    );
    const isolatedPostimageManifestHash = hashRecord(
      'IsolatedAgentWorkspaceSnapshot', isolatedPostimage,
    );
    const sourcePostimageManifestHash = hashRecord(
      'IsolatedAgentWorkspaceSnapshot', sourcePostimage,
    );
    const identity = {
      delegateAgentExecutionReceiptHash: delegateReceipt.agentExecutionReceiptHash,
      changedPaths,
      agentWorkspacePostimageBindingHash: postimage.agentWorkspacePostimageBindingHash,
      sourcePreimageManifestHash,
      isolatedPreimageManifestHash,
      isolatedPostimageManifestHash,
      sourcePostimageManifestHash,
    };
    const payload = {
      ...mergePayload,
      delegateExecutorId: delegateReceipt.executorId,
      delegateAgentExecutionReceiptHash: delegateReceipt.agentExecutionReceiptHash,
      changedPaths,
      agentWorkspacePostimageBinding: postimage,
      agentWorkspacePostimageBindingHash: postimage.agentWorkspacePostimageBindingHash,
      sourcePreimage,
      sourcePreimageManifestHash,
      isolatedPreimage,
      isolatedPreimageManifestHash,
      isolatedPostimage,
      isolatedPostimageManifestHash,
      sourcePostimage,
      sourcePostimageManifestHash,
      mergeIdentityHash: hashRecord('IsolatedAgentMergeIdentity', identity),
    };
    return {
      ...payload,
      isolatedAgentMergeReceiptHash: hashRecord('IsolatedAgentMergeReceipt', payload),
    };
  };
  const ghostDelegate = fixtureAgentReceipt('fixture-agent', ['ghost.tex']);
  const ghostPostimage = buildAgentWorkspacePostimageBinding({
    changedPaths: ['ghost.tex'],
    files: [{ path: 'ghost.tex', hash: null }],
  });
  const ghost = rehashMerge({
    delegateReceipt: ghostDelegate,
    changedPaths: ['ghost.tex'],
    postimage: ghostPostimage,
    before: mergePayload.sourcePreimage,
    after: mergePayload.sourcePreimage,
  });
  assert.equal(verifyIsolatedAgentMergeReceipt(ghost, {
    delegateAgentExecutionReceipt: ghostDelegate,
  }), false);

  const unlistedHash = hashRecord('UnlistedIsolatedAgentFile', { value: 'attacker' });
  const unlisted = rehashMerge({
    delegateReceipt: receipt,
    changedPaths: mergePayload.changedPaths,
    postimage: mergePayload.agentWorkspacePostimageBinding,
    before: mergePayload.sourcePreimage,
    after: [
      ...mergePayload.sourcePostimage,
      { path: 'unlisted.tex', hash: unlistedHash },
    ],
  });
  assert.equal(verifyIsolatedAgentMergeReceipt(unlisted, {
    delegateAgentExecutionReceipt: receipt,
  }), false);
});

test('outcome-blind isolation does not restore authority from an oversized results directory', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-agent-outcome-blind-authority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const automationResults = path.join(source, 'automation-results');
  fs.mkdirSync(automationResults, { recursive: true });
  fs.writeFileSync(path.join(source, 'main.tex'), 'before\n');
  fs.writeFileSync(
    path.join(automationResults, 'EMPIRICAL_ASSERTION_AUTHORITY.json'),
    '{"kind":"EmpiricalAssertionAuthority"}\n',
  );
  const historicalResults = path.join(automationResults, 'historical-results.ndjson');
  fs.writeFileSync(historicalResults, '');
  fs.truncateSync(historicalResults, 64 * 1024 * 1024 + 1);
  const delegate = {
    version: 1,
    kind: 'FixtureAgentExecutor',
    executorId: 'fixture-outcome-blind-authority',
    capabilities: () => buildExecutorCapabilities({
      executorId: 'fixture-outcome-blind-authority',
      sandboxModes: ['workspace-write'],
      networkPolicy: 'none',
      receiptKinds: ['AgentExecutionReceipt'],
    }),
    async execute(input) {
      assert.equal(fs.existsSync(path.join(input.workspacePath, 'automation-results')), false);
      return fixtureAgentReceipt('fixture-outcome-blind-authority', []);
    },
  };
  const executor = createIsolatedAgentExecutor({
    delegate,
    isolationRoot: path.join(root, 'isolated'),
    keepFailedWorkspaces: false,
  });
  const receipt = await executor.execute({
    workspacePath: source,
    role: 'coder-python',
    sandbox: 'workspace-write',
    isolationPolicy: { outcomeBlind: true },
    workspaceMutationPolicy: {
      allowedPaths: ['main.tex'],
      allowedPrefixes: [],
      allowedExtensions: [],
      forbiddenPaths: [],
      forbiddenExtensions: [],
    },
  });
  assert.deepEqual(receipt.changedPaths, []);
  assert.equal(
    fs.readFileSync(
      path.join(automationResults, 'EMPIRICAL_ASSERTION_AUTHORITY.json'),
      'utf8',
    ),
    '{"kind":"EmpiricalAssertionAuthority"}\n',
  );
});

test('invalid retained empirical authority fails before the isolated delegate starts', async (t) => {
  for (const authorityType of ['symlink', 'directory', 'oversized-file']) {
    await t.test(authorityType, async (subtest) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `hepta-agent-invalid-authority-${authorityType}-`));
      subtest.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const source = path.join(root, 'source');
      const automationResults = path.join(source, 'automation-results');
      fs.mkdirSync(automationResults, { recursive: true });
      fs.writeFileSync(path.join(source, 'main.tex'), 'before\n');
      const authority = path.join(automationResults, 'EMPIRICAL_ASSERTION_AUTHORITY.json');
      if (authorityType === 'symlink') fs.symlinkSync('../main.tex', authority);
      else if (authorityType === 'directory') fs.mkdirSync(authority);
      else {
        fs.writeFileSync(authority, '');
        fs.truncateSync(authority, 8 * 1024 * 1024 + 1);
      }
      const historicalResults = path.join(automationResults, 'historical-results.ndjson');
      fs.writeFileSync(historicalResults, '');
      fs.truncateSync(historicalResults, 64 * 1024 * 1024 + 1);
      let delegateCalls = 0;
      const delegate = {
        version: 1,
        kind: 'FixtureAgentExecutor',
        executorId: `fixture-invalid-authority-${authorityType}`,
        capabilities: () => buildExecutorCapabilities({
          executorId: `fixture-invalid-authority-${authorityType}`,
          sandboxModes: ['workspace-write'],
          networkPolicy: 'none',
          receiptKinds: ['AgentExecutionReceipt'],
        }),
        async execute() {
          delegateCalls += 1;
          return fixtureAgentReceipt(`fixture-invalid-authority-${authorityType}`, []);
        },
      };
      const executor = createIsolatedAgentExecutor({
        delegate,
        isolationRoot: path.join(root, 'isolated'),
        keepFailedWorkspaces: false,
      });
      await assert.rejects(
        () => executor.execute({ workspacePath: source, role: 'writer' }),
        (error) => error.retryable === false
          && /isolated_workspace_required_evidence_invalid:automation-results\/EMPIRICAL_ASSERTION_AUTHORITY\.json/.test(error.message),
      );
      assert.equal(delegateCalls, 0);
    });
  }
});

test('retained empirical authority remains system-owned in an isolated workspace', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-agent-authority-system-owned-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const automationResults = path.join(source, 'automation-results');
  fs.mkdirSync(automationResults, { recursive: true });
  fs.writeFileSync(path.join(source, 'main.tex'), 'before\n');
  const authority = path.join(automationResults, 'EMPIRICAL_ASSERTION_AUTHORITY.json');
  fs.writeFileSync(authority, '{"kind":"EmpiricalAssertionAuthority"}\n');
  const historicalResults = path.join(automationResults, 'historical-results.ndjson');
  fs.writeFileSync(historicalResults, '');
  fs.truncateSync(historicalResults, 64 * 1024 * 1024 + 1);
  const delegate = {
    version: 1,
    kind: 'FixtureAgentExecutor',
    executorId: 'fixture-authority-system-owned',
    capabilities: () => buildExecutorCapabilities({
      executorId: 'fixture-authority-system-owned',
      sandboxModes: ['workspace-write'],
      networkPolicy: 'none',
      receiptKinds: ['AgentExecutionReceipt'],
    }),
    async execute(input) {
      fs.writeFileSync(
        path.join(input.workspacePath, 'automation-results', 'EMPIRICAL_ASSERTION_AUTHORITY.json'),
        '{"kind":"forged"}\n',
      );
      return fixtureAgentReceipt('fixture-authority-system-owned', [
        'automation-results/EMPIRICAL_ASSERTION_AUTHORITY.json',
      ]);
    },
  };
  const executor = createIsolatedAgentExecutor({
    delegate,
    isolationRoot: path.join(root, 'isolated'),
    keepFailedWorkspaces: false,
  });
  await assert.rejects(
    () => executor.execute({
      workspacePath: source,
      role: 'writer',
      sandbox: 'workspace-write',
    }),
    /workspace_mutation_system_owned:automation-results\/EMPIRICAL_ASSERTION_AUTHORITY\.json/,
  );
  assert.equal(
    fs.readFileSync(authority, 'utf8'),
    '{"kind":"EmpiricalAssertionAuthority"}\n',
  );
});

test('isolated agent clone and diff exclude materialization recovery state', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-agent-recovery-exclusion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'main.tex'), 'before\n');
  const sourceRecovery = path.join(source, '.hepta-materialization-recovery');
  fs.mkdirSync(sourceRecovery);
  fs.writeFileSync(path.join(sourceRecovery, 'completed-operation.tombstone'), 'source recovery state\n');
  const delegate = {
    version: 1,
    kind: 'FixtureAgentExecutor',
    executorId: 'fixture-recovery-exclusion',
    capabilities: () => buildExecutorCapabilities({ executorId: 'fixture-recovery-exclusion', sandboxModes: ['workspace-write'], networkPolicy: 'none', receiptKinds: ['AgentExecutionReceipt'] }),
    async execute(input) {
      const isolatedRecovery = path.join(input.workspacePath, '.hepta-materialization-recovery');
      assert.equal(fs.existsSync(isolatedRecovery), false);
      fs.mkdirSync(isolatedRecovery);
      fs.writeFileSync(path.join(isolatedRecovery, 'agent-operation.tombstone'), 'agent recovery state\n');
      fs.writeFileSync(path.join(input.workspacePath, 'main.tex'), 'after\n');
      return fixtureAgentReceipt('fixture-recovery-exclusion', ['main.tex']);
    },
  };
  const executor = createIsolatedAgentExecutor({ delegate, isolationRoot: path.join(root, 'isolated'), keepFailedWorkspaces: false });
  const receipt = await executor.execute({ workspacePath: source, role: 'writer', sandbox: 'workspace-write' });

  assert.deepEqual(receipt.changedPaths, ['main.tex']);
  assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'after\n');
  assert.equal(fs.readFileSync(path.join(sourceRecovery, 'completed-operation.tombstone'), 'utf8'), 'source recovery state\n');
  assert.equal(fs.existsSync(path.join(sourceRecovery, 'agent-operation.tombstone')), false);
});

test('multi-language empirical executor runs Python in kernel sandbox and persists declared outputs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-empirical-executor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  fs.mkdirSync(source);
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(source, 'run.py'), 'import json\njson.dump({"metric": 0.91}, open("results.json", "w"))\n');
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'], allowedRoots: [source], allowedOutputRoots: [output],
    dockerImage: AUTOMATION_RUNTIME_IMAGES.python.image,
  });
  if (!runner.availability.available) { t.skip('pinned Python sandbox runtime unavailable'); return; }
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
  let mountedDatasetSource = null;
  let mountedDatasetContent = null;
  let mountedDatasetIsFile = false;
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'],
    allowedRoots: [source],
    allowedDatasetRoots: [dataset],
    probe: { available: true, backend: 'bubblewrap', status: 'os_sandbox_available' },
    executor(_launcher, args) {
      command = args;
      const targetIndex = args.indexOf('/datasets/trial');
      mountedDatasetSource = args[targetIndex - 1];
      mountedDatasetIsFile = fs.lstatSync(mountedDatasetSource).isFile();
      mountedDatasetContent = fs.readFileSync(mountedDatasetSource, 'utf8');
      return { status: 0, stdout: '', stderr: '' };
    },
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
  assert.equal(receipt.datasetMounts[0].snapshotManifestHash, receipt.datasetMounts[0].manifestHash);
  assert.equal(receipt.datasetMounts[0].snapshotVerifiedAfterExecution, true);
  const datasetTargetIndex = command.indexOf('/datasets/trial');
  assert.ok(datasetTargetIndex > 0);
  assert.equal(command[datasetTargetIndex - 1], mountedDatasetSource);
  assert.notEqual(mountedDatasetSource, dataset);
  assert.equal(mountedDatasetIsFile, true);
  assert.equal(mountedDatasetContent, 'subject,value\n1,2\n');
  assert.ok(command.includes('--nproc=128:128'));
  assert.equal(receipt.isolation.processLimitVerified, true);
  assert.equal(receipt.isolation.processLimitMechanism, 'rlimit-nproc');
  assert.equal(receipt.isolation.resourceLimitsVerified, true);
});

test('Docker sandbox executes and receipts an immutable image digest instead of a mutable tag', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-sandbox-image-digest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'run.py'), 'print(1)\n');
  const image = 'fixture/runtime:latest';
  const digest = `sha256:${'d'.repeat(64)}`;
  let command = [];
  let resolutions = 0;
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'],
    allowedRoots: [source],
    allowedContainerImages: [image],
    probe: { available: true, backend: 'docker', status: 'os_sandbox_available', image },
    imageDigestResolver: (candidate) => { resolutions += 1; return candidate === image ? digest : null; },
    executor(_launcher, args) { command = args; return { status: 0, stdout: '', stderr: '' }; },
  });
  const receipt = runner.run({ executable: 'python3', containerImage: image, containerExecutable: 'python3', args: ['run.py'], cwd: source, sourceRoot: source });
  assert.equal(receipt.ok, true, JSON.stringify(receipt.blockers));
  assert.equal(receipt.containerImage, image);
  assert.equal(receipt.containerImageDigest, digest);
  assert.equal(receipt.isolation.immutableContainerImageVerified, true);
  assert.ok(command.includes(digest));
  assert.equal(command.includes(image), false);
  assert.equal(resolutions, 1);
});

test('Docker sandbox default resolver inspects a configured tag exactly once', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-default-image-resolution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const docker = path.join(root, 'docker-shim.sh');
  const log = path.join(root, 'docker.log');
  const image = 'fixture/default:latest';
  const digest = `sha256:${'c'.repeat(64)}`;
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'run.py'), 'print(1)\n');
  fs.writeFileSync(docker, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nprintf '%s\\n' '[{"Id":"sha256:${'f'.repeat(64)}","Descriptor":{"digest":"${digest}","mediaType":"application/vnd.oci.image.manifest.v1+json"},"Os":"linux","Architecture":"amd64"}]'\n`);
  fs.chmodSync(docker, 0o755);
  let command = [];
  const runner = createOsSandboxedWorkerRunner({
    docker,
    allowedExecutables: ['python3'],
    allowedRoots: [source],
    allowedContainerImages: [image],
    probe: { available: true, backend: 'docker', status: 'os_sandbox_available', image },
    executor(_launcher, args) { command = args; return { status: 0, stdout: '', stderr: '' }; },
  });
  const receipt = runner.run({ executable: 'python3', containerImage: image, containerExecutable: 'python3', args: ['run.py'], cwd: source, sourceRoot: source });
  assert.equal(receipt.ok, true, JSON.stringify(receipt.blockers));
  assert.equal(receipt.containerImageDigest, digest);
  assert.ok(command.includes(digest));
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [`image inspect ${image}`]);
});

test('runner accepts only its own single-use execution identity and rejects removed, raw, or forged identity inputs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runner-identity-capability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const image = 'fixture/runtime:capability';
  const digest = `sha256:${'7'.repeat(64)}`;
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'run.py'), 'print(1)\n');
  let resolutions = 0;
  let executions = 0;
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'], allowedRoots: [source], allowedContainerImages: [image],
    probe: { available: true, backend: 'docker', status: 'os_sandbox_available', image },
    imageDigestResolver(candidate) { resolutions += 1; return candidate === image ? digest : null; },
    executor() { executions += 1; return { status: 0, stdout: '', stderr: '' }; },
  });
  const request = { executable: 'python3', containerImage: image, containerExecutable: 'python3', args: ['run.py'], cwd: source, sourceRoot: source };
  const raw = runner.run({ ...request, containerImageDigest: digest });
  assert.equal(raw.ok, false);
  assert.ok(raw.blockers.includes('worker_run_input_removed:containerImageDigest'));
  assert.equal(resolutions, 0);
  const legacyIdentity = runner.resolveExecutionRuntimeIdentity({ executable: 'python3', containerImage: image, containerExecutable: 'python3' });
  const legacy = runner.run({ ...request, containerImageIdentity: legacyIdentity });
  assert.equal(legacy.ok, false);
  assert.ok(legacy.blockers.includes('worker_run_input_removed:containerImageIdentity'));
  const acceptedLegacyIdentity = runner.run({ ...request, executionIdentity: legacyIdentity });
  assert.equal(acceptedLegacyIdentity.ok, true, JSON.stringify(acceptedLegacyIdentity.blockers));
  const forged = runner.run({ ...request, executionIdentity: fixtureContainerExecutionIdentity({ image, digest }) });
  assert.equal(forged.ok, false);
  assert.ok(forged.blockers.includes('worker_execution_identity_capability_invalid'));
  const identity = runner.resolveExecutionRuntimeIdentity({ executable: 'python3', containerImage: image, containerExecutable: 'python3' });
  const accepted = runner.run({ ...request, executionIdentity: identity });
  assert.equal(accepted.ok, true, JSON.stringify(accepted.blockers));
  assert.equal(accepted.runtimeIdentityHash, identity.runtimeIdentityHash);
  const replay = runner.run({ ...request, executionIdentity: identity });
  assert.equal(replay.ok, false);
  assert.ok(replay.blockers.includes('worker_execution_identity_capability_consumed'));
  assert.equal(executions, 2);
  assert.equal(resolutions, 2);
});

test('hybrid and host execution identities reject executable drift and workspace copy races', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-executable-identity-drift-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const executable = path.join(source, 'worker.sh');
  const image = 'fixture/fallback:executable-drift';
  const digest = `sha256:${'5'.repeat(64)}`;
  const executableA = '#!/bin/sh\nprintf A\n';
  const executableB = '#!/bin/sh\nprintf B\n';
  fs.mkdirSync(source);
  fs.writeFileSync(executable, executableA);
  fs.chmodSync(executable, 0o755);
  let mutateAfterSnapshot = false;
  let executions = 0;
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: [executable], allowedRoots: [source], dockerImage: image,
    probe: { available: true, backend: 'docker', status: 'os_sandbox_available', image },
    imageDigestResolver(candidate) { return candidate === image ? digest : null; },
    runtimeExecutableSnapshotObserver() { if (mutateAfterSnapshot) fs.writeFileSync(executable, executableB); },
    executor() { executions += 1; return { status: 0, stdout: '', stderr: '' }; },
  });
  const request = { executable, cwd: source, sourceRoot: source };
  const staleIdentity = runner.resolveExecutionRuntimeIdentity({ executable });
  fs.writeFileSync(executable, executableB);
  const stale = runner.run({ ...request, executionIdentity: staleIdentity });
  assert.equal(stale.ok, false);
  assert.ok(stale.blockers.includes('worker_hybrid_executable_identity_mismatch'));

  fs.writeFileSync(executable, executableA);
  const raceIdentity = runner.resolveExecutionRuntimeIdentity({ executable });
  mutateAfterSnapshot = true;
  const copyRace = runner.run({ ...request, executionIdentity: raceIdentity });
  assert.equal(copyRace.ok, false);
  assert.ok(copyRace.blockers.includes('worker_workspace_executable_snapshot_mismatch'));

  fs.writeFileSync(executable, executableA);
  const hostRunner = createOsSandboxedWorkerRunner({
    allowedExecutables: [executable], allowedRoots: [source],
    probe: { available: true, backend: 'bubblewrap', status: 'os_sandbox_available', processLimit: { available: true, mechanism: 'fixture' } },
    executor() { executions += 1; return { status: 0, stdout: '', stderr: '' }; },
  });
  const staleHostIdentity = hostRunner.resolveExecutionRuntimeIdentity({ executable });
  fs.writeFileSync(executable, executableB);
  const staleHost = hostRunner.run({ ...request, executionIdentity: staleHostIdentity });
  assert.equal(staleHost.ok, false);
  assert.ok(staleHost.blockers.includes('worker_host_executable_identity_mismatch'));
  assert.equal(executions, 0);
});

test('host execution snapshots preserve an allowlisted lexical multicall name and reject unregistered aliases', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-argv0-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const elanRoot = path.join(root, '.elan');
  const bin = path.join(elanRoot, 'bin');
  const realExecutable = path.join(bin, 'elan');
  const lake = path.join(bin, 'lake');
  const unregisteredAlias = path.join(bin, 'referee-autopilot');
  fs.mkdirSync(source);
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(source, 'Lakefile.lean'), 'fixture\n');
  fs.writeFileSync(realExecutable, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(realExecutable, 0o755);
  fs.symlinkSync('elan', lake);
  fs.symlinkSync('elan', unregisteredAlias);
  let command = [];
  let executions = 0;
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: [lake], allowedRoots: [source],
    probe: { available: true, backend: 'bubblewrap', status: 'os_sandbox_available', processLimit: { available: true, mechanism: 'fixture' } },
    executor(_launcher, args) { executions += 1; command = args; return { status: 0, stdout: '', stderr: '' }; },
  });
  const identity = runner.resolveExecutionRuntimeIdentity({ executable: lake });
  assert.equal(identity.executableInvocationName, 'lake');
  assert.equal(identity.executableInvocationPath, lake);
  assert.equal(identity.resolvedExecutable, realExecutable);
  const receipt = runner.run({ executable: lake, args: ['build'], cwd: source, sourceRoot: source, executionIdentity: identity });
  assert.equal(receipt.ok, true, JSON.stringify(receipt.blockers));
  assert.equal(receipt.runtimeExecutableInvocationName, 'lake');
  assert.equal(receipt.runtimeExecutableInvocationPath, lake);
  assert.equal(receipt.runtimeExecutableOverlayTarget, realExecutable);
  assert.ok(command.includes(lake));
  assert.ok(command.includes(realExecutable));
  assert.equal(command.includes('/runtime/executable'), false);
  assert.equal(command.includes('/runtime/lake'), false);
  assert.deepEqual(command.slice(command.indexOf(elanRoot) - 1, command.indexOf(elanRoot) + 2), ['--ro-bind', elanRoot, elanRoot]);

  const rejected = runner.run({ executable: unregisteredAlias, args: ['build'], cwd: source, sourceRoot: source });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.blockers.includes('worker_executable_not_allowlisted'));
  assert.equal(executions, 1);
});

test('explicit container execution blocks a source-to-work copy race even when the source is restored before execution', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-workspace-copy-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const entrypoint = path.join(source, 'run.py');
  const image = 'fixture/runtime:workspace-snapshot';
  const digest = `sha256:${'3'.repeat(64)}`;
  const declared = 'print("declared-A")\n';
  const substituted = 'print("substituted-B")\n';
  fs.mkdirSync(source);
  fs.writeFileSync(entrypoint, declared);
  let executions = 0;
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'], allowedRoots: [source], allowedContainerImages: [image],
    probe: { available: true, backend: 'docker', status: 'os_sandbox_available', image },
    imageDigestResolver(candidate) { return candidate === image ? digest : null; },
    workspaceSnapshotObserver({ phase }) {
      if (phase === 'before_workspace_copy') fs.writeFileSync(entrypoint, substituted);
      if (phase === 'after_workspace_copy') fs.writeFileSync(entrypoint, declared);
    },
    executor() { executions += 1; return { status: 0, stdout: '', stderr: '' }; },
  });
  const identity = runner.resolveExecutionRuntimeIdentity({ executable: 'python3', containerImage: image, containerExecutable: 'python3' });
  const receipt = runner.run({ executable: 'python3', containerImage: image, containerExecutable: 'python3', executionIdentity: identity, args: ['run.py'], cwd: source, sourceRoot: source });
  assert.equal(receipt.ok, false);
  assert.ok(receipt.blockers.includes('worker_workspace_execution_snapshot_mismatch'));
  assert.notEqual(receipt.workSourceMerkleHash, receipt.sourceMerkleHashBefore);
  assert.equal(fs.readFileSync(entrypoint, 'utf8'), declared);
  assert.equal(executions, 0);
});

test('execution identity classes cannot cross explicit, hybrid, or runner-instance boundaries', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-execution-identity-classes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const image = 'fixture/runtime:class-bound';
  const digest = `sha256:${'4'.repeat(64)}`;
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'run.py'), 'print(1)\n');
  const makeRunner = () => createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'], allowedRoots: [source], allowedContainerImages: [image], dockerImage: image,
    probe: { available: true, backend: 'docker', status: 'os_sandbox_available', image },
    imageDigestResolver(candidate) { return candidate === image ? digest : null; },
    executor() { return { status: 0, stdout: '', stderr: '' }; },
  });
  const runner = makeRunner();
  assert.equal(runner.resolveContainerImageIdentity, undefined);
  const explicitIdentity = runner.resolveExecutionRuntimeIdentity({ executable: 'python3', containerImage: image, containerExecutable: 'python3' });
  const explicitAsHybrid = runner.run({ executable: 'python3', args: ['run.py'], cwd: source, sourceRoot: source, executionIdentity: explicitIdentity });
  assert.equal(explicitAsHybrid.ok, false);
  assert.ok(explicitAsHybrid.blockers.includes('worker_execution_identity_class_mismatch'));
  const hybridIdentity = runner.resolveExecutionRuntimeIdentity({ executable: 'python3' });
  const hybridAsExplicit = runner.run({ executable: 'python3', containerImage: image, containerExecutable: 'python3', args: ['run.py'], cwd: source, sourceRoot: source, executionIdentity: hybridIdentity });
  assert.equal(hybridAsExplicit.ok, false);
  assert.ok(hybridAsExplicit.blockers.includes('worker_execution_identity_class_mismatch'));
  const foreignIdentity = runner.resolveExecutionRuntimeIdentity({ executable: 'python3', containerImage: image, containerExecutable: 'python3' });
  const foreign = makeRunner().run({ executable: 'python3', containerImage: image, containerExecutable: 'python3', args: ['run.py'], cwd: source, sourceRoot: source, executionIdentity: foreignIdentity });
  assert.equal(foreign.ok, false);
  assert.ok(foreign.blockers.includes('worker_execution_identity_capability_invalid'));
});

test('multi-language execution resolves a mutable image tag once and reuses the digest in the runner', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-single-image-resolution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'run.py'), 'print(1)\n');
  const image = 'fixture/runtime:edge';
  const digest = `sha256:${'e'.repeat(64)}`;
  let resolutions = 0;
  let dockerCommand = [];
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'],
    allowedRoots: [source],
    allowedContainerImages: [image],
    probe: { available: true, backend: 'docker', status: 'os_sandbox_available', image },
    imageDigestResolver(candidate) { resolutions += 1; return candidate === image ? digest : null; },
    executor(_launcher, args) { dockerCommand = args; return { status: 0, stdout: '', stderr: '' }; },
  });
  const executor = createMultiLanguageEmpiricalExecutor({ workerRunner: runner, runtimeImages: { python: { image, executable: 'python3' } } });
  const receipt = executor.execute({ language: 'python', entrypoint: 'run.py', cwd: source, sourceRoot: source, cachePolicy: 'bypass' });
  assert.equal(receipt.status, 'empirical_execution_completed', JSON.stringify(receipt.blockers));
  assert.equal(resolutions, 1);
  assert.equal(receipt.containerImageDigest, digest);
  assert.ok(dockerCommand.includes(digest));
  assert.equal(dockerCommand.includes(image), false);
});

test('sandbox blocks a file dataset changed between declaration hash and snapshot copy', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-file-dataset-snapshot-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const dataset = path.join(root, 'trial.csv');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'run.py'), 'print(1)\n');
  fs.writeFileSync(dataset, 'declared-A\n');
  const declaredManifestHash = fileSha256Hash(dataset);
  let executions = 0;
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'], allowedRoots: [source], allowedDatasetRoots: [root],
    probe: { available: true, backend: 'bubblewrap', status: 'os_sandbox_available' },
    datasetSnapshotObserver() { fs.writeFileSync(dataset, 'undeclared-B\n'); },
    executor() { executions += 1; return { status: 0, stdout: '', stderr: '' }; },
  });
  const receipt = runner.run({
    executable: 'python3', args: ['run.py'], cwd: source, sourceRoot: source,
    datasetMounts: [{ name: 'trial', source: dataset, readOnly: true, manifestHash: declaredManifestHash, licenseId: 'MIT' }],
  });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.status, 'os_sandbox_worker_blocked');
  assert.ok(receipt.blockers.includes('worker_dataset_snapshot_materialization_failed'));
  assert.ok(receipt.blockers.includes('worker_dataset_source_changed_during_snapshot'));
  assert.equal(executions, 0);
});

test('sandbox fails closed when a file dataset changes during execution', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-file-dataset-postcheck-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const dataset = path.join(root, 'trial.csv');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'run.py'), 'print(1)\n');
  fs.writeFileSync(dataset, 'value\n1\n');
  const declaredManifestHash = fileSha256Hash(dataset);
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'], allowedRoots: [source], allowedDatasetRoots: [root],
    probe: { available: true, backend: 'bubblewrap', status: 'os_sandbox_available' },
    executor() { fs.writeFileSync(dataset, 'value\n2\n'); return { status: 0, stdout: '', stderr: '' }; },
  });
  const receipt = runner.run({
    executable: 'python3', args: ['run.py'], cwd: source, sourceRoot: source,
    datasetMounts: [{ name: 'trial', source: dataset, readOnly: true, manifestHash: declaredManifestHash, licenseId: 'MIT' }],
  });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.datasetMutationDetected, true);
  assert.equal(receipt.datasetMounts[0].manifestVerifiedAfterExecution, false);
  assert.equal(receipt.datasetMounts[0].snapshotVerifiedAfterExecution, true);
  assert.ok(receipt.blockers.includes('worker_dataset_manifest_changed_during_execution'));
});

test('directory dataset snapshots hide mutate-and-revert races from the worker', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-directory-dataset-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const datasetRoot = path.join(root, 'datasets');
  const dataset = path.join(datasetRoot, 'trial');
  const observation = path.join(dataset, 'observations.csv');
  fs.mkdirSync(source);
  fs.mkdirSync(dataset, { recursive: true });
  fs.writeFileSync(path.join(source, 'run.py'), 'print(1)\n');
  fs.writeFileSync(observation, 'declared-A\n');
  const declaredManifestHash = directoryMerkleHash(dataset);
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'], allowedRoots: [source], allowedDatasetRoots: [datasetRoot],
    probe: { available: true, backend: 'bubblewrap', status: 'os_sandbox_available' },
    executor(_launcher, command) {
      const targetIndex = command.indexOf('/datasets/trial');
      const mountedSnapshot = command[targetIndex - 1];
      assert.notEqual(mountedSnapshot, dataset);
      fs.writeFileSync(observation, 'transient-B\n');
      assert.equal(fs.readFileSync(path.join(mountedSnapshot, 'observations.csv'), 'utf8'), 'declared-A\n');
      fs.writeFileSync(observation, 'declared-A\n');
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  const receipt = runner.run({
    executable: 'python3', args: ['run.py'], cwd: source, sourceRoot: source,
    datasetMounts: [{ name: 'trial', source: dataset, readOnly: true, manifestHash: declaredManifestHash, licenseId: 'MIT' }],
  });
  assert.equal(receipt.ok, true, JSON.stringify(receipt.blockers));
  assert.equal(receipt.datasetMounts[0].manifestVerifiedAfterExecution, true);
  assert.equal(receipt.datasetMounts[0].snapshotVerifiedAfterExecution, true);
});

test('sandbox fails closed when a directory dataset changes during execution', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-sandbox-dataset-postcheck-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const datasets = path.join(root, 'datasets');
  const dataset = path.join(datasets, 'trial');
  fs.mkdirSync(source);
  fs.mkdirSync(dataset, { recursive: true });
  fs.writeFileSync(path.join(source, 'run.py'), 'print(1)\n');
  fs.writeFileSync(path.join(dataset, 'observations.csv'), 'value\n1\n');
  const declaredManifestHash = directoryMerkleHash(dataset);
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'], allowedRoots: [source], allowedDatasetRoots: [datasets],
    probe: { available: true, backend: 'bubblewrap', status: 'os_sandbox_available' },
    executor() {
      fs.writeFileSync(path.join(dataset, 'observations.csv'), 'value\n2\n');
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  const receipt = runner.run({
    executable: 'python3', args: ['run.py'], cwd: source, sourceRoot: source,
    datasetMounts: [{ name: 'trial', source: dataset, readOnly: true, manifestHash: declaredManifestHash, licenseId: 'CC-BY-4.0' }],
  });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.datasetMutationDetected, true);
  assert.ok(receipt.blockers.includes('worker_dataset_manifest_changed_during_execution'));
  assert.equal(receipt.datasetMounts[0].manifestHashBefore, declaredManifestHash);
  assert.notEqual(receipt.datasetMounts[0].manifestHashAfter, declaredManifestHash);
  assert.equal(receipt.datasetMounts[0].manifestVerifiedAfterExecution, false);
  assert.equal(receipt.isolation.datasetManifestsVerifiedAfterExecution, false);
});

test('sandbox rejects symlink escapes in workspace and dataset mount roots', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-sandbox-input-symlinks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const allowed = path.join(root, 'allowed');
  const outsideWorkspace = path.join(root, 'outside-workspace');
  const datasets = path.join(root, 'datasets');
  const outsideDataset = path.join(root, 'outside.csv');
  fs.mkdirSync(allowed);
  fs.mkdirSync(outsideWorkspace);
  fs.mkdirSync(datasets);
  fs.writeFileSync(path.join(outsideWorkspace, 'run.py'), 'print(1)\n');
  fs.writeFileSync(outsideDataset, 'secret\n');
  fs.symlinkSync(outsideWorkspace, path.join(allowed, 'linked-workspace'));
  fs.symlinkSync(outsideDataset, path.join(datasets, 'linked.csv'));
  let executions = 0;
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'], allowedRoots: [allowed], allowedDatasetRoots: [datasets],
    probe: { available: true, backend: 'bubblewrap', status: 'os_sandbox_available' },
    executor() { executions += 1; return { status: 0, stdout: '', stderr: '' }; },
  });
  const linkedWorkspace = path.join(allowed, 'linked-workspace');
  const workspaceReceipt = runner.run({ executable: 'python3', args: ['run.py'], cwd: linkedWorkspace, sourceRoot: linkedWorkspace });
  assert.equal(workspaceReceipt.ok, false);
  assert.ok(workspaceReceipt.blockers.includes('worker_workspace_path_unsafe'));
  const datasetReceipt = runner.run({
    executable: 'python3', args: ['run.py'], cwd: allowed, sourceRoot: allowed,
    datasetMounts: [{ name: 'linked', source: path.join(datasets, 'linked.csv'), readOnly: true, manifestHash: fileSha256Hash(outsideDataset), licenseId: 'fixture' }],
  });
  assert.equal(datasetReceipt.ok, false);
  assert.ok(datasetReceipt.blockers.includes('worker_dataset_mount_invalid_or_not_read_only'));
  assert.equal(executions, 0);
});

test('sandbox recursively rejects symlinks and special files in the executable workspace snapshot', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-workspace-recursive-types-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const nested = path.join(source, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(source, 'run.py'), 'print(1)\n');
  const unsafe = path.join(nested, 'unsafe');
  fs.symlinkSync('../run.py', unsafe);
  let executions = 0;
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'], allowedRoots: [source],
    probe: { available: true, backend: 'bubblewrap', status: 'os_sandbox_available', processLimit: { available: true, mechanism: 'fixture' } },
    executor() { executions += 1; return { status: 0, stdout: '', stderr: '' }; },
  });
  const symlinkReceipt = runner.run({ executable: 'python3', args: ['run.py'], cwd: source, sourceRoot: source });
  assert.equal(symlinkReceipt.ok, false);
  assert.ok(symlinkReceipt.blockers.includes('worker_workspace_execution_snapshot_unsafe'));
  assert.ok(symlinkReceipt.blockers.includes('worker_workspace_symlink_forbidden:nested/unsafe'));

  fs.unlinkSync(unsafe);
  const mkfifo = spawnSync('mkfifo', [unsafe], { encoding: 'utf8' });
  assert.equal(mkfifo.status, 0, mkfifo.stderr);
  const fifoReceipt = runner.run({ executable: 'python3', args: ['run.py'], cwd: source, sourceRoot: source });
  assert.equal(fifoReceipt.ok, false);
  assert.ok(fifoReceipt.blockers.includes('worker_workspace_execution_snapshot_unsafe'));
  assert.ok(fifoReceipt.blockers.includes('worker_workspace_special_file_forbidden:nested/unsafe'));
  assert.equal(executions, 0);
});

test('sandbox recursively rejects symlinks and special files inside directory datasets', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-dataset-recursive-types-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const datasets = path.join(root, 'datasets');
  const symlinkDataset = path.join(datasets, 'symlinked');
  const fifoDataset = path.join(datasets, 'fifo');
  fs.mkdirSync(source);
  fs.mkdirSync(symlinkDataset, { recursive: true });
  fs.mkdirSync(fifoDataset, { recursive: true });
  fs.writeFileSync(path.join(source, 'run.py'), 'print(1)\n');
  fs.writeFileSync(path.join(symlinkDataset, 'data.csv'), 'safe\n');
  fs.symlinkSync('data.csv', path.join(symlinkDataset, 'alias.csv'));
  const fifo = path.join(fifoDataset, 'stream.pipe');
  const mkfifo = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  assert.equal(mkfifo.status, 0, mkfifo.stderr);
  let executions = 0;
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'], allowedRoots: [source], allowedDatasetRoots: [datasets],
    probe: { available: true, backend: 'bubblewrap', status: 'os_sandbox_available' },
    executor() { executions += 1; return { status: 0, stdout: '', stderr: '' }; },
  });
  for (const [name, dataset] of [['symlinked', symlinkDataset], ['fifo', fifoDataset]]) {
    const receipt = runner.run({
      executable: 'python3', args: ['run.py'], cwd: source, sourceRoot: source,
      datasetMounts: [{ name, source: dataset, readOnly: true, manifestHash: directoryMerkleHash(dataset), licenseId: 'fixture' }],
    });
    assert.equal(receipt.ok, false, name);
    assert.ok(receipt.blockers.includes('worker_dataset_mount_invalid_or_not_read_only'), name);
  }
  assert.equal(executions, 0);
});

test('sandbox rejects a declared output symlink without copying the external target', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-sandbox-output-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  const outside = path.join(root, 'outside.txt');
  fs.mkdirSync(source);
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(source, 'run.py'), 'print(1)\n');
  fs.writeFileSync(outside, 'must-not-be-materialized\n');
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'],
    allowedRoots: [source],
    allowedOutputRoots: [output],
    probe: { available: true, backend: 'bubblewrap', status: 'os_sandbox_available' },
    executor(_launcher, command) {
      const mountedOutputIndex = command.indexOf('/output');
      assert.ok(mountedOutputIndex > 0);
      fs.symlinkSync(outside, path.join(command[mountedOutputIndex - 1], 'results.json'));
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  const receipt = runner.run({ executable: 'python3', args: ['run.py'], cwd: source, sourceRoot: source, outputDirectory: output, outputPaths: ['results.json'] });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.artifacts.length, 0);
  assert.ok(receipt.blockers.some((item) => item.startsWith('worker_output_path_unsafe:results.json:')));
  assert.equal(fs.existsSync(path.join(output, 'results.json')), false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'must-not-be-materialized\n');
});

test('sandbox atomically materializes a regular declared output below an allowlisted root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-sandbox-output-materialization-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const outputRoot = path.join(root, 'outputs');
  const output = path.join(outputRoot, 'attempt-1');
  fs.mkdirSync(source);
  fs.mkdirSync(outputRoot);
  fs.writeFileSync(path.join(source, 'run.py'), 'print(1)\n');
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'],
    allowedRoots: [source],
    allowedOutputRoots: [outputRoot],
    probe: { available: true, backend: 'bubblewrap', status: 'os_sandbox_available' },
    executor(_launcher, command) {
      const mountedOutputIndex = command.indexOf('/output');
      fs.writeFileSync(path.join(command[mountedOutputIndex - 1], 'results.json'), '{"metric":1}\n');
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  const receipt = runner.run({ executable: 'python3', args: ['run.py'], cwd: source, sourceRoot: source, outputDirectory: output, outputPaths: ['results.json'] });
  assert.equal(receipt.ok, true, JSON.stringify(receipt.blockers));
  assert.equal(receipt.artifacts.length, 1);
  assert.equal(receipt.artifacts[0].sha256, fileSha256Hash(path.join(output, 'results.json')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'results.json'), 'utf8')), { metric: 1 });
});

test('canonical empirical outputs cannot fall back from HEPTA_OUTPUT_DIR to the worker directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-sandbox-output-root-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  fs.mkdirSync(source);
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(source, 'run.py'), 'print(1)\n');
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'],
    allowedRoots: [source],
    allowedOutputRoots: [output],
    probe: { available: true, backend: 'bubblewrap', status: 'os_sandbox_available' },
    executor(_launcher, command) {
      const mountedWorkIndex = command.findIndex((value, index) => value === '/work' && command[index - 2] === '--bind');
      assert.ok(mountedWorkIndex > 1);
      fs.writeFileSync(path.join(command[mountedWorkIndex - 1], 'results.json'), '{"metric":1}\n');
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  const receipt = runner.run({
    executable: 'python3',
    args: ['run.py'],
    cwd: source,
    sourceRoot: source,
    outputDirectory: output,
    outputPaths: ['results.json'],
    requireSeparateOutputRoot: true,
    env: { HEPTA_OUTPUT_DIR: '/output' },
  });
  assert.equal(receipt.ok, false);
  assert.ok(receipt.blockers.includes('worker_declared_output_missing_from_separate_root:results.json'));
  assert.equal(receipt.isolation.separateOutputRootVerified, false);
  assert.equal(fs.existsSync(path.join(output, 'results.json')), false);
});

test('sandbox rejects an output whose parent component is a symlink escape', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-sandbox-output-parent-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(source);
  fs.mkdirSync(output);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(source, 'run.py'), 'print(1)\n');
  fs.writeFileSync(path.join(outside, 'results.json'), 'outside\n');
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'], allowedRoots: [source], allowedOutputRoots: [output],
    probe: { available: true, backend: 'bubblewrap', status: 'os_sandbox_available' },
    executor(_launcher, command) {
      const mountedOutputIndex = command.indexOf('/output');
      fs.symlinkSync(outside, path.join(command[mountedOutputIndex - 1], 'nested'));
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  const receipt = runner.run({ executable: 'python3', args: ['run.py'], cwd: source, sourceRoot: source, outputDirectory: output, outputPaths: ['nested/results.json'] });
  assert.equal(receipt.ok, false);
  assert.ok(receipt.blockers.some((item) => item.startsWith('worker_output_path_unsafe:nested/results.json:')));
  assert.equal(fs.readFileSync(path.join(outside, 'results.json'), 'utf8'), 'outside\n');
});
