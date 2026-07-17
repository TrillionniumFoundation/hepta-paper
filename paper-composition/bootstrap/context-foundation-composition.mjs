import fs from 'node:fs';
import { createExecutionContext, assertExecutionServices } from '../../paper-application/execution-context.mjs';
import { assertScopedSchemaVersion } from '../../paper-adapters/persistence/scoped-schema-version-gate.mjs';
import { createReadOnlyPaperStore, openExistingWritablePaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { composeTypedPersistenceServices } from './typed-persistence-composition.mjs';
import { heptaStorePath } from '../../paper-adapters/persistence/store-paths.mjs';
import { assertWorkspaceLayoutPhysicallyDecoupled } from '../../paper-adapters/runtime/workspace-layout.mjs';

function resolveStore({ root, runtimeRoot, readOnly, allowMissingReadOnlyStore, serviceOverrides }) {
  if (serviceOverrides.store) return serviceOverrides.store;
  return readOnly
    ? createReadOnlyPaperStore({ root, runtimeRoot, allowMissing: allowMissingReadOnlyStore })
    : openExistingWritablePaperStore({ root, runtimeRoot });
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
  serviceOverrides,
  writerId,
}) {
  if (!readOnly || mutableOutputs) {
    assertWorkspaceLayoutPhysicallyDecoupled({ assetRoot: root, runtimeRoot });
  }
  const store = resolveStore({ root, runtimeRoot, readOnly, allowMissingReadOnlyStore, serviceOverrides });
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
    ...composeTypedPersistenceServices({ store, overrides: serviceOverrides }),
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
  serviceOverrides,
  writerId,
  rootKind,
}) {
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

export function exposeScopedFoundationServices(foundation, { schemaVersion } = {}) {
  const { store, ...typed } = foundation;
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
