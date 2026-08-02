import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertAgentExecutorPort } from '../../paper-ports/agent-executor-port.mjs';
import { buildExecutorCapabilities, capabilityRequestFromExecution, evaluateExecutorCapabilityRequest } from '../../paper-ports/executor-capabilities.mjs';
import { buildAgentWorkspacePostimageBinding } from '../../paper-domain/evidence/agent-execution-receipt-contract.mjs';
import {
  buildIsolatedAgentMergeReceipt,
  buildIsolatedAgentWorkspaceContentPolicy,
} from '../../paper-domain/evidence/isolated-agent-merge-receipt-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import {
  changedWorkspacePaths,
  readOnlyMutationBlockers,
  workspaceMutationPolicyBlockers,
} from './workspace-change-tracker.mjs';
import {
  abortStagedScopedFileSync,
  commitStagedScopedFileSync,
  inspectScopedRegularFileSync,
  inspectScopedRegularFileWithRecoverySync,
  recoverScopedMaterializationIntentsSync,
  removeScopedRegularFileSync,
  stageScopedRegularFileCopySync,
} from '../runtime/scoped-file-materialization-repository.mjs';

const EXCLUDED = new Set(['.git', 'node_modules', 'runtime', '.artifact-cas', '.hepta-materialization-recovery', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache']);
const MAX_AGENT_WORKSPACE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_AGENT_WORKSPACE_DIRECTORY_BYTES = 64 * 1024 * 1024;
// Each staged copy owns a destination directory descriptor and a target lock
// until the complete preimage set has been checked. Bound the batch so a
// hostile workspace cannot turn that safety protocol into an EMFILE failure.
const MAX_AGENT_WORKSPACE_CHANGED_PATHS = 128;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_EXECUTABLE_MODE = 0o700;
const RESEARCH_DATA_SUFFIXES = Object.freeze([
  '.nii', '.nii.gz', '.mgz', '.mgh', '.gii', '.mat', '.npy', '.npz', '.h5', '.hdf5',
  '.pkl', '.pickle', '.rds', '.rdata', '.parquet', '.feather', '.arrow', '.dcm', '.edf',
  '.tck', '.trk', '.sqlite', '.sqlite3', '.db', '.zip', '.tar', '.tgz', '.7z',
]);
const OUTCOME_BEARING_WORKSPACE_PATHS = Object.freeze([
  'automation-results', 'results.json', 'results.csv', 'observation.json',
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
  return excludedRoots.some((root) => isPathWithin(root, candidate));
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

function cloneTree(source, destination, sourceRoot = source, destinationRoot = destination, excludedRoots = [], skipSourceSymlinks = false) {
  fs.mkdirSync(destination, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  fs.chmodSync(destination, PRIVATE_DIRECTORY_MODE);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    if (excludedEntry(entry, from)) continue;
    const to = path.join(destination, entry.name);
    if (underExcludedRoot(from, excludedRoots)) continue;
    const stat = fs.lstatSync(from);
    if (stat.isDirectory()) cloneTree(from, to, sourceRoot, destinationRoot, excludedRoots, skipSourceSymlinks);
    else if (stat.isFile()) {
      const relative = path.relative(sourceRoot, from).replace(/\\/g, '/');
      const destinationRelative = path.relative(destinationRoot, to).replace(/\\/g, '/');
      let staged = null;
      try {
        staged = stageScopedRegularFileCopySync({
          sourceRoot,
          destinationRoot,
          relative,
          destinationRelative,
          stageId: `isolated-clone:${destinationRelative}`,
          expectedHash: null,
          destinationMode: (stat.mode & 0o111) ? PRIVATE_EXECUTABLE_MODE : PRIVATE_FILE_MODE,
        });
        commitStagedScopedFileSync(staged, { destinationRoot, expectedHash: null });
      } finally {
        abortStagedScopedFileSync(staged);
      }
    } else if (stat.isSymbolicLink()) {
      if (skipSourceSymlinks) continue;
      const relative = path.relative(sourceRoot, from).replace(/\\/g, '/');
      throw new Error(`isolated_workspace_symlink_forbidden:${relative}`);
    } else {
      const relative = path.relative(sourceRoot, from).replace(/\\/g, '/');
      throw new Error(`isolated_workspace_special_file_forbidden:${relative}`);
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
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isFile()) {
        try { rows.set(relative, inspectScopedRegularFileSync({ scopeRoot: root, relative }).hash); }
        catch (error) { rows.set(relative, `unsafe:${error?.code || 'file_identity_failed'}`); }
      } else if (stat.isSymbolicLink()) rows.set(relative, `unsafe:symlink:${fs.readlinkSync(absolute)}`);
      else rows.set(relative, `unsafe:special:${stat.mode}`);
    }
  };
  walk(root);
  return rows;
}

function workspaceDelta(before, root) {
  const after = baseline(root);
  return Object.freeze({ after, changedPaths: changedWorkspacePaths(before, after) });
}

function retryableContainedMutationPolicyViolation({ readOnlyBlockers, mutationPolicyBlockers }) {
  return readOnlyBlockers.length === 0
    && mutationPolicyBlockers.length > 0
    && mutationPolicyBlockers.every((blocker) => blocker.startsWith('workspace_mutation_not_allowlisted:'));
}

function snapshotRows(snapshot) {
  return [...snapshot.entries()].filter(([, hash]) => /^sha256:[0-9a-f]{64}$/.test(hash))
    .map(([relative, hash]) => ({ path: relative, hash }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function createIsolatedAgentExecutor({
  delegate,
  isolationRoot,
  keepWorkspaces = false,
  keepFailedWorkspaces = true,
  workspaceRegistry = null,
  assertExternalSideEffectReady = null,
} = {}) {
  assertAgentExecutorPort(delegate);
  if (!isolationRoot) throw new Error('isolationRoot is required');
  if (assertExternalSideEffectReady !== null
    && typeof assertExternalSideEffectReady !== 'function') {
    throw new Error('isolated_agent_external_side_effect_gate_invalid');
  }
  const resolvedIsolationRoot = path.resolve(isolationRoot);
  fs.mkdirSync(resolvedIsolationRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  fs.chmodSync(resolvedIsolationRoot, PRIVATE_DIRECTORY_MODE);
  const executorId = `isolated:${delegate.executorId}`;
  const delegateCapabilities = delegate.capabilities();
  const capabilities = buildExecutorCapabilities({
    ...delegateCapabilities,
    executorId,
    workspaceIsolation: true,
  });
  return assertAgentExecutorPort({
    version: 1,
    kind: 'IsolatedAgentExecutor',
    executorId,
    capabilities: () => capabilities,
    async execute(input = {}) {
      const executionSideEffectGate = input.assertExternalSideEffectReady
        || assertExternalSideEffectReady;
      if (executionSideEffectGate !== null
        && executionSideEffectGate !== undefined
        && typeof executionSideEffectGate !== 'function') {
        throw new Error('isolated_agent_external_side_effect_gate_invalid');
      }
      const preflight = evaluateExecutorCapabilityRequest({ capabilities, request: capabilityRequestFromExecution(input) });
      if (preflight.blockers.length) throw new Error(preflight.blockers.join(','));
      const source = path.resolve(input.workspacePath || '');
      const outcomeBlind = input.isolationPolicy?.outcomeBlind === true;
      if (outcomeBlind && !input.workspaceMutationPolicy) {
        const error = new Error('outcome_blind_writable_agent_mutation_policy_required');
        error.retryable = false;
        throw error;
      }
      recoverScopedMaterializationIntentsSync({ scopeRoot: source });
      const declaredExcludes = (input.isolationExcludes || []).map((candidate) => path.resolve(String(candidate))).filter((candidate) => candidate !== source && isPathWithin(source, candidate));
      const outcomeBearingExcludes = outcomeBlind
        ? OUTCOME_BEARING_WORKSPACE_PATHS.map((relative) => path.resolve(source, relative))
        : [];
      const explicitExcludes = [...new Set([...declaredExcludes, ...outcomeBearingExcludes])];
      const largeDirectoryExcludes = oversizedTopLevelDirectories(source, explicitExcludes);
      const isolationExcludes = [...new Set([...explicitExcludes, ...largeDirectoryExcludes])];
      const skipSourceSymlinks = input.isolationPolicy?.skipSourceSymlinks === true;
      const context = input.context || {};
      const operationNodeId = context.operationNodeId || context.nodeId || input.role || 'node';
      const nodeKey = `${String(context.campaignId || 'campaign')}-${String(operationNodeId)}-${crypto.randomUUID()}`.replace(/[^A-Za-z0-9_.-]/g, '_');
      const materializationAttemptId = String(
        context.attemptId
        || context.executionId
        || input.executionId
        || `direct:${nodeKey}`,
      );
      const isolated = path.resolve(resolvedIsolationRoot, nodeKey);
      const sourceBaseline = baseline(source, isolationExcludes);
      cloneTree(source, isolated, source, resolvedIsolationRoot, isolationExcludes, skipSourceSymlinks);
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
      let delegateStarted = false;
      try {
        const delegatedInput = { ...input };
        const outcomeBlindContext = { ...context };
        if (outcomeBlind) {
          delete delegatedInput.isolationExcludes;
          delete outcomeBlindContext.sourceWorkspace;
        }
        if (executionSideEffectGate) {
          await executionSideEffectGate({
            action: `isolated_agent_execute:${operationNodeId}`,
            campaignId: context.campaignId || null,
            nodeId: context.nodeId || null,
          });
          executionSideEffectGate.assertCurrent?.({
            action: `isolated_agent_execute:${operationNodeId}`,
            campaignId: context.campaignId || null,
            nodeId: context.nodeId || null,
          });
        }
        await executionSideEffectGate?.markStarted?.({
          action: `isolated_agent_execute:${operationNodeId}`,
        });
        delegateStarted = true;
        receipt = await delegate.execute({
          ...delegatedInput,
          workspacePath: isolated,
          requiredCapabilities: { ...(input.requiredCapabilities || {}), workspaceIsolation: false },
          context: outcomeBlind
            ? { ...outcomeBlindContext, outcomeBlindWorkspace: true, isolatedWorkspace: isolated }
            : { ...context, sourceWorkspace: source, isolatedWorkspace: isolated },
        });
        const isolatedDelta = workspaceDelta(isolatedBaseline, isolated);
        const changedPaths = isolatedDelta.changedPaths;
        if (changedPaths.length > MAX_AGENT_WORKSPACE_CHANGED_PATHS) {
          const error = new Error(`isolated_workspace_change_limit_exceeded:${changedPaths.length}:${MAX_AGENT_WORKSPACE_CHANGED_PATHS}`);
          error.retryable = false;
          error.receipt = receipt;
          throw error;
        }
        const readOnlyBlockers = readOnlyMutationBlockers({ sandbox: input.sandbox, changedPaths });
        const mutationPolicyBlockers = workspaceMutationPolicyBlockers({
          policy: input.workspaceMutationPolicy || null,
          changedPaths,
        });
        if (readOnlyBlockers.length || mutationPolicyBlockers.length) {
          const error = new Error([...readOnlyBlockers, ...mutationPolicyBlockers].join(','));
          error.retryable = retryableContainedMutationPolicyViolation({
            readOnlyBlockers,
            mutationPolicyBlockers,
          });
          error.receipt = receipt;
          throw error;
        }
        if (JSON.stringify([...(receipt?.changedPaths || [])].map(String).sort())
          !== JSON.stringify(changedPaths)) {
          const error = new Error('isolated_workspace_delegate_changed_paths_mismatch');
          error.retryable = false;
          error.receipt = receipt;
          throw error;
        }
        const prepared = [];
        const conflicts = [];
        const unsafeChanges = [];
        for (const relative of changedPaths) {
          const expectedHash = sourceBaseline.get(relative) ?? null;
          let current;
          try {
            current = inspectScopedRegularFileWithRecoverySync({ scopeRoot: source, relative });
          } catch (error) {
            unsafeChanges.push(`${relative}:${error?.code || 'destination_identity_failed'}`);
            continue;
          }
          if (current.hash !== expectedHash) {
            conflicts.push(relative);
            continue;
          }
          const from = path.join(isolated, relative);
          try {
            fs.lstatSync(from);
            const staged = stageScopedRegularFileCopySync({
              sourceRoot: isolated,
              destinationRoot: source,
              relative,
              stageId: `isolated-merge:${materializationAttemptId}:copy:${relative}`,
              expectedHash,
            });
            prepared.push({ type: 'copy', relative, expectedHash, staged });
          } catch (error) {
            if (error?.code === 'ENOENT') prepared.push({ type: 'delete', relative, expectedHash, staged: null });
            else unsafeChanges.push(`${relative}:${error?.code || 'source_identity_failed'}`);
          }
        }
        if (unsafeChanges.length) {
          for (const change of prepared) abortStagedScopedFileSync(change.staged);
          const error = new Error(`isolated_workspace_unsafe_change:${unsafeChanges.join(',')}`);
          error.retryable = false;
          error.receipt = receipt;
          throw error;
        }
        if (conflicts.length) {
          for (const change of prepared) abortStagedScopedFileSync(change.staged);
          const error = new Error(`isolated_workspace_merge_conflict:${conflicts.join(',')}`);
          error.retryable = true;
          error.conflicts = conflicts;
          error.receipt = receipt;
          throw error;
        }
        for (const change of prepared) {
          let current;
          try { current = inspectScopedRegularFileSync({ scopeRoot: source, relative: change.relative }); }
          catch { current = { hash: Symbol('unsafe') }; }
          if (current.hash !== change.expectedHash) conflicts.push(change.relative);
        }
        if (conflicts.length) {
          for (const change of prepared) abortStagedScopedFileSync(change.staged);
          const error = new Error(`isolated_workspace_merge_conflict:${[...new Set(conflicts)].join(',')}`);
          error.retryable = true;
          error.conflicts = [...new Set(conflicts)];
          error.receipt = receipt;
          throw error;
        }
        try {
          for (const change of prepared.filter((item) => item.type === 'copy')) {
            commitStagedScopedFileSync(change.staged, { destinationRoot: source, expectedHash: change.expectedHash });
          }
          for (const change of prepared.filter((item) => item.type === 'delete')) {
            removeScopedRegularFileSync({
              scopeRoot: source,
              relative: change.relative,
              expectedHash: change.expectedHash,
              operationId: `isolated-merge:${materializationAttemptId}:delete:${change.relative}`,
            });
          }
        } finally {
          for (const change of prepared) abortStagedScopedFileSync(change.staged);
        }
        const agentWorkspacePostimageBinding = buildAgentWorkspacePostimageBinding({
          changedPaths,
          files: changedPaths.map((relative) => ({
            path: relative,
            hash: isolatedDelta.after.get(relative) ?? null,
          })),
        });
        const workspaceContentPolicy = buildIsolatedAgentWorkspaceContentPolicy({
          outcomeBlindWorkspace: outcomeBlind,
          oversizedTopLevelDirectories: largeDirectoryExcludes
            .map((candidate) => path.relative(source, candidate).replace(/\\/g, '/'))
            .sort(),
        });
        const sourcePostimage = baseline(source, isolationExcludes);
        const isolatedAgentMergeReceipt = buildIsolatedAgentMergeReceipt({
          delegateExecutorId: receipt.executorId,
          delegateAgentExecutionReceipt: receipt,
          changedPaths,
          agentWorkspacePostimageBinding,
          sourcePreimage: snapshotRows(sourceBaseline),
          isolatedPreimage: snapshotRows(isolatedBaseline),
          isolatedPostimage: snapshotRows(isolatedDelta.after),
          sourcePostimage: snapshotRows(sourcePostimage),
          workspaceContentPolicy,
        });
        succeeded = true;
        workspaceRegistry?.transition(registryEntry.workspaceId, {
          status: 'merged',
          retentionState: 'protected',
          retentionReason: keepWorkspaces ? 'operator_retained' : 'merged_pending_removal',
        });
        return Object.freeze({
          ...receipt,
          changedPaths,
          agentWorkspacePostimageBinding,
          isolatedAgentMergeReceipt,
          isolatedWorkspaceRetained: Boolean(keepWorkspaces),
          workspaceContentPolicy,
          isolatedAgentMergeReceiptHash:
            isolatedAgentMergeReceipt.isolatedAgentMergeReceiptHash,
        });
      } catch (error) {
        failure = error;
        if ((error?.stateRecoverabilityFatal === true
          || error?.stateRecoverabilityDeferred === true
          || error?.authorityEvidenceRenewalFatal === true
          || error?.authorityEvidenceRenewalDeferred === true
          || error?.residentReactivationRequired === true) && !delegateStarted) {
          error.externalSideEffectNotStarted = true;
          throw error;
        }
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
