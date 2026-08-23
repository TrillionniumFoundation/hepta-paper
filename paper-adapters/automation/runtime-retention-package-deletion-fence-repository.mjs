import crypto from 'node:crypto';
import path from 'node:path';

import { hasExactPlainObjectKeys }
  from '../../workflow-kernel/exact-object-keys.mjs';
import {
  createPreparedPackageDeletionFence,
  packageDeletionFenceTokenHash,
  samePackageDeletionFenceBinding,
  transitionPackageDeletionFence,
} from './runtime-retention-package-deletion-fence-contract.mjs';
import { createRuntimeRetentionPackageDeletionFenceStorageRepository }
  from './runtime-retention-package-deletion-fence-storage-repository.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const HANDLE_KEYS = Object.freeze([
  'fenceToken', 'generation', 'kind', 'packageLifecycleReceiptHash',
  'recordHash', 'version',
]);
const SELECTOR_KEYS = new Set([
  'packageLifecycleReceiptHash', 'packagePath', 'packageContentHash',
  'deletionIntentHash', 'operationId',
]);

function fail(code, cause = null) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  throw error;
}

function validHandle(handle) {
  return Boolean(hasExactPlainObjectKeys(handle, HANDLE_KEYS)
    && handle.version === 1
    && handle.kind === 'RuntimeRetentionPackageDeletionFenceHandle'
    && SHA256.test(String(handle.packageLifecycleReceiptHash || ''))
    && Number.isSafeInteger(handle.generation) && handle.generation >= 1
    && typeof handle.fenceToken === 'string'
    && SHA256.test(String(handle.recordHash || '')));
}

function handleFor(record, fenceToken) {
  return Object.freeze({
    version: 1,
    kind: 'RuntimeRetentionPackageDeletionFenceHandle',
    packageLifecycleReceiptHash: record.packageLifecycleReceiptHash,
    generation: record.generation,
    fenceToken,
    recordHash: record.runtimeRetentionPackageDeletionFenceHash,
  });
}

function assertHandle(record, handle, expectedRecordHash) {
  if (!record || !validHandle(handle)
    || handle.packageLifecycleReceiptHash !== record.packageLifecycleReceiptHash
    || handle.generation !== record.generation
    || packageDeletionFenceTokenHash(handle.fenceToken) !== record.fenceTokenHash
    || !SHA256.test(String(expectedRecordHash || ''))
    || expectedRecordHash !== record.runtimeRetentionPackageDeletionFenceHash) {
    fail('runtime_retention_package_deletion_fence_compare_failed');
  }
}

function normalizedSelector(selector, runtimeRoot) {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)
    || Object.getPrototypeOf(selector) !== Object.prototype) {
    fail('runtime_retention_package_deletion_fence_selector_invalid');
  }
  const entries = Object.entries(selector).filter(([, value]) => value !== null
    && value !== undefined);
  if (!entries.length || entries.some(([key, value]) =>
    !SELECTOR_KEYS.has(key) || typeof value !== 'string' || !value.length)) {
    fail('runtime_retention_package_deletion_fence_selector_invalid');
  }
  const selected = Object.fromEntries(entries);
  for (const key of [
    'packageLifecycleReceiptHash', 'packageContentHash', 'deletionIntentHash',
  ]) {
    if (Object.hasOwn(selected, key) && !SHA256.test(selected[key])) {
      fail('runtime_retention_package_deletion_fence_selector_invalid');
    }
  }
  if (Object.hasOwn(selected, 'packagePath')) {
    const candidate = path.resolve(selected.packagePath);
    if (!path.isAbsolute(selected.packagePath) || candidate !== selected.packagePath
      || path.dirname(candidate) !== path.join(runtimeRoot, 'packages')) {
      fail('runtime_retention_package_deletion_fence_selector_invalid');
    }
  }
  return Object.freeze(selected);
}

function selectorMatches(record, selector) {
  // Multiple identities are alternate ways to identify a protected package.
  // OR semantics prevents a caller from padding a true selector with one false
  // field to evade a terminal fence.
  return Object.entries(selector).some(([key, value]) => record[key] === value);
}

function inspectAccess(records, selector, { writer, runtimeRoot }) {
  const selected = normalizedSelector(selector, runtimeRoot);
  const active = records.filter((record) => ['prepared', 'deleting'].includes(record.status));
  const matchingTerminal = records.filter((record) => record.status === 'deleted'
    && selectorMatches(record, selected));
  const matchingActive = active.filter((record) => selectorMatches(record, selected));
  const blockers = [
    ...(writer && active.length
      ? ['runtime_retention_package_deletion_fence_reachability_mutation_blocked'] : []),
    ...(!writer && matchingActive.length
      ? ['runtime_retention_package_deletion_fence_read_blocked'] : []),
    ...(matchingTerminal.length
      ? ['runtime_retention_package_deletion_fence_package_deleted'] : []),
  ];
  return Object.freeze({
    allowed: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
    activeFenceHashes: Object.freeze(active.map((record) =>
      record.runtimeRetentionPackageDeletionFenceHash).sort()),
    matchingFenceHashes: Object.freeze([
      ...matchingActive,
      ...matchingTerminal,
    ].map((record) => record.runtimeRetentionPackageDeletionFenceHash).sort()),
  });
}

export function createRuntimeRetentionPackageDeletionFenceRepository({
  runtimeRoot,
  randomToken = () => crypto.randomBytes(32).toString('base64url'),
} = {}) {
  if (typeof runtimeRoot !== 'string' || !runtimeRoot.trim()
    || typeof randomToken !== 'function') {
    fail('runtime_retention_package_deletion_fence_repository_invalid');
  }
  const root = path.resolve(runtimeRoot);
  const {
    assertLocked,
    list: listRecords,
    read: readRecord,
    runLocked: locked,
    write: writeRecord,
  } = createRuntimeRetentionPackageDeletionFenceStorageRepository({ runtimeRoot: root });

  return Object.freeze({
    version: 1,
    kind: 'RuntimeRetentionPackageDeletionFenceRepository',
    inspect(packageLifecycleReceiptHash) {
      return locked((scope) => readRecord(scope, packageLifecycleReceiptHash));
    },
    list() {
      return locked((scope) => listRecords(scope));
    },
    prepare(request = {}) {
      return locked((scope) => {
        const prior = readRecord(scope, request.packageLifecycleReceiptHash);
        const fenceToken = request.fenceToken || randomToken();
        const requested = {
          ...request,
          runtimeRoot: root,
          fenceTokenHash: packageDeletionFenceTokenHash(fenceToken),
        };
        if (prior && ['prepared', 'deleting'].includes(prior.status)) {
          if (samePackageDeletionFenceBinding(prior, requested)
            && prior.fenceTokenHash === requested.fenceTokenHash) {
            return Object.freeze({ record: prior, handle: handleFor(prior, fenceToken) });
          }
          fail('runtime_retention_package_deletion_fence_already_active');
        }
        if (prior?.status === 'deleted') {
          fail('runtime_retention_package_deletion_fence_package_deleted');
        }
        const expectedPrevious = request.expectedPreviousFenceHash ?? null;
        if ((prior?.runtimeRetentionPackageDeletionFenceHash || null)
          !== expectedPrevious) {
          fail('runtime_retention_package_deletion_fence_compare_failed');
        }
        const record = createPreparedPackageDeletionFence({
          ...requested,
          generation: (prior?.generation || 0) + 1,
          previousFenceHash: prior?.runtimeRetentionPackageDeletionFenceHash || null,
        });
        assertLocked(scope);
        const persisted = writeRecord(scope, record);
        return Object.freeze({
          record: persisted,
          handle: handleFor(persisted, fenceToken),
        });
      });
    },
    resume(request = {}) {
      return locked((scope) => {
        const current = readRecord(scope, request.packageLifecycleReceiptHash);
        const fenceToken = request.fenceToken;
        const requested = {
          ...request,
          runtimeRoot: root,
          fenceTokenHash: packageDeletionFenceTokenHash(fenceToken),
        };
        if (!current
          || !samePackageDeletionFenceBinding(current, requested)
          || current.fenceTokenHash !== requested.fenceTokenHash) {
          fail('runtime_retention_package_deletion_fence_compare_failed');
        }
        return Object.freeze({
          record: current,
          handle: handleFor(current, fenceToken),
        });
      });
    },
    transition(handle, {
      expectedRecordHash,
      status,
      transitionedAt,
      transitionId,
      abortReasonHash = null,
    } = {}) {
      return locked((scope) => {
        const current = readRecord(scope, handle?.packageLifecycleReceiptHash);
        if (current?.status === status && current.transitionId === transitionId
          && validHandle(handle)
          && handle.generation === current.generation
          && handle.recordHash === expectedRecordHash
          && packageDeletionFenceTokenHash(handle.fenceToken) === current.fenceTokenHash
          && expectedRecordHash === current.previousFenceHash) {
          return Object.freeze({
            record: current,
            handle: handleFor(current, handle.fenceToken),
          });
        }
        assertHandle(current, handle, expectedRecordHash);
        const next = transitionPackageDeletionFence(current, {
          status,
          transitionedAt,
          transitionId,
          abortReasonHash,
        });
        assertLocked(scope);
        const persisted = writeRecord(scope, next);
        return Object.freeze({
          record: persisted,
          handle: handleFor(persisted, handle.fenceToken),
        });
      });
    },
    assertHeld(handle, { statuses = ['prepared', 'deleting'] } = {}) {
      return locked((scope) => {
        const current = readRecord(scope, handle?.packageLifecycleReceiptHash);
        assertHandle(current, handle, handle?.recordHash);
        if (!Array.isArray(statuses) || !statuses.includes(current.status)) {
          fail('runtime_retention_package_deletion_fence_not_held');
        }
        return current;
      });
    },
    withDeletionGuard(handle, operation) {
      if (typeof operation !== 'function') {
        fail('runtime_retention_package_deletion_fence_guard_operation_invalid');
      }
      return locked((scope) => {
        const current = readRecord(scope, handle?.packageLifecycleReceiptHash);
        assertHandle(current, handle, handle?.recordHash);
        if (current.status !== 'deleting') {
          fail('runtime_retention_package_deletion_fence_not_held');
        }
        const value = operation(Object.freeze({
          record: current,
          assertHeld: () => {
            assertLocked(scope);
            return current;
          },
        }));
        if (value && typeof value.then === 'function') {
          fail('runtime_retention_package_deletion_fence_async_guard_forbidden');
        }
        assertLocked(scope);
        return value;
      });
    },
    inspectReaderAuthority(selector) {
      return locked((scope) => inspectAccess(listRecords(scope), selector, {
        writer: false,
        runtimeRoot: root,
      }));
    },
    inspectWriterAuthority(selector) {
      return locked((scope) => inspectAccess(listRecords(scope), selector, {
        writer: true,
        runtimeRoot: root,
      }));
    },
    withReaderGuard(selector, operation) {
      if (typeof operation !== 'function') {
        fail('runtime_retention_package_deletion_fence_guard_operation_invalid');
      }
      return locked((scope) => {
        const authority = inspectAccess(listRecords(scope), selector, {
          writer: false,
          runtimeRoot: root,
        });
        if (!authority.allowed) fail(authority.blockers[0]);
        return operation(Object.freeze({ authority, assertHeld: () => {
          assertLocked(scope);
          return true;
        } }));
      });
    },
    withWriterGuard(selector, operation) {
      if (typeof operation !== 'function') {
        fail('runtime_retention_package_deletion_fence_guard_operation_invalid');
      }
      return locked((scope) => {
        const authority = inspectAccess(listRecords(scope), selector, {
          writer: true,
          runtimeRoot: root,
        });
        if (!authority.allowed) fail(authority.blockers[0]);
        return operation(Object.freeze({ authority, assertHeld: () => {
          assertLocked(scope);
          return true;
        } }));
      });
    },
  });
}
