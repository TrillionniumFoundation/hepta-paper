import path from 'node:path';
import { createExecutionContext, assertExecutionServices } from '../execution-context.mjs';
import { createDefaultPaperStore, createReadOnlyPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { createSha256Hasher } from '../../paper-adapters/runtime/sha256-hasher.mjs';
import { createAuthorityVerifier } from '../../paper-adapters/authority/authority-verifier.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import {
  issueArtifactRepositoryWriter,
  issueExperimentReproducibilityWriter,
  issueExperimentWorkerWriter,
  issueFormalAdapterWriter,
  issueFormalVerifierWriter,
  issueNativeResearchWorkerWriter,
} from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
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
  const artifactReceiptLedger = serviceOverrides.artifactReceiptLedger || (serviceOverrides.receiptLedger
    ? receiptLedger
    : createSqliteReceiptLedger({
        store,
        clock,
        issuerCapability: issueArtifactRepositoryWriter(),
      }));
  const nativeResearchWorkerReceiptLedger = serviceOverrides.nativeResearchWorkerReceiptLedger || createSqliteReceiptLedger({
    store,
    clock,
    issuerCapability: issueNativeResearchWorkerWriter(),
  });
  const trustedResearchReceiptWriters = Object.freeze({
    experimentWorker: serviceOverrides.experimentWorkerReceiptLedger || createSqliteReceiptLedger({ store, clock, issuerCapability: issueExperimentWorkerWriter() }),
    experimentReproducibility: serviceOverrides.experimentReproducibilityReceiptLedger || createSqliteReceiptLedger({ store, clock, issuerCapability: issueExperimentReproducibilityWriter() }),
    formalAdapter: serviceOverrides.formalAdapterReceiptLedger || createSqliteReceiptLedger({ store, clock, issuerCapability: issueFormalAdapterWriter() }),
    formalExecution: serviceOverrides.formalExecutionReceiptLedger || createSqliteReceiptLedger({ store, clock, issuerCapability: issueFormalVerifierWriter() }),
  });
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
    trustedResearchReceiptWriters,
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
