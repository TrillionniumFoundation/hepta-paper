import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertAgentExecutorPort } from '../../paper-ports/agent-executor-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function treeManifest(root) {
  const rows = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['.git', 'node_modules', 'runtime', '.artifact-cas'].includes(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) rows.push([relative, crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')]);
    }
  };
  walk(root);
  return rows;
}

function changedPaths(before, after) {
  const left = new Map(before);
  const right = new Map(after);
  return [...new Set([...left.keys(), ...right.keys()])].filter((key) => left.get(key) !== right.get(key)).sort();
}

function runProcess(spawnImpl, executable, args, options, prompt, timeoutMs, signal = null) {
  return new Promise((resolve) => {
    const child = spawnImpl(executable, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve({ exitCode: null, signal: null, stdout, stderr, error }); });
    child.on('close', (exitCode, childSignal) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve({ exitCode, signal: childSignal, stdout, stderr, error: null }); });
    child.stdin?.end(prompt);
  });
}

export function createCodexAgentExecutor({
  codexBinary = 'codex',
  model = null,
  oss = false,
  localProvider = 'ollama',
  spawnImpl = spawn,
  timeoutMs = 30 * 60 * 1000,
} = {}) {
  return assertAgentExecutorPort({
    version: 1,
    kind: 'CodexAgentExecutor',
    executorId: 'codex-agent-executor-v1',
    async execute({ role, workspacePath, instructions, context = {}, requiredChecks = [], sandbox = 'workspace-write', outputTokenBudget = null, timeoutMs: requestedTimeout = null, signal = null } = {}) {
      const workspace = path.resolve(workspacePath || '');
      if (!role || !instructions || !fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
        throw new Error('agent role, existing workspacePath and instructions are required');
      }
      const before = treeManifest(workspace);
      const prompt = [
        `You are the ${role} for an automated paper campaign.`,
        'Work only inside the provided workspace. Do not submit externally, send messages, or access credentials.',
        String(instructions),
        `Structured context: ${JSON.stringify(context)}`,
        requiredChecks.length ? `Before finishing run these checks when applicable: ${requiredChecks.join(' ; ')}` : '',
        outputTokenBudget ? `Keep the final response within ${Math.max(128, Number(outputTokenBudget))} output tokens. Prefer editing files with tools over returning file bodies.` : '',
        'Finish with one compact JSON object containing status, summary, checksRun, and blockers. Include every role-specific JSON field explicitly requested by the task in that same object.',
      ].filter(Boolean).join('\n\n');
      if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error('agent sandbox must be read-only or workspace-write');
      const args = ['exec'];
      if (oss) args.push('--oss', '--local-provider', localProvider);
      if (model) args.push('--model', model);
      args.push('--ephemeral', '--color', 'never', '--sandbox', sandbox, '--skip-git-repo-check', '--cd', workspace, '-');
      const startedAt = new Date().toISOString();
      const processResult = await runProcess(spawnImpl, codexBinary, args, { cwd: workspace, env: { ...process.env, HEPTA_AUTOMATION_ROLE: role } }, prompt, Math.min(Number(requestedTimeout || timeoutMs), timeoutMs), signal);
      const completedAt = new Date().toISOString();
      const after = treeManifest(workspace);
      const changes = changedPaths(before, after);
      const payload = {
        version: 1,
        kind: 'AgentExecutionReceipt',
        executorId: 'codex-agent-executor-v1',
        providerMode: oss ? `local:${localProvider}` : 'openai',
        model,
        maximumOutputTokens: outputTokenBudget ? Math.max(128, Number(outputTokenBudget)) : null,
        role,
        status: processResult.exitCode === 0 && !processResult.error ? 'agent_execution_completed' : 'agent_execution_failed',
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        changedPaths: changes,
        stdoutHash: `sha256:${crypto.createHash('sha256').update(processResult.stdout).digest('hex')}`,
        stderrHash: `sha256:${crypto.createHash('sha256').update(processResult.stderr).digest('hex')}`,
        finalOutput: processResult.stdout.slice(-12000),
        stderrTail: processResult.stderr.slice(-12000),
        error: processResult.error?.message || null,
        startedAt,
        completedAt,
        externalActionPerformed: false,
      };
      const receipt = Object.freeze({ ...payload, agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload) });
      if (payload.status !== 'agent_execution_completed') {
        const error = new Error(payload.error || `agent exited ${payload.exitCode}`);
        error.retryable = true;
        error.receipt = receipt;
        throw error;
      }
      return receipt;
    },
  });
}
