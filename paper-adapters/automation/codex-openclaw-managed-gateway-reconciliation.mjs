import fs from 'node:fs';
import path from 'node:path';

import {
  runtimeError,
} from './codex-openclaw-managed-runtime-common.mjs';

export const GATEWAY_RPC_ATTEMPT_TIMEOUT_MS = 30_000;
export const GATEWAY_ABORT_WINDOW_MS = 30_000;
export const GATEWAY_TERMINAL_WAIT_WINDOW_MS = 30_000;
export const GATEWAY_SESSION_DELETE_WINDOW_MS = 180_000;
export const GATEWAY_CLEANUP_WINDOW_MS = 240_000;
export const GATEWAY_RECONCILIATION_INITIAL_DELAY_MS = 100;
export const GATEWAY_RECONCILIATION_MAXIMUM_DELAY_MS = 5_000;
export const GATEWAY_ARTIFACT_QUIET_WINDOW_MS = 25;

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;
const ARTIFACT_SUFFIXES = Object.freeze([
  '.jsonl',
  '.trajectory.jsonl',
  '.trajectory-path.json',
  '.jsonl.codex-app-server.json',
  '.jsonl.codex-app-server.json.migrated',
]);
const LEGACY_ARTIFACT_QUARANTINE = /^\.hepta-cleanup-[0-9]+-[0-9a-f]{32}$/;

function objectRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function directoryIdentity(stat) {
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
  });
}

function fileIdentity(stat) {
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
    links: String(stat.nlink),
    owner: String(stat.uid),
  });
}

function sameIdentity(left, right) {
  return Boolean(left && right
    && Object.keys(left).every((key) => left[key] === right[key]));
}

function currentUserOwns(stat) {
  return typeof process.getuid !== 'function' || Number(stat.uid) === process.getuid();
}

function privateOwnedDirectory(stat, {
  allowOtherOwner = false,
  allowWorldWrite = false,
} = {}) {
  return stat.isDirectory()
    && (allowOtherOwner || currentUserOwns(stat))
    && (allowWorldWrite || (stat.mode & 0o002n) === 0n)
    && (!(allowOtherOwner && (stat.mode & 0o002n) !== 0n)
      || (stat.mode & 0o1000n) !== 0n);
}

function descriptorPath(descriptor) {
  return path.join('/proc/self/fd', String(descriptor));
}

function safeChildName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name !== '.'
    && name !== '..'
    && path.basename(name) === name
    && !name.includes('/')
    && !name.includes('\\');
}

function pinnedChildPath(directory, name) {
  if (!safeChildName(name)) {
    throw runtimeError(
      'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
    );
  }
  return path.join(directory.descriptorPath, name);
}

function openPinnedDirectory(candidate, {
  allowOtherOwner = false,
  allowWorldWrite = false,
  errorCode = 'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
} = {}) {
  const selected = path.resolve(String(candidate || ''));
  let descriptor;
  try {
    const before = fs.lstatSync(selected, { bigint: true });
    if (!privateOwnedDirectory(before, { allowOtherOwner, allowWorldWrite })
      || before.isSymbolicLink()
      || fs.realpathSync.native(selected) !== selected) {
      throw new Error('directory is not canonical');
    }
    descriptor = fs.openSync(
      selected,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const identity = directoryIdentity(opened);
    const openedPath = descriptorPath(descriptor);
    if (!privateOwnedDirectory(opened, { allowOtherOwner, allowWorldWrite })
      || !sameIdentity(directoryIdentity(before), identity)
      || fs.realpathSync.native(openedPath) !== selected) {
      throw new Error('directory descriptor is not canonical');
    }
    return {
      path: selected,
      descriptor,
      descriptorPath: openedPath,
      identity,
      allowOtherOwner,
      allowWorldWrite,
      closed: false,
    };
  } catch {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw runtimeError(errorCode);
  }
}

function assertPinnedDirectoryCurrent(directory, errorCode) {
  try {
    const selected = fs.lstatSync(directory.path, { bigint: true });
    const opened = fs.fstatSync(directory.descriptor, { bigint: true });
    if (directory.closed
      || selected.isSymbolicLink()
      || !privateOwnedDirectory(selected, {
        allowOtherOwner: directory.allowOtherOwner,
        allowWorldWrite: directory.allowWorldWrite,
      })
      || !privateOwnedDirectory(opened, {
        allowOtherOwner: directory.allowOtherOwner,
        allowWorldWrite: directory.allowWorldWrite,
      })
      || !sameIdentity(directory.identity, directoryIdentity(selected))
      || !sameIdentity(directory.identity, directoryIdentity(opened))) {
      throw new Error('directory identity changed');
    }
  } catch {
    throw runtimeError(errorCode);
  }
}

function closePinnedDirectory(directory) {
  if (!directory || directory.closed) return;
  try {
    fs.closeSync(directory.descriptor);
  } finally {
    directory.closed = true;
  }
}

function artifactRootPaths(runtime, { agentId, openclawStateDir } = {}) {
  const stateRoot = path.resolve(String(openclawStateDir || ''));
  return Object.freeze({
    sessions: path.join(stateRoot, 'agents', String(agentId || ''), 'sessions'),
    internalRuns: path.join(stateRoot, 'internal-agent-runs'),
    runtimeSessions: path.resolve(String(runtime?.sessionsDir || '')),
    runtimeInternalRuns: path.resolve(String(runtime?.internalRunsDir || '')),
  });
}

export function openGatewayArtifactScope(runtime, options = {}) {
  const roots = artifactRootPaths(runtime, options);
  if (roots.sessions !== roots.runtimeSessions
    || roots.internalRuns !== roots.runtimeInternalRuns
    || roots.sessions === roots.internalRuns) {
    throw runtimeError(
      'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
    );
  }
  const opened = [];
  try {
    opened.push(openPinnedDirectory(roots.sessions));
    opened.push(openPinnedDirectory(roots.internalRuns));
    if (sameIdentity(opened[0].identity, opened[1].identity)) {
      throw new Error('artifact roots overlap');
    }
    const scope = { roots: opened, closed: false };
    assertNoLegacyArtifactQuarantine(scope);
    return scope;
  } catch (error) {
    for (const root of opened.reverse()) {
      try { closePinnedDirectory(root); } catch { /* Preserve first failure. */ }
    }
    if (error?.code) throw error;
    throw runtimeError(
      'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
    );
  }
}

export function closeGatewayArtifactScope(scope) {
  if (!scope || scope.closed) return;
  let firstFailure = null;
  for (const root of [...scope.roots].reverse()) {
    try { closePinnedDirectory(root); } catch (error) { firstFailure ||= error; }
  }
  scope.closed = true;
  if (firstFailure) throw firstFailure;
}

function uniqueIdentities(identities) {
  const selected = [...new Set((identities || [])
    .map((identity) => String(identity || '').trim())
    .filter(Boolean))];
  if (selected.some(
    (identity) => !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(identity),
  )) {
    throw runtimeError(
      'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
    );
  }
  return selected;
}

function artifactResidue(scope, identities) {
  const prefixes = uniqueIdentities(identities).map((identity) => `${identity}.`);
  return scope.roots.flatMap((root) => {
    assertPinnedDirectoryCurrent(
      root,
      'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
    );
    return fs.readdirSync(root.descriptorPath)
      .filter((entry) => prefixes.some((prefix) => entry.startsWith(prefix)))
      .map((entry) => Object.freeze({ root, name: entry }));
  });
}

function legacyArtifactQuarantineResidue(scope) {
  return scope.roots.flatMap((root) => {
    assertPinnedDirectoryCurrent(
      root,
      'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
    );
    return fs.readdirSync(root.descriptorPath)
      .filter((entry) => LEGACY_ARTIFACT_QUARANTINE.test(entry))
      .map((entry) => Object.freeze({ root, name: entry }));
  });
}

function assertNoLegacyArtifactQuarantine(scope) {
  if (!scope || scope.closed
    || legacyArtifactQuarantineResidue(scope).length !== 0) {
    throw runtimeError(
      'codex_openclaw_managed_session_cleanup_artifact_residue_detected',
    );
  }
}

export function assertGatewayArtifactNamespacesEmpty(scope, identities) {
  assertNoLegacyArtifactQuarantine(scope);
  if (!scope || scope.closed || artifactResidue(scope, identities).length !== 0) {
    throw runtimeError(
      'codex_openclaw_managed_session_cleanup_artifact_residue_detected',
    );
  }
}

export async function assertGatewayArtifactNamespacesQuiet(scope, identities) {
  assertGatewayArtifactNamespacesEmpty(scope, identities);
  await new Promise((resolve) => setTimeout(
    resolve,
    GATEWAY_ARTIFACT_QUIET_WINDOW_MS,
  ));
  assertGatewayArtifactNamespacesEmpty(scope, identities);
}

function removePinnedExactArtifact(root, name) {
  assertPinnedDirectoryCurrent(
    root,
    'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
  );
  const source = pinnedChildPath(root, name);
  let descriptor;
  try {
    descriptor = fs.openSync(source, fs.constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw runtimeError(
      'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
    );
  }
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const identity = fileIdentity(opened);
    if (!opened.isFile() || opened.nlink !== 1n || !currentUserOwns(opened)) {
      throw runtimeError(
        'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
      );
    }
    assertPinnedDirectoryCurrent(
      root,
      'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
    );
    const selected = fs.lstatSync(source, { bigint: true });
    if (selected.isSymbolicLink()
      || !selected.isFile()
      || !sameIdentity(identity, fileIdentity(selected))) {
      throw runtimeError(
        'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
      );
    }
    fs.unlinkSync(source);
    const held = fs.fstatSync(descriptor, { bigint: true });
    if (!held.isFile()
      || held.nlink !== 0n
      || !sameIdentity(directoryIdentity(opened), directoryIdentity(held))) {
      throw runtimeError(
        'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
      );
    }
    assertPinnedDirectoryCurrent(
      root,
      'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
    );
  } catch (error) {
    if (String(error?.code || '').startsWith('codex_openclaw_')) throw error;
    throw runtimeError(
      'codex_openclaw_managed_session_cleanup_artifact_removal_failed',
    );
  } finally {
    fs.closeSync(descriptor);
  }
}

export function removeGatewaySessionArtifacts(scope, identities) {
  const selected = uniqueIdentities(identities);
  if (!scope || scope.closed || selected.length === 0) {
    throw runtimeError(
      'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
    );
  }
  assertNoLegacyArtifactQuarantine(scope);
  const allowedNames = new Set(selected.flatMap((identity) => (
    ARTIFACT_SUFFIXES.map((suffix) => `${identity}${suffix}`)
  )));
  if (artifactResidue(scope, selected)
    .some(({ name }) => !allowedNames.has(name))) {
    throw runtimeError(
      'codex_openclaw_managed_session_cleanup_artifact_residue_detected',
    );
  }
  for (const root of scope.roots) {
    for (const identity of selected) {
      for (const suffix of ARTIFACT_SUFFIXES) {
        removePinnedExactArtifact(root, `${identity}${suffix}`);
      }
    }
  }
  if (artifactResidue(scope, selected).length !== 0) {
    throw runtimeError(
      'codex_openclaw_managed_session_cleanup_artifact_residue_detected',
    );
  }
}

export function openGatewayAttemptWorkspace(candidate) {
  const workspacePath = path.resolve(String(candidate || ''));
  const parentPath = path.dirname(workspacePath);
  if (!path.basename(workspacePath).startsWith('hepta-managed-gateway-rpc-')) {
    throw runtimeError(
      'codex_openclaw_managed_session_cleanup_temporary_workspace_removal_failed',
    );
  }
  let parent;
  let workspace;
  try {
    parent = openPinnedDirectory(parentPath, {
      allowOtherOwner: true,
      allowWorldWrite: true,
      errorCode:
        'codex_openclaw_managed_session_cleanup_temporary_workspace_removal_failed',
    });
    workspace = openPinnedDirectory(workspacePath, {
      errorCode:
        'codex_openclaw_managed_session_cleanup_temporary_workspace_removal_failed',
    });
    return {
      parent,
      workspace,
      name: path.basename(workspacePath),
      closed: false,
    };
  } catch (error) {
    try { closePinnedDirectory(workspace); } catch { /* Preserve first failure. */ }
    try { closePinnedDirectory(parent); } catch { /* Preserve first failure. */ }
    throw error;
  }
}

export function closeGatewayAttemptWorkspace(pinned) {
  if (!pinned || pinned.closed) return;
  let firstFailure = null;
  try { closePinnedDirectory(pinned.workspace); } catch (error) {
    firstFailure ||= error;
  }
  try { closePinnedDirectory(pinned.parent); } catch (error) {
    firstFailure ||= error;
  }
  pinned.closed = true;
  if (firstFailure) throw firstFailure;
}

export function removeGatewayAttemptWorkspace(pinned) {
  const failureCode =
    'codex_openclaw_managed_session_cleanup_temporary_workspace_removal_failed';
  if (!pinned || pinned.closed) throw runtimeError(failureCode);
  const { parent, workspace, name } = pinned;
  assertPinnedDirectoryCurrent(parent, failureCode);
  assertPinnedDirectoryCurrent(workspace, failureCode);
  if (fs.readdirSync(workspace.descriptorPath).length !== 0) {
    throw runtimeError(failureCode);
  }
  const source = pinnedChildPath(parent, name);
  try {
    const selected = fs.lstatSync(source, { bigint: true });
    const opened = fs.fstatSync(workspace.descriptor, { bigint: true });
    if (!selected.isDirectory()
      || selected.isSymbolicLink()
      || !sameIdentity(workspace.identity, directoryIdentity(selected))
      || !sameIdentity(workspace.identity, directoryIdentity(opened))) {
      throw new Error('workspace identity changed');
    }
    fs.rmdirSync(source);
    assertPinnedDirectoryCurrent(parent, failureCode);
  } catch {
    throw runtimeError(failureCode);
  }
}

export async function waitForGatewayReconciliation({
  abortSignal,
  deadline,
  delayMs,
} = {}) {
  const remaining = Math.max(0, Number(deadline) - Date.now());
  const boundedDelay = Math.min(
    Math.max(1, Number(delayMs) || GATEWAY_RECONCILIATION_INITIAL_DELAY_MS),
    remaining,
  );
  if (boundedDelay <= 0 || abortSignal?.aborted) return;
  await new Promise((resolve) => {
    const timer = setTimeout(done, boundedDelay);
    function done() {
      abortSignal?.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    abortSignal?.addEventListener('abort', done, { once: true });
    if (abortSignal?.aborted) done();
  });
}

export function retryableGatewayFailure(error, {
  allowUnavailable = false,
} = {}) {
  const failure = error?.gatewayFailure;
  return failure?.kind === 'transport'
    || (allowUnavailable
      && failure?.kind === 'server'
      && failure.code === 'UNAVAILABLE');
}

export async function retryGatewayTransport(operation, {
  abortSignal = null,
  allowUnavailable = false,
  deadline,
} = {}) {
  let delayMs = GATEWAY_RECONCILIATION_INITIAL_DELAY_MS;
  let lastError = null;
  for (;;) {
    if (abortSignal?.aborted) {
      throw runtimeError('codex_openclaw_managed_model_cancelled');
    }
    const remainingMs = Math.max(0, Number(deadline) - Date.now());
    if (remainingMs <= 0) {
      throw lastError
        || runtimeError('codex_openclaw_managed_agent_command_failed');
    }
    try {
      return await operation(remainingMs);
    } catch (error) {
      lastError = error;
      if (!retryableGatewayFailure(error, { allowUnavailable })
        || abortSignal?.aborted
        || Date.now() >= deadline) throw error;
      const retryAfterMs = Number(error?.gatewayFailure?.retryAfterMs);
      await waitForGatewayReconciliation({
        abortSignal,
        deadline,
        delayMs: Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0
          ? Math.max(delayMs, retryAfterMs) : delayMs,
      });
      delayMs = Math.min(
        GATEWAY_RECONCILIATION_MAXIMUM_DELAY_MS,
        delayMs * 2,
      );
    }
  }
}

export function validateGatewayCleanupDescription(described, {
  prepared,
  sessionKey,
} = {}) {
  if (!objectRecord(described)) {
    throw runtimeError(
      'codex_openclaw_managed_session_cleanup_entry_inspection_failed',
    );
  }
  if (described.session === null) return null;
  const session = described.session;
  if (!objectRecord(session)
    || session.key !== sessionKey
    || typeof session.sessionId !== 'string'
    || !session.sessionId.trim()
    || !Number.isFinite(session.updatedAt)) {
    throw runtimeError(
      'codex_openclaw_managed_session_cleanup_entry_inspection_failed',
    );
  }
  if (!prepared || session.sessionId !== prepared.sessionId) {
    throw runtimeError(
      'codex_openclaw_managed_session_cleanup_entry_binding_changed',
    );
  }
  return Object.freeze({
    sessionId: session.sessionId,
    updatedAt: session.updatedAt,
  });
}
