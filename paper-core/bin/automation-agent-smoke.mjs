#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createOpenClawAgentExecutor } from '../../paper-adapters/automation/openclaw-agent-executor.mjs';
import { createOllamaStructuredAgentExecutor } from '../../paper-adapters/automation/ollama-structured-agent-executor.mjs';
import { createAgentBackendRouter } from '../../paper-adapters/automation/agent-backend-router.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-real-agent-smoke-'));
try {
  fs.writeFileSync(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nA bounded automation smoke fixture.\n\\end{document}\n');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Only edit main.tex. Do not use network or external services.\n');
  let ollamaModel = process.env.HEPTA_AGENT_MODEL || null;
  if (!ollamaModel) {
    const tags = spawnSync('ollama', ['list'], { encoding: 'utf8', timeout: 5000 });
    ollamaModel = String(tags.stdout || '').split(/\n/).slice(1).map((line) => line.trim().split(/\s+/)[0]).find((name) => name && !/embed/i.test(name)) || null;
  }
  const openclaw = createOpenClawAgentExecutor({
    agentId: process.env.HEPTA_OPENCLAW_AGENT || 'hepta-paper-worker',
    model: process.env.HEPTA_OPENCLAW_MODEL || undefined,
    timeoutMs: 10 * 60 * 1000,
  });
  const fallback = ollamaModel ? createOllamaStructuredAgentExecutor({ model: ollamaModel, timeoutMs: 10 * 60 * 1000, maximumOutputTokens: Number(process.env.HEPTA_AGENT_MAX_OUTPUT_TOKENS || 2048) }) : null;
  const agent = createAgentBackendRouter({ primary: openclaw, fallbacks: [fallback] });
  const receipt = await agent.execute({
    role: 'paper-writer-smoke',
    workspacePath: root,
    instructions: 'Add one concise sentence about reproducible experiments before the end of the document. Make no other changes.',
    requiredChecks: ['confirm main.tex still contains document begin/end markers'],
    sandbox: 'workspace-write',
  });
  const source = fs.readFileSync(path.join(root, 'main.tex'), 'utf8');
  const passed = receipt.changedPaths.includes('main.tex') && /reproduc/i.test(source) && /\\end\{document\}/.test(source);
  process.stdout.write(`${JSON.stringify({ status: passed ? 'real_agent_smoke_passed' : 'real_agent_smoke_failed', passed, receipt, source }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
