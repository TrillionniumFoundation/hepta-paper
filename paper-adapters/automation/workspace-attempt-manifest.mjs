import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { normalizeScopedRelativePath } from '../runtime/scoped-file-materialization-path-io.mjs';
import { workspaceAttemptIntegrationError as integrationError } from './workspace-attempt-errors.mjs';

export function compareWorkspaceAttemptPaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalWorkspaceAttemptRows(value, label, { requireCanonicalInput = false } = {}) {
  const source = value instanceof Map
    ? [...value.entries()].map(([pathValue, hash]) => ({ path: pathValue, hash }))
    : (Array.isArray(value) ? value : []);
  const normalized = source.map((row) => ({
    path: normalizeScopedRelativePath(row?.path),
    hash: row?.hash === null || row?.hash === undefined ? null : String(row.hash),
  })).sort((left, right) => compareWorkspaceAttemptPaths(left.path, right.path));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].path === normalized[index].path) {
      throw integrationError(`workspace_attempt_${label}_duplicate_path`, { detail: normalized[index].path });
    }
  }
  if (requireCanonicalInput && JSON.stringify(source) !== JSON.stringify(normalized)) {
    throw integrationError(`workspace_attempt_${label}_not_canonical`);
  }
  return normalized;
}

export function workspaceAttemptRowsMap(rows = []) {
  return new Map(rows.map((row) => [row.path, row.hash]));
}

export function workspaceAttemptMapHash(map, pathValue) {
  return map.has(pathValue) ? map.get(pathValue) : null;
}

export function workspaceAttemptRowsEqual(left, right) {
  return JSON.stringify(canonicalWorkspaceAttemptRows(left, 'manifest'))
    === JSON.stringify(canonicalWorkspaceAttemptRows(right, 'manifest'));
}

export function workspaceAttemptManifestHash(kind, rows) {
  return hashRecord(kind, rows);
}

export function expectedIntegratedWorkspaceAttemptRows(sourceReadSet, changes) {
  const integrated = workspaceAttemptRowsMap(sourceReadSet);
  for (const change of changes) {
    if (change.postimageHash === null) integrated.delete(change.path);
    else integrated.set(change.path, change.postimageHash);
  }
  return canonicalWorkspaceAttemptRows(integrated, 'integrated_manifest');
}

export function workspaceAttemptSnapshotMatchesExact(actualMap, expectedRows) {
  return JSON.stringify(canonicalWorkspaceAttemptRows(actualMap, 'actual_manifest'))
    === JSON.stringify(expectedRows);
}

export function validateWorkspaceAttemptSourceReadSet(current, sourceReadSet, changes) {
  const baseline = workspaceAttemptRowsMap(sourceReadSet);
  const changeMap = new Map(changes.map((change) => [change.path, change]));
  const allPaths = new Set([...baseline.keys(), ...current.keys()]);
  const stale = [];
  for (const pathValue of [...allPaths].sort(compareWorkspaceAttemptPaths)) {
    const currentHash = workspaceAttemptMapHash(current, pathValue);
    const change = changeMap.get(pathValue);
    if (!change && currentHash !== workspaceAttemptMapHash(baseline, pathValue)) stale.push(pathValue);
  }
  if (stale.length) {
    const error = integrationError('workspace_attempt_read_set_stale', {
      retryable: true,
      detail: stale.join(','),
    });
    error.conflicts = stale;
    throw error;
  }
}
