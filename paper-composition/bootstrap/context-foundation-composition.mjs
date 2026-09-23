import fs from 'node:fs';
import { createExecutionContext, assertExecutionServices } from '../../paper-application/execution-context.mjs';
import { assertScopedSchemaVersion } from '../../paper-adapters/persistence/scoped-schema-version-gate.mjs';
import { createReadOnlyPaperStore, openExistingWritablePaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { composeTypedPersistenceServices } from './typed-persistence-composition.mjs';
import { heptaStorePath } from '../../paper-adapters/persistence/store-paths.mjs';
import { assertWorkspaceLayoutPhysicallyDecoupled } from '../../paper-adapters/runtime/workspace-layout.mjs';
import {
  createRuntimeRetentionPackageDeletionWriterBoundary,
} from '../../paper-adapters/automation/runtime-retention-package-deletion-writer-boundary.mjs';
import {
  createRuntimeRetentionPackageDeletionWriterStore,
} from '../../paper-adapters/persistence/runtime-retention-package-deletion-writer-store.mjs';

const WRITER_OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/;

function packageDeletionWriterOperationId(writerId) {
  const operationId = `store:${String(writerId || '')}`;
  if (!WRITER_OPERATION_ID.test(operationId)) {
    throw new Error('foundation_package_deletion_writer_id_invalid');
  }
  return operationId;
}

function assertMutableOverridesSafe({ readOnly, serviceOverrides }) {
  if (readOnly === true) return;
  for (const name of [
    'packageDeletionWriterBoundary',
    'receiptLedger',
  ]) {
    if (Object.hasOwn(serviceOverrides, name)) {
      throw new Error(`foundation_mutable_${name}_override_forbidden`);
    }
  }
}

function resolveStore({
  root,
  runtimeRoot,
  readOnly,
  allowMissingReadOnlyStore,
  serviceOverrides,
  writableStoreFactory = null,
}) {
  if (serviceOverrides.store) return serviceOverrides.store;
  if (!readOnly && writableStoreFactory) return writableStoreFactory();
  return readOnly
    ? createReadOnlyPaperStore({ root, runtimeRoot, allowMissing: allowMissingReadOnlyStore })
    : openExistingWritablePaperStore({ root, runtimeRoot });
}

function createWriterContext({ readOnly, runtimeRoot, writerId }) {
  if (readOnly === true) {
    return Object.freeze({ boundary: null, operationId: null });
  }
  return Object.freeze({
    boundary: createRuntimeRetentionPackageDeletionWriterBoundary({ runtimeRoot }),
    operationId: packageDeletionWriterOperationId(writerId),
  });
}

function composeResolvedFoundationServices({
  root,
  runtimeRoot,
  readOnly,
  allowMissingReadOnlyStore,
  serviceOverrides,
  writableStoreFactory,
  writerContext,
  writerId,
}) {
  const openStore = () => resolveStore({
    root,
    runtimeRoot,
    readOnly,
    allowMissingReadOnlyStore,
    serviceOverrides,
    writableStoreFactory,
  });
  let resolvedStore = null;
  try {
    resolvedStore = readOnly === true
      ? openStore()
      : writerContext.boundary.run({ operationId: writerContext.operationId }, openStore);
    const store = readOnly === true ? resolvedStore
      : createRuntimeRetentionPackageDeletionWriterStore({
        store: resolvedStore,
        writerBoundary: writerContext.boundary,
        operationId: writerContext.operationId,
      });
    const clock = serviceOverrides.clock || createSystemClock();
    const receiptLedger = serviceOverrides.receiptLedger || createSqliteReceiptLedger({
      store,
      clock,
      writerIdentity: { writerId, writerKind: 'in-process-service' },
    });
    return Object.freeze({
      store,
      clock,
      receiptLedger,
      packageDeletionWriterBoundary: writerContext.boundary,
      packageDeletionWriterOperationId: writerContext.operationId,
      ...composeTypedPersistenceServices({ store, overrides: serviceOverrides }),
    });
  } catch (error) {
    if (!serviceOverrides.store) resolvedStore?.close?.();
    throw error;
  }
}

export function inspectScopedPaperStoreSchema({
  store,
  allowUnavailable = false,
  rootKind = 'scoped-status',
} = {}) {
  try {
    const receipt = assertScopedSchemaVersion({ store, allowUnavailable, rootKind });
    return Object.freeze({
      receipt,
      blockers: Object.freeze(receipt.status === 'scoped_schema_version_verified'
        ? []
        : ['campaign_store_schema_unavailable']),
    });
  } catch (error) {
    return Object.freeze({
      receipt: null,
      blockers: Object.freeze([error?.message || 'campaign_store_schema_verification_failed']),
    });
  }
}

export function composeFoundationServices({
  root,
  runtimeRoot,
  readOnly,
  mutableOutputs = false,
  allowMissingReadOnlyStore,
  serviceOverrides = {},
  writerId,
  writableStoreFactory = null,
}) {
  assertMutableOverridesSafe({ readOnly, serviceOverrides });
  if (writableStoreFactory && (readOnly === true || serviceOverrides.store)) {
    throw new Error('foundation_writable_store_factory_invalid');
  }
  if (!readOnly || mutableOutputs) {
    assertWorkspaceLayoutPhysicallyDecoupled({ assetRoot: root, runtimeRoot });
  }
  if (!readOnly && !serviceOverrides.store && !writableStoreFactory) {
    const dbPath = heptaStorePath(root, runtimeRoot);
    if (!fs.existsSync(dbPath)) {
      throw new Error(`paper_store_not_initialized:run_store_migrate:${dbPath}`);
    }
  }
  const writerContext = createWriterContext({ readOnly, runtimeRoot, writerId });
  return composeResolvedFoundationServices({
    root,
    runtimeRoot,
    readOnly,
    allowMissingReadOnlyStore,
    serviceOverrides,
    writableStoreFactory,
    writerContext,
    writerId,
  });
}

export function openScopedPaperStore({
  root,
  runtimeRoot,
  readOnly,
  mutableOutputs = false,
  allowMissingReadOnlyStore,
  immutableReadOnlyStore = false,
  serviceOverrides = {},
  rootKind,
}) {
  if (!readOnly || mutableOutputs) {
    assertWorkspaceLayoutPhysicallyDecoupled({ assetRoot: root, runtimeRoot });
  }
  let store = serviceOverrides.store || null;
  let schemaVersion;
  if (store) {
    schemaVersion = assertScopedSchemaVersion({
      store,
      allowUnavailable: Boolean(readOnly && allowMissingReadOnlyStore),
      rootKind,
    });
  } else if (readOnly) {
    if (immutableReadOnlyStore) {
      const dbPath = heptaStorePath(root, runtimeRoot);
      const sidecars = [`${dbPath}-wal`, `${dbPath}-shm`].filter((candidate) => fs.existsSync(candidate));
      if (sidecars.length) throw new Error(`immutable_readonly_store_active_wal_present:${sidecars.join(',')}`);
    }
    store = createReadOnlyPaperStore({ root, runtimeRoot, allowMissing: allowMissingReadOnlyStore, immutable: immutableReadOnlyStore });
    try {
      schemaVersion = assertScopedSchemaVersion({
        store,
        allowUnavailable: Boolean(allowMissingReadOnlyStore),
        rootKind,
      });
    } catch (error) {
      store.close?.();
      throw error;
    }
  } else {
    const inspector = createReadOnlyPaperStore({ root, runtimeRoot, immutable: true });
    try {
      assertScopedSchemaVersion({ store: inspector, rootKind });
    } finally {
      inspector.close();
    }
    store = openExistingWritablePaperStore({ root, runtimeRoot });
    try {
      schemaVersion = assertScopedSchemaVersion({ store, rootKind });
    } catch (error) {
      store.close();
      throw error;
    }
  }
  return Object.freeze({ store, schemaVersion, owned: !serviceOverrides.store });
}

export function composeScopedFoundationServices({
  root,
  runtimeRoot,
  readOnly,
  mutableOutputs = false,
  allowMissingReadOnlyStore,
  immutableReadOnlyStore = false,
  serviceOverrides = {},
  writerId,
  rootKind,
  writableStoreFactory = null,
}) {
  if (!readOnly || mutableOutputs) {
    assertWorkspaceLayoutPhysicallyDecoupled({ assetRoot: root, runtimeRoot });
  }
  if (readOnly !== true) {
    let schemaVersion;
    if (serviceOverrides.store) {
      schemaVersion = assertScopedSchemaVersion({
        store: serviceOverrides.store,
        rootKind,
      });
    } else {
      const inspector = createReadOnlyPaperStore({
        root,
        runtimeRoot,
        immutable: true,
      });
      try {
        schemaVersion = assertScopedSchemaVersion({ store: inspector, rootKind });
      } finally {
        inspector.close();
      }
    }
    const foundation = composeFoundationServices({
      root,
      runtimeRoot,
      readOnly: false,
      mutableOutputs,
      allowMissingReadOnlyStore,
      serviceOverrides,
      writerId,
      writableStoreFactory,
    });
    return Object.freeze({ foundation, schemaVersion });
  }
  const scopedStore = openScopedPaperStore({
    root,
    runtimeRoot,
    readOnly,
    mutableOutputs,
    allowMissingReadOnlyStore,
    immutableReadOnlyStore,
    serviceOverrides,
    rootKind,
  });
  const { store, schemaVersion } = scopedStore;
  try {
    const foundation = composeFoundationServices({
      root,
      runtimeRoot,
      readOnly,
      mutableOutputs,
      allowMissingReadOnlyStore,
      serviceOverrides: { ...serviceOverrides, store },
      writerId,
    });
    return Object.freeze({ foundation, schemaVersion });
  } catch (error) {
    if (scopedStore.owned) store.close?.();
    throw error;
  }
}

function standaloneWriterServices(foundation, schemaVersion) {
  const {
    packageDeletionWriterBoundary: _packageDeletionWriterBoundary,
    packageDeletionWriterOperationId: _packageDeletionWriterOperationId,
    ...services
  } = foundation;
  return Object.freeze({ ...services, schemaVersion });
}

function createStandaloneWriterScope({
  root,
  runtimeRoot,
  writerId,
  rootKind = null,
  serviceOverrides = {},
  writableStoreFactory = null,
  writerSelector = {},
}) {
  assertMutableOverridesSafe({ readOnly: false, serviceOverrides });
  if (serviceOverrides.store || (writableStoreFactory !== null
    && typeof writableStoreFactory !== 'function')) {
    throw new Error('foundation_standalone_writer_store_factory_invalid');
  }
  assertWorkspaceLayoutPhysicallyDecoupled({ assetRoot: root, runtimeRoot });
  let schemaVersion = null;
  if (rootKind !== null) {
    const inspector = createReadOnlyPaperStore({
      root,
      runtimeRoot,
      immutable: true,
    });
    try {
      schemaVersion = assertScopedSchemaVersion({ store: inspector, rootKind });
    } finally {
      inspector.close();
    }
  }
  const writerContext = createWriterContext({
    readOnly: false,
    runtimeRoot,
    writerId,
  });
  return Object.freeze({
    root,
    runtimeRoot,
    serviceOverrides,
    writableStoreFactory,
    writerId,
    writerContext,
    schemaVersion,
    selector: Object.freeze({
      ...writerSelector,
      operationId: writerContext.operationId,
    }),
  });
}

function composeStandaloneWriterFoundation(scope) {
  return composeResolvedFoundationServices({
    root: scope.root,
    runtimeRoot: scope.runtimeRoot,
    readOnly: false,
    allowMissingReadOnlyStore: false,
    serviceOverrides: scope.serviceOverrides,
    writableStoreFactory: scope.writableStoreFactory,
    writerContext: scope.writerContext,
    writerId: scope.writerId,
  });
}

export function runWithScopedFoundationWriter(options, operation) {
  if (typeof operation !== 'function') {
    throw new Error('foundation_standalone_writer_operation_invalid');
  }
  const scope = createStandaloneWriterScope(options || {});
  return scope.writerContext.boundary.run(scope.selector, () => {
    let foundation = null;
    try {
      foundation = composeStandaloneWriterFoundation(scope);
      return operation(standaloneWriterServices(
        foundation,
        scope.schemaVersion,
      ));
    } finally {
      foundation?.store.close?.();
    }
  });
}

export function runWithScopedFoundationWriterAsync(options, operation) {
  if (typeof operation !== 'function') {
    throw new Error('foundation_standalone_writer_operation_invalid');
  }
  const scope = createStandaloneWriterScope(options || {});
  return scope.writerContext.boundary.runAsync(scope.selector, async () => {
    let foundation = null;
    try {
      foundation = composeStandaloneWriterFoundation(scope);
      return await operation(standaloneWriterServices(
        foundation,
        scope.schemaVersion,
      ));
    } finally {
      foundation?.store.close?.();
    }
  });
}

export function exposeScopedFoundationServices(foundation, { schemaVersion } = {}) {
  const {
    store,
    packageDeletionWriterBoundary: _packageDeletionWriterBoundary,
    packageDeletionWriterOperationId: _packageDeletionWriterOperationId,
    ...typed
  } = foundation;
  if (!store) throw new Error('scoped foundation requires an internal StorePort');
  return Object.freeze({
    ...typed,
    schemaVersion,
    persistenceSession: Object.freeze({
      version: 1,
      kind: 'ScopedPersistenceSessionPort',
      available: () => typeof store.available !== 'function' || store.available(),
      close: () => store.close?.(),
    }),
  });
}

export function buildExecutionContext({
  root,
  runtimeRoot,
  mode,
  execute,
  writeReport,
  options,
  serviceProfile,
  capabilities,
  services,
}) {
  const context = createExecutionContext({
    root,
    runtimeRoot,
    mode,
    execute,
    writeReport,
    serviceProfile,
    capabilities,
    options,
    services,
  });
  assertExecutionServices(context);
  return context;
}
