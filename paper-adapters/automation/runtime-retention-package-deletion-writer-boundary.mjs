import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

import { createRuntimeRetentionPackageDeletionFenceRepository }
  from './runtime-retention-package-deletion-fence-repository.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SELECTOR_KEYS = new Set([
  'packageLifecycleReceiptHash',
  'packagePath',
  'packageContentHash',
  'deletionIntentHash',
  'operationId',
]);
const DEFERRED_OPERATION_KINDS = new Set([
  'AsyncFunction',
  'AsyncGeneratorFunction',
  'GeneratorFunction',
]);

function fail(code, cause = null) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  throw error;
}

function normalizedSelector(selector, runtimeRoot) {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)
    || Object.getPrototypeOf(selector) !== Object.prototype) {
    fail('runtime_retention_package_deletion_writer_boundary_selector_invalid');
  }
  const entries = Object.entries(selector).filter(([, value]) =>
    value !== null && value !== undefined);
  if (!entries.length || entries.some(([key, value]) =>
    !SELECTOR_KEYS.has(key) || typeof value !== 'string' || !value.length)) {
    fail('runtime_retention_package_deletion_writer_boundary_selector_invalid');
  }
  const selected = Object.fromEntries(entries);
  for (const key of [
    'packageLifecycleReceiptHash',
    'packageContentHash',
    'deletionIntentHash',
  ]) {
    if (Object.hasOwn(selected, key) && !SHA256.test(selected[key])) {
      fail('runtime_retention_package_deletion_writer_boundary_selector_invalid');
    }
  }
  if (Object.hasOwn(selected, 'packagePath')) {
    const candidate = path.resolve(selected.packagePath);
    if (!path.isAbsolute(selected.packagePath)
      || candidate !== selected.packagePath
      || path.dirname(candidate) !== path.join(runtimeRoot, 'packages')) {
      fail('runtime_retention_package_deletion_writer_boundary_selector_invalid');
    }
  }
  return Object.freeze(selected);
}

function operationKind(operation) {
  try {
    return operation?.constructor?.name || '';
  } catch (error) {
    fail(
      'runtime_retention_package_deletion_writer_boundary_operation_invalid',
      error,
    );
  }
}

function assertSynchronousOperation(operation) {
  if (typeof operation !== 'function'
    || DEFERRED_OPERATION_KINDS.has(operationKind(operation))) {
    fail('runtime_retention_package_deletion_writer_boundary_operation_invalid');
  }
}

function assertAsynchronousOperation(operation) {
  if (typeof operation !== 'function'
    || ['AsyncGeneratorFunction', 'GeneratorFunction'].includes(operationKind(operation))) {
    fail('runtime_retention_package_deletion_writer_boundary_operation_invalid');
  }
}

function assertNotThenable(value) {
  let then;
  try {
    then = value !== null && ['object', 'function'].includes(typeof value)
      ? value.then
      : null;
  } catch (error) {
    fail(
      'runtime_retention_package_deletion_writer_boundary_async_forbidden',
      error,
    );
  }
  if (typeof then === 'function') {
    fail('runtime_retention_package_deletion_writer_boundary_async_forbidden');
  }
}

function selectorHeld(held, requested) {
  return Object.entries(requested).every(([key, value]) =>
    held[key] === value);
}

function runSynchronousHeldOperation(operation, assertHeld) {
  assertHeld();
  let result;
  try {
    result = operation();
    assertNotThenable(result);
  } finally {
    assertHeld();
  }
  return result;
}

function runAsynchronousHeldOperation(operation, context) {
  context.assertHeld();
  let result;
  try {
    result = operation();
  } catch (error) {
    context.assertHeld();
    throw error;
  }
  let nativePromise = false;
  try {
    nativePromise = result instanceof Promise
      && Object.getPrototypeOf(result) === Promise.prototype;
  } catch (error) {
    fail(
      'runtime_retention_package_deletion_writer_boundary_native_promise_required',
      error,
    );
  }
  if (!nativePromise) {
    fail('runtime_retention_package_deletion_writer_boundary_native_promise_required');
  }
  return Promise.prototype.then.call(
    result,
    (value) => { context.assertHeld(); return value; },
    (error) => { context.assertHeld(); throw error; },
  );
}

export function createRuntimeRetentionPackageDeletionWriterScope({
  writerBoundary,
  operationId,
} = {}) {
  const selectedOperationId = String(operationId || '');
  if (typeof writerBoundary?.runAsync !== 'function'
    || !selectedOperationId.length) {
    fail('runtime_retention_package_deletion_writer_scope_invalid');
  }
  return Object.freeze({
    version: 1,
    kind: 'PackageDeletionWriterScopePort',
    runAsync(selector, operation) {
      if (!selector || typeof selector !== 'object' || Array.isArray(selector)
        || Object.getPrototypeOf(selector) !== Object.prototype
        || (Object.hasOwn(selector, 'operationId')
          && selector.operationId !== selectedOperationId)) {
        fail('runtime_retention_package_deletion_writer_scope_selector_invalid');
      }
      return writerBoundary.runAsync(Object.freeze({
        ...selector,
        operationId: selectedOperationId,
      }), operation);
    },
  });
}

export function createRuntimeRetentionPackageDeletionWriterBoundary({
  runtimeRoot,
} = {}) {
  const root = path.resolve(String(runtimeRoot || ''));
  const repository = createRuntimeRetentionPackageDeletionFenceRepository({
    runtimeRoot,
  });
  const heldContext = new AsyncLocalStorage();

  return Object.freeze({
    run(selector, operation) {
      assertSynchronousOperation(operation);
      const selected = normalizedSelector(selector, root);
      const held = heldContext.getStore() || null;
      if (held) {
        if (!held.active) {
          fail('runtime_retention_package_deletion_writer_boundary_capability_expired');
        }
        if (!selectorHeld(held.selector, selected)) {
          fail('runtime_retention_package_deletion_writer_boundary_selector_not_held');
        }
        return runSynchronousHeldOperation(operation, held.assertHeld);
      }

      return repository.withWriterGuard(selected, ({ assertHeld }) => {
        const context = {
          active: true,
          asynchronous: false,
          assertHeld,
          selector: selected,
        };
        try {
          return heldContext.run(context, () =>
            runSynchronousHeldOperation(operation, assertHeld));
        } finally {
          context.active = false;
        }
      });
    },
    runAsync(selector, operation) {
      assertAsynchronousOperation(operation);
      const selected = normalizedSelector(selector, root);
      const held = heldContext.getStore() || null;
      if (held) {
        if (!held.active) {
          fail('runtime_retention_package_deletion_writer_boundary_capability_expired');
        }
        if (!held.asynchronous) {
          fail('runtime_retention_package_deletion_writer_boundary_async_scope_required');
        }
        if (!selectorHeld(held.selector, selected)) {
          fail('runtime_retention_package_deletion_writer_boundary_selector_not_held');
        }
        return runAsynchronousHeldOperation(operation, held);
      }

      return repository.withWriterGuard(selected, ({ assertHeld }) => {
        const context = {
          active: true,
          asynchronous: true,
          assertHeld,
          selector: selected,
        };
        return heldContext.run(context, () => {
          let pending;
          try {
            pending = runAsynchronousHeldOperation(operation, context);
          } catch (error) {
            context.active = false;
            throw error;
          }
          return pending.finally(() => { context.active = false; });
        });
      });
    },
  });
}
