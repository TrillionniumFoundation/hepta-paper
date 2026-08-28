import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { fsyncDirectoryPathSync } from '../runtime/scoped-file-materialization-path-io.mjs';
import {
  cloneWorkspaceTreeSync,
} from './workspace-attempt-tree-cloner.mjs';
import {
  DEFAULT_WORKSPACE_ATTEMPT_EXCLUDED_NAMES,
  snapshotWorkspaceFilesSync,
  workspaceAttemptRootIdentitySync,
} from './workspace-attempt-root-snapshot.mjs';

const BINDING_VERSION = 1;
const BINDING_KIND = 'VenueMigrationWorkspaceBinding';

function safeSegment(value) {
  return String(value || 'unknown')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .replace(/^\.+$/, '_')
    .slice(0, 180) || 'unknown';
}

function canonicalRows(snapshot) {
  return [...snapshot.entries()]
    .map(([relativePath, hash]) => ({ path: relativePath, hash }))
    .filter(({ hash }) => !String(hash || '').startsWith('unsafe:'))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function snapshotHash(snapshot) {
  return hashRecord('VenueMigrationWorkspaceSnapshot', canonicalRows(snapshot));
}

function bindingHash(payload) {
  return hashRecord(BINDING_KIND, payload);
}

function readBindingSync(bindingPath) {
  try {
    const raw = fs.readFileSync(bindingPath, 'utf8');
    const parsed = JSON.parse(raw);
    const { venueMigrationWorkspaceBindingHash: claimed, ...payload } = parsed || {};
    if (!claimed || bindingHash(payload) !== claimed) {
      throw new Error('venue_migration_workspace_binding_hash_invalid');
    }
    if (payload.version !== BINDING_VERSION || payload.kind !== BINDING_KIND) {
      throw new Error('venue_migration_workspace_binding_kind_invalid');
    }
    return Object.freeze({ ...payload, venueMigrationWorkspaceBindingHash: claimed });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error('venue_migration_workspace_binding_json_invalid');
    throw error;
  }
}

function writeBindingAtomicallySync(bindingPath, binding) {
  const parent = path.dirname(bindingPath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${bindingPath}.tmp-${crypto.randomUUID()}`;
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    const body = `${JSON.stringify(binding)}\n`;
    fs.writeFileSync(descriptor, body, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, bindingPath);
  fsyncDirectoryPathSync(parent);
}

function assertEntryAndRoots(entry, runtimeRoot) {
  if (entry?.kind !== 'VenueMigrationCampaignEntry') {
    throw new Error('venue_migration_workspace_entry_invalid');
  }
  const runtimeIdentity = workspaceAttemptRootIdentitySync(runtimeRoot, 'runtime');
  const sourceIdentity = workspaceAttemptRootIdentitySync(entry.sourceWorkspace, 'source');
  const campaignWorkspace = path.resolve(entry.workspaceIsolation?.campaignWorkspaceRoot || '');
  if (!campaignWorkspace || !isPathWithin(runtimeIdentity.realPath, campaignWorkspace)) {
    throw new Error(`venue_migration_workspace_runtime_escape:${entry.paperId}`);
  }
  if (isPathWithin(sourceIdentity.realPath, campaignWorkspace)
    || isPathWithin(campaignWorkspace, sourceIdentity.realPath)) {
    throw new Error(`venue_migration_workspace_roots_overlap:${entry.paperId}`);
  }
  return Object.freeze({ runtimeIdentity, sourceIdentity, campaignWorkspace });
}

function expectedBindingPayload({ entry, runtimeIdentity, sourceIdentity, campaignWorkspace, sourceSnapshot, campaignSnapshot }) {
  return Object.freeze({
    version: BINDING_VERSION,
    kind: BINDING_KIND,
    status: 'venue_migration_workspace_bound',
    paperId: entry.paperId,
    campaignId: entry.campaignId,
    migrationKey: entry.migrationKey,
    sourceVenue: entry.sourceVenue,
    targetVenue: entry.targetVenue,
    sourceWorkspace: sourceIdentity.realPath,
    campaignWorkspaceRoot: campaignWorkspace,
    runtimeRoot: runtimeIdentity.realPath,
    sourceRootIdentityHash: sourceIdentity.workspaceAttemptRootIdentityHash,
    sourceSnapshotHash: snapshotHash(sourceSnapshot),
    campaignRootIdentityHash: workspaceAttemptRootIdentitySync(campaignWorkspace, 'campaign').workspaceAttemptRootIdentityHash,
    campaignSnapshotHash: snapshotHash(campaignSnapshot),
    sourceMutationPolicy: 'canonical_read_only',
    externalSubmissionEnabled: false,
  });
}

function readOrBindExistingWorkspace({ entry, roots, bindingPath }) {
  const binding = readBindingSync(bindingPath);
  if (!binding) return null;
  if (binding.paperId !== entry.paperId
    || binding.campaignId !== entry.campaignId
    || binding.migrationKey !== entry.migrationKey
    || binding.sourceWorkspace !== roots.sourceIdentity.realPath
    || binding.campaignWorkspaceRoot !== roots.campaignWorkspace
    || binding.sourceRootIdentityHash !== roots.sourceIdentity.workspaceAttemptRootIdentityHash) {
    throw new Error(`venue_migration_workspace_binding_mismatch:${entry.paperId}`);
  }
  const sourceSnapshot = snapshotWorkspaceFilesSync({
    root: roots.sourceIdentity.realPath,
    excludedNames: DEFAULT_WORKSPACE_ATTEMPT_EXCLUDED_NAMES,
  });
  if (snapshotHash(sourceSnapshot) !== binding.sourceSnapshotHash) {
    throw new Error(`venue_migration_source_changed_after_binding:${entry.paperId}`);
  }
  const campaignIdentity = workspaceAttemptRootIdentitySync(roots.campaignWorkspace, 'campaign');
  if (campaignIdentity.workspaceAttemptRootIdentityHash !== binding.campaignRootIdentityHash) {
    throw new Error(`venue_migration_campaign_workspace_replaced:${entry.paperId}`);
  }
  return Object.freeze({
    ...binding,
    status: 'venue_migration_workspace_reused',
    venueMigrationWorkspaceBindingHash: binding.venueMigrationWorkspaceBindingHash,
  });
}

/**
 * Materialize one campaign-level COW workspace.  The operation is deterministic
 * for a migration entry and idempotent after its binding marker is published.
 * The canonical source is snapshotted before and after cloning and is never a
 * destination of a write in this module.
 */
export function materializeVenueMigrationWorkspaceSync({
  entry,
  runtimeRoot,
  excludedNames = DEFAULT_WORKSPACE_ATTEMPT_EXCLUDED_NAMES,
} = {}) {
  const roots = assertEntryAndRoots(entry, runtimeRoot);
  const bindingPath = path.resolve(
    entry.workspaceIsolation?.bindingMarkerPath
      || path.join(roots.runtimeIdentity.realPath, 'venue-migration-workspace-bindings', `${safeSegment(entry.campaignId)}.json`),
  );
  if (!isPathWithin(roots.runtimeIdentity.realPath, bindingPath)) {
    throw new Error(`venue_migration_workspace_binding_runtime_escape:${entry.paperId}`);
  }
  if (fs.existsSync(roots.campaignWorkspace)) {
    const reused = readOrBindExistingWorkspace({ entry, roots, bindingPath });
    if (reused) return reused;
    throw new Error(`venue_migration_workspace_orphaned:${entry.paperId}`);
  }
  if (fs.existsSync(bindingPath)) {
    // A marker without its destination is an incomplete prior publication;
    // never overwrite it implicitly because doing so would lose lineage.
    throw new Error(`venue_migration_workspace_binding_orphaned:${entry.paperId}`);
  }

  const lockPath = `${bindingPath}.lock`;
  fs.mkdirSync(path.dirname(bindingPath), { recursive: true, mode: 0o700 });
  let lockOwned = false;
  let stagingRelative = null;
  let stagingPath = null;
  try {
    try {
      fs.mkdirSync(lockPath, { recursive: false, mode: 0o700 });
      lockOwned = true;
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error(`venue_migration_workspace_materialization_in_progress:${entry.paperId}`);
      }
      throw error;
    }
    // Re-check after taking the lock in case another process published between
    // the initial existence check and lock acquisition.
    if (fs.existsSync(roots.campaignWorkspace)) {
      const reused = readOrBindExistingWorkspace({ entry, roots, bindingPath });
      if (reused) return reused;
      throw new Error(`venue_migration_workspace_orphaned:${entry.paperId}`);
    }
    if (fs.existsSync(bindingPath)) {
      throw new Error(`venue_migration_workspace_binding_orphaned:${entry.paperId}`);
    }
    const sourceBefore = snapshotWorkspaceFilesSync({
      root: roots.sourceIdentity.realPath,
      excludedNames,
    });
    const stageToken = `${safeSegment(entry.campaignId)}-${crypto.randomUUID()}`;
    stagingRelative = path.posix.join('venue-migration-workspaces', '.staging', stageToken);
    stagingPath = path.resolve(roots.runtimeIdentity.realPath, ...stagingRelative.split('/'));
    cloneWorkspaceTreeSync({
      sourceRoot: roots.sourceIdentity.realPath,
      destinationBaseRoot: roots.runtimeIdentity.realPath,
      destinationRelative: stagingRelative,
      excludedNames,
    });
    const sourceAfter = snapshotWorkspaceFilesSync({
      root: roots.sourceIdentity.realPath,
      excludedNames,
    });
    if (JSON.stringify(canonicalRows(sourceBefore)) !== JSON.stringify(canonicalRows(sourceAfter))) {
      throw new Error(`venue_migration_source_changed_during_clone:${entry.paperId}`);
    }
    const campaignSnapshot = snapshotWorkspaceFilesSync({
      root: stagingPath,
      excludedNames,
    });
    if (JSON.stringify(canonicalRows(sourceBefore)) !== JSON.stringify(canonicalRows(campaignSnapshot))) {
      throw new Error(`venue_migration_clone_manifest_mismatch:${entry.paperId}`);
    }
    fs.mkdirSync(path.dirname(roots.campaignWorkspace), { recursive: true, mode: 0o700 });
    fs.renameSync(stagingPath, roots.campaignWorkspace);
    stagingPath = null;
    const campaignIdentity = workspaceAttemptRootIdentitySync(roots.campaignWorkspace, 'campaign');
    const payload = expectedBindingPayload({
      entry,
      runtimeIdentity: roots.runtimeIdentity,
      sourceIdentity: roots.sourceIdentity,
      campaignWorkspace: roots.campaignWorkspace,
      sourceSnapshot: sourceBefore,
      campaignSnapshot,
    });
    const binding = Object.freeze({
      ...payload,
      campaignRootIdentityHash: campaignIdentity.workspaceAttemptRootIdentityHash,
      venueMigrationWorkspaceBindingHash: bindingHash({
        ...payload,
        campaignRootIdentityHash: campaignIdentity.workspaceAttemptRootIdentityHash,
      }),
    });
    writeBindingAtomicallySync(bindingPath, binding);
    return binding;
  } catch (error) {
    if (stagingPath && isPathWithin(roots.runtimeIdentity.realPath, stagingPath)) {
      try { fs.rmSync(stagingPath, { recursive: true, force: true }); } catch {}
    }
    throw error;
  } finally {
    if (lockOwned) {
      try { fs.rmdirSync(lockPath); } catch {}
    }
  }
}

export function materializeVenueMigrationWorkspacesSync({
  manifest,
  runtimeRoot,
  excludedNames = DEFAULT_WORKSPACE_ATTEMPT_EXCLUDED_NAMES,
} = {}) {
  if (manifest?.kind !== 'VenueMigrationCampaignManifest') {
    throw new Error('venue_migration_manifest_required');
  }
  const bindings = manifest.entries.map((entry) => materializeVenueMigrationWorkspaceSync({
    entry,
    runtimeRoot,
    excludedNames,
  }));
  return Object.freeze({
    status: 'venue_migration_workspaces_ready',
    manifestHash: manifest.manifestHash,
    bindings: Object.freeze(bindings),
    bindingCount: bindings.length,
    sourceMutationPolicy: 'canonical_read_only',
  });
}
