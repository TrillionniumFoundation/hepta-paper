import path from 'node:path';
import { createExecutionContext, assertExecutionServices } from '../../paper-application/execution-context.mjs';
import { createDefaultPaperStore, createReadOnlyPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { createSha256Hasher } from '../../paper-adapters/runtime/sha256-hasher.mjs';
import { createAuthorityVerifier } from '../../paper-adapters/authority/authority-verifier.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { composeTrustedReceiptLedgers } from './receipt-ledger-composition.mjs';
import { createSqliteJobReceiptStore } from '../../paper-adapters/persistence/sqlite-job-receipt-store.mjs';
import { createSqliteWorkflowStateStore } from '../../paper-adapters/persistence/sqlite-workflow-state-store.mjs';
import { createSqliteSubmissionDeliveryStore } from '../../paper-adapters/submission/sqlite-delivery-store.mjs';
import { createPaperStageAdapterRegistry } from '../../paper-adapters/stages/paper-stage-adapter-registry.mjs';

export function bootstrapPaperExecutionContext({
  root,
  runtimeRoot,
  mode,
  execute = false,
  writeReport = false,
  readOnly = false,
  options = {},
  serviceOverrides = {},
} = {}) {
  const store = serviceOverrides.store || (readOnly ? createReadOnlyPaperStore({ root, runtimeRoot }) : createDefaultPaperStore({ root, runtimeRoot }));
  const clock = serviceOverrides.clock || createSystemClock();
  const receiptLedger = serviceOverrides.receiptLedger || createSqliteReceiptLedger({
    store,
    clock,
    writerIdentity: { writerId: 'hepta-paper-bootstrap', writerKind: 'in-process-service' },
  });
  const trustedLedgers = composeTrustedReceiptLedgers({ store, clock, overrides: serviceOverrides });
  const artifactReceiptLedger = serviceOverrides.receiptLedger ? receiptLedger : trustedLedgers.artifact;
  const nativeResearchWorkerReceiptLedger = trustedLedgers.nativeResearchWorker;
  const artifactRepositoryFactory = serviceOverrides.artifactRepositoryFactory || ((scopeRoot) => (
    createFilesystemArtifactRepository({
      scopeRoot,
      casRoot: path.join(runtimeRoot, 'artifact-cas'),
      receiptLedger: artifactReceiptLedger,
      clock,
    })
  ));
  const services = {
    store,
    artifactRepositoryFactory,
    clock,
    hasher: serviceOverrides.hasher || createSha256Hasher(),
    authorityVerifier: serviceOverrides.authorityVerifier || createAuthorityVerifier(),
    receiptLedger,
    paperStageAdapters: serviceOverrides.paperStageAdapters || createPaperStageAdapterRegistry(),
    trustedResearchReceiptWriters: trustedLedgers.research,
    jobReceiptStore: serviceOverrides.jobReceiptStore || createSqliteJobReceiptStore({
      store,
      receiptLedger,
      receiptLedgerResolver: (receipt) => receipt?.kind === 'NativeResearchWorkerExecutionReceipt'
        ? nativeResearchWorkerReceiptLedger
        : receiptLedger,
      clock,
    }),
    workflowStateStore: serviceOverrides.workflowStateStore || createSqliteWorkflowStateStore({ store, clock, receiptLedger }),
    submissionExecutorDescriptor: serviceOverrides.submissionExecutorDescriptor || null,
    executorResponseVerifier: serviceOverrides.executorResponseVerifier || null,
    submissionDeliveryStore: serviceOverrides.submissionDeliveryStore || createSqliteSubmissionDeliveryStore({ store, receiptLedger, clock, executorResponseVerifier: serviceOverrides.executorResponseVerifier || null, providerCapabilityVerifier: serviceOverrides.providerCapabilityVerifier || null }),
  };
  const context = createExecutionContext({ root, runtimeRoot, mode, execute, writeReport, options, services });
  assertExecutionServices(context);
  return context;
}
