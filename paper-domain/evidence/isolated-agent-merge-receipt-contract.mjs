import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildAgentWorkspacePostimageBinding,
  verifyAgentExecutionReceipt,
  verifyAgentWorkspacePostimageBinding,
} from './agent-execution-receipt-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAXIMUM_SNAPSHOT_ROWS = 20_000;
const MAXIMUM_WORKSPACE_PATH_BYTES = 1024;
const MAXIMUM_CHANGED_PATHS = 128;
const MAXIMUM_FILE_BYTES = 8 * 1024 * 1024;
const MAXIMUM_TOP_LEVEL_DIRECTORY_BYTES = 64 * 1024 * 1024;
const OUTCOME_BEARING_WORKSPACE_PATHS = Object.freeze([
  'automation-results', 'results.json', 'results.csv', 'observation.json',
]);

function normalizedWorkspacePath(value) {
  const relative = String(value || '');
  return relative && Buffer.byteLength(relative, 'utf8') <= MAXIMUM_WORKSPACE_PATH_BYTES
    && !relative.includes('\\') && !relative.startsWith('/')
    && relative.split('/').every((part) => part && part !== '.' && part !== '..')
    ? relative : null;
}

export function buildIsolatedAgentWorkspaceContentPolicy({
  outcomeBlindWorkspace = false,
  oversizedTopLevelDirectories = [],
} = {}) {
  const oversized = Array.isArray(oversizedTopLevelDirectories)
    ? oversizedTopLevelDirectories.map(normalizedWorkspacePath).sort() : [];
  if (oversized.length > MAXIMUM_CHANGED_PATHS
    || oversized.some((value) => !value)
    || new Set(oversized).size !== oversized.length) {
    throw new Error('isolated_agent_workspace_content_policy_invalid');
  }
  const outcomeBlind = outcomeBlindWorkspace === true;
  return Object.freeze({
    version: 1,
    kind: 'IsolatedAgentWorkspaceContentPolicy',
    maximumFileBytes: MAXIMUM_FILE_BYTES,
    maximumTopLevelDirectoryBytes: MAXIMUM_TOP_LEVEL_DIRECTORY_BYTES,
    maximumChangedPaths: MAXIMUM_CHANGED_PATHS,
    directoryMode: '0700',
    regularFileMode: '0600',
    executableFileMode: '0700',
    researchDataBinaryExcluded: true,
    outcomeBlindWorkspace: outcomeBlind,
    outcomeBearingPathsExcluded: outcomeBlind
      ? OUTCOME_BEARING_WORKSPACE_PATHS : Object.freeze([]),
    oversizedTopLevelDirectories: Object.freeze(oversized),
  });
}

function canonicalRows(rows) {
  if (!Array.isArray(rows) || rows.length > MAXIMUM_SNAPSHOT_ROWS) return null;
  const normalized = rows.map((row) => Object.freeze({
    path: normalizedWorkspacePath(row?.path),
    hash: String(row?.hash || '').toLowerCase(),
  })).sort((left, right) => String(left.path).localeCompare(String(right.path)));
  if (normalized.some((row) => !row.path || !SHA256.test(row.hash))
    || new Set(normalized.map((row) => row.path)).size !== normalized.length) return null;
  return Object.freeze(normalized);
}

function changedSnapshotPaths(before, after) {
  const beforeByPath = new Map(before.map((row) => [row.path, row.hash]));
  const afterByPath = new Map(after.map((row) => [row.path, row.hash]));
  return Object.freeze([...new Set([...beforeByPath.keys(), ...afterByPath.keys()])]
    .filter((relative) => beforeByPath.get(relative) !== afterByPath.get(relative))
    .sort());
}

function manifestHash(rows) {
  return hashRecord('IsolatedAgentWorkspaceSnapshot', rows);
}

export function buildIsolatedAgentMergeReceipt({
  delegateExecutorId,
  delegateAgentExecutionReceipt,
  changedPaths,
  agentWorkspacePostimageBinding,
  sourcePreimage,
  isolatedPreimage,
  isolatedPostimage,
  sourcePostimage,
  workspaceContentPolicy,
} = {}) {
  const sourceBefore = canonicalRows(sourcePreimage);
  const isolatedBefore = canonicalRows(isolatedPreimage);
  const isolatedAfter = canonicalRows(isolatedPostimage);
  const sourceAfter = canonicalRows(sourcePostimage);
  const paths = Object.freeze([...(changedPaths || [])].map(String).sort());
  let canonicalPolicy = null;
  try { canonicalPolicy = buildIsolatedAgentWorkspaceContentPolicy(workspaceContentPolicy); }
  catch { /* rejected below */ }
  if (!delegateExecutorId
    || delegateExecutorId !== delegateAgentExecutionReceipt?.executorId
    || !verifyAgentExecutionReceipt(delegateAgentExecutionReceipt)
    || JSON.stringify(paths) !== JSON.stringify(delegateAgentExecutionReceipt.changedPaths)
    || paths.length > MAXIMUM_CHANGED_PATHS
    || paths.some((relative) => !normalizedWorkspacePath(relative))
    || new Set(paths).size !== paths.length
    || !sourceBefore || !isolatedBefore || !isolatedAfter || !sourceAfter
    || JSON.stringify(sourceBefore) !== JSON.stringify(isolatedBefore)
    || JSON.stringify(sourceAfter) !== JSON.stringify(isolatedAfter)
    || JSON.stringify(paths) !== JSON.stringify(changedSnapshotPaths(sourceBefore, sourceAfter))
    || !canonicalPolicy
    || JSON.stringify(canonicalPolicy) !== JSON.stringify(workspaceContentPolicy)
    || !verifyAgentWorkspacePostimageBinding(agentWorkspacePostimageBinding)
    || JSON.stringify(agentWorkspacePostimageBinding.changedPaths) !== JSON.stringify(paths)) {
    throw new Error('isolated_agent_merge_receipt_input_invalid');
  }
  const rebuiltPostimage = buildAgentWorkspacePostimageBinding({
    changedPaths: paths,
    files: paths.map((relative) => ({
      path: relative,
      hash: sourceAfter.find((row) => row.path === relative)?.hash || null,
    })),
  });
  if (JSON.stringify(rebuiltPostimage) !== JSON.stringify(agentWorkspacePostimageBinding)) {
    throw new Error('isolated_agent_merge_postimage_invalid');
  }
  const identity = {
    delegateAgentExecutionReceiptHash: delegateAgentExecutionReceipt.agentExecutionReceiptHash,
    changedPaths: paths,
    agentWorkspacePostimageBindingHash:
      agentWorkspacePostimageBinding.agentWorkspacePostimageBindingHash,
    sourcePreimageManifestHash: manifestHash(sourceBefore),
    isolatedPreimageManifestHash: manifestHash(isolatedBefore),
    isolatedPostimageManifestHash: manifestHash(isolatedAfter),
    sourcePostimageManifestHash: manifestHash(sourceAfter),
  };
  const payload = {
    version: 2,
    kind: 'IsolatedAgentMergeReceipt',
    status: 'isolated_agent_changes_merged',
    delegateExecutorId: String(delegateExecutorId),
    delegateAgentExecutionReceiptHash: delegateAgentExecutionReceipt.agentExecutionReceiptHash,
    changedPaths: paths,
    agentWorkspacePostimageBinding,
    agentWorkspacePostimageBindingHash:
      agentWorkspacePostimageBinding.agentWorkspacePostimageBindingHash,
    sourcePreimage: sourceBefore,
    sourcePreimageManifestHash: identity.sourcePreimageManifestHash,
    isolatedPreimage: isolatedBefore,
    isolatedPreimageManifestHash: identity.isolatedPreimageManifestHash,
    isolatedPostimage: isolatedAfter,
    isolatedPostimageManifestHash: identity.isolatedPostimageManifestHash,
    sourcePostimage: sourceAfter,
    sourcePostimageManifestHash: identity.sourcePostimageManifestHash,
    mergeIdentityHash: hashRecord('IsolatedAgentMergeIdentity', identity),
    conflictPaths: Object.freeze([]),
    workspaceContentPolicy: canonicalPolicy,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    isolatedAgentMergeReceiptHash: hashRecord('IsolatedAgentMergeReceipt', payload),
  });
}

export function verifyIsolatedAgentMergeReceipt(receipt, {
  delegateAgentExecutionReceipt = null,
} = {}) {
  try {
    if (!delegateAgentExecutionReceipt
      || receipt?.delegateAgentExecutionReceiptHash
        !== delegateAgentExecutionReceipt.agentExecutionReceiptHash) return false;
    const rebuilt = buildIsolatedAgentMergeReceipt({
      delegateExecutorId: receipt.delegateExecutorId,
      delegateAgentExecutionReceipt,
      changedPaths: receipt.changedPaths,
      agentWorkspacePostimageBinding: receipt.agentWorkspacePostimageBinding,
      sourcePreimage: receipt.sourcePreimage,
      isolatedPreimage: receipt.isolatedPreimage,
      isolatedPostimage: receipt.isolatedPostimage,
      sourcePostimage: receipt.sourcePostimage,
      workspaceContentPolicy: receipt.workspaceContentPolicy,
    });
    return JSON.stringify(rebuilt) === JSON.stringify(receipt);
  } catch { return false; }
}
