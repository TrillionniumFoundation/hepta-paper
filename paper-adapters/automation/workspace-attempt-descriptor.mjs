import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { normalizeScopedRelativePath } from '../runtime/scoped-file-materialization-path-io.mjs';
import { changedWorkspacePaths } from './workspace-change-tracker.mjs';
import { workspaceAttemptIntegrationError as integrationError } from './workspace-attempt-errors.mjs';
import {
  canonicalWorkspaceAttemptRows,
  compareWorkspaceAttemptPaths,
  expectedIntegratedWorkspaceAttemptRows,
  workspaceAttemptManifestHash,
  workspaceAttemptMapHash,
  workspaceAttemptRowsMap,
} from './workspace-attempt-manifest.mjs';
import {
  assertCurrentWorkspaceAttemptRootIdentity,
  assertDisjointWorkspaceAttemptRoots,
  snapshotWorkspaceFilesSync,
  verifyWorkspaceAttemptRootIdentityClaim,
  workspaceAttemptRootIdentitySync,
} from './workspace-attempt-root-snapshot.mjs';

const DESCRIPTOR_VERSION = 2;

function canonicalChanges(value, { requireCanonicalInput = false } = {}) {
  if (!Array.isArray(value)) throw integrationError('workspace_attempt_integration_changes_invalid');
  const source = value.map((change) => ({
    path: normalizeScopedRelativePath(change?.path),
    preimageHash: change?.preimageHash === null || change?.preimageHash === undefined
      ? null
      : String(change.preimageHash),
    postimageHash: change?.postimageHash === null || change?.postimageHash === undefined
      ? null
      : String(change.postimageHash),
  }));
  const canonical = source.slice().sort((left, right) => compareWorkspaceAttemptPaths(left.path, right.path));
  for (let index = 1; index < canonical.length; index += 1) {
    if (canonical[index - 1].path === canonical[index].path) {
      throw integrationError('workspace_attempt_integration_duplicate_path', { detail: canonical[index].path });
    }
  }
  if (requireCanonicalInput && JSON.stringify(source) !== JSON.stringify(canonical)) {
    throw integrationError('workspace_attempt_integration_changes_not_canonical');
  }
  return canonical;
}

export function buildWorkspaceIntegrationDescriptorSync(attempt) {
  if (!attempt?.campaignId || !attempt?.nodeId || !attempt?.originalAttemptId) {
    throw integrationError('workspace_attempt_identity_required');
  }
  assertCurrentWorkspaceAttemptRootIdentity(attempt.sourceWorkspace, attempt.sourceRootIdentity, 'source');
  assertCurrentWorkspaceAttemptRootIdentity(attempt.attemptWorkspace, attempt.attemptRootIdentity, 'attempt');
  assertDisjointWorkspaceAttemptRoots(attempt.sourceRootIdentity, attempt.attemptRootIdentity);
  const after = snapshotWorkspaceFilesSync({
    root: attempt.attemptWorkspace,
    excludedNames: new Set(attempt.excludedNames),
  });
  const unsafe = [...after.entries()].filter(([, hash]) => String(hash || '').startsWith('unsafe:'));
  if (unsafe.length) {
    throw integrationError('workspace_attempt_unsafe_change', {
      detail: unsafe.map(([pathValue]) => pathValue).join(','),
    });
  }
  const changedPaths = changedWorkspacePaths(attempt.attemptBaseline, after);
  const changes = canonicalChanges(changedPaths.map((relative) => ({
    path: relative,
    preimageHash: attempt.sourceBaseline.get(relative) ?? null,
    postimageHash: after.get(relative) ?? null,
  })));
  const sourceReadSet = canonicalWorkspaceAttemptRows(attempt.sourceBaseline, 'source_read_set');
  const attemptBaseline = canonicalWorkspaceAttemptRows(attempt.attemptBaseline, 'attempt_baseline');
  const attemptPostimage = canonicalWorkspaceAttemptRows(after, 'attempt_postimage');
  const integratedSourceManifest = expectedIntegratedWorkspaceAttemptRows(sourceReadSet, changes);
  const payload = {
    version: DESCRIPTOR_VERSION,
    kind: 'WorkspaceAttemptIntegrationDescriptor',
    campaignId: attempt.campaignId,
    nodeId: attempt.nodeId,
    originalAttemptId: attempt.originalAttemptId,
    sourceWorkspace: attempt.sourceRootIdentity.realPath,
    attemptWorkspace: attempt.attemptRootIdentity.realPath,
    sourceRootIdentity: attempt.sourceRootIdentity,
    attemptRootIdentity: attempt.attemptRootIdentity,
    excludedNames: [...attempt.excludedNames].sort(),
    changes,
    sourceReadSet,
    attemptBaseline,
    attemptPostimage,
    integratedSourceManifest,
    sourceReadSetManifestHash: workspaceAttemptManifestHash('WorkspaceAttemptSourceReadSet', sourceReadSet),
    attemptBaselineManifestHash: workspaceAttemptManifestHash('WorkspaceAttemptBaseline', attemptBaseline),
    attemptPostimageManifestHash: workspaceAttemptManifestHash('WorkspaceAttemptPostimage', attemptPostimage),
    integratedSourceManifestHash: workspaceAttemptManifestHash('WorkspaceAttemptIntegratedSource', integratedSourceManifest),
  };
  return Object.freeze({
    ...payload,
    workspaceAttemptIntegrationDescriptorHash: hashRecord('WorkspaceAttemptIntegrationDescriptor', payload),
  });
}

export function verifyWorkspaceIntegrationDescriptor(descriptor) {
  if (!descriptor || descriptor.version !== DESCRIPTOR_VERSION
    || descriptor.kind !== 'WorkspaceAttemptIntegrationDescriptor') {
    throw integrationError('workspace_attempt_integration_descriptor_version_invalid');
  }
  if (!descriptor.campaignId || !descriptor.nodeId || !descriptor.originalAttemptId) {
    throw integrationError('workspace_attempt_integration_descriptor_identity_missing');
  }
  verifyWorkspaceAttemptRootIdentityClaim(descriptor.sourceRootIdentity, 'source');
  verifyWorkspaceAttemptRootIdentityClaim(descriptor.attemptRootIdentity, 'attempt');
  if (!Array.isArray(descriptor.excludedNames)
    || descriptor.excludedNames.some((name) => !name || typeof name !== 'string')
    || JSON.stringify(descriptor.excludedNames) !== JSON.stringify([...new Set(descriptor.excludedNames)].sort())) {
    throw integrationError('workspace_attempt_excluded_names_invalid');
  }
  const sourceReadSet = canonicalWorkspaceAttemptRows(
    descriptor.sourceReadSet,
    'source_read_set',
    { requireCanonicalInput: true },
  );
  const attemptBaseline = canonicalWorkspaceAttemptRows(
    descriptor.attemptBaseline,
    'attempt_baseline',
    { requireCanonicalInput: true },
  );
  const attemptPostimage = canonicalWorkspaceAttemptRows(
    descriptor.attemptPostimage,
    'attempt_postimage',
    { requireCanonicalInput: true },
  );
  const integratedSourceManifest = canonicalWorkspaceAttemptRows(
    descriptor.integratedSourceManifest,
    'integrated_source_manifest',
    { requireCanonicalInput: true },
  );
  const changes = canonicalChanges(descriptor.changes, { requireCanonicalInput: true });
  if (workspaceAttemptManifestHash('WorkspaceAttemptSourceReadSet', sourceReadSet)
      !== descriptor.sourceReadSetManifestHash
    || workspaceAttemptManifestHash('WorkspaceAttemptBaseline', attemptBaseline)
      !== descriptor.attemptBaselineManifestHash
    || workspaceAttemptManifestHash('WorkspaceAttemptPostimage', attemptPostimage)
      !== descriptor.attemptPostimageManifestHash
    || workspaceAttemptManifestHash('WorkspaceAttemptIntegratedSource', integratedSourceManifest)
      !== descriptor.integratedSourceManifestHash) {
    throw integrationError('workspace_attempt_integration_manifest_hash_invalid');
  }
  const sourceMap = workspaceAttemptRowsMap(sourceReadSet);
  const beforeMap = workspaceAttemptRowsMap(attemptBaseline);
  const postMap = workspaceAttemptRowsMap(attemptPostimage);
  const expectedChangedPaths = changedWorkspacePaths(beforeMap, postMap);
  if (JSON.stringify(expectedChangedPaths) !== JSON.stringify(changes.map((change) => change.path))) {
    throw integrationError('workspace_attempt_integration_change_set_invalid');
  }
  for (const change of changes) {
    if (change.preimageHash !== workspaceAttemptMapHash(sourceMap, change.path)
      || change.postimageHash !== workspaceAttemptMapHash(postMap, change.path)) {
      throw integrationError('workspace_attempt_integration_change_manifest_mismatch', { detail: change.path });
    }
    if (String(change.postimageHash || '').startsWith('unsafe:')) {
      throw integrationError('workspace_attempt_postimage_unsafe', { detail: change.path });
    }
  }
  if (JSON.stringify(expectedIntegratedWorkspaceAttemptRows(sourceReadSet, changes))
    !== JSON.stringify(integratedSourceManifest)) {
    throw integrationError('workspace_attempt_integrated_manifest_invalid');
  }
  const { workspaceAttemptIntegrationDescriptorHash: claimed, ...payload } = descriptor;
  if (!claimed || hashRecord('WorkspaceAttemptIntegrationDescriptor', payload) !== claimed) {
    throw integrationError('workspace_attempt_integration_descriptor_hash_invalid');
  }
  return { sourceReadSet, attemptBaseline, attemptPostimage, integratedSourceManifest, changes };
}

export function validateWorkspaceIntegrationAuthority(descriptor, authority = {}) {
  for (const field of ['campaignId', 'nodeId', 'originalAttemptId', 'sourceRoot', 'attemptRoot', 'runtimeRoot']) {
    if (!authority[field]) {
      throw integrationError('workspace_attempt_integration_authority_required', { detail: field });
    }
  }
  if (String(authority.campaignId) !== descriptor.campaignId
    || String(authority.nodeId) !== descriptor.nodeId
    || String(authority.originalAttemptId) !== descriptor.originalAttemptId) {
    throw integrationError('workspace_attempt_integration_authority_identity_mismatch');
  }
  const sourceIdentity = workspaceAttemptRootIdentitySync(authority.sourceRoot, 'source');
  const attemptIdentity = workspaceAttemptRootIdentitySync(authority.attemptRoot, 'attempt');
  const runtimeIdentity = workspaceAttemptRootIdentitySync(authority.runtimeRoot, 'runtime');
  assertDisjointWorkspaceAttemptRoots(sourceIdentity, attemptIdentity);
  if (!isPathWithin(runtimeIdentity.realPath, attemptIdentity.realPath)) {
    throw integrationError('workspace_attempt_integration_attempt_outside_runtime');
  }
  if (descriptor.sourceWorkspace !== sourceIdentity.realPath
    || descriptor.attemptWorkspace !== attemptIdentity.realPath
    || descriptor.sourceRootIdentity.workspaceAttemptRootIdentityHash
      !== sourceIdentity.workspaceAttemptRootIdentityHash
    || descriptor.attemptRootIdentity.workspaceAttemptRootIdentityHash
      !== attemptIdentity.workspaceAttemptRootIdentityHash) {
    throw integrationError('workspace_attempt_integration_authoritative_root_mismatch');
  }
  return { sourceIdentity, attemptIdentity, runtimeIdentity };
}
