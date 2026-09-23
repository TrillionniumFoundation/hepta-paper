import { assertStorePort } from '../../paper-ports/store-port.mjs';

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/;
const WRITE_SELECTOR = 'packageDeletionWriterSelector';
const TARGET_SELECTOR_KEYS = new Set([
  'packageLifecycleReceiptHash',
  'packagePath',
  'packageContentHash',
  'deletionIntentHash',
]);

function guardedCall(boundary, selector, operation) {
  return boundary.run(selector, operation);
}

function optionalMethod(store, name, factory) {
  return typeof store[name] === 'function' ? { [name]: factory() } : {};
}

function targetedSelector(input, operationId) {
  if (!input || typeof input !== 'object'
    || !Object.hasOwn(input, WRITE_SELECTOR)) {
    return Object.freeze({ operationId });
  }
  const targeted = input[WRITE_SELECTOR];
  if (!targeted || typeof targeted !== 'object' || Array.isArray(targeted)
    || Object.getPrototypeOf(targeted) !== Object.prototype) {
    throw new Error(
      'runtime_retention_package_deletion_writer_store_selector_invalid',
    );
  }
  const entries = Object.entries(targeted).filter(([, value]) =>
    value !== null && value !== undefined);
  if (!entries.length || entries.some(([key, value]) =>
    !TARGET_SELECTOR_KEYS.has(key)
      || typeof value !== 'string' || !value.length)) {
    throw new Error(
      'runtime_retention_package_deletion_writer_store_selector_invalid',
    );
  }
  return Object.freeze({
    operationId,
    ...Object.fromEntries(entries),
  });
}

function mutationArguments(args) {
  const [input, ...rest] = args;
  if (!input || typeof input !== 'object'
    || !Object.hasOwn(input, WRITE_SELECTOR)) return args;
  const { [WRITE_SELECTOR]: _selector, ...forwarded } = input;
  return [forwarded, ...rest];
}

export function createRuntimeRetentionPackageDeletionWriterStore({
  store,
  writerBoundary,
  operationId,
} = {}) {
  const ownedStore = assertStorePort(store);
  const selectedOperationId = String(operationId || '');
  if (ownedStore.readOnly === true
    || typeof writerBoundary?.run !== 'function'
    || !OPERATION_ID.test(selectedOperationId)) {
    throw new Error(
      'runtime_retention_package_deletion_writer_store_configuration_invalid',
    );
  }
  const selector = Object.freeze({ operationId: selectedOperationId });
  const guarded = (operation, selected = selector) =>
    guardedCall(writerBoundary, selected, operation);

  return assertStorePort(Object.freeze({
    version: Number(ownedStore.version || 0),
    kind: 'RuntimeRetentionPackageDeletionWriterStoreAdapter',
    dbPath: ownedStore.dbPath,
    readOnly: false,
    query: (...args) => ownedStore.query(...args),
    execute: (sql, options = null) => {
      const selected = targetedSelector(options, selectedOperationId);
      return guarded(() => ownedStore.execute(sql), selected);
    },
    ...optionalMethod(ownedStore, 'run', () =>
      (...args) => guarded(() => ownedStore.run(...args))),
    ...optionalMethod(ownedStore, 'mutate', () => (...args) => {
      const selected = targetedSelector(args[0], selectedOperationId);
      const forwarded = mutationArguments(args);
      return guarded(() => ownedStore.mutate(...forwarded), selected);
    }),
    ...optionalMethod(ownedStore, 'transaction', () =>
      (operation, options = {}) => options?.readOnly === true
        ? ownedStore.transaction(operation, options)
        : guarded(() => ownedStore.transaction(operation, options))),
    ...optionalMethod(ownedStore, 'recoverPendingMutations', () =>
      (...args) => guarded(() => ownedStore.recoverPendingMutations(...args))),
    ...optionalMethod(ownedStore, 'available', () =>
      (...args) => ownedStore.available(...args)),
    ...optionalMethod(ownedStore, 'checkpoint', () =>
      (...args) => ownedStore.checkpoint(...args)),
    ...optionalMethod(ownedStore, 'close', () =>
      (...args) => ownedStore.close(...args)),
    ...(ownedStore.externallyFencedMutations === true ? {
      externallyFencedMutations: true,
      databaseRole: ownedStore.databaseRole,
      databaseInstanceId: ownedStore.databaseInstanceId,
      schemaContractId: ownedStore.schemaContractId,
      writerId: ownedStore.writerId,
      writerIds: ownedStore.writerIds,
      operationWriters: ownedStore.operationWriters,
      operationIds: ownedStore.operationIds,
    } : {}),
  }));
}
