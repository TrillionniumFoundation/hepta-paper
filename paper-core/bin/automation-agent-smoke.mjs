#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCodexAgentExecutor } from '../../paper-adapters/automation/codex-agent-executor.mjs';
import { createOllamaStructuredAgentExecutor } from '../../paper-adapters/automation/ollama-structured-agent-executor.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-real-agent-smoke-'));
try {
  fs.writeFileSync(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nA bounded automation smoke fixture.\n\\end{document}\n');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Only edit main.tex. Do not use network or external services.\n');
  const localProvider = process.env.HEPTA_AGENT_LOCAL_PROVIDER || null;
  const agent = localProvider === 'ollama'
    ? createOllamaStructuredAgentExecutor({ model: process.env.HEPTA_AGENT_MODEL, timeoutMs: 10 * 60 * 1000, maximumOutputTokens: Number(process.env.HEPTA_AGENT_MAX_OUTPUT_TOKENS || 2048) })
    : createCodexAgentExecutor({ timeoutMs: 10 * 60 * 1000, model: process.env.HEPTA_AGENT_MODEL || null });
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
