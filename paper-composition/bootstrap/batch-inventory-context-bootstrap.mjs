import path from 'node:path';
import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { createFilesystemReportReceiptLedger } from '../../paper-adapters/artifacts/filesystem-report-receipt-ledger.mjs';
import { createInventoryRepository } from '../../paper-adapters/inventory/inventory-repository.mjs';
import {
  buildExecutionContext,
  composeScopedFoundationServices,
  exposeScopedFoundationServices,
} from './context-foundation-composition.mjs';

// Minimal scoped context for inventory/preview/report/proposal surfaces. It has
// no stage executor, submission delivery, or campaign mutation capability.
export function bootstrapBatchInventoryContext({
  root,
  runtimeRoot,
  mode = 'inventory',
  execute = false,
  writeReport = false,
  readOnly = true,
  allowMissingReadOnlyStore = true,
  options = {},
  serviceOverrides = {},
} = {}) {
  const { foundation, schemaVersion } = composeScopedFoundationServices({
    root,
    runtimeRoot,
    readOnly,
    mutableOutputs: Boolean(writeReport),
    allowMissingReadOnlyStore,
    immutableReadOnlyStore: true,
    serviceOverrides,
    writerId: 'hepta-paper-batch-inventory-bootstrap',
    rootKind: 'batch',
  });
  const { store, clock } = foundation;
  const artifactReceiptLedger = serviceOverrides.artifactReceiptLedger
    || createFilesystemReportReceiptLedger({ scopeRoot: runtimeRoot, receiptRoot: path.join(runtimeRoot, 'report-receipts'), clock });
  const artifactRepositoryFactory = serviceOverrides.artifactRepositoryFactory
    || ((scopeRoot) => createFilesystemArtifactRepository({
      scopeRoot,
      casRoot: path.join(runtimeRoot, 'report-artifact-cas'),
      receiptLedger: artifactReceiptLedger,
      clock,
    }));
  const services = Object.freeze({
    ...exposeScopedFoundationServices(foundation, { schemaVersion }),
    artifactRepositoryFactory,
    inventoryRepository: serviceOverrides.inventoryRepository || createInventoryRepository({ store }),
  });
  return buildExecutionContext({
    root,
    runtimeRoot,
    mode,
    execute,
    writeReport,
    options,
    serviceProfile: 'inventory',
    capabilities: ['artifact-repository', 'inventory-read', 'receipt-ledger', 'typed-persistence'],
    services,
  });
}
