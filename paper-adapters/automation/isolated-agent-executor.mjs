import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertAgentExecutorPort } from '../../paper-ports/agent-executor-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const EXCLUDED = new Set(['.git', 'node_modules', 'runtime', '.artifact-cas', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache']);

function excludedEntry(entry) {
  return EXCLUDED.has(entry.name) || (entry.isFile() && /\.py[co]$/i.test(entry.name));
}

function fileHash(candidate) {
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex');
}

function cloneTree(source, destination, sourceRoot = source) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (excludedEntry(entry)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) cloneTree(from, to, sourceRoot);
    else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE);
    } else if (entry.isSymbolicLink()) {
      const relative = path.relative(sourceRoot, from).replace(/\\/g, '/');
      throw new Error(`isolated_workspace_symlink_forbidden:${relative}`);
    }
  }
}

function baseline(root) {
  const rows = new Map();
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (excludedEntry(entry)) continue;
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) rows.set(relative, fileHash(absolute));
    }
  };
  walk(root);
  return rows;
}

function delta(before, root) {
  const after = baseline(root);
  return [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key)).sort();
}

export function createIsolatedAgentExecutor({ delegate, isolationRoot, keepWorkspaces = false, keepFailedWorkspaces = true } = {}) {
  assertAgentExecutorPort(delegate);
  if (!isolationRoot) throw new Error('isolationRoot is required');
  return assertAgentExecutorPort({
    version: 1,
    kind: 'IsolatedAgentExecutor',
    executorId: `isolated:${delegate.executorId}`,
    async execute(input = {}) {
      const source = path.resolve(input.workspacePath || '');
      const context = input.context || {};
      const nodeKey = `${String(context.campaignId || 'campaign')}-${String(context.nodeId || input.role || 'node')}-${crypto.randomUUID()}`.replace(/[^A-Za-z0-9_.-]/g, '_');
      const isolated = path.resolve(isolationRoot, nodeKey);
      const sourceBaseline = baseline(source);
      cloneTree(source, isolated);
      const isolatedBaseline = baseline(isolated);
      let receipt;
      let succeeded = false;
      try {
        receipt = await delegate.execute({ ...input, workspacePath: isolated, context: { ...context, sourceWorkspace: source, isolatedWorkspace: isolated } });
        const changedPaths = delta(isolatedBaseline, isolated);
        const conflicts = changedPaths.filter((relative) => fileHash(path.join(source, relative)) !== (sourceBaseline.get(relative) ?? null));
        if (conflicts.length) {
          const error = new Error(`isolated_workspace_merge_conflict:${conflicts.join(',')}`);
          error.retryable = true;
          error.conflicts = conflicts;
          error.receipt = receipt;
          throw error;
        }
        for (const relative of changedPaths) {
          const from = path.join(isolated, relative);
          const to = path.join(source, relative);
          if (!fs.existsSync(from)) fs.rmSync(to, { force: true, recursive: true });
          else {
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.copyFileSync(from, to);
          }
        }
        const mergePayload = {
          version: 1,
          kind: 'IsolatedAgentMergeReceipt',
          delegateExecutorId: delegate.executorId,
          sourceWorkspace: source,
          isolatedWorkspace: isolated,
          changedPaths,
          conflictPaths: [],
          status: 'isolated_agent_changes_merged',
          externalActionPerformed: false,
        };
        succeeded = true;
        return Object.freeze({ ...receipt, changedPaths, isolatedWorkspaceRetained: Boolean(keepWorkspaces), isolatedAgentMergeReceiptHash: hashRecord('IsolatedAgentMergeReceipt', mergePayload) });
      } finally {
        if (!keepWorkspaces && (succeeded || !keepFailedWorkspaces)) fs.rmSync(isolated, { recursive: true, force: true });
      }
    },
  });
}
