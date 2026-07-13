import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertAgentExecutorPort } from '../../paper-ports/agent-executor-port.mjs';
import { buildExecutorCapabilities, capabilityRequestFromExecution, evaluateExecutorCapabilityRequest } from '../../paper-ports/executor-capabilities.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { changedWorkspacePaths, readOnlyMutationBlockers, sha256FileSync } from './workspace-change-tracker.mjs';

const EXCLUDED = new Set(['.git', 'node_modules', 'runtime', '.artifact-cas', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache']);
const MAX_AGENT_WORKSPACE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_AGENT_WORKSPACE_DIRECTORY_BYTES = 64 * 1024 * 1024;
const RESEARCH_DATA_SUFFIXES = Object.freeze([
  '.nii', '.nii.gz', '.mgz', '.mgh', '.gii', '.mat', '.npy', '.npz', '.h5', '.hdf5',
  '.pkl', '.pickle', '.rds', '.rdata', '.parquet', '.feather', '.arrow', '.dcm', '.edf',
  '.tck', '.trk', '.sqlite', '.sqlite3', '.db', '.zip', '.tar', '.tgz', '.7z',
]);

function excludedEntry(entry, candidate = null) {
  const lower = entry.name.toLowerCase();
  return EXCLUDED.has(entry.name)
    || (entry.isDirectory() && (/^\.venv(?:-|$)/.test(entry.name) || entry.name === 'venv'))
    || (entry.isFile() && (/\.py[co]$/i.test(entry.name)
      || RESEARCH_DATA_SUFFIXES.some((suffix) => lower.endsWith(suffix))
      || (candidate && fs.statSync(candidate).size > MAX_AGENT_WORKSPACE_FILE_BYTES)));
}

function underExcludedRoot(candidate, excludedRoots) {
  return excludedRoots.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`));
}

function directoryExceedsLimit(root, limit) {
  let bytes = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!excludedEntry(entry, candidate)) stack.push(candidate);
      }
      else if (entry.isFile()) {
        bytes += fs.statSync(candidate).size;
        if (bytes > limit) return true;
      }
    }
  }
  return false;
}

function oversizedTopLevelDirectories(root, excludedRoots) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ entry, candidate: path.join(root, entry.name) }))
    .filter(({ entry, candidate }) => !excludedEntry(entry, candidate) && !underExcludedRoot(candidate, excludedRoots))
    .filter(({ candidate }) => directoryExceedsLimit(candidate, MAX_AGENT_WORKSPACE_DIRECTORY_BYTES))
    .map(({ candidate }) => candidate);
}

function cloneTree(source, destination, sourceRoot = source, excludedRoots = [], skipSourceSymlinks = false) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    if (excludedEntry(entry, from)) continue;
    const to = path.join(destination, entry.name);
    if (underExcludedRoot(from, excludedRoots)) continue;
    if (entry.isDirectory()) cloneTree(from, to, sourceRoot, excludedRoots, skipSourceSymlinks);
    else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE);
    } else if (entry.isSymbolicLink()) {
      if (skipSourceSymlinks) continue;
      const relative = path.relative(sourceRoot, from).replace(/\\/g, '/');
      throw new Error(`isolated_workspace_symlink_forbidden:${relative}`);
    }
  }
}

function baseline(root, excludedRoots = []) {
  const rows = new Map();
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (excludedEntry(entry, absolute)) continue;
      if (underExcludedRoot(absolute, excludedRoots)) continue;
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) rows.set(relative, sha256FileSync(absolute));
    }
  };
  walk(root);
  return rows;
}

function delta(before, root) {
  const after = baseline(root);
  return changedWorkspacePaths(before, after);
}

export function createIsolatedAgentExecutor({ delegate, isolationRoot, keepWorkspaces = false, keepFailedWorkspaces = true, workspaceRegistry = null } = {}) {
  assertAgentExecutorPort(delegate);
  if (!isolationRoot) throw new Error('isolationRoot is required');
  const executorId = `isolated:${delegate.executorId}`;
  const delegateCapabilities = delegate.capabilities();
  const capabilities = buildExecutorCapabilities({
    ...delegateCapabilities,
    executorId,
    workspaceIsolation: true,
  });
  const largeDirectoryCache = new Map();
  return assertAgentExecutorPort({
    version: 1,
    kind: 'IsolatedAgentExecutor',
    executorId,
    capabilities: () => capabilities,
    async execute(input = {}) {
      const preflight = evaluateExecutorCapabilityRequest({ capabilities, request: capabilityRequestFromExecution(input) });
      if (preflight.blockers.length) throw new Error(preflight.blockers.join(','));
      const source = path.resolve(input.workspacePath || '');
      const declaredExcludes = (input.isolationExcludes || []).map((candidate) => path.resolve(String(candidate))).filter((candidate) => candidate !== source && candidate.startsWith(`${source}${path.sep}`));
      const cacheKey = `${source}\0${declaredExcludes.slice().sort().join('\0')}`;
      const largeDirectoryExcludes = largeDirectoryCache.get(cacheKey) || oversizedTopLevelDirectories(source, declaredExcludes);
      largeDirectoryCache.set(cacheKey, largeDirectoryExcludes);
      const isolationExcludes = [...new Set([...declaredExcludes, ...largeDirectoryExcludes])];
      const skipSourceSymlinks = input.isolationPolicy?.skipSourceSymlinks === true;
      const context = input.context || {};
      const nodeKey = `${String(context.campaignId || 'campaign')}-${String(context.nodeId || input.role || 'node')}-${crypto.randomUUID()}`.replace(/[^A-Za-z0-9_.-]/g, '_');
      const isolated = path.resolve(isolationRoot, nodeKey);
      const sourceBaseline = baseline(source, isolationExcludes);
      cloneTree(source, isolated, source, isolationExcludes, skipSourceSymlinks);
      const isolatedBaseline = baseline(isolated);
      const workspaceManifestHash = hashRecord('IsolatedWorkspaceManifest', [...isolatedBaseline.entries()].map(([relative, hash]) => ({ relative, hash })));
      const registryEntry = workspaceRegistry?.register({
        workspaceId: `workspace:${nodeKey}`,
        campaignId: String(context.campaignId || 'campaign'),
        nodeId: context.nodeId || null,
        parentWorkspaceId: context.parentWorkspaceId || null,
        sourcePath: source,
        workspacePath: isolated,
        manifestHash: workspaceManifestHash,
      }) || null;
      let receipt;
      let succeeded = false;
      let failure = null;
      try {
        receipt = await delegate.execute({
          ...input,
          workspacePath: isolated,
          requiredCapabilities: { ...(input.requiredCapabilities || {}), workspaceIsolation: false },
          context: { ...context, sourceWorkspace: source, isolatedWorkspace: isolated },
        });
        const changedPaths = delta(isolatedBaseline, isolated);
        const readOnlyBlockers = readOnlyMutationBlockers({ sandbox: input.sandbox, changedPaths });
        if (readOnlyBlockers.length) {
          const error = new Error(readOnlyBlockers.join(','));
          error.retryable = false;
          error.receipt = receipt;
          throw error;
        }
        const conflicts = changedPaths.filter((relative) => sha256FileSync(path.join(source, relative)) !== (sourceBaseline.get(relative) ?? null));
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
          workspaceContentPolicy: {
            maximumFileBytes: MAX_AGENT_WORKSPACE_FILE_BYTES,
            maximumTopLevelDirectoryBytes: MAX_AGENT_WORKSPACE_DIRECTORY_BYTES,
            researchDataBinaryExcluded: true,
            oversizedTopLevelDirectories: largeDirectoryExcludes.map((candidate) => path.relative(source, candidate).replace(/\\/g, '/')).sort(),
          },
          externalActionPerformed: false,
        };
        succeeded = true;
        workspaceRegistry?.transition(registryEntry.workspaceId, {
          status: 'merged',
          retentionState: 'protected',
          retentionReason: keepWorkspaces ? 'operator_retained' : 'merged_pending_removal',
        });
        return Object.freeze({ ...receipt, changedPaths, isolatedWorkspaceRetained: Boolean(keepWorkspaces), workspaceContentPolicy: mergePayload.workspaceContentPolicy, isolatedAgentMergeReceiptHash: hashRecord('IsolatedAgentMergeReceipt', mergePayload) });
      } catch (error) {
        failure = error;
        workspaceRegistry?.transition(registryEntry.workspaceId, {
          status: error?.conflicts?.length ? 'conflict' : 'failed',
          failureClass: error?.code || error?.message || 'isolated_agent_failed',
          retentionReason: 'failure_or_unresolved_lineage',
        });
        throw error;
      } finally {
        if (!keepWorkspaces && (succeeded || !keepFailedWorkspaces)) {
          fs.rmSync(isolated, { recursive: true, force: true });
          if (registryEntry && (!failure || !keepFailedWorkspaces)) workspaceRegistry?.transition(registryEntry.workspaceId, {
            status: 'removed',
            retentionState: 'eligible',
            retentionReason: succeeded ? 'merged_and_removed' : 'explicit_failed_workspace_removal',
          });
        }
      }
    },
  });
}
