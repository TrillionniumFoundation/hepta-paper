import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { runtimeError } from './codex-openclaw-managed-runtime-common.mjs';

const MAXIMUM_MANAGED_STDOUT_NOISE_BYTES = 64 * 1024;
const ACTIVE_MANAGED_STDOUT_GUARDS = new WeakSet();
const MANAGED_SESSION_STORE_LOCK_BACKENDS = Object.freeze([
  '/usr/bin/flock',
  '/bin/flock',
]);
function managedSessionStoreLockBackend() {
  for (const candidate of MANAGED_SESSION_STORE_LOCK_BACKENDS) {
    try {
      const resolved = fs.realpathSync(candidate);
      const stat = fs.statSync(resolved);
      fs.accessSync(resolved, fs.constants.X_OK);
      if (stat.isFile() && (stat.mode & 0o022) === 0) return resolved;
    } catch { /* try the next system location */ }
  }
  throw runtimeError(
    'codex_openclaw_managed_session_store_lock_backend_unavailable',
  );
}
function openManagedSessionStoreLockDirectory(sessionsDir) {
  const requested = path.resolve(String(sessionsDir || ''));
  let descriptor = null;
  try {
    const resolved = fs.realpathSync(requested);
    const linkStat = fs.lstatSync(requested);
    descriptor = fs.openSync(
      requested,
      fs.constants.O_RDONLY
        | fs.constants.O_DIRECTORY
        | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    const owned = typeof process.getuid !== 'function'
      || opened.uid === process.getuid();
    if (resolved !== requested || linkStat.isSymbolicLink()
      || !linkStat.isDirectory() || !opened.isDirectory() || !owned
      || opened.dev !== linkStat.dev || opened.ino !== linkStat.ino) {
      fs.closeSync(descriptor);
      descriptor = null;
      throw new Error('managed session store lock directory invalid');
    }
    return descriptor;
  } catch {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* preserve scope failure */ }
    }
    throw runtimeError(
      'codex_openclaw_managed_session_store_lock_scope_invalid',
    );
  }
}

async function acquireManagedSessionStoreLifecycleLock({
  sessionsDir,
  timeoutMs,
  signal = null,
} = {}) {
  const effectiveTimeoutMs = Number(timeoutMs);
  if (!Number.isFinite(effectiveTimeoutMs) || effectiveTimeoutMs < 1) {
    throw runtimeError(
      'codex_openclaw_managed_session_store_lock_timeout_invalid',
    );
  }
  if (signal?.aborted) {
    throw runtimeError('codex_openclaw_managed_model_cancelled');
  }
  const descriptor = openManagedSessionStoreLockDirectory(sessionsDir);
  let child;
  try {
    child = spawn(managedSessionStoreLockBackend(), [
      '--exclusive',
      '--timeout',
      (effectiveTimeoutMs / 1000).toFixed(3),
      '3',
    ], {
      stdio: ['ignore', 'ignore', 'ignore', descriptor],
    });
  } catch {
    fs.closeSync(descriptor);
    throw runtimeError(
      'codex_openclaw_managed_session_store_lock_backend_failed',
    );
  }
  const outcome = await new Promise((resolve) => {
    let aborted = false;
    const abort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', () => {
      signal?.removeEventListener('abort', abort);
      resolve({ kind: 'backend_failed' });
    });
    child.once('exit', (code, childSignal) => {
      signal?.removeEventListener('abort', abort);
      resolve({
        kind: aborted ? 'cancelled'
          : code === 0 && childSignal === null ? 'acquired'
            : code === 1 && childSignal === null ? 'timeout'
              : 'backend_failed',
      });
    });
  });
  if (outcome.kind !== 'acquired') {
    fs.closeSync(descriptor);
    if (outcome.kind === 'cancelled') {
      throw runtimeError('codex_openclaw_managed_model_cancelled');
    }
    throw runtimeError(
      outcome.kind === 'timeout'
        ? 'codex_openclaw_managed_session_store_lock_timeout'
        : 'codex_openclaw_managed_session_store_lock_backend_failed',
    );
  }
  return Object.freeze({
    release() { fs.closeSync(descriptor); },
  });
}

export async function withCodexOpenClawManagedSessionStoreLifecycleLock(
  operation,
  options = {},
) {
  if (typeof operation !== 'function') {
    throw runtimeError(
      'codex_openclaw_managed_session_store_lock_operation_invalid',
    );
  }
  const lock = await acquireManagedSessionStoreLifecycleLock(options);
  let operationError = null;
  try {
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      lock.release();
    } catch {
      if (!operationError) {
        throw runtimeError(
          'codex_openclaw_managed_session_store_lock_release_failed',
        );
      }
    }
  }
}
export async function withCodexOpenClawManagedStdoutIsolation(
  operation,
  { output = process.stdout } = {},
) {
  if (typeof operation !== 'function'
    || (typeof output !== 'object' && typeof output !== 'function')
    || output === null
    || typeof output.write !== 'function') {
    throw runtimeError('codex_openclaw_managed_stdout_isolation_invalid');
  }
  if (ACTIVE_MANAGED_STDOUT_GUARDS.has(output)) {
    throw runtimeError('codex_openclaw_managed_stdout_guard_already_active');
  }
  const hadOwnWrite = Object.hasOwn(output, 'write');
  const originalDescriptor = Object.getOwnPropertyDescriptor(output, 'write');
  const originalWrite = output.write;
  let capturedBytes = 0;
  let invalidWriteObserved = false;
  const discardWrite = (_chunk, encoding, callback) => {
    const completion = typeof encoding === 'function'
      ? encoding
      : callback;
    if (typeof completion === 'function') queueMicrotask(completion);
    try {
      let byteLength = null;
      if (typeof _chunk === 'string') {
        const normalizedEncoding = typeof encoding === 'string'
          ? encoding
          : 'utf8';
        byteLength = Buffer.byteLength(_chunk, normalizedEncoding);
      } else if (_chunk instanceof Uint8Array) {
        byteLength = _chunk.byteLength;
      }
      if (byteLength === null) {
        invalidWriteObserved = true;
      } else {
        capturedBytes = Math.min(
          MAXIMUM_MANAGED_STDOUT_NOISE_BYTES + 1,
          capturedBytes + byteLength,
        );
      }
    } catch {
      invalidWriteObserved = true;
    }
    return true;
  };

  ACTIVE_MANAGED_STDOUT_GUARDS.add(output);
  try {
    if (originalDescriptor?.configurable === false) {
      if (!Object.hasOwn(originalDescriptor, 'value')
        || originalDescriptor.writable !== true) {
        throw new Error('stdout write property is not replaceable');
      }
      Object.defineProperty(output, 'write', { value: discardWrite });
    } else {
      Object.defineProperty(output, 'write', {
        configurable: true,
        enumerable: originalDescriptor?.enumerable === true,
        writable: true,
        value: discardWrite,
      });
    }
  } catch {
    ACTIVE_MANAGED_STDOUT_GUARDS.delete(output);
    throw runtimeError('codex_openclaw_managed_stdout_guard_install_failed');
  }

  let operationResult;
  let operationError = null;
  let ownershipLost = false;
  let restorationFailed = false;
  try {
    operationResult = await operation();
  } catch (error) {
    operationError = error;
  } finally {
    ownershipLost = output.write !== discardWrite;
    try {
      if (hadOwnWrite) {
        Object.defineProperty(output, 'write', originalDescriptor);
      } else if (!delete output.write) {
        throw new Error('stdout write property could not be removed');
      }
      if (output.write !== originalWrite) {
        throw new Error('stdout write property was not restored');
      }
    } catch {
      restorationFailed = true;
    }
    ACTIVE_MANAGED_STDOUT_GUARDS.delete(output);
  }
  if (restorationFailed) {
    throw runtimeError(
      'codex_openclaw_managed_stdout_guard_restore_failed',
    );
  }
  if (ownershipLost) {
    throw runtimeError(
      'codex_openclaw_managed_stdout_guard_ownership_lost',
    );
  }
  if (invalidWriteObserved) {
    throw runtimeError(
      'codex_openclaw_managed_stdout_guard_write_invalid',
    );
  }
  if (capturedBytes > MAXIMUM_MANAGED_STDOUT_NOISE_BYTES) {
    throw runtimeError(
      'codex_openclaw_managed_stdout_guard_limit_exceeded',
    );
  }
  if (operationError) throw operationError;
  return operationResult;
}
